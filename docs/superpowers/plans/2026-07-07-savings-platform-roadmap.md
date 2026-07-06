# Savings Platform — Program Plan (M1–M5)

> The design-partner product per the repositioned [PLAN.md](../../../PLAN.md): every finding is a
> dollar figure plus an auditable counterfactual. This is the **program spine** — each milestone
> runs through its own design → spec → plan → build loop. Build order is dependency-driven, not
> milestone-numeric.

## The spine (shared substrate every engine needs)

**S0 — Keystone: faithful fork.** Today `fork.js` re-runs the *recorded prompt only* (the
`ponytail:` ceiling in the file) and is Claude-only. Every savings claim ("we re-ran your call, output
held") is only as credible as the re-execution. So the keystone is:
- **Full-request capture** — the tracer records the whole normalized request (system, message
  history, tools), not just a truncated prompt. New span field (e.g. `fleetglass.request` = JSON).
  **Opt-in + redaction hooks + size cap** — full requests are large and can carry PII.
- **Faithful re-execution** — `fork.js` reconstructs the exact request from the captured blob and
  re-runs it on any target model, across all three providers (not just Claude).
- The blob is **structured enough to drop a segment** (so M2 can ablate).

**S1 — Agreement metric** (built with M1, reused by M2/M4/M5). Pluggable: exact-field-match for
structured output; an LLM-judge for free text. The partner defines the bar; we measure, never assume.

**S2 — Sampling.** Pick representative real calls per agent for an engine to re-run (cost-bounded).

## Milestones

### M1 — Savings Report + model-downgrade engine (the core)
- **Model-downgrade engine:** for an agent/step, fork S2-sampled real calls onto a cheaper model,
  score with S1, compute cost delta → finding `{agent, from→to model, agreement, $/mo}`.
- **Savings Report:** aggregate findings per workflow into an in-product report (UI + export) —
  headline recoverable $/yr, opportunity table, each row links to the fork as evidence.
- **DoD:** on a real trace set, produce a report with ≥1 model-downgrade finding backed by an
  inspectable fork. Depends on S0, S1, S2.

### M2 — Context ROI engine
- Ablate one context segment (drop it from the reconstructed request), re-run, score with S1,
  cost delta → finding. Emits into the same Savings Report.
- **DoD:** a context-trim finding with measured agreement. Depends on S0 (structured blob), S1.

### M3 — Pathology detection (read-only) — PARALLELIZABLE
- Already specced: [`2026-07-07-structural-pathology-detection-design.md`](../specs/2026-07-07-structural-pathology-detection-design.md).
  `pathology.js` + `store.js` `pathologies[]` + dashboard card + graph highlight + replay hook.
- **Independent of the keystone** — runs on existing traces. Good early quick-win / demo fuel;
  contributes the "runaway $ burned" line to the report.
- **DoD:** the spec's tests pass; runaway tasks surface with $ burned. Depends on: nothing new.

### M4 — Prompt-change regression + drift canary
- Freeze a golden set of real traces; re-run on a new prompt/model via faithful fork; compare
  statistically (S1 agreement + CI, cost delta, drift: tool-call/refusal rates) → ship/hold verdict.
- **DoD:** given prompt v→v', a verdict with per-trace agreement and a cost/quality delta.
  Depends on S0, S1, `store.js` anomaly-baseline math (reuse).

### M5 — Shadow-mode + cache/batch yield (heaviest, last)
- **Shadow-mode:** opt-in sampled duplication of live calls onto the cheaper config; agreement
  tracked over time. This edges toward the critical path — the natural home is the **unified client**
  (design already approved, thin+additive). Gate hard: opt-in, sampled, never default in-path.
- **Yield:** count batchable/cache-eligible calls × provider discount → finding (analysis, no re-exec).
- **DoD:** a shadow-agreement trend + a yield finding in the report. Depends on S0, S1, unified client.

## Build order (dependency-driven)

```
S0 keystone ──┬─▶ M1 (+S1,S2) ──┬─▶ M2
              │                 └─▶ M4
              └───────────────────▶ M5 (+ unified client)
M3 pathology ── parallel, no keystone dep ── start anytime (good first win)
```

Recommended sequence: **M3 first (parallel quick-win) → S0 keystone → M1 → M2 → M4 → M5.**
Rationale: M3 ships demo value immediately with zero new dependencies while S0 (the gating,
higher-risk change: full-request capture + privacy) is designed and built; then M1 delivers the core
product; M2/M4 are cheap reuses of the M1 substrate; M5 is deferred because it needs the unified
client and touches the critical path.

## Cross-cutting concerns (decide once, apply everywhere)

- **Privacy / PII:** full-request capture is opt-in with redaction hooks and size caps. This is a
  trust prerequisite for design partners — design it in S0, not bolted on later.
- **Agreement metric definition:** agreed with the partner up front (structured vs text); ours to
  measure, theirs to set the bar. Lives in S1, reused everywhere.
- **Cost of re-execution:** every engine spends real tokens forking. S2 sampling caps it; report the
  analysis cost transparently.
- **Never %-of-savings billing** (unauditable) and **never default in the critical path** (shadow/kill
  are opt-in) — both are load-bearing for the ROI/procurement story.

## Execution

Each milestone: brainstorm → spec (`docs/superpowers/specs/`) → plan (`docs/superpowers/plans/`) →
subagent-driven build → review → merge to `main`. Same loop as the onboarding SDK.
**Next up: S0 keystone** (unblocks M1/M2/M4) — or M3 in parallel as a first quick win.
