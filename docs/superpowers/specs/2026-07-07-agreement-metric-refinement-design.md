# Agreement-Metric Refinement — Design

**Date:** 2026-07-07
**Status:** Approved (design), pending implementation plan

## Goal

Stop the structural agreement metric from reporting false disagreement on cosmetically-different
JSON. The live run showed `gemini-2.5-flash → gemini-2.5-flash-lite` at **0% agreement** despite
plausibly-equivalent classifications — because strict `===` on JSON leaves treats `"Billing"` vs
`"billing"` (and markdown-fenced replies) as total mismatch. This refinement makes the deterministic
path robust to cosmetic drift, improving both the M1 downgrade engine and M2 (which reuse the same
metric). Deterministic only — no new API calls.

## Scope

One module: `agreement.js`. No new files, no dependency, no interface change to `score`/`structuralScore`
signatures (behavior refinement only). The judge fallback for genuine free text is unchanged.

## Changes

### 1. `asJson` — tolerate markdown fences
Models often wrap JSON in ` ```json … ``` ` despite instructions. Before `JSON.parse`, strip a
leading fence (` ``` ` or ` ```json `) and a trailing fence, and trim. A fenced JSON reply then takes
the structural path instead of falling through to the judge.

```js
function asJson(s) {
  const t = String(s).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch { return undefined; }
}
```

### 2. `structuralScore` — normalize leaf values before compare
Compare normalized leaves so cosmetic string differences don't count as mismatch:
- strings → `.trim().toLowerCase()`
- numbers / booleans / null → unchanged (JS `===` already treats `1` and `1.0` as the equal number `1`).

```js
const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
// in the leaf comparison: norm(la[k]) === norm(lb[k])
```

`leaves` flattening and the fraction-of-`a`'s-leaves definition are unchanged; only the per-leaf
equality is normalized.

## Testing

Add to `agreement.test.js`:
- `structuralScore` with `{ category: 'Billing' }` vs `{ category: 'billing' }` → `1` (case-insensitive).
- `structuralScore` with `{ p: ' high ' }` vs `{ p: 'high' }` → `1` (whitespace-trimmed).
- `score` on a fenced reply `` "```json\n{\"x\":1}\n```" `` vs `'{"x": 1}'` → `method: 'structural'`, score `1`
  (fence stripped, judge not called).
- Regression: the existing five agreement tests still pass (identical JSON → 1, half-match → 0.5,
  free-text → judge, no-judge → none).

## Non-goals

- Judge-escalation on low structural scores (considered, declined — keeps the path deterministic and free).
- Semantic/embedding similarity for structured output.
- Number-string coercion (`1` vs `"1"`) — different JSON types stay distinct.

## Dependencies added

None.
