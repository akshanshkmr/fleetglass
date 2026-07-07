import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeJudge } from './judge.js';

test('makeJudge builds a judge prompt and parses a float score', async () => {
  let seen;
  const call = async (url, headers, body) => { seen = body; return { candidates: [{ content: { parts: [{ text: '0.9' }] } }], usageMetadata: {} }; };
  const judge = makeJudge({ model: 'gemini-2.5-flash', key: 'k', call });
  const s = await judge('answer A', 'answer B');
  assert.equal(s, 0.9);
  const prompt = JSON.stringify(seen);
  assert.match(prompt, /answer A/);
  assert.match(prompt, /answer B/);
});

test('makeJudge clamps and defaults a non-numeric reply to 0', async () => {
  const judge = makeJudge({ model: 'gemini-2.5-flash', key: 'k', call: async () => ({ candidates: [{ content: { parts: [{ text: 'not a number' }] } }], usageMetadata: {} }) });
  assert.equal(await judge('a', 'b'), 0);
});
