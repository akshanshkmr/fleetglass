// Simulates a company running three separate agent workflows, so the
// dashboard shows a real bird's-eye fleet view. Each tick emits one task
// from a weighted-random workflow, tagged via the service.name resource
// attribute. At PROMPT_CHANGE_MS the incident-response summarizer gets a
// bloated prompt "deploy" — cost/call ~x2 and the anomaly alert fires.

const ENDPOINT = process.env.FLEETGLASS_URL || 'http://localhost:4700/v1/traces';
// change lands after the detector has a clean baseline (needs ~5 summarizer calls)
const PROMPT_CHANGE_MS = Number(process.env.PROMPT_CHANGE_MS || 180_000);
const started = Date.now();

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const jitter = (n) => Math.round(n * (0.85 + Math.random() * 0.3));
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

const TOPICS = [
  'Q3 churn drivers in the EU cohort',
  'competitor pricing changes this week',
  'incident 4821 root cause timeline',
  'onboarding funnel drop-off at step 3',
  'renewal risk for the Meridian account',
  'API latency regression after v2.14',
];
const TICKETS = [
  'refund not received after cancellation',
  'SSO login loops back to the sign-in page',
  'CSV export missing the tax column',
  'API key rotation broke the staging webhook',
];
const ARTICLES = [
  'migrating agent workloads to batch APIs',
  'what tool schemas cost you per call',
  'observability patterns for LLM fleets',
];

function span({ trace, parent, agent, model, inTok, outTok, ctx, prompt, completion }) {
  const now = Date.now();
  const attrs = [
    { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
    { key: 'gen_ai.agent.name', value: { stringValue: agent } },
    { key: 'gen_ai.request.model', value: { stringValue: model } },
    { key: 'gen_ai.usage.input_tokens', value: { intValue: inTok } },
    { key: 'gen_ai.usage.output_tokens', value: { intValue: outTok } },
  ];
  if (prompt) attrs.push({ key: 'gen_ai.prompt', value: { stringValue: prompt } });
  if (completion) attrs.push({ key: 'gen_ai.completion', value: { stringValue: completion } });
  for (const [k, v] of Object.entries(ctx || {})) {
    attrs.push({ key: `fleetglass.context.${k}_tokens`, value: { intValue: v } });
  }
  return {
    traceId: trace,
    spanId: hex(8),
    ...(parent ? { parentSpanId: parent } : {}),
    name: `chat ${model}`,
    startTimeUnixNano: String(now * 1e6),
    attributes: attrs,
  };
}

function toolSpan({ trace, parent, agent, tool, input, output }) {
  return {
    traceId: trace,
    spanId: hex(8),
    parentSpanId: parent,
    name: `execute_tool ${tool}`,
    startTimeUnixNano: String(Date.now() * 1e6),
    attributes: [
      { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
      { key: 'gen_ai.agent.name', value: { stringValue: agent } },
      { key: 'gen_ai.tool.name', value: { stringValue: tool } },
      { key: 'fleetglass.tool.input', value: { stringValue: input } },
      { key: 'fleetglass.tool.output', value: { stringValue: output } },
    ],
  };
}

function incidentResponse() {
  const trace = hex(16);
  const spans = [];
  const promptChanged = Date.now() - started > PROMPT_CHANGE_MS;
  const topic = pick(TOPICS);

  const orch = span({
    trace, agent: 'orchestrator', model: 'claude-opus-4-8',
    inTok: jitter(3000), outTok: jitter(280),
    ctx: { system: jitter(1400), history: jitter(1100), retrieval: 0, tools: jitter(500) },
    prompt: `Task: analyze ${topic}. Decide which specialists to involve and dispatch subtasks.`,
    completion: `Plan: gather sources on "${topic}", extract key figures, escalate to summarizer if findings exceed threshold.`,
  });
  spans.push(orch);

  const r = Math.random();
  if (r < 0.48) {
    const research = span({
      trace, parent: orch.spanId, agent: 'researcher', model: 'claude-sonnet-5',
      inTok: jitter(8200), outTok: jitter(900),
      ctx: { system: jitter(900), history: jitter(2600), retrieval: jitter(4100), tools: jitter(600) },
      prompt: `Research: ${topic}. Use web.search, cite sources, return structured findings.`,
      completion: `Found ${2 + Math.floor(Math.random() * 4)} relevant sources on ${topic}; strongest signal from internal dashboard export.`,
    });
    spans.push(research);
    spans.push(toolSpan({
      trace, parent: research.spanId, agent: 'researcher', tool: 'web.search',
      input: JSON.stringify({ query: topic, recency_days: 7 }),
      output: JSON.stringify({ results: 2 + Math.floor(Math.random() * 4), top: `report on ${topic}` }),
    }));
    if (Math.random() < 0.12) {
      // the "bad deploy": prompt change starts re-including full retrieval history
      const history = promptChanged ? jitter(24000) : jitter(6400);
      const ctx = { system: jitter(2100), history, retrieval: jitter(3700), tools: jitter(5500) };
      spans.push(span({
        trace, parent: research.spanId, agent: 'summarizer', model: 'claude-opus-4-8',
        inTok: ctx.system + ctx.history + ctx.retrieval + ctx.tools,
        outTok: jitter(promptChanged ? 2200 : 1200),
        ctx,
        prompt: `Synthesize the research on ${topic} into an executive brief.${promptChanged ? ' [Full conversation history included below]' : ''}`,
        completion: `Executive brief — ${topic}: three findings, one recommended action, confidence medium-high.`,
      }));
    }
  } else if (r < 0.92) {
    const extract = span({
      trace, parent: orch.spanId, agent: 'extractor', model: 'claude-haiku-4-5',
      inTok: jitter(2100), outTok: jitter(160),
      ctx: { system: jitter(700), history: jitter(300), retrieval: jitter(600), tools: jitter(500) },
      prompt: `Extract entities, dates, and figures relevant to ${topic} from the attached document.`,
      completion: `{"entities": ${3 + Math.floor(Math.random() * 5)}, "figures": ${1 + Math.floor(Math.random() * 3)}}`,
    });
    spans.push(extract);
    spans.push(toolSpan({
      trace, parent: extract.spanId, agent: 'extractor', tool: 'parse_document',
      input: JSON.stringify({ doc: `${topic.replaceAll(' ', '_')}.pdf` }),
      output: JSON.stringify({ pages: 4 + Math.floor(Math.random() * 20), tables: Math.floor(Math.random() * 4) }),
    }));
  }
  return spans;
}

function supportTriage() {
  const trace = hex(16);
  const spans = [];
  const ticket = pick(TICKETS);

  const triager = span({
    trace, agent: 'triager', model: 'claude-haiku-4-5',
    inTok: jitter(1100), outTok: jitter(90),
    ctx: { system: jitter(600), history: jitter(200), retrieval: 0, tools: jitter(300) },
    prompt: `Classify this ticket and route it: "${ticket}"`,
    completion: `{"category": "billing", "priority": "p2", "route": "responder"}`,
  });
  spans.push(triager);

  if (Math.random() < 0.62) {
    const responder = span({
      trace, parent: triager.spanId, agent: 'responder', model: 'claude-sonnet-5',
      inTok: jitter(3400), outTok: jitter(420),
      ctx: { system: jitter(1200), history: jitter(700), retrieval: jitter(1100), tools: jitter(400) },
      prompt: `Draft a reply for: "${ticket}". Use the KB articles provided.`,
      completion: `Hi — thanks for flagging this. Here's what happened and how we'll fix it…`,
    });
    spans.push(responder);
    spans.push(toolSpan({
      trace, parent: responder.spanId, agent: 'responder', tool: 'kb.search',
      input: JSON.stringify({ query: ticket }),
      output: JSON.stringify({ articles: 1 + Math.floor(Math.random() * 3) }),
    }));
    if (Math.random() < 0.08) {
      spans.push(span({
        trace, parent: responder.spanId, agent: 'escalator', model: 'claude-opus-4-8',
        inTok: jitter(5600), outTok: jitter(500),
        ctx: { system: jitter(1500), history: jitter(2400), retrieval: jitter(1300), tools: jitter(400) },
        prompt: `This ticket needs human-level judgment: "${ticket}". Summarize for the escalation queue.`,
        completion: `Escalation summary: customer-impacting billing defect, recommend refund + eng ticket.`,
      }));
    }
  }
  return spans;
}

function contentPipeline() {
  const trace = hex(16);
  const spans = [];
  const article = pick(ARTICLES);

  const crawler = span({
    trace, agent: 'crawler', model: 'claude-haiku-4-5',
    inTok: jitter(1800), outTok: jitter(200),
    ctx: { system: jitter(500), history: 0, retrieval: jitter(900), tools: jitter(400) },
    prompt: `Collect source material for an article on ${article}.`,
    completion: `Collected ${3 + Math.floor(Math.random() * 5)} sources, deduplicated to key excerpts.`,
  });
  spans.push(crawler);
  spans.push(toolSpan({
    trace, parent: crawler.spanId, agent: 'crawler', tool: 'web.fetch',
    input: JSON.stringify({ topic: article }),
    output: JSON.stringify({ pages: 3 + Math.floor(Math.random() * 5) }),
  }));

  if (Math.random() < 0.7) {
    const writer = span({
      trace, parent: crawler.spanId, agent: 'writer', model: 'claude-sonnet-5',
      inTok: jitter(6800), outTok: jitter(1500),
      ctx: { system: jitter(1100), history: jitter(500), retrieval: jitter(4200), tools: jitter(300) },
      prompt: `Write a first draft on ${article} from the collected sources.`,
      completion: `# ${article}\n\nDraft: 900 words, five sections, two pull quotes.`,
    });
    spans.push(writer);
    if (Math.random() < 0.3) {
      spans.push(span({
        trace, parent: writer.spanId, agent: 'reviewer', model: 'claude-opus-4-8',
        inTok: jitter(4200), outTok: jitter(380),
        ctx: { system: jitter(900), history: jitter(2000), retrieval: jitter(800), tools: jitter(200) },
        prompt: `Review the draft on ${article} for accuracy and tone. Return edits.`,
        completion: `Review: 2 factual fixes, tighten the intro, approve after edits.`,
      }));
    }
  }
  return spans;
}

const WORKFLOWS = [
  { name: 'incident-response', weight: 0.45, build: incidentResponse },
  { name: 'support-triage', weight: 0.35, build: supportTriage },
  { name: 'content-pipeline', weight: 0.2, build: contentPipeline },
];

function pickWorkflow() {
  let r = Math.random();
  for (const w of WORKFLOWS) { r -= w.weight; if (r <= 0) return w; }
  return WORKFLOWS[0];
}

async function tick() {
  const wf = pickWorkflow();
  const body = {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: wf.name } }] },
      scopeSpans: [{ spans: wf.build() }],
    }],
  };
  try {
    await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    console.error('post failed:', e.message);
  }
}

console.log(`simulating ${WORKFLOWS.length} workflows → ${ENDPOINT} (incident-response prompt change at t+${PROMPT_CHANGE_MS / 1000}s)`);
setInterval(tick, 500);
