# Savings M1 · Plan 2 of 2 — Downgrade Engine + Savings Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the faithful-fork substrate (Plan 1) into an auditable dollar finding — sample an agent's real calls, fork them onto cheaper models, score output agreement, and surface the recoverable spend in a Savings Report.

**Architecture:** Pure `agreement.js` scores two completions (structural field-match for JSON, else an injected LLM-judge). `judge.js` builds a real judge from `translate.js` + a provider call. Pure `savings.js` samples steps, forks each via the injected `forkStep`, aggregates cost delta × monthly volume into findings. A `/api/savings` job endpoint runs the engine with the real fork + judge; a report panel renders the findings.

**Tech Stack:** Node ≥20 (ESM, `node:test`, `fetch`). Zero mandatory deps; the judge is a provider REST call (as `fork.js`/`translate.js` already do).

## Global Constraints

- **Builds on Plan 1** (already on `main`): `forkStep(step, {provider, model}, call?)` returns `{ original:{model,in,out,cost,completion}, fork:{provider,model,in,out,cost,completion}, deltaCost }`; `providerOf(model)`, `toProvider`, `parseResponse` in `translate.js`; `keyFor(provider)` in `fork.js`; chat steps carry `request` (canonical `{system, messages, tools}`) when captured; `callCost(model, in, out)` in `store.js`.
- **Zero mandatory runtime deps.** Judge/fork are `fetch` to REST endpoints; no provider SDKs imported.
- **No change is ever auto-applied — advisory only.** The report suggests; it never mutates the user's system.
- **Agreement metric:** structural field-match when both completions parse as JSON; otherwise an LLM-judge (0–1). The pass bar is a threshold, default `0.95`.
- **Sampling is cost-bounded:** default `N = 8` recent chat steps per agent that carry a captured request.
- **`savingsPerMo` = mean per-call cost delta × the agent's observed calls/month.**
- **Cross-provider findings are flagged** `fidelity: 'cross-provider'` (tools were dropped in Plan 1); same-provider are `fidelity: 'exact'`.
- Work directly on `main` (this project pushes direct to main; do NOT branch). Commit per task.

---

### Task 1: Agreement metric (`agreement.js`)

**Files:**
- Create: `agreement.js`
- Test: `agreement.test.js`

**Interfaces:**
- Produces:
  - `structuralScore(a, b) → number` — fraction of `a`'s leaf paths present-and-equal in `b` (0–1).
  - `score(original, fork, { judge } = {}) → Promise<{ score, method }>` — `method` is `'structural'` | `'judge'` | `'none'`. `judge` is `async (a, b) => number` (0–1), injectable.

- [ ] **Step 1: Write the failing test**

`agreement.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structuralScore, score } from './agreement.js';

test('structuralScore: identical JSON leaves → 1', () => {
  assert.equal(structuralScore({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }), 1);
});

test('structuralScore: half the leaves match → 0.5', () => {
  assert.equal(structuralScore({ a: 1, b: 2 }, { a: 1, b: 999 }), 0.5);
});

test('score: two JSON strings use the structural path (no judge call)', async () => {
  let judged = false;
  const r = await score('{"x": 1, "y": 2}', '{"x": 1, "y": 3}', { judge: async () => { judged = true; return 0; } });
  assert.equal(r.method, 'structural');
  assert.equal(r.score, 0.5);
  assert.equal(judged, false, 'judge must not be called when both parse as JSON');
});

test('score: free text falls back to the injected judge', async () => {
  const r = await score('the sky is blue', 'skies are blue', { judge: async (a, b) => 0.88 });
  assert.equal(r.method, 'judge');
  assert.equal(r.score, 0.88);
});

test('score: free text with no judge → method none, score 0', async () => {
  const r = await score('a', 'b');
  assert.deepEqual(r, { score: 0, method: 'none' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test agreement.test.js`
Expected: FAIL — `Cannot find module './agreement.js'`.

- [ ] **Step 3: Implement**

`agreement.js`:
```js
// agreement.js — score two completions for output agreement (0–1). Structural
// field-match when both parse as JSON (deterministic, free); otherwise an
// injected LLM-judge. The metric behind every savings finding.

function leaves(obj, prefix, out) {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) leaves(obj[k], prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = obj;
  }
  return out;
}

export function structuralScore(a, b) {
  const la = leaves(a, '', {});
  const lb = leaves(b, '', {});
  const keys = Object.keys(la);
  if (!keys.length) return Object.keys(lb).length ? 0 : 1;
  const matched = keys.filter((k) => Object.prototype.hasOwnProperty.call(lb, k) && lb[k] === la[k]).length;
  return matched / keys.length;
}

function asJson(s) { try { return JSON.parse(s); } catch { return undefined; } }

export async function score(original, fork, { judge } = {}) {
  const a = asJson(original);
  const b = asJson(fork);
  if (a !== undefined && b !== undefined) return { score: structuralScore(a, b), method: 'structural' };
  if (judge) return { score: await judge(original, fork), method: 'judge' };
  return { score: 0, method: 'none' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test agreement.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add agreement.js agreement.test.js
git commit -m "feat: output-agreement metric (structural + judge seam)"
```

---

### Task 2: LLM-judge (`judge.js`)

**Files:**
- Create: `judge.js`
- Modify: `fork.js` (export the existing `httpCall`)
- Test: `judge.test.js`

**Interfaces:**
- Consumes: `toProvider`, `parseResponse`, `providerOf` (`translate.js`); `httpCall` (`fork.js`).
- Produces: `makeJudge({ model, key, call? }) → async (a, b) => number` — a judge that asks `model` to rate agreement 0–1 and returns a clamped float. `call` defaults to `httpCall`, injectable for tests.

- [ ] **Step 1: Export httpCall from fork.js**

In `fork.js`, change `async function httpCall(...)` to `export async function httpCall(...)` (same body).

- [ ] **Step 2: Write the failing test**

`judge.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeJudge } from './judge.js';

test('makeJudge builds a judge prompt and parses a float score', async () => {
  let seen;
  const call = async (url, headers, body) => { seen = body; return { candidates: [{ content: { parts: [{ text: '0.9' }] } }], usageMetadata: {} }; };
  const judge = makeJudge({ model: 'gemini-2.5-flash', key: 'k', call });
  const s = await judge('answer A', 'answer B');
  assert.equal(s, 0.9);
  const prompt = JSON.stringify(seen);
  assert.match(prompt, /answer A/);
  assert.match(prompt, /answer B/);
});

test('makeJudge clamps and defaults a non-numeric reply to 0', async () => {
  const judge = makeJudge({ model: 'gemini-2.5-flash', key: 'k', call: async () => ({ candidates: [{ content: { parts: [{ text: 'not a number' }] } }], usageMetadata: {} }) });
  assert.equal(await judge('a', 'b'), 0);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test judge.test.js`
Expected: FAIL — `Cannot find module './judge.js'`.

- [ ] **Step 4: Implement**

`judge.js`:
```js
// judge.js — an LLM-as-judge for output agreement. Reuses translate.js to call
// any provider; returns a clamped 0–1 agreement score. Injectable `call` for tests.
import { toProvider, parseResponse, providerOf } from './translate.js';
import { httpCall } from './fork.js';

const RUBRIC = 'You compare two AI answers to the same request and rate how equivalent they are in meaning and quality, from 0 (completely different / worse) to 1 (equivalent). Reply with ONLY a decimal number between 0 and 1.';

export function makeJudge({ model, key, call = httpCall }) {
  const provider = providerOf(model);
  return async (a, b) => {
    const canonical = { system: RUBRIC, messages: [{ role: 'user', content: `Answer A:\n${a}\n\nAnswer B:\n${b}\n\nAgreement score (0-1):` }] };
    const { url, headers, body } = toProvider(canonical, { provider, model, maxTokens: 8, key });
    const data = await call(url, headers, body);
    const { completion } = parseResponse(provider, data);
    const n = parseFloat(String(completion).match(/[0-9]*\.?[0-9]+/)?.[0]);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test judge.test.js fork.test.js`
Expected: PASS — 2 judge tests; fork tests still green (export change is inert).

- [ ] **Step 6: Commit**

```bash
git add judge.js fork.js judge.test.js
git commit -m "feat: LLM-as-judge for output agreement (reuses translate)"
```

---

### Task 3: Downgrade engine (`savings.js`)

**Files:**
- Create: `savings.js`
- Test: `savings.test.js`

**Interfaces:**
- Consumes: `providerOf` (`translate.js`); injected `fork(step, target) → {original, fork, deltaCost}` and `score(original, fork) → {score}`.
- Produces:
  - `sampleSteps(steps, n = 8) → step[]` — the last `n` chat steps carrying `request.messages`.
  - `analyze({ steps, agent, targets, callsPerMonth, fork, score, passBar = 0.95 }) → Promise<finding[]>`, finding = `{ agent, from, to, provider, agreement, costOld, costNew, savingsPerMo, fidelity, pass, samples }`, sorted by `savingsPerMo` desc.

- [ ] **Step 1: Write the failing test**

`savings.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleSteps, analyze } from './savings.js';

const mkStep = (i) => ({ kind: 'chat', model: 'claude-opus-4-8', cost: 0.03, completion: `{"n": ${i}}`, request: { messages: [{ role: 'user', content: 'q' }] } });

test('sampleSteps takes the last N chat steps with a request', () => {
  const steps = [...Array(12)].map((_, i) => mkStep(i));
  steps.push({ kind: 'tool' }, { kind: 'chat', model: 'm' }); // no request → excluded
  assert.equal(sampleSteps(steps, 8).length, 8);
  assert.ok(sampleSteps(steps, 8).every((s) => s.request?.messages?.length));
});

test('analyze aggregates agreement + cost delta into a finding with $/mo', async () => {
  const steps = [mkStep(1), mkStep(2)];
  // fake fork: cheaper model, identical structured output → agreement 1
  const fork = async (step, target) => ({
    original: { model: step.model, cost: 0.03, completion: step.completion },
    fork: { model: target.model, cost: 0.01, completion: step.completion },
    deltaCost: -0.02,
  });
  const score = async (a, b) => ({ score: a === b ? 1 : 0 });
  const findings = await analyze({ steps, agent: 'writer', targets: [{ model: 'claude-haiku-4-5' }], callsPerMonth: 10000, fork, score });
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.agent, 'writer');
  assert.equal(f.to, 'claude-haiku-4-5');
  assert.equal(f.agreement, 1);
  assert.equal(f.costOld, 0.03);
  assert.equal(f.costNew, 0.01);
  assert.equal(f.savingsPerMo, 200); // (0.03-0.01) * 10000
  assert.equal(f.fidelity, 'exact'); // claude→claude
  assert.equal(f.pass, true);
});

test('analyze flags cross-provider fidelity', async () => {
  const fork = async (s, t) => ({ original: { model: s.model, cost: 0.03, completion: 'x' }, fork: { model: t.model, cost: 0.005, completion: 'x' }, deltaCost: -0.025 });
  const score = async () => ({ score: 0.97 });
  const [f] = await analyze({ steps: [mkStep(1)], agent: 'a', targets: [{ model: 'gemini-2.5-flash' }], callsPerMonth: 1000, fork, score });
  assert.equal(f.fidelity, 'cross-provider'); // claude→gemini
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test savings.test.js`
Expected: FAIL — `Cannot find module './savings.js'`.

- [ ] **Step 3: Implement**

`savings.js`:
```js
// savings.js — the model-downgrade engine. Samples an agent's real calls, forks
// each onto cheaper targets, scores agreement, and turns the cost delta into a
// dollar finding. Pure: fork + score are injected (real ones wired in the server).
import { providerOf } from './translate.js';

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);

export function sampleSteps(steps, n = 8) {
  return steps.filter((s) => s.kind === 'chat' && s.request?.messages?.length).slice(-n);
}

export async function analyze({ steps, agent, targets, callsPerMonth, fork, score, passBar = 0.95 }) {
  const sample = sampleSteps(steps);
  const originModel = sample[0]?.model;
  const findings = [];
  for (const target of targets) {
    const provider = target.provider || providerOf(target.model);
    const agreements = [];
    const oldCosts = [];
    const newCosts = [];
    for (const step of sample) {
      let r;
      try { r = await fork(step, target); } catch { continue; } // a failed fork drops the sample, not the run
      oldCosts.push(r.original.cost);
      newCosts.push(r.fork.cost);
      agreements.push((await score(r.original.completion, r.fork.completion)).score);
    }
    if (!agreements.length) continue;
    const agreement = mean(agreements);
    const costOld = mean(oldCosts);
    const costNew = mean(newCosts);
    findings.push({
      agent, from: originModel, to: target.model, provider,
      agreement, costOld, costNew,
      savingsPerMo: (costOld - costNew) * callsPerMonth,
      fidelity: providerOf(originModel) === provider ? 'exact' : 'cross-provider',
      pass: agreement >= passBar,
      samples: agreements.length,
    });
  }
  return findings.sort((x, y) => y.savingsPerMo - x.savingsPerMo);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test savings.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add savings.js savings.test.js
git commit -m "feat: model-downgrade savings engine (sample→fork→score→$/mo)"
```

---

### Task 4: `/api/savings` endpoint + store step lookup

**Files:**
- Modify: `store.js` (add `agentSteps` + expose it from `createStore`)
- Modify: `server.js` (add the `/api/savings` job route)
- Test: `store.test.js` (agentSteps) + manual smoke

**Interfaces:**
- Consumes: `analyze`, `sampleSteps` (`savings.js`); `forkStep` (`fork.js`); `makeJudge` (`judge.js`); `keyFor` (`fork.js`); `providerOf` (`translate.js`).
- Produces:
  - `store.agentSteps(workflow, agent) → step[]` — chat steps (with captured request) for that agent across the workflow's retained traces, oldest→newest.
  - `POST /api/savings { workflow, agent?, targets? }` → `{ id }`; `GET /api/savings?id=` → `{ status: 'running'|'done'|'error', findings?, error? }`.

- [ ] **Step 1: Write the failing test (store.agentSteps)**

Append to `store.test.js`:
```js
test('agentSteps returns an agent\'s chat steps with captured requests', () => {
  const store = createStore();
  const req = { system: 's', messages: [{ role: 'user', content: 'q' }], tools: null };
  store.ingest(batch('wf', [chatSpan({ agent: 'writer', model: 'claude-opus-4-8', in: 10, out: 2, extra: [
    { key: 'fleetglass.request', value: { stringValue: JSON.stringify(req) } },
  ] })]));
  const steps = store.agentSteps('wf', 'writer');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].agent, 'writer');
  assert.deepEqual(steps[0].request, req);
});
```
(Use the same `batch`/`chatSpan` helpers Task 3 of Plan 1 established in this file.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test store.test.js`
Expected: FAIL — `store.agentSteps is not a function`.

- [ ] **Step 3: Implement store.agentSteps**

In `store.js`, add inside `createStore` (near `getTrace`):
```js
  function agentSteps(workflow, agent) {
    const out = [];
    for (const t of traces.values()) {
      if (t.wf !== workflow) continue;
      for (const s of t.steps) if (s.kind === 'chat' && s.agent === agent && s.request) out.push(s);
    }
    return out.sort((a, b) => a.ts - b.ts);
  }
```
and add `agentSteps` to the returned object: `return { ingest, snapshot, listTraces, getTrace, agentSteps };`

- [ ] **Step 4: Run to verify store test passes**

Run: `node --test store.test.js`
Expected: PASS (all, incl. new).

- [ ] **Step 5: Add the /api/savings route**

In `server.js`, add these imports at the top:
```js
import { forkStep, keyFor } from './fork.js';
import { analyze } from './savings.js';
import { makeJudge } from './judge.js';
import { score as scoreFn } from './agreement.js';
import { providerOf } from './translate.js';
```
(Adjust the existing `import { forkStep } from './fork.js'` line to the combined import above — do not double-import.)

Add a module-level job map after `const store = createStore();`:
```js
const savingsJobs = new Map(); // id -> { status, findings, error }
const DEFAULT_TARGETS = [{ model: 'claude-haiku-4-5' }, { model: 'gpt-4o-mini' }, { model: 'gemini-2.5-flash' }];
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'gemini-2.5-flash';
```

Add the route (place it beside the `/api/fork` handler):
```js
  if (req.method === 'POST' && url.pathname === '/api/savings') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let params; try { params = JSON.parse(body); } catch { res.writeHead(400).end('{}'); return; }
      const snap = store.snapshot();
      const wf = snap.workflows.find((w) => w.name === params.workflow);
      if (!wf) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown workflow' })); return; }
      const agentName = params.agent || (wf.agents[0] && wf.agents[0].name); // default: top-spend agent
      const agentRow = wf.agents.find((a) => a.name === agentName);
      if (!agentRow) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown agent' })); return; }
      const steps = store.agentSteps(params.workflow, agentName);
      const targets = (params.targets || DEFAULT_TARGETS).filter((t) => !steps[0] || t.model !== steps[0].model);
      const callsPerMonth = (agentRow.callsPerMin || 0) * 60 * 24 * 30;
      const judgeKey = keyFor(providerOf(JUDGE_MODEL));
      const judge = judgeKey ? makeJudge({ model: JUDGE_MODEL, key: judgeKey }) : null;
      const score = (a, b) => scoreFn(a, b, judge ? { judge } : {});

      const id = Math.random().toString(16).slice(2, 10);
      savingsJobs.set(id, { status: 'running' });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
      analyze({ steps, agent: agentName, targets, callsPerMonth, fork: forkStep, score })
        .then((findings) => savingsJobs.set(id, { status: 'done', agent: agentName, findings }))
        .catch((e) => savingsJobs.set(id, { status: 'error', error: e.message }));
    });
    return;
  }

  if (url.pathname === '/api/savings') { // GET poll
    const job = savingsJobs.get(url.searchParams.get('id'));
    if (!job) { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(job));
    return;
  }
```

- [ ] **Step 6: Smoke test (no keys → job errors cleanly, route works)**

Run: `node server.js` in one shell. Then:
`curl -s -X POST http://localhost:4700/api/savings -H 'content-type: application/json' -d '{"workflow":"nope"}'` → expect HTTP 404 `{"error":"unknown workflow"}`.
The full path needs real traces + keys (deferred to operator). Confirm the server does not crash. Stop the server.

- [ ] **Step 7: Commit**

```bash
git add store.js server.js
git commit -m "feat: /api/savings job endpoint + store.agentSteps"
```

---

### Task 5: Savings Report UI

**Files:**
- Modify: `public/index.html` (a Savings panel in the drill-down + styles)
- Modify: `public/app.js` (trigger + poll + render)
- Test: manual (needs the server; findings need keys)

**Interfaces:**
- Consumes: `POST /api/savings`, `GET /api/savings?id=` (Task 4).

- [ ] **Step 1: Add the panel markup + styles**

In `public/index.html`, add a panel in the drill-down column (near the other `.panel` blocks). Match the existing panel/heading style:
```html
<div class="panel" id="savings-panel">
  <h2>Savings report</h2>
  <button id="savings-run" class="btn">Analyze savings</button>
  <div id="savings-out"></div>
</div>
```
Add styles (near the fork panel styles):
```html
<style>
#savings-panel .btn { background: var(--ok); color: #06231a; border: 0; border-radius: 6px; padding: 7px 13px; font: 500 12.5px "IBM Plex Sans", sans-serif; cursor: pointer; }
.savings-head { font: 13px "IBM Plex Mono", monospace; color: var(--ok); margin: 10px 0; }
.savings-row { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; font: 11.5px "IBM Plex Mono", monospace; padding: 7px 0; border-top: 1px solid var(--line); }
.savings-row .agree { color: var(--ok); } .savings-row .agree.warn { color: var(--money); }
.savings-row .save { color: var(--money); text-align: right; }
.savings-note { font: 11px "IBM Plex Mono", monospace; color: var(--dim); margin-top: 8px; }
</style>
```

- [ ] **Step 2: Wire the trigger + render in app.js**

In `public/app.js`, add near the other panel logic:
```js
$('savings-run').addEventListener('click', async () => {
  const wf = selectedWf;
  const out = $('savings-out');
  out.innerHTML = '<div class="savings-note">Sampling real calls and forking on cheaper models…</div>';
  let job;
  try {
    const { id } = await (await fetch('/api/savings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow: wf }) })).json();
    for (let i = 0; i < 60; i++) {                    // poll up to ~60s
      await new Promise((r) => setTimeout(r, 1000));
      job = await (await fetch('/api/savings?id=' + id)).json();
      if (job.status !== 'running') break;
    }
  } catch (e) { out.innerHTML = `<div class="savings-note">${e.message}</div>`; return; }
  if (!job || job.status === 'error') { out.innerHTML = `<div class="savings-note">${job?.error || 'analysis failed'}</div>`; return; }
  const pass = (job.findings || []).filter((f) => f.pass && f.savingsPerMo > 0);
  const yr = pass.reduce((s, f) => s + f.savingsPerMo, 0) * 12;
  out.innerHTML = `<div class="savings-head">Recoverable ≈ ${money(yr)}/yr · agent ${job.agent}</div>` +
    (job.findings || []).map((f) => {
      const pct = Math.round(f.agreement * 100);
      return `<div class="savings-row"><span>${f.from.replace(/^(claude|gemini)-/, '')} → ${f.to.replace(/^(claude|gemini)-/, '')}${f.fidelity === 'cross-provider' ? ' ~' : ''}</span>` +
        `<span class="agree ${f.pass ? '' : 'warn'}">${pct}%</span>` +
        `<span class="save">${money(f.savingsPerMo)}/mo</span></div>`;
    }).join('') +
    `<div class="savings-note">~ = cross-provider (tools dropped). Agreement measured on ${(job.findings?.[0]?.samples) || 0} sampled calls. Advisory — nothing changed in your system.</div>`;
});
```

- [ ] **Step 3: Verify wiring (no-key)**

Run: `node server.js`; open http://localhost:4700, drill into a workflow, click "Analyze savings". With no captured traces/keys it shows a clean note (no crash). Confirm via `node --check public/app.js` and a `preview` screenshot of the panel rendering.

- [ ] **Step 4: Manual live check (deferred to operator)**

With captured traces (`captureRequests: true`) and provider keys set, click "Analyze savings" → a recoverable $/yr headline and per-target rows with real agreement % and $/mo.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: Savings Report panel (analyze → findings)"
```

---

## Self-Review

**Spec coverage (engine + report slice of the M1 spec):**
- Agreement metric, auto structural + LLM-judge, pass bar default 0.95 → Tasks 1–2. ✅
- Sampling N=8 → `sampleSteps` Task 3. ✅
- Downgrade engine, finding shape, `savingsPerMo` = per-call delta × monthly volume → Task 3. ✅
- Cross-provider `fidelity` flag → Task 3 + surfaced in UI Task 5. ✅
- `/api/savings` on-demand job (POST → id, GET → status/findings) → Task 4. ✅
- Report view: recoverable $/yr headline + opportunity table → Task 5. ✅
- Advisory only (no auto-apply) → no mutation anywhere; UI note states it. ✅
- Cost transparency / judge configurable → `JUDGE_MODEL` env; findings carry `samples`. ✅
- **Not in this plan (Plan 1, already shipped):** capture, translate, faithful fork.

**Placeholder scan:** none — every code step is complete; the two manual steps (4.6 smoke, 5.4 live) are explicit and keys-gated.

**Type consistency:** `score(original, fork, {judge})` signature identical in Task 1 def, Task 4 use; `analyze({steps, agent, targets, callsPerMonth, fork, score, passBar})` identical Task 3 def / Task 4 call; finding fields (`agent, from, to, provider, agreement, costOld, costNew, savingsPerMo, fidelity, pass, samples`) identical Task 3 → Task 5 render; `makeJudge({model, key, call})` identical Task 2 / Task 4; `store.agentSteps(workflow, agent)` identical Task 4 def / route use; `forkStep(step, target)` matches Plan 1's shipped signature.
