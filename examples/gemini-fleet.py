"""Real 3-agent Gemini research workflow onboarded to FleetGlass: one wrap(),
one agent() per role — no manual span mapping.

    python ../server.js ...            # (dashboard: from repo root run `node server.js`)
    pip install -r requirements.txt
    pip install -e ../sdk/python
    export GEMINI_API_KEY=...
    python gemini-fleet.py "your question"      # add --inflate to trigger the anomaly alert
"""
import os, sys
from google import genai
from fleetglass import Tracer

key = os.environ.get("GEMINI_API_KEY")
if not key:
    sys.exit("Set GEMINI_API_KEY first.")

inflate = "--inflate" in sys.argv
args = [a for a in sys.argv[1:] if a != "--inflate"]
question = args[0] if args else (
    "A B2B SaaS company's trial-to-paid conversion dropped from 22% to 14% in a quarter. "
    "Likely causes, and what to investigate first?")

fg = Tracer(workflow="gemini-research")
ai = fg.wrap(genai.Client(api_key=key))

def ask(model, system, text):
    return ai.models.generate_content(
        model=model, contents=text,
        config={"system_instruction": system, "max_output_tokens": 1024})

with fg.task():
    with fg.agent("planner"):
        plan = ask("gemini-2.5-flash", "Break the question into at most three concrete investigation steps. Be brief.", question)
    with fg.agent("searcher"):
        bloat = ("\n\n[full history]\n" + plan.text * 40) if inflate else ""
        facts = ask("gemini-2.5-flash", "List the concrete signals/metrics to check. JSON only.",
                    f"Q: {question}\nPlan:\n{plan.text}{bloat}")
        fg.emit_tool(tool="metrics.lookup", input=question[:160], output=(facts.text or "")[:400])
    with fg.agent("writer"):
        ask("gemini-2.5-flash",
            "Write a 4-sentence founder brief: most likely cause, strongest signal to check, one alternative, first action.",
            f"Q: {question}\nPlan:\n{plan.text}\nSignals:\n{facts.text}")

print("Done -> http://localhost:4700 (workflow: gemini-research). Click the card for topology, per-agent Gemini cost, and replay.")
