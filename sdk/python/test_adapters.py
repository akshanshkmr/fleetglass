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

if __name__ == "__main__":
    unittest.main()
