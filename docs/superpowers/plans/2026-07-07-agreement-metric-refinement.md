# Agreement-Metric Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the structural agreement metric robust to cosmetic JSON drift (case, whitespace, markdown fences) so it stops reporting false disagreement.

**Architecture:** Two surgical, deterministic changes to `agreement.js` — strip markdown code fences before `JSON.parse`, and normalize string leaves before equality. No signature or dependency change; the judge fallback is untouched.

**Tech Stack:** Node ≥20 (ESM, `node:test`). Zero deps.

## Global Constraints

- Deterministic only — no new API calls, no judge escalation.
- No change to `score` / `structuralScore` signatures; behavior refinement only.
- Different JSON types stay distinct (`1` vs `"1"` do not match); only string leaves are case/whitespace-normalized.
- Work directly on `main` (this project pushes direct to main; do NOT branch). Commit per task.

---

### Task 1: Refine `agreement.js` (fence-strip + leaf normalization)

**Files:**
- Modify: `agreement.js` (`asJson`, `structuralScore`)
- Test: `agreement.test.js`

**Interfaces:**
- Consumes/Produces: unchanged public API — `structuralScore(a, b)`, `score(original, fork, { judge })`. Only internal behavior changes.

- [ ] **Step 1: Write the failing tests**

Append to `agreement.test.js`:
```js
test('structuralScore is case- and whitespace-insensitive on string leaves', () => {
  assert.equal(structuralScore({ category: 'Billing', p: ' high ' }, { category: 'billing', p: 'high' }), 1);
});

test('structuralScore keeps distinct types distinct (1 vs "1" do not match)', () => {
  assert.equal(structuralScore({ n: 1 }, { n: '1' }), 0);
});

test('score treats a markdown-fenced JSON reply as JSON (structural, judge not called)', async () => {
  let judged = false;
  const r = await score('```json\n{"x": 1}\n```', '{"x": 1}', { judge: async () => { judged = true; return 0; } });
  assert.equal(r.method, 'structural');
  assert.equal(r.score, 1);
  assert.equal(judged, false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test agreement.test.js`
Expected: FAIL — the case-insensitive test returns `0` (strict `===` on `'Billing'` vs `'billing'`), and the fenced-reply test currently falls to the judge (fences break `JSON.parse`) so `method` is `'judge'` and `judged` is `true`.

- [ ] **Step 3: Implement fence-stripping in `asJson`**

In `agreement.js`, replace the `asJson` function:
```js
function asJson(s) {
  const t = String(s).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch { return undefined; }
}
```

- [ ] **Step 4: Implement leaf normalization in `structuralScore`**

In `agreement.js`, replace `structuralScore`:
```js
export function structuralScore(a, b) {
  const la = leaves(a, '', {});
  const lb = leaves(b, '', {});
  const keys = Object.keys(la);
  if (!keys.length) return Object.keys(lb).length ? 0 : 1;
  const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
  const matched = keys.filter((k) => Object.prototype.hasOwnProperty.call(lb, k) && norm(lb[k]) === norm(la[k])).length;
  return matched / keys.length;
}
```

- [ ] **Step 5: Run to verify all pass**

Run: `node --test agreement.test.js`
Expected: PASS — the 3 new tests plus the existing 5 (identical JSON → 1, half-match → 0.5, JSON-both skips judge, free-text → judge, no-judge → none).

- [ ] **Step 6: Commit**

```bash
git add agreement.js agreement.test.js
git commit -m "fix: agreement metric tolerant of case/whitespace/json-fence drift"
```

---

## Self-Review

**Spec coverage:**
- Fence-strip in `asJson` → Task 1 Step 3. ✅
- Normalize string leaves (trim+lowercase), numbers/bools/null unchanged → Task 1 Step 4. ✅
- Distinct JSON types stay distinct → asserted by the `1` vs `"1"` test. ✅
- Judge fallback unchanged → not touched; regression covered by existing tests. ✅

**Placeholder scan:** none — complete code in every step.

**Type consistency:** `structuralScore`/`score`/`asJson`/`leaves` names unchanged from the shipped module; `norm` is a local helper.
