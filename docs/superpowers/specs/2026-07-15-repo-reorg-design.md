# Repo Reorganization — Design

**Date:** 2026-07-15
**Status:** Approved (design), pending implementation plan
**Scope:** Structural only. No behavior change, no new dependencies, no functional gain —
navigability only. This is the first of two sub-projects; the second (dashboard
truthfulness + fleet visibility + Savings-tab IA) is where the user-visible wins are
and gets its own spec.

## Problem

24 `.js` files sit flat in the repo root — 12 modules plus their 12 co-located tests —
mixing three distinct kinds of code:

- **Control plane:** `server.js` (274 lines), `store.js` (356)
- **Pure analysis engines:** `pathology`, `savings`, `shadow`, `yield`, `contextroi`,
  `regression`, `agreement` — all small, all the same shape (pure, injected deps,
  unit-tested, no I/O)
- **Provider plumbing:** `fork.js`, `judge.js` (both do real network calls),
  `translate.js` (a 3-line shim re-exporting `sdk/node/translate.js`)

`sdk/`, `public/`, and `docs/` are already clean. `.gitignore` is correct and nothing
junky is tracked. The only real clutter is the flat root, and there is exactly one
obvious grouping: the 7 pure engines are genuinely one category.

## The move

Create `engines/` and `git mv` the 7 pure analysis engines plus their 7 tests
(14 files):

```
engines/{pathology,savings,shadow,yield,contextroi,regression,agreement}.js
engines/{pathology,savings,shadow,yield,contextroi,regression,agreement}.test.js
```

Use `git mv` so history follows the files.

**Result:** root drops from 24 `.js` files to 9 — `server.js`, `store.js` +
`store.test.js`, `fork.js` + `fork.test.js`, `judge.js` + `judge.test.js`,
`translate.js` + `translate.test.js`.

## Why exactly those 7

The split is **root = control plane + provider plumbing; `engines/` = pure analysis.**

- The 7 share one identity: pure analysis with injected dependencies, unit-tested,
  no network or clock. `engines/` matches the domain language already used throughout
  the specs ("the downgrade engine", "the rolling engine").
- `fork.js` and `judge.js` make real network calls — they are not pure engines.
- `translate.js` **must stay at the repo root**: it is a shim (`export * from
  './sdk/node/translate.js';`) that exists precisely so the control-plane importers
  resolve at that path. Moving it would defeat its only purpose.

`sdk/` is unaffected — no engine is imported by the SDK, so its self-containment
boundary is untouched.

## Import edits — 8 lines total

The import graph makes this small:

- **Unchanged:** intra-engine imports (`yield.js`, `contextroi.js`, `regression.js`
  → `./savings.js`) — they move together, so relative paths still resolve.
- **`engines/savings.js`** → `'../translate.js'` (the only engine reaching outside the
  group).
- **`store.js`** ×3 → `'./engines/pathology.js'`, `'./engines/yield.js'`,
  `'./engines/shadow.js'`.
- **`server.js`** ×4 → `'./engines/savings.js'`, `'./engines/agreement.js'`,
  `'./engines/contextroi.js'`, `'./engines/regression.js'`.
- The 7 test files move alongside their modules, so their `./x.js` imports stay valid.

## Verification — and one real hazard

**Use `npm test` (bare `node --test`), not an explicit glob.**

Bare `node --test` discovers test files recursively; it currently reports **95/95**,
identical to the explicit glob `node --test *.test.js sdk/node/*.test.js`. After the
move, that explicit glob would **silently skip every `engines/*.test.js` file** and
still exit green on a reduced count — a false pass that looks like success. This is the
only real hazard in the change, and the plan must pin `npm test` as the verification
command.

Success criteria:
- `npm test` → **95/95, 0 fail** (same count as before the move — no test lost).
- `node server.js` starts and serves (`curl localhost:4700/api/snapshot` → 200), proving
  the control-plane imports resolve.

## Non-goals

- **No behavior change.** Pure file moves + import-path edits.
- **Not moving** `fork.js`, `judge.js`, `translate.js`, `store.js`, `server.js`.
- **Not splitting** `public/app.js` (642 lines) or the 272 lines of inline CSS in
  `index.html` — pure churn with zero user-visible gain; left alone deliberately.
- **Not touching** `sdk/`, `docs/`, `examples/`, or `PLAN.md`.
- **No new directories** beyond `engines/` — resist further fragmentation; every
  remaining root module is small and belongs to one of two clear categories.

## Dependencies added

None.
