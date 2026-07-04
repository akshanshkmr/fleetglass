// A real 3-agent fleet on the Claude API, traced into FleetGlass.
//
//   node ../server.js          # dashboard on :4700 (from repo root: node server.js)
//   npm install && node claude-fleet.mjs
//
// Auth resolves from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
// `ant auth login` profile — the zero-arg client picks it up.
//
// Model mix is deliberate: the orchestrator/summarizer run on Opus and the
// extractor on Haiku, because per-agent model/cost visibility is what the
// dashboard demonstrates.

import Anthropic from '@anthropic-ai/sdk';
import { createTracer } from '../tracer.js';

const client = new Anthropic();
const fg = createTracer();

const QUESTION = process.argv[2] ||
  'Our checkout error rate jumped from 0.4% to 2.1% after yesterday\'s deploy of payment-service v3.2. What should we investigate first?';

async function ask({ agent, model, system, user, parent, task }) {
  const params = {
    model,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (model.startsWith('claude-opus')) params.thinking = { type: 'adaptive' };
  const response = await client.messages.create(params);
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const spanId = task.anthropic({
    agent, parent, params, response,
    context: { system, history: user },
  });
  console.log(`\n[${agent} · ${response.model} · ${response.usage.input_tokens}→${response.usage.output_tokens} tok]\n${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`);
  return { text, spanId };
}

const task = fg.startTask();
console.log(`task ${task.traceId.slice(0, 8)} — watch it at http://localhost:4700`);

// 1. Orchestrator (Opus) plans the investigation
const plan = await ask({
  task,
  agent: 'orchestrator',
  model: 'claude-opus-4-8',
  system: 'You are the orchestrator of an incident-response agent fleet. Break the incident into at most three concrete investigation steps and state which specialist handles each. Be brief.',
  user: QUESTION,
});

// 2. Extractor (Haiku) pulls structured facts — handoff edge orchestrator→extractor
const facts = await ask({
  task,
  agent: 'extractor',
  model: 'claude-haiku-4-5',
  parent: plan.spanId,
  system: 'Extract the concrete facts (services, versions, metrics, deltas, timestamps) from the incident description as compact JSON. JSON only.',
  user: QUESTION,
});
task.tool({
  agent: 'extractor',
  parent: plan.spanId,
  tool: 'parse_incident',
  input: QUESTION.slice(0, 200),
  output: facts.text.slice(0, 400),
});

// 3. Summarizer (Opus) writes the brief — handoff edge extractor→summarizer
await ask({
  task,
  agent: 'summarizer',
  model: 'claude-opus-4-8',
  parent: facts.spanId,
  system: 'Write a 4-sentence incident brief for the on-call engineer: what happened, the most likely cause, the first thing to check, and how to verify.',
  user: `Incident: ${QUESTION}\n\nOrchestrator plan:\n${plan.text}\n\nExtracted facts:\n${facts.text}`,
});

await fg.flush();
console.log('\nDone. The task is now in the dashboard: graph edges, per-agent cost, and a scrubbable replay under "Recent tasks".');
