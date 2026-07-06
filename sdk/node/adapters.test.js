import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracer } from './tracer.js';
import { wrap } from './adapters.js';

function fakeGoogle() {
  return { models: { async generateContent(req) {
    return { text: 'the answer', usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 7 }, modelVersion: req.model };
  } } };
}

test('wrap(google) emits a chat span from the response', async () => {
  const sent = [];
  const fg = createTracer({ post: async (s) => sent.push(...s) });
  const client = wrap(fakeGoogle(), fg);
  await fg.task(async () => {
    await fg.agent('planner', async () => {
      const res = await client.models.generateContent({ model: 'gemini-2.5-flash', contents: 'hello', config: { systemInstruction: 'be brief', tools: [{ name: 't' }] } });
      assert.equal(res.text, 'the answer'); // pass-through preserved
    });
  });
  await fg.flush();
  const attr = (s, k, t = 'stringValue') => s.attributes.find((a) => a.key === k)?.value?.[t];
  const span = sent[0];
  assert.equal(attr(span, 'gen_ai.agent.name'), 'planner');
  assert.equal(attr(span, 'gen_ai.request.model'), 'gemini-2.5-flash');
  assert.equal(attr(span, 'gen_ai.usage.input_tokens', 'intValue'), 42);
  assert.equal(attr(span, 'gen_ai.usage.output_tokens', 'intValue'), 7);
  assert.equal(attr(span, 'gen_ai.completion'), 'the answer');
  assert.ok(attr(span, 'fleetglass.context.system_tokens', 'intValue') >= 0);
});

test('wrap rejects an unknown client', () => {
  const fg = createTracer({ post: async () => {} });
  assert.throws(() => wrap({}, fg), /unrecognized/);
});

test('wrap is idempotent — re-wrapping does not double-emit', async () => {
  const sent = [];
  const fg = createTracer({ post: async (s) => sent.push(...s) });
  const once = wrap(fakeGoogle(), fg);
  const twice = wrap(once, fg);           // re-wrap the already-wrapped client
  assert.equal(twice, once, 're-wrap returns the same proxy');
  await fg.task(() => fg.agent('a', () => twice.models.generateContent({ model: 'm', contents: 'x' })));
  await fg.flush();
  assert.equal(sent.length, 1, 'exactly one span, not two');
});

test('wrap(google) tolerates a response with no usageMetadata', async () => {
  const sent = [];
  const fg = createTracer({ post: async (s) => sent.push(...s) });
  const client = wrap({ models: { async generateContent() { return { text: 'hi' }; } } }, fg);
  await fg.task(() => fg.agent('a', () => client.models.generateContent({ model: 'm', contents: 'x' })));
  await fg.flush();
  const attr = (s, k, t = 'stringValue') => s.attributes.find((a) => a.key === k)?.value?.[t];
  assert.equal(attr(sent[0], 'gen_ai.usage.input_tokens', 'intValue'), 0);
  assert.equal(attr(sent[0], 'gen_ai.usage.output_tokens', 'intValue'), 0);
  assert.equal(attr(sent[0], 'gen_ai.completion'), 'hi');
});

test('wrap(anthropic) emits a chat span', async () => {
  const sent = [];
  const fg = createTracer({ post: async (s) => sent.push(...s) });
  const client = wrap({ messages: { async create(p) {
    return { model: p.model, content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 3 } };
  } } }, fg);
  await fg.task(() => fg.agent('a', async () => {
    await client.messages.create({ model: 'claude-haiku-4-5', system: 'sys', messages: [{ role: 'user', content: 'q' }] });
  }));
  await fg.flush();
  const attr = (s, k, t = 'stringValue') => s.attributes.find((a) => a.key === k)?.value?.[t];
  assert.equal(attr(sent[0], 'gen_ai.request.model'), 'claude-haiku-4-5');
  assert.equal(attr(sent[0], 'gen_ai.usage.output_tokens', 'intValue'), 3);
});

test('wrap(openai) emits a chat span', async () => {
  const sent = [];
  const fg = createTracer({ post: async (s) => sent.push(...s) });
  const client = wrap({ chat: { completions: { async create(p) {
    return { model: p.model, choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 8, completion_tokens: 4 } };
  } } } }, fg);
  await fg.task(() => fg.agent('a', async () => {
    await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }] });
  }));
  await fg.flush();
  const attr = (s, k, t = 'stringValue') => s.attributes.find((a) => a.key === k)?.value?.[t];
  assert.equal(attr(sent[0], 'gen_ai.request.model'), 'gpt-4o-mini');
  assert.equal(attr(sent[0], 'gen_ai.usage.input_tokens', 'intValue'), 8);
});
