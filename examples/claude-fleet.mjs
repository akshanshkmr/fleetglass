// Real 3-agent incident-response fleet on the Claude API, onboarded to FleetGlass
// with the SDK: one wrap(), one agent() per role. No manual span mapping.
//
//   node ../server.js                     # dashboard on :4700 (from repo root: node server.js)
//   export ANTHROPIC_API_KEY=sk-ant-...   # or `ant auth login` — the zero-arg client picks it up
//   node claude-fleet.mjs "your question"
//
// Model mix is deliberate: the orchestrator/summarizer run on Opus and the
// extractor on Haiku, because per-agent model/cost visibility is what the
// dashboard demonstrates.
import Anthropic from '@anthropic-ai/sdk';
import { createTracer } from '../sdk/node/index.js';

const QUESTION = process.argv[2] ||
  'Our checkout error rate jumped from 0.4% to 2.1% after yesterday\'s deploy of payment-service v3.2. What should we investigate first?';

const fg = createTracer({ workflow: 'incident-copilot' });
const ai = fg.wrap(new Anthropic());

const ask = (model, system, user) =>
  ai.messages.create({ model, max_tokens: 1024, system, messages: [{ role: 'user', content: user }] });

const textOf = (res) => res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

await fg.task(async () => {
  const plan = await fg.agent('orchestrator', () =>
    ask('claude-opus-4-8', 'You are the orchestrator of an incident-response agent fleet. Break the incident into at most three concrete investigation steps and state which specialist handles each. Be brief.', QUESTION));
  const planText = textOf(plan);

  const facts = await fg.agent('extractor', async () => {
    const r = await ask('claude-haiku-4-5', 'Extract the concrete facts (services, versions, metrics, deltas, timestamps) from the incident description as compact JSON. JSON only.', QUESTION);
    fg.emitTool({ tool: 'parse_incident', input: QUESTION.slice(0, 200), output: textOf(r).slice(0, 400) });
    return r;
  });
  const factsText = textOf(facts);

  await fg.agent('summarizer', () =>
    ask('claude-opus-4-8', 'Write a 4-sentence incident brief for the on-call engineer: what happened, the most likely cause, the first thing to check, and how to verify.', `Incident: ${QUESTION}\n\nOrchestrator plan:\n${planText}\n\nExtracted facts:\n${factsText}`));
});

console.log('Done → http://localhost:4700 (workflow: incident-copilot). Click the card for topology, per-agent cost, and replay.');
