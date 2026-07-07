// judge.js — an LLM-as-judge for output agreement. Reuses translate.js to call
// any provider; returns a clamped 0–1 agreement score. Injectable `call` for tests.
import { toProvider, parseResponse, providerOf } from './translate.js';
import { httpCall } from './fork.js';

const RUBRIC = 'You compare two AI answers to the same request and rate how equivalent they are in meaning and quality, from 0 (completely different / worse) to 1 (equivalent). Reply with ONLY a decimal number between 0 and 1.';

export function makeJudge({ model, key, call = httpCall }) {
  const provider = providerOf(model);
  return async (a, b) => {
    const canonical = { system: RUBRIC, messages: [{ role: 'user', content: `Answer A:\n${a}\n\nAnswer B:\n${b}\n\nAgreement score (0-1):` }] };
    const { url, headers, body } = toProvider(canonical, { provider, model, maxTokens: 24, key });
    const data = await call(url, headers, body);
    const { completion } = parseResponse(provider, data);
    const n = parseFloat(String(completion).match(/[0-9]*\.?[0-9]+/)?.[0]);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  };
}
