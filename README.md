# FleetGlass

Live control plane for AI agent fleets — see what your agents are doing right now and what it costs.

Phase 0 ("See") of the plan in [PLAN.md](PLAN.md): a read-only observability dashboard fed by
OpenTelemetry GenAI spans. No proxy, nothing in your critical path.

## Quickstart

```sh
node server.js     # control plane → http://localhost:4700
node simulator.js  # in a second terminal: simulated 4-agent fleet
```

Open http://localhost:4700. At t+40s the simulator "deploys" a bloated summarizer prompt and the
anomaly alert fires: cost/call ~×2 vs baseline.

```sh
npm test           # store: normalization, cost math, edge derivation, anomaly detection
```

## What it does

- **Ingest** — `POST /v1/traces` accepts OTLP/JSON spans using [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (`gen_ai.agent.name`, `gen_ai.request.model`, `gen_ai.usage.*`).
- **Live agent graph** — agents as nodes, handoffs (derived from cross-agent parent spans) as edges, traffic dots animated at real request rates.
- **Context inspector** — click any agent: stacked breakdown of its context window (system / history / retrievals / tool schemas).
- **Cost heatmap** — spend and cost/call per agent; money is always amber.
- **Anomaly alert** — cost/call in the last 90s vs the prior baseline; fires at ×1.7 without any ground-truth evals.

## What's real vs. simulated

Real: the ingest endpoint, normalization, edge derivation, cost math, anomaly detection, SSE live feed.
Simulated: the agents (`simulator.js`), and the `fleetglass.context.*_tokens` attributes — context
breakdown isn't in the OTel GenAI semconv yet, so real integrations need a thin SDK wrapper to emit it.

Prices in `store.js` are approximate list prices; edit `PRICES` to match yours.

## Architecture

Zero dependencies. `store.js` (pure: normalize → aggregate → detect) · `server.js` (node:http: ingest,
snapshot API, SSE, static) · `public/` (vanilla JS dashboard) · `simulator.js` (OTLP GenAI span generator).
In-memory store with a 10-minute window; cumulative totals survive pruning. Swap for ClickHouse when
retention matters.
