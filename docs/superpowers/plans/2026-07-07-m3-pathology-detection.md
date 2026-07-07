# Savings M3 — Structural Pathology Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect runaway agent shapes (cyclic handoffs, retry storms, context spirals) from the traces FleetGlass already collects, surface them on the dashboard, and link each straight into replay.

**Architecture:** A pure `pathology.js` runs shape-analysis over one active task's ordered steps. `store.js` `snapshot()` runs it over active traces and emits a `pathologies[]` array plus `pathology` flags on affected agents/edges. The dashboard renders a red pathology card whose Replay button jumps the existing replay overlay to the offending step. Read-only — no execution.

**Tech Stack:** Node ≥20 (ESM, `node:test`). Zero deps. Pure functions over existing in-memory data.

## Global Constraints

- **Read-only:** detection + alert + graph highlight only. No killing, retries, timeouts, or state changes.
- **Per-task, active traces only:** a trace is active if its latest step `ts` is within `ACTIVE_MS` (120000 ms).
- **Thresholds are named constants** at the top of `pathology.js`, each with a `// ponytail:` note — hand-tuned calibration knobs.
- **At most one finding per `kind` per trace.**
- Finding shape: `{ kind, agents, detail, cost, since, step }` (`step` = step index to jump replay to); store enriches to `{ workflow, trace, kind, agents, detail, cost, since, step }`.
- Zero new deps. Work directly on `main` (do NOT branch). Commit per task.

---

### Task 1: `pathology.js` — the three detectors

**Files:**
- Create: `pathology.js`
- Test: `pathology.test.js`

**Interfaces:**
- Produces: `detectPathologies(trace, now = Date.now()) → finding[]` where `trace = { start, wf, steps[] }`, steps ordered by `ts` with chat steps `{ ts, agent, kind:'chat', in, cost }` and tool steps `{ ts, agent, kind:'tool' }`. Finding = `{ kind:'cycle'|'retry'|'spiral', agents, detail, cost, since, step }`.

- [ ] **Step 1: Write the failing test**

`pathology.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPathologies } from './pathology.js';

const NOW = 1_000_000_000_000;
const chat = (agent, i, inTok = 100) => ({ ts: NOW - (20 - i) * 1000, agent, kind: 'chat', in: inTok, cost: 0.01 });
const trace = (steps) => ({ start: steps[0].ts, wf: 'wf', steps });

test('ping-pong A,B,A,B,A,B,A,B → one cycle finding naming A and B', () => {
  const steps = ['A','B','A','B','A','B','A','B'].map((a, i) => chat(a, i));
  const f = detectPathologies(trace(steps), NOW);
  const cyc = f.find((x) => x.kind === 'cycle');
  assert.ok(cyc, 'cycle detected');
  assert.deepEqual(cyc.agents.sort(), ['A', 'B']);
});

test('A×8 consecutive → one retry finding for A', () => {
  const steps = [...Array(8)].map((_, i) => chat('A', i));
  const f = detectPathologies(trace(steps), NOW);
  const r = f.find((x) => x.kind === 'retry');
  assert.ok(r);
  assert.deepEqual(r.agents, ['A']);
  assert.equal(f.some((x) => x.kind === 'cycle'), false, 'no false cycle for a single agent');
});

test('input tokens 5K,9K,18K,30K,48K → one spiral finding', () => {
  const ins = [5000, 9000, 18000, 30000, 48000];
  const steps = ins.map((n, i) => chat('A', i, n));
  const f = detectPathologies(trace(steps), NOW);
  assert.ok(f.find((x) => x.kind === 'spiral'));
});

test('linear A→B→C→D → no findings (false-positive guard)', () => {
  const steps = ['A','B','C','D'].map((a, i) => chat(a, i));
  assert.deepEqual(detectPathologies(trace(steps), NOW), []);
});

test('inactive trace (last step older than ACTIVE_MS) → no findings', () => {
  const steps = ['A','B','A','B','A','B','A','B'].map((a, i) => ({ ...chat(a, i), ts: NOW - 300000 }));
  assert.deepEqual(detectPathologies(trace(steps), NOW), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test pathology.test.js`
Expected: FAIL — `Cannot find module './pathology.js'`.

- [ ] **Step 3: Implement**

`pathology.js`:
```js
// pathology.js — detect runaway agent shapes from one task's trace, read-only.
// Pure: given a trace's ordered steps, return findings. Thresholds are the
// calibration knobs a minimal model can't infer — tune in the field.
// ponytail: threshold heuristics; per-model tuning if false positives bite.

const ACTIVE_MS = 120000;          // only scan tasks whose last step is this recent
const CYCLE_MAX_AGENTS = 3;        // ping-pong / triangle involve few agents
const CYCLE_MIN_HANDOFFS = 6;
const CYCLE_REPEAT = 3;            // the cycle n-gram must repeat this many times at the tail
const RETRY_MIN = 6;               // consecutive same-agent chat steps
const RETRY_WINDOW_MS = 120000;
const SPIRAL_MIN_STEPS = 5;
const SPIRAL_GROWTH_RATIO = 2.0;   // latest input >= 2x the earliest
const SPIRAL_FLOOR_TOK = 15000;    // ignore small growth

const fmtK = (n) => (n / 1000).toFixed(1) + 'K';
const sumCost = (steps) => steps.reduce((c, s) => c + (s.cost || 0), 0);

function tailRepeats(runs, period) {
  if (runs.length < period) return 0;
  const gram = runs.slice(-period);
  let reps = 0;
  for (let end = runs.length; end - period >= 0; end -= period) {
    const chunk = runs.slice(end - period, end);
    if (chunk.every((x, i) => x === gram[i])) reps++;
    else break;
  }
  return reps;
}

function detectCycle(steps) {
  const runs = [];
  const runStartStep = [];
  let prev = null;
  steps.forEach((s, i) => { if (s.agent !== prev) { runs.push(s.agent); runStartStep.push(i); prev = s.agent; } });
  const handoffs = runs.length - 1;
  if (new Set(runs).size > CYCLE_MAX_AGENTS || handoffs < CYCLE_MIN_HANDOFFS) return null;
  const period = [2, 3].find((p) => tailRepeats(runs, p) >= CYCLE_REPEAT);
  if (!period) return null;
  const tailStartRun = runs.length - period * tailRepeats(runs, period);
  const step = runStartStep[tailStartRun];
  const agents = [...new Set(runs.slice(tailStartRun))];
  return { kind: 'cycle', agents, detail: `${agents.join(' ⇄ ')} · ${handoffs} handoffs`, cost: sumCost(steps.slice(step)), since: steps[step].ts, step };
}

function detectRetry(steps) {
  let best = null;
  let i = 0;
  while (i < steps.length) {
    if (steps[i].kind !== 'chat') { i++; continue; }
    let j = i;
    while (j + 1 < steps.length && steps[j + 1].kind === 'chat' && steps[j + 1].agent === steps[i].agent) j++;
    const len = j - i + 1;
    const span = steps[j].ts - steps[i].ts;
    if (len >= RETRY_MIN && span <= RETRY_WINDOW_MS && (!best || len > best.len)) best = { i, j, len, span };
    i = j + 1;
  }
  if (!best) return null;
  const agent = steps[best.i].agent;
  return { kind: 'retry', agents: [agent], detail: `${agent} · ${best.len} calls in ${Math.round(best.span / 1000)}s`, cost: sumCost(steps.slice(best.i, best.j + 1)), since: steps[best.i].ts, step: best.i };
}

function detectSpiral(steps) {
  const chat = steps.filter((s) => s.kind === 'chat');
  if (chat.length < SPIRAL_MIN_STEPS) return null;
  const tail = chat.slice(-SPIRAL_MIN_STEPS);
  const ins = tail.map((s) => s.in || 0);
  const nondec = ins.every((v, i) => i === 0 || v >= ins[i - 1]);
  const earliest = ins[0], latest = ins[ins.length - 1];
  if (!(nondec && latest >= SPIRAL_GROWTH_RATIO * earliest && latest > SPIRAL_FLOOR_TOK)) return null;
  const last = tail[tail.length - 1];
  return { kind: 'spiral', agents: [last.agent], detail: `${fmtK(earliest)} → ${fmtK(latest)} tok over ${chat.length} steps`, cost: last.cost || 0, since: tail[0].ts, step: steps.indexOf(last) };
}

export function detectPathologies(trace, now = Date.now()) {
  const steps = trace.steps || [];
  if (!steps.length || now - steps[steps.length - 1].ts > ACTIVE_MS) return [];
  return [detectCycle(steps), detectRetry(steps), detectSpiral(steps)].filter(Boolean);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test pathology.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add pathology.js pathology.test.js
git commit -m "feat: pathology detectors (cyclic handoffs, retry storm, context spiral)"
```

---

### Task 2: `store.js` integration — `pathologies[]` + flags

**Files:**
- Modify: `store.js` (`import` + `snapshot` body)
- Test: `store.test.js`

**Interfaces:**
- Consumes: `detectPathologies(trace, now)` (Task 1).
- Produces: `snapshot()` returns a new top-level `pathologies: [{ workflow, trace, kind, agents, detail, cost, since, step }]`; each agent row gains `pathology: boolean`; each edge gains `pathology: boolean`; `totals.pathologies` is the count.

- [ ] **Step 1: Write the failing test**

Append to `store.test.js` (reuse the `batch`/`chatSpan` helpers already in the file; a chat span needs `traceId`, agent, model, tokens — set the same `traceId` on 8 alternating-agent spans to build a ping-pong trace):
```js
test('snapshot flags a ping-pong trace as a cycle pathology', () => {
  const store = createStore();
  const spans = [];
  for (let i = 0; i < 8; i++) {
    spans.push(chatSpan({ agent: i % 2 ? 'critic' : 'researcher', model: 'claude-opus-4-8', in: 100, out: 10, trace: 'tRACE1', span: 's' + i, parent: i ? 's' + (i - 1) : undefined }));
  }
  store.ingest(batch('wf', spans));
  const snap = store.snapshot();
  const cyc = snap.pathologies.find((p) => p.kind === 'cycle');
  assert.ok(cyc, 'cycle pathology present');
  assert.equal(cyc.workflow, 'wf');
  assert.deepEqual(cyc.agents.sort(), ['critic', 'researcher']);
  assert.ok(snap.workflows[0].agents.find((a) => a.name === 'researcher').pathology, 'agent flagged');
});
```
NOTE: `chatSpan` must accept `trace`/`span`/`parent` so all 8 spans share one `traceId`. If the existing helper hard-codes a single traceId, extend its signature (default to the current behavior) so pre-existing tests are unaffected — the same backward-compatible pattern used when `extra` was added. Also: the spans' `startTimeUnixNano` must be **recent** (within `ACTIVE_MS` = 120s of `Date.now()`, and strictly increasing so the trace reads A,B,A,B…) — otherwise the trace is "inactive" and correctly yields no pathology. If `chatSpan` already stamps `Date.now()`, that satisfies recency; ensure the 8 spans get increasing timestamps.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test store.test.js`
Expected: FAIL — `snap.pathologies` is undefined.

- [ ] **Step 3: Add the import**

At the top of `store.js`, add:
```js
import { detectPathologies } from './pathology.js';
```

- [ ] **Step 4: Compute pathologies + flags in `snapshot`**

In `store.js` `snapshot(now)`, after `const recentCut = now - RECENT_MS;` (before the `wfStats` loop), add:
```js
    const pathologies = [];
    const pathoAgents = new Map(); // wf -> Set(agent)
    for (const [id, t] of traces) {
      for (const f of detectPathologies(t, now)) {
        pathologies.push({ workflow: t.wf, trace: id, ...f });
        let set = pathoAgents.get(t.wf);
        if (!set) { set = new Set(); pathoAgents.set(t.wf, set); }
        for (const ag of f.agents) set.add(ag);
      }
    }
```
In the `agents.push({ ... })` object, add a field:
```js
          pathology: pathoAgents.get(wf)?.has(name) || false,
```
Replace the `edges` mapping to flag cross-pathology edges:
```js
      const pset = pathoAgents.get(wf);
      const edges = [...edgeCount].map(([k, n]) => {
        const [from, to] = k.split(' ');
        return { from, to, rpm: n, pathology: !!(pset && pset.has(from) && pset.has(to)) };
      });
```
In `workflows.push({ ... })`, add:
```js
        pathologies: pathologies.filter((p) => p.workflow === wf).length,
```
In the final `return { ... }`, add `pathologies` at top level and the count in `totals`:
```js
    return {
      now,
      totals: {
        spend: sum((w) => w.spend),
        callsPerMin: sum((w) => w.callsPerMin),
        tasksPerMin: sum((w) => w.tasksPerMin),
        workflows: workflows.length,
        agents: sum((w) => w.agents.filter((a) => a.live).length),
        alerts: alerts.length,
        pathologies: pathologies.length,
      },
      workflows,
      alerts,
      pathologies,
    };
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test store.test.js`
Expected: PASS — all prior store tests plus the new one.

- [ ] **Step 6: Commit**

```bash
git add store.js store.test.js
git commit -m "feat(store): emit pathologies[] + agent/edge pathology flags"
```

---

### Task 3: UI — pathology card, graph highlight, replay-to-step

**Files:**
- Modify: `public/index.html` (card markup + styles)
- Modify: `public/app.js` (`renderPathologies`, `openReplay` step arg, graph flag, call in `renderAll`)
- Test: manual (`node --check` + preview)

**Interfaces:**
- Consumes: `snap.pathologies`, per-agent/edge `pathology` flag (Task 2); `openReplay(id)`, `renderAll`, `selectedWf`, `money(n)` (existing).

- [ ] **Step 1: Add the card markup + styles**

In `public/index.html`, add a panel above or beside the anomalies panel (the one holding `<div id="alerts">`):
```html
<div class="panel" id="pathology-panel" hidden>
  <h2>Structural pathology</h2>
  <div id="pathologies"></div>
</div>
```
Add styles near the `.alert` styles:
```html
<style>
.patho { display: flex; align-items: baseline; gap: 10px; border-left: 2px solid var(--signal); padding: 6px 10px; margin-bottom: 8px; font-size: 12.5px; background: rgba(255,92,71,.06); }
.patho .k { font: 10px "IBM Plex Mono", monospace; letter-spacing: .1em; text-transform: uppercase; color: var(--signal); }
.patho .d { flex: 1; }
.patho .c { font-family: "IBM Plex Mono", monospace; color: var(--money); }
.patho button { font: 11.5px "IBM Plex Sans", sans-serif; border-radius: 5px; padding: 4px 10px; border: 1px solid var(--line2); background: transparent; color: var(--text); cursor: pointer; }
.patho button.kill { opacity: .4; cursor: not-allowed; }
.gnode.patho rect { stroke: var(--signal); stroke-width: 1.5; }
.gedge.patho { stroke: var(--signal); }
</style>
```

- [ ] **Step 2: `openReplay` accepts an optional step index**

In `public/app.js`, change `openReplay` to jump to a step:
```js
async function openReplay(id, stepIdx = 0) {
  const res = await fetch('/api/trace?id=' + id);
  if (!res.ok) return;
  const trace = await res.json();
  replay = { trace, idx: Math.max(0, Math.min(stepIdx, trace.steps.length - 1)) };
  $('replay').hidden = false;
  $('replay-scrub').max = replay.trace.steps.length - 1;
  renderReplay();
  $('replay-close').focus();
}
```

- [ ] **Step 3: Add `renderPathologies` and call it**

In `public/app.js`, add the renderer:
```js
function renderPathologies(wf) {
  const panel = $('pathology-panel');
  const box = $('pathologies');
  const mine = (snap.pathologies || []).filter((p) => p.workflow === wf.name);
  panel.hidden = !mine.length;
  box.textContent = '';
  const label = { cycle: 'loop', retry: 'retry storm', spiral: 'context spiral' };
  for (const p of mine) {
    const div = document.createElement('div');
    div.className = 'patho';
    div.innerHTML = `<span class="k">${label[p.kind] || p.kind}</span><span class="d">${p.detail}</span><span class="c">${money(p.cost)} burned</span>`;
    const replay = document.createElement('button');
    replay.textContent = 'Replay';
    replay.addEventListener('click', () => openReplay(p.trace, p.step));
    const kill = document.createElement('button');
    kill.className = 'kill';
    kill.textContent = 'Kill';
    kill.disabled = true;
    kill.title = 'needs in-path client (Phase C)';
    div.append(replay, kill);
    box.appendChild(div);
  }
}
```
In `renderAll()`, add a call alongside the other per-workflow renders (e.g. after `renderAlerts()`):
```js
  renderPathologies(wf);
```

- [ ] **Step 4: Flag pathology nodes/edges in the graph**

In `public/app.js` `renderGraph`, in the per-node update loop that sets `g.classList.toggle('hot', a.alert)`, add:
```js
    g.classList.toggle('patho', !!a.pathology);
```
And where edges are updated (the `edgePaths`/label loop), toggle the edge class using the snapshot edge's `pathology`:
```js
    if (label) label.textContent = ep.rpm + '/min';
    const edgeObj = wf.edges.find((x) => x.from + '>' + x.to === ep.edge);
    ep.el.classList.toggle('patho', !!(edgeObj && edgeObj.pathology));
```

- [ ] **Step 5: Verify**

Run: `node --check public/app.js`.
Then start the server, drill into a workflow, and confirm the page loads with no console error. Take a preview screenshot. (A live pathology needs a runaway trace — deferred; the store test proves the data path.)

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: structural pathology card + graph highlight + replay-to-step"
```

---

## Self-Review

**Spec coverage:**
- Three detectors (cycle / retry / spiral), thresholds as named constants, ≤1 per kind, active-only → Task 1. ✅
- Finding shape `{kind, agents, detail, cost, since, step}` → Task 1; enriched `{workflow, trace, ...}` → Task 2. ✅
- store `snapshot` emits `pathologies[]` + agent/edge `pathology` flags → Task 2. ✅
- UI card mirroring the anomaly card; disabled Kill w/ tooltip; Replay → `openReplay(trace, step)`; graph red highlight → Task 3. ✅
- Moat hook: `openReplay` step-jump → Task 3 Step 2 (fork-from-step already lives in the overlay). ✅
- Read-only / no execution → nothing writes state; Kill disabled. ✅

**Placeholder scan:** none — complete code in every step; the two manual UI checks are explicit.

**Type consistency:** `detectPathologies(trace, now)` and finding fields identical Task 1 def / Task 2 use; `pathologies`/`pathology` field names consistent Task 2 → Task 3; `openReplay(id, stepIdx)` new signature used by Task 3 Step 3; graph flag reads `a.pathology`/`edge.pathology` set in Task 2.
