// shadow.js — pure rolling-agreement engine for shadow-mode. Given the prior
// state and one analyze pass's agreement, return the smoothed state; derive a
// status from it. Time-free and deterministic — the store stamps timestamps.
// ponytail: EWMA + fixed thresholds; per-agent tuning if smoothing over/under-reacts.

export function updateShadow(state, sample, { alpha = 0.4 } = {}) {
  const prev = state || { agreement: 0, runs: 0, samples: 0 };
  const agreement = prev.runs === 0
    ? sample.agreement
    : alpha * sample.agreement + (1 - alpha) * prev.agreement;
  return { agreement, runs: prev.runs + 1, samples: prev.samples + (sample.samples || 0) };
}

export function shadowStatus(state, { bar = 0.95, minRuns = 3 } = {}) {
  const s = state || { agreement: 0, runs: 0 };
  if (s.runs < minRuns) return 'validating';
  return s.agreement >= bar ? 'passing' : 'drifting';
}
