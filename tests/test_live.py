import unittest

from server import live


class _Stub:
    def __init__(self, listening: bool = False, busy: bool = False) -> None:
        self._listener = object() if listening else None
        self._busy = busy


class LiveMetricsTests(unittest.TestCase):
    def setUp(self) -> None:
        live.reset()

    def tearDown(self) -> None:
        live.reset()

    def test_snapshot_counts_live_listening_and_generating(self):
        a = _Stub(listening=True, busy=False)
        b = _Stub(listening=False, busy=True)
        live.attach(a)
        live.attach(b)
        snap = live.snapshot()
        self.assertEqual(snap["live_ws"], 2)
        self.assertEqual(snap["live_listening"], 1)
        self.assertEqual(snap["live_generating"], 1)
        live.detach(a)
        self.assertEqual(live.snapshot()["live_ws"], 1)

    def test_error_and_quota_events_count_for_one_hour(self):
        live.note_event({"type": "error", "text": "stt drop"})
        live.note_event({"type": "quota_exceeded", "reason": "stt"})
        live.note_event({"type": "quota_exceeded", "reason": "llm"})
        live.mark("ws_rejected")
        snap = live.snapshot()
        self.assertEqual(snap["errors_1h"], 1)
        self.assertEqual(snap["quota_blocks_1h"], 2)
        self.assertEqual(snap["ws_rejected_1h"], 1)

    def test_status_events_are_not_failures(self):
        live.note_event({"type": "status", "text": "Ready"})
        live.note_event({"type": "chunk", "text": "hi"})
        snap = live.snapshot()
        self.assertEqual(snap["errors_1h"], 0)
        self.assertEqual(snap["quota_blocks_1h"], 0)
