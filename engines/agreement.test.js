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

test('structuralScore is case- and whitespace-insensitive on string leaves', () => {
  assert.equal(structuralScore({ category: 'Billing', p: ' high ' }, { category: 'billing', p: 'high' }), 1);
});

test('structuralScore keeps distinct types distinct (1 vs "1" do not match)', () => {
  assert.equal(structuralScore({ n: 1 }, { n: '1' }), 0);
});

test('score treats a markdown-fenced JSON reply as JSON (structural, judge not called)', async () => {
  let judged = false;
  const r = await score('```json\n{"x": 1}\n```', '{"x": 1}', { judge: async () => { judged = true; return 0; } });
  assert.equal(r.method, 'structural');
  assert.equal(r.score, 1);
  assert.equal(judged, false);
});
