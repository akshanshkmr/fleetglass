// In-memory trace store. Ingests OTLP/JSON spans using GenAI semantic
// conventions and groups everything by workflow — the `service.name`
// resource attribute. One workflow = one agent system; the fleet view
// aggregates across all of them.
// ponytail: in-memory + 10min window; swap for ClickHouse when retention matters.

export const PRICES = {
  // $ per Mtok [input, output] — list prices as of mid-2026, adjust as needed
  'claude-fable-5': [10, 50],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-sonnet-5': [3, 15],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
  'gemini-2.5-pro': [1.25, 10],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-2.5-flash-lite': [0.1, 0.4],
  'gemini-2.0-flash': [0.1, 0.4],
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'o4-mini': [1.1, 4.4],
};
const DEFAULT_PRICE = [3, 15];

export function callCost(model, inTok, outTok) {
  // prefix match so dated snapshots (claude-haiku-4-5-20251001) still resolve
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  const [i, o] = key ? PRICES[key] : DEFAULT_PRICE;
  return (inTok * i + outTok * o) / 1e6;
}

function attr(span, key) {
  const a = (span.attributes || []).find((x) => x.key === key);
  if (!a || !a.value) return undefined;
  const v = a.value;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  return undefined;
}

const WINDOW_MS = 10 * 60 * 1000;
const RECENT_MS = 90 * 1000; // anomaly: recent window vs prior baseline
// ponytail: rolling baseline dilutes as a regression ages into it, so a sustained
// spike self-clears in ~10min; anchor baselines to deploy markers when that matters.
const ANOMALY_RATIO = 1.7;
const MIN_SAMPLES = 5;
const MAX_TRACES = 300;

export function createStore() {
  const spanAgent = new Map(); // spanId -> agent name, for cross-batch parent lookup
  const calls = []; // {ts, trace, wf, agent, model, in, out, cost, ctx}
  const links = []; // {ts, wf, from, to}
  const traces = new Map(); // traceId -> {start, wf, steps} — the replay record
  const cumulative = new Map(); // wf -> {spend, calls, agents: Map(name -> {spend, model})}
  const alertSince = new Map(); // "wf/agent" -> ts

  function bucket(wf) {
    let b = cumulative.get(wf);
    if (!b) {
      b = { spend: 0, calls: 0, agents: new Map() };
      cumulative.set(wf, b);
    }
    return b;
  }

  function addStep(traceId, wf, step) {
    let t = traces.get(traceId);
    if (!t) {
      t = { start: step.ts, wf, steps: [] };
      traces.set(traceId, t);
      if (traces.size > MAX_TRACES) traces.delete(traces.keys().next().value);
    }
    t.start = Math.min(t.start, step.ts);
    t.steps.push(step);
    t.steps.sort((a, b) => a.ts - b.ts);
  }

  function ingest(body) {
    for (const rs of body.resourceSpans || []) {
      const wf = (rs.resource?.attributes || []).find((a) => a.key === 'service.name')?.value?.stringValue || 'default';
      for (const ss of rs.scopeSpans || []) {
        for (const s of ss.spans || []) {
          const agent = attr(s, 'gen_ai.agent.name');
          if (!agent) continue;
          spanAgent.set(s.spanId, agent);
          const parent = s.parentSpanId && spanAgent.get(s.parentSpanId);
          const ts = Number(s.startTimeUnixNano) / 1e6;
          if (parent && parent !== agent) links.push({ ts, wf, from: parent, to: agent });

          const op = attr(s, 'gen_ai.operation.name');
          if (op === 'execute_tool') {
            addStep(s.traceId, wf, {
              ts, agent, kind: 'tool',
              tool: attr(s, 'gen_ai.tool.name') || 'tool',
              input: attr(s, 'fleetglass.tool.input') || '',
              output: attr(s, 'fleetglass.tool.output') || '',
            });
            continue;
          }
          if (op !== 'chat') continue;
          const model = attr(s, 'gen_ai.request.model') || 'unknown';
          const inTok = attr(s, 'gen_ai.usage.input_tokens') || 0;
          const outTok = attr(s, 'gen_ai.usage.output_tokens') || 0;
          const cost = callCost(model, inTok, outTok);
          const ctx = {
            system: attr(s, 'fleetglass.context.system_tokens') || 0,
            history: attr(s, 'fleetglass.context.history_tokens') || 0,
            retrieval: attr(s, 'fleetglass.context.retrieval_tokens') || 0,
            tools: attr(s, 'fleetglass.context.tools_tokens') || 0,
          };
          calls.push({ ts, trace: s.traceId, wf, agent, model, in: inTok, out: outTok, cost, ctx });
          const reqRaw = attr(s, 'fleetglass.request');
          let request;
          if (reqRaw) { try { request = JSON.parse(reqRaw); } catch { request = undefined; } }
          addStep(s.traceId, wf, {
            ts, agent, kind: 'chat', model, in: inTok, out: outTok, cost, ctx,
            prompt: attr(s, 'gen_ai.prompt') || '',
            completion: attr(s, 'gen_ai.completion') || '',
            request,
          });
          const cum = bucket(wf);
          cum.spend += cost;
          cum.calls += 1;
          const ca = cum.agents.get(agent) || { spend: 0, model };
          ca.spend += cost;
          ca.model = model;
          cum.agents.set(agent, ca);
        }
      }
    }
    // ponytail: unbounded span map trimmed by size; proper TTL when it matters
    if (spanAgent.size > 50000) {
      let drop = spanAgent.size - 25000;
      for (const k of spanAgent.keys()) { spanAgent.delete(k); if (--drop <= 0) break; }
    }
  }

  // return the whole retained set (<= MAX_TRACES); the client filters per
  // workflow, so a high-volume workflow must not starve a quiet one out of a
  // small global window.
  function listTraces(limit = MAX_TRACES) {
    return [...traces.entries()].slice(-limit).reverse().map(([id, t]) => ({
      id,
      wf: t.wf,
      start: t.start,
      steps: t.steps.length,
      agents: [...new Set(t.steps.map((s) => s.agent))],
      cost: t.steps.reduce((s, x) => s + (x.cost || 0), 0),
    }));
  }

  function getTrace(id) {
    const t = traces.get(id);
    return t ? { id, wf: t.wf, start: t.start, steps: t.steps } : null;
  }

  function prune(now) {
    const cut = now - WINDOW_MS;
    while (calls.length && calls[0].ts < cut) calls.shift();
    while (links.length && links[0].ts < cut) links.shift();
  }

  function snapshot(now = Date.now()) {
    prune(now);
    const minCut = now - 60 * 1000;
    const recentCut = now - RECENT_MS;

    // per-workflow live stats, seeded from cumulative so idle agents stay listed
    const wfStats = new Map();
    for (const [wf, cum] of cumulative) {
      const agents = new Map();
      for (const name of cum.agents.keys()) {
        agents.set(name, { recent: [], baseline: [], lastMin: 0, ctx: null, lastSeen: 0 });
      }
      wfStats.set(wf, { agents, tasks: new Set(), callsMin: 0 });
    }
    for (const c of calls) {
      const st = wfStats.get(c.wf);
      const a = st && st.agents.get(c.agent);
      if (!a) continue;
      if (c.ts >= recentCut) a.recent.push(c.cost);
      else a.baseline.push(c.cost);
      if (c.ts >= minCut) { a.lastMin += 1; st.callsMin += 1; st.tasks.add(c.trace); }
      a.ctx = c.ctx;
      a.lastSeen = Math.max(a.lastSeen, c.ts);
    }

    const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const alerts = [];
    const workflows = [];
    for (const [wf, st] of wfStats) {
      const cum = cumulative.get(wf);
      const agents = [];
      for (const [name, a] of st.agents) {
        let ratio = null;
        if (a.recent.length >= MIN_SAMPLES && a.baseline.length >= MIN_SAMPLES) {
          ratio = avg(a.recent) / avg(a.baseline);
        }
        const firing = ratio !== null && ratio >= ANOMALY_RATIO;
        const key = wf + '/' + name;
        if (firing && !alertSince.has(key)) alertSince.set(key, now);
        if (!firing) alertSince.delete(key);
        if (firing) alerts.push({ workflow: wf, agent: name, ratio: Math.round(ratio * 10) / 10, since: alertSince.get(key) });
        const ca = cum.agents.get(name);
        agents.push({
          name,
          model: ca.model,
          spend: ca.spend,
          callsPerMin: a.lastMin,
          costPerCall: a.recent.length ? avg(a.recent) : (a.baseline.length ? avg(a.baseline) : 0),
          ctx: a.ctx,
          live: now - a.lastSeen < 10 * 1000,
          alert: firing,
        });
      }
      agents.sort((x, y) => y.spend - x.spend);

      const edgeCount = new Map();
      for (const l of links) {
        if (l.wf !== wf || l.ts < minCut) continue;
        const k = l.from + ' ' + l.to;
        edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
      }
      const edges = [...edgeCount].map(([k, n]) => {
        const [from, to] = k.split(' ');
        return { from, to, rpm: n };
      });

      workflows.push({
        name: wf,
        spend: cum.spend,
        callsPerMin: st.callsMin,
        tasksPerMin: st.tasks.size,
        alerts: agents.filter((a) => a.alert).length,
        live: agents.some((a) => a.live),
        agents,
        edges,
      });
    }
    workflows.sort((x, y) => y.spend - x.spend);

    const sum = (f) => workflows.reduce((s, w) => s + f(w), 0);
    return {
      now,
      totals: {
        spend: sum((w) => w.spend),
        callsPerMin: sum((w) => w.callsPerMin),
        tasksPerMin: sum((w) => w.tasksPerMin),
        workflows: workflows.length,
        agents: sum((w) => w.agents.filter((a) => a.live).length),
        alerts: alerts.length,
      },
      workflows,
      alerts,
    };
  }

  return { ingest, snapshot, listTraces, getTrace };
}
