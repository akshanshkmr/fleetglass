# FleetGlass Savings Report — `<Company>`

**The artifact you hand a design partner.** Fill it after ingesting a sampled trace export.
Every finding needs a **dollar figure** and the **counterfactual** behind it — a number without
proof is a guess, and guesses die in procurement. Keep it to one page.

---

## Report — `<Company>`  ·  period `<start> – <end>`  ·  prepared `<date>`

**Current agent LLM spend:** `$<X>/mo` (`$<X×12>/yr`), across `<N>` workflows, `<M>` agents,
`<K>` tasks in the sample.

> ## Recoverable: **`$<TOTAL>/yr`** — `<pct>%` of current spend, at `≥<agree>%` output agreement.

### Top opportunities

| # | Opportunity | Mechanism | Evidence | Savings /mo | Effort |
|---|---|---|---|---|---|
| 1 | Downgrade `<agent>` step | `<expensive-model>` → `<cheaper-model>` | forked `<n>` real calls · `<a>%` agreement | `$<s1>` | low |
| 2 | Trim `<segment>` context | drop `<seg>` (`<t>K tok`), keep rest | ablation on `<n>` calls · `<a>%` agreement | `$<s2>` | low |
| 3 | Kill `<pathology>` | `<agent⇄agent>` loop / retry storm | `<c>` handoffs, `$<burn>` burned in sample | `$<s3>` | med |
| 4 | Batch + cache yield | batch-API + cache-aware scheduling | flat provider discount, no routing risk | `$<s4>` | low |

### Evidence detail (the part that closes)

- **#1 — model downgrade.** Re-ran `<n>` production `<agent>` calls on `<cheaper-model>` via
  fork-from-step. Output agreement `<a>%` (metric: `<define — e.g. semantic-equality judged by
  <model>, or exact-field-match on structured output>`). Cost/call `$<old>` → `$<new>`.
- **#2 — context ROI.** The `<seg>` segment is `<pct>%` of input tokens on `<agent>`; ablating it
  changed output on `<1-a>%` of sampled calls. Likely lost-in-the-middle filler.
- **#3 — runaway.** `<pattern>` detected in `<t>` tasks; each burned ~`$<per>` with no progress.
- **#4 — yield.** `<pct>%` of calls are batchable / cache-eligible; provider discount applies flat.

**Method & caveats:** findings are from a `<sample size>` sample of real traces, not full-duplicate
replay. Agreement is measured, not assumed; the `<agree>%` bar is yours to set. Savings assume
current volume holds. No change is applied to your production — this is advisory.

### The ask

Capturing this recurring — with monthly re-analysis, shadow-mode agreement tracking, and the
regression check before every prompt change — is the **`$<tier>/mo`** tier. On a `$<TOTAL>/yr`
finding, it pays for itself `<TOTAL/tier×12>×` over.

---

### How to run one (founder playbook)

1. **Get the traces.** Sampled OTLP export, or point their existing OTel exporter at a FleetGlass
   instance for a week (`gen_ai.*` semconv — no code change on their side).
2. **Compute the engines** (all from the substrate we built):
   - model downgrade → fork-from-step on the priciest agents' steps, diff output + cost.
   - context ROI → ablate each segment on a sample, measure agreement.
   - runaway → pathology detection over their traces (cost burned per pattern).
   - yield → count batchable/cacheable calls × provider discount.
3. **Define the agreement metric with them up front** — structured output → exact field match;
   free text → an LLM judge they trust. Their number, not ours.
4. **Lead with the total, prove with the counterfactual, ask for the tier.** Charge from day one —
   a free pilot proves nothing about willingness to pay.
5. **Target: 5 paid reports before writing more product.** If the number doesn't sell, no feature will.
