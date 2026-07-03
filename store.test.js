import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, callCost } from './store.js';

const NOW = 1_800_000_000_000;

function batch(spans) {
  return { resourceSpans: [{ scopeSpans: [{ spans }] }] };
}

function chatSpan({ ts, trace = 't1', spanId, parent, agent, model = 'sonnet-5', inTok = 1000, outTok = 100 }) {
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
    ],
  };
}

test('ingest normalizes spans, derives edges, computes cost', () => {
  const store = createStore();
  store.ingest(batch([
    chatSpan({ ts: NOW - 5000, spanId: 'a', agent: 'orchestrator', model: 'opus-4-8', inTok: 3000, outTok: 300 }),
    chatSpan({ ts: NOW - 4000, spanId: 'b', parent: 'a', agent: 'researcher', inTok: 8000, outTok: 900 }),
  ]));
  const snap = store.snapshot(NOW);

  assert.equal(snap.agents.length, 2);
  assert.deepEqual(snap.edges, [{ from: 'orchestrator', to: 'researcher', rpm: 1 }]);
  const orch = snap.agents.find((a) => a.name === 'orchestrator');
  assert.ok(Math.abs(orch.spend - (3000 * 15 + 300 * 75) / 1e6) < 1e-9);
  assert.equal(snap.totals.tasksPerMin, 1);
  assert.equal(snap.totals.callsPerMin, 2);
});

test('cost table math', () => {
  assert.equal(callCost('haiku-4.5', 1_000_000, 0), 0.8);
  assert.equal(callCost('unknown-model', 1_000_000, 1_000_000), 18); // default 3/15
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
  store.ingest(batch(spans));
  const snap = store.snapshot(NOW);
  assert.equal(snap.alerts.length, 1);
  assert.equal(snap.alerts[0].agent, 'summarizer');
  assert.ok(snap.alerts[0].ratio >= 2);

  // steady traffic → no alert
  const calm = createStore();
  const calmSpans = [];
  for (let i = 0; i < 16; i++) {
    calmSpans.push(chatSpan({ ts: NOW - 300_000 + i * 18_000, trace: 'c' + i, spanId: 'c' + i, agent: 'summarizer', inTok: 5000, outTok: 500 }));
  }
  calm.ingest(batch(calmSpans));
  assert.equal(calm.snapshot(NOW).alerts.length, 0);
});
