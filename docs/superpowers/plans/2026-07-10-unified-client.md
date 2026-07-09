# Unified Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `fleetglass({ model }).chat(input)` — one provider-agnostic client that runs the call over the existing REST translator and auto-emits the same trace span as `wrap()`.

**Architecture:** The client is a thin forward-facing shell over `translate.js` (canonical `{system, messages, tools}` → provider REST → parsed response), reusing the engine the fork tool already exercises. `translate.js` moves into the SDK (`sdk/node/`) so the SDK stays self-contained; a one-line root re-export shim keeps the 5 control-plane importers untouched. Every call emits a chat span via an internal tracer, so topology/cost/yield/pathology/savings all light up unchanged.

**Tech Stack:** Node ≥ 20, ESM, `node:test`, zero runtime dependencies.

## Global Constraints

- **Zero dependencies.** Core and SDK add no runtime or peer deps. `sdk/node/` must import nothing from repo root (stays copy-installable).
- **ESM only**, Node ≥ 20 (`package.json` `engines`).
- **Error inversion.** The client *is* the call path: provider/network errors (non-2xx) and missing-key/unknown-provider **must throw**. The span *emit* is telemetry-safe (wrapped in try/catch, a failed emit never breaks a successful call).
- **Additive.** Nothing removed from `sdk/node/index.js`; `wrap()`/`createTracer` keep working. No behavior change to `fork.js`/`savings.js`/`judge.js`/`server.js`.
- **Commits** end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Spec: `docs/superpowers/specs/2026-07-10-unified-client-design.md`.

---

### Task 1: Relocate the translator into the SDK (with key resolution)

Pure refactor — no behavior change. Move `translate.js` into `sdk/node/`, add `KEY_ENV`/`keyFor` there, leave a root re-export shim, and point `fork.js` at the new home while still re-exporting `keyFor` for `server.js`.

**Files:**
- Create: `sdk/node/translate.js` (moved content + `KEY_ENV`/`keyFor`)
- Modify: `translate.js` (repo root → one-line shim)
- Modify: `fork.js` (drop local `KEY_ENV`/`keyFor`; import from translator; re-export `keyFor`)
- Test: `translate.test.js` (existing, at root — add one `keyFor` assertion)

**Interfaces:**
- Produces: `sdk/node/translate.js` exports `providerOf(model)`, `toProvider(canonical, {provider, model, maxTokens, key})`, `parseResponse(provider, data)`, `KEY_ENV`, `keyFor(provider)`.
- Root `translate.js` re-exports all of the above unchanged (so `./translate.js` importers are untouched).
- `fork.js` continues to export `keyFor` and `httpCall` (server.js/judge.js unaffected).

- [ ] **Step 1: Move the file and add key resolution**

Move the current contents of `translate.js` into a new `sdk/node/translate.js`, and append the key helpers (verbatim from what `fork.js` has today):

```js
// sdk/node/translate.js — canonical request { system, messages, tools } → each
// provider's real REST request, and each provider's response → { completion, inTok, outTok }.
// Pure and zero-dep; the SDK's provider-protocol layer, shared by the unified
// client and the control-plane fork engine.

const PREFIX = [['claude-', 'anthropic'], ['gpt-', 'openai'], ['o4', 'openai'], ['o3', 'openai'], ['gemini-', 'google']];
export function providerOf(model) {
  const hit = PREFIX.find(([p]) => model.startsWith(p));
  return hit ? hit[1] : null;
}

export function toProvider(canonical, { provider, model, maxTokens, key }) {
  const { system = '', messages = [], tools } = canonical || {};
  if (provider === 'anthropic') {
    const body = { model, max_tokens: maxTokens, messages: messages.map((m) => ({ role: m.role, content: m.content })) };
    if (system) body.system = system;
    if (tools) body.tools = tools;
    return { url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body };
  }
  if (provider === 'openai') {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : [...messages];
    const body = { model, max_completion_tokens: maxTokens, messages: msgs };
    if (tools) body.tools = tools;
    return { url: 'https://api.openai.com/v1/chat/completions', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body };
  }
  if (provider === 'google') {
    const body = {
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: maxTokens },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools) body.tools = tools;
    return { url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body };
  }
  throw new Error(`unknown provider ${provider}`);
}

export function parseResponse(provider, data) {
  if (provider === 'anthropic') {
    return { completion: (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'), inTok: data.usage?.input_tokens || 0, outTok: data.usage?.output_tokens || 0 };
  }
  if (provider === 'openai') {
    return { completion: data.choices?.[0]?.message?.content || '', inTok: data.usage?.prompt_tokens || 0, outTok: data.usage?.completion_tokens || 0 };
  }
  if (provider === 'google') {
    const parts = data.candidates?.[0]?.content?.parts || [];
    return { completion: parts.map((p) => p.text || '').join(''), inTok: data.usageMetadata?.promptTokenCount || 0, outTok: data.usageMetadata?.candidatesTokenCount || 0 };
  }
  throw new Error(`unknown provider ${provider}`);
}

// Provider API-key resolution from the environment (shared by client + fork).
export const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY' };
export const keyFor = (provider) => process.env[KEY_ENV[provider]];
```

- [ ] **Step 2: Replace root `translate.js` with a shim**

Overwrite `translate.js` (repo root) with:

```js
// translate.js — moved to sdk/node/translate.js (the SDK owns the provider-protocol
// layer). Re-exported here so the control-plane importers stay unchanged.
export * from './sdk/node/translate.js';
```

- [ ] **Step 3: Point `fork.js` at the translator, re-export `keyFor`**

In `fork.js`, change the imports (line ~6) and delete its local `KEY_ENV`/`keyFor` (lines ~8-9). Keep `httpCall` and `forkStep` exactly as they are.

Replace:
```js
import { toProvider, parseResponse, providerOf } from './translate.js';

const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY' };
export const keyFor = (provider) => process.env[KEY_ENV[provider]];
```
with:
```js
import { toProvider, parseResponse, providerOf, keyFor, KEY_ENV } from './translate.js';

export { keyFor };  // server.js imports keyFor from here
```

(The rest of `fork.js` — `httpCall`, `forkStep`, its use of `keyFor`/`KEY_ENV` — is unchanged.)

- [ ] **Step 4: Add a `keyFor` assertion to `translate.test.js`**

Append to `translate.test.js` (which imports from `./translate.js` — the shim resolves it):

```js
test('keyFor reads the provider env var', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  assert.equal(keyFor('anthropic'), 'sk-test');
});
```

Update its import line to include `keyFor`:
```js
import { toProvider, parseResponse, providerOf, keyFor } from './translate.js';
```

- [ ] **Step 5: Run the full suite — verify no regressions**

Run: `node --test`
Expected: all tests PASS (the moved translator, `fork.test.js`, `savings`, `judge`, `store`, etc. — same count as before plus the one new `keyFor` case).

- [ ] **Step 6: Verify the SDK stays self-contained**

Run: `grep -rn "\.\./\.\./" sdk/node/*.js`
Expected: no output (`sdk/node/` imports nothing from repo root).

- [ ] **Step 7: Commit**

```bash
git add sdk/node/translate.js translate.js fork.js translate.test.js
git commit -m "refactor: move translate.js into the SDK, share keyFor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: The client call surface — `fleetglass().chat()`

Provider-agnostic call: construct with a model, resolve provider/key, accept a string or canonical input, call over the translator, return a normalized result. No tracing yet (Task 3). Tests inject `call` — no network.

**Files:**
- Create: `sdk/node/client.js`
- Test: `sdk/node/client.test.js`

**Interfaces:**
- Consumes: `toProvider`, `parseResponse`, `providerOf`, `keyFor` from `./translate.js` (Task 1).
- Produces: `fleetglass({ model, provider?, key?, maxTokens?, call? })` → `{ chat, provider, model }`.
  `chat(input, perCall?)` where `input` is a string or `{ system, messages, tools }`, `perCall` is `{ maxTokens? }`, returns `{ text, usage: { inputTokens, outputTokens }, model, raw }`. Task 3 extends the constructor (workflow/agent/captureRequests/endpoint) and adds `task`/`agent`/`flush` + span emission.

- [ ] **Step 1: Write the failing tests**

Create `sdk/node/client.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test sdk/node/client.test.js`
Expected: FAIL — `Cannot find module './client.js'` (or `fleetglass is not a function`).

- [ ] **Step 3: Implement the call surface**

Create `sdk/node/client.js`:

```js
// FleetGlass unified client: one provider-agnostic call surface over the REST
// translator. `fleetglass({ model }).chat(input)` runs the call and (Task 3) emits
// the same trace span as wrap(). Zero deps.
import { toProvider, parseResponse, providerOf, keyFor } from './translate.js';

async function httpCall(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const clamp = (n) => Math.max(256, Math.min(4096, n || 1024));
const normalize = (input) => (typeof input === 'string' ? { messages: [{ role: 'user', content: input }] } : (input || {}));

export function fleetglass(opts = {}) {
  const { model, maxTokens: defMax, call = httpCall } = opts;
  if (!model) throw new Error('fleetglass: model is required');
  const provider = opts.provider || providerOf(model);
  if (!provider) throw new Error(`fleetglass: cannot infer provider from model ${model}`);
  const key = opts.key || keyFor(provider);
  if (!key) { const e = new Error(`fleetglass: no API key for ${provider} (pass key, or set ${provider}'s env var)`); e.code = 'NO_KEY'; throw e; }

  async function chat(input, perCall = {}) {
    const req = normalize(input);
    const maxTokens = clamp(perCall.maxTokens ?? defMax);
    const { url, headers, body } = toProvider(req, { provider, model, maxTokens, key });
    const data = await call(url, headers, body);          // throws on API/network error
    const { completion, inTok, outTok } = parseResponse(provider, data);
    return { text: completion, usage: { inputTokens: inTok, outputTokens: outTok }, model, raw: data };
  }

  return { chat, provider, model };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test sdk/node/client.test.js`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add sdk/node/client.js sdk/node/client.test.js
git commit -m "feat(sdk): unified client call surface — fleetglass().chat()

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Tracing integration + auto-wrap + export

Make each call emit the same chat span as `wrap()` (context breakdown + captured request), auto-wrap un-scoped calls in an implicit task/agent, expose `task`/`agent`/`flush`, and export `fleetglass` from the SDK index. The span emit is telemetry-safe; the call still throws on API errors.

**Files:**
- Modify: `sdk/node/client.js`
- Modify: `sdk/node/index.js` (add export)
- Test: `sdk/node/client.test.js` (add span + auto-wrap tests)

**Interfaces:**
- Consumes: `createTracer`, `currentFrame` from `./tracer.js`.
- Produces: `fleetglass({ model, provider?, key?, workflow?, agent?, captureRequests?, maxTokens?, endpoint?, call? })` → `{ chat, task, agent, flush, provider, model }`. Every `chat` emits a chat span (via an internal tracer) using the `post` transport; auto-wraps when there's no active frame. `fleetglass` is exported from `sdk/node/index.js`.

- [ ] **Step 1: Write the failing tests**

Append to `sdk/node/client.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test sdk/node/client.test.js`
Expected: FAIL — new tests fail (`fg.flush is not a function`, no spans captured).

- [ ] **Step 3: Wire the tracer into the client**

Edit `sdk/node/client.js`. Add the tracer import at the top:

```js
import { createTracer, currentFrame } from './tracer.js';
```

Add these helpers next to `clamp`/`normalize`:

```js
const lastUser = (messages) => [...(messages || [])].reverse().find((m) => m.role === 'user')?.content || '';
const historyText = (messages) => (messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
```

Replace the body of `fleetglass` (from the destructure through `return`) with the tracing version:

```js
export function fleetglass(opts = {}) {
  const { model, maxTokens: defMax, workflow = 'default', agent = 'agent', captureRequests = false, endpoint, post, call = httpCall } = opts;
  if (!model) throw new Error('fleetglass: model is required');
  const provider = opts.provider || providerOf(model);
  if (!provider) throw new Error(`fleetglass: cannot infer provider from model ${model}`);
  const key = opts.key || keyFor(provider);
  if (!key) { const e = new Error(`fleetglass: no API key for ${provider} (pass key, or set ${provider}'s env var)`); e.code = 'NO_KEY'; throw e; }

  // Telemetry must never break the call. The default transport already swallows
  // fetch errors; a custom `post` might not — and auto-wrap awaits flush() in
  // task's finally, so an unswallowed transport error would reject the call. Wrap it.
  const safePost = post ? async (spans) => { try { await post(spans); } catch { /* drop */ } } : undefined;
  const tracer = createTracer({ workflow, endpoint, captureRequests, ...(safePost ? { post: safePost } : {}) });

  async function runCall(req, maxTokens) {
    const { url, headers, body } = toProvider(req, { provider, model, maxTokens, key });
    const data = await call(url, headers, body);          // throws on API/network error
    const { completion, inTok, outTok } = parseResponse(provider, data);
    try {
      tracer.emitChat({
        model, inputTokens: inTok, outputTokens: outTok,
        prompt: lastUser(req.messages), completion,
        context: { system: req.system || '', history: historyText(req.messages), tools: req.tools ? JSON.stringify(req.tools) : '' },
        request: req,
      });
    } catch { /* telemetry must never break a successful call */ }
    return { text: completion, usage: { inputTokens: inTok, outputTokens: outTok }, model, raw: data };
  }

  async function chat(input, perCall = {}) {
    const req = normalize(input);
    const maxTokens = clamp(perCall.maxTokens ?? defMax);
    if (currentFrame()) return runCall(req, maxTokens);                  // inside user's task/agent
    return tracer.task(() => tracer.agent(agent, () => runCall(req, maxTokens)));  // auto-wrap
  }

  return { chat, task: tracer.task, agent: tracer.agent, flush: tracer.flush, provider, model };
}
```

(The module-level `httpCall`, `clamp`, `normalize` from Task 2 stay as-is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test sdk/node/client.test.js`
Expected: all tests PASS (Task 2's 7 + the 4 new). The `post`-passing tests capture spans; `captureRequests` toggles the `fleetglass.request` attr; explicit `fg.agent` names the span; a throwing `post` doesn't break the call.

- [ ] **Step 5: Export from the SDK index**

Edit `sdk/node/index.js` to add the client export (additive):

```js
export { createTracer, currentFrame } from './tracer.js';
export { wrap } from './adapters.js';
export { fleetglass } from './client.js';
```

- [ ] **Step 6: Run the whole suite**

Run: `node --test`
Expected: everything PASS — SDK client tests, tracer/adapter tests, and all control-plane tests (unaffected by Task 1's move).

- [ ] **Step 7: Commit**

```bash
git add sdk/node/client.js sdk/node/index.js sdk/node/client.test.js
git commit -m "feat(sdk): client emits chat spans + auto-wrap; export fleetglass

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- REST over translator (no provider SDKs) → Task 2/3 (`toProvider`/`parseResponse`). ✅
- `translate.js` → SDK + root shim + `keyFor`/`KEY_ENV` moved → Task 1. ✅
- Constructor (model required, provider inferred, key from env, workflow/agent/captureRequests/maxTokens/endpoint) → Task 2 (call subset) + Task 3 (tracing options). ✅
- Call surface: string|canonical input, `{text, usage, model, raw}` return, maxTokens clamp, no cost → Task 2. ✅
- Same span as `wrap()` (context + request) → Task 3. ✅
- Auto-wrap scoping → Task 3. ✅
- Error inversion (API throws, emit telemetry-safe) → Task 2 (throw) + Task 3 (safe emit). ✅
- Index export → Task 3. ✅
- Non-goals (streaming, tool loops, multimodal, retries, act-features) → not implemented, correct. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✅

**Type consistency:** `fleetglass(opts)` → `{ chat, task, agent, flush, provider, model }` consistent across Tasks 2–3; `chat(input, perCall)` → `{ text, usage:{inputTokens,outputTokens}, model, raw }` consistent; `call(url, headers, body)` seam consistent with `toProvider`'s `{url, headers, body}` output and `fork.js`'s `httpCall`. ✅
