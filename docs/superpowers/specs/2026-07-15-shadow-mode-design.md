# Shadow-Mode (v1) — Design

**Date:** 2026-07-15
**Status:** Approved (design), pending implementation plan
**Program:** third "act"-adjacent feature, after the kill-switch and auto-routing.
Auto-routing v1 flips an agent to a cheaper model on *offline* evidence (an
8-sample judge score from recorded calls, run once). Its honest limitation: live
traffic can drift from that sample after the flip. Shadow-mode is the continuous
evidence engine that keeps a candidate honest — and, because its forking runs
server-side with the control plane's keys, it gathers **cross-provider** live
equivalence evidence, which is what later unlocks cross-provider routing.

## Goal

A human clicks **Shadow** on a downgrade finding → the control plane continuously
re-verifies that `(agent → candidate)` pairing against the freshest live traffic,
maintaining a rolling agreement + status (validating / passing / drifting). A
drifting pairing raises an alert; if it is also an active route, that is the
"unroute this" signal.

## Decisions (settled in brainstorming)

1. **Evidence: periodically re-run the existing offline `analyze` on fresh
   recorded traffic.** For each armed pairing, a background interval re-runs
   `analyze` (single target = the candidate) on the agent's most recent captured
   calls and folds the resulting agreement into a rolling stat. The store's
   retained traffic (~10-min window) *is* the recent live traffic, so this is
   live-fresh — and it reuses `analyze` / `forkStep` / the judge verbatim, with
   **no ingest-path change**. Not an inline/real-time per-call mirror (much more
   machinery for marginally fresher evidence).
2. **Arming: an explicit Shadow button on any downgrade finding.** Independent of
   routing, so it can (a) validate a candidate *before* routing and (b) watch a
   **cross-provider** candidate (forking is server-side with the control plane's
   keys) even though *routing* is same-provider-only. If the shadowed pairing is
   also an active route, a drift alarm is the "route going bad" signal.
3. **Drift = alarm, not auto-action.** A drifting pairing raises an alert; the
   human unroutes via the existing Route toggle. Auto-unroute-on-drift stays
   deferred (opt-in), consistent with every prior act-feature keeping the human on
   the trigger.

## Components

### 1. `shadow.js` (new, pure) — the rolling engine

The only non-trivial logic. Pure, unit-tested, imports nothing.

```
updateShadow(state, sample, { alpha = 0.4 }) -> state'
shadowStatus(state, { bar = 0.95, minRuns = 3 }) -> 'validating' | 'passing' | 'drifting'
```
- `state` is `{ agreement, runs, samples }` (or `null`/`undefined` on first run).
  `sample` is `{ agreement: number, samples: number }` from one `analyze` pass
  (mean agreement over the calls it scored, and how many it scored).
- `agreement'` = EWMA: `runs === 0 ? sample.agreement : alpha*sample.agreement + (1-alpha)*agreement`.
  Smooths per-run noise so one unlucky pass doesn't flip the status.
- `runs' = runs + 1`; `samples' = samples + sample.samples`.
- `shadowStatus`: `runs < minRuns → 'validating'`; else `agreement >= bar →
  'passing'`; else `'drifting'`. `drifting` is the alarm condition.

`shadow.js` is **purely numeric and time-free** (no `Date.now`) so it is fully
deterministic to test — timestamps (`since`, `lastRun`) are stamped by the store.
Constants (`bar = 0.95` matches `savings.passBar`; `alpha`, `minRuns`) are the
field-tuning knobs — `ponytail:` per-agent tuning if smoothing over/under-reacts.

### 2. `store.js` — shadow set (durable, no TTL)

An in-memory `Map<"workflow/agent", { model, state }>`:
- `shadow(workflow, agent, model)` — arm the pairing (fresh `state`); a falsy
  `model` **stops** it (delete). Overwriting the candidate resets the state.
- `shadows()` — return the armed pairings + state as a plain array
  `[{ workflow, agent, model, agreement, runs, samples, status, since, lastRun }]`
  (status via `shadowStatus`), for the snapshot and the loop.
- `recordShadow(workflow, agent, sample, now = Date.now())` — fold one `analyze`
  result through `updateShadow` into the pairing's state and stamp `since` (first
  record) + `lastRun` (each record); no-op if the pairing was stopped.

The store stays **pure** — it holds state and calls the pure `shadow.js`, never an
LLM. Separate state from `snapshot()`; `snapshot()` gains a `shadows` field and
folds `drifting` pairings into `alerts`.

### 3. `server.js` — arm endpoint + background loop

- **`POST /api/shadow { workflow, agent, model }`** — validate non-object/missing
  body (guard from commit `49839b0`); `workflow` + `agent` required non-empty
  strings; `model` optional (absent/empty stops the pairing). Call
  `store.shadow(...)`, respond `{ ok: true }`.
- **Background loop** — a `setInterval` (like the existing SSE broadcaster) every
  `SHADOW_INTERVAL_MS` (default 5 min). For each `store.shadows()` pairing: take
  the agent's captured steps (`store.agentSteps(workflow, agent)`); **skip** if
  there are none or no provider key for the candidate; else run
  `analyze({ steps, agent, targets: [{ model }], callsPerMonth: 0, fork: forkStep, score })`
  and, from `findings[0]`, call
  `store.recordShadow(workflow, agent, { agreement, samples })`. Reuses the exact
  `judge`/`score`/`forkStep` wiring the `/api/savings` route already builds.
  `ponytail:` the loop re-samples the retained window each run rather than tracking
  a per-pairing watermark — an idle agent re-scores the same calls (stable
  agreement, no false drift), at the cost of repeat forks; add a watermark if that
  cost bites.

### 4. `public/app.js` — Shadow button + panel

- A **Shadow** button on every downgrade finding (any `fidelity` — server-side
  forking handles cross-provider). Delegated listener + numeric `data-i` index
  (same XSS-safe pattern as the Route button — `esc()` doesn't escape quotes).
  Toggles: `POST /api/shadow { workflow, agent, model }` to start, empty `model`
  to stop; button reflects local state ("Shadowing" / "Shadow").
- A small **Shadow** panel (Savings tab) listing armed pairings from the snapshot's
  `shadows`: `agent → candidate`, rolling agreement %, a status chip
  (validating / passing / drifting), sample count, last-run age. A `drifting` row
  renders red. Panel copy states shadow-mode spends continuously.

## The one new property — ongoing cost

Unlike every prior feature, shadow-mode spends real money continuously: each
pairing's run is ~8 forks + 8 judge calls, every interval. Controls: the interval
is the cost knob (default 5 min); a run is **skipped when there's no captured
traffic or no provider key**; the panel surfaces last-run + samples so it is never
a silent drain. Stated plainly in the panel copy.

## Data flow

```
Shadow click → POST /api/shadow → store shadow set (durable)
loop every N min, per pairing:
  agentSteps → analyze([candidate]) → { agreement, samples }
  → store.recordShadow → updateShadow (EWMA) → status
  → snapshot.shadows + (drifting → alerts) → dashboard panel
```

## Error handling

- **A failing fork/judge inside `analyze`** already drops that sample (existing
  behavior) and never throws out of the pass; a pairing with zero scorable calls
  simply records nothing that run.
- **Loop isolation** — the shadow pass is wrapped so one pairing's error (or a
  provider outage) never breaks the interval or the server; it just skips that
  pairing until next run.
- **`POST /api/shadow` bad body** — guarded, `400`, no crash.
- Shadow spend is real but bounded (interval + skip-when-idle); it never touches
  the agent's own calls (server-side only), so it cannot affect production latency.

## Testing

- **`shadow.js`** (`shadow.test.js`): first sample seeds `agreement`; EWMA
  smooths a noisy second sample; status is `validating` below `minRuns`, `passing`
  when the smoothed agreement holds `≥ bar`, `drifting` when it crosses below after
  `minRuns`, and recovers to `passing` when it climbs back.
- **Store** (`store.test.js`): `shadow` arms; `shadows()` returns the pairing with
  derived status; `recordShadow` advances the state; an empty `model` stops it;
  `recordShadow` on a stopped pairing is a no-op.
- **Server** (integration, per route convention — no route unit test): `POST
  /api/shadow` arms a pairing and it appears in `/api/snapshot`'s `shadows`; a
  malformed body → `400`. (The loop's `analyze` reuse is already covered by
  `savings.test.js`; the loop is thin glue verified in integration.)
- **Client/UI**: `node --check`; Shadow button + panel verified in the preview.

## Non-goals (deferred)

- **Auto-unroute-on-drift** — an opt-in autonomous action; v1 alarms only.
- **Inline / real-time shadowing** — decided against; we re-analyze fresh recorded
  traffic.
- **Per-pairing traffic watermark** — v1 re-samples the retained window each run.
- **Historical drift charts** — v1 shows current rolling agreement + status only.
- **Shadow persistence across restart** — in-memory, like routes.
- **Cross-provider routing itself** — shadow-mode builds the evidence for it; the
  multi-key routing client is a separate increment.

## Dependencies added

None. Reuses `savings.analyze`, `forkStep`, the judge, the store, and the existing
`setInterval` pattern; adds one pure module (`shadow.js`).
