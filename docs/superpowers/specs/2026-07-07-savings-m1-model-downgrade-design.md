# Savings M1 — Model-Downgrade Engine + Savings Report — Design

**Date:** 2026-07-07
**Status:** Approved (design), pending implementation plan
**Program:** [savings-platform-roadmap](../plans/2026-07-07-savings-platform-roadmap.md) · milestone M1 (includes the S0 keystone)

## Goal

Produce an **auditable, cross-provider** savings finding on a design partner's real traces: "your
`<agent>` on `<cheaper model>` → `<agreement>%` output agreement, −$`<X>`/mo," backed by a fork the
partner can inspect. Delivered in an in-product Savings Report.

## Locked decisions

1. **Cross-provider** downgrades (Opus→Haiku *and* Opus→Gemini-flash), via a canonical request + translator.
2. **Auto agreement metric** — structural match for JSON output, LLM-judge for free text; partner sets the pass bar.
3. **On-demand** analysis — a user-triggered, bounded batch of forks (not continuous background).

## Why this order (the keystone is inside M1)

The engine's whole claim is "we re-ran your real call and output held." Today `fork.js` re-runs the
recorded *prompt only* and is Claude-only — not auditable, not cross-provider. So M1 builds the
faithful-fork keystone (S0) first; the engine and report sit on top.

## Canonical request format

Capture once, fork anywhere. The canonical request is provider-neutral:

```
{ system: string,
  messages: [ { role: 'user' | 'assistant', content: string } ],
  tools?: <provider tool schema, best-effort> }
```

- `system` / `messages` translate faithfully across all three providers.
- `tools` translate **verbatim for same-provider** forks; **cross-provider tool translation is a
  documented limitation** — a finding on a tool-using step forked cross-provider carries a
  reduced-fidelity flag rather than a silent wrong number.

## Components

### 1. Canonical request capture (S0)
`wrap()` adapters already intercept the request. They normalize it to the canonical shape (the
*inbound* translator half) and emit `fleetglass.request` (JSON) on the chat span. `store.js` persists
it on the step. **Opt-in** via a tracer flag `captureRequests`; a **redaction hook** runs before
emit; a **size cap** truncates oversized blobs. Both languages (Node + Python).

### 2. Translator — `translate.js` (new, server, zero-dep)
`toProvider(canonical, { provider, model }) → providerRequest` — the *outbound* half, mapping
canonical → `messages.create` (Anthropic) / `chat.completions.create` (OpenAI) /
`generateContent` (Google). Pure, fixture-testable. The inbound half lives in the adapters (§1).

### 3. Faithful fork — extend `fork.js`
`forkStep(step, { provider, model })`: read the step's captured canonical request, `toProvider(...)`,
re-execute on the target provider. **Multi-provider keys** on the control plane
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`); select the target's key, clear error if
missing. Returns `{ completion, model, inTok, outTok, cost }`. Replaces the prompt-only, Claude-only path.

### 4. Agreement metric — `agreement.js` (new)
`score(original, fork, opts) → { score, method }`. If both completions parse as JSON → structural
field match (fraction of matching leaf fields); else an **LLM-judge** call returning a 0–1 agreement
(judge model + key configurable; injectable for tests). Partner's pass bar is a threshold (default 0.95).

### 5. Sampling — in `savings.js`
`sample(steps, n=8)` — pick N recent real chat steps for an agent that carry a captured request.
Cost-bounded; N configurable.

### 6. Downgrade engine — `savings.js` (new)
`analyze({ workflow, agent, targets }) → findings[]`. For each target `{provider, model}`: fork the
N sampled calls, `score` each vs the recorded completion, aggregate. Finding:
`{ agent, from, to, agreement, costOld, costNew, savingsPerMo, fidelity, forkIds }`.
`savingsPerMo` = mean per-call cost delta × the agent's observed calls/month (from `store` cumulative
+ rate). `fidelity` flags cross-provider tool-translation gaps.

### 7. Savings Report
- `POST /api/savings { workflow, agent?, targets[] }` → starts a bounded job, returns `{ id }`.
- `GET /api/savings?id=` (or SSE) → `{ status, findings }`.
- A **report view** in `public/`: headline recoverable $/yr, an opportunity table sorted by
  `savingsPerMo`, each row linking into the existing replay/fork overlay as evidence.

## Data flow

`wrapped call → canonical request captured (opt-in) → stored on step`
… on demand:
`POST /api/savings → sample N calls → forkStep→target (translate + re-exec) → agreement score →
per-call cost delta × monthly volume → findings → report view`

## Testing

- `translate.test.js` — canonical → each provider's request shape (fixtures).
- `agreement.test.js` — JSON pair → structural score; text pair → judge path (judge injected/faked); identical text → 1.0.
- `fork` faithful path — captured canonical request → correct translated target request, cost from usage (fake provider call).
- `savings.test.js` — sampled steps + faked forks → finding with correct cost delta and `savingsPerMo`.
- capture — an adapter normalizes a real provider request → canonical (both languages).

## Cross-cutting

- **Privacy:** request capture is opt-in, redaction-hooked, size-capped.
- **Cost transparency:** the report shows the analysis's own fork spend.
- **No %-of-savings billing.** No change is ever auto-applied — advisory only.
- **Judge non-determinism** bounded by sampling + the partner's pass bar.

## Non-goals (M1)

Continuous background analysis (report is on-demand); context ROI / regression (M2/M4 reuse this
substrate); cross-provider **tool** translation (flagged, not silently wrong); auto-apply; streaming.

## Dependencies added

None mandatory in the tracer core (capture is opt-in, zero-dep). Server-side fork uses `fetch` to
provider REST endpoints (zero-dep, as `fork.js` already does). Judge is a provider call, no new SDK.
