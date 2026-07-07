# Savings M2 — Context ROI — Design

**Date:** 2026-07-07
**Status:** Approved (design), pending implementation plan
**Program:** [savings-platform-roadmap](../plans/2026-07-07-savings-platform-roadmap.md) · milestone M2
**Depends on:** the faithful-fork substrate (M1 Plan 1) + the agreement metric (M1 Plan 2, refined by
the [agreement-metric refinement](2026-07-07-agreement-metric-refinement-design.md), which lands first).

## Goal

Show which parts of an agent's context actually earn their tokens. For each ablatable context segment,
re-run the agent's real calls with that segment removed, measure output agreement, and report the
recoverable spend if it's safe to drop — e.g. "dropping the tool schemas on `extractor` → 98%
agreement, −$X/mo." Directly targets context bloat / lost-in-the-middle waste.

## Principle & the honest limit

We can only ablate what the **canonical request** (`{system, messages, tools}`) separates: the **tools
schema**, the **system prompt**, and **history turns**. "Retrieval" is not a separable segment today —
it lives inside `messages`/`system` — so true retrieval-segment ROI is out of scope until the SDK
captures a labeled retrieval field (deferred). We ablate what we have; we do not pretend to ablate
what we can't.

## Reuse — no substrate change

The engine reuses `forkStep` **unchanged**: it constructs a synthetic step carrying the *ablated*
canonical request and the step's **same model**, and forks it — re-running the reduced context on the
same model. Original (full context, the recorded completion + cost) vs ablated (fewer input tokens →
cheaper) gives agreement + cost delta. No change to `fork.js`, `translate.js`, or capture.

## Components

### 1. Ablation transforms — `contextroi.js` (pure)
`ablations(request) → [{ segment, request }]`, each a modified copy, emitted only when the segment is
present and non-trivial:
- `tools` → `{ ...request, tools: undefined }` (only if `request.tools`).
- `system` → `{ ...request, system: '' }` (only if `request.system`).
- `history` → `{ ...request, messages: request.messages.slice(-1) }` — keep only the last turn (only if
  `request.messages.length > 1`).

### 2. Engine — `contextroi.js`
`analyzeContext({ steps, agent, callsPerMonth, fork, score, passBar = 0.95 }) → finding[]`, sorted by
`savingsPerMo` desc. For each ablatable segment, over the sampled steps (reusing `sampleSteps` from
`savings.js`): fork a synthetic step `{ ...step, request: ablatedRequest }` on `{ model: step.model }`,
`score(original.completion, ablated.completion)`, aggregate. Finding:
`{ agent, segment, agreement, costOld, costNew, savingsPerMo, pass, samples }`, where
`pass = agreement >= passBar` means "safe to drop this segment," and
`savingsPerMo = (costOld - costNew) * callsPerMonth`. `fork` and `score` are injected (real ones wired
in the server), so the engine is pure/testable.

### 3. Server — `/api/context-roi`
`POST /api/context-roi { workflow, agent? }` → `{ id }`; `GET /api/context-roi?id=` → `{ status,
findings?/error? }`. Mirrors `/api/savings`: resolves the top-spend agent by default, gets
`store.agentSteps`, computes `callsPerMonth = projectCallsPerMonth(steps)`, runs `analyzeContext` with
the real `forkStep` + the (refined) `score`. Async job map.

### 4. Report UI
A "Context ROI" panel in the drill-down (sibling to the Savings Report), with an "Analyze context"
button → per-segment rows: `drop <segment> → <agreement>% · −$X/mo · <pass|below-bar>`, plus a note
that dropping a below-bar segment would change output. Advisory only — nothing is applied.

## Data flow

`captured steps → sample → for each segment: fork(synthetic ablated step, same model) → agreement
vs original → cost delta × monthly volume → context-ROI finding → panel`

## Testing

- `contextroi.test.js` (pure, injected fork/score):
  - `ablations` emits tools/system/history variants only when present (a request with no tools yields
    no tools ablation; single-message request yields no history ablation).
  - `analyzeContext` on a request whose ablated output matches the original → high agreement, positive
    `savingsPerMo`, `pass: true`; whose ablated output differs → below bar, `pass: false`.
  - segment finding shape + sort-by-savings.
- `store.agentSteps` reuse — no new store test needed.
- Server `/api/context-roi` — no-key/unknown-workflow smoke (404), no crash (mirrors `/api/savings`).
- UI — `node --check` + a preview render of the panel (findings need keys — deferred to operator).

## Non-goals (M2)

Retrieval-segment ablation (needs SDK retrieval labeling — deferred); per-turn history bisection beyond
"keep last turn"; auto-applying any trim (advisory only); combining ablations (each segment scored
independently in v1).

## Dependencies added

None. Reuses `forkStep`, `agreement.score`, `savings.sampleSteps`/`projectCallsPerMonth`, `translate`.
