// FleetGlass Node tracer core: emits FleetGlass JSON spans and threads the
// current agent + parent span through AsyncLocalStorage so provider adapters
// and agent() scopes need no explicit wiring.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
export const currentFrame = () => als.getStore();

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Split real input_tokens across context segments by character share.
function contextTokens(segments, inputTokens) {
  const chars = Object.fromEntries(Object.entries(segments).map(([k, v]) => [k, (v || '').length]));
  const total = Object.values(chars).reduce((s, n) => s + n, 0) || 1;
  return Object.fromEntries(Object.entries(chars).map(([k, n]) => [k, Math.round((n / total) * inputTokens)]));
}

export function createTracer({ endpoint = process.env.FLEETGLASS_URL || 'http://localhost:4700/v1/traces', workflow = 'default', post } = {}) {
  let queue = [];
  let timer = null;

  const defaultPost = async (spans) => {
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceSpans: [{
            resource: { attributes: [{ key: 'service.name', value: { stringValue: workflow } }] },
            scopeSpans: [{ spans }],
          }],
        }),
      });
    } catch { /* observability must never break the agent */ }
  };
  const send = post || defaultPost;

  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const spans = queue;
    queue = [];
    if (spans.length) await send(spans);
  }
  function push(span) {
    queue.push(span);
    if (!timer) timer = setTimeout(() => { flush(); }, 300);
  }

  function frameOrThrow() {
    const f = currentFrame();
    if (!f) throw new Error('fleetglass: emit outside task() — wrap work in fg.task(...)');
    return f;
  }
  function nextParent(f) { return f.last || f.anchor || undefined; }

  function emitChat({ model, inputTokens = 0, outputTokens = 0, prompt = '', completion = '', context } = {}) {
    const f = frameOrThrow();
    const spanId = hex(8);
    const attrs = [
      { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
      { key: 'gen_ai.agent.name', value: { stringValue: f.agent || 'agent' } },
      { key: 'gen_ai.request.model', value: { stringValue: model || 'unknown' } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: inputTokens } },
      { key: 'gen_ai.usage.output_tokens', value: { intValue: outputTokens } },
    ];
    if (prompt) attrs.push({ key: 'gen_ai.prompt', value: { stringValue: String(prompt).slice(0, 4000) } });
    if (completion) attrs.push({ key: 'gen_ai.completion', value: { stringValue: String(completion).slice(0, 4000) } });
    if (context) for (const [k, v] of Object.entries(contextTokens(context, inputTokens))) attrs.push({ key: `fleetglass.context.${k}_tokens`, value: { intValue: v } });
    const parent = nextParent(f);
    push({ traceId: f.trace, spanId, ...(parent ? { parentSpanId: parent } : {}), name: `chat ${model}`, startTimeUnixNano: String(Date.now() * 1e6), attributes: attrs });
    f.last = spanId;
    return spanId;
  }

  function emitTool({ tool = 'tool', input = '', output = '' } = {}) {
    const f = frameOrThrow();
    const spanId = hex(8);
    const parent = nextParent(f);
    push({ traceId: f.trace, spanId, ...(parent ? { parentSpanId: parent } : {}), name: `execute_tool ${tool}`, startTimeUnixNano: String(Date.now() * 1e6), attributes: [
      { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
      { key: 'gen_ai.agent.name', value: { stringValue: f.agent || 'agent' } },
      { key: 'gen_ai.tool.name', value: { stringValue: tool } },
      { key: 'fleetglass.tool.input', value: { stringValue: String(input).slice(0, 4000) } },
      { key: 'fleetglass.tool.output', value: { stringValue: String(output).slice(0, 4000) } },
    ] });
    f.last = spanId;
    return spanId;
  }

  async function task(fn) {
    const frame = { trace: hex(16), agent: null, anchor: undefined, last: undefined };
    try { return await als.run(frame, fn); }
    finally { await flush(); }
  }

  async function agent(name, fn) {
    const p = frameOrThrow();
    const frame = { trace: p.trace, agent: name, anchor: p.last || p.anchor, last: undefined };
    return als.run(frame, fn);
  }

  const api = { task, agent, withAgent: agent, emitChat, emitTool, flush };
  return api;
}
