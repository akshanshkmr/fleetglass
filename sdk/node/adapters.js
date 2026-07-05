// Provider adapters: wrap(client) returns a proxy that auto-captures each
// model call onto fg.emitChat, reading the current agent/parent from context.

// Telemetry must never break the agent: a failed emit drops the span, never the call.
function safeEmit(fg, fields) {
  try { fg.emitChat(fields); } catch { /* drop the span, keep the response */ }
}

function contentsToText(contents) {
  if (typeof contents === 'string') return contents;
  if (!Array.isArray(contents)) return '';
  return contents.map((c) => typeof c === 'string' ? c : (c.parts || []).map((p) => p.text || '').join('')).join('\n');
}

function wrapGoogle(client, fg) {
  const models = client.models;
  const orig = models.generateContent.bind(models);
  const proxiedModels = new Proxy(models, {
    get(t, p) {
      if (p !== 'generateContent') return t[p];
      return async (req) => {
        const res = await orig(req);
        const um = res.usageMetadata || {};
        const historyText = contentsToText(req.contents);
        safeEmit(fg, {
          model: res.modelVersion || req.model,
          inputTokens: um.promptTokenCount || 0,
          outputTokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
          prompt: historyText,
          completion: res.text || '',
          context: {
            system: sysText(req.config?.systemInstruction),
            history: historyText,
            tools: req.config?.tools ? JSON.stringify(req.config.tools) : '',
          },
        });
        return res;
      };
    },
  });
  return new Proxy(client, { get(t, p) { return p === 'models' ? proxiedModels : t[p]; } });
}

function sysText(si) {
  if (!si) return '';
  if (typeof si === 'string') return si;
  return (si.parts || []).map((p) => p.text || '').join('') || String(si);
}

export function wrap(client, fg) {
  if (client?.models?.generateContent) return wrapGoogle(client, fg);
  throw new Error('fleetglass: unrecognized client (expected a @google/genai client)');
}
