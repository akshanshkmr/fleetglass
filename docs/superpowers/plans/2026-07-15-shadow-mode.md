# Shadow-Mode (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A human clicks **Shadow** on a downgrade finding; the control plane continuously re-verifies that candidate on fresh live traffic and shows a rolling agreement + status (validating / passing / drifting).

**Architecture:** A pure EWMA engine (`shadow.js`) folds each `analyze` pass into a rolling agreement; the store holds durable shadow pairings + state; a server `setInterval` loop re-runs the existing `analyze` (single target) per armed pairing on the freshest captured calls and records the result; the dashboard adds a Shadow button + panel. Reuses `analyze` / `forkStep` / the judge verbatim — no ingest-path change.

**Tech Stack:** Node.js (built-in `node:test`, `node:http`, `fetch`), zero-dep SDK, vanilla-JS dashboard.

## Global Constraints

- **No new dependencies.** Everything reuses existing modules.
- **`shadow.js` is pure and time-free** (no `Date.now`, no I/O) — imports nothing; timestamps are stamped by the store.
- **Tests:** Node's built-in runner — `node --test <file>`. No frameworks.
- **Route convention:** HTTP routes / background loops are thin glue with **no** route-level unit test (see `/api/kill`, `/api/route`) — the engines are unit-tested, the glue is integration-verified.
- **Git:** commit per task; **push to `main` after the whole branch is reviewed** (no PR flow); rebase if the remote moved. Run the full suite (`node --test *.test.js sdk/node/*.test.js`) before pushing.
- **Commit trailer** on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## File Structure

- `shadow.js` (new) — `updateShadow` (EWMA) + `shadowStatus`. **Unit-tested.**
- `store.js` — durable shadow set + `shadow`/`shadows`/`recordShadow`; `snapshot()` gains a `shadows` field. **Unit-tested.**
- `server.js` — `POST /api/shadow` + a background re-verify loop. **Integration-verified.**
- `public/index.html` + `public/app.js` — Shadow button on findings + a Shadow panel. **Preview-verified.**

---

### Task 1: `shadow.js` — pure rolling engine

**Files:**
- Create: `shadow.js`
- Test: `shadow.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `updateShadow(state, sample, { alpha = 0.4 } = {}) -> { agreement, runs, samples }` — EWMA fold; `state` may be `null`/`undefined` on first run; `sample` is `{ agreement: number, samples: number }`.
  - `shadowStatus(state, { bar = 0.95, minRuns = 3 } = {}) -> 'validating' | 'passing' | 'drifting'`.

- [ ] **Step 1: Write the failing test**

Create `shadow.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateShadow, shadowStatus } from './shadow.js';

test('first sample seeds the agreement', () => {
  const s = updateShadow(null, { agreement: 0.9, samples: 8 });
  assert.deepEqual(s, { agreement: 0.9, runs: 1, samples: 8 });
});

test('EWMA smooths a noisy later sample (alpha 0.4)', () => {
  const s1 = updateShadow(null, { agreement: 0.9, samples: 8 });
  const s2 = updateShadow(s1, { agreement: 0.5, samples: 8 });
  assert.ok(Math.abs(s2.agreement - (0.4 * 0.5 + 0.6 * 0.9)) < 1e-9); // 0.74
  assert.equal(s2.runs, 2);
  assert.equal(s2.samples, 16);
});

test('status: validating below minRuns, then passing / drifting by the bar', () => {
  assert.equal(shadowStatus({ agreement: 0.99, runs: 2, samples: 16 }), 'validating'); // runs < 3
  assert.equal(shadowStatus({ agreement: 0.97, runs: 3, samples: 24 }), 'passing');
  assert.equal(shadowStatus({ agreement: 0.80, runs: 3, samples: 24 }), 'drifting');
});

test('a recovering agreement climbs back to passing', () => {
  assert.equal(shadowStatus({ agreement: 0.96, runs: 5, samples: 40 }), 'passing');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test shadow.test.js`
Expected: FAIL — `Cannot find module './shadow.js'`.

- [ ] **Step 3: Write `shadow.js`**

Create `shadow.js`:

```js
// shadow.js — pure rolling-agreement engine for shadow-mode. Given the prior
// state and one analyze pass's agreement, return the smoothed state; derive a
// status from it. Time-free and deterministic — the store stamps timestamps.
// ponytail: EWMA + fixed thresholds; per-agent tuning if smoothing over/under-reacts.

export function updateShadow(state, sample, { alpha = 0.4 } = {}) {
  const prev = state || { agreement: 0, runs: 0, samples: 0 };
  const agreement = prev.runs === 0
    ? sample.agreement
    : alpha * sample.agreement + (1 - alpha) * prev.agreement;
  return { agreement, runs: prev.runs + 1, samples: prev.samples + (sample.samples || 0) };
}

export function shadowStatus(state, { bar = 0.95, minRuns = 3 } = {}) {
  const s = state || { agreement: 0, runs: 0 };
  if (s.runs < minRuns) return 'validating';
  return s.agreement >= bar ? 'passing' : 'drifting';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test shadow.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add shadow.js shadow.test.js
git commit -m "feat(shadow): pure EWMA rolling-agreement engine (updateShadow/shadowStatus)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Store — shadow set + snapshot `shadows` field

**Files:**
- Modify: `store.js` (import ~line 8; state after `routeTable` ~line 68-ish; `shadows` in the snapshot return ~line 313; functions after `routes()` ~line 330; export ~line 332)
- Test: `store.test.js`

**Interfaces:**
- Consumes: `updateShadow`, `shadowStatus` from `shadow.js` (Task 1).
- Produces (on the object returned by `createStore()`):
  - `shadow(workflow, agent, model)` — arm the pairing (fresh state); falsy `model` stops it (delete); a new `model` resets state.
  - `recordShadow(workflow, agent, sample, now = Date.now())` — fold `sample` through `updateShadow`; stamp `since` (first) + `lastRun`; no-op if stopped.
  - `shadows()` — array `[{ workflow, agent, model, agreement, runs, samples, status, since, lastRun }]`.
  - `snapshot()` return gains a `shadows: shadows()` field (everything else unchanged).

- [ ] **Step 1: Write the failing test**

Add to `store.test.js`:

```js
test('shadow: arm, record advances state, status crosses the bar, stop clears', () => {
  const s = createStore();
  s.shadow('wf', 'planner', 'claude-haiku-4-5');
  assert.equal(s.shadows().length, 1);
  assert.equal(s.shadows()[0].status, 'validating'); // runs 0

  for (let i = 0; i < 3; i++) s.recordShadow('wf', 'planner', { agreement: 0.98, samples: 8 });
  let row = s.shadows()[0];
  assert.equal(row.runs, 3);
  assert.equal(row.status, 'passing');
  assert.ok(row.samples === 24);

  for (let i = 0; i < 4; i++) s.recordShadow('wf', 'planner', { agreement: 0.5, samples: 8 });
  assert.equal(s.shadows()[0].status, 'drifting'); // smoothed agreement fell below the bar

  s.shadow('wf', 'planner', ''); // stop
  assert.deepEqual(s.shadows(), []);
  s.recordShadow('wf', 'planner', { agreement: 0.9, samples: 8 }); // no-op on a stopped pairing
  assert.deepEqual(s.shadows(), []);
});

test('snapshot exposes shadows', () => {
  const s = createStore();
  s.shadow('wf', 'planner', 'claude-haiku-4-5');
  assert.equal(s.snapshot().shadows.length, 1);
  assert.equal(s.snapshot().shadows[0].agent, 'planner');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test store.test.js`
Expected: FAIL — `s.shadow is not a function`.

- [ ] **Step 3: Import the engine**

In `store.js`, change the `pathology.js` import line (~line 7) region so the engine is imported. After the line `import { agentYield } from './yield.js';` (~line 8), add:

```js
import { updateShadow, shadowStatus } from './shadow.js';
```

- [ ] **Step 4: Add the shadow-set state**

In `store.js`, inside `createStore()`, right after the line `const routeTable = new Map(); // "workflow/agent" -> target model — durable, no TTL`, add:

```js
  const shadowSet = new Map(); // "workflow/agent" -> { workflow, agent, model, state, since, lastRun } — durable
```

- [ ] **Step 5: Add `shadows` to the snapshot return**

In `store.js`, in the object returned by `snapshot()`, add a `shadows` field after `pathologies,` (the last field before the closing `};` ~line 313):

```js
      pathologies,
      shadows: shadows(),
```

(`shadows` is a hoisted function declaration added in the next step, so calling it here is fine.)

- [ ] **Step 6: Add `shadow`, `recordShadow`, `shadows`**

In `store.js`, immediately after the `routes()` function's closing brace (~line 330, before the final `return {...}`), add:

```js
  function shadow(workflow, agent, model) {
    const k = String(workflow) + '/' + String(agent);
    if (model) shadowSet.set(k, { workflow: String(workflow), agent: String(agent), model: String(model), state: null, since: 0, lastRun: 0 });
    else shadowSet.delete(k);
  }
  function recordShadow(workflow, agent, sample, now = Date.now()) {
    const e = shadowSet.get(String(workflow) + '/' + String(agent));
    if (!e) return; // stopped
    e.state = updateShadow(e.state, sample);
    if (!e.since) e.since = now;
    e.lastRun = now;
  }
  function shadows() {
    const out = [];
    for (const e of shadowSet.values()) {
      const st = e.state || { agreement: 0, runs: 0, samples: 0 };
      out.push({ workflow: e.workflow, agent: e.agent, model: e.model, agreement: st.agreement, runs: st.runs, samples: st.samples, status: shadowStatus(st), since: e.since, lastRun: e.lastRun });
    }
    return out;
  }
```

- [ ] **Step 7: Export them on the store api**

In `store.js`, change the final return to include the three functions:

```js
  return { ingest, snapshot, listTraces, getTrace, agentSteps, agentChatSteps, kill, killed, route, routes, shadow, shadows, recordShadow };
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `node --test store.test.js`
Expected: PASS (all store tests, including the two new ones).

- [ ] **Step 9: Commit**

```bash
git add store.js store.test.js
git commit -m "feat(store): durable shadow set (shadow/shadows/recordShadow) + snapshot.shadows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Server — `POST /api/shadow` + background re-verify loop

**Files:**
- Modify: `server.js` (add `/api/shadow` route after the `/api/route` block ~line 87; add the loop + interval near the existing `setInterval` ~line 30, using the module's existing imports)

**Interfaces:**
- Consumes: `store.shadow`, `store.shadows`, `store.recordShadow`, `store.agentSteps`; `analyze`, `forkStep`, `makeJudge`, `scoreFn`, `keyFor`, `providerOf`, `JUDGE_MODEL` (all already imported/defined in `server.js`).
- Produces:
  - `POST /api/shadow { workflow, agent, model? }` → `200 { ok: true }`; missing/non-string `workflow`/`agent` → `400`; absent/empty `model` stops the pairing.
  - A `setInterval` that, every `SHADOW_INTERVAL_MS` (default 5 min), re-verifies each armed pairing and records the agreement.

- [ ] **Step 1: Add the `POST /api/shadow` route**

In `server.js`, immediately after the `/api/route` block's closing `}` (its `return;` then `}` ~line 87), insert:

```js
  if (req.method === 'POST' && url.pathname === '/api/shadow') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let params; try { params = JSON.parse(body); } catch { res.writeHead(400).end('{}'); return; }
      if (!params || typeof params !== 'object' || typeof params.workflow !== 'string' || !params.workflow || typeof params.agent !== 'string' || !params.agent) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'workflow and agent required' })); return;
      }
      store.shadow(params.workflow, params.agent, typeof params.model === 'string' ? params.model : '');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    });
    return;
  }
```

- [ ] **Step 2: Add the background re-verify loop**

In `server.js`, immediately after the existing SSE `setInterval(() => { ... }, 1500);` block (~line 30), add:

```js
// Shadow-mode: periodically re-verify each armed pairing against the freshest
// captured traffic. Reuses the exact analyze/judge/fork wiring the /api/savings
// route builds. Spends real money (forks + judge) — interval is the cost knob,
// and a pairing with no captured steps or no target key is skipped.
const SHADOW_INTERVAL_MS = Number(process.env.SHADOW_INTERVAL_MS) || 5 * 60 * 1000;
let shadowRunning = false;
async function shadowPass() {
  if (shadowRunning) return;                          // never overlap slow passes
  shadowRunning = true;
  try {
    const judgeKey = keyFor(providerOf(JUDGE_MODEL));
    const judge = judgeKey ? makeJudge({ model: JUDGE_MODEL, key: judgeKey }) : null;
    const score = (a, b) => scoreFn(a, b, judge ? { judge } : {});
    for (const p of store.shadows()) {
      try {
        const steps = store.agentSteps(p.workflow, p.agent);
        if (!steps.length || !keyFor(providerOf(p.model))) continue;   // nothing to fork, or no key
        const findings = await analyze({ steps, agent: p.agent, targets: [{ model: p.model }], callsPerMonth: 0, fork: forkStep, score });
        const f = findings[0];
        if (f) store.recordShadow(p.workflow, p.agent, { agreement: f.agreement, samples: f.samples });
      } catch { /* one pairing's failure never breaks the pass */ }
    }
  } finally { shadowRunning = false; }
}
setInterval(shadowPass, SHADOW_INTERVAL_MS);
```

- [ ] **Step 3: Integration-verify (no route unit test — matches `/api/kill`, `/api/route`)**

```bash
node server.js & SRV=$!; sleep 1
# arm a shadow pairing
curl -s -X POST localhost:4700/api/shadow -H 'content-type: application/json' -d '{"workflow":"wf","agent":"planner","model":"claude-haiku-4-5"}'
# snapshot carries it (status validating — the loop hasn't run/found captured calls)
curl -s localhost:4700/api/snapshot | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify(j.shadows));})'
# stop it
curl -s -X POST localhost:4700/api/shadow -H 'content-type: application/json' -d '{"workflow":"wf","agent":"planner","model":""}'
curl -s localhost:4700/api/snapshot | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("after stop:",JSON.stringify(j.shadows));})'
# malformed → 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4700/api/shadow -H 'content-type: application/json' -d '{"agent":"x"}'
kill $SRV
```

Expected output, in order:
- `{"ok":true}`
- `[{"workflow":"wf","agent":"planner","model":"claude-haiku-4-5","agreement":0,"runs":0,"samples":0,"status":"validating","since":0,"lastRun":0}]`
- `{"ok":true}`
- `after stop: []`
- `400`

(The loop's actual forking needs captured requests + provider keys, exactly like `/api/savings`; it's covered by `savings.test.js` + verified in the final integration pass. Paste the RAW curl stdout into the report. If port 4700 is taken: `pkill -f 'node server.js'` and retry.)

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(server): POST /api/shadow arms a pairing; background loop re-verifies candidates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Dashboard — Shadow button on findings + Shadow panel

**Files:**
- Modify: `public/index.html` (add a shadow panel in the Savings tab after `#savings-panel` ~line 354)
- Modify: `public/app.js` (Shadow button in the savings render ~line 489; a second delegated listener after the Route listener ~line 496-onward; `renderShadows()` + a call in `renderAll()` ~line 599)

**Interfaces:**
- Consumes: `POST /api/shadow { workflow, agent, model }` (Task 3); `snap.shadows` from the snapshot (Task 2); the findings already in `lastSavings`.
- Produces: clicking Shadow arms/stops a pairing; the panel shows each pairing's rolling agreement + status live from the SSE snapshot.

- [ ] **Step 1: Add the Shadow panel to the Savings tab**

In `public/index.html`, immediately after the `#savings-panel` `</div>` (the block ending ~line 354, right before `<div class="panel" id="context-panel">`), insert:

```html
    <div class="panel" id="shadow-panel" hidden>
      <h2>Shadow — live re-verification of candidates</h2>
      <div id="shadow-out"></div>
    </div>
```

- [ ] **Step 2: Add a Shadow button to each finding row**

In `public/app.js`, in the savings render (~line 491), change the row's return so it appends a Shadow button after the Route button. Replace this line:

```js
        `<span class="save">${money(f.savingsPerMo)}/mo</span>${btn}</div>`;
```

with:

```js
        `<span class="save">${money(f.savingsPerMo)}/mo</span>${btn}<button class="shadow-btn" data-i="${i}">Shadow</button></div>`;
```

(The Shadow button is enabled for every finding — server-side forking handles cross-provider. It carries only the numeric `data-i`, same XSS-safe pattern as the Route button.)

- [ ] **Step 3: Add the delegated Shadow listener**

In `public/app.js`, immediately after the Route button's delegated listener (the `$('savings-out').addEventListener('click', ...)` block that ends ~line 515), add a second delegated listener:

```js
// Shadow button (delegated — same numeric-index pattern as Route).
$('savings-out').addEventListener('click', async (e) => {
  const btn = e.target.closest('.shadow-btn');
  if (!btn || !lastSavings) return;
  const f = lastSavings.findings[+btn.dataset.i];
  if (!f) return;
  const on = btn.dataset.on === '1';
  btn.disabled = true;
  try {
    const res = await fetch('/api/shadow', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: lastSavings.wf, agent: f.agent, model: on ? '' : f.to }) });
    if (res.ok) { btn.dataset.on = on ? '' : '1'; btn.textContent = on ? 'Shadow' : 'Shadowing'; }
  } catch { /* leave as-is */ }
  btn.disabled = false;
});
```

- [ ] **Step 4: Add `renderShadows()` and call it from `renderAll()`**

In `public/app.js`, add the render function right before `function renderAll() {` (~line 589):

```js
function renderShadows() {
  const panel = $('shadow-panel'), box = $('shadow-out');
  const list = (snap.shadows || []).filter((s) => s.workflow === selectedWf);
  panel.hidden = !list.length;
  box.innerHTML = list.map((s) => {
    const pct = Math.round((s.agreement || 0) * 100);
    const cls = s.status === 'drifting' ? 'warn' : '';
    const model = (s.model || '').replace(/^(claude|gemini)-/, '');
    return `<div class="savings-row"><span>${esc(s.agent)} → ${esc(model)}</span>` +
      `<span class="agree ${cls}">${s.runs ? pct + '%' : '—'}</span>` +
      `<span class="save ${cls}">${esc(s.status)} · ${s.samples || 0} samples</span></div>`;
  }).join('') +
    `<div class="savings-note">Re-verifies each candidate on fresh traffic every few minutes — this spends on forks + judge calls. Click <b>Shadow</b> on a finding again to stop.</div>`;
}
```

Then, inside `renderAll()`, add a call to `renderShadows()` after `renderTasks(wf);` (~line 601):

```js
  renderTasks(wf);
  renderShadows();
```

(`esc` escapes `& < >`; `s.agent`/`s.model`/`s.status` go into element **text**, not attributes, so `esc` is the right tool here — no attribute interpolation.)

- [ ] **Step 5: Verify syntax (no unit test — `public/` has no test infra, by convention)**

Run: `node --check public/app.js`
Expected: no output (syntax OK). Live behavior is confirmed in the final integration pass.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat(ui): Shadow button on findings + live Shadow panel (POST /api/shadow)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final integration pass (after all four tasks + review)

- [ ] **Full suite green:** `node --test *.test.js sdk/node/*.test.js` → 0 fail.
- [ ] **End-to-end shadow:** start the server (preview), `POST /api/shadow` a pairing, confirm `/api/snapshot`'s `shadows` carries it (status `validating`); then drive `store.recordShadow` semantics by feeding samples (the loop needs captured requests + provider keys, like `/api/savings`) and confirm the status transitions validating→passing→drifting and the panel reflects it. A short `SHADOW_INTERVAL_MS` (e.g. `SHADOW_INTERVAL_MS=3000`) exercises the loop without waiting 5 min. Provider keys stay env-only.
- [ ] **Push to `main`** (no PR): rebase if the remote moved, then `git push`.

## Self-Review (author checklist — completed)

- **Spec coverage:** pure EWMA engine + status (Task 1) ✓; durable shadow set + snapshot field (Task 2) ✓; arm endpoint + background re-verify loop reusing analyze/judge/fork + skip-when-idle/no-key + non-overlap guard (Task 3) ✓; Shadow button (any fidelity) + live panel with status + cost copy (Task 4) ✓; drift surfaced as the red `drifting` row (Task 4) ✓.
- **Deviation from spec (intentional):** the spec said drift "folds into `alerts`"; the plan instead surfaces drift as the red `drifting` row in the Shadow panel and adds only `shadows` to the snapshot — the existing `alerts` array has anomaly-ratio shape that `renderAlerts`/`renderMetrics` depend on, and conflating a second shape would risk breaking them. Same alarm, no regression. Fleet-level drift alerting is a deferred nicety.
- **Placeholder scan:** none — every code step is verbatim.
- **Type consistency:** `updateShadow`/`shadowStatus` signatures match Task 1→2; `sample = { agreement, samples }` is produced identically by the store test and the server loop (`{ agreement: f.agreement, samples: f.samples }` from an `analyze` finding, which carries both); `store.shadows()` row shape matches what `renderShadows` reads (`agent`, `model`, `agreement`, `runs`, `samples`, `status`); route key `"workflow/agent"` built identically in `shadow`/`recordShadow`.
- **Security:** Shadow button carries only a numeric `data-i`; `renderShadows` interpolates `agent`/`model`/`status` into element text via `esc()` (not attributes); `/api/shadow` validates its body.
- **Cost safety:** loop skips pairings with no captured steps or no target key, guards against overlapping passes (`shadowRunning`), and the interval is env-tunable — the ongoing spend is bounded and never touches the agent's own calls.