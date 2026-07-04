const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const CTX = [
  ['system', 'System prompt', 'var(--wire)'],
  ['history', 'History', 'var(--ok)'],
  ['retrieval', 'Retrieved docs', 'var(--violet)'],
  ['tools', 'Tool schemas', 'var(--money)'],
];

let selected = null;
let snap = null;

const money = (n) => '$' + (n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2));
const fmtTok = (n) => n.toLocaleString();

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

function renderGraph() {
  const svg = $('graph');
  const key = snap.agents.map((a) => a.name).sort().join() + '|' + snap.edges.map((e) => e.from + e.to).sort().join();
  const { pos, W, H } = layout(snap.agents, snap.edges);

  if (key !== topoKey) {
    topoKey = key;
    svg.textContent = '';
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    edgePaths = [];

    for (const e of snap.edges) {
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

    for (const a of snap.agents) {
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
      g.addEventListener('click', () => { selected = a.name; renderAll(); });
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selected = a.name; renderAll(); } });
      svg.appendChild(g);
    }
    const dotLayer = el('g', { id: 'dots' });
    svg.appendChild(dotLayer);
  }

  for (const ep of edgePaths) {
    const e = snap.edges.find((x) => x.from + '>' + x.to === ep.edge);
    ep.rpm = e ? e.rpm : 0;
    const label = svg.querySelector(`text[data-edge="${ep.edge}"]`);
    if (label) label.textContent = ep.rpm + '/min';
  }
  for (const g of svg.querySelectorAll('.gnode')) {
    const a = snap.agents.find((x) => x.name === g.dataset.agent);
    if (!a) continue;
    g.classList.toggle('sel', a.name === selected);
    g.classList.toggle('hot', a.alert);
    const meta = g.querySelector('.meta');
    meta.textContent = '';
    const model = document.createTextNode(a.model + ' · ');
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
  $('m-tasks').textContent = snap.totals.tasksPerMin;
  const alerts = $('m-alerts');
  alerts.textContent = snap.totals.alerts;
  alerts.classList.toggle('hot', snap.totals.alerts > 0);
}

function renderCosts() {
  const box = $('costs');
  if (!snap.agents.length) return;
  box.className = '';
  box.textContent = '';
  const max = Math.max(...snap.agents.map((a) => a.spend), 1e-9);
  for (const a of snap.agents) {
    const row = document.createElement('div');
    row.className = 'costrow';
    row.innerHTML = `<span>${a.name}</span><div><div class="bar${a.alert ? ' hot' : ''}" style="width:${Math.max(2, (a.spend / max) * 100)}%"></div></div><span class="amt${a.alert ? ' hot' : ''}"><b>${money(a.spend)}</b> · ${money(a.costPerCall)}/call</span>`;
    box.appendChild(row);
  }
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
    div.innerHTML = `<time>${since}</time><span><b>${al.agent}</b> cost/call ×${al.ratio} vs baseline — check the last prompt or model change</span>`;
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

function renderCtx() {
  const agent = snap.agents.find((a) => a.name === selected) || snap.agents[0];
  if (!agent || !agent.ctx) return;
  selected = agent.name;
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
async function renderTasks() {
  const list = await (await fetch('/api/traces')).json();
  if (!list.length) return;
  const box = $('tasks');
  box.className = '';
  box.textContent = '';
  for (const t of list.slice(0, 8)) {
    const row = document.createElement('button');
    row.className = 'taskrow';
    row.innerHTML = `<span>${new Date(t.start).toISOString().slice(11, 19)}</span><span class="id">${t.id.slice(0, 8)}</span><span class="agents">${t.agents.join(' → ')}</span><span class="steps">${t.steps} st</span><span class="cost">${money(t.cost)}</span>`;
    row.addEventListener('click', () => openReplay(t.id));
    box.appendChild(row);
  }
}

let replay = null; // {trace, idx}

async function openReplay(id) {
  const res = await fetch('/api/trace?id=' + id);
  if (!res.ok) return;
  replay = { trace: await res.json(), idx: 0 };
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
  $('replay-title').textContent = `Replay — task ${trace.id.slice(0, 8)}`;
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
  } else {
    block('Tool input', step.input);
    block('Tool output', step.output);
  }
}

$('replay-close').addEventListener('click', closeReplay);
$('replay').addEventListener('click', (e) => { if (e.target === $('replay')) closeReplay(); });
$('replay-scrub').addEventListener('input', (e) => { if (replay) { replay.idx = Number(e.target.value); renderReplay(); } });
document.addEventListener('keydown', (e) => {
  if (!replay) return;
  if (e.key === 'Escape') closeReplay();
  if (e.key === 'ArrowRight' && replay.idx < replay.trace.steps.length - 1) { replay.idx++; renderReplay(); }
  if (e.key === 'ArrowLeft' && replay.idx > 0) { replay.idx--; renderReplay(); }
});

function renderAll() {
  if (!snap || !snap.agents.length) return;
  renderMetrics();
  renderGraph();
  renderCosts();
  renderAlerts();
  renderCtx();
  renderTasks();
}

new EventSource('/api/stream').onmessage = (ev) => {
  snap = JSON.parse(ev.data);
  renderAll();
};
