import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { forkStep } from './fork.js';

const PORT = process.env.PORT || 4700;
const PUB = join(dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const store = createStore();
const sseClients = new Set();

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
        const { id, step, model } = JSON.parse(body);
        const t = store.getTrace(id);
        const result = await forkStep(t && t.steps[step], model);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(e.code === 'NO_KEY' ? 501 : 400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message }));
      }
    });
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
