# Repo Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the 7 pure analysis engines (and their tests) into `engines/`, dropping the repo root from 24 `.js` files to 9. No behavior change.

**Architecture:** `root = control plane + provider plumbing; engines/ = pure analysis.` Pure file moves via `git mv` plus 8 import-path edits. The engines already import each other with relative paths and move together, so only the group's one outward import (`savings.js → translate.js`) and the two consumers (`store.js`, `server.js`) need editing.

**Tech Stack:** Node.js (built-in `node:test`), zero dependencies.

## Global Constraints

- **No behavior change.** File moves + import-path edits only. Do not refactor, rename, reformat, or "improve" any moved file's contents.
- **No new dependencies.**
- **Use `git mv`** (not `mv`) so history follows the files.
- **Verify with `npm test`, NEVER an explicit glob.** Bare `node --test` discovers recursively (currently **95/95**). The glob `node --test *.test.js sdk/node/*.test.js` would silently skip every `engines/*.test.js` after the move and still exit green on a reduced count — a false pass. `npm test` must report **95/95, 0 fail**.
- **Git:** this project commits straight to `main` (no PR/branch flow); rebase if the remote moved.
- **Commit trailer** on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## File Structure

- Create: `engines/` — the 7 pure engines + their 7 tests (14 files, moved).
- Modify: `engines/savings.js` (1 import), `store.js` (3 imports), `server.js` (4 imports).
- Untouched: `fork.js`, `judge.js`, `translate.js` (root shim — must stay at the root path), `sdk/`, `public/`, `docs/`, `examples/`, `PLAN.md`.

This is a single task: the move and the import edits are one atomic change — the repo does not run in between (a moved file with unpatched importers is a broken tree), so splitting them would produce a knowingly-red intermediate commit.

---

### Task 1: Move the 7 pure engines into `engines/` and repoint imports

**Files:**
- Create dir: `engines/`
- Move (via `git mv`, 14 files): `{pathology,savings,shadow,yield,contextroi,regression,agreement}.js` and `{pathology,savings,shadow,yield,contextroi,regression,agreement}.test.js` → `engines/`
- Modify: `engines/savings.js` (line 4), `store.js` (lines 7-9), `server.js` (lines 7, 9, 11, 12)

**Interfaces:**
- Consumes: nothing new.
- Produces: no API change whatsoever. Every module keeps its exact exports; only its path changes. `store.js` and `server.js` import the same names from `./engines/…` instead of `./…`.

- [ ] **Step 1: Record the baseline**

Run: `npm test`
Expected: `ℹ tests 95` / `ℹ pass 95` / `ℹ fail 0`. Note this number — it must be identical at the end.

- [ ] **Step 2: Move the 14 files with `git mv`**

```bash
mkdir -p engines
git mv pathology.js savings.js shadow.js yield.js contextroi.js regression.js agreement.js engines/
git mv pathology.test.js savings.test.js shadow.test.js yield.test.js contextroi.test.js regression.test.js agreement.test.js engines/
```

Verify the root is now clean:

```bash
ls -1 *.js
```
Expected exactly: `fork.js`, `fork.test.js`, `judge.js`, `judge.test.js`, `server.js`, `store.js`, `store.test.js`, `translate.js`, `translate.test.js` (9 files).

- [ ] **Step 3: Repoint the one engine that imports outside the group**

In `engines/savings.js`, change the import (line 4) from:

```js
import { providerOf } from './translate.js';
```

to:

```js
import { providerOf } from '../translate.js';
```

**Do not touch any other import in the moved files** — `yield.js`, `contextroi.js`, and `regression.js` import `./savings.js`, which still resolves correctly because they moved together. The 7 test files import their own module from `./x.js`, also still correct.

- [ ] **Step 4: Repoint `store.js` (3 imports)**

In `store.js`, change lines 7-9 from:

```js
import { detectPathologies } from './pathology.js';
import { agentYield } from './yield.js';
import { updateShadow, shadowStatus } from './shadow.js';
```

to:

```js
import { detectPathologies } from './engines/pathology.js';
import { agentYield } from './engines/yield.js';
import { updateShadow, shadowStatus } from './engines/shadow.js';
```

- [ ] **Step 5: Repoint `server.js` (4 imports)**

In `server.js`, change these four import lines (7, 9, 11, 12) from:

```js
import { analyze, projectCallsPerMonth } from './savings.js';
import { score as scoreFn } from './agreement.js';
import { analyzeContext } from './contextroi.js';
import { analyzeRegression } from './regression.js';
```

to:

```js
import { analyze, projectCallsPerMonth } from './engines/savings.js';
import { score as scoreFn } from './engines/agreement.js';
import { analyzeContext } from './engines/contextroi.js';
import { analyzeRegression } from './engines/regression.js';
```

(Leave `server.js`'s other imports — `./store.js`, `./fork.js`, `./judge.js`, `./translate.js` — exactly as they are.)

- [ ] **Step 6: Confirm no stale import paths remain**

```bash
grep -rn "from '\./\(pathology\|savings\|shadow\|yield\|contextroi\|regression\|agreement\)\.js'" *.js
```
Expected: **no output** from the repo root (only files inside `engines/` may import `./savings.js`, and this grep does not search there).

- [ ] **Step 7: Run the full suite — `npm test`, not a glob**

Run: `npm test`
Expected: `ℹ tests 95` / `ℹ pass 95` / `ℹ fail 0` — the **same 95** as Step 1. A lower count means test files were dropped from discovery, not that the move succeeded.

- [ ] **Step 8: Prove the control plane still boots**

```bash
pkill -f 'node server.js' 2>/dev/null; sleep 0.5
node server.js & SRV=$!; sleep 1.2
curl -s -o /dev/null -w '%{http_code}\n' localhost:4700/api/snapshot
kill $SRV 2>/dev/null
```
Expected: `200` — proves `server.js` and `store.js` resolve their new `./engines/…` paths at runtime (an import typo would crash on boot, which the unit tests alone would not catch).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: group the 7 pure analysis engines under engines/

root = control plane + provider plumbing; engines/ = pure analysis.
Pure moves + 8 import-path edits, no behavior change. Root drops 24 -> 9 .js files.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(`git add -A` so the renames are staged as renames alongside the import edits.)

---

## Final verification (after the task + review)

- [ ] **`npm test` → 95/95, 0 fail.**
- [ ] **`git show --stat HEAD`** shows the 14 files as **renames** (`R`), not delete+add — confirming history followed.
- [ ] **Push to `main`** (no PR): rebase if the remote moved, then `git push`.

## Self-Review (author checklist — completed)

- **Spec coverage:** the 7 engines + 7 tests moved to `engines/` via `git mv` ✓; the 8 import edits enumerated exactly (savings→`../translate.js`; store ×3; server ×4) ✓; `fork`/`judge`/`translate`/`store`/`server` explicitly left at root ✓; `npm test` pinned as the verification command with the false-green hazard called out ✓; root ends at 9 `.js` files ✓.
- **Placeholder scan:** none — every step has the literal command or the exact before/after code.
- **Consistency:** the "unchanged" claim for intra-engine imports is verified against the real graph (`yield`/`contextroi`/`regression` → `./savings.js`; the 7 tests → `./x.js`); `savings.js` is the only engine importing outward (`translate.js`), matching the single edit in Step 3.
- **Scope:** one task. The move and the import edits cannot be split without committing a knowingly-broken tree, and there is no second deliverable a reviewer could accept or reject independently.
- **Risk pinned:** Step 7 asserts the count must equal Step 1's baseline (95), which is what catches the false-green; Step 8 catches an import typo that unit tests would miss because nothing imports `server.js`.
