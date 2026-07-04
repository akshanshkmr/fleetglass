// FleetGlass tracer — zero-dep client for the ingest endpoint.
// Instruments any Node agent system: start a task per unit of work, record
// each model call and tool execution, and pass the returned spanId as
// `parent` when handing off to another agent — that parent link across
// different agent names is what draws the handoff edges in the graph.
//
//   import { createTracer } from './tracer.js';
//   const fg = createTracer();
//   const task = fg.startTask();
//   const planId = task.chat({ agent: 'orchestrator', model, inputTokens, outputTokens, prompt, completion });
//   task.chat({ agent: 'extractor', parent: planId, ... });   // ← handoff edge orchestrator→extractor
//   await fg.flush();

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Split real input_tokens across context segments by character share.
// ponytail: char-proportional estimate; exact per-segment counts need count_tokens.
function contextTokens(segments, inputTokens) {
  const chars = Object.fromEntries(Object.entries(segments).map(([k, v]) => [k, (v || '').length]));
  const total = Object.values(chars).reduce((s, n) => s + n, 0) || 1;
  return Object.fromEntries(Object.entries(chars).map(([k, n]) => [k, Math.round((n / total) * inputTokens)]));
}

export function createTracer(endpoint = process.env.FLEETGLASS_URL || 'http://localhost:4700/v1/traces') {
  let queue = [];
  let timer = null;

  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const spans = queue;
    queue = [];
    if (!spans.length) return;
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }),
      });
    } catch {
      // observability must never break the agent — drop the batch
    }
  }

  function push(span) {
    queue.push(span);
    if (!timer) timer = setTimeout(flush, 300);
  }

  function startTask() {
    const traceId = hex(16);

    function chat({ agent, parent, model, inputTokens = 0, outputTokens = 0, prompt = '', completion = '', context }) {
      const spanId = hex(8);
      const attrs = [
        { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
        { key: 'gen_ai.agent.name', value: { stringValue: agent } },
        { key: 'gen_ai.request.model', value: { stringValue: model } },
        { key: 'gen_ai.usage.input_tokens', value: { intValue: inputTokens } },
        { key: 'gen_ai.usage.output_tokens', value: { intValue: outputTokens } },
      ];
      if (prompt) attrs.push({ key: 'gen_ai.prompt', value: { stringValue: String(prompt).slice(0, 4000) } });
      if (completion) attrs.push({ key: 'gen_ai.completion', value: { stringValue: String(completion).slice(0, 4000) } });
      if (context) {
        for (const [k, v] of Object.entries(contextTokens(context, inputTokens))) {
          attrs.push({ key: `fleetglass.context.${k}_tokens`, value: { intValue: v } });
        }
      }
      push({
        traceId, spanId,
        ...(parent ? { parentSpanId: parent } : {}),
        name: `chat ${model}`,
        startTimeUnixNano: String(Date.now() * 1e6),
        attributes: attrs,
      });
      return spanId;
    }

    // Convenience: record an Anthropic messages.create round trip.
    // `context` segments are the raw strings you assembled the request from
    // (system / history / retrieval / tools) — scaled to real usage tokens.
    function anthropic({ agent, parent, params, response, context }) {
      const lastUser = [...(params.messages || [])].reverse().find((m) => m.role === 'user');
      const promptText = typeof lastUser?.content === 'string'
        ? lastUser.content
        : (lastUser?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const completion = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const usage = response.usage || {};
      return chat({
        agent, parent,
        model: response.model || params.model,
        inputTokens: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
        outputTokens: usage.output_tokens || 0,
        prompt: promptText,
        completion,
        context,
      });
    }

    function tool({ agent, parent, tool: name, input = '', output = '' }) {
      const spanId = hex(8);
      push({
        traceId, spanId,
        ...(parent ? { parentSpanId: parent } : {}),
        name: `execute_tool ${name}`,
        startTimeUnixNano: String(Date.now() * 1e6),
        attributes: [
          { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
          { key: 'gen_ai.agent.name', value: { stringValue: agent } },
          { key: 'gen_ai.tool.name', value: { stringValue: name } },
          { key: 'fleetglass.tool.input', value: { stringValue: String(input).slice(0, 4000) } },
          { key: 'fleetglass.tool.output', value: { stringValue: String(output).slice(0, 4000) } },
        ],
      });
      return spanId;
    }

    return { traceId, chat, anthropic, tool };
  }

  return { startTask, flush };
}
