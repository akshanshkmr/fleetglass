import unittest
from fleetglass.tracer import Tracer

class Sink(Tracer):
    def __init__(self):
        self.sent = []
        super().__init__()
    def _post(self, spans):
        self.sent.extend(spans)

def attr(span, key, kind='stringValue'):
    for a in span['attributes']:
        if a['key'] == key:
            return a['value'].get(kind)
    return None

class TestTracer(unittest.TestCase):
    def test_emit_outside_task_raises(self):
        with self.assertRaises(RuntimeError):
            Sink().emit_chat(model='m')

    def test_nested_agents_thread_parent(self):
        fg = Sink()
        with fg.task():
            with fg.agent('orchestrator'):
                fg.emit_chat(model='a', input_tokens=10, output_tokens=2, prompt='p', completion='c')
                with fg.agent('researcher'):
                    fg.emit_chat(model='b', input_tokens=10, output_tokens=2, prompt='p', completion='c')
        fg.flush()
        orch = next(s for s in fg.sent if attr(s, 'gen_ai.agent.name') == 'orchestrator')
        res = next(s for s in fg.sent if attr(s, 'gen_ai.agent.name') == 'researcher')
        self.assertEqual(res['parentSpanId'], orch['spanId'])
        self.assertEqual(orch['traceId'], res['traceId'])

    def test_decorator_form(self):
        fg = Sink()
        @fg.agent('worker')
        def do():
            fg.emit_chat(model='a', input_tokens=1, output_tokens=1)
        with fg.task():
            do()
        fg.flush()
        self.assertEqual(attr(fg.sent[0], 'gen_ai.agent.name'), 'worker')

if __name__ == '__main__':
    unittest.main()
