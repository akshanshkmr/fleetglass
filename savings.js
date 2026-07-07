// savings.js — the model-downgrade engine. Samples an agent's real calls, forks
// each onto cheaper targets, scores agreement, and turns the cost delta into a
// dollar finding. Pure: fork + score are injected (real ones wired in the server).
import { providerOf } from './translate.js';

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);

export function sampleSteps(steps, n = 8) {
  return steps.filter((s) => s.kind === 'chat' && s.request?.messages?.length).slice(-n);
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
