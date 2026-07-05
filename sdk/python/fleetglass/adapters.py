"""Provider adapters: wrap(client) returns the same client with its completion
method intercepted to auto-capture spans onto the tracer."""

def _contents_to_text(contents):
    if isinstance(contents, str):
        return contents
    if isinstance(contents, (list, tuple)):
        out = []
        for c in contents:
            if isinstance(c, str):
                out.append(c)
            else:
                parts = getattr(c, "parts", None) or (c.get("parts") if isinstance(c, dict) else None) or []
                out.append("".join(getattr(p, "text", None) or (p.get("text") if isinstance(p, dict) else "") or "" for p in parts))
        return "\n".join(out)
    return ""

def _sys_text(config):
    if not config:
        return ""
    si = config.get("system_instruction") if isinstance(config, dict) else getattr(config, "system_instruction", None)
    if not si:
        return ""
    return si if isinstance(si, str) else str(si)

def _tools_text(config):
    if not config:
        return ""
    tools = config.get("tools") if isinstance(config, dict) else getattr(config, "tools", None)
    return "" if not tools else str(tools)

def _safe_emit(tracer, **fields):
    # Telemetry must never break the agent: a failed emit drops the span, never the call.
    try:
        tracer.emit_chat(**fields)
    except Exception:
        pass

def _wrap_google(client, tracer):
    real = client.models.generate_content

    def traced(model=None, contents=None, config=None, **kw):
        res = real(model=model, contents=contents, config=config, **kw)
        um = getattr(res, "usage_metadata", None)
        history = _contents_to_text(contents)
        _safe_emit(
            tracer,
            model=getattr(res, "model_version", None) or model or "unknown",
            input_tokens=getattr(um, "prompt_token_count", 0) or 0,
            output_tokens=(getattr(um, "candidates_token_count", 0) or 0) + (getattr(um, "thoughts_token_count", 0) or 0),
            prompt=history,
            completion=getattr(res, "text", "") or "",
            context={"system": _sys_text(config), "history": history, "tools": _tools_text(config)},
        )
        return res

    client.models.generate_content = traced  # monkey-patch the bound method on this instance
    return client

def _msgs_text(messages):
    for m in reversed(messages or []):
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, str):
                return c
            return "\n".join(b.get("text", "") for b in (c or []) if isinstance(b, dict) and b.get("type") == "text")
    return ""

def _sys_from_messages(messages):
    return "\n".join(m.get("content", "") for m in (messages or []) if m.get("role") == "system" and isinstance(m.get("content"), str))

def _wrap_anthropic(client, tracer):
    real = client.messages.create
    def traced(model=None, system=None, messages=None, **kw):
        res = real(model=model, system=system, messages=messages, **kw)
        u = getattr(res, "usage", None)
        _safe_emit(
            tracer,
            model=getattr(res, "model", None) or model or "unknown",
            input_tokens=(getattr(u, "input_tokens", 0) or 0) + (getattr(u, "cache_read_input_tokens", 0) or 0) + (getattr(u, "cache_creation_input_tokens", 0) or 0),
            output_tokens=getattr(u, "output_tokens", 0) or 0,
            prompt=_msgs_text(messages),
            completion="".join(getattr(b, "text", "") for b in getattr(res, "content", []) if getattr(b, "type", "") == "text"),
            context={"system": system or "", "history": _msgs_text(messages), "tools": str(kw.get("tools") or "")},
        )
        return res
    client.messages.create = traced
    return client

def _wrap_openai(client, tracer):
    real = client.chat.completions.create
    def traced(model=None, messages=None, **kw):
        res = real(model=model, messages=messages, **kw)
        u = getattr(res, "usage", None)
        _safe_emit(
            tracer,
            model=getattr(res, "model", None) or model or "unknown",
            input_tokens=getattr(u, "prompt_tokens", 0) or 0,
            output_tokens=getattr(u, "completion_tokens", 0) or 0,
            prompt=_msgs_text(messages),
            completion=(res.choices[0].message.content if getattr(res, "choices", None) else "") or "",
            context={"system": _sys_from_messages(messages), "history": _msgs_text(messages), "tools": str(kw.get("tools") or "")},
        )
        return res
    client.chat.completions.create = traced
    return client

def wrap(client, tracer):
    models = getattr(client, "models", None)
    if models is not None and hasattr(models, "generate_content"):
        return _wrap_google(client, tracer)
    messages = getattr(client, "messages", None)
    if messages is not None and hasattr(messages, "create"):
        return _wrap_anthropic(client, tracer)
    chat = getattr(client, "chat", None)
    if chat is not None and hasattr(getattr(chat, "completions", None), "create"):
        return _wrap_openai(client, tracer)
    raise TypeError("fleetglass: unrecognized client (google-genai / anthropic / openai)")
