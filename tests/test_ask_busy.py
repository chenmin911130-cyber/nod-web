import threading
import unittest
from unittest import mock

from server.app import Session


class AskBusySeamTests(unittest.TestCase):
    """Session.ask is the seam the WebSocket client uses for typed questions."""

    def _session(self, *, busy: bool) -> Session:
        sess = Session.__new__(Session)
        sess._busy = busy
        sess._busy_lock = threading.Lock()
        sess._pending_asks = []
        sess.user_id = None
        sess.cfg = {"stt": {}, "ui": {}, "llm": {}}
        sess._workspace = "interview"
        sess.emit = mock.Mock()
        sess.pipeline = mock.Mock()
        sess.pipeline.process_text = mock.Mock()
        sess.pipeline._cancel = threading.Event()
        return sess

    def test_typed_ask_while_busy_is_queued_not_rejected(self):
        # Issue #6: a typed interview question while busy must be queued for
        # the next drain, not rejected with a terminal `done` that clears the
        # UI. The empty-id `done` used to round-trip through the reducer and
        # wipe the answer that was still being generated.
        sess = self._session(busy=True)
        sess.ask("What is the capital of China?")
        events = [c.args[0] for c in sess.emit.call_args_list if c.args]
        self.assertFalse(
            any(e.get("type") == "done" for e in events),
            f"typed ask while busy must queue, not emit a terminal done; got {events}",
        )
        sess.pipeline.process_text.assert_not_called()
        self.assertTrue(sess._busy)
        self.assertEqual(len(sess._pending_asks), 1)
        self.assertEqual(sess._pending_asks[0][0], "What is the capital of China?")

    def test_typed_ask_while_idle_starts_generation(self):
        sess = self._session(busy=False)
        sess._active_run_state = mock.Mock(return_value="idle")
        sess.ask("What is the capital of China?")
        for _ in range(40):
            if sess.pipeline.process_text.called:
                break
            threading.Event().wait(0.05)
        sess.pipeline.process_text.assert_called_once()
        args, kwargs = sess.pipeline.process_text.call_args
        self.assertEqual(args[0], "What is the capital of China?")
        self.assertEqual(args[1], "ask")
        self.assertEqual(kwargs.get("display_text"), "What is the capital of China?")
