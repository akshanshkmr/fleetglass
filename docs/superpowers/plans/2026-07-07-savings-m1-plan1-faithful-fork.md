# Savings M1 · Plan 1 of 2 — Faithful Fork Substrate (S0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture each model call's full request in a provider-neutral canonical form, and re-execute any recorded chat step faithfully on any target provider/model — the keystone every savings engine's counterfactual depends on.

**Architecture:** The `wrap()` adapters normalize the request they already intercept into a canonical `{system, messages, tools}` shape and emit it (opt-in) as a `fleetglass.request` span attribute; the store persists it on the step. A new pure `translate.js` maps canonical → each provider's real request; `fork.js` is rewritten to reconstruct + translate + re-execute on any provider with that provider's key. Plan 2 (agreement metric + downgrade engine + Savings Report) builds on this.

**Tech Stack:** Node ≥20 (ESM, `node:test`, `fetch`), Python ≥3.9 (stdlib, `unittest`). Zero mandatory deps; provider calls are `fetch`/`urllib` to REST endpoints (as `fork.js` already does for Anthropic).

## Global Constraints

- **Zero mandatory runtime dependencies.** Request capture is opt-in; provider re-execution uses `fetch` (Node) / stdlib (server) to REST endpoints — no provider SDKs imported.
- **Capture is opt-in and safe:** enabled by a tracer flag `captureRequests` (default `false`); a `redact` hook runs before emit; blobs are size-capped (`maxRequestBytes`, default 16000).
- **Canonical request shape** (exact): `{ system: string, messages: [{ role: 'user'|'assistant', content: string }], tools: <passthrough or undefined> }`.
- **Observability never breaks the agent:** capture goes through the existing `safeEmit`/`_safe_emit` guard; a capture failure drops the blob, never the call.
- **Multi-provider keys** on the control plane: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`. Missing target key → a clear `NO_KEY` error, never a wrong number.
- **Cross-provider `tools` are best-effort:** translated verbatim same-provider; passed through (or dropped) cross-provider — never silently reshaped.

---

### Task 1: Canonical request capture — Node tracer + adapters

**Files:**
- Modify: `sdk/node/tracer.js` (`createTracer` options + `emitChat`)
- Modify: `sdk/node/adapters.js` (canonicalize per provider, pass `request` to `safeEmit`)
- Test: `sdk/node/adapters.test.js`

**Interfaces:**
- Consumes: existing `emitChat`, `safeEmit(fg, fields)`, `wrapGoogle/Anthropic/OpenAI`.
- Produces:
  - `createTracer({ ..., captureRequests?, redact?, maxRequestBytes? })` — capture opt-in.
  - `emitChat({ ..., request })` — when `captureRequests` and `request` present, emits attr `fleetglass.request` = JSON(redact(request)) capped to `maxRequestBytes`.
  - canonical `request` = `{ system, messages:[{role,content}], tools }` produced by each adapter.

- [ ] **Step 1: Write the failing test**

Append to `sdk/node/adapters.test.js`:
```js
test('wrap(google) captures a canonical request when enabled', async () => {
  const sent = [];
  const fg = createTracer({ post: async (s) => sent.push(...s), captureRequests: true });
  const client = wrap({ models: { async generateContent() { return { text: 'hi', usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }; } } }, fg);
  await fg.task(() => fg.agent('a', () => client.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: 'question one' }] }],
    config: { systemInstruction: 'be brief', tools: [{ name: 't' }] },
  })));
  await fg.flush();
  const raw = sent[0].attributes.find((a) => a.key === 'fleetglass.request')?.value?.stringValue;
  assert.ok(raw, 'request captured');
  const req = JSON.parse(raw);
  assert.equal(req.system, 'be brief');
  assert.deepEqual(req.messages, [{ role: 'user', content: 'question one' }]);
  assert.deepEqual(req.tools, [{ name: 't' }]);
});

test('request is NOT captured when captureRequests is off (default)', async () => {
  const sent = [];
  const fg = createTracer({ post: async (s) => sent.push(...s) });
  const client = wrap({ models: { async generateContent() { return { text: 'hi' }; } } }, fg);
  await fg.task(() => fg.agent('a', () => client.models.generateContent({ model: 'm', contents: 'x' })));
  await fg.flush();
  assert.equal(sent[0].attributes.find((a) => a.key === 'fleetglass.request'), undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test sdk/node/adapters.test.js`
Expected: FAIL — `fleetglass.request` attribute is undefined (capture not implemented).

- [ ] **Step 3: Add capture to the tracer**

In `sdk/node/tracer.js`, change the `createTracer` signature and `emitChat`:
```js
export function createTracer({ endpoint = process.env.FLEETGLASS_URL || 'http://localhost:4700/v1/traces', workflow = 'default', post, captureRequests = false, redact = (r) => r, maxRequestBytes = 16000 } = {}) {
```
Inside `emitChat`, after the `context` block that pushes `fleetglass.context.*` attrs, add:
```js
    if (captureRequests && request) {
      try {
        const blob = JSON.stringify(redact(request)).slice(0, maxRequestBytes);
        attrs.push({ key: 'fleetglass.request', value: { stringValue: blob } });
      } catch { /* capture must never break the call */ }
    }
```
and add `request` to the destructured `emitChat` params:
```js
  function emitChat({ model, inputTokens = 0, outputTokens = 0, prompt = '', completion = '', context, request } = {}) {
```

- [ ] **Step 4: Add canonicalizers + wire into the adapters**

In `sdk/node/adapters.js`, add near the top helpers (after `contentsToText`):
```js
// Provider request → canonical { system, messages:[{role,content}], tools }.
function googleMessages(contents) {
  if (typeof contents === 'string') return [{ role: 'user', content: contents }];
  if (!Array.isArray(contents)) return [];
  return contents.map((c) => ({
    role: c.role === 'model' ? 'assistant' : 'user',
    content: typeof c === 'string' ? c : (c.parts || []).map((p) => p.text || '').join(''),
  }));
}
function anthropicMessages(messages) {
  return (messages || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
  }));
}
function openaiMessages(messages) {
  return (messages || []).filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : '',
  }));
}
```
Then add `request:` to each `safeEmit(fg, {...})` call:
- in `wrapGoogle`: `request: { system: sysText(req.config?.systemInstruction), messages: googleMessages(req.contents), tools: req.config?.tools }`
- in `wrapAnthropic`: `request: { system: params.system || '', messages: anthropicMessages(params.messages), tools: params.tools }`
- in `wrapOpenAI`: `request: { system: sysFromMessages(params.messages), messages: openaiMessages(params.messages), tools: params.tools }`

- [ ] **Step 5: Run to verify it passes**

Run: `node --test sdk/node/adapters.test.js sdk/node/tracer.test.js`
Expected: PASS — all prior tests plus the 2 new capture tests.

- [ ] **Step 6: Commit**

```bash
git add sdk/node/tracer.js sdk/node/adapters.js sdk/node/adapters.test.js
git commit -m "feat(node): opt-in canonical request capture for faithful fork"
```

---

### Task 2: Canonical request capture — Python mirror

**Files:**
- Modify: `sdk/python/fleetglass/tracer.py` (`Tracer.__init__` + `emit_chat`)
- Modify: `sdk/python/fleetglass/adapters.py` (canonicalizers + `_safe_emit` calls)
- Test: `sdk/python/test_adapters.py`

**Interfaces:**
- Produces: `Tracer(endpoint=None, workflow='default', capture_requests=False, redact=None, max_request_bytes=16000)`; `emit_chat(..., request=None)` emits `fleetglass.request`; canonical shape identical to Node.

- [ ] **Step 1: Write the failing test**

Append to `sdk/python/test_adapters.py`:
```python
class TestCapture(unittest.TestCase):
    def test_google_captures_canonical_request(self):
        fg = Sink(); fg.capture_requests = True
        client = wrap(FakeClient(), fg)
        with fg.task():
            with fg.agent("a"):
                client.models.generate_content(model="gemini-2.5-flash", contents="question one",
                                               config={"system_instruction": "be brief", "tools": [{"name": "t"}]})
        fg.flush()
        raw = attr(fg.sent[0], "fleetglass.request")
        self.assertIsNotNone(raw)
        req = json.loads(raw)
        self.assertEqual(req["system"], "be brief")
        self.assertEqual(req["messages"], [{"role": "user", "content": "question one"}])

    def test_no_capture_by_default(self):
        fg = Sink()
        client = wrap(FakeClient(), fg)
        with fg.task():
            with fg.agent("a"):
                client.models.generate_content(model="m", contents="x")
        fg.flush()
        self.assertIsNone(attr(fg.sent[0], "fleetglass.request"))
```
Add `import json` at the top of the test file if absent.

- [ ] **Step 2: Run to verify it fails**

Run: `cd sdk/python && python3 -m unittest test_adapters -v`
Expected: FAIL — `fleetglass.request` is `None`.

- [ ] **Step 3: Add capture to the tracer**

In `sdk/python/fleetglass/tracer.py`, extend `__init__`:
```python
    def __init__(self, endpoint=None, workflow="default", capture_requests=False, redact=None, max_request_bytes=16000):
        self.endpoint = endpoint or os.environ.get("FLEETGLASS_URL", "http://localhost:4700/v1/traces")
        self.workflow = workflow
        self.capture_requests = capture_requests
        self.redact = redact or (lambda r: r)
        self.max_request_bytes = max_request_bytes
        self._batch = []
        self._lock = threading.Lock()
```
In `emit_chat`, add a `request=None` parameter and, after the `context` block, before building `span`:
```python
        if self.capture_requests and request is not None:
            try:
                blob = json.dumps(self.redact(request))[: self.max_request_bytes]
                attrs.append({"key": "fleetglass.request", "value": {"stringValue": blob}})
            except Exception:
                pass
```
(`json` is already imported in tracer.py.)

- [ ] **Step 4: Add canonicalizers + wire into the adapters**

In `sdk/python/fleetglass/adapters.py`, add helpers near the other `_` helpers:
```python
def _google_messages(contents):
    if isinstance(contents, str):
        return [{"role": "user", "content": contents}]
    if not isinstance(contents, (list, tuple)):
        return []
    out = []
    for c in contents:
        if isinstance(c, str):
            out.append({"role": "user", "content": c})
        else:
            parts = getattr(c, "parts", None) or (c.get("parts") if isinstance(c, dict) else None) or []
            role = getattr(c, "role", None) or (c.get("role") if isinstance(c, dict) else None)
            text = "".join((getattr(p, "text", None) or (p.get("text") if isinstance(p, dict) else "") or "") for p in parts)
            out.append({"role": "assistant" if role == "model" else "user", "content": text})
    return out

def _plain_messages(messages):
    out = []
    for m in messages or []:
        if m.get("role") == "system":
            continue
        c = m.get("content")
        out.append({"role": "assistant" if m.get("role") == "assistant" else "user",
                    "content": c if isinstance(c, str) else ""})
    return out
```
Then pass `request=` to each `_safe_emit(tracer, ...)`:
- `_wrap_google`: `request={"system": _sys_text(config), "messages": _google_messages(contents), "tools": (config or {}).get("tools") if isinstance(config, dict) else getattr(config, "tools", None)}`
- `_wrap_anthropic`: `request={"system": system or "", "messages": _plain_messages(messages), "tools": kw.get("tools")}`
- `_wrap_openai`: `request={"system": _sys_from_messages(messages), "messages": _plain_messages(messages), "tools": kw.get("tools")}`

- [ ] **Step 5: Run to verify it passes**

Run: `cd sdk/python && python3 -m unittest test_tracer test_adapters -v`
Expected: PASS — all prior tests plus the 2 new capture tests.

- [ ] **Step 6: Commit**

```bash
git add sdk/python/fleetglass/tracer.py sdk/python/fleetglass/adapters.py sdk/python/test_adapters.py
git commit -m "feat(python): opt-in canonical request capture for faithful fork"
```

---

### Task 3: Persist the captured request on the step (store.js)

**Files:**
- Modify: `store.js` (`addStep` chat branch in `ingest`)
- Test: `store.test.js`

**Interfaces:**
- Consumes: `fleetglass.request` span attribute (Tasks 1–2).
- Produces: a chat step now carries `request` (parsed canonical object) when present.

- [ ] **Step 1: Write the failing test**

Append to `store.test.js` (follow the file's existing span-building helper style):
```js
test('ingest parses fleetglass.request onto the chat step', () => {
  const store = createStore();
  const req = { system: 's', messages: [{ role: 'user', content: 'q' }], tools: null };
  store.ingest(spanBatch('wf', [chatSpan({ agent: 'a', model: 'claude-opus-4-8', in: 10, out: 2, extra: [
    { key: 'fleetglass.request', value: { stringValue: JSON.stringify(req) } },
  ] })]));
  const t = store.listTraces()[0];
  const full = store.getTrace(t.id);
  assert.deepEqual(full.steps[0].request, req);
});
```
If `store.test.js` lacks reusable `spanBatch`/`chatSpan` helpers with an `extra` attributes hook, add minimal ones mirroring the OTLP shape the store ingests (resource `service.name`, span with `gen_ai.operation.name=chat`, `gen_ai.agent.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens/output_tokens`, plus `extra` attributes).

- [ ] **Step 2: Run to verify it fails**

Run: `node --test store.test.js`
Expected: FAIL — `full.steps[0].request` is `undefined`.

- [ ] **Step 3: Persist the request**

In `store.js` `ingest`, inside the `op === 'chat'` branch, in the `addStep(s.traceId, wf, { ... })` object for chat, add a `request` field parsed from the attribute:
```js
          const reqRaw = attr(s, 'fleetglass.request');
          let request;
          if (reqRaw) { try { request = JSON.parse(reqRaw); } catch { request = undefined; } }
          addStep(s.traceId, wf, {
            ts, agent, kind: 'chat', model, in: inTok, out: outTok, cost, ctx,
            prompt: attr(s, 'gen_ai.prompt') || '',
            completion: attr(s, 'gen_ai.completion') || '',
            request,
          });
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test store.test.js`
Expected: PASS — all prior store tests plus the new one.

- [ ] **Step 5: Commit**

```bash
git add store.js store.test.js
git commit -m "feat(store): persist captured canonical request on chat steps"
```

---

### Task 4: Provider translator (`translate.js`)

**Files:**
- Create: `translate.js`
- Test: `translate.test.js`

**Interfaces:**
- Produces:
  - `PROVIDER_OF` — `{ 'claude-': 'anthropic', 'gpt-': 'openai', 'o4': 'openai', 'gemini-': 'google' }` prefix map, plus `providerOf(model) → 'anthropic'|'openai'|'google'|null`.
  - `toProvider(canonical, { provider, model, maxTokens, key }) → { url, headers, body }`.
  - `parseResponse(provider, data) → { completion, inTok, outTok }`.

- [ ] **Step 1: Write the failing test**

`translate.test.js`:
```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test translate.test.js`
Expected: FAIL — `Cannot find module './translate.js'`.

- [ ] **Step 3: Implement the translator**

`translate.js`:
```js
// translate.js — canonical request { system, messages, tools } → each provider's
// real REST request, and each provider's response → { completion, inTok, outTok }.
// Pure and zero-dep; the outbound half of the request translator.

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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test translate.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add translate.js translate.test.js
git commit -m "feat: canonical→provider request translator"
```

---

### Task 5: Faithful multi-provider fork (`fork.js`)

**Files:**
- Modify: `fork.js` (rewrite `forkStep` + provider key selection; keep the `deltaCost` result shape)
- Test: `fork.test.js` (new — replaces the inline self-check with `node --test`)

**Interfaces:**
- Consumes: `toProvider`, `parseResponse`, `providerOf` (Task 4); `callCost` (`store.js`); a step carrying `request` (Task 3).
- Produces:
  - `keyFor(provider) → string | undefined` (env: anthropic→`ANTHROPIC_API_KEY`, openai→`OPENAI_API_KEY`, google→`GEMINI_API_KEY`).
  - `forkStep(step, target, call?) → { original, fork, deltaCost }` where `target = { provider?, model }` (provider defaults to `providerOf(model)`), and `call = async (url, headers, body) => data` is injectable.

- [ ] **Step 1: Write the failing test**

`fork.test.js`:
```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test fork.test.js`
Expected: FAIL — current `forkStep(step, model, call)` has the old signature (positional model, Claude-only, prompt-based).

- [ ] **Step 3: Rewrite fork.js**

Replace the body of `fork.js` with:
```js
// fork.js — faithful, cross-provider fork-from-step: re-execute a recorded chat
// step's captured canonical request on any target provider/model, and compare
// completion + cost against the original. The counterfactual engine of the
// savings platform (M1+).
import { callCost } from './store.js';
import { toProvider, parseResponse, providerOf } from './translate.js';

const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY' };
export const keyFor = (provider) => process.env[KEY_ENV[provider]];

async function httpCall(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// `call` is injectable so tests run without a network/key.
export async function forkStep(step, target, call = httpCall) {
  if (!step || step.kind !== 'chat') throw new Error('can only fork a chat step');
  if (!step.request || !step.request.messages) throw new Error('step has no captured request — enable captureRequests to fork faithfully');
  const model = target.model;
  const provider = target.provider || providerOf(model);
  if (!provider) throw new Error(`unknown provider for model ${model}`);
  const key = keyFor(provider);
  if (!key) { const e = new Error(`${KEY_ENV[provider]} not set on the control plane`); e.code = 'NO_KEY'; throw e; }

  const maxTokens = Math.max(256, Math.min(4096, step.out || 1024));
  const { url, headers, body } = toProvider(step.request, { provider, model, maxTokens, key });
  const data = await call(url, headers, body);
  const { completion, inTok, outTok } = parseResponse(provider, data);
  const cost = callCost(model, inTok, outTok);
  return {
    original: { model: step.model, in: step.in, out: step.out, cost: step.cost, completion: step.completion },
    fork: { provider, model, in: inTok, out: outTok, cost, completion },
    deltaCost: cost - step.cost,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test fork.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add fork.js fork.test.js
git commit -m "feat: faithful cross-provider fork from captured request"
```

---

### Task 6: Wire faithful fork into the server + replay UI

**Files:**
- Modify: `server.js` (`/api/fork` handler — pass `{ provider, model }`)
- Modify: `public/app.js` (fork panel — send provider/model; the model dropdown may now offer cross-provider targets)
- Test: manual (needs live keys) + `node --test` regression

**Interfaces:**
- Consumes: `forkStep(step, { provider, model })` (Task 5).

- [ ] **Step 1: Update the server route**

In `server.js`, the `/api/fork` handler currently calls `forkStep(t && t.steps[step], model)`. Change the parse + call to the new target shape:
```js
        const { id, step, model, provider } = JSON.parse(body);
        const t = store.getTrace(id);
        const result = await forkStep(t && t.steps[step], { provider, model });
```
(The `NO_KEY` → 501 mapping already present stays correct — `forkStep` still sets `e.code = 'NO_KEY'`.)

- [ ] **Step 2: Update the replay fork panel**

In `public/app.js` `forkPanel`, the model list may now include cross-provider targets. Change `FORK_MODELS` to span providers and send `provider` in the POST:
```js
const FORK_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'gpt-4o-mini', 'gemini-2.5-flash'];
```
In the fork click handler, derive provider from the model prefix and include it in the body:
```js
      const provider = model.startsWith('claude-') ? 'anthropic' : model.startsWith('gpt-') || model.startsWith('o4') ? 'openai' : 'google';
      const res = await fetch('/api/fork', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: traceId, step: idx, model, provider }) });
```

- [ ] **Step 3: Verify no regression + faithful path is reachable**

Run: `node --test store.test.js translate.test.js fork.test.js sdk/node/*.test.js`
Expected: PASS (all).
Then a no-key smoke: `node server.js` in one shell; `POST /api/fork` for a chat step with no keys set returns HTTP 501 with a clear provider-key message (confirms wiring, no network).

- [ ] **Step 4: Manual live check (needs keys — deferred to operator)**

With `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY` set and a captured trace (run an example with `captureRequests: true`), fork a chat step cross-provider from the replay overlay; confirm the forked completion + real cost delta render.

- [ ] **Step 5: Commit**

```bash
git add server.js public/app.js
git commit -m "feat: faithful cross-provider fork in the replay overlay"
```

---

## Self-Review

**Spec coverage (of the S0 slice of the M1 spec):**
- Canonical request capture, opt-in + redaction + size cap → Tasks 1–2 (both languages). ✅
- Canonical shape `{system, messages, tools}` → Tasks 1–2 canonicalizers; asserted in tests. ✅
- Persist request on step → Task 3. ✅
- Translator canonical→provider (+ response parse) → Task 4. ✅
- Faithful cross-provider re-execution + multi-provider keys + NO_KEY error → Task 5. ✅
- Tools best-effort/passthrough (not silently reshaped) → `toProvider` passes `tools` through unchanged per provider; cross-provider fidelity flag is applied in Plan 2's engine (this plan only carries `tools` verbatim). ✅
- Server/UI reachability → Task 6. ✅
- **Deferred to Plan 2 (not this plan):** agreement metric, sampling, downgrade engine, `savingsPerMo`, Savings Report + `/api/savings`. Called out, not missing.

**Placeholder scan:** none — every code step carries complete code; the only manual step (Task 6.4) is an unavoidable live-key check, explicitly marked.

**Type consistency:** `forkStep(step, target, call)` target shape `{provider?, model}` consistent across Task 5 + Task 6; `toProvider`/`parseResponse` signatures identical in Task 4 def and Task 5 use; canonical `{system, messages:[{role,content}], tools}` identical across Tasks 1–5; capture flag named `captureRequests` (Node) / `capture_requests` (Python) consistently.
