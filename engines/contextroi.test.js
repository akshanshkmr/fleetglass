import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ablations, analyzeContext } from './contextroi.js';

const mkStep = (i) => ({
  kind: 'chat', model: 'claude-opus-4-8', cost: 0.03, completion: `{"n":${i}}`,
  request: { system: 'sys', tools: [{ name: 't' }], messages: [
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
  ] },
});

test('ablations emits a variant per present segment', () => {
  assert.deepEqual(ablations(mkStep(1).request).map((a) => a.segment).sort(), ['history', 'system', 'tools']);
});

test('ablations skips absent segments', () => {
  assert.deepEqual(ablations({ messages: [{ role: 'user', content: 'x' }] }).map((a) => a.segment), []);
});

test('ablations content: tools dropped, system emptied, history trimmed to last turn', () => {
  const by = Object.fromEntries(ablations(mkStep(1).request).map((a) => [a.segment, a.request]));
  assert.equal(by.tools.tools, undefined);
  assert.equal(by.system.system, '');
  assert.deepEqual(by.history.messages, [{ role: 'user', content: 'c' }]);
});

test('analyzeContext scores each ablatable segment into a finding', async () => {
  const step = mkStep(1);
  const fork = async (s, t) => ({ original: { model: s.model, cost: 0.03, completion: s.completion }, fork: { model: t.model, cost: 0.02, completion: s.completion } });
  const score = async (a, b) => ({ score: a === b ? 1 : 0 });
  const findings = await analyzeContext({ steps: [step], agent: 'x', callsPerMonth: 1000, fork, score });
  assert.equal(findings.length, 3);
  for (const f of findings) {
    assert.equal(f.agreement, 1);
    assert.equal(f.pass, true);
    assert.ok(Math.abs(f.savingsPerMo - 10) < 1e-10, `Expected savingsPerMo ~10, got ${f.savingsPerMo}`); // (0.03-0.02)*1000
    assert.equal(f.samples, 1);
  }
  assert.deepEqual(findings.map((f) => f.segment).sort(), ['history', 'system', 'tools']);
});
