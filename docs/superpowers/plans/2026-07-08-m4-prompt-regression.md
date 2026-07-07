# Savings M4 — Prompt-Change Regression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given a proposed new system prompt, re-run it against a golden set of an agent's real calls and report the blast radius — how many outputs materially changed, plus cost/length drift — for human review before shipping.

**Architecture:** A pure `regression.js` engine samples an agent's captured steps, forks each with `request.system` swapped to the new prompt (same model), scores the new output vs the recorded baseline, and aggregates. A `/api/regression` job endpoint mirrors `/api/savings`; a "Prompt regression" panel takes the pasted prompt in a textarea and renders the blast-radius verdict + per-trace rows.

**Tech Stack:** Node ≥20 (ESM, `node:test`, `fetch`). Zero deps. Reuses the M1–M3 substrate.

## Global Constraints

- **Reuses shipped substrate, no substrate change:** `forkStep(step, {provider, model}, call?)` → `{ original:{cost,completion,...}, fork:{cost,completion,...}, deltaCost }`; `sampleSteps(steps, n=8)` + `projectCallsPerMonth(steps)` in `savings.js`; `score(baseline, new, {judge})` in `agreement.js`; `makeJudge`, `keyFor`, `providerOf`, `JUDGE_MODEL`, `store.agentSteps`, `store.snapshot`.
- **Change = new system prompt, same model:** fork `{ ...step, request: { ...step.request, system: newSystem } }` on `{ model: step.model }`. `step.completion` = baseline (current prompt), `fork.completion` = new-prompt output.
- **Advisory, not a binary verdict:** report blast radius (count changed, cost/length drift); never auto-ship/block.
- **`changed` = count of rows with agreement < passBar (0.95).** `costDeltaPct = (costNew-costOld)/costOld`; `lengthDeltaPct` = mean per-row `(newLen-oldLen)/oldLen` (guard `oldLen===0`).
- Zero mandatory deps. Work directly on `main` (do NOT branch). Commit per task.

---

### Task 1: Regression engine (`regression.js`)

**Files:**
- Create: `regression.js`
- Test: `regression.test.js`

**Interfaces:**
- Consumes: `sampleSteps` (`savings.js`); injected `fork(step, target) → {original, fork}` and `score(a, b) → {score}`.
- Produces: `analyzeRegression({ steps, agent, newSystem, callsPerMonth, fork, score, passBar = 0.95 }) → { agent, samples, meanAgreement, changed, costOld, costNew, costDeltaPct, lengthDeltaPct, rows }` where `rows = [{ agreement, baseline, updated }]`.

- [ ] **Step 1: Write the failing test**

`regression.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRegression } from './regression.js';

const mkStep = (completion) => ({ kind: 'chat', model: 'claude-opus-4-8', cost: 0.03, completion, request: { system: 'old', messages: [{ role: 'user', content: 'q' }] } });

test('identical new output → agreement 1, nothing changed, zero drift', async () => {
  const steps = [mkStep('same answer'), mkStep('same answer')];
  const fork = async (s) => ({ original: { cost: 0.03, completion: s.completion }, fork: { cost: 0.03, completion: s.completion } });
  const score = async (a, b) => ({ score: a === b ? 1 : 0 });
  const r = await analyzeRegression({ steps, agent: 'x', newSystem: 'new', callsPerMonth: 1000, fork, score });
  assert.equal(r.samples, 2);
  assert.equal(r.meanAgreement, 1);
  assert.equal(r.changed, 0);
  assert.equal(r.costDeltaPct, 0);
  assert.equal(r.lengthDeltaPct, 0);
  assert.equal(r.rows.length, 2);
});

test('differing new output → counts changed, computes cost/length drift', async () => {
  const steps = [mkStep('short')]; // baseline len 5
  // new prompt: different, longer output, cheaper call
  const fork = async (s) => ({ original: { cost: 0.03, completion: s.completion }, fork: { cost: 0.024, completion: 'a much longer answer' } });
  const score = async () => ({ score: 0.4 });
  const r = await analyzeRegression({ steps, agent: 'x', newSystem: 'new', callsPerMonth: 1000, fork, score });
  assert.equal(r.changed, 1);            // 0.4 < 0.95
  assert.equal(r.meanAgreement, 0.4);
  assert.ok(Math.abs(r.costDeltaPct - (-0.2)) < 1e-9);   // (0.024-0.03)/0.03
  assert.ok(r.lengthDeltaPct > 0);       // 'a much longer answer' longer than 'short'
});

test('the fork request has the new system prompt swapped in', async () => {
  let seen;
  const fork = async (s) => { seen = s.request.system; return { original: { cost: 0.03, completion: 'x' }, fork: { cost: 0.03, completion: 'x' } }; };
  await analyzeRegression({ steps: [mkStep('x')], agent: 'x', newSystem: 'THE NEW PROMPT', callsPerMonth: 1, fork, score: async () => ({ score: 1 }) });
  assert.equal(seen, 'THE NEW PROMPT');
});

test('empty sample → samples 0, empty rows', async () => {
  const r = await analyzeRegression({ steps: [], agent: 'x', newSystem: 'new', callsPerMonth: 1, fork: async () => ({}), score: async () => ({ score: 1 }) });
  assert.equal(r.samples, 0);
  assert.deepEqual(r.rows, []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test regression.test.js`
Expected: FAIL — `Cannot find module './regression.js'`.

- [ ] **Step 3: Implement**

`regression.js`:
```js
// regression.js — prompt-change regression. Re-run an agent's real calls with a
// proposed new system prompt (same model) and report the blast radius vs the
// recorded baseline output. Pure: fork + score are injected. Reuses forkStep by
// forking a synthetic system-swapped step; no substrate change.
import { sampleSteps } from './savings.js';

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);

export async function analyzeRegression({ steps, agent, newSystem, callsPerMonth, fork, score, passBar = 0.95 }) {
  const sample = sampleSteps(steps);
  const rows = [];
  const oldCosts = [];
  const newCosts = [];
  const lenDeltas = [];
  for (const step of sample) {
    let r;
    try { r = await fork({ ...step, request: { ...step.request, system: newSystem } }, { model: step.model }); }
    catch { continue; }
    const baseline = r.original.completion || '';
    const updated = r.fork.completion || '';
    const agreement = (await score(baseline, updated)).score;
    oldCosts.push(r.original.cost);
    newCosts.push(r.fork.cost);
    lenDeltas.push(baseline.length ? (updated.length - baseline.length) / baseline.length : 0);
    rows.push({ agreement, baseline: baseline.slice(0, 200), updated: updated.slice(0, 200) });
  }
  const costOld = mean(oldCosts);
  const costNew = mean(newCosts);
  return {
    agent,
    samples: rows.length,
    meanAgreement: rows.length ? mean(rows.map((x) => x.agreement)) : 0,
    changed: rows.filter((x) => x.agreement < passBar).length,
    costOld,
    costNew,
    costDeltaPct: costOld ? (costNew - costOld) / costOld : 0,
    lengthDeltaPct: mean(lenDeltas),
    rows,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test regression.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add regression.js regression.test.js
git commit -m "feat: prompt-change regression engine (blast radius + drift)"
```

---

### Task 2: `/api/regression` endpoint

**Files:**
- Modify: `server.js` (import + route + job map)
- Test: manual smoke

**Interfaces:**
- Consumes: `analyzeRegression` (`regression.js`); `forkStep`, `keyFor`, `makeJudge`, `scoreFn`, `providerOf`, `projectCallsPerMonth`, `store.agentSteps`, `store.snapshot`, `JUDGE_MODEL`.
- Produces: `POST /api/regression { workflow, agent?, newSystem }` → `{ id }`; `GET /api/regression?id=` → `{ status, agent?, result?, error? }`. Missing/empty `newSystem` → 400.

- [ ] **Step 1: Add the import + job map**

In `server.js`, add to the imports:
```js
import { analyzeRegression } from './regression.js';
```
After the existing `const contextJobs = new Map();` line, add:
```js
const regressionJobs = new Map();
```

- [ ] **Step 2: Add the routes**

In `server.js`, immediately after the `GET /api/context-roi` poll handler, add:
```js
  if (req.method === 'POST' && url.pathname === '/api/regression') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let params; try { params = JSON.parse(body); } catch { res.writeHead(400).end('{}'); return; }
      if (!params.newSystem || !String(params.newSystem).trim()) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'newSystem prompt required' })); return; }
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
      regressionJobs.set(id, { status: 'running' });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
      analyzeRegression({ steps, agent: agentName, newSystem: params.newSystem, callsPerMonth, fork: forkStep, score })
        .then((result) => regressionJobs.set(id, { status: 'done', agent: agentName, result }))
        .catch((e) => regressionJobs.set(id, { status: 'error', error: e.message }));
    });
    return;
  }

  if (url.pathname === '/api/regression') { // GET poll
    const job = regressionJobs.get(url.searchParams.get('id'));
    if (!job) { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(job));
    return;
  }
```

- [ ] **Step 3: Regression + smoke**

Run: `node --test regression.test.js savings.test.js agreement.test.js fork.test.js translate.test.js store.test.js` → all pass.
Then: `node server.js` in one shell; smoke the guards:
- `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:4700/api/regression -H 'content-type: application/json' -d '{"workflow":"x"}'` → **400** (missing newSystem).
- `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:4700/api/regression -H 'content-type: application/json' -d '{"workflow":"nope","newSystem":"hi"}'` → **404** (unknown workflow).
Confirm no crash; stop the server.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: /api/regression job endpoint"
```

---

### Task 3: Prompt regression UI panel

**Files:**
- Modify: `public/index.html` (panel + styles)
- Modify: `public/app.js` (trigger + poll + render)
- Test: manual (`node --check` + preview)

**Interfaces:**
- Consumes: `POST /api/regression`, `GET /api/regression?id=` (Task 2); `selectedWf`, `money(n)` (existing).

- [ ] **Step 1: Add the panel markup + styles**

In `public/index.html`, add a panel near the Context ROI panel:
```html
<div class="panel" id="regression-panel">
  <h2>Prompt regression</h2>
  <textarea id="regression-input" placeholder="Paste a proposed new system prompt…" rows="3"></textarea>
  <button id="regression-run" class="btn">Run regression</button>
  <div id="regression-out"></div>
</div>
```
Add styles near the savings/context styles:
```html
<style>
#regression-panel textarea { width: 100%; box-sizing: border-box; background: var(--ink); color: var(--text); border: 1px solid var(--line2); border-radius: 6px; padding: 8px 10px; font: 12px "IBM Plex Mono", monospace; resize: vertical; margin-bottom: 8px; }
#regression-panel .btn { background: var(--wire); color: #08132b; border: 0; border-radius: 6px; padding: 7px 13px; font: 500 12.5px "IBM Plex Sans", sans-serif; cursor: pointer; }
.regr-head { font: 13px "IBM Plex Mono", monospace; color: var(--wire); margin: 10px 0; }
.regr-row { font: 11.5px "IBM Plex Mono", monospace; color: var(--dim); padding: 7px 0; border-top: 1px solid var(--line); }
.regr-row .agree { color: var(--ok); } .regr-row .agree.warn { color: var(--money); }
.regr-row .snip { color: var(--faint); display: block; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
```

- [ ] **Step 2: Wire the trigger + render in app.js**

In `public/app.js`, add near the context handler:
```js
$('regression-run').addEventListener('click', async () => {
  const wf = selectedWf;
  const newSystem = $('regression-input').value;
  const out = $('regression-out');
  if (!newSystem.trim()) { out.innerHTML = '<div class="savings-note">Paste a proposed system prompt first.</div>'; return; }
  out.innerHTML = '<div class="savings-note">Re-running the golden set with the new prompt…</div>';
  let job;
  try {
    const { id } = await (await fetch('/api/regression', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow: wf, newSystem }) })).json();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      job = await (await fetch('/api/regression?id=' + id)).json();
      if (job.status !== 'running') break;
    }
  } catch (e) { out.innerHTML = `<div class="savings-note">${e.message}</div>`; return; }
  if (!job || job.status === 'error') { out.innerHTML = `<div class="savings-note">${job?.error || 'regression failed'}</div>`; return; }
  const r = job.result || {};
  if (!r.samples) { out.innerHTML = `<div class="savings-note">No captured requests for <b>${r.agent || 'this agent'}</b> — enable <code>captureRequests</code> in the tracer (and set provider keys) so its calls can be re-run.</div>`; return; }
  const pct = (x) => (x >= 0 ? '+' : '') + Math.round(x * 100) + '%';
  out.innerHTML = `<div class="regr-head">${r.changed} of ${r.samples} outputs changed · cost ${pct(r.costDeltaPct)} · length ${pct(r.lengthDeltaPct)} · agent ${r.agent}</div>` +
    (r.rows || []).map((row) => {
      const p = Math.round(row.agreement * 100);
      return `<div class="regr-row"><span class="agree ${row.agreement < 0.95 ? 'warn' : ''}">${p}% match</span>` +
        `<span class="snip">old: ${(row.baseline || '').replace(/</g, '&lt;')}</span>` +
        `<span class="snip">new: ${(row.updated || '').replace(/</g, '&lt;')}</span></div>`;
    }).join('') +
    `<div class="savings-note">Advisory — a low % means the new prompt changed that output; review before shipping. Nothing shipped.</div>`;
});
```

- [ ] **Step 3: Verify**

Run: `node --check public/app.js`.
Then start the server, drill into a workflow, paste any text, click "Run regression", and confirm the page loads with no console error and (with no captured traces) the empty-state note shows. Take a preview screenshot.

- [ ] **Step 4: Manual live check (deferred to operator)**

With captured traces + provider keys, paste a modified system prompt → a blast-radius line + per-trace old/new snippets.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: Prompt regression panel (paste prompt → blast radius)"
```

---

## Self-Review

**Spec coverage:**
- Engine forks a system-swapped step on the same model, scores baseline vs new → Task 1. ✅
- Result shape `{agent, samples, meanAgreement, changed, costOld, costNew, costDeltaPct, lengthDeltaPct, rows}` → Task 1. ✅
- `changed` = agreement<bar; cost/length drift formulas → Task 1 (guarded oldLen/costOld). ✅
- `/api/regression` job, `newSystem` required (400), unknown wf (404) → Task 2. ✅
- Textarea panel, blast-radius line + per-trace rows, empty-state, advisory → Task 3. ✅
- Reuses forkStep/sampleSteps/projectCallsPerMonth/score/agentSteps — no substrate change. ✅
- Non-goals (canary, model regression, tool/refusal drift) not built. ✅

**Placeholder scan:** none — complete code in every step; the two manual steps (2.3 smoke, 3.4 live) are explicit and keys-gated.

**Type consistency:** `analyzeRegression({steps, agent, newSystem, callsPerMonth, fork, score, passBar})` identical Task 1 def / Task 2 call; result fields identical Task 1 → Task 3 render; `fork({...step, request:{...system}}, {model})` matches shipped `forkStep`; `sampleSteps`, `projectCallsPerMonth`, `scoreFn`, `makeJudge`, `store.agentSteps` match shipped signatures.
