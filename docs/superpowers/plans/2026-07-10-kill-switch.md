# Kill-Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human stop a runaway task from the dashboard — a killed task's next `fg.chat` throws `KILLED` instead of making a provider call.

**Architecture:** The store keeps an in-memory `Set` of killed trace ids (armed by `POST /api/kill` from the dashboard's existing Kill button). The `/v1/traces` ingest response carries the current killed list back to the SDK. The client flushes per-call so it harvests that list every call, and before each provider call it throws if its active `currentFrame().trace` is killed. Detection is unchanged (`pathology.js`); this adds only the *act*.

**Tech Stack:** Node.js (built-in `node:test`, `node:http`, `fetch`), zero-dep SDK, vanilla-JS dashboard.

## Global Constraints

- **SDK stays zero-dep.** `sdk/node/*` imports nothing from the repo root or npm; `client.js`/`tracer.js` only import from within `sdk/node/`.
- **Tests:** Node's built-in runner — `node --test <file>`. No frameworks.
- **Route convention:** HTTP routes are thin glue and have **no** route-level unit test (see `/api/fork` — its engine `forkStep` is unit-tested, not the route). Unit-test the engine (store); verify routes in integration.
- **Git:** commit per task; **push to `main` after the whole branch is reviewed** (no PR flow). Run the full suite (`node --test *.test.js sdk/node/*.test.js`) before pushing.
- **Commit trailer** on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## File Structure

- `store.js` — add killed-set state + `kill()`/`killed()` (with TTL prune); export on the store api. **Unit-tested.**
- `server.js` — add `POST /api/kill`; make `/v1/traces` response return `{ killed }`. **Integration-verified.**
- `sdk/node/tracer.js` — `flush()` returns the transport response; `defaultPost` returns the parsed body. Enables client harvest without duplicating the OTLP envelope.
- `sdk/node/client.js` — kill-check + per-call flush + harvest. **Unit-tested.**
- `public/app.js` — enable the existing (currently disabled) Kill button → `POST /api/kill`. **Preview-verified.**

---

### Task 1: Store killed-set (`kill` / `killed` with TTL prune)

**Files:**
- Modify: `store.js` (add const ~line 58; add state ~line 66; add functions ~line 313; add to returned api ~line 314)
- Test: `store.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (on the object returned by `createStore()`):
  - `kill(trace: string, now?: number): void` — arm `trace` (records arm time; ignores falsy `trace`).
  - `killed(now?: number): string[]` — current killed trace ids, after pruning any older than 10 min.

- [ ] **Step 1: Write the failing test**

Add to `store.test.js`:

```js
test('kill arms a trace; killed lists it and prunes after the TTL', () => {
  const s = createStore();
  const now = 1_000_000;
  s.kill('t1', now);
  assert.deepEqual(s.killed(now), ['t1']);
  assert.deepEqual(s.killed(now + 11 * 60 * 1000), []); // pruned after 10min TTL
});

test('kill ignores a falsy trace', () => {
  const s = createStore();
  s.kill('', 1000);
  assert.deepEqual(s.killed(1000), []);
});
```

`createStore` and `test`/`assert` are already imported at the top of `store.test.js` (existing tests use them).

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test store.test.js`
Expected: FAIL — `s.kill is not a function`.

- [ ] **Step 3: Add the TTL constant**

In `store.js`, after the line `const MAX_TRACES = 300;` (~line 58), add:

```js
const KILL_TTL_MS = 10 * 60 * 1000; // a killed trace throws & dies fast; entry only outlives in-flight calls
```

- [ ] **Step 4: Add the killed-set state**

In `store.js`, inside `createStore()`, after the line `const alertSince = new Map(); // "wf/agent" -> ts` (~line 66), add:

```js
  const killedTraces = new Map(); // traceId -> armedAt (ms) — the kill-switch set
```

- [ ] **Step 5: Add `kill` and `killed`**

In `store.js`, immediately before the final `return { ingest, snapshot, listTraces, getTrace, agentSteps, agentChatSteps };` (~line 314), add:

```js
  function kill(trace, now = Date.now()) {
    if (trace) killedTraces.set(String(trace), now);
  }
  function killed(now = Date.now()) {
    for (const [t, at] of killedTraces) if (now - at > KILL_TTL_MS) killedTraces.delete(t);
    return [...killedTraces.keys()];
  }
```

- [ ] **Step 6: Export them on the store api**

In `store.js`, change the final return to include `kill` and `killed`:

```js
  return { ingest, snapshot, listTraces, getTrace, agentSteps, agentChatSteps, kill, killed };
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test store.test.js`
Expected: PASS (all store tests, including the two new ones).

- [ ] **Step 8: Commit**

```bash
git add store.js store.test.js
git commit -m "feat(store): killed-trace set (kill/killed with 10min TTL prune)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Server — `POST /api/kill` + killed list in the `/v1/traces` response

**Files:**
- Modify: `server.js` (change `/v1/traces` end handler ~line 40; add `/api/kill` route after the `/api/fork` block ~line 59)

**Interfaces:**
- Consumes: `store.kill(trace)`, `store.killed()` from Task 1.
- Produces:
  - `POST /api/kill` with JSON body `{ trace: string }` → `200 { ok: true }`; malformed body → `400 { error }`.
  - `POST /v1/traces` response body changes from `{}` to `{ killed: string[] }`.

- [ ] **Step 1: Make `/v1/traces` return the killed list**

In `server.js`, in the `/v1/traces` handler, change the success line (~line 40) from:

```js
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
```

to:

```js
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ killed: store.killed() }));
```

- [ ] **Step 2: Add the `POST /api/kill` route**

In `server.js`, immediately after the closing `}` of the `/api/fork` block (the `return;` on ~line 58 followed by `}` on ~line 59), insert:

```js
  if (req.method === 'POST' && url.pathname === '/api/kill') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let params; try { params = JSON.parse(body); } catch { res.writeHead(400).end('{}'); return; }
      if (!params || typeof params !== 'object' || typeof params.trace !== 'string' || !params.trace) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'trace required' })); return;
      }
      store.kill(params.trace);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    });
    return;
  }
```

- [ ] **Step 3: Integration-verify (no route unit test — matches `/api/fork` convention)**

Start the server and exercise both changes:

```bash
node server.js & SRV=$!; sleep 1
# arm a trace
curl -s -X POST localhost:4700/api/kill -H 'content-type: application/json' -d '{"trace":"tX"}'
# /v1/traces response now carries the killed list
curl -s -X POST localhost:4700/v1/traces -H 'content-type: application/json' -d '{"resourceSpans":[]}'
# malformed body → 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4700/api/kill -H 'content-type: application/json' -d 'not json'
kill $SRV
```

Expected output, in order:
- `{"ok":true}`
- `{"killed":["tX"]}`
- `400`

(If the port is taken, the run before it did not clean up — `pkill -f 'node server.js'` and retry.)

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(server): POST /api/kill arms a trace; /v1/traces returns killed list

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Client enforcement — flush-per-call, harvest killed, throw `KILLED`

**Files:**
- Modify: `sdk/node/tracer.js` (`defaultPost` ~lines 23-36; `flush` ~lines 39-44)
- Modify: `sdk/node/client.js` (`safePost` ~line 29; add killed-set + `guardedCall`; wire `chat` ~lines 47-52)
- Test: `sdk/node/client.test.js`

**Interfaces:**
- Consumes: `POST /v1/traces` response shape `{ killed: string[] }` (Task 2); `currentFrame()` → `{ trace, agent, ... }` (`tracer.js:8`, threads `f.trace` into spans at `:77`).
- Produces: `fg.chat` throws `Error` with `.code === 'KILLED'` (no provider call, no span) when the active trace is in the killed set; otherwise unchanged. Behavior only fires inside a task where the trace is stable across calls (a user-managed `fg.task(...)`), which is the only place a pathology can accumulate.

- [ ] **Step 1: Write the failing tests**

Add to `sdk/node/client.test.js`:

```js
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
```

`fleetglass`, `test`, `assert` are already imported at the top of `client.test.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test sdk/node/client.test.js`
Expected: FAIL — the "killed task" test still calls the provider twice (`counter.n === 2`, kill not enforced yet).

- [ ] **Step 3: Make the tracer transport return its response**

In `sdk/node/tracer.js`, replace `defaultPost` (~lines 23-36) with a version that returns the parsed body:

```js
  const defaultPost = async (spans) => {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceSpans: [{
            resource: { attributes: [{ key: 'service.name', value: { stringValue: workflow } }] },
            scopeSpans: [{ spans }],
          }],
        }),
      });
      return await res.json().catch(() => null); // let the caller read { killed } (kill-switch)
    } catch { return null; /* observability must never break the agent */ }
  };
```

In the same file, change `flush()` (~lines 39-44) to return the transport result:

```js
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const spans = queue;
    queue = [];
    if (spans.length) return await send(spans);
  }
```

- [ ] **Step 4: Make the client's `safePost` return its wrapped value**

In `sdk/node/client.js`, change `safePost` (~line 29) from:

```js
  const safePost = post ? async (spans) => { try { await post(spans); } catch { /* drop */ } } : undefined;
```

to:

```js
  const safePost = post ? async (spans) => { try { return await post(spans); } catch { return undefined; /* drop */ } } : undefined;
```

- [ ] **Step 5: Add the killed-set and `guardedCall`; wire `chat`**

In `sdk/node/client.js`, after the `const tracer = createTracer(...)` line (~line 30), add the killed-set:

```js
  const killedSet = new Set(); // trace ids the control plane has flagged killed
```

Then replace the `chat` function (~lines 47-52) with a guarded version that kill-checks, then flushes per call and harvests the killed list:

```js
  // ponytail: per-call flush (not batched) — a pathology can't fire without many
  // calls, so this trades a POST-per-call for a fresh kill signal every call.
  async function guardedCall(req, maxTokens) {
    const f = currentFrame();
    if (f && killedSet.has(f.trace)) { const e = new Error('task killed by FleetGlass kill-switch'); e.code = 'KILLED'; throw e; }
    const r = await runCall(req, maxTokens);
    const posted = await tracer.flush();                    // span goes out now; response carries { killed }
    if (posted && Array.isArray(posted.killed)) { killedSet.clear(); for (const t of posted.killed) killedSet.add(t); }
    return r;
  }

  async function chat(input, perCall = {}) {
    const req = normalize(input);
    const maxTokens = clamp(perCall.maxTokens ?? defMax);
    if (currentFrame()) return guardedCall(req, maxTokens);                          // inside user's task/agent
    return tracer.task(() => tracer.agent(agent, () => guardedCall(req, maxTokens))); // auto-wrap
  }
```

(The existing `runCall` is unchanged — `guardedCall` wraps it.)

- [ ] **Step 6: Run the client tests to verify they pass**

Run: `node --test sdk/node/client.test.js`
Expected: PASS — all client tests (existing 11 + 3 new).

- [ ] **Step 7: Run the tracer tests (guard against regressions from the flush/post change)**

Run: `node --test sdk/node/tracer.test.js`
Expected: PASS — the flush-returns-value and defaultPost-returns-body changes are additive; existing tests ignore the return.

- [ ] **Step 8: Commit**

```bash
git add sdk/node/tracer.js sdk/node/client.js sdk/node/client.test.js
git commit -m "feat(sdk): client enforces kill-switch (per-call flush, harvest killed, throw KILLED)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Dashboard — enable the Kill button → `POST /api/kill`

**Files:**
- Modify: `public/app.js` (the Kill button in `renderPathologies`, ~lines 278-283)

**Interfaces:**
- Consumes: `POST /api/kill { trace }` (Task 2); the per-finding object `p` with `p.trace` (already in scope in `renderPathologies`).
- Produces: clicking Kill arms the trace server-side; the button shows local "killed" feedback.

- [ ] **Step 1: Enable and wire the button**

In `public/app.js`, replace the disabled-button block (~lines 278-283):

```js
    const kill = document.createElement('button');
    kill.className = 'kill';
    kill.textContent = 'Kill';
    kill.disabled = true;
    kill.title = 'needs in-path client (Phase C)';
    div.append(replay, kill);
```

with:

```js
    const kill = document.createElement('button');
    kill.className = 'kill';
    kill.textContent = 'Kill';
    kill.addEventListener('click', async () => {
      kill.disabled = true;
      try {
        const res = await fetch('/api/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trace: p.trace }) });
        if (res.ok) { kill.textContent = 'killed'; } else { kill.disabled = false; }
      } catch { kill.disabled = false; }
    });
    div.append(replay, kill);
```

- [ ] **Step 2: Preview-verify (no unit test — `public/` has no test infra, by convention)**

This is verified in the plan's final integration pass (below), where a live firing pathology is needed to render a Kill button. The change is a button handler mirroring the existing `/api/fork` and `/api/savings` POST calls in the same file. Confirm the file parses:

Run: `node --check public/app.js`
Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat(ui): enable Kill button on pathology findings (POST /api/kill)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final integration pass (after all four tasks + review)

- [ ] **Full suite green:** `node --test *.test.js sdk/node/*.test.js` → 0 fail.
- [ ] **End-to-end kill:** start the server (preview), ingest a synthetic looping trace so a pathology fires and the Kill button renders, click it (or `POST /api/kill` with that trace id), then confirm a `fleetglass()` client running that trace throws `KILLED` on its next call. Gemini key stays env-only (free tier ~20/day — a stubbed `call` is fine for the client half; the server/UI half needs no key).
- [ ] **Push to `main`** (no PR): `git push`.

## Self-Review (author checklist — completed)

- **Spec coverage:** killed-set + TTL (Task 1) ✓; arm endpoint + piggyback response (Task 2) ✓; per-call flush + harvest + hard-stop throw + error-inversion (Task 3) ✓; Kill button (Task 4) ✓; per-trace granularity via `currentFrame().trace` (Task 3) ✓. The spec's "single-call non-case" is covered by construction (kill only fires where a stable trace accumulates a pathology) — noted in Task 3 Interfaces.
- **Deviation from spec (intentional, DRYer):** the spec said "the client supplies its own `post`"; the plan instead has `tracer.flush()` return the transport response and the client harvests from it — identical observable behavior, but reuses the tracer's OTLP envelope + endpoint resolution instead of duplicating them. Testable via an injected `post` that echoes the trace.
- **Placeholder scan:** none — every code step is verbatim.
- **Type consistency:** `kill`/`killed` signatures match across Tasks 1→2; `{ killed: string[] }` response shape matches across Tasks 2→3; `currentFrame().trace` matches `tracer.js:77`.
