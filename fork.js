// fork.js — Phase 1 "fork-from-step": re-execute one recorded chat step live on a
// different model and compare completion + cost against the original. This is the
// trust engine for routing — "re-run step 12 on Haiku" before you believe a swap.
//
// Fidelity ceiling: the substrate captures a step's user prompt as text but system/
// history/retrieval only as token counts, so a fork is faithful to the prompt and
// approximate on hidden context.
// ponytail: prompt-only re-execution; record the full messages array in sdk/node/tracer.js
// for exact re-execution when counterfactual precision matters.

import { callCost } from './store.js';

// Only Claude models are forkable here — it's the one provider we hold a key for.
export const forkable = (model) => model.startsWith('claude-');

async function anthropicCall({ model, maxTokens, prompt }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { const e = new Error('ANTHROPIC_API_KEY not set on the control plane'); e.code = 'NO_KEY'; throw e; }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// `call` is injectable so the self-check runs without a network/key.
export async function forkStep(step, model, call = anthropicCall) {
  if (!step || step.kind !== 'chat') throw new Error('can only fork a chat step');
  if (!forkable(model)) throw new Error(`fork target must be a Claude model (no key for ${model})`);
  if (!step.prompt) throw new Error('step recorded no prompt text to re-run');

  const data = await call({ model, maxTokens: Math.max(256, Math.min(4096, step.out || 1024)), prompt: step.prompt });
  const completion = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const inTok = data.usage?.input_tokens || 0;
  const outTok = data.usage?.output_tokens || 0;
  const cost = callCost(model, inTok, outTok);
  return {
    prompt: step.prompt,
    original: { model: step.model, in: step.in, out: step.out, cost: step.cost, completion: step.completion },
    fork: { model, in: inTok, out: outTok, cost, completion },
    deltaCost: cost - step.cost,
  };
}

// self-check: node fork.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = async ({ model }) => ({
    content: [{ type: 'text', text: `re-run on ${model}` }],
    usage: { input_tokens: 1000, output_tokens: 200 },
  });
  const step = { kind: 'chat', model: 'claude-opus-4-8', in: 1000, out: 200, cost: callCost('claude-opus-4-8', 1000, 200), prompt: 'Summarize.', completion: 'orig' };
  const r = await forkStep(step, 'claude-haiku-4-5', fake);
  console.assert(r.fork.completion === 're-run on claude-haiku-4-5', 'completion shaped');
  console.assert(r.fork.cost === callCost('claude-haiku-4-5', 1000, 200), 'fork cost from usage');
  console.assert(r.deltaCost < 0, 'haiku cheaper than opus → negative delta');
  await forkStep({ kind: 'tool' }, 'claude-haiku-4-5', fake).then(() => console.assert(false, 'tool step must reject')).catch(() => {});
  await forkStep(step, 'gemini-2.5-flash', fake).then(() => console.assert(false, 'non-claude must reject')).catch(() => {});
  console.log('fork.js self-check ok');
}
