import threading
import unittest
from unittest import mock

from server.app import Session


class HistoryKeepTests(unittest.TestCase):
    def _session(self) -> Session:
        sess = Session.__new__(Session)
        sess._listener = None
        sess._listen_wanted = True
        sess._manual = False
        sess.user_id = "user-1"
        sess.usage_session_id = "sess-1"
        sess.pipeline = mock.Mock()
        sess.pipeline._cancel = threading.Event()
        sess.pipeline.usage_session_id = "sess-1"
        sess.emit = mock.Mock()
        return sess

    def test_stop_listen_asks_to_save_without_cancelling(self):
        sess = self._session()
        sess.stop_listen()
        types = [c.args[0]["type"] for c in sess.emit.call_args_list]
        self.assertIn("save_prompt", types)
        self.assertFalse(sess.pipeline._cancel.is_set())

    def test_keep_history_marks_session_without_cancelling(self):
        sess = self._session()
        with mock.patch("server.meter.keep_usage_session") as keep:
            sess.keep_history()
        keep.assert_called_once_with("user-1", "sess-1", keep_content=True, keep_audio=True)

    def test_keep_history_can_save_content_only(self):
        sess = self._session()
        with mock.patch("server.meter.keep_usage_session") as keep:
            sess.keep_history(content=True, audio=False)
        keep.assert_called_once_with("user-1", "sess-1", keep_content=True, keep_audio=False)
        self.assertEqual(sess.usage_session_id, "sess-1")
        self.assertFalse(sess.pipeline._cancel.is_set())

    def test_discard_history_deletes_and_clears_current_session(self):
        sess = self._session()
        with mock.patch("server.meter.discard_usage_session") as discard:
            sess.discard_history()
        discard.assert_called_once_with("user-1", "sess-1")
        self.assertIsNone(sess.usage_session_id)
        self.assertFalse(sess.pipeline._cancel.is_set())
