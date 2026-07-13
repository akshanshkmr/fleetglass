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

// A test transport captures spans instead of POSTing them.
function tracing(model, extra = {}) {
  const sent = [];
  const fg = fleetglass({
    model, key: 'k',
    call: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 7, output_tokens: 2 } }),
    post: async (spans) => sent.push(...spans),
    ...extra,
  });
  return { fg, sent };
}
const attr = (s, k) => s.attributes.find((a) => a.key === k)?.value;

test('a bare chat auto-wraps and emits one chat span', async () => {
  const { fg, sent } = tracing('claude-sonnet-5');
  await fg.chat('hi');
  await fg.flush();
  assert.equal(sent.length, 1);
  assert.equal(attr(sent[0], 'gen_ai.operation.name').stringValue, 'chat');
  assert.equal(attr(sent[0], 'gen_ai.usage.input_tokens').intValue, 7);
});

test('captureRequests off → no fleetglass.request attr; on → present', async () => {
  const off = tracing('claude-sonnet-5');
  await off.fg.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await off.fg.flush();
  assert.equal(attr(off.sent[0], 'fleetglass.request'), undefined);

  const on = tracing('claude-sonnet-5', { captureRequests: true });
  await on.fg.chat({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
  await on.fg.flush();
  const blob = attr(on.sent[0], 'fleetglass.request').stringValue;
  assert.match(blob, /"system":"s"/);
});

test('explicit fg.agent names the span (topology preserved)', async () => {
  const { fg, sent } = tracing('claude-sonnet-5');
  await fg.task(async () => { await fg.agent('planner', async () => { await fg.chat('hi'); }); });
  await fg.flush();
  assert.equal(attr(sent[0], 'gen_ai.agent.name').stringValue, 'planner');
});

test('emit failure never breaks a successful call', async () => {
  const fg = fleetglass({
    model: 'claude-sonnet-5', key: 'k',
    call: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }),
    post: async () => { throw new Error('collector down'); },
  });
  const r = await fg.chat('hi');   // must resolve despite the transport throwing
  assert.equal(r.text, 'ok');
});

// A stub provider `call` that counts invocations and returns an anthropic-shaped reply.
function countingCall(counter) {
  return async () => { counter.n++; return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }; };
}

test('killed task: the next chat throws KILLED and does not call the provider', async () => {
  const counter = { n: 0 };
  // post echoes the just-emitted trace back as killed → the next call in the same task is armed.
  const post = async (spans) => ({ killed: [spans[0].traceId] });
  const fg = fleetglass({ model: 'claude-sonnet-5', key: 'k', call: countingCall(counter), post });
  await assert.rejects(
    fg.task(async () => {
      await fg.chat('one');   // runs; post marks this trace killed
      await fg.chat('two');   // trace killed → throws before the provider call
    }),
    (e) => e.code === 'KILLED',
  );
  assert.equal(counter.n, 1); // provider called exactly once
});

test('not killed: every chat in the task runs', async () => {
  const counter = { n: 0 };
  const fg = fleetglass({ model: 'claude-sonnet-5', key: 'k', call: countingCall(counter), post: async () => ({ killed: [] }) });
  await fg.task(async () => { await fg.chat('one'); await fg.chat('two'); });
  assert.equal(counter.n, 2);
});

test('a throwing telemetry post never breaks the call', async () => {
  const counter = { n: 0 };
  const fg = fleetglass({ model: 'claude-sonnet-5', key: 'k', call: countingCall(counter), post: async () => { throw new Error('boom'); } });
  const r = await fg.chat('hi'); // auto-wrap; post throws but is swallowed
  assert.equal(r.text, 'ok');
  assert.equal(counter.n, 1);
});

// Records the provider request's `model` (anthropic/openai put it in the body) per call.
function modelCapturingCall(models) {
  return async (url, headers, body) => { models.push(body.model); return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }; };
}

test('routed agent: after harvest, the next same-provider call swaps to the cheaper model', async () => {
  const models = [];
  const post = async () => ({ routes: { 'default/agent': 'claude-haiku-4-5' } });
  const fg = fleetglass({ model: 'claude-sonnet-5', key: 'k', call: modelCapturingCall(models), post });
  await fg.task(async () => { await fg.chat('a'); await fg.chat('b'); });
  assert.equal(models[0], 'claude-sonnet-5'); // first call: routeMap not harvested yet
  assert.equal(models[1], 'claude-haiku-4-5'); // second call: routed (same provider)
});

test('cross-provider route is ignored — the call stays on the original model', async () => {
  const models = [];
  const post = async () => ({ routes: { 'default/agent': 'gemini-2.0-flash' } }); // different provider
  const fg = fleetglass({ model: 'claude-sonnet-5', key: 'k', call: modelCapturingCall(models), post });
  await fg.task(async () => { await fg.chat('a'); await fg.chat('b'); });
  assert.equal(models[1], 'claude-sonnet-5'); // cross-provider route not applied
});

test('no route: model unchanged and result reports the model actually used', async () => {
  const models = [];
  const fg = fleetglass({ model: 'claude-sonnet-5', key: 'k', call: modelCapturingCall(models), post: async () => ({}) });
  const r = await fg.chat('a');
  assert.equal(models[0], 'claude-sonnet-5');
  assert.equal(r.model, 'claude-sonnet-5');
});
