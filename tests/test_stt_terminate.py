"""AssemblyAI streaming must send Terminate. Dropping the socket is not enough.

Streaming is billed on WebSocket-open time. Sessions that are not terminated
stay open and bill for up to 3 hours. See:
https://www.assemblyai.com/docs/billing-and-pricing
https://www.assemblyai.com/docs/streaming/message-sequence
"""
import json
import threading
import unittest
from unittest import mock

from server.app import (
    CloudListener,
    Session,
    _reset_live_stt,
    _terminate_assemblyai_session,
)


def _connected_ws():
    ws = mock.Mock()
    ws.sock = mock.Mock()
    ws.sock.connected = True
    ws.send = mock.Mock()
    ws.close = mock.Mock()
    return ws


class TerminateHelperTests(unittest.TestCase):
    def test_sends_terminate_json_before_close(self):
        ws = _connected_ws()
        order: list[str] = []
        ws.send.side_effect = lambda *a, **k: order.append("send")
        ws.close.side_effect = lambda *a, **k: order.append("close")
        done = threading.Event()
        done.set()
        _terminate_assemblyai_session(ws, done)
        self.assertEqual(json.loads(ws.send.call_args[0][0]), {"type": "Terminate"})
        self.assertEqual(order, ["send", "close"])

    def test_skips_terminate_when_already_disconnected(self):
        ws = _connected_ws()
        ws.sock.connected = False
        _terminate_assemblyai_session(ws)
        ws.send.assert_not_called()
        ws.close.assert_called()


class CloudListenerStopTests(unittest.TestCase):
    def _listener(self) -> CloudListener:
        return CloudListener(
            api_key="test-key",
            cfg={"stt": {}},
            on_final=lambda *a: None,
            on_partial=None,
            on_error=None,
        )

    def test_stop_sends_terminate_before_close(self):
        lst = self._listener()
        ws = _connected_ws()
        ws.send.side_effect = lambda *a, **k: lst._terminated.set()
        lst._ws = ws
        lst._was_ready = True
        lst.stop()
        payload = json.loads(ws.send.call_args[0][0])
        self.assertEqual(payload, {"type": "Terminate"})
        ws.close.assert_called()
        self.assertIsNone(lst._ws)
        self.assertTrue(lst._stop.is_set())

    def test_stop_is_idempotent(self):
        lst = self._listener()
        ws = _connected_ws()
        ws.send.side_effect = lambda *a, **k: lst._terminated.set()
        lst._ws = ws
        lst.stop()
        lst.stop()
        self.assertEqual(ws.send.call_count, 1)
        self.assertEqual(ws.close.call_count, 1)

    def test_termination_message_marks_session_ended(self):
        lst = self._listener()
        lst._on_message(None, json.dumps({
            "type": "Termination",
            "audio_duration_seconds": 12,
            "session_duration_seconds": 90,
        }))
        self.assertTrue(lst._terminated.is_set())


class SessionListenLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        _reset_live_stt()

    def tearDown(self) -> None:
        _reset_live_stt()

    def _session(self, user_id: str | None = "user-1") -> Session:
        sess = Session.__new__(Session)
        sess.emit = mock.Mock()
        sess.cfg = {"stt": {}}
        sess.user_id = user_id
        sess._workspace = "interview"
        sess._mic_muted = False
        sess._listen_wanted = True
        sess._listen_started_at = 0.0
        sess._last_voice_at = 0.0
        sess._idle_check_at = 0.0
        sess._listener = None
        sess._listen_mu = threading.RLock()
        sess._listen_starting = False
        sess._stt_restart_timer = None
        sess._pending_q = __import__("collections").deque(maxlen=8)
        sess._pending_wait = (None, 0.0, None)
        sess._pending_speaker = None
        sess._meeting_flush_timer = None
        sess._interview_wait_timer = None
        sess._meeting_lock = threading.Lock()
        sess._stt_drops = 0
        sess._stt_drop_at = 0.0
        sess._paused = False
        sess._engine = "idle"
        sess._manual = False
        sess.pipeline = mock.Mock()
        sess.pipeline.assemblyai_key.return_value = "test-key"
        sess._stt_cfg = mock.Mock(return_value={"stt": {}})
        sess._cancel_interview_wait_timer = mock.Mock()
        sess._flush_interview_wait = mock.Mock()
        sess._flush_meeting_hold = mock.Mock()
        sess._flush_cloud_archive = mock.Mock()
        sess._offer_save_history = mock.Mock()
        sess._on_final = mock.Mock()
        sess._on_partial = mock.Mock()
        sess._on_stt_drop = mock.Mock()
        return sess

    def test_stop_listening_terminates_the_open_session(self):
        sess = self._session()
        lst = mock.Mock()
        sess._listener = lst
        sess._stop_listening()
        lst.stop.assert_called_once()
        self.assertIsNone(sess._listener)

    def test_abandoned_handshake_is_terminated(self):
        sess = self._session()
        created: list[mock.Mock] = []

        def fake_listener(**kwargs):
            lst = mock.Mock()
            created.append(lst)

            def start():
                sess._listen_wanted = False

            lst.start.side_effect = start
            return lst

        with mock.patch("server.app.CloudListener", side_effect=fake_listener):
            sess._start_listening()
        self.assertEqual(len(created), 1)
        created[0].stop.assert_called_once()
        self.assertIsNone(sess._listener)

    def test_restart_terminates_the_old_session_before_opening_another(self):
        sess = self._session()
        order: list[str] = []
        old = mock.Mock()
        old.stop.side_effect = lambda: order.append("old-stop")
        new = mock.Mock()
        new.start.side_effect = lambda: order.append("new-start")
        sess._listener = old
        with mock.patch("server.app.CloudListener", return_value=new):
            sess._restart_listener()
        self.assertEqual(order, ["old-stop", "new-start"])
        self.assertIs(sess._listener, new)

    def test_three_concurrent_starts_open_one_socket(self):
        """CSV 2026-09-03 11:11:26Z: three created sessions in one second.

        start_listen runs on the WS thread pool. The old guard checked
        `_listener` before the handshake assigned it, so three frames opened
        three AssemblyAI sockets and only the last reference was kept.
        """
        sess = self._session()
        started: list[mock.Mock] = []
        handshake = threading.Event()
        release = threading.Event()

        def fake_listener(**kwargs):
            lst = mock.Mock()

            def start():
                started.append(lst)
                handshake.set()
                release.wait(1.0)

            lst.start.side_effect = start
            return lst

        with mock.patch("server.app.CloudListener", side_effect=fake_listener):
            threads = [threading.Thread(target=sess._start_listening) for _ in range(3)]
            for t in threads:
                t.start()
            self.assertTrue(handshake.wait(1.0))
            release.set()
            for t in threads:
                t.join(1.0)
        self.assertEqual(len(started), 1)
        self.assertIs(sess._listener, started[0])
        started[0].stop.assert_not_called()

    def test_second_session_same_user_terminates_the_first(self):
        first = mock.Mock()
        second = mock.Mock()
        queue = [first, second]
        a = self._session("user-1")
        b = self._session("user-1")
        with mock.patch("server.app.CloudListener", side_effect=lambda **k: queue.pop(0)):
            a._start_listening()
            b._start_listening()
        first.stop.assert_called()
        second.start.assert_called()
        self.assertIs(b._listener, second)

    def test_second_session_notifies_the_first_and_stops_its_ui(self):
        """Phone + web both Start: the first device must leave Listening."""
        first = mock.Mock()
        second = mock.Mock()
        queue = [first, second]
        a = self._session("user-1")
        b = self._session("user-1")
        a.pipeline.abort_stream = mock.Mock()
        with mock.patch("server.app.CloudListener", side_effect=lambda **k: queue.pop(0)):
            a._start_listening()
            b._start_listening()
        kinds = [c.args[0].get("type") for c in a.emit.call_args_list]
        self.assertIn("listen_taken", kinds)
        taken = next(c.args[0] for c in a.emit.call_args_list if c.args[0].get("type") == "listen_taken")
        self.assertIn("another device", taken.get("text", "").lower())
        self.assertFalse(a._listen_wanted)
        self.assertIsNone(a._listener)
        a.pipeline.abort_stream.assert_not_called()
        phases = [c.args[0] for c in a.emit.call_args_list if c.args[0].get("type") == "phase"]
        self.assertTrue(any(ev.get("capture") == "off" for ev in phases))
        b_kinds = [c.args[0].get("type") for c in b.emit.call_args_list]
        self.assertNotIn("listen_taken", b_kinds)

    def test_restart_does_not_look_like_another_device(self):
        sess = self._session()
        old = mock.Mock()
        new = mock.Mock()
        sess._listener = old
        with mock.patch("server.app.CloudListener", return_value=new):
            sess._restart_listener()
        kinds = [c.args[0].get("type") for c in sess.emit.call_args_list]
        self.assertNotIn("listen_taken", kinds)
        self.assertTrue(sess._listen_wanted)

    def test_pause_terminates_assemblyai_without_looking_like_stop(self):
        sess = self._session()
        lst = mock.Mock()
        sess._listener = lst
        sess.pipeline.abort_stream = mock.Mock()
        sess.pause_listen()
        lst.stop.assert_called_once()
        self.assertIsNone(sess._listener)
        self.assertTrue(sess._paused)
        self.assertTrue(sess._listen_wanted)
        sess.pipeline.abort_stream.assert_not_called()
        kinds = [c.args[0].get("type") for c in sess.emit.call_args_list]
        self.assertNotIn("save_prompt", kinds)
        phases = [c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "phase"]
        self.assertTrue(phases)
        self.assertEqual(phases[-1]["capture"], "paused")

    def test_resume_after_pause_opens_a_new_assemblyai_session(self):
        sess = self._session()
        old = mock.Mock()
        new = mock.Mock()
        sess._listener = old
        sess.pause_listen()
        with mock.patch("server.app.CloudListener", return_value=new):
            sess.resume_listen()
        old.stop.assert_called()
        new.start.assert_called()
        self.assertIs(sess._listener, new)
        self.assertFalse(sess._paused)
        phases = [c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "phase"]
        self.assertEqual(phases[-1]["capture"], "listening")
