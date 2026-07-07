import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structuralScore, score } from './agreement.js';

test('structuralScore: identical JSON leaves → 1', () => {
  assert.equal(structuralScore({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }), 1);
});

test('structuralScore: half the leaves match → 0.5', () => {
  assert.equal(structuralScore({ a: 1, b: 2 }, { a: 1, b: 999 }), 0.5);
});

test('score: two JSON strings use the structural path (no judge call)', async () => {
  let judged = false;
  const r = await score('{"x": 1, "y": 2}', '{"x": 1, "y": 3}', { judge: async () => { judged = true; return 0; } });
  assert.equal(r.method, 'structural');
  assert.equal(r.score, 0.5);
  assert.equal(judged, false, 'judge must not be called when both parse as JSON');
});

test('score: free text falls back to the injected judge', async () => {
  const r = await score('the sky is blue', 'skies are blue', { judge: async (a, b) => 0.88 });
  assert.equal(r.method, 'judge');
  assert.equal(r.score, 0.88);
});

test('score: free text with no judge → method none, score 0', async () => {
  const r = await score('a', 'b');
  assert.deepEqual(r, { score: 0, method: 'none' });
});
