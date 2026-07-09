# Unified Client — Design

**Date:** 2026-07-10
**Status:** Approved (design), pending implementation plan
**Program:** post-SDK direction. This is the on-ramp for the "act" features
(shadow-mode M5p2, kill-switch, evidence-gated auto-routing) — they need
FleetGlass in the critical path, and this client is that path. This milestone
ships **only** the client; the act-features are separate sub-projects.

## Goal

One provider-agnostic client that both runs the call and observes it:

```js
import { fleetglass } from 'fleetglass';        // sdk/node
const fg = fleetglass({ model: 'claude-sonnet-5', workflow: 'billing-bot' });
const r = await fg.chat('summarize this ticket');
// r.text, r.usage, r.model — and a fully-populated span already sent to the control plane
```

Today onboarding means: install a provider SDK, construct it, `fg.wrap()` it,
learn provider-native call shapes, and scaffold `fg.task`/`fg.agent`. The unified
client collapses that to `fleetglass({model}).chat(...)`.

## Key decision: REST, not provider SDKs

We already built the entire multi-provider live-call engine — it's packaged as
the *fork* (counterfactual) tool. `translate.js` turns a canonical
`{ system, messages, tools }` into each provider's REST request and parses the
response, pure and zero-dep; `fork.js` already calls it live. **The unified
client is that same call path, exposed forward-facing.**

So the client is REST-based (Option A), **not** a wrapper over official provider
SDKs (Option B, the earlier assumption):
- **Zero peer deps** — core stays truly zero-dep; no `npm install @anthropic-ai/sdk`.
- **Reuses tested code** — the fork engine already exercises `toProvider`/`parseResponse`.
- **Perfect span capture** — the client holds the canonical request in hand, so it
  emits a fully-populated span (context breakdown + captured request) with no
  per-provider extraction.

Trade-off accepted: we own request-shape maintenance as provider APIs evolve, and
streaming needs manual SSE (deferred, below).

## Components

### 1. `sdk/node/translate.js` (moved from repo root)

The pure, zero-dep provider-protocol layer legitimately belongs to the SDK (it is
"how to speak each provider"). Move `translate.js` → `sdk/node/translate.js`,
keeping `providerOf`, `toProvider`, `parseResponse`. Add `KEY_ENV` and
`keyFor(provider)` here (moved from `fork.js`) — both the client and fork need key
resolution, so it belongs with the protocol metadata.

Root keeps a one-line re-export shim so the 5 existing control-plane importers
(`fork.js`, `savings.js`, `judge.js`, `server.js`, `translate.test.js`) are
untouched:

```js
// translate.js (root)
export * from './sdk/node/translate.js';
```

`fork.js` drops its local `KEY_ENV`/`keyFor` and imports them from the translator
(via the root shim or directly). `translate.js` stays a leaf module (imports
nothing), so `sdk/node` remains self-contained — copying `sdk/node` alone still works.

### 2. `sdk/node/client.js` (new) — `fleetglass(opts)`

**Constructor** `fleetglass({ model, provider, key, workflow, agent, captureRequests, maxTokens, endpoint })`:
- `model` **required**. `provider` inferred via `providerOf(model)` if omitted;
  throw a clear error if it can't be inferred.
- `key` from `process.env` via `keyFor(provider)` if omitted; throw a clear error
  (`code: 'NO_KEY'`, like fork) if still missing.
- `workflow` default `'default'`; `agent` default `'agent'`.
- `captureRequests` default `false` — privacy at the trust boundary. Turning it on
  is what lets the fork-based savings engines (downgrade, context-ROI, regression)
  operate on these calls; documented in the client's doc comment.
- `maxTokens` optional constructor-level default.
- `endpoint` passes through to the tracer (default `FLEETGLASS_URL` /
  `http://localhost:4700/v1/traces`).

Internally constructs one `createTracer({ workflow, endpoint, captureRequests })`.

**Call surface** `await fg.chat(input, perCallOpts?)`:
- `input` is either a canonical `{ system, messages, tools }` object **or** a plain
  string (sugar → `{ messages: [{ role: 'user', content: input }] }`).
- `perCallOpts` is `{ maxTokens }` only in v1 (`system`/`tools` always come from
  `input`). `maxTokens` resolves per-call → constructor → default, clamped
  256–4096 (matches fork).
- Returns `{ text, usage: { inputTokens, outputTokens }, model, raw }`. **No cost** —
  cost is the control plane's job; the client reports tokens only.

**Flow** (per call):
```
req = normalize(input, perCallOpts)              // string|canonical → canonical
{url,headers,body} = toProvider(req, {provider, model, maxTokens, key})
data = await httpCall(url, headers, body)         // throws on non-2xx
{completion, inTok, outTok} = parseResponse(provider, data)
safeEmitChat(req, {model, inTok, outTok, completion})   // telemetry-safe
return { text: completion, usage: {inputTokens: inTok, outputTokens: outTok}, model, raw: data }
```

`httpCall` is a 4-line local `fetch`-and-throw in the client (not imported from
`fork.js`, which pulls in `store.js`/control-plane). The span emitted carries the
same shape as `wrap()`: `model`, `inputTokens`, `outputTokens`, `prompt` (last user
message), `completion`, `context {system, history, tools}`, and canonical `request`
(when `captureRequests`). So topology, cost, yield, pathology, and every savings
engine light up with no extra wiring.

### 3. Auto-wrap scoping

`fg.chat` ensures a task frame exists:
- If `currentFrame()` is set (user is inside `fg.task`/`fg.agent`), emit into it —
  real multi-agent topology preserved.
- If not, wrap the call in an implicit `tracer.task(() => tracer.agent(agentName, ...))`
  so a bare `await fg.chat(...)` just works.

The client re-exposes `task`/`agent` from its tracer (`fg.task`, `fg.agent`) for
users who want to name agents and draw topology.

### 4. `sdk/node/index.js`

Add `export { fleetglass } from './client.js';` alongside the existing
`createTracer`/`wrap` exports (additive — nothing removed).

## Error handling — the critical inversion

The tracer's rule is "telemetry must never break the agent" (`safeEmit` swallows).
The client is the **opposite**: it *is* the call path.
- **Provider/API error (non-2xx, network):** must **throw**. `httpCall` already does.
- **Telemetry error (emit fails):** swallowed — never breaks a successful call
  (`safeEmit` semantics around the emit only).
- **Missing key / unknown provider:** throw at construct/call with a clear message.

## Data flow

`fg.chat(canonical) → toProvider → fetch → parseResponse → emitChat (same span as wrap())
→ control plane → dashboard / savings engines`

## Testing

`sdk/node/client.test.js` (injected `call`, no network/key):
- string input → canonical single user message; canonical input passes through.
- builds the correct provider request for the model (delegates to `toProvider`).
- returns normalized `{ text, usage, model }` from a stubbed response.
- emits a chat span; with `captureRequests: true` the span carries the canonical `request`.
- auto-wrap: a bare `fg.chat` (no surrounding `fg.task`) still emits a span.
- a `call` that throws propagates out of `fg.chat` (not swallowed).
- missing key / unknown provider throws.

Moved `translate.test.js` keeps passing (import path unchanged via the root shim,
or repointed — either way green). Existing `fork.test.js` still green after
`keyFor` relocation.

## Non-goals (deferred)

- **Streaming** (`fg.stream`) — `translate.js` is single-shot; per-provider SSE +
  partial-span semantics are real work that unblocks nothing downstream. Add when a
  user needs token streaming.
- **Tool-call execution loops** — the client sends `tools` but does not run a
  multi-turn tool loop; the caller drives tool turns as separate `fg.chat` calls.
- **Multimodal / non-text content** — canonical capture is text-only (inherited
  `translate.js` limitation).
- **Retries / backoff** — caller's responsibility for now.
- **Act-features** — shadow-mode, kill-switch, routing. This client unblocks them;
  it does not include them.

## Dependencies added

None. Reuses `translate.js` (moved), `createTracer`, and a local `fetch`.
