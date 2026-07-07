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

// Provider request → canonical { system, messages:[{role,content}], tools }.
// ponytail: canonical capture is text-only — multimodal and tool-result content blocks are dropped; full-fidelity capture is a later milestone.
function googleMessages(contents) {
  if (typeof contents === 'string') return [{ role: 'user', content: contents }];
  if (!Array.isArray(contents)) return [];
  return contents.map((c) => ({
    role: c.role === 'model' ? 'assistant' : 'user',
    content: typeof c === 'string' ? c : (c.parts || []).map((p) => p.text || '').join(''),
  }));
}
function anthropicMessages(messages) {
  return (messages || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
  }));
}
function openaiMessages(messages) {
  return (messages || []).filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : '',
  }));
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
          request: { system: sysText(req.config?.systemInstruction), messages: googleMessages(req.contents), tools: req.config?.tools },
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

function msgsText(messages) {
  const last = [...(messages || [])].reverse().find((m) => m.role === 'user');
  const c = last?.content;
  return typeof c === 'string' ? c : (c || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}
function sysFromMessages(messages) {
  return (messages || []).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
}

function wrapAnthropic(client, fg) {
  const orig = client.messages.create.bind(client.messages);
  const messages = new Proxy(client.messages, { get(t, p) {
    if (p !== 'create') return t[p];
    return async (params) => {
      const res = await orig(params);
      const u = res.usage || {};
      safeEmit(fg, {
        model: res.model || params.model,
        inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        outputTokens: u.output_tokens || 0,
        prompt: msgsText(params.messages),
        completion: (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
        context: { system: params.system || '', history: msgsText(params.messages), tools: params.tools ? JSON.stringify(params.tools) : '' },
        request: { system: params.system || '', messages: anthropicMessages(params.messages), tools: params.tools },
      });
      return res;
    };
  } });
  return new Proxy(client, { get(t, p) { return p === 'messages' ? messages : t[p]; } });
}

function wrapOpenAI(client, fg) {
  const orig = client.chat.completions.create.bind(client.chat.completions);
  const completions = new Proxy(client.chat.completions, { get(t, p) {
    if (p !== 'create') return t[p];
    return async (params) => {
      const res = await orig(params);
      const u = res.usage || {};
      safeEmit(fg, {
        model: res.model || params.model,
        inputTokens: u.prompt_tokens || 0,
        outputTokens: u.completion_tokens || 0,
        prompt: msgsText(params.messages),
        completion: res.choices?.[0]?.message?.content || '',
        context: { system: sysFromMessages(params.messages), history: msgsText(params.messages), tools: params.tools ? JSON.stringify(params.tools) : '' },
        request: { system: sysFromMessages(params.messages), messages: openaiMessages(params.messages), tools: params.tools },
      });
      return res;
    };
  } });
  const chat = new Proxy(client.chat, { get(t, p) { return p === 'completions' ? completions : t[p]; } });
  return new Proxy(client, { get(t, p) { return p === 'chat' ? chat : t[p]; } });
}

// Idempotency: re-wrapping an already-wrapped client would stack emits.
// Mark the proxies we return and no-op on re-wrap.
const wrapped = new WeakSet();

export function wrap(client, fg) {
  if (wrapped.has(client)) return client;
  let proxy;
  if (client?.models?.generateContent) proxy = wrapGoogle(client, fg);
  else if (client?.messages?.create) proxy = wrapAnthropic(client, fg);
  else if (client?.chat?.completions?.create) proxy = wrapOpenAI(client, fg);
  else throw new Error('fleetglass: unrecognized client (google-genai / anthropic / openai)');
  wrapped.add(proxy);
  return proxy;
}
