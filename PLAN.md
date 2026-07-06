# FleetGlass — SaaS Plan

**One-liner:** Cut your AI agent bill — with proof. We find the spend you can safely
remove and back every dollar with a counterfactual you can audit.

> Repositioned 2026-07-07 from "observability control plane" (a vitamin in a red ocean)
> to "cost savings with evidence" (a painkiller with a budget line). Observability is the
> free top-of-funnel; the product is the number. History of the old framing is in git.

---

## 1. Wedge and thesis

Agent LLM bills are exploding and nobody can prove what's safe to cut. Observability tools
(LangSmith, Langfuse, Helicone, Arize) show you *what happened*; none tell you *what you can
change without breaking output*. That gap is our wedge.

- **The painkiller:** an evidence-backed savings report — "here is $X/yr you can recover, and
  here is the counterfactual proving output still holds." CFO-legible, auditable, budgeted.
- **The moat:** the **counterfactual substrate** — record every step's full I/O, then re-execute
  it (fork-from-step), ablate its context, or shadow it on a cheaper config. This is what a
  log-viewer structurally cannot do, and it's what turns "cut cost" from a guess into proof.
- **The funnel:** free, design-led observability (live agent graph, cost heatmap, replay) exists
  to get the traces in the door and make the savings number computable. The graph is the demo;
  the savings report is the sale.

**Why we win where LangSmith/Datadog won't just add this:** they're read-only log tools optimized
for enterprise breadth; we're multi-provider + counterfactual + mid-market, and the savings number
is a different product motion (ROI sale, not a seat sale). Design speed and the replay substrate are
the durable cut — not prettier dashboards.

## 2. ICP and buyer

- **Primary (narrow on purpose):** teams burning **$10k–$50k/mo** on agents and *feeling it* —
  coding agents, support/triage agents, research/RAG pipelines. The bill has a line item and an
  owner who's been asked "why is this so expensive?"
- **User:** the AI/platform engineer whose traces we analyze. **Buyer:** the eng lead / whoever
  owns the LLM budget. The savings number makes it a fast, self-justifying purchase.
- **Anti-ICP for now:** hobbyists (no budget), Fortune 500 (sales cycle kills a pre-seed company),
  teams under ~$5k/mo spend (savings too small to matter).

## 3. Motion: sell before you build

The trust ratchet is also a **revenue** ratchet — earn the right to the next step by delivering the
previous one's number.

1. **Manual savings report (now, does-not-scale).** Ingest a prospect's traces (or a sampled
   export), run the analysis by hand, deliver the one-page report (see `docs/savings-report-template.md`).
   Charge from day one. **No SDK adoption required to prove willingness-to-pay.**
2. **Productize the report.** The recurring analysis + dashboard, self-serve after the first
   hand-held one lands.
3. **Shadow-mode proof (opt-in).** Sample real calls onto the cheaper config, report agreement %
   over time. Advisory, never in the critical path by default.
4. **Advisory → in-the-loop.** Budget guardrails, runaway kill-switch (opt-in circuit breaker),
   evidence-gated auto-routing. Each unlocked only after the prior number is trusted.

## 4. The savings engines (our differentiated substrate, aimed at $)

| Engine | Finding it produces | Backed by |
|---|---|---|
| **Model downgrade** | "step X on Haiku vs Opus → 97% agreement, −$Y/mo" | fork-from-step |
| **Context ROI** | "retrieval segment adds 4.1K tok, 98% agreement without it → −$Z/mo" | ablation replay |
| **Runaway elimination** | "ping-pong loop / retry storm burned $W last week" | pathology detection |
| **Cache / batch yield** | "flat ~30% via batch-API + cache-aware scheduling, zero routing risk" | request shaping |
| **Prompt-change regression** | "v15 raised cost 18% for 6% quality — don't ship" | golden-set replay |

Each engine emits a dollar figure *and* the counterfactual behind it. That pairing is the product.

## 5. Pricing

| Tier | Price | What it buys |
|---|---|---|
| Free | $0 | Live obs, 7-day retention, capped spans. Gets traces in; makes the number computable. |
| Team | $199–$799/mo | The recurring savings report, replay/fork, regression + drift, 90-day retention. |
| Enterprise | $30k–$80k/yr | Shadow-mode + routing, self-host, SSO/RBAC, chargeback, security tier. |

Framed as ROI, not features: *"we found $40k/yr; the $9.6k tier pays for itself."* **No %-of-savings
billing** — unauditable counterfactuals die in procurement.

## 6. Go-to-market

1. **Sell the report, not the tool.** First 10 customers come from founder-led manual reports.
2. **Data-driven content as the growth loop** — "Anatomy of a $400 retry loop," "Tool schemas eat
   30% of every call," built from *real* (anonymized) customer data. This is the one moat competitors
   can't copy without your traces.
3. **Open-source the SDK/collector** (OTel-compatible) — distribution + neutralizes lock-in.
4. **One spectacular public demo** — a live, explorable multi-agent graph, embeddable, no signup.
5. Land free-obs → expand on the savings number or the kill-switch that saved a weekend.

## 7. Metrics

Willingness-to-pay first: **# paying design partners** → **$ found vs $ realized** (the credibility
metric) → free→paid conversion → **% of paid orgs enabling shadow-mode** (trust-ratchet health) →
NRR (>120% via spend-based tiers).

## 8. Risks

| Risk | Mitigation |
|---|---|
| Crowded obs market; we look like "prettier LangSmith" | Reposition on savings-with-proof; the graph is free funnel, not the product |
| Incumbent adds a savings view | It's an ROI motion + counterfactual substrate, not a dashboard feature; win on multi-provider + speed + mid-market focus |
| Model prices keep falling, shrinking the pitch | Savings % of a growing bill stays large; also lead with runaway prevention (durable) |
| Can't prove savings are real | Sampled shadow-mode + defined agreement metric; never %-of-savings billing |
| No distribution | Founder-led sales first; data-content loop second; OSS SDK third |
| Building platform before PMF | Manual report first; productize only after 3–5 paying partners |

## 9. Milestones (revenue-first)

- **M1:** 5 paid manual savings reports delivered. Proof that the number sells.
- **M3:** productized recurring report; ~$5k MRR; 10 paying teams.
- **M6:** shadow-mode + savings dashboard; ~$25k MRR → raise on realized-savings data.
- **M12:** routing + security/self-host; first 2 enterprise logos.

## 10. What we are NOT

Not a durable-execution engine (Temporal's lane — we detect, we don't run your workflow). Not a
unified LLM gateway (LiteLLM's lane, commoditized, in the critical path). Not another read-only log
viewer. We are the layer that turns your traces into a **provable, recoverable dollar number.**
