// fork.js — faithful, cross-provider fork-from-step: re-execute a recorded chat
// step's captured canonical request on any target provider/model, and compare
// completion + cost against the original. The counterfactual engine of the
// savings platform (M1+).
import { callCost } from './store.js';
import { toProvider, parseResponse, providerOf } from './translate.js';

const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY' };
export const keyFor = (provider) => process.env[KEY_ENV[provider]];

async function httpCall(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// `call` is injectable so tests run without a network/key.
export async function forkStep(step, target, call = httpCall) {
  if (!step || step.kind !== 'chat') throw new Error('can only fork a chat step');
  if (!step.request || !step.request.messages?.length) throw new Error('step has no captured request — enable captureRequests to fork faithfully');
  const model = target.model;
  const provider = target.provider || providerOf(model);
  if (!provider) throw new Error(`unknown provider for model ${model}`);
  const key = keyFor(provider);
  if (!key) { const e = new Error(`${KEY_ENV[provider]} not set on the control plane`); e.code = 'NO_KEY'; throw e; }

  const maxTokens = Math.max(256, Math.min(4096, step.out || 1024));
  const originProvider = providerOf(step.model);
  // tools schemas are provider-specific — drop them cross-provider rather than send a mismatched shape (400).
  // ponytail: same-provider keeps tools verbatim; faithful cross-provider tool translation is a later milestone.
  const req = (originProvider && originProvider !== provider) ? { ...step.request, tools: undefined } : step.request;
  const { url, headers, body } = toProvider(req, { provider, model, maxTokens, key });
  const data = await call(url, headers, body);
  const { completion, inTok, outTok } = parseResponse(provider, data);
  const cost = callCost(model, inTok, outTok);
  return {
    original: { model: step.model, in: step.in, out: step.out, cost: step.cost, completion: step.completion },
    fork: { provider, model, in: inTok, out: outTok, cost, completion },
    deltaCost: cost - step.cost,
  };
}
