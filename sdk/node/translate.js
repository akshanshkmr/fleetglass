// sdk/node/translate.js — canonical request { system, messages, tools } → each
// provider's real REST request, and each provider's response → { completion, inTok, outTok }.
// Pure and zero-dep; the SDK's provider-protocol layer, shared by the unified
// client and the control-plane fork engine.

const PREFIX = [['claude-', 'anthropic'], ['gpt-', 'openai'], ['o4', 'openai'], ['o3', 'openai'], ['gemini-', 'google']];
export function providerOf(model) {
  const hit = PREFIX.find(([p]) => model.startsWith(p));
  return hit ? hit[1] : null;
}

export function toProvider(canonical, { provider, model, maxTokens, key }) {
  const { system = '', messages = [], tools } = canonical || {};
  if (provider === 'anthropic') {
    const body = { model, max_tokens: maxTokens, messages: messages.map((m) => ({ role: m.role, content: m.content })) };
    if (system) body.system = system;
    if (tools) body.tools = tools;
    return { url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body };
  }
  if (provider === 'openai') {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : [...messages];
    const body = { model, max_completion_tokens: maxTokens, messages: msgs };
    if (tools) body.tools = tools;
    return { url: 'https://api.openai.com/v1/chat/completions', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body };
  }
  if (provider === 'google') {
    const body = {
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: maxTokens },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools) body.tools = tools;
    return { url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body };
  }
  throw new Error(`unknown provider ${provider}`);
}

export function parseResponse(provider, data) {
  if (provider === 'anthropic') {
    return { completion: (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'), inTok: data.usage?.input_tokens || 0, outTok: data.usage?.output_tokens || 0 };
  }
  if (provider === 'openai') {
    return { completion: data.choices?.[0]?.message?.content || '', inTok: data.usage?.prompt_tokens || 0, outTok: data.usage?.completion_tokens || 0 };
  }
  if (provider === 'google') {
    const parts = data.candidates?.[0]?.content?.parts || [];
    return { completion: parts.map((p) => p.text || '').join(''), inTok: data.usageMetadata?.promptTokenCount || 0, outTok: data.usageMetadata?.candidatesTokenCount || 0 };
  }
  throw new Error(`unknown provider ${provider}`);
}

// Provider API-key resolution from the environment (shared by client + fork).
export const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY' };
export const keyFor = (provider) => process.env[KEY_ENV[provider]];
