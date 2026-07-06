import unittest
from fleetglass.tracer import Tracer
from fleetglass.adapters import wrap

class Sink(Tracer):
    def __init__(self):
        self.sent = []
        super().__init__()
    def _post(self, spans):
        self.sent.extend(spans)

class FakeUsage:
    prompt_token_count = 42
    candidates_token_count = 7
    thoughts_token_count = 0

class FakeResp:
    text = "the answer"
    usage_metadata = FakeUsage()
    model_version = "gemini-2.5-flash"

class FakeModels:
    def generate_content(self, model=None, contents=None, config=None):
        return FakeResp()

class FakeClient:
    def __init__(self):
        self.models = FakeModels()

def attr(span, key, kind="stringValue"):
    for a in span["attributes"]:
        if a["key"] == key:
            return a["value"].get(kind)
    return None

class TestGoogleAdapter(unittest.TestCase):
    def test_wrap_emits_span(self):
        fg = Sink()
        client = wrap(FakeClient(), fg)
        with fg.task():
            with fg.agent("planner"):
                r = client.models.generate_content(model="gemini-2.5-flash", contents="hello",
                                                    config={"system_instruction": "be brief"})
                self.assertEqual(r.text, "the answer")
        fg.flush()
        span = fg.sent[0]
        self.assertEqual(attr(span, "gen_ai.agent.name"), "planner")
        self.assertEqual(attr(span, "gen_ai.request.model"), "gemini-2.5-flash")
        self.assertEqual(attr(span, "gen_ai.usage.input_tokens", "intValue"), 42)
        self.assertEqual(attr(span, "gen_ai.completion"), "the answer")

    def test_unknown_client_raises(self):
        with self.assertRaises(TypeError):
            wrap(object(), Sink())

    def test_wrap_idempotent(self):
        fg = Sink()
        client = FakeClient()
        once = wrap(client, fg)
        twice = wrap(once, fg)           # re-wrap the already-wrapped client
        self.assertIs(twice, once)
        with fg.task():
            with fg.agent("a"):
                once.models.generate_content(model="m", contents="x")
        fg.flush()
        self.assertEqual(len(fg.sent), 1)  # exactly one span, not two

    def test_missing_usage_metadata(self):
        fg = Sink()
        class Resp:
            text = "hi"                   # no usage_metadata, no model_version
        class Models:
            def generate_content(self, model=None, contents=None, config=None):
                return Resp()
        class Client:
            def __init__(self):
                self.models = Models()
        client = wrap(Client(), fg)
        with fg.task():
            with fg.agent("a"):
                client.models.generate_content(model="m", contents="x")
        fg.flush()
        span = fg.sent[0]
        self.assertEqual(attr(span, "gen_ai.usage.input_tokens", "intValue"), 0)
        self.assertEqual(attr(span, "gen_ai.usage.output_tokens", "intValue"), 0)
        self.assertEqual(attr(span, "gen_ai.completion"), "hi")

class FakeAnthropicMsgs:
    def create(self, model=None, system=None, messages=None, **kw):
        class R:
            pass
        r = R(); r.model = model
        r.content = [type("B", (), {"type": "text", "text": "hi"})()]
        r.usage = type("U", (), {"input_tokens": 5, "output_tokens": 3, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0})()
        return r
class FakeAnthropic:
    def __init__(self): self.messages = FakeAnthropicMsgs()

class FakeOpenAICompletions:
    def create(self, model=None, messages=None, **kw):
        class R: pass
        r = R(); r.model = model
        r.choices = [type("C", (), {"message": type("M", (), {"content": "hi"})()})()]
        r.usage = type("U", (), {"prompt_tokens": 8, "completion_tokens": 4})()
        return r
class FakeOpenAIChat:
    def __init__(self): self.completions = FakeOpenAICompletions()
class FakeOpenAI:
    def __init__(self): self.chat = FakeOpenAIChat()

class TestMoreProviders(unittest.TestCase):
    def test_anthropic(self):
        fg = Sink(); client = wrap(FakeAnthropic(), fg)
        with fg.task():
            with fg.agent("a"):
                client.messages.create(model="claude-haiku-4-5", system="sys", messages=[{"role": "user", "content": "q"}])
        fg.flush()
        self.assertEqual(attr(fg.sent[0], "gen_ai.request.model"), "claude-haiku-4-5")
        self.assertEqual(attr(fg.sent[0], "gen_ai.usage.output_tokens", "intValue"), 3)
    def test_openai(self):
        fg = Sink(); client = wrap(FakeOpenAI(), fg)
        with fg.task():
            with fg.agent("a"):
                client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "system", "content": "s"}, {"role": "user", "content": "q"}])
        fg.flush()
        self.assertEqual(attr(fg.sent[0], "gen_ai.request.model"), "gpt-4o-mini")
        self.assertEqual(attr(fg.sent[0], "gen_ai.usage.input_tokens", "intValue"), 8)

if __name__ == "__main__":
    unittest.main()
