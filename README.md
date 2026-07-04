# FleetGlass

Live control plane for AI agent fleets — see what your agents are doing right now and what it costs.

Phase 0 ("See") of the plan in [PLAN.md](PLAN.md): a read-only observability dashboard fed by
OpenTelemetry GenAI spans. No proxy, nothing in your critical path.

## Quickstart

```sh
node server.js     # control plane → http://localhost:4700
node simulator.js  # in a second terminal: simulated 4-agent fleet
```

Open http://localhost:4700. At t+3min the simulator "deploys" a bloated summarizer prompt
(re-including full retrieval history); the anomaly alert fires a minute or two later:
cost/call ~×2 vs baseline.

```sh
npm test           # store: normalization, cost math, edge derivation, anomaly detection
```

## What it does

- **Ingest** — `POST /v1/traces` accepts OTLP/JSON spans using [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (`gen_ai.agent.name`, `gen_ai.request.model`, `gen_ai.usage.*`).
- **Live agent graph** — agents as nodes, handoffs (derived from cross-agent parent spans) as edges, traffic dots animated at real request rates.
- **Context inspector** — click any agent: stacked breakdown of its context window (system / history / retrievals / tool schemas).
- **Cost heatmap** — spend and cost/call per agent; money is always amber.
- **Anomaly alert** — cost/call in the last 90s vs the prior baseline; fires at ×1.7 without any ground-truth evals.
- **Time-travel replay** — click any recent task: scrub step by step through what each agent saw (prompt, completion, tool I/O, context breakdown at that step). Arrow keys navigate, Esc closes. This is the seed of the Phase 1 replay substrate (fork-from-step needs live model keys and comes later).

## Integrate your own agents

The simulator is just one client of the ingest endpoint. To trace a real system, use
[tracer.js](tracer.js) (zero dependencies, ~100 lines):

```js
import { createTracer } from './tracer.js';

const fg = createTracer();            // → http://localhost:4700/v1/traces
const task = fg.startTask();          // one task = one traceId = one replay

// record any model call (provider-agnostic)
const planId = task.chat({
  agent: 'orchestrator', model: 'claude-opus-4-8',
  inputTokens: 3000, outputTokens: 280,
  prompt, completion,
  context: { system, history },       // raw strings — scaled to real token usage
});

// hand off to another agent: pass the previous spanId as `parent`.
// A cross-agent parent link is what draws a handoff edge in the graph.
task.chat({ agent: 'extractor', parent: planId, model: 'claude-haiku-4-5', ... });
task.tool({ agent: 'extractor', parent: planId, tool: 'parse_document', input, output });

await fg.flush();
```

**With the Anthropic SDK**, `task.anthropic(...)` records a `messages.create` round trip
(model, real token usage incl. cache reads, prompt, completion) in one call — see
[examples/claude-fleet.mjs](examples/claude-fleet.mjs), a real 3-agent incident-response
fleet on the Claude API:

```sh
cd examples && npm install
export ANTHROPIC_API_KEY=sk-ant-...   # or `ant auth login`
node claude-fleet.mjs
```

**How multiple agents are handled:** every span carries `gen_ai.agent.name` — that's the
node identity. Costs, call rates, context breakdowns, and anomaly baselines are all
aggregated per agent name. Handoffs are derived structurally: when a span's parent span
belongs to a *different* agent, that parent→child link becomes a graph edge. So the fleet
topology is discovered from the traces — nothing is configured up front.

**Other frameworks (LangGraph, CrewAI, OpenAI Agents SDK):** anything that can POST
OTLP/JSON spans with GenAI semconv attributes (`gen_ai.agent.name`, `gen_ai.request.model`,
`gen_ai.usage.*`) to `/v1/traces` works. Framework adapters that map their native OTel
output automatically are the next milestone.

## What's real vs. simulated

Real: the ingest endpoint, normalization, edge derivation, cost math, anomaly detection, replay
recording, SSE live feed. Simulated: the agents (`simulator.js`), and the `fleetglass.context.*_tokens`
/ `fleetglass.tool.*` attributes — context breakdown and tool payloads aren't in the OTel GenAI
semconv yet, so real integrations need a thin SDK wrapper to emit them (`gen_ai.prompt`/`gen_ai.completion`
are the legacy semconv span attributes).

Prices in `store.js` are approximate list prices; edit `PRICES` to match yours.

## Architecture

Zero dependencies. `store.js` (pure: normalize → aggregate → detect) · `server.js` (node:http: ingest,
snapshot API, SSE, static) · `public/` (vanilla JS dashboard) · `simulator.js` (OTLP GenAI span generator).
In-memory store with a 10-minute window; cumulative totals survive pruning. Swap for ClickHouse when
retention matters.
