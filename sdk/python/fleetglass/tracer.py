"""FleetGlass Python tracer core: emits FleetGlass JSON spans and threads the
current agent + parent span through contextvars. Stdlib only.

Batching is thread-free and deterministic: spans accumulate on the tracer and
send on flush() or when the batch hits BATCH_MAX. A lock guards the batch so
parallel worker threads can share one tracer safely.
"""
import functools, json, os, secrets, threading, time, urllib.request
import contextvars
from contextlib import contextmanager

_ctx = contextvars.ContextVar("fleetglass_frame", default=None)
BATCH_MAX = 50  # spans; flush eagerly so a long task streams to the dashboard

def current_frame():
    return _ctx.get()

class _Frame:
    __slots__ = ("trace", "agent", "anchor", "last")
    def __init__(self, trace, agent=None, anchor=None):
        self.trace, self.agent, self.anchor, self.last = trace, agent, anchor, None

def _context_tokens(segments, input_tokens):
    chars = {k: len(v or "") for k, v in segments.items()}
    total = sum(chars.values()) or 1
    return {k: round(n / total * input_tokens) for k, n in chars.items()}

class Tracer:
    def __init__(self, endpoint=None, workflow="default"):
        self.endpoint = endpoint or os.environ.get("FLEETGLASS_URL", "http://localhost:4700/v1/traces")
        self.workflow = workflow
        self._batch = []
        self._lock = threading.Lock()

    def _enqueue(self, span):
        with self._lock:
            self._batch.append(span)
            full = len(self._batch) >= BATCH_MAX
        if full:
            self.flush()

    def _post(self, spans):
        if not spans:
            return
        body = json.dumps({"resourceSpans": [{
            "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": self.workflow}}]},
            "scopeSpans": [{"spans": spans}],
        }]}).encode()
        try:
            req = urllib.request.Request(self.endpoint, data=body, headers={"content-type": "application/json"})
            urllib.request.urlopen(req, timeout=2).read()
        except Exception:
            pass  # never break the agent

    def flush(self):
        with self._lock:
            spans, self._batch = self._batch, []
        self._post(spans)  # synchronous → deterministic; Sink overrides _post in tests

    def _frame(self):
        f = _ctx.get()
        if f is None:
            raise RuntimeError("fleetglass: emit outside task() — wrap work in Tracer.task()")
        return f

    def _parent(self, f):
        return f.last or f.anchor

    def emit_chat(self, model="unknown", input_tokens=0, output_tokens=0, prompt="", completion="", context=None):
        f = self._frame()
        span_id = secrets.token_hex(8)
        attrs = [
            {"key": "gen_ai.operation.name", "value": {"stringValue": "chat"}},
            {"key": "gen_ai.agent.name", "value": {"stringValue": f.agent or "agent"}},
            {"key": "gen_ai.request.model", "value": {"stringValue": model}},
            {"key": "gen_ai.usage.input_tokens", "value": {"intValue": input_tokens}},
            {"key": "gen_ai.usage.output_tokens", "value": {"intValue": output_tokens}},
        ]
        if prompt:
            attrs.append({"key": "gen_ai.prompt", "value": {"stringValue": str(prompt)[:4000]}})
        if completion:
            attrs.append({"key": "gen_ai.completion", "value": {"stringValue": str(completion)[:4000]}})
        if context:
            for k, v in _context_tokens(context, input_tokens).items():
                attrs.append({"key": f"fleetglass.context.{k}_tokens", "value": {"intValue": v}})
        span = {"traceId": f.trace, "spanId": span_id, "name": f"chat {model}",
                "startTimeUnixNano": str(time.time_ns()), "attributes": attrs}
        parent = self._parent(f)
        if parent:
            span["parentSpanId"] = parent
        self._enqueue(span)
        f.last = span_id
        return span_id

    def emit_tool(self, tool="tool", input="", output=""):
        f = self._frame()
        span_id = secrets.token_hex(8)
        span = {"traceId": f.trace, "spanId": span_id, "name": f"execute_tool {tool}",
                "startTimeUnixNano": str(time.time_ns()), "attributes": [
                    {"key": "gen_ai.operation.name", "value": {"stringValue": "execute_tool"}},
                    {"key": "gen_ai.agent.name", "value": {"stringValue": f.agent or "agent"}},
                    {"key": "gen_ai.tool.name", "value": {"stringValue": tool}},
                    {"key": "fleetglass.tool.input", "value": {"stringValue": str(input)[:4000]}},
                    {"key": "fleetglass.tool.output", "value": {"stringValue": str(output)[:4000]}},
                ]}
        parent = self._parent(f)
        if parent:
            span["parentSpanId"] = parent
        self._enqueue(span)
        f.last = span_id
        return span_id

    @contextmanager
    def task(self):
        tok = _ctx.set(_Frame(secrets.token_hex(16)))
        try:
            yield
        finally:
            _ctx.reset(tok)
            self.flush()

    def agent(self, name):
        return _AgentScope(name)

    def wrap(self, client):
        from .adapters import wrap
        return wrap(client, self)

class _AgentScope:
    def __init__(self, name):
        self.name = name
    def __enter__(self):
        p = _ctx.get()
        if p is None:
            raise RuntimeError("fleetglass: agent() must run inside task()")
        self._tok = _ctx.set(_Frame(p.trace, self.name, p.last or p.anchor))
        return self
    def __exit__(self, *exc):
        _ctx.reset(self._tok)
        return False
    def __call__(self, fn):
        @functools.wraps(fn)
        def wrapper(*a, **kw):
            with _AgentScope(self.name):
                return fn(*a, **kw)
        return wrapper
