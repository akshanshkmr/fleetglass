import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPathologies } from './pathology.js';

const NOW = 1_000_000_000_000;
const chat = (agent, i, inTok = 100) => ({ ts: NOW - (20 - i) * 1000, agent, kind: 'chat', in: inTok, cost: 0.01 });
const trace = (steps) => ({ start: steps[0].ts, wf: 'wf', steps });

test('ping-pong A,B,A,B,A,B,A,B → one cycle finding naming A and B', () => {
  const steps = ['A','B','A','B','A','B','A','B'].map((a, i) => chat(a, i));
  const f = detectPathologies(trace(steps), NOW);
  const cyc = f.find((x) => x.kind === 'cycle');
  assert.ok(cyc, 'cycle detected');
  assert.deepEqual(cyc.agents.sort(), ['A', 'B']);
});

test('A×8 consecutive → one retry finding for A', () => {
  const steps = [...Array(8)].map((_, i) => chat('A', i));
  const f = detectPathologies(trace(steps), NOW);
  const r = f.find((x) => x.kind === 'retry');
  assert.ok(r);
  assert.deepEqual(r.agents, ['A']);
  assert.equal(f.some((x) => x.kind === 'cycle'), false, 'no false cycle for a single agent');
});

test('input tokens 5K,9K,18K,30K,48K → one spiral finding', () => {
  const ins = [5000, 9000, 18000, 30000, 48000];
  const steps = ins.map((n, i) => chat('A', i, n));
  const f = detectPathologies(trace(steps), NOW);
  assert.ok(f.find((x) => x.kind === 'spiral'));
});

test('linear A→B→C→D → no findings (false-positive guard)', () => {
  const steps = ['A','B','C','D'].map((a, i) => chat(a, i));
  assert.deepEqual(detectPathologies(trace(steps), NOW), []);
});

test('inactive trace (last step older than ACTIVE_MS) → no findings', () => {
  const steps = ['A','B','A','B','A','B','A','B'].map((a, i) => ({ ...chat(a, i), ts: NOW - 300000 }));
  assert.deepEqual(detectPathologies(trace(steps), NOW), []);
});
