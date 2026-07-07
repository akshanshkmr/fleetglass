# Savings M4 — Prompt-Change Regression — Design

**Date:** 2026-07-07
**Status:** Approved (design), pending implementation plan
**Program:** [savings-platform-roadmap](../plans/2026-07-07-savings-platform-roadmap.md) · milestone M4
**Depends on:** the faithful-fork substrate (M1) + the agreement metric (M1 Plan 2 + refinement).

## Goal

Before shipping a system-prompt change, re-run it against a golden set of the agent's *real* calls and
report the **blast radius**: how many outputs materially changed, by how much, and the cost/length
drift — so a human reviews the changed cases before shipping.

## Principle (honest framing)

A prompt change is often *meant* to change output, so agreement-vs-baseline is not "worse," it is
"how much did this alter your real outputs, and at what cost." The tool is **advisory and
human-reviewed** — it surfaces the changed cases and the cost/length drift, it does **not** emit a
binary ship/block verdict pretending to know quality.

## Locked decisions

1. **Change = a new system prompt** — swap `request.system` on each golden step and re-run on the
   **same model**. (Model-swap regression is M1's downgrade engine, out of scope.)
2. **User-triggered** — paste the proposed prompt, run now against a freshly-sampled golden set.
   (Nightly drift canary needs a scheduler + golden-set persistence — deferred.)

## Reuse — no substrate change

Reuses `forkStep` unchanged: fork a synthetic step `{ ...step, request: { ...step.request, system:
newSystem } }` on `{ model: step.model }`. `step.completion` is the recorded baseline (current prompt);
`fork.completion` is the new-prompt output. `score(baseline, new)` is the agreement. Reuses
`sampleSteps`, `projectCallsPerMonth`, `agreement.score`, `store.agentSteps`, and the job/report pattern.

## Components

### 1. `regression.js` (pure)
`analyzeRegression({ steps, agent, newSystem, callsPerMonth, fork, score, passBar = 0.95 }) → result`.
For each sampled step: `r = await fork({ ...step, request: { ...step.request, system: newSystem } },
{ model: step.model })`; `a = (await score(r.original.completion, r.fork.completion)).score`;
collect. Result:
```
{ agent, samples, meanAgreement,
  changed,            // count of rows with agreement < passBar
  costOld, costNew, costDeltaPct,     // (costNew-costOld)/costOld
  lengthDeltaPct,     // mean output-length change, (newLen-oldLen)/oldLen
  rows: [{ agreement, baseline, updated }] }   // per-trace, for review
```
`fork` and `score` injected. A thrown fork is skipped (drops that sample). Steps must carry a captured
`request` (via `sampleSteps`, which filters on `request.messages`).

### 2. Server — `/api/regression`
`POST /api/regression { workflow, agent?, newSystem }` → `{ id }`; `GET /api/regression?id=` →
`{ status, agent?, result?, error? }`. Mirrors `/api/savings`: resolves the top-spend agent by
default, `store.agentSteps`, `projectCallsPerMonth`, judge-gated `score`, runs `analyzeRegression` with
the real `forkStep`. `newSystem` comes from the request body (the pasted prompt); reject with 400 if
absent/empty. Async job map.

### 3. UI — "Prompt regression" panel
A drill-down panel with a **`<textarea id="regression-input">`** (paste the proposed system prompt), a
**Run** button, and an output area. On Run: POST `{ workflow, newSystem }`, poll, then render:
- a **blast-radius line**: `"3 of 8 outputs changed · cost +4% · length −12% · agent extractor"`.
- per-trace **rows**: `agreement %` + a truncated `baseline → updated` snippet, each opening replay.
- an empty-state message when there are no captured requests (mirrors the savings/context panels).
Advisory only — nothing ships automatically.

## Data flow

`captured steps → sample → fork(system-swapped step, same model) → score(baseline vs new) →
blast-radius aggregate → verdict panel → replay`

## Testing

`regression.test.js` (pure, injected fork/score):
- identical baseline/new completions → `meanAgreement` 1, `changed` 0, `costDeltaPct`/`lengthDeltaPct` 0.
- differing completions (agreement below bar) → `changed` counts them; `costDeltaPct` and
  `lengthDeltaPct` computed from the fork costs / completion lengths.
- empty sample → `samples` 0, empty `rows` (no run).
Server `/api/regression`: no-key / unknown-workflow smoke → 404; missing `newSystem` → 400; no crash.
UI: `node --check` + a preview render of the panel (findings need keys — deferred to operator).

## Non-goals (v1)

Nightly drift canary (scheduler + golden-set persistence); model-swap regression (M1); tool-call-rate
and refusal-rate drift (need richer capture than text completions); auto ship/block; multi-prompt A/B.

## Dependencies added

None. Reuses `forkStep`, `agreement.score`, `savings.sampleSteps`/`projectCallsPerMonth`, `translate`,
`store.agentSteps`.
