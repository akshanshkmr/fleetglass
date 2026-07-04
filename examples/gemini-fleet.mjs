// A real 3-agent research workflow on the Google Gemini API, traced into
// FleetGlass. Proves the pipeline is provider-agnostic: the tracer takes
// model/tokens/prompt directly, so nothing here is Claude-specific.
//
//   node ../server.js                 # dashboard on :4700 (from repo root: node server.js)
//   export GEMINI_API_KEY=...         # your key — never hardcode it
//   node gemini-fleet.mjs "your question"
//
// Zero dependencies — uses the raw generateContent REST endpoint via fetch.
// Model mix is deliberate: planner/writer on 2.5-pro, searcher on 2.5-flash,
// so the dashboard shows per-agent model + cost side by side.

import { createTracer } from '../tracer.js';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error('Set GEMINI_API_KEY in the environment first (e.g. export GEMINI_API_KEY=...).');
  process.exit(1);
}

const fg = createTracer(undefined, 'gemini-research'); // its own card in the fleet view

const QUESTION = process.argv[2] ||
  'A B2B SaaS company\'s trial-to-paid conversion dropped from 22% to 14% over one quarter. What are the most likely causes and what should they investigate first?';

async function gemini({ agent, model, system, user, parent, task }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: { maxOutputTokens: 1024 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Gemini ${model} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  const usage = data.usageMetadata || {};

  const spanId = task.chat({
    agent,
    parent,
    model: data.modelVersion || model,
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
    prompt: user,
    completion: text,
    context: { system, history: user },
  });

  console.log(`\n[${agent} · ${data.modelVersion || model} · ${usage.promptTokenCount || 0}→${usage.candidatesTokenCount || 0} tok]\n${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`);
  return { text, spanId };
}

const task = fg.startTask();
console.log(`task ${task.traceId.slice(0, 8)} — watch it at http://localhost:4700 (workflow: gemini-research)`);

// 1. Planner (Pro) breaks the question into an investigation plan
const plan = await gemini({
  task,
  agent: 'planner',
  model: 'gemini-2.5-pro',
  system: 'You plan analyses for a growth team. Break the question into at most three concrete investigation steps, each with the data you would pull. Be brief.',
  user: QUESTION,
});

// 2. Searcher (Flash) gathers candidate factors — handoff edge planner→searcher
const facts = await gemini({
  task,
  agent: 'searcher',
  model: 'gemini-2.5-flash',
  parent: plan.spanId,
  system: 'Given an investigation plan, list the concrete signals and metrics to check as compact JSON. JSON only.',
  user: `Question: ${QUESTION}\n\nPlan:\n${plan.text}`,
});
task.tool({
  agent: 'searcher',
  parent: plan.spanId,
  tool: 'metrics.lookup',
  input: QUESTION.slice(0, 160),
  output: facts.text.slice(0, 400),
});

// 3. Writer (Pro) produces the brief — handoff edge searcher→writer
await gemini({
  task,
  agent: 'writer',
  model: 'gemini-2.5-pro',
  parent: facts.spanId,
  system: 'Write a 4-sentence brief for the founder: the single most likely cause, the strongest supporting signal to check, one alternative hypothesis, and the first concrete action.',
  user: `Question: ${QUESTION}\n\nPlan:\n${plan.text}\n\nSignals to check:\n${facts.text}`,
});

await fg.flush();
console.log('\nDone. Open http://localhost:4700 → the "gemini-research" workflow card. Click it for the topology, per-agent Gemini cost, and a scrubbable replay.');
