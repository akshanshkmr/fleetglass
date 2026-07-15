// pathology.js — detect runaway agent shapes from one task's trace, read-only.
// Pure: given a trace's ordered steps, return findings. Thresholds are the
// calibration knobs a minimal model can't infer — tune in the field.
// ponytail: threshold heuristics; per-model tuning if false positives bite.

const ACTIVE_MS = 120000;          // only scan tasks whose last step is this recent
const CYCLE_MAX_AGENTS = 3;        // ping-pong / triangle involve few agents
const CYCLE_MIN_HANDOFFS = 6;
const CYCLE_REPEAT = 3;            // the cycle n-gram must repeat this many times at the tail
const RETRY_MIN = 6;               // consecutive same-agent chat steps
const RETRY_WINDOW_MS = 120000;
const SPIRAL_MIN_STEPS = 5;
const SPIRAL_GROWTH_RATIO = 2.0;   // latest input >= 2x the earliest
const SPIRAL_FLOOR_TOK = 15000;    // ignore small growth

const fmtK = (n) => (n / 1000).toFixed(1) + 'K';
const sumCost = (steps) => steps.reduce((c, s) => c + (s.cost || 0), 0);

function tailRepeats(runs, period) {
  if (runs.length < period) return 0;
  const gram = runs.slice(-period);
  let reps = 0;
  for (let end = runs.length; end - period >= 0; end -= period) {
    const chunk = runs.slice(end - period, end);
    if (chunk.every((x, i) => x === gram[i])) reps++;
    else break;
  }
  return reps;
}

function detectCycle(steps) {
  const runs = [];
  const runStartStep = [];
  let prev = null;
  steps.forEach((s, i) => { if (s.agent !== prev) { runs.push(s.agent); runStartStep.push(i); prev = s.agent; } });
  const handoffs = runs.length - 1;
  if (new Set(runs).size > CYCLE_MAX_AGENTS || handoffs < CYCLE_MIN_HANDOFFS) return null;
  const period = [2, 3].find((p) => tailRepeats(runs, p) >= CYCLE_REPEAT);
  if (!period) return null;
  const tailStartRun = runs.length - period * tailRepeats(runs, period);
  const step = runStartStep[tailStartRun];
  const agents = [...new Set(runs.slice(tailStartRun))];
  return { kind: 'cycle', agents, detail: `${agents.join(' ⇄ ')} · ${handoffs} handoffs`, cost: sumCost(steps.slice(step)), since: steps[step].ts, step };
}

function detectRetry(steps) {
  let best = null;
  let i = 0;
  while (i < steps.length) {
    if (steps[i].kind !== 'chat') { i++; continue; }
    let j = i;
    while (j + 1 < steps.length && steps[j + 1].kind === 'chat' && steps[j + 1].agent === steps[i].agent) j++;
    const len = j - i + 1;
    const span = steps[j].ts - steps[i].ts;
    if (len >= RETRY_MIN && span <= RETRY_WINDOW_MS && (!best || len > best.len)) best = { i, j, len, span };
    i = j + 1;
  }
  if (!best) return null;
  const agent = steps[best.i].agent;
  return { kind: 'retry', agents: [agent], detail: `${agent} · ${best.len} calls in ${Math.round(best.span / 1000)}s`, cost: sumCost(steps.slice(best.i, best.j + 1)), since: steps[best.i].ts, step: best.i };
}

function detectSpiral(steps) {
  const chat = steps.filter((s) => s.kind === 'chat');
  if (chat.length < SPIRAL_MIN_STEPS) return null;
  const tail = chat.slice(-SPIRAL_MIN_STEPS);
  const ins = tail.map((s) => s.in || 0);
  const nondec = ins.every((v, i) => i === 0 || v >= ins[i - 1]);
  const earliest = ins[0], latest = ins[ins.length - 1];
  if (!(nondec && latest >= SPIRAL_GROWTH_RATIO * earliest && latest > SPIRAL_FLOOR_TOK)) return null;
  const last = tail[tail.length - 1];
  return { kind: 'spiral', agents: [last.agent], detail: `${fmtK(earliest)} → ${fmtK(latest)} tok over ${chat.length} steps`, cost: last.cost || 0, since: tail[0].ts, step: steps.indexOf(last) };
}

export function detectPathologies(trace, now = Date.now()) {
  const steps = trace.steps || [];
  if (!steps.length || now - steps[steps.length - 1].ts > ACTIVE_MS) return [];
  return [detectCycle(steps), detectRetry(steps), detectSpiral(steps)].filter(Boolean);
}
