# Savings M2 — Context ROI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show which context segments earn their tokens — for each ablatable segment (tools / system / history), re-run an agent's real calls with it removed and report the recoverable spend if output still agrees.

**Architecture:** A pure `contextroi.js` engine ablates the canonical request and reuses `forkStep` by forking a synthetic step (the ablated request on the SAME model) — no substrate change. A `/api/context-roi` job mirrors `/api/savings`; a Context ROI panel renders per-segment findings.

**Tech Stack:** Node ≥20 (ESM, `node:test`, `fetch`). Zero deps.

## Global Constraints

- **Depends on** the shipped M1 substrate + the agreement-metric refinement (land that plan first): `forkStep(step, {provider, model}, call?)` → `{ original:{model,cost,completion,...}, fork:{model,cost,completion,...}, deltaCost }`; `sampleSteps(steps, n)` and `projectCallsPerMonth(steps)` in `savings.js`; `score(original, fork, {judge})` in `agreement.js`; `makeJudge`, `keyFor`, `providerOf`, `store.agentSteps`.
- **Ablate only what the canonical request separates:** `tools`, `system`, `history` (keep last turn). Retrieval-segment ablation is out of scope (deferred — needs SDK labeling).
- **Reuse `forkStep` unchanged** — fork a synthetic `{ ...step, request: ablatedRequest }` on `{ model: step.model }`.
- **Advisory only** — nothing is applied; findings only.
- `savingsPerMo = (costOld - costNew) * callsPerMonth`; `pass = agreement >= passBar` (default 0.95) means "safe to drop this segment."
- Zero mandatory deps. Work directly on `main` (do NOT branch). Commit per task.

---

### Task 1: Context-ROI engine (`contextroi.js`)

**Files:**
- Create: `contextroi.js`
- Test: `contextroi.test.js`

**Interfaces:**
- Consumes: `sampleSteps` (`savings.js`); injected `fork(step, target) → {original, fork}` and `score(a, b) → {score}`.
- Produces:
  - `ablations(request) → [{ segment, request }]` — variants for present segments only (`segment` ∈ `'tools'|'system'|'history'`).
  - `analyzeContext({ steps, agent, callsPerMonth, fork, score, passBar = 0.95 }) → finding[]`, finding = `{ agent, segment, agreement, costOld, costNew, savingsPerMo, pass, samples }`, sorted by `savingsPerMo` desc.

- [ ] **Step 1: Write the failing test**

`contextroi.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ablations, analyzeContext } from './contextroi.js';

const mkStep = (i) => ({
  kind: 'chat', model: 'claude-opus-4-8', cost: 0.03, completion: `{"n":${i}}`,
  request: { system: 'sys', tools: [{ name: 't' }], messages: [
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
  ] },
});

test('ablations emits a variant per present segment', () => {
  assert.deepEqual(ablations(mkStep(1).request).map((a) => a.segment).sort(), ['history', 'system', 'tools']);
});

test('ablations skips absent segments', () => {
  assert.deepEqual(ablations({ messages: [{ role: 'user', content: 'x' }] }).map((a) => a.segment), []);
});

test('ablations content: tools dropped, system emptied, history trimmed to last turn', () => {
  const by = Object.fromEntries(ablations(mkStep(1).request).map((a) => [a.segment, a.request]));
  assert.equal(by.tools.tools, undefined);
  assert.equal(by.system.system, '');
  assert.deepEqual(by.history.messages, [{ role: 'user', content: 'c' }]);
});

test('analyzeContext scores each ablatable segment into a finding', async () => {
  const step = mkStep(1);
  const fork = async (s, t) => ({ original: { model: s.model, cost: 0.03, completion: s.completion }, fork: { model: t.model, cost: 0.02, completion: s.completion } });
  const score = async (a, b) => ({ score: a === b ? 1 : 0 });
  const findings = await analyzeContext({ steps: [step], agent: 'x', callsPerMonth: 1000, fork, score });
  assert.equal(findings.length, 3);
  for (const f of findings) {
    assert.equal(f.agreement, 1);
    assert.equal(f.pass, true);
    assert.equal(f.savingsPerMo, 10); // (0.03-0.02)*1000
    assert.equal(f.samples, 1);
  }
  assert.deepEqual(findings.map((f) => f.segment).sort(), ['history', 'system', 'tools']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test contextroi.test.js`
Expected: FAIL — `Cannot find module './contextroi.js'`.

- [ ] **Step 3: Implement**

`contextroi.js`:
```js
// contextroi.js — the context-ROI engine. For each ablatable context segment,
// re-run the agent's real calls with that segment removed (SAME model) and measure
// output agreement + cost delta. Reuses forkStep by forking a synthetic ablated step;
// no change to the fork/translate substrate.
import { sampleSteps } from './savings.js';

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);

// Ablation variants, emitted only when the segment is present and non-trivial.
export function ablations(request) {
  const out = [];
  if (request.tools) out.push({ segment: 'tools', request: { ...request, tools: undefined } });
  if (request.system) out.push({ segment: 'system', request: { ...request, system: '' } });
  if ((request.messages || []).length > 1) out.push({ segment: 'history', request: { ...request, messages: request.messages.slice(-1) } });
  return out;
}

export async function analyzeContext({ steps, agent, callsPerMonth, fork, score, passBar = 0.95 }) {
  const sample = sampleSteps(steps);
  const acc = new Map(); // segment -> { agreements, oldCosts, newCosts }
  for (const step of sample) {
    for (const { segment, request } of ablations(step.request || {})) {
      let r;
      try { r = await fork({ ...step, request }, { model: step.model }); } catch { continue; }
      const a = acc.get(segment) || { agreements: [], oldCosts: [], newCosts: [] };
      a.oldCosts.push(r.original.cost);
      a.newCosts.push(r.fork.cost);
      a.agreements.push((await score(r.original.completion, r.fork.completion)).score);
      acc.set(segment, a);
    }
  }
  const findings = [];
  for (const [segment, a] of acc) {
    if (!a.agreements.length) continue;
    const agreement = mean(a.agreements);
    const costOld = mean(a.oldCosts);
    const costNew = mean(a.newCosts);
    findings.push({ agent, segment, agreement, costOld, costNew, savingsPerMo: (costOld - costNew) * callsPerMonth, pass: agreement >= passBar, samples: a.agreements.length });
  }
  return findings.sort((x, y) => y.savingsPerMo - x.savingsPerMo);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test contextroi.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add contextroi.js contextroi.test.js
git commit -m "feat: context-ROI engine (ablate tools/system/history, score agreement)"
```

---

### Task 2: `/api/context-roi` endpoint

**Files:**
- Modify: `server.js` (import + route + job map)
- Test: manual smoke

**Interfaces:**
- Consumes: `analyzeContext` (`contextroi.js`); `forkStep`, `keyFor` (`fork.js`); `makeJudge` (`judge.js`); `scoreFn` (`agreement.js`, already imported as `score as scoreFn`); `projectCallsPerMonth` (`savings.js`); `providerOf` (`translate.js`); `store.agentSteps`, `store.snapshot`.
- Produces: `POST /api/context-roi { workflow, agent? }` → `{ id }`; `GET /api/context-roi?id=` → `{ status, agent?, findings?/error? }`.

- [ ] **Step 1: Add the import + job map**

In `server.js`, add to the imports:
```js
import { analyzeContext } from './contextroi.js';
```
After the existing `const savingsJobs = new Map();` line, add:
```js
const contextJobs = new Map();
```

- [ ] **Step 2: Add the routes**

In `server.js`, immediately after the `GET /api/savings` poll handler, add (mirrors the savings route; `JUDGE_MODEL`, `DEFAULT_TARGETS` etc. already exist):
```js
  if (req.method === 'POST' && url.pathname === '/api/context-roi') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let params; try { params = JSON.parse(body); } catch { res.writeHead(400).end('{}'); return; }
      const snap = store.snapshot();
      const wf = snap.workflows.find((w) => w.name === params.workflow);
      if (!wf) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown workflow' })); return; }
      const agentName = params.agent || (wf.agents[0] && wf.agents[0].name);
      const agentRow = wf.agents.find((a) => a.name === agentName);
      if (!agentRow) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown agent' })); return; }
      const steps = store.agentSteps(params.workflow, agentName);
      const callsPerMonth = projectCallsPerMonth(steps);
      const judgeKey = keyFor(providerOf(JUDGE_MODEL));
      const judge = judgeKey ? makeJudge({ model: JUDGE_MODEL, key: judgeKey }) : null;
      const score = (a, b) => scoreFn(a, b, judge ? { judge } : {});

      const id = Math.random().toString(16).slice(2, 10);
      contextJobs.set(id, { status: 'running' });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
      analyzeContext({ steps, agent: agentName, callsPerMonth, fork: forkStep, score })
        .then((findings) => contextJobs.set(id, { status: 'done', agent: agentName, findings }))
        .catch((e) => contextJobs.set(id, { status: 'error', error: e.message }));
    });
    return;
  }

  if (url.pathname === '/api/context-roi') { // GET poll
    const job = contextJobs.get(url.searchParams.get('id'));
    if (!job) { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(job));
    return;
  }
```

- [ ] **Step 3: Regression + smoke**

Run: `node --test contextroi.test.js savings.test.js agreement.test.js fork.test.js translate.test.js store.test.js` → all pass.
Then: `node server.js` in one shell; `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:4700/api/context-roi -H 'content-type: application/json' -d '{"workflow":"nope"}'` → expect 404. Confirm no crash; stop the server.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: /api/context-roi job endpoint"
```

---

### Task 3: Context ROI report UI

**Files:**
- Modify: `public/index.html` (panel + styles)
- Modify: `public/app.js` (trigger + poll + render)
- Test: manual (`node --check` + preview)

**Interfaces:**
- Consumes: `POST /api/context-roi`, `GET /api/context-roi?id=` (Task 2); `selectedWf`, `money(n)` (existing).

- [ ] **Step 1: Add the panel markup + styles**

In `public/index.html`, add a panel next to the Savings Report panel:
```html
<div class="panel" id="context-panel">
  <h2>Context ROI</h2>
  <button id="context-run" class="btn">Analyze context</button>
  <div id="context-out"></div>
</div>
```
Add styles near the savings styles (reuse the `.btn`, `.savings-row`, `.savings-note` families):
```html
<style>
#context-panel .btn { background: var(--violet); color: #120a24; border: 0; border-radius: 6px; padding: 7px 13px; font: 500 12.5px "IBM Plex Sans", sans-serif; cursor: pointer; }
.context-head { font: 13px "IBM Plex Mono", monospace; color: var(--violet); margin: 10px 0; }
</style>
```

- [ ] **Step 2: Wire the trigger + render in app.js**

In `public/app.js`, add near the savings handler:
```js
$('context-run').addEventListener('click', async () => {
  const wf = selectedWf;
  const out = $('context-out');
  out.innerHTML = '<div class="savings-note">Re-running calls with each context segment removed…</div>';
  let job;
  try {
    const { id } = await (await fetch('/api/context-roi', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow: wf }) })).json();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      job = await (await fetch('/api/context-roi?id=' + id)).json();
      if (job.status !== 'running') break;
    }
  } catch (e) { out.innerHTML = `<div class="savings-note">${e.message}</div>`; return; }
  if (!job || job.status === 'error') { out.innerHTML = `<div class="savings-note">${job?.error || 'analysis failed'}</div>`; return; }
  const pass = (job.findings || []).filter((f) => f.pass && f.savingsPerMo > 0);
  const yr = pass.reduce((s, f) => s + f.savingsPerMo, 0) * 12;
  out.innerHTML = `<div class="context-head">Trimmable ≈ ${money(yr)}/yr · agent ${job.agent}</div>` +
    (job.findings || []).map((f) => {
      const pct = Math.round(f.agreement * 100);
      return `<div class="savings-row"><span>drop ${f.segment}</span>` +
        `<span class="agree ${f.pass ? '' : 'warn'}">${pct}%</span>` +
        `<span class="save">${money(f.savingsPerMo)}/mo</span></div>`;
    }).join('') +
    `<div class="savings-note">A below-bar segment changes output if removed — keep it. Advisory only.</div>`;
});
```

- [ ] **Step 3: Verify**

Run: `node --check public/app.js`.
Then start the server, open the dashboard, drill into a workflow, and confirm the "Context ROI" panel + "Analyze context" button render with no console error (findings need keys — deferred). Take a preview screenshot.

- [ ] **Step 4: Manual live check (deferred to operator)**

With captured traces + provider keys, click "Analyze context" → per-segment agreement + trimmable $/mo.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: Context ROI report panel"
```

---

## Self-Review

**Spec coverage:**
- Ablation transforms tools/system/history, present-only → Task 1 `ablations`. ✅
- Reuse forkStep via synthetic ablated step, same model → Task 1 `analyzeContext` (`fork({...step, request}, {model: step.model})`). ✅
- Finding shape + `pass`/`savingsPerMo`, sorted → Task 1. ✅
- `/api/context-roi` job mirroring `/api/savings` → Task 2. ✅
- Report panel per-segment → Task 3. ✅
- Advisory only → no mutation anywhere; UI note states it. ✅
- Retrieval-segment deferred → not in `ablations`. ✅

**Placeholder scan:** none — complete code in every step; the two manual steps (2.3 smoke, 3.4 live) are explicit and keys-gated.

**Type consistency:** `ablations(request)` / `analyzeContext({steps, agent, callsPerMonth, fork, score, passBar})` identical Task 1 def / Task 2 use; finding fields `{agent, segment, agreement, costOld, costNew, savingsPerMo, pass, samples}` identical Task 1 → Task 3 render; `forkStep(step, {model})`, `projectCallsPerMonth`, `sampleSteps`, `scoreFn`, `makeJudge`, `store.agentSteps` match shipped signatures.
