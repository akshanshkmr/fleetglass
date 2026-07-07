import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toProvider, parseResponse, providerOf } from './translate.js';

const canonical = { system: 'be brief', messages: [{ role: 'user', content: 'hi' }], tools: null };

test('providerOf maps model prefixes', () => {
  assert.equal(providerOf('claude-haiku-4-5'), 'anthropic');
  assert.equal(providerOf('gpt-4o-mini'), 'openai');
  assert.equal(providerOf('gemini-2.5-flash'), 'google');
  assert.equal(providerOf('mystery'), null);
});

test('toProvider(anthropic) shapes messages.create body', () => {
  const { url, body } = toProvider(canonical, { provider: 'anthropic', model: 'claude-haiku-4-5', maxTokens: 256, key: 'k' });
  assert.match(url, /anthropic\.com/);
  assert.equal(body.model, 'claude-haiku-4-5');
  assert.equal(body.system, 'be brief');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
});

test('toProvider(openai) folds system into a message', () => {
  const { body } = toProvider(canonical, { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 256, key: 'k' });
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'be brief');
  assert.equal(body.messages[1].content, 'hi');
});

test('toProvider(google) shapes contents + systemInstruction', () => {
  const { body } = toProvider(canonical, { provider: 'google', model: 'gemini-2.5-flash', maxTokens: 256, key: 'k' });
  assert.equal(body.contents[0].parts[0].text, 'hi');
  assert.equal(body.systemInstruction.parts[0].text, 'be brief');
});

test('parseResponse extracts completion + usage per provider', () => {
  assert.deepEqual(parseResponse('anthropic', { content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 3, output_tokens: 1 } }), { completion: 'a', inTok: 3, outTok: 1 });
  assert.deepEqual(parseResponse('openai', { choices: [{ message: { content: 'b' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }), { completion: 'b', inTok: 4, outTok: 2 });
  assert.deepEqual(parseResponse('google', { candidates: [{ content: { parts: [{ text: 'c' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }), { completion: 'c', inTok: 5, outTok: 3 });
});
