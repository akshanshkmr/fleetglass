# Structural Pathology Detection — Design

**Date:** 2026-07-07
**Status:** Approved (design), pending implementation plan

## Goal

Detect runaway agent behavior — the shapes that burn money silently — from traces FleetGlass
already collects, and surface each detection with a one-click path into the replay/fork substrate.
Read-only v1: alert + graph highlight, no execution.

## Principle (and the line we hold)

FleetGlass **observes and detects; it does not execute.** v1 runs pure shape-analysis over the
in-memory traces we already have — no retries, no timeouts, no state persistence, no killing. That
keeps us on the observability side of the line and out of durable-execution's lane (Temporal et al.):
those engines are *in* the control path and are blind to the semantic/cost dimension (token spiral,
cost burn, semantic ping-pong) that these detectors catch — and they only cover the sliver of agents
actually running on them, whereas FleetGlass sees the shape regardless of orchestrator.

The detection heuristic is not itself the moat (a counter can catch a simple retry loop). The moat is
the **substrate underneath** — replay + fork-from-step + context breakdown. So every detection links
straight into it: "replay this loop," "fork this step on a cheaper model to see if it breaks the
cycle." That is what a control-plane alarm can never do, and it turns a commodity alert into a demo
of the substrate.

Killing a runaway task is explicitly **out of scope for v1** — it means intervening in execution.
It returns in Phase C as a thin, opt-in circuit breaker riding the in-path unified client, never a
workflow runtime.

## Scope: per-task, active traces

Detection runs per **task** (one `traceId`), on **active** traces only — those whose latest step is
within `ACTIVE_MS` (120s). This maps directly to "this task is running away right now," matches the
approved mock, and lines up with the future per-task kill-switch. (Per-workflow aggregate detection is
a possible later addition; not v1.)

## Components

### 1. `pathology.js` (new, pure)

`detectPathologies(trace, now) → findings[]`, where a trace is `{ start, wf, steps[] }` and each
finding is `{ kind, agents, detail, cost, since, step }` (`step` = index to jump replay to).
Steps are the store's replay records, ordered by `ts`: chat steps carry `{ ts, agent, kind:'chat',
in, out, cost, ctx }`; tool steps `{ ts, agent, kind:'tool', ... }`.

Three detectors, each keyed on a distinct shape:

**Cyclic handoffs** (`kind: 'cycle'`) — ping-pong `A⇄B` and longer `A→B→C→A`.
- Take the agent label of each step in ts order; collapse consecutive duplicates into `runs`.
- `handoffs = runs.length - 1`. If distinct agents in `runs` ≤ `CYCLE_MAX_AGENTS` (3) **and**
  `handoffs ≥ CYCLE_MIN_HANDOFFS` (6) **and** `runs` ends in a repeating period (period 2 or 3)
  repeated ≥ `CYCLE_REPEAT` (3) times → fire.
- `agents` = the cycle's agents; `cost` = summed step cost over the cyclic tail; `detail` e.g.
  `"researcher ⇄ critic · 47 handoffs"`; `step` = first step of the cyclic tail.

**Retry storm** (`kind: 'retry'`) — one agent repeating with no handoff.
- Longest run of consecutive **same-agent chat steps** within `RETRY_WINDOW_MS` (120s). If length
  ≥ `RETRY_MIN` (6) → fire. `detail` e.g. `"extractor · 8 calls in 47s"`; `cost` = run cost;
  `step` = run start. ("No progress" is proxied structurally by the consecutive count — output-
  similarity is a v2 refinement, too heavy for v1.)

**Context spiral** (`kind: 'spiral'`) — input tokens growing unbounded.
- Over the last `SPIRAL_MIN_STEPS` (5) chat steps, if `in` is non-decreasing, the latest `in`
  ≥ `SPIRAL_GROWTH_RATIO` (2.0) × the earliest, and latest `in` > `SPIRAL_FLOOR_TOK` (15000) →
  fire. `detail` e.g. `"6.4K → 48K tok over 9 steps"`; `cost` = latest step cost; `step` = latest.

At most one finding per `kind` per trace (report the strongest). All thresholds are named constants
at the top of the file, each with a `// ponytail:` note — they are heuristics that need field
tuning, and are the calibration knobs a minimal model can't infer.

### 2. `store.js` integration

In `snapshot(now)`, after the anomaly pass: iterate `traces`; for each **active** trace run
`detectPathologies(trace, now)`; collect enriched findings into a new top-level
`pathologies: [{ workflow, trace, kind, agents, detail, cost, since, step }]`. Set a `pathology`
flag on each affected agent (and, for `cycle`, on the affected edges) so the graph can highlight
them — parallel to the existing `alert` flag. No other store changes.

### 3. UI (`public/app.js`, `public/index.html`)

- A **"Structural pathology"** card (red, mirroring the anomaly-alert card), shown when the selected
  workflow has active pathologies. One row per finding: an icon by kind, the `detail` + agents +
  `cost` burned, a **`Replay` button**, and a **disabled `Kill` button** with tooltip
  `"needs in-path client (Phase C)"`.
- **Moat hook:** `Replay` calls the existing `openReplay(trace)` extended to accept an optional step
  index, jumping the overlay to the offending `step`. Fork-from-step already lives on chat steps in
  that overlay — so "detected → replay → fork" is complete with only the jump-to-step addition.
- Topology graph: agents/edges carrying the `pathology` flag render red, reusing the existing
  `hot`/alert styling.

## Data flow

`spans → store (live-growing trace) → snapshot() every 1.5s → detectPathologies(active traces)
→ pathologies[] + pathology flags → SSE → dashboard card + red graph highlight → Replay → fork`

## Testing

`pathology.test.js` (pure, synthetic traces, `node --test`):
- ping-pong `A,B,A,B,A,B,A,B` → one `cycle` finding naming `A`,`B`.
- `A×8` consecutive → one `retry` finding for `A`.
- input tokens `5K,9K,18K,30K,48K` → one `spiral` finding.
- linear `A→B→C→D` → **no findings** (false-positive guard).
- inactive trace (old `ts`) → no findings.

Plus one store integration test: ingest a workflow whose trace ping-pongs → `snapshot().pathologies`
is non-empty with the right `workflow`/`kind`.

## Non-goals (v1)

- **Killing / any execution intervention** — Phase C, opt-in circuit breaker on the unified client.
- Output-similarity-based "no progress" — structural proxies only.
- Cross-task / cross-workflow pattern mining.
- Auto-tuned thresholds — fixed named constants, tuned by hand.

## Dependencies added

None. Pure functions over existing in-memory data; zero new runtime deps.
