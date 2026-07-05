import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracer, currentFrame } from './index.js';

test('emitChat outside a task throws', () => {
  const fg = createTracer();
  assert.throws(() => fg.emitChat({ model: 'm' }), /task\(\)/);
});

test('nested agents thread parent span → cross-agent handoff', async () => {
  const sent = [];
  const fg = createTracer({ post: async (spans) => sent.push(...spans) }); // test seam
  await fg.task(async () => {
    await fg.agent('orchestrator', async () => {
      fg.emitChat({ model: 'a', inputTokens: 10, outputTokens: 2, prompt: 'p', completion: 'c' });
      await fg.agent('researcher', async () => {
        fg.emitChat({ model: 'b', inputTokens: 10, outputTokens: 2, prompt: 'p', completion: 'c' });
      });
    });
  });
  await fg.flush();
  const attr = (s, k) => s.attributes.find((a) => a.key === k)?.value?.stringValue;
  const orch = sent.find((s) => attr(s, 'gen_ai.agent.name') === 'orchestrator');
  const res = sent.find((s) => attr(s, 'gen_ai.agent.name') === 'researcher');
  assert.equal(res.parentSpanId, orch.spanId, 'researcher span parents onto orchestrator span');
  assert.equal(orch.traceId, res.traceId, 'same trace');
});

test('sequential agents thread parents → handoff chain', async () => {
  const sent = [];
  const fg = createTracer({ post: async (spans) => sent.push(...spans) });
  await fg.task(async () => {
    await fg.agent('planner', async () => { fg.emitChat({ model: 'a', inputTokens: 1, outputTokens: 1 }); });
    await fg.agent('searcher', async () => { fg.emitChat({ model: 'b', inputTokens: 1, outputTokens: 1 }); });
    await fg.agent('writer', async () => { fg.emitChat({ model: 'c', inputTokens: 1, outputTokens: 1 }); });
  });
  await fg.flush();
  const [planner, searcher, writer] = sent;
  assert.equal(planner.parentSpanId, undefined, 'first agent has no parent');
  assert.equal(searcher.parentSpanId, planner.spanId, 'searcher parents onto planner');
  assert.equal(writer.parentSpanId, searcher.spanId, 'writer parents onto searcher');
});

test('sibling chat spans chain within an agent', async () => {
  const sent = [];
  const fg = createTracer({ post: async (spans) => sent.push(...spans) });
  await fg.task(async () => {
    await fg.agent('solo', async () => {
      fg.emitChat({ model: 'a', inputTokens: 1, outputTokens: 1 });
      fg.emitChat({ model: 'a', inputTokens: 1, outputTokens: 1 });
    });
  });
  await fg.flush();
  assert.equal(sent[1].parentSpanId, sent[0].spanId);
});
