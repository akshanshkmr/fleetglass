# Savings M5 (part 1) — Cache/Batch Yield — Design

**Date:** 2026-07-08
**Status:** Approved (design), pending implementation plan
**Program:** [savings-platform-roadmap](../plans/2026-07-07-savings-platform-roadmap.md) · milestone M5, **part 1 (yield)**.
Shadow-mode is **part 2**, deferred — it needs the unified client and crosses into the critical path; its own sub-project.

## Goal

Estimate recoverable spend, for free, from two provider levers that need no re-execution:
- **Prompt caching** — the stable system+tools prefix an agent re-sends on every call is cacheable at
  a large discount.
- **Batch API** — latency-tolerant volume runs at ~50% off.

Cache-yield is data-driven and confident; batch-yield is a flat estimate, clearly caveated. Surfaced
**live** in the snapshot — no forking, no keys, no button.

## Why it needs no keys or captured requests

Yield reads the **context breakdown** token counts (`ctx.system`, `ctx.tools`) that the SDK already
emits on every chat step by default — *not* the captured request (which is opt-in) and *not* a fork.
So it works on any SDK-traced workflow, instantly, over data the store already holds.

## Components

### 1. `yield.js` (pure)
`agentYield(steps, inputPrice) → { cacheableTokens, cacheSavingsPerMo, batchSavingsPerMo, spendPerMo } | null`:
- Filter to chat steps; return `null` if none.
- `cacheableTokens` = round(mean over chat steps of `(ctx.system || 0) + (ctx.tools || 0)`) — the stable, cacheable prefix.
- `callsPerMonth = projectCallsPerMonth(chatSteps)` (reused from `savings.js`).
- `cacheSavingsPerMo = cacheableTokens × callsPerMonth × inputPrice × CACHE_SAVE_FRACTION / 1e6`,
  where `CACHE_SAVE_FRACTION = 0.9` (cache reads ≈ 10% of the input price → 90% saved on the cached prefix).
- `spendPerMo = mean(step.cost) × callsPerMonth`; `batchSavingsPerMo = spendPerMo × BATCH_DISCOUNT`,
  where `BATCH_DISCOUNT = 0.5` (Batch API ~50% off, **if latency-tolerant**).
- Constants are named at the top with `// ponytail:` notes (flat provider discounts; tune per provider).
- Imports only `projectCallsPerMonth` from `savings.js` — `inputPrice` is passed in (no `PRICES` import,
  so no circular dependency with `store.js`).

### 2. `store.js` integration
In `snapshot()`, per workflow per agent: `const y = agentYield(agentSteps(wf, name), inputPriceOf(model))`.
`inputPriceOf(model)` is a tiny helper reusing the existing `PRICES` prefix-match (the `[0]` input price;
`DEFAULT_PRICE[0]` fallback). Attach `yield: y` to the agent row. Sum a per-workflow
`yield: { cacheSavingsPerMo, batchSavingsPerMo }` over its agents. (Calling `agentSteps` per agent each
snapshot is O(agents × traces); acceptable at `MAX_TRACES=300`. `// ponytail:` note if it ever bites.)

### 3. UI — live "Yield" panel
A drill-down panel, always shown for the selected workflow:
- Headline: `Prompt caching −$X/mo · Batch API −$Y/mo if latency-tolerant` (workflow totals).
- Per-agent rows: `agent · cacheable ~T tok/call · −$…/mo cache`.
- A note: batch is an estimate assuming latency-tolerant calls; cache assumes a stable reused prefix.
Advisory — nothing is applied.

## Data flow

`SDK chat spans (with ctx breakdown) → store → snapshot() → agentYield per agent → agent.yield +
workflow.yield → SSE → live Yield panel`

## Testing

`yield.test.js` (pure):
- cacheableTokens = mean of `ctx.system + ctx.tools` across chat steps.
- cache/batch savings math (given known tokens, price, volume, cost).
- steps with no `ctx` → cacheableTokens 0, cacheSavingsPerMo 0 (batch still computes from cost).
- no chat steps → `null`.
Store test: ingest an agent whose chat steps carry a stable `ctx.system`/`ctx.tools` → the agent row
has a non-zero `yield.cacheSavingsPerMo`, and `workflow.yield` sums its agents.

## Non-goals (part 1)

Shadow-mode (part 2 — needs the unified client + critical path); per-provider cache-price nuance
(flat fractions); detecting real latency-tolerance (batch is an "if" estimate); on-demand job endpoint
(yield is instant, computed live).

## Dependencies added

None. Reuses `projectCallsPerMonth`, `PRICES`/`store.agentSteps`; pure arithmetic over existing data.
