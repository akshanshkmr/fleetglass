# Kill-Switch — Design

**Date:** 2026-07-10
**Status:** Approved (design), pending implementation plan
**Program:** first of the "act" features. Structural pathology detection
(`pathology.js`: `detectCycle`/`detectRetry`/`detectSpiral`, already shipped and
wired into the store snapshot + Structural-pathology panel) is the *detect* half.
The kill-switch is the first time FleetGlass *acts*: a human, seeing a firing
pathology, stops the runaway task before it burns more spend. This is unblocked
by the unified client (`sdk/node/client.js`) — `fg.chat` is now the critical
path that can refuse the next call.

## Goal

When a live task is looping/retrying/spiraling, a human clicks **Kill** on the
finding and the runaway stops: the next `fg.chat` in that task throws instead of
making a provider call. Detection stays automatic; the *act* has a human on the
trigger (the detectors are tuned heuristics, not ground truth — see Non-goals for
the later auto-arm path).

## Decisions (settled in brainstorming)

1. **Behavior: hard stop.** A killed `fg.chat` `throw`s an error with
   `code: 'KILLED'`. A thrown error is the one thing every caller already
   propagates, and a kill-switch must stop the runaway *without* its cooperation.
   Not a soft `{ killed: true }` flag (a runaway loop would ignore it).
2. **Arming: manual arm, automatic detect.** The server keeps detecting; the
   dashboard shows a **Kill** button on each finding; a human clicks it. Not
   fully-automatic arming — the first time we ever act on a heuristic, a human is
   on the trigger. (Opt-in `autoKill` is a later, additive step — Non-goals.)
3. **Signal delivery: piggyback on telemetry (no new GET, no timer).** The
   `/v1/traces` POST that already happens after each call carries the kill list
   back in its response. Refined so it works mid-task: the client flushes
   **per call**, not just at task end — a pathology can't fire without multiple
   steps, so there are always further calls to intercept.

## Components

### 1. Store — killed-set (`store.js`)

Add an in-memory `Set<traceId>` of killed tasks with:
- `kill(trace, now = Date.now())` — add `trace`, record the arm time.
- `killed(now)` — return the current killed trace ids, pruning entries older than
  `KILL_TTL_MS` (~10 min) so the set can't grow unbounded. A killed task throws
  and dies quickly; the entry only needs to outlive the task's in-flight calls.

`snapshot()` is unchanged. The killed-set is separate live state, read by the
ingest response path, not part of the aggregate.

### 2. Server — arm endpoint + piggyback response (`server.js`)

- **`POST /api/kill { trace }`** — validate `trace` is a non-empty string
  (guard non-object/missing body like the other job routes — commit `49839b0`),
  call `store.kill(trace)`, respond `{ ok: true }`. Unknown/stale trace ids are
  accepted silently (idempotent; the id simply prunes out later).
- **`POST /v1/traces` response** — currently an empty 200. Change to
  `200 { killed: [...traceIds] }` from `store.killed(now)`. Ingest semantics are
  otherwise unchanged; this only adds a response body.

### 3. Dashboard — Kill button (`public/app.js`, `public/index.html`)

The Structural-pathology panel already renders findings filtered to the selected
workflow, each carrying `{ workflow, trace, kind, detail, ... }`. Add a **Kill**
button per finding that `POST`s `{ trace: p.trace }` to `/api/kill`. On success,
mark the row killed (disable the button, label it "killed") — purely cosmetic
local feedback; the authoritative stop happens client-side in the agent process.
Escape any interpolated text with the existing `esc()` helper (commit `23d298f`).

### 4. Client — enforcement (`sdk/node/client.js`)

The client holds a per-instance `Set<traceId> killedSet`.

- **Telemetry `post`.** The client supplies its own `post(spans)` to the tracer:
  POST `spans` to `endpoint`, read `killed` from the JSON response, replace
  `killedSet` with it. Telemetry-safe: any network/parse error or non-array
  `killed` leaves `killedSet` unchanged and never throws (the existing
  `safePost` error-swallowing contract). This replaces the current pass-through
  `safePost` — same swallow semantics, now also harvesting the kill list.
- **Per-call flush.** After `runCall` emits its span, `fg.chat` `await`s
  `tracer.flush()` so the span POSTs immediately and `killedSet` refreshes on
  every call, in every mode (auto-wrap *and* a user-managed `fg.task`). Eager
  flush doesn't break topology: `parentSpanId` is threaded at emit time from
  `currentFrame()`, not at flush time. Guard against a wasted POST when the queue
  is already empty (flush is a no-op then).
- **Pre-call check.** Before building the provider request, `fg.chat` reads the
  active task's `traceId` (from the tracer's current frame) and, if it is in
  `killedSet`, throws:
  ```js
  const e = new Error('task killed by FleetGlass kill-switch');
  e.code = 'KILLED';
  throw e;
  ```
  No `toProvider`, no `httpCall`, no span, no spend. This rides the same
  error-inversion path as provider errors: throws propagate to the caller;
  telemetry errors stay swallowed.

The client reads the active trace id from `currentFrame().trace` — the tracer
already exposes `currentFrame()` (`sdk/node/tracer.js:8`) and threads `f.trace`
into every span (`:77`), so no tracer change is needed for this. Auto-wrap always
establishes a frame before the call, so `currentFrame()` is non-null at the check.

## Data flow

```
detector fires  →  panel shows finding  →  human clicks Kill
   → POST /api/kill { trace }  →  store.kill(trace)

fg.chat (call k):
   check killedSet ∌ trace  →  toProvider → httpCall → parseResponse
   → emitChat → await flush → POST /v1/traces
   → response { killed:[...] }  →  killedSet updated
fg.chat (call k+1):
   check killedSet ∋ trace  →  throw KILLED   (stopped, no spend)
```

Stop latency: one call after the human clicks (the intervening telemetry
round-trip), in every execution mode.

## Error handling

- **Killed:** `fg.chat` throws `code: 'KILLED'` — the caller's runaway unwinds.
- **Provider/API error:** unchanged — throws (error inversion).
- **Telemetry error** (POST fails, bad response, non-array `killed`): swallowed;
  `killedSet` simply doesn't refresh that cycle. Never breaks a call.
- **`POST /api/kill` with a bad body:** guarded, `400`, no crash.

## The one genuine non-case

A task that makes a single call and never calls again cannot be stopped
mid-flight — there's no "next call" to intercept. But that can't trigger a
pathology in the first place: `detectCycle`/`detectRetry`/`detectSpiral` all
require multiple steps. So it is out of scope by construction, not a gap.

## Testing

- **Store** (`store.test.js`): `kill` then `killed` returns the id; an entry
  older than `KILL_TTL_MS` is pruned out.
- **Server** (`server.test.js` or existing harness): `POST /api/kill { trace }`
  arms it and a subsequent `POST /v1/traces` response includes that trace id in
  `killed`; a malformed `/api/kill` body returns `400` without crashing.
- **Client** (`sdk/node/client.test.js`, injected `call`, no network): with the
  active trace in `killedSet`, `fg.chat` throws `KILLED` and the injected `call`
  is never invoked; with an empty set a normal call still returns its result;
  a `post` whose response carries `{ killed:[thisTrace] }` populates `killedSet`
  so the *next* `fg.chat` throws; a throwing/garbage `post` leaves the call
  working (telemetry-safe).

## Non-goals (deferred)

- **Auto-arm** — opt-in `fleetglass({ autoKill: true })` that arms on a firing
  pathology with no human. Additive once the thresholds are trusted in the field.
- **Unkill / resume UI** — a killed task throws and dies; entries self-prune.
  No resume in v1.
- **Cross-process kill** — a client can only stop tasks it is emitting (it checks
  its own active trace). Killing a task owned by a different process is not v1.
- **Shadow-mode / auto-routing** — the evidence→action pair, a separate
  sub-project. This ships only the kill-switch.

## Dependencies added

None. Reuses the store, the existing `/v1/traces` ingest path, the tracer's
flush/frame, and the client's error-inversion path.
