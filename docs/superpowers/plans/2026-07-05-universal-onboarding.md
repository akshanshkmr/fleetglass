# Universal Onboarding SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Onboard FleetGlass into any Python or Node agent workflow, any provider, with one `wrap()` + one `agent()` — auto-capturing model, tokens, prompt, completion, cost, context breakdown, and handoffs.

**Architecture:** A per-language tracer *core* emits FleetGlass's existing JSON span format and threads the current agent + parent span through async-context (`AsyncLocalStorage` in Node, `contextvars` in Python). A thin `agent()` decorator/context-manager sets that context; provider `wrap(client)` adapters read it and map each model call's request/response onto the core's `emitChat`. The server, store, fork, and replay are unchanged.

**Tech Stack:** Node ≥18 (ESM, `node:async_hooks`, `node:test`), Python ≥3.9 (`contextvars`, stdlib `urllib` + `threading`, `unittest`), provider SDKs `@google/genai` / `google-genai` (wrapped, never a hard dep).

## Global Constraints

- **Zero mandatory runtime dependencies.** Node core is zero-dep; Python core is stdlib-only. Provider SDKs are wrapped from the instance the user passes — never imported by the SDK.
- **Observability must never break the agent.** Every network/emit path swallows its own errors and drops the batch.
- **Wire format is FleetGlass JSON** (`resourceSpans[].scopeSpans[].spans[]` with GenAI semconv attributes). No protobuf/gzip.
- **Package names:** `fleetglass` on npm and PyPI.
- **No simulated telemetry** ships in the product after this plan.
- **Span text fields cap at 4000 chars** (matches existing `tracer.js`).
- Context segments: `system` / `history` / `tools` auto-derived from the request; `retrieval` is `0` unless the caller passes an explicit `context={retrieval: ...}` override.

---

## Part A — Node SDK

### Task 1: Node tracer core with async-context

**Files:**
- Create: `sdk/node/tracer.js` (moved + evolved from root `tracer.js`)
- Create: `sdk/node/index.js`
- Create: `sdk/node/tracer.test.js`
- Delete: root `tracer.js` (after examples are repointed in Task 3/Task 9)

**Interfaces:**
- Produces:
  - `createTracer({ endpoint?, workflow? }) → fg`
  - `fg.task(fn) → Promise<any>` — runs `fn` inside a fresh trace context, auto-flushes on exit
  - `fg.agent(name, fn) → Promise<any>` — runs `fn` inside an agent scope (must be within a task)
  - `fg.withAgent` — alias of `fg.agent`
  - `fg.emitChat({ model, inputTokens, outputTokens, prompt, completion, context }) → spanId` — context-aware
  - `fg.emitTool({ tool, input, output }) → spanId` — context-aware
  - `fg.flush() → Promise<void>`
  - `currentFrame() → { trace, agent, anchor, last } | undefined` (exported for adapters/tests)

- [ ] **Step 1: Write the failing test**

`sdk/node/tracer.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracer, currentFrame } from './index.js';

test('emitChat outside a task throws', () => {
  const fg = createTracer();
  assert.throws(() => fg.emitChat({ model: 'm' }), /task\(\)/);
});

test('nested agents thread parent span → cross-agent handoff', async () => {
  const sent = [];
  const fg = createTracer({ post: async (spans) => sent.push(...spans) }); // test seam
  await fg.task(async () => {
    await fg.agent('orchestrator', async () => {
      fg.emitChat({ model: 'a', inputTokens: 10, outputTokens: 2, prompt: 'p', completion: 'c' });
      await fg.agent('researcher', async () => {
        fg.emitChat({ model: 'b', inputTokens: 10, outputTokens: 2, prompt: 'p', completion: 'c' });
      });
    });
  });
  await fg.flush();
  const attr = (s, k) => s.attributes.find((a) => a.key === k)?.value?.stringValue;
  const orch = sent.find((s) => attr(s, 'gen_ai.agent.name') === 'orchestrator');
  const res = sent.find((s) => attr(s, 'gen_ai.agent.name') === 'researcher');
  assert.equal(res.parentSpanId, orch.spanId, 'researcher span parents onto orchestrator span');
  assert.equal(orch.traceId, res.traceId, 'same trace');
});

test('sibling chat spans chain within an agent', async () => {
  const sent = [];
  const fg = createTracer({ post: async (spans) => sent.push(...spans) });
  await fg.task(async () => {
    await fg.agent('solo', async () => {
      fg.emitChat({ model: 'a', inputTokens: 1, outputTokens: 1 });
      fg.emitChat({ model: 'a', inputTokens: 1, outputTokens: 1 });
    });
  });
  await fg.flush();
  assert.equal(sent[1].parentSpanId, sent[0].spanId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test sdk/node/tracer.test.js`
Expected: FAIL — `Cannot find module './index.js'`.

- [ ] **Step 3: Write the core**

`sdk/node/tracer.js`:
```js
// FleetGlass Node tracer core: emits FleetGlass JSON spans and threads the
// current agent + parent span through AsyncLocalStorage so provider adapters
// and agent() scopes need no explicit wiring.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
export const currentFrame = () => als.getStore();

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Split real input_tokens across context segments by character share.
function contextTokens(segments, inputTokens) {
  const chars = Object.fromEntries(Object.entries(segments).map(([k, v]) => [k, (v || '').length]));
  const total = Object.values(chars).reduce((s, n) => s + n, 0) || 1;
  return Object.fromEntries(Object.entries(chars).map(([k, n]) => [k, Math.round((n / total) * inputTokens)]));
}

export function createTracer({ endpoint = process.env.FLEETGLASS_URL || 'http://localhost:4700/v1/traces', workflow = 'default', post } = {}) {
  let queue = [];
  let timer = null;

  const defaultPost = async (spans) => {
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceSpans: [{
            resource: { attributes: [{ key: 'service.name', value: { stringValue: workflow } }] },
            scopeSpans: [{ spans }],
          }],
        }),
      });
    } catch { /* observability must never break the agent */ }
  };
  const send = post || defaultPost;

  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const spans = queue;
    queue = [];
    if (spans.length) await send(spans);
  }
  function push(span) {
    queue.push(span);
    if (!timer) timer = setTimeout(() => { flush(); }, 300);
  }

  function frameOrThrow() {
    const f = currentFrame();
    if (!f) throw new Error('fleetglass: emit outside task() — wrap work in fg.task(...)');
    return f;
  }
  function nextParent(f) { return f.last || f.anchor || undefined; }

  function emitChat({ model, inputTokens = 0, outputTokens = 0, prompt = '', completion = '', context } = {}) {
    const f = frameOrThrow();
    const spanId = hex(8);
    const attrs = [
      { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
      { key: 'gen_ai.agent.name', value: { stringValue: f.agent || 'agent' } },
      { key: 'gen_ai.request.model', value: { stringValue: model || 'unknown' } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: inputTokens } },
      { key: 'gen_ai.usage.output_tokens', value: { intValue: outputTokens } },
    ];
    if (prompt) attrs.push({ key: 'gen_ai.prompt', value: { stringValue: String(prompt).slice(0, 4000) } });
    if (completion) attrs.push({ key: 'gen_ai.completion', value: { stringValue: String(completion).slice(0, 4000) } });
    if (context) for (const [k, v] of Object.entries(contextTokens(context, inputTokens))) attrs.push({ key: `fleetglass.context.${k}_tokens`, value: { intValue: v } });
    const parent = nextParent(f);
    push({ traceId: f.trace, spanId, ...(parent ? { parentSpanId: parent } : {}), name: `chat ${model}`, startTimeUnixNano: String(Date.now() * 1e6), attributes: attrs });
    f.last = spanId;
    return spanId;
  }

  function emitTool({ tool = 'tool', input = '', output = '' } = {}) {
    const f = frameOrThrow();
    const spanId = hex(8);
    const parent = nextParent(f);
    push({ traceId: f.trace, spanId, ...(parent ? { parentSpanId: parent } : {}), name: `execute_tool ${tool}`, startTimeUnixNano: String(Date.now() * 1e6), attributes: [
      { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
      { key: 'gen_ai.agent.name', value: { stringValue: f.agent || 'agent' } },
      { key: 'gen_ai.tool.name', value: { stringValue: tool } },
      { key: 'fleetglass.tool.input', value: { stringValue: String(input).slice(0, 4000) } },
      { key: 'fleetglass.tool.output', value: { stringValue: String(output).slice(0, 4000) } },
    ] });
    f.last = spanId;
    return spanId;
  }

  async function task(fn) {
    const frame = { trace: hex(16), agent: null, anchor: undefined, last: undefined };
    try { return await als.run(frame, fn); }
    finally { await flush(); }
  }

  async function agent(name, fn) {
    const p = frameOrThrow();
    const frame = { trace: p.trace, agent: name, anchor: p.last || p.anchor, last: undefined };
    return als.run(frame, fn);
  }

  const api = { task, agent, withAgent: agent, emitChat, emitTool, flush };
  return api;
}
```

`sdk/node/index.js`:
```js
export { createTracer, currentFrame } from './tracer.js';
export { wrap } from './adapters.js';
```

- [ ] **Step 4: Stub adapters so index.js imports resolve**

`sdk/node/adapters.js`:
```js
// provider adapters — filled in Task 2
export function wrap() { throw new Error('fleetglass: wrap() not yet implemented'); }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test sdk/node/tracer.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add sdk/node/tracer.js sdk/node/index.js sdk/node/adapters.js sdk/node/tracer.test.js
git commit -m "feat(node): tracer core with async-context agent/parent threading"
```

---

### Task 2: Node Google adapter (`wrap`)

**Files:**
- Modify: `sdk/node/adapters.js`
- Test: `sdk/node/adapters.test.js`

**Interfaces:**
- Consumes: `fg.emitChat(...)`, `currentFrame` from Task 1.
- Produces: `wrap(client, fg) → proxiedClient`. `fg.wrap = (client) => wrap(client, fg)` is added in this task so callers use `fg.wrap(client)`.

- [ ] **Step 1: Write the failing test** — fake `@google/genai` client shape

`sdk/node/adapters.test.js`:
```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test sdk/node/adapters.test.js`
Expected: FAIL — `wrap() not yet implemented`.

- [ ] **Step 3: Implement the adapter**

`sdk/node/adapters.js`:
```js
// Provider adapters: wrap(client) returns a proxy that auto-captures each
// model call onto fg.emitChat, reading the current agent/parent from context.

function contentsToText(contents) {
  if (typeof contents === 'string') return contents;
  if (!Array.isArray(contents)) return '';
  return contents.map((c) => typeof c === 'string' ? c : (c.parts || []).map((p) => p.text || '').join('')).join('\n');
}

function wrapGoogle(client, fg) {
  const models = client.models;
  const orig = models.generateContent.bind(models);
  const proxiedModels = new Proxy(models, {
    get(t, p) {
      if (p !== 'generateContent') return t[p];
      return async (req) => {
        const res = await orig(req);
        const um = res.usageMetadata || {};
        fg.emitChat({
          model: res.modelVersion || req.model,
          inputTokens: um.promptTokenCount || 0,
          outputTokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
          prompt: contentsToText(req.contents),
          completion: res.text || '',
          context: {
            system: sysText(req.config?.systemInstruction),
            history: contentsToText(req.contents),
            tools: req.config?.tools ? JSON.stringify(req.config.tools) : '',
          },
        });
        return res;
      };
    },
  });
  return new Proxy(client, { get(t, p) { return p === 'models' ? proxiedModels : t[p]; } });
}

function sysText(si) {
  if (!si) return '';
  if (typeof si === 'string') return si;
  return (si.parts || []).map((p) => p.text || '').join('') || String(si);
}

export function wrap(client, fg) {
  if (client?.models?.generateContent) return wrapGoogle(client, fg);
  throw new Error('fleetglass: unrecognized client (expected a @google/genai client)');
}
```

Also add `wrap` to the tracer api so `fg.wrap(client)` works — modify `createTracer` in `sdk/node/tracer.js`:
```js
// at top of tracer.js:
import { wrap as wrapClient } from './adapters.js';
// inside createTracer, replace `const api = { ... }` with:
const api = { task, agent, withAgent: agent, emitChat, emitTool, flush };
api.wrap = (client) => wrapClient(client, api);
return api;
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test sdk/node/adapters.test.js sdk/node/tracer.test.js`
Expected: PASS — 5 tests total.

- [ ] **Step 5: Commit**

```bash
git add sdk/node/adapters.js sdk/node/tracer.js sdk/node/adapters.test.js
git commit -m "feat(node): wrap() google-genai adapter auto-captures chat spans"
```

---

### Task 3: Node Gemini example (real, replaces the old one)

**Files:**
- Modify: `examples/gemini-fleet.mjs` (rewrite to the `wrap()` + `agent()` API)
- Modify: `examples/package.json` (add `@google/genai` dependency)

**Interfaces:**
- Consumes: `createTracer`, `fg.wrap`, `fg.task`, `fg.agent`, `fg.emitTool`.

- [ ] **Step 1: Add the dependency**

Edit `examples/package.json` — add to `dependencies`:
```json
"@google/genai": "^1.0.0"
```
Run: `cd examples && npm install`
Expected: installs `@google/genai`.

- [ ] **Step 2: Rewrite the example**

`examples/gemini-fleet.mjs`:
```js
// Real 3-agent Gemini research workflow, onboarded to FleetGlass with the SDK:
// one wrap(), one agent() per role. No manual span mapping.
//
//   node ../server.js                  # dashboard on :4700 (from repo root: node server.js)
//   export GEMINI_API_KEY=...          # your key — never hardcode it
//   node gemini-fleet.mjs "your question"          # add --inflate to trigger the anomaly alert
import { GoogleGenAI } from '@google/genai';
import { createTracer } from '../sdk/node/index.js';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('Set GEMINI_API_KEY first.'); process.exit(1); }

const INFLATE = process.argv.includes('--inflate');
const QUESTION = process.argv.slice(2).filter((a) => a !== '--inflate')[0] ||
  "A B2B SaaS company's trial-to-paid conversion dropped from 22% to 14% in a quarter. Likely causes, and what to investigate first?";

const fg = createTracer({ workflow: 'gemini-research' });
const ai = fg.wrap(new GoogleGenAI({ apiKey: KEY }));

const ask = (model, systemInstruction, text) =>
  ai.models.generateContent({ model, contents: text, config: { systemInstruction, maxOutputTokens: 1024 } });

await fg.task(async () => {
  const plan = await fg.agent('planner', () =>
    ask('gemini-2.5-flash', 'Break the question into at most three concrete investigation steps. Be brief.', QUESTION));

  const facts = await fg.agent('searcher', async () => {
    const bloat = INFLATE ? `\n\n[full history]\n${plan.text.repeat(40)}` : '';
    const r = await ask('gemini-2.5-flash', 'List the concrete signals/metrics to check. JSON only.', `Q: ${QUESTION}\nPlan:\n${plan.text}${bloat}`);
    fg.emitTool({ tool: 'metrics.lookup', input: QUESTION.slice(0, 160), output: r.text.slice(0, 400) });
    return r;
  });

  await fg.agent('writer', () =>
    ask('gemini-2.5-flash', 'Write a 4-sentence founder brief: most likely cause, strongest signal to check, one alternative, first action.', `Q: ${QUESTION}\nPlan:\n${plan.text}\nSignals:\n${facts.text}`));
});

console.log('Done → http://localhost:4700 (workflow: gemini-research). Click the card for topology, per-agent Gemini cost, and replay.');
```

- [ ] **Step 3: Manual end-to-end verification (needs a live key)**

Run (three shells): `node server.js`, then `cd examples && export GEMINI_API_KEY=... && node gemini-fleet.mjs`.
Expected: console "Done →"; at http://localhost:4700 a `gemini-research` card appears with planner→searcher→writer topology, real Gemini cost, and a scrubbable replay. Run again with `--inflate`; the anomaly alert fires on `searcher`.

- [ ] **Step 4: Commit**

```bash
git add examples/gemini-fleet.mjs examples/package.json examples/package-lock.json
git commit -m "feat(examples): real Gemini fleet via wrap()+agent() (Node)"
```

---

## Part B — Python SDK

### Task 4: Python package skeleton + tracer core

**Files:**
- Create: `sdk/python/pyproject.toml`
- Create: `sdk/python/fleetglass/__init__.py`
- Create: `sdk/python/fleetglass/tracer.py`
- Create: `sdk/python/test_tracer.py`

**Interfaces:**
- Produces:
  - `Tracer(endpoint=None, workflow='default')`
  - `Tracer.task()` — context manager yielding nothing; auto-flushes on exit
  - `Tracer.agent(name)` — returns an object usable as `with` and as `@decorator`
  - `Tracer.emit_chat(model, input_tokens=0, output_tokens=0, prompt='', completion='', context=None) → span_id`
  - `Tracer.emit_tool(tool='tool', input='', output='') → span_id`
  - `Tracer.flush()`
  - `Tracer.wrap(client)` — filled in Task 6
  - module-level `current_frame()`

- [ ] **Step 1: Write the failing test**

`sdk/python/test_tracer.py`:
```python
import unittest
from fleetglass.tracer import Tracer

class Sink(Tracer):
    def __init__(self):
        self.sent = []
        super().__init__()
    def _post(self, spans):
        self.sent.extend(spans)

def attr(span, key, kind='stringValue'):
    for a in span['attributes']:
        if a['key'] == key:
            return a['value'].get(kind)
    return None

class TestTracer(unittest.TestCase):
    def test_emit_outside_task_raises(self):
        with self.assertRaises(RuntimeError):
            Sink().emit_chat(model='m')

    def test_nested_agents_thread_parent(self):
        fg = Sink()
        with fg.task():
            with fg.agent('orchestrator'):
                fg.emit_chat(model='a', input_tokens=10, output_tokens=2, prompt='p', completion='c')
                with fg.agent('researcher'):
                    fg.emit_chat(model='b', input_tokens=10, output_tokens=2, prompt='p', completion='c')
        fg.flush()
        orch = next(s for s in fg.sent if attr(s, 'gen_ai.agent.name') == 'orchestrator')
        res = next(s for s in fg.sent if attr(s, 'gen_ai.agent.name') == 'researcher')
        self.assertEqual(res['parentSpanId'], orch['spanId'])
        self.assertEqual(orch['traceId'], res['traceId'])

    def test_decorator_form(self):
        fg = Sink()
        @fg.agent('worker')
        def do():
            fg.emit_chat(model='a', input_tokens=1, output_tokens=1)
        with fg.task():
            do()
        fg.flush()
        self.assertEqual(attr(fg.sent[0], 'gen_ai.agent.name'), 'worker')

if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd sdk/python && python -m unittest test_tracer -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'fleetglass'`.

- [ ] **Step 3: Write pyproject + package**

`sdk/python/pyproject.toml`:
```toml
[project]
name = "fleetglass"
version = "0.1.0"
description = "Zero-dependency tracer for onboarding agent workflows to FleetGlass."
requires-python = ">=3.9"
dependencies = []

[build-system]
requires = ["setuptools>=64"]
build-backend = "setuptools.build_meta"

[tool.setuptools]
packages = ["fleetglass"]
```

`sdk/python/fleetglass/tracer.py`:
```python
"""FleetGlass Python tracer core: emits FleetGlass JSON spans and threads the
current agent + parent span through contextvars. Stdlib only.

Batching is thread-free and deterministic: spans accumulate on the tracer and
send on flush() or when the batch hits BATCH_MAX. A lock guards the batch so
parallel worker threads can share one tracer safely.
"""
import functools, json, os, secrets, threading, time, urllib.request
import contextvars
from contextlib import contextmanager

_ctx = contextvars.ContextVar("fleetglass_frame", default=None)
BATCH_MAX = 50  # spans; flush eagerly so a long task streams to the dashboard

def current_frame():
    return _ctx.get()

class _Frame:
    __slots__ = ("trace", "agent", "anchor", "last")
    def __init__(self, trace, agent=None, anchor=None):
        self.trace, self.agent, self.anchor, self.last = trace, agent, anchor, None

def _context_tokens(segments, input_tokens):
    chars = {k: len(v or "") for k, v in segments.items()}
    total = sum(chars.values()) or 1
    return {k: round(n / total * input_tokens) for k, n in chars.items()}

class Tracer:
    def __init__(self, endpoint=None, workflow="default"):
        self.endpoint = endpoint or os.environ.get("FLEETGLASS_URL", "http://localhost:4700/v1/traces")
        self.workflow = workflow
        self._batch = []
        self._lock = threading.Lock()

    def _enqueue(self, span):
        with self._lock:
            self._batch.append(span)
            full = len(self._batch) >= BATCH_MAX
        if full:
            self.flush()

    def _post(self, spans):
        if not spans:
            return
        body = json.dumps({"resourceSpans": [{
            "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": self.workflow}}]},
            "scopeSpans": [{"spans": spans}],
        }]}).encode()
        try:
            req = urllib.request.Request(self.endpoint, data=body, headers={"content-type": "application/json"})
            urllib.request.urlopen(req, timeout=2).read()
        except Exception:
            pass  # never break the agent

    def flush(self):
        with self._lock:
            spans, self._batch = self._batch, []
        self._post(spans)  # synchronous → deterministic; Sink overrides _post in tests

    def _frame(self):
        f = _ctx.get()
        if f is None:
            raise RuntimeError("fleetglass: emit outside task() — wrap work in Tracer.task()")
        return f

    def _parent(self, f):
        return f.last or f.anchor

    def emit_chat(self, model="unknown", input_tokens=0, output_tokens=0, prompt="", completion="", context=None):
        f = self._frame()
        span_id = secrets.token_hex(8)
        attrs = [
            {"key": "gen_ai.operation.name", "value": {"stringValue": "chat"}},
            {"key": "gen_ai.agent.name", "value": {"stringValue": f.agent or "agent"}},
            {"key": "gen_ai.request.model", "value": {"stringValue": model}},
            {"key": "gen_ai.usage.input_tokens", "value": {"intValue": input_tokens}},
            {"key": "gen_ai.usage.output_tokens", "value": {"intValue": output_tokens}},
        ]
        if prompt:
            attrs.append({"key": "gen_ai.prompt", "value": {"stringValue": str(prompt)[:4000]}})
        if completion:
            attrs.append({"key": "gen_ai.completion", "value": {"stringValue": str(completion)[:4000]}})
        if context:
            for k, v in _context_tokens(context, input_tokens).items():
                attrs.append({"key": f"fleetglass.context.{k}_tokens", "value": {"intValue": v}})
        span = {"traceId": f.trace, "spanId": span_id, "name": f"chat {model}",
                "startTimeUnixNano": str(time.time_ns()), "attributes": attrs}
        parent = self._parent(f)
        if parent:
            span["parentSpanId"] = parent
        self._enqueue(span)
        f.last = span_id
        return span_id

    def emit_tool(self, tool="tool", input="", output=""):
        f = self._frame()
        span_id = secrets.token_hex(8)
        span = {"traceId": f.trace, "spanId": span_id, "name": f"execute_tool {tool}",
                "startTimeUnixNano": str(time.time_ns()), "attributes": [
                    {"key": "gen_ai.operation.name", "value": {"stringValue": "execute_tool"}},
                    {"key": "gen_ai.agent.name", "value": {"stringValue": f.agent or "agent"}},
                    {"key": "gen_ai.tool.name", "value": {"stringValue": tool}},
                    {"key": "fleetglass.tool.input", "value": {"stringValue": str(input)[:4000]}},
                    {"key": "fleetglass.tool.output", "value": {"stringValue": str(output)[:4000]}},
                ]}
        parent = self._parent(f)
        if parent:
            span["parentSpanId"] = parent
        self._enqueue(span)
        f.last = span_id
        return span_id

    @contextmanager
    def task(self):
        tok = _ctx.set(_Frame(secrets.token_hex(16)))
        try:
            yield
        finally:
            _ctx.reset(tok)
            self.flush()

    def agent(self, name):
        return _AgentScope(name)

    def wrap(self, client):
        from .adapters import wrap
        return wrap(client, self)

class _AgentScope:
    def __init__(self, name):
        self.name = name
    def __enter__(self):
        p = _ctx.get()
        if p is None:
            raise RuntimeError("fleetglass: agent() must run inside task()")
        self._tok = _ctx.set(_Frame(p.trace, self.name, p.last or p.anchor))
        return self
    def __exit__(self, *exc):
        _ctx.reset(self._tok)
        return False
    def __call__(self, fn):
        @functools.wraps(fn)
        def wrapper(*a, **kw):
            with _AgentScope(self.name):
                return fn(*a, **kw)
        return wrapper
```

`sdk/python/fleetglass/__init__.py`:
```python
from .tracer import Tracer, current_frame
__all__ = ["Tracer", "current_frame"]
```

`sdk/python/fleetglass/adapters.py` (stub, filled in Task 6):
```python
def wrap(client, tracer):
    raise NotImplementedError("fleetglass: wrap() not yet implemented")
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd sdk/python && python -m unittest test_tracer -v`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add sdk/python/pyproject.toml sdk/python/fleetglass/ sdk/python/test_tracer.py
git commit -m "feat(python): fleetglass tracer core (stdlib, contextvars)"
```

---

### Task 5: Python Google adapter (`wrap`)

**Files:**
- Modify: `sdk/python/fleetglass/adapters.py`
- Test: `sdk/python/test_adapters.py`

**Interfaces:**
- Consumes: `Tracer.emit_chat`, `current_frame`.
- Produces: `wrap(client, tracer) → proxied client`.

- [ ] **Step 1: Write the failing test** — fake `google-genai` client shape

`sdk/python/test_adapters.py`:
```python
import unittest
from fleetglass.tracer import Tracer
from fleetglass.adapters import wrap

class Sink(Tracer):
    def __init__(self):
        self.sent = []
        super().__init__()
    def _post(self, spans):
        self.sent.extend(spans)

class FakeUsage:
    prompt_token_count = 42
    candidates_token_count = 7
    thoughts_token_count = 0

class FakeResp:
    text = "the answer"
    usage_metadata = FakeUsage()
    model_version = "gemini-2.5-flash"

class FakeModels:
    def generate_content(self, model=None, contents=None, config=None):
        return FakeResp()

class FakeClient:
    def __init__(self):
        self.models = FakeModels()

def attr(span, key, kind="stringValue"):
    for a in span["attributes"]:
        if a["key"] == key:
            return a["value"].get(kind)
    return None

class TestGoogleAdapter(unittest.TestCase):
    def test_wrap_emits_span(self):
        fg = Sink()
        client = wrap(FakeClient(), fg)
        with fg.task():
            with fg.agent("planner"):
                r = client.models.generate_content(model="gemini-2.5-flash", contents="hello",
                                                    config={"system_instruction": "be brief"})
                self.assertEqual(r.text, "the answer")
        fg.flush()
        span = fg.sent[0]
        self.assertEqual(attr(span, "gen_ai.agent.name"), "planner")
        self.assertEqual(attr(span, "gen_ai.request.model"), "gemini-2.5-flash")
        self.assertEqual(attr(span, "gen_ai.usage.input_tokens", "intValue"), 42)
        self.assertEqual(attr(span, "gen_ai.completion"), "the answer")

    def test_unknown_client_raises(self):
        with self.assertRaises(TypeError):
            wrap(object(), Sink())

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd sdk/python && python -m unittest test_adapters -v`
Expected: FAIL — `NotImplementedError`.

- [ ] **Step 3: Implement the adapter**

`sdk/python/fleetglass/adapters.py`:
```python
"""Provider adapters: wrap(client) returns the same client with its completion
method intercepted to auto-capture spans onto the tracer."""

def _contents_to_text(contents):
    if isinstance(contents, str):
        return contents
    if isinstance(contents, (list, tuple)):
        out = []
        for c in contents:
            if isinstance(c, str):
                out.append(c)
            else:
                parts = getattr(c, "parts", None) or (c.get("parts") if isinstance(c, dict) else None) or []
                out.append("".join(getattr(p, "text", None) or (p.get("text") if isinstance(p, dict) else "") or "" for p in parts))
        return "\n".join(out)
    return ""

def _sys_text(config):
    if not config:
        return ""
    si = config.get("system_instruction") if isinstance(config, dict) else getattr(config, "system_instruction", None)
    if not si:
        return ""
    return si if isinstance(si, str) else str(si)

def _tools_text(config):
    if not config:
        return ""
    tools = config.get("tools") if isinstance(config, dict) else getattr(config, "tools", None)
    return "" if not tools else str(tools)

def _safe_emit(tracer, **fields):
    # Telemetry must never break the agent: a failed emit drops the span, never the call.
    try:
        tracer.emit_chat(**fields)
    except Exception:
        pass

def _wrap_google(client, tracer):
    real = client.models.generate_content

    def traced(model=None, contents=None, config=None, **kw):
        res = real(model=model, contents=contents, config=config, **kw)
        um = getattr(res, "usage_metadata", None)
        history = _contents_to_text(contents)
        _safe_emit(
            tracer,
            model=getattr(res, "model_version", None) or model or "unknown",
            input_tokens=getattr(um, "prompt_token_count", 0) or 0,
            output_tokens=(getattr(um, "candidates_token_count", 0) or 0) + (getattr(um, "thoughts_token_count", 0) or 0),
            prompt=history,
            completion=getattr(res, "text", "") or "",
            context={"system": _sys_text(config), "history": history, "tools": _tools_text(config)},
        )
        return res

    client.models.generate_content = traced  # monkey-patch the bound method on this instance
    return client

def wrap(client, tracer):
    models = getattr(client, "models", None)
    if models is not None and hasattr(models, "generate_content"):
        return _wrap_google(client, tracer)
    raise TypeError("fleetglass: unrecognized client (expected a google-genai client)")
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd sdk/python && python -m unittest test_adapters -v`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add sdk/python/fleetglass/adapters.py sdk/python/test_adapters.py
git commit -m "feat(python): wrap() google-genai adapter auto-captures chat spans"
```

---

### Task 6: Python Gemini example

**Files:**
- Create: `examples/gemini-fleet.py`
- Create: `examples/requirements.txt`

**Interfaces:**
- Consumes: `Tracer`, `fg.wrap`, `fg.task`, `fg.agent`, `fg.emit_tool`.

- [ ] **Step 1: Create requirements**

`examples/requirements.txt`:
```
google-genai>=1.0.0
fleetglass
```

- [ ] **Step 2: Write the example**

`examples/gemini-fleet.py`:
```python
"""Real 3-agent Gemini research workflow onboarded to FleetGlass: one wrap(),
one agent() per role — no manual span mapping.

    python ../server.js ...            # (dashboard: from repo root run `node server.js`)
    pip install -r requirements.txt
    pip install -e ../sdk/python
    export GEMINI_API_KEY=...
    python gemini-fleet.py "your question"      # add --inflate to trigger the anomaly alert
"""
import os, sys
from google import genai
from fleetglass import Tracer

key = os.environ.get("GEMINI_API_KEY")
if not key:
    sys.exit("Set GEMINI_API_KEY first.")

inflate = "--inflate" in sys.argv
args = [a for a in sys.argv[1:] if a != "--inflate"]
question = args[0] if args else (
    "A B2B SaaS company's trial-to-paid conversion dropped from 22% to 14% in a quarter. "
    "Likely causes, and what to investigate first?")

fg = Tracer(workflow="gemini-research")
ai = fg.wrap(genai.Client(api_key=key))

def ask(model, system, text):
    return ai.models.generate_content(
        model=model, contents=text,
        config={"system_instruction": system, "max_output_tokens": 1024})

with fg.task():
    with fg.agent("planner"):
        plan = ask("gemini-2.5-flash", "Break the question into at most three concrete investigation steps. Be brief.", question)
    with fg.agent("searcher"):
        bloat = ("\n\n[full history]\n" + plan.text * 40) if inflate else ""
        facts = ask("gemini-2.5-flash", "List the concrete signals/metrics to check. JSON only.",
                    f"Q: {question}\nPlan:\n{plan.text}{bloat}")
        fg.emit_tool(tool="metrics.lookup", input=question[:160], output=(facts.text or "")[:400])
    with fg.agent("writer"):
        ask("gemini-2.5-flash",
            "Write a 4-sentence founder brief: most likely cause, strongest signal to check, one alternative, first action.",
            f"Q: {question}\nPlan:\n{plan.text}\nSignals:\n{facts.text}")

print("Done -> http://localhost:4700 (workflow: gemini-research). Click the card for topology, per-agent Gemini cost, and replay.")
```

- [ ] **Step 3: Manual end-to-end verification (needs a live key)**

Run: `node server.js` (repo root); then `cd examples && pip install -r requirements.txt && pip install -e ../sdk/python && export GEMINI_API_KEY=... && python gemini-fleet.py`.
Expected: "Done ->"; a `gemini-research` card with planner→searcher→writer, real Gemini cost, replay. Re-run with `--inflate`; anomaly fires on `searcher`. Confirm parity with the Node example.

- [ ] **Step 4: Commit**

```bash
git add examples/gemini-fleet.py examples/requirements.txt
git commit -m "feat(examples): real Gemini fleet via wrap()+agent() (Python)"
```

---

## Part C — Additional providers, cleanup, docs

### Task 7: Anthropic + OpenAI adapters (both languages)

**Files:**
- Modify: `sdk/node/adapters.js`, `sdk/node/adapters.test.js`
- Modify: `sdk/python/fleetglass/adapters.py`, `sdk/python/test_adapters.py`
- Modify: `store.js` (add OpenAI models to `PRICES`)

**Interfaces:**
- Consumes: `emitChat` / `emit_chat`.
- Produces: `wrap()` additionally recognizes Anthropic (`messages.create`) and OpenAI (`chat.completions.create`) clients.

- [ ] **Step 1: Add OpenAI prices** — `store.js`, extend `PRICES`:
```js
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'o4-mini': [1.1, 4.4],
```
Run: `npm test`
Expected: PASS (existing suite unaffected).

- [ ] **Step 2: Node — failing tests for anthropic + openai fakes**

Append to `sdk/node/adapters.test.js`:
```js
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
```
Run: `node --test sdk/node/adapters.test.js` → FAIL (`unrecognized client`).

- [ ] **Step 3: Node — implement the two adapters** in `sdk/node/adapters.js`:
```js
function msgsText(messages) {
  const last = [...(messages || [])].reverse().find((m) => m.role === 'user');
  const c = last?.content;
  return typeof c === 'string' ? c : (c || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}
function sysFromMessages(messages) {
  return (messages || []).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
}

function wrapAnthropic(client, fg) {
  const orig = client.messages.create.bind(client.messages);
  const messages = new Proxy(client.messages, { get(t, p) {
    if (p !== 'create') return t[p];
    return async (params) => {
      const res = await orig(params);
      const u = res.usage || {};
      safeEmit(fg, {
        model: res.model || params.model,
        inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        outputTokens: u.output_tokens || 0,
        prompt: msgsText(params.messages),
        completion: (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
        context: { system: params.system || '', history: msgsText(params.messages), tools: params.tools ? JSON.stringify(params.tools) : '' },
      });
      return res;
    };
  } });
  return new Proxy(client, { get(t, p) { return p === 'messages' ? messages : t[p]; } });
}

function wrapOpenAI(client, fg) {
  const orig = client.chat.completions.create.bind(client.chat.completions);
  const completions = new Proxy(client.chat.completions, { get(t, p) {
    if (p !== 'create') return t[p];
    return async (params) => {
      const res = await orig(params);
      const u = res.usage || {};
      safeEmit(fg, {
        model: res.model || params.model,
        inputTokens: u.prompt_tokens || 0,
        outputTokens: u.completion_tokens || 0,
        prompt: msgsText(params.messages),
        completion: res.choices?.[0]?.message?.content || '',
        context: { system: sysFromMessages(params.messages), history: msgsText(params.messages), tools: params.tools ? JSON.stringify(params.tools) : '' },
      });
      return res;
    };
  } });
  const chat = new Proxy(client.chat, { get(t, p) { return p === 'completions' ? completions : t[p]; } });
  return new Proxy(client, { get(t, p) { return p === 'chat' ? chat : t[p]; } });
}
```
Extend `wrap()` dispatch:
```js
export function wrap(client, fg) {
  if (client?.models?.generateContent) return wrapGoogle(client, fg);
  if (client?.messages?.create) return wrapAnthropic(client, fg);
  if (client?.chat?.completions?.create) return wrapOpenAI(client, fg);
  throw new Error('fleetglass: unrecognized client (google-genai / anthropic / openai)');
}
```
Run: `node --test sdk/node/adapters.test.js sdk/node/tracer.test.js` → PASS.

- [ ] **Step 4: Python — failing tests + implementation** mirror Step 2/3.

Append to `sdk/python/test_adapters.py`:
```python
class FakeAnthropicMsgs:
    def create(self, model=None, system=None, messages=None, **kw):
        class R:
            pass
        r = R(); r.model = model
        r.content = [type("B", (), {"type": "text", "text": "hi"})()]
        r.usage = type("U", (), {"input_tokens": 5, "output_tokens": 3, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0})()
        return r
class FakeAnthropic:
    def __init__(self): self.messages = FakeAnthropicMsgs()

class FakeOpenAICompletions:
    def create(self, model=None, messages=None, **kw):
        class R: pass
        r = R(); r.model = model
        r.choices = [type("C", (), {"message": type("M", (), {"content": "hi"})()})()]
        r.usage = type("U", (), {"prompt_tokens": 8, "completion_tokens": 4})()
        return r
class FakeOpenAIChat:
    def __init__(self): self.completions = FakeOpenAICompletions()
class FakeOpenAI:
    def __init__(self): self.chat = FakeOpenAIChat()

class TestMoreProviders(unittest.TestCase):
    def test_anthropic(self):
        fg = Sink(); client = wrap(FakeAnthropic(), fg)
        with fg.task():
            with fg.agent("a"):
                client.messages.create(model="claude-haiku-4-5", system="sys", messages=[{"role": "user", "content": "q"}])
        fg.flush()
        self.assertEqual(attr(fg.sent[0], "gen_ai.request.model"), "claude-haiku-4-5")
        self.assertEqual(attr(fg.sent[0], "gen_ai.usage.output_tokens", "intValue"), 3)
    def test_openai(self):
        fg = Sink(); client = wrap(FakeOpenAI(), fg)
        with fg.task():
            with fg.agent("a"):
                client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "system", "content": "s"}, {"role": "user", "content": "q"}])
        fg.flush()
        self.assertEqual(attr(fg.sent[0], "gen_ai.request.model"), "gpt-4o-mini")
        self.assertEqual(attr(fg.sent[0], "gen_ai.usage.input_tokens", "intValue"), 8)
```

Extend `sdk/python/fleetglass/adapters.py`:
```python
def _msgs_text(messages):
    for m in reversed(messages or []):
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, str):
                return c
            return "\n".join(b.get("text", "") for b in (c or []) if isinstance(b, dict) and b.get("type") == "text")
    return ""

def _sys_from_messages(messages):
    return "\n".join(m.get("content", "") for m in (messages or []) if m.get("role") == "system" and isinstance(m.get("content"), str))

def _wrap_anthropic(client, tracer):
    real = client.messages.create
    def traced(model=None, system=None, messages=None, **kw):
        res = real(model=model, system=system, messages=messages, **kw)
        u = getattr(res, "usage", None)
        _safe_emit(
            tracer,
            model=getattr(res, "model", None) or model or "unknown",
            input_tokens=(getattr(u, "input_tokens", 0) or 0) + (getattr(u, "cache_read_input_tokens", 0) or 0) + (getattr(u, "cache_creation_input_tokens", 0) or 0),
            output_tokens=getattr(u, "output_tokens", 0) or 0,
            prompt=_msgs_text(messages),
            completion="".join(getattr(b, "text", "") for b in getattr(res, "content", []) if getattr(b, "type", "") == "text"),
            context={"system": system or "", "history": _msgs_text(messages), "tools": str(kw.get("tools") or "")},
        )
        return res
    client.messages.create = traced
    return client

def _wrap_openai(client, tracer):
    real = client.chat.completions.create
    def traced(model=None, messages=None, **kw):
        res = real(model=model, messages=messages, **kw)
        u = getattr(res, "usage", None)
        _safe_emit(
            tracer,
            model=getattr(res, "model", None) or model or "unknown",
            input_tokens=getattr(u, "prompt_tokens", 0) or 0,
            output_tokens=getattr(u, "completion_tokens", 0) or 0,
            prompt=_msgs_text(messages),
            completion=(res.choices[0].message.content if getattr(res, "choices", None) else "") or "",
            context={"system": _sys_from_messages(messages), "history": _msgs_text(messages), "tools": str(kw.get("tools") or "")},
        )
        return res
    client.chat.completions.create = traced
    return client
```
Extend `wrap()` dispatch:
```python
def wrap(client, tracer):
    models = getattr(client, "models", None)
    if models is not None and hasattr(models, "generate_content"):
        return _wrap_google(client, tracer)
    messages = getattr(client, "messages", None)
    if messages is not None and hasattr(messages, "create"):
        return _wrap_anthropic(client, tracer)
    chat = getattr(client, "chat", None)
    if chat is not None and hasattr(getattr(chat, "completions", None), "create"):
        return _wrap_openai(client, tracer)
    raise TypeError("fleetglass: unrecognized client (google-genai / anthropic / openai)")
```
Run: `cd sdk/python && python -m unittest -v` → PASS (all).

- [ ] **Step 5: Commit**

```bash
git add sdk/node/adapters.js sdk/node/adapters.test.js sdk/python/fleetglass/adapters.py sdk/python/test_adapters.py store.js
git commit -m "feat: anthropic + openai wrap() adapters (node+python), openai prices"
```

---

### Task 8: Remove the simulator, repoint Node example imports, rewrite README onboarding

**Files:**
- Delete: `simulator.js`, root `tracer.js`
- Modify: `examples/claude-fleet.mjs` (repoint import to `../sdk/node/index.js`, adopt `wrap()`)
- Modify: `README.md`, `.claude/launch.json` (drop simulator references)

**Interfaces:** none new.

- [ ] **Step 1: Delete simulated + moved files**
```bash
git rm simulator.js tracer.js
```

- [ ] **Step 2: Repoint the Claude example** — in `examples/claude-fleet.mjs`, change `import { createTracer } from '../tracer.js';` to `import { createTracer } from '../sdk/node/index.js';` and convert its calls to `fg.wrap(new Anthropic())` + `fg.task`/`fg.agent` (same shape as `examples/gemini-fleet.mjs`, Anthropic client).

- [ ] **Step 3: Verify nothing else imports the deleted files**

Run: `grep -rn "from '../tracer.js'\|require('./simulator\|simulator.js" . --include=*.js --include=*.mjs --include=*.md`
Expected: no matches except historical mentions you are editing in README.

- [ ] **Step 4: Rewrite README onboarding section**

Replace the "Quickstart" simulator instructions and "Integrate your own agents" section with the two-language `wrap()` story:
```md
## Onboard your agents (Python or Node, any provider)

**Node**
    npm install fleetglass
    import { createTracer } from 'fleetglass';
    const fg = createTracer({ workflow: 'my-system' });
    const ai = fg.wrap(new GoogleGenAI({ apiKey }));   // or Anthropic / OpenAI client
    await fg.task(async () => {
      await fg.agent('planner', () => ai.models.generateContent({ model, contents, config }));
    });

**Python**
    pip install fleetglass
    from fleetglass import Tracer
    fg = Tracer(workflow='my-system')
    ai = fg.wrap(genai.Client(api_key=key))            # or Anthropic / OpenAI client
    with fg.task():
        with fg.agent('planner'):
            ai.models.generate_content(model=..., contents=..., config=...)

`wrap()` auto-captures model, tokens, prompt, completion, cost, and context breakdown;
`agent()` names the node and derives handoffs. Runnable fleets: `examples/gemini-fleet.mjs`,
`examples/gemini-fleet.py`.
```
Also update `.claude/launch.json` if it references the simulator (it does not run the simulator today — leave the `fleetglass` server config as-is).

- [ ] **Step 5: Full test sweep**

Run: `npm test && node --test sdk/node/*.test.js && (cd sdk/python && python -m unittest -v)`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove simulator, onboard docs for python+node wrap() SDK"
```

---

## Self-Review

**Spec coverage:**
- Wrapper + agent context → Tasks 1, 2, 4, 5 (core + agent + google adapters). ✅
- Decorator *and* context manager → Task 4 `_AgentScope.__call__` + `__enter__`; Node `fg.agent(name, fn)` Task 1. ✅
- Any provider (OpenAI/Anthropic/Google) → Tasks 2, 5, 7. ✅
- Both languages → Part A (Node), Part B (Python). ✅
- Gemini-first, both langs → Tasks 3, 6 before Task 7. ✅
- Zero mandatory deps → Node zero-dep core; Python stdlib core (`pyproject` `dependencies = []`). ✅
- Context segments system/history/tools auto, retrieval opt-in → adapters pass `{system,history,tools}`; `retrieval` omitted → 0. ✅
- No simulated telemetry → Task 8 deletes `simulator.js`; `--inflate` triggers a *real* anomaly. ✅
- sdk/{node,python} layout, package name `fleetglass` → Tasks 1, 4, 8. ✅
- OpenAI prices → Task 7 Step 1. ✅
- Non-streaming first (spec non-goal) → adapters read final `usage`/`text` only; streaming not handled. ✅

**Placeholder scan:** none — every code step shows complete code; manual live-key steps (Task 3.3, Task 6.3) are explicitly manual and unavoidable (need a Google key).

**Type consistency:** `emitChat`/`emit_chat` signatures identical across languages; `wrap(client, fg)` / `wrap(client, tracer)` consistent; frame fields `{trace, agent, anchor, last}` identical in both cores; `currentFrame`/`current_frame` exported and used in tests.
