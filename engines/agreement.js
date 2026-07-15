// agreement.js — score two completions for output agreement (0–1). Structural
// field-match when both parse as JSON (deterministic, free); otherwise an
// injected LLM-judge. The metric behind every savings finding.

function leaves(obj, prefix, out) {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) leaves(obj[k], prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = obj;
  }
  return out;
}

export function structuralScore(a, b) {
  const la = leaves(a, '', {});
  const lb = leaves(b, '', {});
  const keys = Object.keys(la);
  if (!keys.length) return Object.keys(lb).length ? 0 : 1;
  const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
  const matched = keys.filter((k) => Object.prototype.hasOwnProperty.call(lb, k) && norm(lb[k]) === norm(la[k])).length;
  return matched / keys.length;
}

function asJson(s) {
  const t = String(s).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch { return undefined; }
}

export async function score(original, fork, { judge } = {}) {
  const a = asJson(original);
  const b = asJson(fork);
  if (a !== undefined && b !== undefined) return { score: structuralScore(a, b), method: 'structural' };
  if (judge) return { score: await judge(original, fork), method: 'judge' };
  return { score: 0, method: 'none' };
}
