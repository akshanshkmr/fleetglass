import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRegression } from './regression.js';

const mkStep = (completion) => ({ kind: 'chat', model: 'claude-opus-4-8', cost: 0.03, completion, request: { system: 'old', messages: [{ role: 'user', content: 'q' }] } });

test('identical new output → agreement 1, nothing changed, zero drift', async () => {
  const steps = [mkStep('same answer'), mkStep('same answer')];
  const fork = async (s) => ({ original: { cost: 0.03, completion: s.completion }, fork: { cost: 0.03, completion: s.completion } });
  const score = async (a, b) => ({ score: a === b ? 1 : 0 });
  const r = await analyzeRegression({ steps, agent: 'x', newSystem: 'new', callsPerMonth: 1000, fork, score });
  assert.equal(r.samples, 2);
  assert.equal(r.meanAgreement, 1);
  assert.equal(r.changed, 0);
  assert.equal(r.costDeltaPct, 0);
  assert.equal(r.lengthDeltaPct, 0);
  assert.equal(r.rows.length, 2);
});

test('differing new output → counts changed, computes cost/length drift', async () => {
  const steps = [mkStep('short')]; // baseline len 5
  // new prompt: different, longer output, cheaper call
  const fork = async (s) => ({ original: { cost: 0.03, completion: s.completion }, fork: { cost: 0.024, completion: 'a much longer answer' } });
  const score = async () => ({ score: 0.4 });
  const r = await analyzeRegression({ steps, agent: 'x', newSystem: 'new', callsPerMonth: 1000, fork, score });
  assert.equal(r.changed, 1);            // 0.4 < 0.95
  assert.equal(r.meanAgreement, 0.4);
  assert.ok(Math.abs(r.costDeltaPct - (-0.2)) < 1e-9);   // (0.024-0.03)/0.03
  assert.ok(r.lengthDeltaPct > 0);       // 'a much longer answer' longer than 'short'
});

test('the fork request has the new system prompt swapped in', async () => {
  let seen;
  const fork = async (s) => { seen = s.request.system; return { original: { cost: 0.03, completion: 'x' }, fork: { cost: 0.03, completion: 'x' } }; };
  await analyzeRegression({ steps: [mkStep('x')], agent: 'x', newSystem: 'THE NEW PROMPT', callsPerMonth: 1, fork, score: async () => ({ score: 1 }) });
  assert.equal(seen, 'THE NEW PROMPT');
});

test('empty sample → samples 0, empty rows', async () => {
  const r = await analyzeRegression({ steps: [], agent: 'x', newSystem: 'new', callsPerMonth: 1, fork: async () => ({}), score: async () => ({ score: 1 }) });
  assert.equal(r.samples, 0);
  assert.deepEqual(r.rows, []);
});
