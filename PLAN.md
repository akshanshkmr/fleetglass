# Agent Control Plane — SaaS Plan

**Working name:** TBD (brand matters here — the product is design-led)
**One-liner:** The control plane for AI agent fleets — see what your agents are doing right now, debug why, and cut what it costs.

---

## 1. Wedge and thesis

Teams are shipping multi-agent systems with zero operational visibility. Tracing tools (LangSmith, LangFuse) show logs after the fact; gateways (LiteLLM, OpenRouter) route blindly. Nobody closes the loop: **observe → prove with evidence → act automatically**.

- **The wedge:** a design-led live visual control plane (agent graph, context inspector, cost heatmap).
- **The moat:** a deterministic replay substrate — record every agent step's full tool I/O so any step can be re-executed, forked, and counterfactually tested. One substrate powers replay, fork-from-step, context ROI, regression suites, and drift canaries.

## 2. ICP and buyer

- **Primary:** Series A–C product companies with agents in production — 5–50 engineers, $5k–$200k/mo LLM spend. User = AI/platform engineer; buyer = eng lead. Pain is acute, procurement is fast.
- **Secondary (phase 3+):** enterprise platform teams, arriving via the security tier and self-host.
- **Anti-ICP for now:** hobbyists (support drain), Fortune 500 (sales cycle kills a pre-seed company).

## 3. Product roadmap

### Phase 0 — "See" (months 0–2) · free, read-only, no trust required
- OTel GenAI ingestion (no proxy, out of critical path)
- Live agent graph — agents as nodes, tasks/handoffs as edges
- Context inspector — stacked token breakdown per call (system / history / retrievals / tool schemas)
- Cost heatmap — cost by agent, step, prompt
- One killer alert: "cost/task doubled since yesterday's prompt change"
- Success bar: first meaningful graph within 10 minutes of install

### Phase 1 — "Prove" (months 2–5) · the moat gets built here
- Recording substrate: full tool I/O capture for deterministic re-execution
- Time-travel replay + **fork-from-step** ("re-run step 12 on Haiku")
- Prod-traces-as-regression-suite for prompt changes
- Nightly drift canaries (frozen golden set vs. prod config)
- Behavioral drift fingerprinting (tool-call rates, refusal rates, output distributions)

### Phase 2 — "Save" (months 4–8) · first revenue expansion
- Opt-in proxy (OpenAI-compatible base-URL swap)
- Shadow-mode savings reports: "$X/week at 98% output agreement" (sampled, not full-duplicate)
- Batch-API + cache-hit yield management (flat ~50% wins, zero routing risk)
- Budget guardrails; structural loop detection with kill-switch (ping-pong handoffs, retry storms, context spirals)

### Phase 3 — "Act" (months 8–14) · enterprise tier
- Opt-in auto-routing per task type, gated on shadow-mode evidence
- Injection taint tracking across agent handoffs (the security SKU)
- Self-hosted deployment, SSO/RBAC, team chargeback reports

**Sequencing logic:** a trust ratchet. Read-only → advisory → in-the-loop. Never ask for critical-path placement before showing value.

## 4. Pricing

| Tier | Price | What it buys |
|---|---|---|
| Free | $0 | 2 seats, 7-day retention, capped spans/mo. Exists to make the graph a shared screenshot. |
| Team | $199–$799/mo | Tiered by ingested spans + seats. Replay, canaries, savings reports, 90-day retention. |
| Enterprise | $30k–$80k/yr | Self-host, taint tracking/security, auto-routing, SSO, chargeback. |

Savings reports are a **sales artifact, not a billing model** ("we found $40k/yr; the $9.6k tier pays for itself"). No %-of-savings billing — unauditable counterfactuals die in procurement.

## 5. Go-to-market

1. **Open-source the SDK/collector** (OTel-compatible) — distribution + neutralizes lock-in objections.
2. **One spectacular public demo:** a live, explorable multi-agent graph, embeddable, no signup.
3. **Content engine from own data:** "Tool definitions eat 30% of every call," "Anatomy of a $400 retry loop."
4. **Framework channel:** listed integrations with LangGraph, CrewAI, OpenAI Agents SDK, MCP registries.
5. Land free with observability → expand to paid when the savings report shows a number or the kill-switch saves a weekend.

## 6. Metrics

Time-to-first-graph (<10 min) → weekly-active dashboards per org → free→paid conversion (5–8%) → **% of paid orgs enabling the proxy** (trust-ratchet health) → NRR (>120% via spend-based tiers).

## 7. Team and cost structure

Two technical founders; first hire is a **design engineer** (the product IS the dashboard). Infra: ClickHouse + object storage for traces; replay/shadow compute metered through customer keys, not your margin. <$3k/mo infra until Series A scale.

## 8. Risks

| Risk | Mitigation |
|---|---|
| LiteLLM/LangFuse add a graph view | They're table-UIs/gateways at core; win on replay substrate + design speed |
| Providers build native dashboards | Single-provider by definition; multi-provider + topology is the defensible cut |
| Adapter treadmill | OTel-first; bespoke adapters only where OTel data is thin |
| Bad reroute breaks prod | Shadow-evidence gate before any auto-routing; advisory by default |
| Model price deflation shrinks savings pitch | Lead with control/visibility (durable); savings is the door-opener |
| Proxy trust/latency objections | Proxy is opt-in phase 2; observability never sits in the critical path |

## 9. Milestones

- **M2:** Phase 0 live, 20 design partners, demo on HN.
- **M5:** fork-from-step shipped, 10 paying teams, ~$5k MRR.
- **M8:** proxy + savings reports, ~$25k MRR → raise seed on trust-ratchet conversion data.
- **M14:** security tier + self-host, first 2 enterprise logos.

## 10. Differentiators nobody ships today

1. **Fork-from-step counterfactual replay** — the trust engine for routing.
2. **Context ROI attribution** — ablation replay: which context segments actually change outputs.
3. **Injection taint tracking** across agent handoffs — opens the security budget.
4. **Behavioral drift fingerprinting** without ground-truth evals.
5. **Structural pathology detection** — loop/ping-pong/retry-storm shapes in the live graph.
6. **Yield management** — auto-batch + cache-aware scheduling (when/how, not just which model).
7. **Fleet-derived provider health** — see provider degradation before status pages do.
