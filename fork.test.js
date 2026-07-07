import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forkStep } from './fork.js';
import { callCost } from './store.js';

const step = {
  kind: 'chat', model: 'claude-opus-4-8', in: 1000, out: 200,
  cost: callCost('claude-opus-4-8', 1000, 200),
  completion: 'orig',
  request: { system: 's', messages: [{ role: 'user', content: 'q' }], tools: null },
};

test('forkStep re-runs the captured request on a cross-provider target', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  const seen = {};
  const call = async (url, headers, body) => { seen.url = url; seen.body = body; return { candidates: [{ content: { parts: [{ text: 'cheap answer' }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 180 } }; };
  const r = await forkStep(step, { model: 'gemini-2.5-flash' }, call);
  assert.match(seen.url, /generativelanguage/);
  assert.equal(seen.body.contents[0].parts[0].text, 'q');       // faithful: real message, not a stub
  assert.equal(r.fork.completion, 'cheap answer');
  assert.equal(r.fork.cost, callCost('gemini-2.5-flash', 900, 180));
  assert.ok(r.deltaCost < 0, 'gemini flash cheaper than opus');
});

test('forkStep rejects a step with no captured request', async () => {
  await assert.rejects(forkStep({ kind: 'chat', model: 'claude-opus-4-8' }, { model: 'claude-haiku-4-5' }, async () => ({})), /captured request/);
});

test('forkStep errors NO_KEY when the target provider key is missing', async () => {
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(forkStep(step, { model: 'gpt-4o-mini' }, async () => ({})), /OPENAI_API_KEY/);
});

test('cross-provider fork drops tools (avoids a mismatched schema 400)', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  const toolStep = { kind: 'chat', model: 'claude-opus-4-8', out: 200, cost: 1, completion: 'o',
    request: { system: 's', messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'search' }] } };
  let seen;
  const call = async (url, headers, body) => { seen = body; return { candidates: [{ content: { parts: [{ text: 'a' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }; };
  await forkStep(toolStep, { model: 'gemini-2.5-flash' }, call);
  assert.equal(seen.tools, undefined, 'tools dropped cross-provider');
});

test('same-provider fork keeps tools verbatim', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const toolStep = { kind: 'chat', model: 'claude-opus-4-8', out: 200, cost: 1, completion: 'o',
    request: { system: 's', messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'search' }] } };
  let seen;
  const call = async (url, headers, body) => { seen = body; return { content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 10, output_tokens: 5 } }; };
  await forkStep(toolStep, { model: 'claude-haiku-4-5' }, call);
  assert.deepEqual(seen.tools, [{ name: 'search' }], 'tools kept same-provider');
});

test('forkStep rejects an empty messages array', async () => {
  await assert.rejects(forkStep({ kind: 'chat', model: 'claude-opus-4-8', request: { messages: [] } }, { model: 'claude-haiku-4-5' }, async () => ({})), /captured request/);
});
