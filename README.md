<div align="center">

# 🛰️ FleetGlass

### The live control plane for AI agent fleets

**See what your agents are doing right now · debug why · and cut what it costs.**

<br>

![status](https://img.shields.io/badge/phase-0%20%22See%22%20%2B%20Phase%201%20fork--from--step-5b8def?style=flat-square)
![deps](https://img.shields.io/badge/dependencies-0-4ec9a0?style=flat-square)
![runtime](https://img.shields.io/badge/runtime-Node%2018%2B-e8a33d?style=flat-square)
![protocol](https://img.shields.io/badge/ingest-OTel%20GenAI%20semconv-8b6fd8?style=flat-square)
![tests](https://img.shields.io/badge/tests-passing-4ec9a0?style=flat-square)

</div>

---

Teams ship multi-agent systems with **zero operational visibility**. Tracing tools show you
logs after the fact; gateways route blindly. Nobody closes the loop: **observe → prove with
evidence → act**. FleetGlass is a design-led, real-time visual control plane that does — starting
with the part you can trust on day one: read-only observability that never sits in your critical path.

> **Zero dependencies. Zero proxy. One `POST` and you have a live agent graph.**

<div align="center">

```
  your agents ──OTLP/JSON spans──▶  /v1/traces  ──▶  in-memory store  ──SSE──▶  live dashboard
   (any lang)   (GenAI semconv)      (node:http)     normalize·aggregate·detect    (vanilla JS)
```

</div>

---

## ✨ What you get

| | Feature | What it does |
|---|---|---|
| 🗂️ | **Fleet view** | One card per workflow (`service.name`) — spend, call rate, agent count, anomalies, live pulse. The bird's-eye view across every agent system you run. Click to drill in. |
| 🕸️ | **Live agent graph** | Agents are nodes, handoffs are edges — *derived structurally* from cross-agent parent spans. Traffic dots animate at real request rates. Nothing configured up front. |
| 🔬 | **Context inspector** | Click any agent: a stacked breakdown of its context window — system / history / retrievals / tool schemas. See what's actually eating your tokens. |
| 💰 | **Cost heatmap** | Spend and cost-per-call per agent, provider-agnostic list pricing. Money is always amber. |
| 🚨 | **Anomaly alert** | *"cost/call doubled since yesterday's prompt change"* — fires at ×1.7 vs a rolling baseline, no ground-truth evals required. |
| ⏪ | **Time-travel replay** | Click any recent task and scrub step-by-step through exactly what each agent saw — prompt, completion, tool I/O, context breakdown at that step. Arrow keys navigate, `Esc` closes. |
| 🍴 | **Fork-from-step** ⭐ | On any chat step, pick a cheaper model and **re-run its prompt live** — then diff the new completion against the original and see the cost delta. *"Re-run step 12 on Haiku."* This is the trust engine for routing. |

---

## 🚀 Quickstart

```sh
node server.js      # control plane → http://localhost:4700
```

Open **http://localhost:4700**, then run any real fleet against it — see
[Onboard your agents](#-onboard-your-agents-python-or-node-any-provider) below. The fastest way to
see the whole loop live (graph, cost heatmap, anomaly alert) is one of the runnable examples:

```sh
cd examples && npm install
export GEMINI_API_KEY=...
node gemini-fleet.mjs --inflate    # --inflate re-includes full history to trip the anomaly alert
```

```sh
npm test            # store: normalization · cost math · edge derivation · anomaly detection
node fork.js        # fork-from-step self-check (runs without a key)
```

---

## 🍴 Fork-from-step (the moat)

Observability tells you a step is expensive. **Fork-from-step tells you what happens if you make it
cheaper — before you touch production.**

Open any task in replay, land on a chat step, and you'll see a **Fork from step** panel:

1. Pick a target model (Haiku, Sonnet, …).
2. Hit **Fork ▸** — FleetGlass re-runs that step's recorded prompt **live** on the new model.
3. The panel shows the original and forked completions **side by side**, with the real cost delta:
   *"73% cheaper — $0.021/call. Judge output agreement before you route."*

```sh
export ANTHROPIC_API_KEY=sk-ant-...   # the control plane makes the live call
```

Without a key the panel says so cleanly — nothing else breaks.

> **Fidelity note.** The substrate captures a step's prompt as *text* but system / history /
> retrievals as *token counts* only, so a fork is faithful to the prompt and approximate on hidden
> context. Record the full messages array in [`sdk/node/tracer.js`](sdk/node/tracer.js) for exact
> re-execution when counterfactual precision matters.

---

## 🔌 Onboard your agents (Python or Node, any provider)

One `wrap()` around your existing model client, one `agent()` per role — no manual span mapping,
no explicit `parent`/`spanId` wiring. Handoffs are derived automatically from call order within a
task.

**Node** — `sdk/node/`, zero dependencies

```js
import { createTracer } from 'fleetglass';           // or '../sdk/node/index.js' in this repo

const fg = createTracer({ workflow: 'my-system' });
const ai = fg.wrap(new GoogleGenAI({ apiKey }));      // or `new Anthropic()` / `new OpenAI()`

await fg.task(async () => {
  const plan = await fg.agent('planner', () =>
    ai.models.generateContent({ model, contents, config }));
  await fg.agent('executor', () => {
    fg.emitTool({ tool: 'run_query', input, output });  // any non-model tool call
    return ai.models.generateContent({ model, contents: plan.text, config });
  });
});
```

**Python** — `sdk/python/`, stdlib only

```python
from fleetglass import Tracer

fg = Tracer(workflow='my-system')
ai = fg.wrap(genai.Client(api_key=key))               # or the Anthropic / OpenAI client

with fg.task():
    with fg.agent('planner'):
        plan = ai.models.generate_content(model=model, contents=contents, config=config)
    with fg.agent('executor'):
        fg.emit_tool(tool='run_query', input=q, output=result)
        ai.models.generate_content(model=model, contents=plan.text, config=config)
```

`wrap()` auto-captures model, tokens, prompt, completion, cost, and the context breakdown
(system / history / tools) straight from the client's real response — nothing to compute by hand.
`agent()` works as both a context manager and, in Python, a decorator. A cross-agent parent link
(one agent's call following another's within the same task) is what draws a **handoff edge** in
the graph — nothing configured up front.

Runnable end-to-end fleets, install deps and run directly:

```sh
cd examples && npm install
export GEMINI_API_KEY=...
node gemini-fleet.mjs "your question"        # or claude-fleet.mjs with ANTHROPIC_API_KEY

cd examples && pip install -r requirements.txt
export GEMINI_API_KEY=...
python3 gemini-fleet.py "your question"
```

**Other frameworks** (LangGraph, CrewAI, OpenAI Agents SDK): anything that can `POST` OTLP/JSON
spans with GenAI semconv attributes — `gen_ai.agent.name`, `gen_ai.request.model`,
`gen_ai.usage.*` — to `/v1/traces` works. Native-adapter mapping is the next milestone.

### How multi-agent topology is discovered

Every span carries `gen_ai.agent.name` — that's the node identity. Costs, call rates, context
breakdowns, and anomaly baselines aggregate per agent name. **Handoffs are derived structurally:**
when a span's parent belongs to a *different* agent, that parent→child link becomes a graph edge.
The fleet topology falls out of the traces — nothing is configured up front.

---

## 🧱 Architecture

Zero mandatory dependencies in the control plane. Small files, one clean seam each:

| File | Role |
|---|---|
| [`store.js`](store.js) | **Pure core** — normalize OTLP → aggregate per workflow/agent → detect anomalies. Fully unit-tested. |
| [`server.js`](server.js) | `node:http` — ingest (`POST /v1/traces`), snapshot API, SSE live feed, `POST /api/fork`, static serving. |
| [`fork.js`](fork.js) | Live re-execution of one recorded step on a different model — the fork-from-step engine. |
| [`sdk/node/`](sdk/node/) | Zero-dep Node SDK (`createTracer`, `fg.wrap`, `fg.agent`) for instrumenting real agents. |
| [`sdk/python/`](sdk/python/) | Stdlib-only Python SDK (`Tracer`, `fg.wrap`, `fg.agent`) — same shape. |
| [`public/`](public/) | Vanilla-JS dashboard — fleet view, graph, inspector, heatmap, replay. No build step. |
| [`examples/`](examples/) | Runnable fleets against real providers (Gemini, Claude) — the demo path. |

In-memory store, 10-minute rolling window; cumulative totals survive pruning. **Swap for ClickHouse +
object storage when retention matters** — the store interface is the only thing that changes.

### What's real vs. approximated

- **Real:** the ingest endpoint, normalization, edge derivation, cost math, anomaly detection,
  replay recording, live fork-from-step, the SSE feed, and every span emitted by the SDKs —
  `wrap()` reads real token usage and text straight off the provider response.
- **Approximated:** the `fleetglass.context.*_tokens` / `fleetglass.tool.*` attributes — context
  breakdown and tool payloads aren't in the OTel GenAI semconv yet, so the SDKs derive a per-segment
  token split from real input-token totals and raw prompt/system/history text (`gen_ai.prompt` /
  `gen_ai.completion` are the legacy semconv span attributes carrying that text).

Prices live in `PRICES` in [`store.js`](store.js) — approximate list prices; edit to match yours.

---

## 🗺️ Roadmap

FleetGlass follows a **trust ratchet**: read-only → advisory → in-the-loop. Never ask for
critical-path placement before showing value. Full plan in [`PLAN.md`](PLAN.md).

- ✅ **Phase 0 — "See"** · OTel GenAI ingest, live agent graph, context inspector, cost heatmap, the killer anomaly alert.
- 🚧 **Phase 1 — "Prove"** · deterministic replay substrate · **fork-from-step** (shipped) · prod-traces-as-regression-suite · nightly drift canaries.
- 🔜 **Phase 2 — "Save"** · opt-in proxy · shadow-mode savings reports · batch/cache yield management · budget guardrails + loop kill-switch.
- 🔜 **Phase 3 — "Act"** · evidence-gated auto-routing · injection taint tracking (the security SKU) · self-host, SSO/RBAC, chargeback.

---

<div align="center">

**Built to be forked, read, and understood in one sitting.**

`node server.js` · open `localhost:4700` · watch the fleet

</div>
