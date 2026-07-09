import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fleetglass } from './client.js';

// A stub `call` returning an anthropic-shaped response; records the request it saw.
function anthropicStub(seen) {
  return async (url, headers, body) => {
    seen.url = url; seen.headers = headers; seen.body = body;
    return { content: [{ type: 'text', text: 'hello back' }], usage: { input_tokens: 12, output_tokens: 3 } };
  };
}

test('string input → single user message, normalized result', async () => {
  const seen = {};
  const fg = fleetglass({ model: 'claude-sonnet-5', key: 'k', call: anthropicStub(seen) });
  const r = await fg.chat('summarize this');
  assert.equal(r.text, 'hello back');
  assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 3 });
  assert.equal(r.model, 'claude-sonnet-5');
  assert.equal(seen.body.messages[0].content, 'summarize this');
  assert.equal(seen.body.messages[0].role, 'user');
});

test('canonical input passes system + tools through to the provider request', async () => {
  const seen = {};
  const fg = fleetglass({ model: 'claude-sonnet-5', key: 'k', call: anthropicStub(seen) });
  await fg.chat({ system: 'be terse', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't' }] });
  assert.equal(seen.body.system, 'be terse');
  assert.deepEqual(seen.body.tools, [{ name: 't' }]);
});

test('maxTokens: per-call overrides constructor, clamped to [256,4096]', async () => {
  const seen = {};
  const fg = fleetglass({ model: 'claude-sonnet-5', key: 'k', maxTokens: 500, call: anthropicStub(seen) });
  await fg.chat('x');
  assert.equal(seen.body.max_tokens, 500);
  await fg.chat('x', { maxTokens: 999999 });
  assert.equal(seen.body.max_tokens, 4096);        // clamped
  await fg.chat('x', { maxTokens: 1 });
  assert.equal(seen.body.max_tokens, 256);          // clamped
});

test('provider inferred from model', () => {
  const fg = fleetglass({ model: 'gemini-2.5-flash', key: 'k' });
  assert.equal(fg.provider, 'google');
});

test('unknown provider throws', () => {
  assert.throws(() => fleetglass({ model: 'llama-3', key: 'k' }), /provider/);
});

test('missing key throws NO_KEY', () => {
  delete process.env.ANTHROPIC_API_KEY;
  try { fleetglass({ model: 'claude-sonnet-5' }); assert.fail('should throw'); }
  catch (e) { assert.equal(e.code, 'NO_KEY'); }
});

test('a call error propagates (not swallowed)', async () => {
  const fg = fleetglass({ model: 'claude-sonnet-5', key: 'k', call: async () => { throw new Error('502 upstream'); } });
  await assert.rejects(fg.chat('x'), /502 upstream/);
});
