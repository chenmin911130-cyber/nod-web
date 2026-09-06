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
        sess._workspace = "meeting"
        sess.pipeline = mock.Mock()
        sess.pipeline._cancel = threading.Event()
        sess.pipeline.usage_session_id = "sess-1"
        sess.emit = mock.Mock()
        sess._flush_cloud_archive = mock.Mock()
        return sess

    def test_keep_history_uploads_audio_before_keep(self):
        sess = self._session()
        order: list[str] = []
        sess._flush_cloud_archive.side_effect = lambda final=False: order.append("flush")
        with mock.patch("server.meter.keep_usage_session", side_effect=lambda *a, **k: order.append("keep")):
            sess.keep_history()
        self.assertEqual(order, ["flush", "keep"])
        sess._flush_cloud_archive.assert_called_once_with(final=False)

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

    def test_keep_history_then_resume_listen_reuses_same_session(self):
        sess = self._session()
        sess._consent_ok = True
        sess._workspace = "meeting"
        sess.cfg = {"stt": {"listen_scene": "meeting"}}
        with (
            mock.patch("server.meter.keep_usage_session"),
            mock.patch("server.meter.is_session_kept", return_value=True),
            mock.patch("server.meter.usage_snapshot", return_value={"ok": True}),
            mock.patch("server.meter.open_usage_session", return_value=("sess-2", {"ok": True})) as opened,
        ):
            sess.keep_history()
            ok = sess._ensure_usage()
        self.assertTrue(ok)
        self.assertEqual(sess.usage_session_id, "sess-1")
        self.assertEqual(sess.pipeline.usage_session_id, "sess-1")
        opened.assert_not_called()

    def test_interview_stop_listen_does_not_offer_save(self):
        sess = self._session()
        sess._workspace = "interview"
        sess.stop_listen()
        types = [c.args[0]["type"] for c in sess.emit.call_args_list]
        self.assertNotIn("save_prompt", types)

    def test_translate_stop_listen_does_not_offer_save(self):
        sess = self._session()
        sess._workspace = "translate"
        sess.stop_listen()
        types = [c.args[0]["type"] for c in sess.emit.call_args_list]
        self.assertNotIn("save_prompt", types)

    def test_meeting_stop_listen_does_not_offer_save_after_keep(self):
        sess = self._session()
        with (
            mock.patch("server.meter.keep_usage_session"),
            mock.patch("server.meter.is_session_kept", return_value=True),
        ):
            sess.keep_history()
            sess.emit.reset_mock()
            sess.stop_listen()
        types = [c.args[0]["type"] for c in sess.emit.call_args_list]
        self.assertNotIn("save_prompt", types)

    def test_keep_history_without_session_emits_failed(self):
        sess = self._session()
        sess.usage_session_id = None
        sess.keep_history()
        types = [c.args[0]["type"] for c in sess.emit.call_args_list]
        self.assertIn("history_keep_failed", types)
        self.assertNotIn("history_kept", types)

    def test_keep_history_error_emits_failed(self):
        sess = self._session()
        with mock.patch("server.meter.keep_usage_session", side_effect=RuntimeError("disk")):
            sess.keep_history()
        types = [c.args[0]["type"] for c in sess.emit.call_args_list]
        self.assertIn("history_keep_failed", types)
        self.assertNotIn("history_kept", types)
