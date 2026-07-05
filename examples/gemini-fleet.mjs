// Real 3-agent Gemini research workflow, onboarded to FleetGlass with the SDK:
// one wrap(), one agent() per role. No manual span mapping.
//
//   node ../server.js                  # dashboard on :4700 (from repo root: node server.js)
//   export GEMINI_API_KEY=...          # your key — never hardcode it
//   node gemini-fleet.mjs "your question"          # add --inflate to trigger the anomaly alert
import { GoogleGenAI } from '@google/genai';
import { createTracer } from '../sdk/node/index.js';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('Set GEMINI_API_KEY first.'); process.exit(1); }

const INFLATE = process.argv.includes('--inflate');
const QUESTION = process.argv.slice(2).filter((a) => a !== '--inflate')[0] ||
  "A B2B SaaS company's trial-to-paid conversion dropped from 22% to 14% in a quarter. Likely causes, and what to investigate first?";

const fg = createTracer({ workflow: 'gemini-research' });
const ai = fg.wrap(new GoogleGenAI({ apiKey: KEY }));

const ask = (model, systemInstruction, text) =>
  ai.models.generateContent({ model, contents: text, config: { systemInstruction, maxOutputTokens: 1024 } });

await fg.task(async () => {
  const plan = await fg.agent('planner', () =>
    ask('gemini-2.5-flash', 'Break the question into at most three concrete investigation steps. Be brief.', QUESTION));

  const facts = await fg.agent('searcher', async () => {
    const bloat = INFLATE ? `\n\n[full history]\n${(plan.text || '').repeat(40)}` : '';
    const r = await ask('gemini-2.5-flash', 'List the concrete signals/metrics to check. JSON only.', `Q: ${QUESTION}\nPlan:\n${plan.text}${bloat}`);
    fg.emitTool({ tool: 'metrics.lookup', input: QUESTION.slice(0, 160), output: (r.text || '').slice(0, 400) });
    return r;
  });

  await fg.agent('writer', () =>
    ask('gemini-2.5-flash', 'Write a 4-sentence founder brief: most likely cause, strongest signal to check, one alternative, first action.', `Q: ${QUESTION}\nPlan:\n${plan.text}\nSignals:\n${facts.text}`));
});

console.log('Done → http://localhost:4700 (workflow: gemini-research). Click the card for topology, per-agent Gemini cost, and replay.');
