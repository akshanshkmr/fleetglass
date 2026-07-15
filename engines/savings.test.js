import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleSteps, analyze, projectCallsPerMonth } from './savings.js';

const mkStep = (i) => ({ kind: 'chat', model: 'claude-opus-4-8', cost: 0.03, completion: `{"n": ${i}}`, request: { messages: [{ role: 'user', content: 'q' }] } });

test('sampleSteps takes the last N chat steps with a request', () => {
  const steps = [...Array(12)].map((_, i) => mkStep(i));
  steps.push({ kind: 'tool' }, { kind: 'chat', model: 'm' }); // no request → excluded
  assert.equal(sampleSteps(steps, 8).length, 8);
  assert.ok(sampleSteps(steps, 8).every((s) => s.request?.messages?.length));
});

test('analyze aggregates agreement + cost delta into a finding with $/mo', async () => {
  const steps = [mkStep(1), mkStep(2)];
  // fake fork: cheaper model, identical structured output → agreement 1
  const fork = async (step, target) => ({
    original: { model: step.model, cost: 0.03, completion: step.completion },
    fork: { model: target.model, cost: 0.01, completion: step.completion },
    deltaCost: -0.02,
  });
  const score = async (a, b) => ({ score: a === b ? 1 : 0 });
  const findings = await analyze({ steps, agent: 'writer', targets: [{ model: 'claude-haiku-4-5' }], callsPerMonth: 10000, fork, score });
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.agent, 'writer');
  assert.equal(f.to, 'claude-haiku-4-5');
  assert.equal(f.agreement, 1);
  assert.equal(f.costOld, 0.03);
  assert.equal(f.costNew, 0.01);
  assert.ok(Math.abs(f.savingsPerMo - 200) < 0.01); // (0.03-0.01) * 10000
  assert.equal(f.fidelity, 'exact'); // claude→claude
  assert.equal(f.pass, true);
});

test('analyze flags cross-provider fidelity', async () => {
  const fork = async (s, t) => ({ original: { model: s.model, cost: 0.03, completion: 'x' }, fork: { model: t.model, cost: 0.005, completion: 'x' }, deltaCost: -0.025 });
  const score = async () => ({ score: 0.97 });
  const [f] = await analyze({ steps: [mkStep(1)], agent: 'a', targets: [{ model: 'gemini-2.5-flash' }], callsPerMonth: 1000, fork, score });
  assert.equal(f.fidelity, 'cross-provider'); // claude→gemini
});

test('projectCallsPerMonth: rate from timespan', () => {
  // 8 steps spanning exactly 1 minute → 8 calls/min → 8 * 60*24*30
  const steps = [...Array(8)].map((_, i) => ({ ts: i * (60000 / 7) }));
  assert.equal(projectCallsPerMonth(steps), 8 * 60 * 24 * 30);
});
test('projectCallsPerMonth: single step / zero span → non-zero floor', () => {
  assert.equal(projectCallsPerMonth([{ ts: 1000 }]), 1 * 60 * 24 * 30);
});
test('projectCallsPerMonth: empty → 0', () => {
  assert.equal(projectCallsPerMonth([]), 0);
});
