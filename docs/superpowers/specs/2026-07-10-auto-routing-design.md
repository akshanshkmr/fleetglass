# Evidence-Gated Auto-Routing (v1) — Design

**Date:** 2026-07-10
**Status:** Approved (design), pending implementation plan
**Program:** second "act" feature, after the kill-switch. The kill-switch proved
FleetGlass can *act* on a live call (throw to stop spend); auto-routing points the
same lever at cost — swap an agent to a cheaper, evidence-equivalent model. Reuses
the downgrade evidence engine (`savings.js`) and the kill-switch's delivery pattern
(server table → piggyback on `/v1/traces` response → in-path client acts).

## Goal

When the downgrade analysis proves a cheaper model is equivalent for an agent, a
human clicks **Route** and that agent's future `fg.chat` calls run on the cheaper
model — automatically, until unrouted. The saving realizes on live traffic and
shows up in cost/yield.

```
downgrade finding passes (agreement ≥ 0.95, same-provider)
  → human clicks Route → POST /api/route → server routing table
  → /v1/traces response piggybacks { routes } → client swaps the model per call
  → span carries the cheaper model → store prices it cheaper → savings visible
```

## Decisions (settled in brainstorming)

1. **Arming: human approves a passing finding.** The **Route** button enables only
   when `pass && fidelity === 'exact'`. Evidence-*gated* (dead until the evidence
   clears the bar), human-*confirmed* — same caution as the kill-switch's manual
   arm, the first time we ever *change* production calls. Auto-flip (`autoRoute`
   opt-in) is a later additive step (Non-goals).
2. **Same-provider only (v1).** The client holds one provider + one key. Routing
   opus→haiku reuses that key; cross-provider (claude→gemini) would need a second
   key the client was never given. Route only `fidelity: 'exact'` findings; show
   cross-provider findings with a disabled button + reason. Cross-provider routing
   is a separate increment (shadow-mode + multi-key).
3. **Delivery: reuse the kill channel.** The `/v1/traces` response already returns
   `{ killed }`; extend to `{ killed, routes }`. No new endpoint for delivery, no
   timer — the client already harvests that response after each per-call flush.

## Components

### 1. Store — routing table (`store.js`)

Add an in-memory `Map<string, string>` — key `"workflow/agent"`, value target model:
- `route(workflow, agent, model)` — set the route; an empty/falsy `model` **clears**
  it (unroute). Overwrites any existing route for that key.
- `routes()` — return the table as a plain object `{ "workflow/agent": model }`.

**No TTL** — unlike killed traces (which self-expire), a route is durable savings
and persists until explicitly cleared. In-memory, so lost on restart.
`ponytail:` note — persist alongside the store when the deploy/ClickHouse milestone
lands. Separate state from `snapshot()`; read only by the ingest response path.

### 2. Server — arm endpoint + piggyback (`server.js`)

- **`POST /api/route { workflow, agent, model }`** — validate non-object/missing
  body like the other routes (guard from commit `49839b0`); `workflow` and `agent`
  required non-empty strings; `model` optional string (absent/empty → clear).
  Call `store.route(workflow, agent, model)`, respond `{ ok: true }`.
- **`POST /v1/traces` response** — currently `{ killed: store.killed() }`. Extend to
  `{ killed: store.killed(), routes: store.routes() }`. Ingest semantics unchanged.

### 3. Dashboard — Route button (`public/app.js`)

The Savings panel renders downgrade findings (each with `agent, from, to,
agreement, savingsPerMo, pass, fidelity` — note the finding does **not** carry
`workflow`; the panel already knows the selected workflow from its own state, the
same value the Downgrade run was POSTed with). Add a **Route** button per finding:
- **Enabled** only when `finding.pass && finding.fidelity === 'exact'`.
- **Disabled** with title "cross-provider — needs target key" when
  `pass && fidelity !== 'exact'`; disabled with title "below agreement bar" when
  `!pass`.
- On click: `POST /api/route { workflow: <selected workflow>, agent: finding.agent,
  model: finding.to }`. On success the
  button shows active state ("Routed → <to>"); clicking again unroutes
  (`POST /api/route` with empty `model`). Escape any interpolated text with the
  existing `esc()` helper (commit `23d298f`).

Local button feedback only; the authoritative swap happens client-side in the agent
process. The routed agent's row auto-updates to the cheaper model on its own, since
new spans carry it.

### 4. Client — enforcement (`sdk/node/client.js`)

The client holds a per-instance `routeMap` (plain object, replaced wholesale on each
harvest — server-authoritative, like `killedSet`).

- **Harvest.** The client already reads `posted.killed` after each `tracer.flush()`.
  Also read `posted.routes` (guard: only assign when it is a non-null object) into
  `routeMap`.
- **Swap.** Before building the request in `guardedCall`, after the kill-check,
  resolve the effective model:
  ```
  const key = workflow + '/' + (currentFrame().agent || 'agent');
  const target = routeMap[key];
  const useModel = (target && providerOf(target) === provider) ? target : model;
  ```
  Same-provider guard: a cross-provider or unknown target is ignored — the call
  proceeds on the constructed `model`, never breaks. The existing `key` (API key) is
  reused unchanged. Pass `useModel` into `toProvider` and `emitChat` so the emitted
  span carries the **actual** model used.

`runCall` currently closes over the constructor `model`; it takes `useModel` as a
parameter (or `guardedCall` passes it) so the routed model flows to both the provider
request and the span. No other client surface changes.

## Data flow

```
downgrade job → finding { pass, fidelity:'exact', agent, to } → Route button
  → POST /api/route { workflow, agent, model } → store.route(...)

fg.chat (in a task):
  kill-check → resolve useModel from routeMap (same-provider guard)
  → toProvider(req, { provider, model: useModel, key }) → call
  → emitChat(model: useModel, ...) → flush → POST /v1/traces
  → response { killed, routes } → routeMap updated
```

## Error handling

- **Route resolution** is pure/local — cannot throw. Unknown/cross-provider target →
  ignored, call proceeds on the original model.
- **Provider error on the routed call** — throws normally (error inversion).
- **Telemetry error** (bad/failed response) — swallowed; `routeMap` simply doesn't
  refresh that cycle (existing `safePost`/harvest-guard semantics).
- **`POST /api/route` bad body** — guarded, `400`, no crash.

## The key limitation (why shadow-mode is next)

v1 routes on *offline* evidence: an 8-sample judge score over recorded calls. Live
traffic can drift from that sample after the flip. The human accepts that risk at
approval time. **Shadow-mode** — continuous forking of live traffic + a drift alarm
— is the natural follow-up that keeps a route honest, and it is also what unlocks
cross-provider routing (fresh live equivalence + multi-key). Out of scope here.

## Testing

- **Store** (`store.test.js`): `route` then `routes` returns `{ "wf/agent": model }`;
  an empty `model` clears the entry; a second `route` on the same key overwrites.
- **Server** (integration, per route convention — no route unit test): `POST
  /api/route` arms a route and a subsequent `/v1/traces` response includes it under
  `routes`; a malformed body returns `400`.
- **Client** (`sdk/node/client.test.js`, injected `call`, no network): with a route
  set for the active `workflow/agent` and a same-provider target, `fg.chat` builds
  the request for and emits the **target** model, reusing the key; a cross-provider
  target is ignored (original model used); no route → original model; the flush
  response's `routes` populates `routeMap` so a later call swaps.

## Non-goals (deferred)

- **Auto-flip** — `fleetglass({ autoRoute: true })` flipping on `pass` with no human.
  Additive once the bar is trusted.
- **Cross-provider routing** — needs a multi-key client + shadow-mode's live
  evidence. v1 gates the action to same-provider.
- **Per-call / conditional routing** — the route is per-agent, all-or-nothing.
- **Route persistence across restart** — in-memory; persist at the deploy milestone.
- **Shadow-mode** — the live-traffic evidence engine; separate sub-project.

## Dependencies added

None. Reuses `savings.js` (evidence), `store.js`, the `/v1/traces` ingest path, the
kill-switch's flush/harvest channel, and the client's `providerOf` + call path.
