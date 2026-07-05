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
