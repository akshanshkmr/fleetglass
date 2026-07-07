import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { forkStep, keyFor } from './fork.js';
import { analyze, projectCallsPerMonth } from './savings.js';
import { makeJudge } from './judge.js';
import { score as scoreFn } from './agreement.js';
import { providerOf } from './translate.js';
import { analyzeContext } from './contextroi.js';

const PORT = process.env.PORT || 4700;
const PUB = join(dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const store = createStore();
const sseClients = new Set();
const savingsJobs = new Map(); // id -> { status, findings, error }
const contextJobs = new Map();
const DEFAULT_TARGETS = [{ model: 'claude-haiku-4-5' }, { model: 'gpt-4o-mini' }, { model: 'gemini-2.5-flash' }];
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'gemini-2.5-flash';

setInterval(() => {
  if (!sseClients.size) return;
  const data = `data: ${JSON.stringify(store.snapshot())}\n\n`;
  for (const res of sseClients) res.write(data);
}, 1500);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'POST' && url.pathname === '/v1/traces') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8e6) req.destroy(); });
    req.on('end', () => {
      try { store.ingest(JSON.parse(body)); } catch { res.writeHead(400).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/fork') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { id, step, model, provider } = JSON.parse(body);
        const t = store.getTrace(id);
        const result = await forkStep(t && t.steps[step], { provider, model });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(e.code === 'NO_KEY' ? 501 : 400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/savings') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let params; try { params = JSON.parse(body); } catch { res.writeHead(400).end('{}'); return; }
      const snap = store.snapshot();
      const wf = snap.workflows.find((w) => w.name === params.workflow);
      if (!wf) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown workflow' })); return; }
      const agentName = params.agent || (wf.agents[0] && wf.agents[0].name); // default: top-spend agent
      const agentRow = wf.agents.find((a) => a.name === agentName);
      if (!agentRow) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown agent' })); return; }
      const steps = store.agentSteps(params.workflow, agentName);
      const targets = (params.targets || DEFAULT_TARGETS).filter((t) => !steps[0] || t.model !== steps[0].model);
      const callsPerMonth = projectCallsPerMonth(steps);
      const judgeKey = keyFor(providerOf(JUDGE_MODEL));
      const judge = judgeKey ? makeJudge({ model: JUDGE_MODEL, key: judgeKey }) : null;
      const score = (a, b) => scoreFn(a, b, judge ? { judge } : {});

      const id = Math.random().toString(16).slice(2, 10);
      savingsJobs.set(id, { status: 'running' });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
      analyze({ steps, agent: agentName, targets, callsPerMonth, fork: forkStep, score })
        .then((findings) => savingsJobs.set(id, { status: 'done', agent: agentName, findings }))
        .catch((e) => savingsJobs.set(id, { status: 'error', error: e.message }));
    });
    return;
  }

  if (url.pathname === '/api/savings') { // GET poll
    const job = savingsJobs.get(url.searchParams.get('id'));
    if (!job) { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(job));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/context-roi') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let params; try { params = JSON.parse(body); } catch { res.writeHead(400).end('{}'); return; }
      const snap = store.snapshot();
      const wf = snap.workflows.find((w) => w.name === params.workflow);
      if (!wf) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown workflow' })); return; }
      const agentName = params.agent || (wf.agents[0] && wf.agents[0].name);
      const agentRow = wf.agents.find((a) => a.name === agentName);
      if (!agentRow) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown agent' })); return; }
      const steps = store.agentSteps(params.workflow, agentName);
      const callsPerMonth = projectCallsPerMonth(steps);
      const judgeKey = keyFor(providerOf(JUDGE_MODEL));
      const judge = judgeKey ? makeJudge({ model: JUDGE_MODEL, key: judgeKey }) : null;
      const score = (a, b) => scoreFn(a, b, judge ? { judge } : {});

      const id = Math.random().toString(16).slice(2, 10);
      contextJobs.set(id, { status: 'running' });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
      analyzeContext({ steps, agent: agentName, callsPerMonth, fork: forkStep, score })
        .then((findings) => contextJobs.set(id, { status: 'done', agent: agentName, findings }))
        .catch((e) => contextJobs.set(id, { status: 'error', error: e.message }));
    });
    return;
  }

  if (url.pathname === '/api/context-roi') { // GET poll
    const job = contextJobs.get(url.searchParams.get('id'));
    if (!job) { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(job));
    return;
  }

  if (url.pathname === '/api/traces') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(store.listTraces()));
    return;
  }

  if (url.pathname === '/api/trace') {
    const t = store.getTrace(url.searchParams.get('id'));
    if (!t) { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(t));
    return;
  }

  if (url.pathname === '/api/snapshot') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(store.snapshot()));
    return;
  }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(store.snapshot())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (file.includes('..')) { res.writeHead(403).end(); return; }
  try {
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(await readFile(join(PUB, file)));
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, () => console.log(`fleetglass control plane → http://localhost:${PORT}`));
