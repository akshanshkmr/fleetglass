// FleetGlass unified client: one provider-agnostic call surface over the REST
// translator. `fleetglass({ model }).chat(input)` runs the call and (Task 3) emits
// the same trace span as wrap(). Zero deps.
import { toProvider, parseResponse, providerOf, keyFor } from './translate.js';
import { createTracer, currentFrame } from './tracer.js';

async function httpCall(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const clamp = (n) => Math.max(256, Math.min(4096, n || 1024));
const normalize = (input) => (typeof input === 'string' ? { messages: [{ role: 'user', content: input }] } : (input || {}));
const lastUser = (messages) => [...(messages || [])].reverse().find((m) => m.role === 'user')?.content || '';
const historyText = (messages) => (messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');

export function fleetglass(opts = {}) {
  const { model, maxTokens: defMax, workflow = 'default', agent = 'agent', captureRequests = false, endpoint, post, call = httpCall } = opts;
  if (!model) throw new Error('fleetglass: model is required');
  const provider = opts.provider || providerOf(model);
  if (!provider) throw new Error(`fleetglass: cannot infer provider from model ${model}`);
  const key = opts.key || keyFor(provider);
  if (!key) { const e = new Error(`fleetglass: no API key for ${provider} (pass key, or set ${provider}'s env var)`); e.code = 'NO_KEY'; throw e; }

  // Telemetry must never break the call. The default transport already swallows
  // fetch errors; a custom `post` might not — and auto-wrap awaits flush() in
  // task's finally, so an unswallowed transport error would reject the call. Wrap it.
  const safePost = post ? async (spans) => { try { return await post(spans); } catch { return undefined; /* drop */ } } : undefined;
  const tracer = createTracer({ workflow, endpoint, captureRequests, ...(safePost ? { post: safePost } : {}) });
  const killedSet = new Set(); // trace ids the control plane has flagged killed
  let routeMap = {}; // "workflow/agent" -> target model, harvested from /v1/traces responses

  async function runCall(req, maxTokens, useModel = model) {
    const { url, headers, body } = toProvider(req, { provider, model: useModel, maxTokens, key });
    const data = await call(url, headers, body);          // throws on API/network error
    const { completion, inTok, outTok } = parseResponse(provider, data);
    try {
      tracer.emitChat({
        model: useModel, inputTokens: inTok, outputTokens: outTok,
        prompt: lastUser(req.messages), completion,
        context: { system: req.system || '', history: historyText(req.messages), tools: req.tools ? JSON.stringify(req.tools) : '' },
        request: req,
      });
    } catch { /* telemetry must never break a successful call */ }
    return { text: completion, usage: { inputTokens: inTok, outputTokens: outTok }, model: useModel, raw: data };
  }

  // ponytail: per-call flush (not batched) — a pathology can't fire without many
  // calls, so this trades a POST-per-call for a fresh kill/route signal every call.
  async function guardedCall(req, maxTokens) {
    const f = currentFrame();
    if (f && killedSet.has(f.trace)) { const e = new Error('task killed by FleetGlass kill-switch'); e.code = 'KILLED'; throw e; }
    const target = routeMap[workflow + '/' + ((f && f.agent) || agent)];
    const useModel = (target && providerOf(target) === provider) ? target : model; // same-provider only; else ignore
    const r = await runCall(req, maxTokens, useModel);
    const posted = await tracer.flush();                    // span goes out now; response carries { killed, routes }
    if (posted && Array.isArray(posted.killed)) { killedSet.clear(); for (const t of posted.killed) killedSet.add(t); }
    if (posted && posted.routes && typeof posted.routes === 'object') routeMap = posted.routes;
    return r;
  }

  async function chat(input, perCall = {}) {
    const req = normalize(input);
    const maxTokens = clamp(perCall.maxTokens ?? defMax);
    if (currentFrame()) return guardedCall(req, maxTokens);                          // inside user's task/agent
    return tracer.task(() => tracer.agent(agent, () => guardedCall(req, maxTokens))); // auto-wrap
  }

  return { chat, task: tracer.task, agent: tracer.agent, flush: tracer.flush, provider, model };
}
