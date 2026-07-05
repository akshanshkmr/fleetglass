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

def wrap(client, tracer):
    models = getattr(client, "models", None)
    if models is not None and hasattr(models, "generate_content"):
        return _wrap_google(client, tracer)
    raise TypeError("fleetglass: unrecognized client (expected a google-genai client)")
