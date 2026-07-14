const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const CTX = [
  ['system', 'System prompt', 'var(--wire)'],
  ['history', 'History', 'var(--ok)'],
  ['retrieval', 'Retrieved docs', 'var(--violet)'],
  ['tools', 'Tool schemas', 'var(--money)'],
];

let snap = null;
let selectedWf = null;    // workflow name
let selectedAgent = null; // agent within the selected workflow

// Recoverable headline = always-on yield + on-demand engine results (annualized $).
// downgrade/context reset on workflow switch; yield refreshes every snapshot.
const recoverable = { yield: 0, downgrade: 0, context: 0 };
function renderRecoverable() {
  $('recoverable').textContent = '≈ ' + money(recoverable.yield + recoverable.downgrade + recoverable.context) + '/yr';
}
function showTab(name) {
  const obs = name === 'observe';
  $('tab-observe').hidden = !obs;
  $('tab-savings').hidden = obs;
  $('tab-btn-observe').classList.toggle('sel', obs);
  $('tab-btn-savings').classList.toggle('sel', !obs);
  $('tab-btn-observe').setAttribute('aria-selected', obs);
  $('tab-btn-savings').setAttribute('aria-selected', !obs);
}

const money = (n) => {
  if (n >= 100) return '$' + Math.round(n).toLocaleString();
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(3);   // cents
  return '$' + n.toFixed(4);                    // sub-cent (cheap models, per-call)
};
const fmtTok = (n) => n.toLocaleString();
const currentWf = () => snap.workflows.find((w) => w.name === selectedWf) || snap.workflows[0];

setInterval(() => {
  $('clock').textContent = new Date().toISOString().slice(11, 19) + ' UTC';
}, 1000);

// ---- layout: layer agents by longest path from roots ----
const NODE_W = 172, NODE_H = 58, COL_GAP = 118, ROW_GAP = 34, PAD = 12;

function layout(agents, edges) {
  const depth = Object.fromEntries(agents.map((a) => [a.name, 0]));
  for (let i = 0; i < 10; i++) {
    for (const e of edges) {
      if (depth[e.to] !== undefined && depth[e.from] !== undefined) {
        depth[e.to] = Math.max(depth[e.to], depth[e.from] + 1);
      }
    }
  }
  const cols = new Map();
  for (const a of [...agents].sort((x, y) => x.name.localeCompare(y.name))) {
    const d = depth[a.name] || 0;
    if (!cols.has(d)) cols.set(d, []);
    cols.get(d).push(a.name);
  }
  const maxRows = Math.max(...[...cols.values()].map((c) => c.length), 1);
  const H = maxRows * (NODE_H + ROW_GAP) - ROW_GAP + PAD * 2;
  const W = (cols.size) * (NODE_W + COL_GAP) - COL_GAP + PAD * 2;
  const pos = {};
  for (const [d, names] of cols) {
    const colH = names.length * (NODE_H + ROW_GAP) - ROW_GAP;
    names.forEach((n, i) => {
      pos[n] = { x: PAD + d * (NODE_W + COL_GAP), y: (H - colH) / 2 + i * (NODE_H + ROW_GAP) };
    });
  }
  return { pos, W, H };
}

// ---- graph rendering: static layer rebuilt on topology change, dots persistent ----
let topoKey = '';
let edgePaths = []; // {el, len, rpm, dots: [t...]}

function el(tag, attrs, cls) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (cls) e.setAttribute('class', cls);
  return e;
}

function renderGraph(wf) {
  const svg = $('graph');
  $('graph-title').textContent = `Agent topology — ${wf.name} — last 60s`;
  const key = wf.name + '|' + wf.agents.map((a) => a.name).sort().join() + '|' + wf.edges.map((e) => e.from + e.to).sort().join();
  const { pos, W, H } = layout(wf.agents, wf.edges);

  if (key !== topoKey) {
    topoKey = key;
    svg.textContent = '';
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    edgePaths = [];

    for (const e of wf.edges) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) continue;
      const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
      const mx = (x1 + x2) / 2;
      const path = el('path', { d: `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}` }, 'gedge');
      svg.appendChild(path);
      const label = el('text', { x: mx, y: (y1 + y2) / 2 - 7, 'text-anchor': 'middle' }, 'gelabel');
      label.dataset.edge = e.from + '>' + e.to;
      svg.appendChild(label);
      edgePaths.push({ el: path, len: path.getTotalLength(), rpm: e.rpm, dots: [], edge: e.from + '>' + e.to });
    }

    for (const a of wf.agents) {
      const p = pos[a.name];
      const g = el('g', { transform: `translate(${p.x} ${p.y})`, tabindex: 0, role: 'button', 'aria-label': `Inspect ${a.name}` }, 'gnode');
      g.dataset.agent = a.name;
      g.appendChild(el('rect', { width: NODE_W, height: NODE_H, rx: 4 }));
      g.appendChild(el('circle', { cx: 14, cy: 15, r: 3.5 }, 'livedot'));
      const name = el('text', { x: 26, y: 19 }, 'name');
      name.textContent = a.name;
      g.appendChild(name);
      const meta = el('text', { x: 14, y: 41 }, 'meta');
      g.appendChild(meta);
      g.addEventListener('click', () => { selectedAgent = a.name; renderAll(); });
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectedAgent = a.name; renderAll(); } });
      svg.appendChild(g);
    }
    const dotLayer = el('g', { id: 'dots' });
    svg.appendChild(dotLayer);
  }

  for (const ep of edgePaths) {
    const e = wf.edges.find((x) => x.from + '>' + x.to === ep.edge);
    ep.rpm = e ? e.rpm : 0;
    const label = svg.querySelector(`text[data-edge="${ep.edge}"]`);
    if (label) label.textContent = ep.rpm + '/min';
    ep.el.classList.toggle('patho', !!(e && e.pathology));
  }
  for (const g of svg.querySelectorAll('.gnode')) {
    const a = wf.agents.find((x) => x.name === g.dataset.agent);
    if (!a) continue;
    g.classList.toggle('sel', a.name === selectedAgent);
    g.classList.toggle('hot', a.alert);
    g.classList.toggle('patho', !!a.pathology);
    const meta = g.querySelector('.meta');
    meta.textContent = '';
    const model = document.createTextNode(a.model.replace(/^(claude|gemini)-/, '') + ' · ');
    const cost = document.createElementNS(SVGNS, 'tspan');
    cost.setAttribute('class', 'money');
    cost.textContent = money(a.spend);
    meta.appendChild(model);
    meta.appendChild(cost);
    if (a.alert) {
      const warn = document.createElementNS(SVGNS, 'tspan');
      warn.textContent = ' ▲';
      warn.setAttribute('fill', 'var(--signal)');
      meta.appendChild(warn);
    }
    g.querySelector('.livedot').style.opacity = a.live ? 1 : 0.15;
  }
}

// ---- flowing traffic dots (the signature) ----
let lastT = 0;
function animate(t) {
  const dt = Math.min((t - lastT) / 1000, 0.1);
  lastT = t;
  const layer = document.getElementById('dots');
  if (layer) {
    for (const ep of edgePaths) {
      const want = ep.rpm === 0 ? 0 : Math.min(1 + Math.floor(ep.rpm / 18), 5);
      while (ep.dots.length < want) ep.dots.push({ t: Math.random(), el: null });
      while (ep.dots.length > want) { const d = ep.dots.pop(); d.el?.remove(); }
      const speed = 0.25 + Math.min(ep.rpm / 120, 0.5);
      for (const d of ep.dots) {
        d.t = (d.t + dt * speed) % 1;
        if (!d.el) { d.el = el('circle', { r: 2 }, 'gdot'); layer.appendChild(d.el); }
        const p = ep.el.getPointAtLength(d.t * ep.len);
        d.el.setAttribute('cx', p.x);
        d.el.setAttribute('cy', p.y);
      }
    }
  }
  requestAnimationFrame(animate);
}
if (!reduced) requestAnimationFrame(animate);

// ---- panels ----
function renderMetrics() {
  $('m-spend').textContent = money(snap.totals.spend);
  $('m-calls').textContent = snap.totals.callsPerMin;
  $('m-wfs').textContent = snap.totals.workflows;
  const alerts = $('m-alerts');
  alerts.textContent = snap.totals.alerts;
  alerts.classList.toggle('hot', snap.totals.alerts > 0);
}

function renderWorkflows() {
  const box = $('workflows');
  box.className = '';
  box.textContent = '';
  for (const w of snap.workflows) {
    const card = document.createElement('button');
    card.className = 'wfcard' + (w.name === selectedWf ? ' sel' : '') + (w.alerts ? ' hot' : '');
    card.innerHTML = `<div class="name"><i class="${w.live ? '' : 'off'}"></i>${w.name}${w.alerts ? `<span class="warn">▲ ${w.alerts}</span>` : ''}</div>
      <div class="stats"><b>${money(w.spend)}</b> · ${w.callsPerMin}/min · ${w.agents.length} agents</div>`;
    card.addEventListener('click', () => {
      if (selectedWf !== w.name) {
        selectedWf = w.name; selectedAgent = null;
        recoverable.downgrade = 0; recoverable.context = 0; // on-demand results are per-workflow
        $('savings-out').textContent = ''; $('context-out').textContent = ''; $('regression-out').textContent = '';
      }
      renderAll();
    });
    box.appendChild(card);
  }
}

function renderCosts(wf) {
  const box = $('costs');
  if (!wf.agents.length) return;
  box.className = '';
  box.textContent = '';
  const max = Math.max(...wf.agents.map((a) => a.spend), 1e-9);
  for (const a of wf.agents) {
    const row = document.createElement('div');
    row.className = 'costrow';
    row.innerHTML = `<span>${a.name}</span><div><div class="bar${a.alert ? ' hot' : ''}" style="width:${Math.max(2, (a.spend / max) * 100)}%"></div></div><span class="amt${a.alert ? ' hot' : ''}"><b>${money(a.spend)}</b> · ${money(a.costPerCall)}/call</span>`;
    box.appendChild(row);
  }
}

function renderYield(wf) {
  const box = $('yield-out');
  const y = wf.yield || { cacheSavingsPerMo: 0, batchSavingsPerMo: 0 };
  const agents = wf.agents.filter((a) => a.yield);
  if (!agents.length || (!y.cacheSavingsPerMo && !y.batchSavingsPerMo)) {
    box.className = 'empty';
    box.textContent = 'No yield signal yet (needs context-breakdown traces).';
    return;
  }
  box.className = '';
  box.innerHTML = `<div class="yield-head">Prompt caching ${money(y.cacheSavingsPerMo)}/mo · Batch API ${money(y.batchSavingsPerMo)}/mo <span class="if">if latency-tolerant</span></div>` +
    agents.map((a) => `<div class="yield-row"><span>${a.name}</span><span class="tok">~${fmtTok(a.yield.cacheableTokens)} tok/call cacheable</span><span class="save">${money(a.yield.cacheSavingsPerMo)}/mo</span></div>`).join('') +
    `<div class="savings-note">Estimates — caching assumes a stable reused prefix; batch assumes latency-tolerant calls. Advisory, nothing applied.</div>`;
}

function renderAlerts() {
  const box = $('alerts');
  if (!snap.alerts.length) {
    box.className = 'empty';
    box.textContent = 'No anomalies. Baselines steady.';
    return;
  }
  box.className = '';
  box.textContent = '';
  for (const al of snap.alerts) {
    const div = document.createElement('div');
    div.className = 'alert';
    const since = new Date(al.since).toISOString().slice(11, 19);
    div.innerHTML = `<time>${since}</time><span><b>${al.workflow} / ${al.agent}</b> cost/call ×${al.ratio} vs baseline — check the last prompt or model change</span>`;
    box.appendChild(div);
  }
}

function renderPathologies(wf) {
  const panel = $('pathology-panel');
  const box = $('pathologies');
  const mine = (snap.pathologies || []).filter((p) => p.workflow === wf.name);
  panel.hidden = !mine.length;
  box.textContent = '';
  const label = { cycle: 'loop', retry: 'retry storm', spiral: 'context spiral' };
  for (const p of mine) {
    const div = document.createElement('div');
    div.className = 'patho';
    div.innerHTML = `<span class="k">${label[p.kind] || esc(p.kind)}</span><span class="d">${esc(p.detail)}</span><span class="c">${money(p.cost)} burned</span>`;
    const replay = document.createElement('button');
    replay.textContent = 'Replay';
    replay.addEventListener('click', () => openReplay(p.trace, p.step));
    const kill = document.createElement('button');
    kill.className = 'kill';
    kill.textContent = 'Kill';
    kill.addEventListener('click', async () => {
      kill.disabled = true;
      try {
        const res = await fetch('/api/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trace: p.trace }) });
        if (res.ok) { kill.textContent = 'killed'; } else { kill.disabled = false; }
      } catch { kill.disabled = false; }
    });
    div.append(replay, kill);
    box.appendChild(div);
  }
}

function buildCtx(ctx, box, withLegend = true) {
  const total = CTX.reduce((s, [k]) => s + (ctx[k] || 0), 0);
  if (!total) return 0;
  const bar = document.createElement('div');
  bar.className = 'ctxbar';
  const legend = document.createElement('div');
  legend.className = 'legend';
  for (const [k, label, color] of CTX) {
    const pct = ((ctx[k] || 0) / total) * 100;
    const seg = document.createElement('div');
    seg.style.cssText = `width:${pct}%;background:${color}`;
    bar.appendChild(seg);
    if (!withLegend) continue;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<i style="background:${color}"></i>${label}<span class="n">${fmtTok(ctx[k] || 0)} · ${Math.round(pct)}%</span>`;
    legend.appendChild(row);
  }
  box.appendChild(bar);
  if (withLegend) box.appendChild(legend);
  return total;
}

function renderCtx(wf) {
  const agent = wf.agents.find((a) => a.name === selectedAgent) || wf.agents[0];
  if (!agent || !agent.ctx) return;
  selectedAgent = agent.name;
  $('ctx-title').textContent = `Context window — ${agent.name}`;
  const box = $('ctx');
  box.className = '';
  box.textContent = '';
  const total = buildCtx(agent.ctx, box);
  if (!total) return;
  const foot = document.createElement('div');
  foot.id = 'ctxtotal';
  foot.innerHTML = `Latest call: <b>${fmtTok(total)}</b> input tokens · ${money(agent.costPerCall)}/call`;
  box.appendChild(foot);
}

// ---- recent tasks + replay ----
async function renderTasks(wf) {
  const wanted = wf.name;
  const list = await (await fetch('/api/traces')).json();
  if (selectedWf !== wanted) return; // selection changed mid-fetch — a later call owns the panel
  const mine = list.filter((t) => t.wf === wanted).slice(0, 8);
  const box = $('tasks');
  if (!mine.length) { box.className = 'empty'; box.textContent = 'No tasks yet for this workflow.'; return; }
  box.className = '';
  box.textContent = '';
  for (const t of mine) {
    const row = document.createElement('button');
    row.className = 'taskrow';
    row.innerHTML = `<span>${new Date(t.start).toISOString().slice(11, 19)}</span><span class="id">${t.id.slice(0, 8)}</span><span class="agents">${t.agents.join(' → ')}</span><span class="steps">${t.steps} st</span><span class="cost">${money(t.cost)}</span>`;
    row.addEventListener('click', () => openReplay(t.id));
    box.appendChild(row);
  }
}

let replay = null; // {trace, idx}

async function openReplay(id, stepIdx = 0) {
  const res = await fetch('/api/trace?id=' + id);
  if (!res.ok) return;
  const trace = await res.json();
  replay = { trace, idx: Math.max(0, Math.min(stepIdx, trace.steps.length - 1)) };
  $('replay').hidden = false;
  $('replay-scrub').max = replay.trace.steps.length - 1;
  renderReplay();
  $('replay-close').focus();
}

function closeReplay() {
  replay = null;
  $('replay').hidden = true;
}

function renderReplay() {
  const { trace, idx } = replay;
  const step = trace.steps[idx];
  $('replay-title').textContent = `Replay — ${trace.wf} · task ${trace.id.slice(0, 8)}`;
  $('replay-cost').textContent = money(trace.steps.reduce((s, x) => s + (x.cost || 0), 0)) + ' total';
  $('replay-scrub').value = idx;

  const steps = $('replay-steps');
  steps.textContent = '';
  const agents = [...new Set(trace.steps.map((s) => s.agent))].sort();
  const HUES = ['var(--wire)', 'var(--ok)', 'var(--violet)', 'var(--money)', 'var(--signal)'];
  trace.steps.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'stepdot' + (i === idx ? ' cur' : '');
    b.style.borderLeftColor = HUES[agents.indexOf(s.agent) % HUES.length];
    b.textContent = `${i + 1} · ${s.agent}${s.kind === 'tool' ? ' · ' + s.tool : ''}`;
    b.addEventListener('click', () => { replay.idx = i; renderReplay(); });
    steps.appendChild(b);
  });

  const d = $('replay-detail');
  d.textContent = '';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const when = new Date(step.ts).toISOString().slice(11, 23);
  meta.innerHTML = step.kind === 'chat'
    ? `<span>agent <b>${step.agent}</b></span><span>model <b>${step.model}</b></span><span>tokens <b>${fmtTok(step.in)} → ${fmtTok(step.out)}</b></span><span class="money">${money(step.cost)}</span><span>${when}</span>`
    : `<span>agent <b>${step.agent}</b></span><span>tool <b>${step.tool}</b></span><span>${when}</span>`;
  d.appendChild(meta);

  const block = (label, text) => {
    if (!text) return;
    const p = document.createElement('div');
    p.className = 'payload';
    p.innerHTML = `<div class="k">${label}</div>`;
    const pre = document.createElement('pre');
    pre.textContent = text;
    p.appendChild(pre);
    d.appendChild(p);
  };
  if (step.kind === 'chat') {
    block('What the agent saw — prompt', step.prompt);
    block('What it said — completion', step.completion);
    const ctxWrap = document.createElement('div');
    ctxWrap.className = 'payload';
    ctxWrap.innerHTML = '<div class="k">Context window at this step</div>';
    buildCtx(step.ctx, ctxWrap, true);
    d.appendChild(ctxWrap);
    d.appendChild(forkPanel(trace.id, idx, step));
  } else {
    block('Tool input', step.input);
    block('Tool output', step.output);
  }
}

// fork-from-step: re-run this chat step's prompt live on another model, diff the result.
const FORK_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'gpt-4o-mini', 'gemini-2.5-flash'];

function forkPanel(traceId, idx, step) {
  const wrap = document.createElement('div');
  wrap.className = 'payload fork';
  const targets = FORK_MODELS.filter((m) => !step.model.startsWith(m));
  const sel = targets.map((m) => `<option value="${m}">${m}</option>`).join('');
  wrap.innerHTML = `<div class="k">Fork from step — re-run this prompt live</div>
    <div class="forkbar"><select class="forkmodel">${sel}</select><button class="forkgo">Fork ▸</button></div>
    <div class="forkout"></div>`;
  const out = wrap.querySelector('.forkout');
  wrap.querySelector('.forkgo').addEventListener('click', async () => {
    const model = wrap.querySelector('.forkmodel').value;
    out.innerHTML = `<div class="forknote">Re-running on ${model}…</div>`;
    let r;
    try {
      const res = await fetch('/api/fork', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: traceId, step: idx, model }) });
      r = await res.json();
      if (!res.ok) throw new Error(r.error || 'fork failed');
    } catch (e) {
      out.innerHTML = `<div class="forknote err">${e.message}</div>`;
      return;
    }
    const pct = r.original.cost ? Math.round((1 - r.fork.cost / r.original.cost) * 100) : 0;
    const cheaper = r.deltaCost < 0;
    out.innerHTML = `
      <div class="forkcmp">
        <div><div class="k">Original — ${r.original.model} · ${money(r.original.cost)}</div><pre>${esc(r.original.completion)}</pre></div>
        <div><div class="k">Fork — ${r.fork.model} · <span class="money">${money(r.fork.cost)}</span></div><pre>${esc(r.fork.completion)}</pre></div>
      </div>
      <div class="forknote ${cheaper ? 'good' : 'warn'}">${cheaper ? `${pct}% cheaper` : `${-pct}% costlier`} — ${money(Math.abs(r.deltaCost))}/call. Judge output agreement before you route.</div>`;
  });
  return wrap;
}

const esc = (s) => (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

let lastSavings = null; // { wf, findings } — so the delegated Route listener can look findings up by index

// savings report: sample recent calls, fork on cheaper models, judge agreement.
$('savings-run').addEventListener('click', async () => {
  const wf = selectedWf;
  const out = $('savings-out');
  out.innerHTML = '<div class="savings-note">Sampling real calls and forking on cheaper models…</div>';
  let job;
  try {
    const { id } = await (await fetch('/api/savings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow: wf }) })).json();
    for (let i = 0; i < 60; i++) {                    // poll up to ~60s
      await new Promise((r) => setTimeout(r, 1000));
      job = await (await fetch('/api/savings?id=' + id)).json();
      if (job.status !== 'running') break;
    }
  } catch (e) { out.innerHTML = `<div class="savings-note">${e.message}</div>`; return; }
  if (!job || job.status === 'error') { out.innerHTML = `<div class="savings-note">${job?.error || 'analysis failed'}</div>`; return; }
  if (!(job.findings || []).length) { out.innerHTML = `<div class="savings-note">No captured requests for <b>${job.agent || 'this agent'}</b> — enable <code>captureRequests</code> in the tracer (and set provider keys) so its calls can be sampled and forked.</div>`; return; }
  const pass = (job.findings || []).filter((f) => f.pass && f.savingsPerMo > 0);
  const yr = pass.reduce((s, f) => s + f.savingsPerMo, 0) * 12;
  recoverable.downgrade = yr; renderRecoverable();
  lastSavings = { wf, findings: job.findings || [] };
  out.innerHTML = `<div class="savings-head">Downgrade ≈ ${money(yr)}/yr · agent ${job.agent}</div>` +
    lastSavings.findings.map((f, i) => {
      const pct = Math.round(f.agreement * 100);
      const routable = f.pass && f.fidelity === 'exact';
      const btn = routable
        ? `<button class="route-btn" data-i="${i}">Route</button>`
        : `<button class="route-btn" disabled title="${f.pass ? 'cross-provider — needs target key' : 'below agreement bar'}">Route</button>`;
      return `<div class="savings-row"><span>${(f.from || '?').replace(/^(claude|gemini)-/, '')} → ${(f.to || '?').replace(/^(claude|gemini)-/, '')}${f.fidelity === 'cross-provider' ? ' ~' : ''}</span>` +
        `<span class="agree ${f.pass ? '' : 'warn'}">${pct}%</span>` +
        `<span class="save">${money(f.savingsPerMo)}/mo</span>${btn}<button class="shadow-btn" data-i="${i}">Shadow</button></div>`;
    }).join('') +
    `<div class="savings-note">~ = cross-provider (tools dropped). Agreement on ${(job.findings?.[0]?.samples) || 0} sampled calls. Route flips a same-provider pass live; click again to revert.</div>`;
});

// Route button (delegated — savings-out is re-rendered each run; buttons carry only a numeric index).
$('savings-out').addEventListener('click', async (e) => {
  const btn = e.target.closest('.route-btn');
  if (!btn || btn.disabled || !lastSavings) return;
  const f = lastSavings.findings[+btn.dataset.i];
  if (!f) return;
  const routed = btn.dataset.routed === '1';
  btn.disabled = true;
  try {
    const res = await fetch('/api/route', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: lastSavings.wf, agent: f.agent, model: routed ? '' : f.to }) });
    if (res.ok) {
      btn.dataset.routed = routed ? '' : '1';
      btn.textContent = routed ? 'Route' : 'Routed → ' + (f.to || '').replace(/^(claude|gemini)-/, '');
    }
  } catch { /* leave button as-is */ }
  btn.disabled = false;
});

// Shadow button (delegated — same numeric-index pattern as Route).
$('savings-out').addEventListener('click', async (e) => {
  const btn = e.target.closest('.shadow-btn');
  if (!btn || !lastSavings) return;
  const f = lastSavings.findings[+btn.dataset.i];
  if (!f) return;
  const on = btn.dataset.on === '1';
  btn.disabled = true;
  try {
    const res = await fetch('/api/shadow', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: lastSavings.wf, agent: f.agent, model: on ? '' : f.to }) });
    if (res.ok) { btn.dataset.on = on ? '' : '1'; btn.textContent = on ? 'Shadow' : 'Shadowing'; }
  } catch { /* leave as-is */ }
  btn.disabled = false;
});

// context ROI report: re-run calls with each context segment (tools/system/history) removed.
$('context-run').addEventListener('click', async () => {
  const wf = selectedWf;
  const out = $('context-out');
  out.innerHTML = '<div class="savings-note">Re-running calls with each context segment removed…</div>';
  let job;
  try {
    const { id } = await (await fetch('/api/context-roi', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow: wf }) })).json();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      job = await (await fetch('/api/context-roi?id=' + id)).json();
      if (job.status !== 'running') break;
    }
  } catch (e) { out.innerHTML = `<div class="savings-note">${e.message}</div>`; return; }
  if (!job || job.status === 'error') { out.innerHTML = `<div class="savings-note">${job?.error || 'analysis failed'}</div>`; return; }
  if (!(job.findings || []).length) { out.innerHTML = `<div class="savings-note">No captured requests for <b>${job.agent || 'this agent'}</b> — enable <code>captureRequests</code> in the tracer (and set provider keys) so its context can be ablated.</div>`; return; }
  const pass = (job.findings || []).filter((f) => f.pass && f.savingsPerMo > 0);
  const yr = pass.reduce((s, f) => s + f.savingsPerMo, 0) * 12;
  recoverable.context = yr; renderRecoverable();
  out.innerHTML = `<div class="context-head">Trimmable ≈ ${money(yr)}/yr · agent ${job.agent}</div>` +
    (job.findings || []).map((f) => {
      const pct = Math.round(f.agreement * 100);
      return `<div class="savings-row"><span>drop ${f.segment}</span>` +
        `<span class="agree ${f.pass ? '' : 'warn'}">${pct}%</span>` +
        `<span class="save">${money(f.savingsPerMo)}/mo</span></div>`;
    }).join('') +
    `<div class="savings-note">A below-bar segment changes output if removed — keep it. Advisory only.</div>`;
});

// prompt regression: fork a system-swapped step on the same model, score baseline vs new.
$('regression-run').addEventListener('click', async () => {
  const wf = selectedWf;
  const newSystem = $('regression-input').value;
  const out = $('regression-out');
  if (!newSystem.trim()) { out.innerHTML = '<div class="savings-note">Paste a proposed system prompt first.</div>'; return; }
  out.innerHTML = '<div class="savings-note">Re-running the golden set with the new prompt…</div>';
  let job;
  try {
    const { id } = await (await fetch('/api/regression', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow: wf, newSystem }) })).json();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      job = await (await fetch('/api/regression?id=' + id)).json();
      if (job.status !== 'running') break;
    }
  } catch (e) { out.innerHTML = `<div class="savings-note">${e.message}</div>`; return; }
  if (!job || job.status === 'error') { out.innerHTML = `<div class="savings-note">${job?.error || 'regression failed'}</div>`; return; }
  const r = job.result || {};
  if (!r.samples) { out.innerHTML = `<div class="savings-note">No captured requests for <b>${r.agent || 'this agent'}</b> — enable <code>captureRequests</code> in the tracer (and set provider keys) so its calls can be re-run.</div>`; return; }
  const pct = (x) => (x >= 0 ? '+' : '') + Math.round(x * 100) + '%';
  out.innerHTML = `<div class="regr-head">${r.changed} of ${r.samples} outputs changed · cost ${pct(r.costDeltaPct)} · length ${pct(r.lengthDeltaPct)} · agent ${r.agent}</div>` +
    (r.rows || []).map((row) => {
      const p = Math.round(row.agreement * 100);
      return `<div class="regr-row"><span class="agree ${row.agreement < 0.95 ? 'warn' : ''}">${p}% match</span>` +
        `<span class="snip">old: ${esc(row.baseline || '')}</span>` +
        `<span class="snip">new: ${esc(row.updated || '')}</span></div>`;
    }).join('') +
    `<div class="savings-note">Advisory — a low % means the new prompt changed that output; review before shipping. Nothing shipped.</div>`;
});

$('tab-btn-observe').addEventListener('click', () => showTab('observe'));
$('tab-btn-savings').addEventListener('click', () => showTab('savings'));

$('replay-close').addEventListener('click', closeReplay);
$('replay').addEventListener('click', (e) => { if (e.target === $('replay')) closeReplay(); });
$('replay-scrub').addEventListener('input', (e) => { if (replay) { replay.idx = Number(e.target.value); renderReplay(); } });
document.addEventListener('keydown', (e) => {
  if (!replay) return;
  if (e.key === 'Escape') closeReplay();
  if (e.key === 'ArrowRight' && replay.idx < replay.trace.steps.length - 1) { replay.idx++; renderReplay(); }
  if (e.key === 'ArrowLeft' && replay.idx > 0) { replay.idx--; renderReplay(); }
});

function renderShadows() {
  const panel = $('shadow-panel'), box = $('shadow-out');
  const list = (snap.shadows || []).filter((s) => s.workflow === selectedWf);
  panel.hidden = !list.length;
  box.innerHTML = list.map((s) => {
    const pct = Math.round((s.agreement || 0) * 100);
    const cls = s.status === 'drifting' ? 'warn' : '';
    const model = (s.model || '').replace(/^(claude|gemini)-/, '');
    return `<div class="savings-row"><span>${esc(s.agent)} → ${esc(model)}</span>` +
      `<span class="agree ${cls}">${s.runs ? pct + '%' : '—'}</span>` +
      `<span class="save ${cls}">${esc(s.status)} · ${s.samples || 0} samples</span></div>`;
  }).join('') +
    `<div class="savings-note">Re-verifies each candidate on fresh traffic every few minutes — this spends on forks + judge calls. Click <b>Shadow</b> on a finding again to stop.</div>`;
}

function renderAll() {
  if (!snap || !snap.workflows.length) return;
  const wf = currentWf();
  selectedWf = wf.name;
  renderMetrics();
  renderWorkflows();
  renderGraph(wf);
  renderCosts(wf);
  renderYield(wf);
  renderAlerts();
  renderPathologies(wf);
  renderCtx(wf);
  renderTasks(wf);
  renderShadows();
  recoverable.yield = ((wf.yield?.cacheSavingsPerMo || 0) + (wf.yield?.batchSavingsPerMo || 0)) * 12;
  renderRecoverable();
}

new EventSource('/api/stream').onmessage = (ev) => {
  snap = JSON.parse(ev.data);
  renderAll();
};
