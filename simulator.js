// Emits OTLP/JSON GenAI spans for a 4-agent fleet so the dashboard is alive
// without a real agent system. At PROMPT_CHANGE_MS it "deploys" a bloated
// summarizer prompt — cost/call roughly doubles and the anomaly alert fires.

const ENDPOINT = process.env.FLEETGLASS_URL || 'http://localhost:4700/v1/traces';
// change lands after the detector has a clean baseline (needs ~5 summarizer calls)
const PROMPT_CHANGE_MS = Number(process.env.PROMPT_CHANGE_MS || 180_000);
const started = Date.now();

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const jitter = (n) => Math.round(n * (0.85 + Math.random() * 0.3));

function span({ trace, parent, agent, model, inTok, outTok, ctx }) {
  const now = Date.now();
  const attrs = [
    { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
    { key: 'gen_ai.agent.name', value: { stringValue: agent } },
    { key: 'gen_ai.request.model', value: { stringValue: model } },
    { key: 'gen_ai.usage.input_tokens', value: { intValue: inTok } },
    { key: 'gen_ai.usage.output_tokens', value: { intValue: outTok } },
  ];
  for (const [k, v] of Object.entries(ctx || {})) {
    attrs.push({ key: `fleetglass.context.${k}_tokens`, value: { intValue: v } });
  }
  return {
    traceId: trace,
    spanId: hex(8),
    ...(parent ? { parentSpanId: parent } : {}),
    name: `chat ${model}`,
    startTimeUnixNano: String(now * 1e6),
    endTimeUnixNano: String((now + 900) * 1e6),
    attributes: attrs,
  };
}

function task() {
  const trace = hex(16);
  const spans = [];
  const promptChanged = Date.now() - started > PROMPT_CHANGE_MS;

  const orch = span({
    trace, agent: 'orchestrator', model: 'opus-4-8',
    inTok: jitter(3000), outTok: jitter(280),
    ctx: { system: jitter(1400), history: jitter(1100), retrieval: 0, tools: jitter(500) },
  });
  spans.push(orch);

  const r = Math.random();
  if (r < 0.48) {
    const research = span({
      trace, parent: orch.spanId, agent: 'researcher', model: 'sonnet-5',
      inTok: jitter(8200), outTok: jitter(900),
      ctx: { system: jitter(900), history: jitter(2600), retrieval: jitter(4100), tools: jitter(600) },
    });
    spans.push(research);
    if (Math.random() < 0.12) {
      // the "bad deploy": prompt change starts re-including full retrieval history
      const history = promptChanged ? jitter(24000) : jitter(6400);
      const ctx = { system: jitter(2100), history, retrieval: jitter(3700), tools: jitter(5500) };
      spans.push(span({
        trace, parent: research.spanId, agent: 'summarizer', model: 'opus-4-8',
        inTok: ctx.system + ctx.history + ctx.retrieval + ctx.tools,
        outTok: jitter(promptChanged ? 2200 : 1200),
        ctx,
      }));
    }
  } else if (r < 0.92) {
    spans.push(span({
      trace, parent: orch.spanId, agent: 'extractor', model: 'haiku-4.5',
      inTok: jitter(2100), outTok: jitter(160),
      ctx: { system: jitter(700), history: jitter(300), retrieval: jitter(600), tools: jitter(500) },
    }));
  }
  return spans;
}

async function tick() {
  const body = { resourceSpans: [{ scopeSpans: [{ spans: task() }] }] };
  try {
    await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    console.error('post failed:', e.message);
  }
}

console.log(`simulating fleet → ${ENDPOINT} (prompt change at t+${PROMPT_CHANGE_MS / 1000}s)`);
setInterval(tick, 650);
