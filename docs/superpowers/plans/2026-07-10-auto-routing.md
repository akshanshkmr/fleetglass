# Evidence-Gated Auto-Routing (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a human approves a passing downgrade finding, that agent's future `fg.chat` calls run on the cheaper same-provider model automatically, and the saving shows up in cost.

**Architecture:** The kill-switch pattern, reused for cost. The store keeps an in-memory routing table (`"workflow/agent" → model`) armed by `POST /api/route` from a dashboard **Route** button (enabled only on a passing, same-provider finding). The `/v1/traces` ingest response — which already piggybacks `{ killed }` — now also carries `{ routes }`. The client harvests routes on each per-call flush and, before each call, swaps to the routed model when it is the same provider (else ignores it), emitting the span with the actual model used.

**Tech Stack:** Node.js (built-in `node:test`, `node:http`, `fetch`), zero-dep SDK, vanilla-JS dashboard.

## Global Constraints

- **SDK stays zero-dep.** `sdk/node/*` imports nothing from the repo root or npm; `client.js` imports only from within `sdk/node/`.
- **Tests:** Node's built-in runner — `node --test <file>`. No frameworks.
- **Route convention:** HTTP routes are thin glue with **no** route-level unit test (see `/api/fork`, `/api/kill` — the engine is unit-tested, the route is integration-verified).
- **Git:** commit per task; **push to `main` after the whole branch is reviewed** (no PR flow). Run the full suite (`node --test *.test.js sdk/node/*.test.js`) before pushing.
- **Commit trailer** on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## File Structure

- `store.js` — add routing-table state + `route()`/`routes()`; export on the store api. **Unit-tested.**
- `server.js` — add `POST /api/route`; make `/v1/traces` response return `{ killed, routes }`. **Integration-verified.**
- `sdk/node/client.js` — harvest `routes`, swap model per call (same-provider guard), emit actual model. **Unit-tested.**
- `public/app.js` — add a **Route** button to each downgrade finding via a delegated listener. **Preview-verified.**

---

### Task 1: Store routing table (`route` / `routes`)

**Files:**
- Modify: `store.js` (add state after `killedTraces` ~line 68; add functions after `killed()` ~line 322; add to returned api ~line 324)
- Test: `store.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (on the object returned by `createStore()`):
  - `route(workflow: string, agent: string, model: string): void` — set `"workflow/agent" → model`; a falsy `model` **clears** the entry; overwrites any existing route for the key.
  - `routes(): object` — the table as a plain object `{ "workflow/agent": model }`.

- [ ] **Step 1: Write the failing test**

Add to `store.test.js`:

```js
test('route sets a target; routes() returns it; empty model clears; re-route overwrites', () => {
  const s = createStore();
  s.route('wf', 'planner', 'claude-haiku-4-5');
  assert.deepEqual(s.routes(), { 'wf/planner': 'claude-haiku-4-5' });
  s.route('wf', 'planner', 'gemini-2.0-flash'); // overwrite
  assert.deepEqual(s.routes(), { 'wf/planner': 'gemini-2.0-flash' });
  s.route('wf', 'planner', ''); // clear
  assert.deepEqual(s.routes(), {});
});
```

`createStore`, `test`, `assert` are already imported at the top of `store.test.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test store.test.js`
Expected: FAIL — `s.route is not a function`.

- [ ] **Step 3: Add the routing-table state**

In `store.js`, inside `createStore()`, after the line `const killedTraces = new Map(); // traceId -> armedAt (ms) — the kill-switch set` (~line 68), add:

```js
  const routeTable = new Map(); // "workflow/agent" -> target model — durable, no TTL
```

- [ ] **Step 4: Add `route` and `routes`**

In `store.js`, immediately after the `killed()` function's closing brace (~line 322, right before the final `return {...}`), add:

```js
  function route(workflow, agent, model) {
    const k = String(workflow) + '/' + String(agent);
    if (model) routeTable.set(k, String(model)); else routeTable.delete(k);
  }
  function routes() {
    return Object.fromEntries(routeTable);
  }
```

- [ ] **Step 5: Export them on the store api**

In `store.js`, change the final return to include `route` and `routes`:

```js
  return { ingest, snapshot, listTraces, getTrace, agentSteps, agentChatSteps, kill, killed, route, routes };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test store.test.js`
Expected: PASS (all store tests, including the new one).

- [ ] **Step 7: Commit**

```bash
git add store.js store.test.js
git commit -m "feat(store): routing table (route/routes, durable no-TTL)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Server — `POST /api/route` + routes in the `/v1/traces` response

**Files:**
- Modify: `server.js` (the `/v1/traces` end handler; add `/api/route` near the `/api/kill` block)

**Interfaces:**
- Consumes: `store.route(workflow, agent, model)`, `store.routes()` from Task 1.
- Produces:
  - `POST /api/route` with JSON body `{ workflow: string, agent: string, model?: string }` → `200 { ok: true }`; malformed body → `400 { error }`. An absent/empty `model` clears the route.
  - `POST /v1/traces` response changes from `{ killed }` to `{ killed, routes }`.

- [ ] **Step 1: Make `/v1/traces` return routes too**

In `server.js`, find the `/v1/traces` success line (it currently reads
`res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ killed: store.killed() }));`)
and change it to:

```js
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ killed: store.killed(), routes: store.routes() }));
```

- [ ] **Step 2: Add the `POST /api/route` route**

In `server.js`, immediately after the closing `}` of the `/api/kill` block (its trailing `return;` then `}`), insert:

```js
  if (req.method === 'POST' && url.pathname === '/api/route') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let params; try { params = JSON.parse(body); } catch { res.writeHead(400).end('{}'); return; }
      if (!params || typeof params !== 'object' || typeof params.workflow !== 'string' || !params.workflow || typeof params.agent !== 'string' || !params.agent) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'workflow and agent required' })); return;
      }
      store.route(params.workflow, params.agent, typeof params.model === 'string' ? params.model : '');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    });
    return;
  }
```

- [ ] **Step 3: Integration-verify (no route unit test — matches `/api/kill` convention)**

```bash
node server.js & SRV=$!; sleep 1
# arm a route
curl -s -X POST localhost:4700/api/route -H 'content-type: application/json' -d '{"workflow":"wf","agent":"planner","model":"claude-haiku-4-5"}'
# /v1/traces response now carries routes
curl -s -X POST localhost:4700/v1/traces -H 'content-type: application/json' -d '{"resourceSpans":[]}'
# clear it (empty model)
curl -s -X POST localhost:4700/api/route -H 'content-type: application/json' -d '{"workflow":"wf","agent":"planner","model":""}'
curl -s -X POST localhost:4700/v1/traces -H 'content-type: application/json' -d '{"resourceSpans":[]}'
# malformed → 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4700/api/route -H 'content-type: application/json' -d '{"agent":"x"}'
kill $SRV
```

Expected output, in order:
- `{"ok":true}`
- `{"killed":[],"routes":{"wf/planner":"claude-haiku-4-5"}}`
- `{"ok":true}`
- `{"killed":[],"routes":{}}`
- `400`

(If port 4700 is taken: `pkill -f 'node server.js'` and retry. Paste the RAW curl stdout into the report.)

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(server): POST /api/route arms a route; /v1/traces returns routes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Client — harvest routes + swap model (same-provider guard)

**Files:**
- Modify: `sdk/node/client.js` (add `routeMap` after `killedSet` ~line 31; change `runCall` signature ~lines 33-46; change `guardedCall` ~lines 50-57)
- Test: `sdk/node/client.test.js`

**Interfaces:**
- Consumes: `/v1/traces` response `{ killed, routes }` (Task 2); `providerOf(model)`, `currentFrame()`.
- Produces: `fg.chat` runs on the routed model when `routeMap["<workflow>/<agent>"]` is set AND `providerOf(target) === provider` (else the constructed model); the emitted span and the returned `.model` reflect the actual model used. First call after construction runs on the original model (routeMap harvested after the first flush), like the kill signal.

- [ ] **Step 1: Write the failing tests**

Add to `sdk/node/client.test.js`:

```js
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
```

`fleetglass`, `test`, `assert` are already imported at the top of `client.test.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test sdk/node/client.test.js`
Expected: FAIL — the "routed agent" test sees `models[1] === 'claude-sonnet-5'` (no swap yet).

- [ ] **Step 3: Add the `routeMap`**

In `sdk/node/client.js`, after the line `const killedSet = new Set(); // trace ids the control plane has flagged killed` (~line 31), add:

```js
  let routeMap = {}; // "workflow/agent" -> target model, harvested from /v1/traces responses
```

- [ ] **Step 4: Thread the effective model through `runCall`**

In `sdk/node/client.js`, replace the whole `runCall` function (~lines 33-46) with a version that takes `useModel` and uses it in the request, the span, and the result:

```js
  async function runCall(req, maxTokens, useModel = model) {
    const { url, headers, body } = toProvider(req, { provider, model: useModel, maxTokens, key });
    const data = await call(url, headers, body);          // throws on API/network error
    const { completion, inTok, outTok } = parseResponse(provider, data);
    try {
      tracer.emitChat({
        model: useModel, inputTokens: inTok, outputTokens: outTok,
        prompt: lastUser(req.messages), completion,
        context: { system: req.system || '', history: historyText(req.messages), tools: req.tools ? JSON.stringify(req.tools) : '' },
        request: req,
      });
    } catch { /* telemetry must never break a successful call */ }
    return { text: completion, usage: { inputTokens: inTok, outputTokens: outTok }, model: useModel, raw: data };
  }
```

- [ ] **Step 5: Resolve the route in `guardedCall` and harvest routes**

In `sdk/node/client.js`, replace the whole `guardedCall` function (~lines 50-57) with:

```js
  // ponytail: per-call flush (not batched) — a pathology can't fire without many
  // calls, so this trades a POST-per-call for a fresh kill/route signal every call.
  async function guardedCall(req, maxTokens) {
    const f = currentFrame();
    if (f && killedSet.has(f.trace)) { const e = new Error('task killed by FleetGlass kill-switch'); e.code = 'KILLED'; throw e; }
    const target = routeMap[workflow + '/' + ((f && f.agent) || agent)];
    const useModel = (target && providerOf(target) === provider) ? target : model; // same-provider only; else ignore
    const r = await runCall(req, maxTokens, useModel);
    const posted = await tracer.flush();                    // span goes out now; response carries { killed, routes }
    if (posted && Array.isArray(posted.killed)) { killedSet.clear(); for (const t of posted.killed) killedSet.add(t); }
    if (posted && posted.routes && typeof posted.routes === 'object') routeMap = posted.routes;
    return r;
  }
```

- [ ] **Step 6: Run the client tests to verify they pass**

Run: `node --test sdk/node/client.test.js`
Expected: PASS — all client tests (existing 14 + 3 new).

- [ ] **Step 7: Run the tracer tests (guard against regression)**

Run: `node --test sdk/node/tracer.test.js`
Expected: PASS (unchanged; this task doesn't touch the tracer, but the harvest relies on `flush()` returning the response).

- [ ] **Step 8: Commit**

```bash
git add sdk/node/client.js sdk/node/client.test.js
git commit -m "feat(sdk): client applies same-provider routes (harvest + per-call model swap)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Dashboard — Route button on downgrade findings

**Files:**
- Modify: `public/app.js` (add module-level `lastSavings`; add a **Route** button in the savings render ~lines 481-488; add one delegated click listener after the `savings-run` listener ~line 489)

**Interfaces:**
- Consumes: `POST /api/route { workflow, agent, model }` (Task 2); the downgrade findings already computed in the `savings-run` handler (`f.agent`, `f.to`, `f.pass`, `f.fidelity`).
- Produces: clicking Route arms/clears the route server-side; the button reflects local state.

- [ ] **Step 1: Add module-level findings state**

In `public/app.js`, immediately before the `// savings report:` comment and its `$('savings-run')` listener (~line 462), add:

```js
let lastSavings = null; // { wf, findings } — so the delegated Route listener can look findings up by index
```

- [ ] **Step 2: Render the Route button and stash findings**

In `public/app.js`, in the `savings-run` click handler, replace the results-render block (the `out.innerHTML = ...` starting at ~line 481 through its closing `;` at ~line 488) with:

```js
  lastSavings = { wf, findings: job.findings || [] };
  out.innerHTML = `<div class="savings-head">Downgrade ≈ ${money(yr)}/yr · agent ${job.agent}</div>` +
    lastSavings.findings.map((f, i) => {
      const pct = Math.round(f.agreement * 100);
      const routable = f.pass && f.fidelity === 'exact';
      const btn = routable
        ? `<button class="route-btn" data-i="${i}">Route</button>`
        : `<button class="route-btn" disabled title="${f.pass ? 'cross-provider — needs target key' : 'below agreement bar'}">Route</button>`;
      return `<div class="savings-row"><span>${(f.from || '?').replace(/^(claude|gemini)-/, '')} → ${(f.to || '?').replace(/^(claude|gemini)-/, '')}${f.fidelity === 'cross-provider' ? ' ~' : ''}</span>` +
        `<span class="agree ${f.pass ? '' : 'warn'}">${pct}%</span>` +
        `<span class="save">${money(f.savingsPerMo)}/mo</span>${btn}</div>`;
    }).join('') +
    `<div class="savings-note">~ = cross-provider (tools dropped). Agreement on ${(job.findings?.[0]?.samples) || 0} sampled calls. Route flips a same-provider pass live; click again to revert.</div>`;
```

(Only the button, the `lastSavings` assignment, and the closing note changed; the row text is otherwise identical to the original.)

- [ ] **Step 3: Add the delegated Route listener**

In `public/app.js`, immediately after the `$('savings-run').addEventListener(...)` handler's closing `});` (~line 489), add:

```js
// Route button (delegated — savings-out is re-rendered each run; buttons carry only a numeric index).
$('savings-out').addEventListener('click', async (e) => {
  const btn = e.target.closest('.route-btn');
  if (!btn || btn.disabled || !lastSavings) return;
  const f = lastSavings.findings[+btn.dataset.i];
  if (!f) return;
  const routed = btn.dataset.routed === '1';
  btn.disabled = true;
  try {
    const res = await fetch('/api/route', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: lastSavings.wf, agent: f.agent, model: routed ? '' : f.to }) });
    if (res.ok) {
      btn.dataset.routed = routed ? '' : '1';
      btn.textContent = routed ? 'Route' : 'Routed → ' + (f.to || '').replace(/^(claude|gemini)-/, '');
    }
  } catch { /* leave button as-is */ }
  btn.disabled = false;
});
```

- [ ] **Step 4: Verify syntax (no unit test — `public/` has no test infra, by convention)**

Run: `node --check public/app.js`
Expected: no output (syntax OK). Live behavior is confirmed in the final integration pass.

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat(ui): Route button on same-provider downgrade findings (POST /api/route)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final integration pass (after all four tasks + review)

- [ ] **Full suite green:** `node --test *.test.js sdk/node/*.test.js` → 0 fail.
- [ ] **End-to-end route:** start the server (preview), arm a route via `POST /api/route { workflow, agent, model }` (or a real Downgrade run + Route click if captured requests exist), then run a `fleetglass()` client (stubbed `call`) for that workflow/agent and confirm its second call's request carries the cheaper model and the emitted span prices it lower. Gemini key stays env-only; the client half needs no real key.
- [ ] **Push to `main`** (no PR): `git push` (rebase first if the remote moved).

## Self-Review (author checklist — completed)

- **Spec coverage:** routing table + clear/overwrite (Task 1) ✓; arm endpoint + piggyback routes (Task 2) ✓; harvest + same-provider swap + actual-model span (Task 3) ✓; Route button, enable-on-pass-and-exact, cross-provider disabled reason, toggle (Task 4) ✓; durable no-TTL (Task 1) ✓.
- **Placeholder scan:** none — every code step is verbatim.
- **Type consistency:** `route(workflow, agent, model)` / `routes()` match across Tasks 1→2; `{ killed, routes }` response shape matches Tasks 2→3; route key `"workflow/agent"` is built identically in the store (`String(workflow)+'/'+String(agent)`) and the client (`workflow + '/' + ((f&&f.agent)||agent)`), and the client's default `workflow='default'` + agent fallback `'agent'` make the test key `'default/agent'` consistent end-to-end.
- **Security:** Route button interpolates no user data into HTML attributes — only a numeric `data-i` index; agent/model are read from the JS `lastSavings` object at click time (avoids `esc()`'s lack of quote-escaping). `/api/route` validates its body.
- **Known v1 limitation (in spec):** button state is optimistic/local — a page reload won't reflect server-side active routes (snapshot doesn't carry routes). Acceptable for v1; noted in the spec's Non-goals-adjacent limitation.
