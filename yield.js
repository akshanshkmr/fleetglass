// yield.js — estimate recoverable spend from prompt caching + Batch API, from data
// the store already holds (context breakdown, cost, rate). No forking, no keys, no
// captured requests. Pure; inputPrice is passed in so there's no PRICES import cycle.
// ponytail: flat provider discounts; tune per provider if they diverge.
import { projectCallsPerMonth } from './savings.js';

const CACHE_SAVE_FRACTION = 0.9;  // cache reads ~10% of input price → 90% saved on the cached prefix
const BATCH_DISCOUNT = 0.5;       // Batch API ~50% off, if latency-tolerant

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);

export function agentYield(steps, inputPrice) {
  const chat = (steps || []).filter((s) => s.kind === 'chat');
  if (!chat.length) return null;
  const cacheableTokens = Math.round(mean(chat.map((s) => (s.ctx?.system || 0) + (s.ctx?.tools || 0))));
  const callsPerMonth = projectCallsPerMonth(chat);
  const spendPerMo = mean(chat.map((s) => s.cost || 0)) * callsPerMonth;
  return {
    cacheableTokens,
    cacheSavingsPerMo: cacheableTokens * callsPerMonth * inputPrice * CACHE_SAVE_FRACTION / 1e6,
    batchSavingsPerMo: spendPerMo * BATCH_DISCOUNT,
    spendPerMo,
  };
}
