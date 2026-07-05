# FleetGlass Universal Onboarding — Design

**Date:** 2026-07-05
**Status:** Approved (design), pending implementation plan

## Goal

Make FleetGlass onboard into **any** AI agent workflow — Python or Node, any provider
(OpenAI, Anthropic, Google) — with one import, one `wrap()`, and one `agent()` annotation.
No simulated data anywhere: real Gemini workflows in Python and Node become the test harness.

## Principle

One import, one `wrap()`, one `agent()` annotation captures everything —
prompt, completion, tokens, cost, context breakdown, and handoffs — provider-agnostic, in both
languages. The wrapper emits FleetGlass's existing JSON span format, so **the server, store, fork,
and replay stay exactly as they are.** All new work is client-side SDK plus real examples.

## Decisions (locked)

1. **Onboarding surface:** client wrapper + agent context (not explicit tracer calls, not OTel-native).
2. **Agent API:** `fg.agent(name)` as decorator *and* context manager (primary), with explicit
   `agent=`/`parent=` kwargs as an always-available escape hatch. Framework auto-detect is a
   possible later layer, out of scope here.
3. **Rollout:** Gemini-first in *both* languages; Anthropic + OpenAI follow as the identical pattern.
4. **Package names:** `fleetglass` on PyPI and npm.
5. **Layout:** light restructure to `sdk/{node,python}` (moves `tracer.js`, ~2 example import edits).

## Components

### 1. Tracer core (per language)

The span emitter plus async-context that threads *current agent* and *current parent span*.

- **Node** — evolve `tracer.js`. Keep `startTask` / `chat` / `tool` / `flush`. Add
  `AsyncLocalStorage` holding `{ agent, parentSpanId }`. Move to `sdk/node/tracer.js`.
- **Python** — new `fleetglass` package under `sdk/python/`. Mirror the Node API using
  `contextvars` for agent/parent context. Batched HTTP POST via **stdlib only**
  (`urllib.request` on a background daemon thread + queue). `pip install fleetglass` pulls
  **zero** mandatory dependencies. Provider SDKs are wrapped, never imported by us.
  - *ponytail:* stdlib urllib in a thread; swap for httpx/async only if throughput demands it.

### 2. Agent context

`fg.agent("researcher")` works as both a decorator and a context manager in each language:

- Python: an object that is both a `@decorator` and a `with`-context (`__call__` +
  `__enter__/__exit__`), plus async variants.
- Node: `fg.agent("researcher", fn)` wrapper and `fg.withAgent("researcher", async () => {…})`.

On a wrapped model call the adapter reads:
- current agent → `gen_ai.agent.name`
- current parent span → `parentSpanId`

When one agent's scope calls into another agent's scope, the cross-agent parent link becomes a
**handoff edge** — the exact derivation the store already performs (a span whose parent belongs to a
different agent draws an edge). Parent threading: on entry an `agent()` scope anchors to the
enclosing scope's most-recent span; the first call inside uses that anchor as parent, subsequent
calls chain off the previous in-scope span.

Parallel fan-out (`asyncio.gather` / `Promise.all`) stays correctly isolated because
`contextvars` / `AsyncLocalStorage` fork per branch.

### 3. Provider adapters

`fg.wrap(client)` detects the provider by client type/module and returns a proxy that intercepts
the completion method:

| Provider | SDK | Intercepts | Auto-captured |
|---|---|---|---|
| Google | `google-genai` | `models.generate_content` | model, `usage_metadata` (prompt/candidates token counts), contents, response text, `system_instruction`, tools |
| Anthropic | `anthropic` | `messages.create` | reuses existing `anthropic()` mapping (incl. cache-read tokens) |
| OpenAI | `openai` | `chat.completions.create` | model, usage, messages, tools |

Context-segment breakdown is derived from the **request shape**:
- **system** ← system param / `system_instruction`
- **history** ← messages / contents (minus system)
- **tools** ← tool schema param
- **retrieval** ← `0` unless the user passes an explicit `context={"retrieval": ...}` override.
  Retrieval is not separable from history automatically; this is the honest ceiling and an opt-in upgrade.

Adapters map the provider response onto the existing `chat()` primitive — no new span shape.

### 4. Server

No wire-format changes (the wrapper emits our JSON). Only change: add OpenAI model entries to
`PRICES` in `store.js` (Gemini and Anthropic already present).

### 5. Examples — the new test harness

Replace the simulator with the **same** real multi-agent Gemini workflow in both languages:

- `examples/gemini-fleet.py`
- `examples/gemini-fleet.mjs`

Workflow: research → extract → summarize (three agents, real `google-genai` calls, real handoffs).
These are what we validate against — no fabricated data.

### 6. Simulator

Delete `simulator.js` from the primary path. Its one irreplaceable behavior was the scripted
"bad deploy" that triggers the anomaly alert on cue. Replace it with an optional `--inflate` flag on
the Gemini example that re-includes full history to trigger the **real** anomaly on demand. No
simulated telemetry remains in the product.

## Layout

```
sdk/node/     tracer.js + adapters.js + index.js      (moved from root; update example imports)
sdk/python/   fleetglass/  (__init__.py, tracer.py, adapters.py, agent.py)
examples/     gemini-fleet.py, gemini-fleet.mjs
```

## Testing

- **Python** — `sdk/python/test_tracer.py` (stdlib `unittest`): span shaping, context split,
  agent/parent threading, provider-response → span mapping using **fake** response objects (no network).
- **Node** — extend existing tests: drive `wrap()` with a fake client, assert emitted spans.
- **End-to-end** — run both Gemini examples against a live Google API key (manual, needs a key).

## Rollout order

1. Tracer core, both languages (with async-context).
2. `agent()` decorator/context, both languages.
3. Google adapter, both languages.
4. Gemini examples (`.py` + `.mjs`).
5. Validate end-to-end on a live Google key.
6. Anthropic + OpenAI adapters (identical pattern).
7. Delete `simulator.js`; update README onboarding docs for both languages.

## Non-goals

- Framework auto-instrumentation (LangGraph/CrewAI node-name inference) — possible later layer.
- OTLP protobuf/gzip ingest — unnecessary while onboarding goes through our wrapper.
- Streaming-response capture nuances beyond final usage/text — handle non-streaming first.
- Automatic retrieval-vs-history segmentation — opt-in labeling only.

## Dependencies added

- Runtime: **none mandatory.** Python core is stdlib; Node core is zero-dep; adapters wrap the
  provider client the user already has.
- Examples/dev: `google-genai` (Python) and `@google/genai` (Node), in the examples package only.
