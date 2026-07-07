import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, callCost } from './store.js';

const NOW = 1_800_000_000_000;

function batch(spans, wf) {
  return {
    resourceSpans: [{
      ...(wf ? { resource: { attributes: [{ key: 'service.name', value: { stringValue: wf } }] } } : {}),
      scopeSpans: [{ spans }],
    }],
  };
}

function chatSpan({ ts, trace = 't1', spanId, parent, agent, model = 'claude-sonnet-5', inTok = 1000, outTok = 100, extra = [] }) {
  return {
    traceId: trace,
    spanId,
    ...(parent ? { parentSpanId: parent } : {}),
    startTimeUnixNano: String(ts * 1e6),
    attributes: [
      { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
      { key: 'gen_ai.agent.name', value: { stringValue: agent } },
      { key: 'gen_ai.request.model', value: { stringValue: model } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: inTok } },
      { key: 'gen_ai.usage.output_tokens', value: { intValue: outTok } },
      ...extra,
    ],
  };
}

test('ingest normalizes spans, derives edges, computes cost', () => {
  const store = createStore();
  store.ingest(batch([
    chatSpan({ ts: NOW - 5000, spanId: 'a', agent: 'orchestrator', model: 'claude-opus-4-8', inTok: 3000, outTok: 300 }),
    chatSpan({ ts: NOW - 4000, spanId: 'b', parent: 'a', agent: 'researcher', inTok: 8000, outTok: 900 }),
  ]));
  const snap = store.snapshot(NOW);

  assert.equal(snap.workflows.length, 1);
  const wf = snap.workflows[0];
  assert.equal(wf.name, 'default'); // no service.name resource attr
  assert.equal(wf.agents.length, 2);
  assert.deepEqual(wf.edges, [{ from: 'orchestrator', to: 'researcher', rpm: 1, pathology: false }]);
  const orch = wf.agents.find((a) => a.name === 'orchestrator');
  assert.ok(Math.abs(orch.spend - (3000 * 5 + 300 * 25) / 1e6) < 1e-9);
  assert.equal(snap.totals.tasksPerMin, 1);
  assert.equal(snap.totals.callsPerMin, 2);
});

test('workflows are isolated: same agent names, separate nodes and edges', () => {
  const store = createStore();
  store.ingest(batch([
    chatSpan({ ts: NOW - 5000, trace: 'tA', spanId: 'a1', agent: 'planner', inTok: 1000, outTok: 100 }),
    chatSpan({ ts: NOW - 4000, trace: 'tA', spanId: 'a2', parent: 'a1', agent: 'worker', inTok: 1000, outTok: 100 }),
  ], 'billing-bot'));
  store.ingest(batch([
    chatSpan({ ts: NOW - 3000, trace: 'tB', spanId: 'b1', agent: 'planner', inTok: 9000, outTok: 900 }),
  ], 'search-bot'));

  const snap = store.snapshot(NOW);
  assert.equal(snap.totals.workflows, 2);
  const billing = snap.workflows.find((w) => w.name === 'billing-bot');
  const search = snap.workflows.find((w) => w.name === 'search-bot');
  assert.deepEqual(billing.agents.map((a) => a.name).sort(), ['planner', 'worker']);
  assert.deepEqual(search.agents.map((a) => a.name), ['planner']); // its own planner, not shared
  assert.equal(billing.edges.length, 1);
  assert.equal(search.edges.length, 0);
  assert.notEqual(billing.agents.find((a) => a.name === 'planner').spend,
    search.agents.find((a) => a.name === 'planner').spend);
  assert.equal(store.getTrace('tA').wf, 'billing-bot');
});

test('cost table math', () => {
  assert.equal(callCost('claude-haiku-4-5', 1_000_000, 0), 1);
  assert.equal(callCost('claude-haiku-4-5-20251001', 1_000_000, 0), 1); // prefix match on snapshots
  assert.equal(callCost('unknown-model', 1_000_000, 1_000_000), 18); // default 3/15
});

test('traces record replayable steps in order, including tool I/O', () => {
  const store = createStore();
  const tool = {
    traceId: 't1', spanId: 'tl', parentSpanId: 'b',
    startTimeUnixNano: String((NOW - 4500) * 1e6),
    attributes: [
      { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
      { key: 'gen_ai.agent.name', value: { stringValue: 'researcher' } },
      { key: 'gen_ai.tool.name', value: { stringValue: 'web.search' } },
      { key: 'fleetglass.tool.input', value: { stringValue: '{"q":"churn"}' } },
      { key: 'fleetglass.tool.output', value: { stringValue: '{"results":3}' } },
    ],
  };
  // ingest out of order: tool span arrives before the earlier chat spans
  store.ingest(batch([tool]));
  store.ingest(batch([
    chatSpan({ ts: NOW - 5000, spanId: 'a', agent: 'orchestrator', model: 'claude-opus-4-8', inTok: 3000, outTok: 300 }),
    chatSpan({ ts: NOW - 4800, spanId: 'b', parent: 'a', agent: 'researcher', inTok: 8000, outTok: 900 }),
  ]));

  const list = store.listTraces();
  assert.equal(list.length, 1);
  assert.equal(list[0].steps, 3);
  assert.deepEqual(list[0].agents.sort(), ['orchestrator', 'researcher']);

  const t = store.getTrace('t1');
  assert.deepEqual(t.steps.map((s) => s.kind), ['chat', 'chat', 'tool']);
  assert.equal(t.steps[2].tool, 'web.search');
  assert.equal(t.steps[2].output, '{"results":3}');
  assert.equal(t.start, NOW - 5000);
});

test('ingest parses fleetglass.request onto the chat step', () => {
  const store = createStore();
  const req = { system: 's', messages: [{ role: 'user', content: 'q' }], tools: null };
  store.ingest(batch([
    chatSpan({
      ts: NOW - 5000, spanId: 'a', agent: 'a', model: 'claude-opus-4-8', inTok: 10, outTok: 2,
      extra: [{ key: 'fleetglass.request', value: { stringValue: JSON.stringify(req) } }],
    }),
  ], 'wf'));
  const t = store.listTraces()[0];
  const full = store.getTrace(t.id);
  assert.deepEqual(full.steps[0].request, req);
});

test('anomaly fires when recent cost/call doubles vs baseline', () => {
  const store = createStore();
  const spans = [];
  for (let i = 0; i < 8; i++) {
    spans.push(chatSpan({ ts: NOW - 300_000 + i * 1000, trace: 'base' + i, spanId: 'base' + i, agent: 'summarizer', inTok: 5000, outTok: 500 }));
  }
  for (let i = 0; i < 8; i++) {
    spans.push(chatSpan({ ts: NOW - 60_000 + i * 1000, trace: 'hot' + i, spanId: 'hot' + i, agent: 'summarizer', inTok: 12000, outTok: 1200 }));
  }
  store.ingest(batch(spans, 'incident-response'));
  const snap = store.snapshot(NOW);
  assert.equal(snap.alerts.length, 1);
  assert.equal(snap.alerts[0].agent, 'summarizer');
  assert.equal(snap.alerts[0].workflow, 'incident-response');
  assert.ok(snap.alerts[0].ratio >= 2);
  assert.equal(snap.workflows[0].alerts, 1);

  // steady traffic → no alert
  const calm = createStore();
  const calmSpans = [];
  for (let i = 0; i < 16; i++) {
    calmSpans.push(chatSpan({ ts: NOW - 300_000 + i * 18_000, trace: 'c' + i, spanId: 'c' + i, agent: 'summarizer', inTok: 5000, outTok: 500 }));
  }
  calm.ingest(batch(calmSpans));
  assert.equal(calm.snapshot(NOW).alerts.length, 0);
});

test('snapshot flags a ping-pong trace as a cycle pathology', () => {
  const store = createStore();
  const spans = [];
  const base = Date.now() - 1000;
  for (let i = 0; i < 8; i++) {
    spans.push(chatSpan({
      ts: base + i * 100,
      trace: 'tRACE1',
      spanId: 's' + i,
      parent: i ? 's' + (i - 1) : undefined,
      agent: i % 2 ? 'critic' : 'researcher',
      model: 'claude-opus-4-8',
      inTok: 100,
      outTok: 10,
    }));
  }
  store.ingest(batch(spans, 'wf'));
  const snap = store.snapshot();
  const cyc = snap.pathologies.find((p) => p.kind === 'cycle');
  assert.ok(cyc, 'cycle pathology present');
  assert.equal(cyc.workflow, 'wf');
  assert.deepEqual(cyc.agents.sort(), ['critic', 'researcher']);
  assert.ok(snap.workflows[0].agents.find((a) => a.name === 'researcher').pathology, 'agent flagged');
});

test('agentSteps returns an agent\'s chat steps with captured requests', () => {
  const store = createStore();
  const req = { system: 's', messages: [{ role: 'user', content: 'q' }], tools: null };
  store.ingest(batch([chatSpan({ ts: NOW - 5000, spanId: 'a', agent: 'writer', model: 'claude-opus-4-8', inTok: 10, outTok: 2, extra: [
    { key: 'fleetglass.request', value: { stringValue: JSON.stringify(req) } },
  ] })], 'wf'));
  const steps = store.agentSteps('wf', 'writer');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].agent, 'writer');
  assert.deepEqual(steps[0].request, req);
});
