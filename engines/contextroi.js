// contextroi.js — the context-ROI engine. For each ablatable context segment,
// re-run the agent's real calls with that segment removed (SAME model) and measure
// output agreement + cost delta. Reuses forkStep by forking a synthetic ablated step;
// no change to the fork/translate substrate.
import { sampleSteps } from './savings.js';

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);

// Ablation variants, emitted only when the segment is present and non-trivial.
export function ablations(request) {
  const out = [];
  if (request.tools) out.push({ segment: 'tools', request: { ...request, tools: undefined } });
  if (request.system) out.push({ segment: 'system', request: { ...request, system: '' } });
  if ((request.messages || []).length > 1) out.push({ segment: 'history', request: { ...request, messages: request.messages.slice(-1) } });
  return out;
}

export async function analyzeContext({ steps, agent, callsPerMonth, fork, score, passBar = 0.95 }) {
  const sample = sampleSteps(steps);
  const acc = new Map(); // segment -> { agreements, oldCosts, newCosts }
  for (const step of sample) {
    for (const { segment, request } of ablations(step.request || {})) {
      let r;
      try { r = await fork({ ...step, request }, { model: step.model }); } catch { continue; }
      const a = acc.get(segment) || { agreements: [], oldCosts: [], newCosts: [] };
      a.oldCosts.push(r.original.cost);
      a.newCosts.push(r.fork.cost);
      a.agreements.push((await score(r.original.completion, r.fork.completion)).score);
      acc.set(segment, a);
    }
  }
  const findings = [];
  for (const [segment, a] of acc) {
    if (!a.agreements.length) continue;
    const agreement = mean(a.agreements);
    const costOld = mean(a.oldCosts);
    const costNew = mean(a.newCosts);
    findings.push({ agent, segment, agreement, costOld, costNew, savingsPerMo: (costOld - costNew) * callsPerMonth, pass: agreement >= passBar, samples: a.agreements.length });
  }
  return findings.sort((x, y) => y.savingsPerMo - x.savingsPerMo);
}
