import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentYield } from './yield.js';

// two chat steps spanning exactly 1 minute → projectCallsPerMonth = 2 * 60*24*30 = 86400
const chat = (i, ctx) => ({ kind: 'chat', ts: i * 60000, cost: 0.03, ctx });
const CPM = 2 * 60 * 24 * 30;

test('cacheableTokens = mean(system+tools) across chat steps', () => {
  const y = agentYield([chat(0, { system: 1000, tools: 500, history: 9000 }), chat(1, { system: 1000, tools: 500 })], 5);
  assert.equal(y.cacheableTokens, 1500); // history excluded
});

test('cacheSavingsPerMo = tokens × callsPerMonth × inputPrice × 0.9 / 1e6', () => {
  const y = agentYield([chat(0, { system: 1000, tools: 500 }), chat(1, { system: 1000, tools: 500 })], 5);
  assert.ok(Math.abs(y.cacheSavingsPerMo - (1500 * CPM * 5 * 0.9 / 1e6)) < 1e-9);
});

test('batchSavingsPerMo = mean(cost) × callsPerMonth × 0.5', () => {
  const y = agentYield([chat(0, {}), chat(1, {})], 5);
  assert.ok(Math.abs(y.batchSavingsPerMo - (0.03 * CPM * 0.5)) < 1e-9);
});

test('no ctx → cacheableTokens 0, cache savings 0, batch still computes', () => {
  const y = agentYield([{ kind: 'chat', ts: 0, cost: 0.03 }, { kind: 'chat', ts: 60000, cost: 0.03 }], 5);
  assert.equal(y.cacheableTokens, 0);
  assert.equal(y.cacheSavingsPerMo, 0);
  assert.ok(y.batchSavingsPerMo > 0);
});

test('no chat steps → null', () => {
  assert.equal(agentYield([{ kind: 'tool' }], 5), null);
});
