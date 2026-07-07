// regression.js — prompt-change regression. Re-run an agent's real calls with a
// proposed new system prompt (same model) and report the blast radius vs the
// recorded baseline output. Pure: fork + score are injected. Reuses forkStep by
// forking a synthetic system-swapped step; no substrate change.
import { sampleSteps } from './savings.js';

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);

export async function analyzeRegression({ steps, agent, newSystem, callsPerMonth, fork, score, passBar = 0.95 }) {
  const sample = sampleSteps(steps);
  const rows = [];
  const oldCosts = [];
  const newCosts = [];
  const lenDeltas = [];
  for (const step of sample) {
    let r;
    try { r = await fork({ ...step, request: { ...step.request, system: newSystem } }, { model: step.model }); }
    catch { continue; }
    const baseline = r.original.completion || '';
    const updated = r.fork.completion || '';
    const agreement = (await score(baseline, updated)).score;
    oldCosts.push(r.original.cost);
    newCosts.push(r.fork.cost);
    lenDeltas.push(baseline.length ? (updated.length - baseline.length) / baseline.length : 0);
    rows.push({ agreement, baseline: baseline.slice(0, 200), updated: updated.slice(0, 200) });
  }
  const costOld = mean(oldCosts);
  const costNew = mean(newCosts);
  return {
    agent,
    samples: rows.length,
    meanAgreement: rows.length ? mean(rows.map((x) => x.agreement)) : 0,
    changed: rows.filter((x) => x.agreement < passBar).length,
    costOld,
    costNew,
    costDeltaPct: costOld ? (costNew - costOld) / costOld : 0,
    lengthDeltaPct: mean(lenDeltas),
    rows,
  };
}
