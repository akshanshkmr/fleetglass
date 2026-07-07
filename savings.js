// savings.js — the model-downgrade engine. Samples an agent's real calls, forks
// each onto cheaper targets, scores agreement, and turns the cost delta into a
// dollar finding. Pure: fork + score are injected (real ones wired in the server).
import { providerOf } from './translate.js';

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);

export function sampleSteps(steps, n = 8) {
  return steps.filter((s) => s.kind === 'chat' && s.request?.messages?.length).slice(-n);
}

// Project the agent's monthly call volume from its retained steps and their real
// timespan — stable vs a 60-second snapshot count, and non-zero whenever there is
// history. Span floored at 1 minute so a tight burst doesn't over-extrapolate.
// ponytail: timespan heuristic; swap for a billing-accurate rate when volume matters.
export function projectCallsPerMonth(steps) {
  if (!steps || !steps.length) return 0;
  const first = steps[0].ts, last = steps[steps.length - 1].ts;
  const spanMin = last > first ? (last - first) / 60000 : 1;
  return Math.round((steps.length / Math.max(spanMin, 1)) * 60 * 24 * 30);
}

export async function analyze({ steps, agent, targets, callsPerMonth, fork, score, passBar = 0.95 }) {
  const sample = sampleSteps(steps);
  const originModel = sample[0]?.model;
  const findings = [];
  for (const target of targets) {
    const provider = target.provider || providerOf(target.model);
    const agreements = [];
    const oldCosts = [];
    const newCosts = [];
    for (const step of sample) {
      let r;
      try { r = await fork(step, target); } catch { continue; } // a failed fork drops the sample, not the run
      oldCosts.push(r.original.cost);
      newCosts.push(r.fork.cost);
      agreements.push((await score(r.original.completion, r.fork.completion)).score);
    }
    if (!agreements.length) continue;
    const agreement = mean(agreements);
    const costOld = mean(oldCosts);
    const costNew = mean(newCosts);
    findings.push({
      agent, from: originModel, to: target.model, provider,
      agreement, costOld, costNew,
      savingsPerMo: (costOld - costNew) * callsPerMonth,
      fidelity: providerOf(originModel) === provider ? 'exact' : 'cross-provider',
      pass: agreement >= passBar,
      samples: agreements.length,
    });
  }
  return findings.sort((x, y) => y.savingsPerMo - x.savingsPerMo);
}
