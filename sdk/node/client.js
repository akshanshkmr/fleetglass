// FleetGlass unified client: one provider-agnostic call surface over the REST
// translator. `fleetglass({ model }).chat(input)` runs the call and (Task 3) emits
// the same trace span as wrap(). Zero deps.
import { toProvider, parseResponse, providerOf, keyFor } from './translate.js';

async function httpCall(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const clamp = (n) => Math.max(256, Math.min(4096, n || 1024));
const normalize = (input) => (typeof input === 'string' ? { messages: [{ role: 'user', content: input }] } : (input || {}));

export function fleetglass(opts = {}) {
  const { model, maxTokens: defMax, call = httpCall } = opts;
  if (!model) throw new Error('fleetglass: model is required');
  const provider = opts.provider || providerOf(model);
  if (!provider) throw new Error(`fleetglass: cannot infer provider from model ${model}`);
  const key = opts.key || keyFor(provider);
  if (!key) { const e = new Error(`fleetglass: no API key for ${provider} (pass key, or set ${provider}'s env var)`); e.code = 'NO_KEY'; throw e; }

  async function chat(input, perCall = {}) {
    const req = normalize(input);
    const maxTokens = clamp(perCall.maxTokens ?? defMax);
    const { url, headers, body } = toProvider(req, { provider, model, maxTokens, key });
    const data = await call(url, headers, body);          // throws on API/network error
    const { completion, inTok, outTok } = parseResponse(provider, data);
    return { text: completion, usage: { inputTokens: inTok, outputTokens: outTok }, model, raw: data };
  }

  return { chat, provider, model };
}
