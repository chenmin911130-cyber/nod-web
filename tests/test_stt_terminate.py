"""AssemblyAI streaming must send Terminate. Dropping the socket is not enough.

Streaming is billed on WebSocket-open time. Sessions that are not terminated
stay open and bill for up to 3 hours. See:
https://www.assemblyai.com/docs/billing-and-pricing
https://www.assemblyai.com/docs/streaming/message-sequence
"""
import json
import threading
import time
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
        sess._pending_asks = []
        sess._pcm_hold = bytearray()
        sess._stt_pending_pcm = b""
        sess._handoff_listener = None
        sess._listen_gen = 0
        sess._follow_lang = None
        sess._stt_drops = 0
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


def _turn_payload(text: str, *, formatted: bool, end: bool = True, turn_order: int = 1, start_ms: int = 1000, end_ms: int = 2000) -> str:
    return json.dumps({
        "type": "Turn",
        "end_of_turn": end,
        "turn_is_formatted": formatted,
        "turn_order": turn_order,
        "transcript": text,
        "words": [{"start": start_ms, "end": end_ms, "text": text.split()[0] if text else ""}],
    })


class StopTailAndErrorTests(unittest.TestCase):
    def _listener(self, on_final=None, on_partial=None, on_error=None, on_drop=None) -> CloudListener:
        return CloudListener(
            api_key="test-key",
            cfg={"stt": {}},
            on_final=on_final or (lambda *a: None),
            on_partial=on_partial,
            on_error=on_error,
            on_drop=on_drop,
        )

    def test_unformatted_end_of_turn_during_stop_is_final(self):
        finals: list[tuple] = []
        partials: list[str] = []
        lst = self._listener(
            on_final=lambda *a: finals.append(a),
            on_partial=lambda text, *rest: partials.append(text),
        )
        lst._stop.set()
        lst._on_message(None, _turn_payload(
            "I'm going to look to that reaction button",
            formatted=False,
            turn_order=7,
            start_ms=271000,
            end_ms=282000,
        ))
        self.assertEqual(len(finals), 1, "stop must commit the unformatted last turn")
        self.assertEqual(finals[0][0], "I'm going to look to that reaction button")
        self.assertEqual(finals[0][3]["stt_turn"], 7)
        self.assertTrue(finals[0][3].get("stop_commit"))
        self.assertEqual(partials, [])

    def test_unformatted_end_of_turn_while_live_stays_partial(self):
        finals: list = []
        partials: list[str] = []
        lst = self._listener(
            on_final=lambda *a: finals.append(a),
            on_partial=lambda text, *rest: partials.append(text),
        )
        lst._on_message(None, _turn_payload("I'm going to look", formatted=False, turn_order=7))
        self.assertEqual(finals, [])
        self.assertEqual(partials, ["I'm going to look"])

    def test_formatted_revision_of_same_turn_is_not_a_second_turn(self):
        finals: list[tuple] = []
        lst = self._listener(on_final=lambda *a: finals.append(a))
        lst._stop.set()
        lst._on_message(None, _turn_payload("Lets get into it", formatted=False, turn_order=8))
        lst._on_message(None, _turn_payload("Let's get into it.", formatted=True, turn_order=8))
        self.assertEqual(len(finals), 2)
        self.assertFalse(finals[0][3].get("revision"))
        self.assertTrue(finals[1][3].get("revision"))
        self.assertEqual(finals[0][3]["stt_turn"], finals[1][3]["stt_turn"])

    def test_error_during_stop_does_not_emit_or_drop(self):
        errors: list[str] = []
        drops: list[str] = []
        lst = self._listener(
            on_error=lambda e: errors.append(e),
            on_drop=lambda r: drops.append(r),
        )
        lst._stop.set()
        lst._on_message(None, json.dumps({"type": "Error", "error": "session closed", "code": 4000}))
        self.assertEqual(errors, [])
        self.assertEqual(drops, [])
        self.assertTrue(lst._terminated.is_set())

    def test_error_while_listening_still_emits(self):
        errors: list[str] = []
        lst = self._listener(on_error=lambda e: errors.append(e))
        lst._on_message(None, json.dumps({"type": "Error", "error": "3005", "code": 3005}))
        self.assertTrue(errors)
        self.assertTrue(lst._terminated.is_set())

    def test_partial_uncovered_at_stop_is_fallback_tail(self):
        lst = self._listener()
        lst._on_message(None, _turn_payload(
            "I'm going to look to that reaction button",
            formatted=False,
            end=False,
            turn_order=9,
        ))
        tail = lst.uncovered_tail()
        self.assertIsNotNone(tail)
        self.assertIn("reaction button", tail["text"])

    def test_committed_turn_covers_matching_partial(self):
        lst = self._listener()
        lst._stop.set()
        text = "Let's get into it."
        lst._on_message(None, _turn_payload(text, formatted=False, turn_order=4))
        lst._on_message(None, _turn_payload(text, formatted=False, end=False, turn_order=4))
        self.assertIsNone(lst.uncovered_tail())


class MeetingStopFlushTests(unittest.TestCase):
    def setUp(self) -> None:
        _reset_live_stt()

    def tearDown(self) -> None:
        _reset_live_stt()

    def _meeting(self) -> Session:
        from collections import deque
        import queue as qmod
        sess = Session.__new__(Session)
        sess.emit = mock.Mock()
        sess.cfg = {"stt": {}}
        sess.user_id = None
        sess.usage_session_id = None
        sess._workspace = "meeting"
        sess._mic_muted = False
        sess._listen_wanted = True
        sess._listen_started_at = 0.0
        sess._listen_accum_sec = 0.0
        sess._last_voice_at = 0.0
        sess._last_pcm_at = 0.0
        sess._idle_check_at = 0.0
        sess._listener = None
        sess._listen_mu = threading.RLock()
        sess._listen_starting = False
        sess._stt_restart_timer = None
        sess._pending_q = deque(maxlen=8)
        sess._pending_asks = []
        sess._pending_wait = (None, 0.0, None)
        sess._pending_speaker = None
        sess._pending_meta = None
        sess._meeting_flush_timer = None
        sess._interview_wait_timer = None
        sess._meeting_lock = threading.Lock()
        sess._interview_lock = threading.Lock()
        sess._open_line = None
        sess._meeting_gen = 0
        sess._meeting_finals = qmod.Queue()
        sess._meeting_worker_started = False
        sess._meeting_worker_thread = None
        sess._final_seq = 0
        sess._recent_finals = []
        sess._stt_drops = 0
        sess._stt_drop_at = 0.0
        sess._paused = False
        sess._engine = "idle"
        sess._manual = False
        sess._listen_gen = 3
        sess._stt_stream_gen = 1
        sess._handoff_listener = None
        sess._stt_pending_pcm = b""
        sess._pcm_hold = bytearray()
        sess._translate_carry = ""
        sess._stt_line_by_turn = {}
        sess._stop_flushing = False
        sess._listen_flush_history_ok = True
        sess._listen_flush_seq = 0
        sess._listen_flush_done = False
        sess._listen_flush_client_id = None
        sess._listen_ended = False
        sess._follow_lang = None
        sess.pipeline = mock.Mock()
        sess.pipeline.assemblyai_key.return_value = "test-key"
        sess.pipeline._last_answer = ""
        qids = iter(range(1, 100))
        sess.pipeline._new_qid = lambda: f"q{next(qids)}"
        sess._stt_cfg = mock.Mock(return_value={"stt": {}})
        sess._flush_cloud_archive = mock.Mock()
        sess._offer_save_history = mock.Mock()
        sess._maybe_follow_speech = lambda *a, **k: None
        sess._mark_voice = lambda *a, **k: None
        return sess

    def test_stop_fallback_commits_partial_once(self):
        sess = self._meeting()
        lst = CloudListener(
            api_key="k",
            cfg={"stt": {}},
            on_final=lambda *a: sess._on_final(*a),
            on_partial=sess._on_partial,
            on_error=None,
        )
        lst._on_message(None, _turn_payload(
            "Let's get into it",
            formatted=False,
            end=False,
            turn_order=5,
            start_ms=271000,
            end_ms=280000,
        ))
        lst.stop = mock.Mock()
        sess._listener = lst
        sess._stop_listening()
        kinds = [c.args[0].get("type") for c in sess.emit.call_args_list]
        self.assertIn("listen_flush", kinds)
        flush = next(c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "listen_flush")
        self.assertTrue(flush.get("ok"))
        questions = [c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "question"]
        self.assertEqual(len(questions), 1)
        self.assertIn("Let's get into it", questions[0]["text"])
        phases = [c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "phase"]
        self.assertTrue(any(ev.get("capture") == "off" for ev in phases))
        flush_i = kinds.index("listen_flush")
        phase_off_i = next(i for i, ev in enumerate(sess.emit.call_args_list) if ev.args[0].get("type") == "phase" and ev.args[0].get("capture") == "off")
        self.assertLess(kinds.index("question") if "question" in kinds else 0, flush_i)
        self.assertLessEqual(flush_i, phase_off_i)

    def test_stop_error_on_listener_does_not_emit_transcription_failed(self):
        sess = self._meeting()
        errors: list = []

        def boom(e):
            errors.append(e)
            sess.emit({"type": "error", "text": f"Transcription failed:{e}"})

        lst = CloudListener(
            api_key="k",
            cfg={"stt": {}},
            on_final=lambda *a: None,
            on_partial=None,
            on_error=boom,
        )
        lst._stop.set()
        lst._on_message(None, json.dumps({"type": "Error", "error": "closed"}))
        self.assertEqual(errors, [])
        kinds = [c.args[0].get("type") for c in sess.emit.call_args_list]
        self.assertNotIn("error", kinds)

    def test_stop_is_idempotent_and_emits_one_flush(self):
        sess = self._meeting()
        lst = mock.Mock()
        lst.stop = mock.Mock()
        lst.uncovered_tail = mock.Mock(return_value=None)
        sess._listener = lst
        sess._stop_listening()
        sess._stop_listening()
        sess.stop_listen()
        flushes = [c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "listen_flush"]
        self.assertEqual(len(flushes), 1)

    def test_stop_listen_echoes_flush_id_and_session(self):
        sess = self._meeting()
        sess.usage_session_id = "sess-b"
        lst = mock.Mock()
        lst.stop = mock.Mock()
        lst.uncovered_tail = mock.Mock(return_value=None)
        sess._listener = lst
        sess.stop_listen(flush_id="f2")
        flush = next(c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "listen_flush")
        self.assertEqual(flush.get("flush_id"), "f2")
        self.assertEqual(flush.get("session_id"), "sess-b")
        self.assertTrue(flush.get("ok"))
        self.assertIsNone(sess._listen_flush_client_id)

    def test_slow_worker_flush_waits_past_one_second_join(self):
        sess = self._meeting()
        real_hold = Session._hold_or_emit_meeting

        def slow_hold(self, *a, **k):
            time.sleep(1.4)
            return real_hold(self, *a, **k)

        lst = mock.Mock()
        lst.stop = mock.Mock()
        lst.uncovered_tail = mock.Mock(return_value=None)
        sess._listener = lst
        with mock.patch.object(Session, "_hold_or_emit_meeting", slow_hold):
            sess._enqueue_meeting_final(
                "I'm going to look to that reaction button",
                "en",
                "A",
                {"turn_order": 1, "first_word_ms": 1000, "last_word_ms": 9000, "n_words": 8},
            )
            t0 = time.monotonic()
            sess._stop_listening()
        elapsed = time.monotonic() - t0
        self.assertGreaterEqual(elapsed, 1.2)
        questions = [c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "question"]
        self.assertEqual(len(questions), 1)
        flush = next(c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "listen_flush")
        self.assertTrue(flush.get("ok"))

    def test_late_formatted_revision_updates_same_line(self):
        sess = self._meeting()
        lst = CloudListener(
            api_key="k",
            cfg={"stt": {}},
            on_final=lambda *a: sess._on_final(*a),
            on_partial=None,
            on_error=None,
        )
        lst._stop.set()
        lst._on_message(None, _turn_payload("Lets get into it.", formatted=False, turn_order=2))
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if any(c.args[0].get("type") == "question" for c in sess.emit.call_args_list):
                break
            time.sleep(0.01)
        lst._on_message(None, _turn_payload("Let's get into it.", formatted=True, turn_order=2))
        lst.stop = mock.Mock()
        lst.uncovered_tail = lambda: None
        sess._listener = lst
        sess._stop_listening()
        questions = [c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "question"]
        updates = [c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "line_update"]
        self.assertEqual(len(questions), 1)
        self.assertEqual(questions[0]["text"], "Lets get into it.")
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["id"], questions[0]["id"])
        self.assertEqual(updates[0]["text"], "Let's get into it.")

    def test_formatted_revision_replaces_held_tail(self):
        sess = self._meeting()
        lst = CloudListener(
            api_key="k",
            cfg={"stt": {}},
            on_final=lambda *a: sess._on_final(*a),
            on_partial=None,
            on_error=None,
        )
        lst._stop.set()
        lst._on_message(None, _turn_payload("I'm", formatted=False, turn_order=7))
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            if getattr(sess, "_pending_wait", (None, 0.0, None))[0]:
                break
            time.sleep(0.01)
        lst._on_message(None, _turn_payload(
            "I'm going to look to that reaction button. Let's get into it.",
            formatted=True,
            turn_order=7,
        ))
        lst.stop = mock.Mock()
        lst.uncovered_tail = lambda: None
        sess._listener = lst
        sess._stop_listening()
        questions = [c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "question"]
        self.assertEqual(len(questions), 1)
        self.assertIn("Let's get into it", questions[0]["text"])

    def test_two_real_repeats_are_kept(self):
        sess = self._meeting()
        sess._on_final("Yes we can start today.", "en", "A", {"turn_order": 1, "stt_turn": 1, "n_words": 5})
        sess._on_final("Yes we can start today.", "en", "A", {"turn_order": 2, "stt_turn": 2, "n_words": 5})
        time.sleep(0.15)
        questions = [c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "question"]
        self.assertEqual(len(questions), 2)

    def test_old_listener_final_does_not_land_after_new_listen_gen(self):
        sess = self._meeting()
        lst = mock.Mock()
        lst.stop = mock.Mock()
        lst.uncovered_tail = mock.Mock(return_value=None)
        sess._listener = lst
        sess._stop_listening()
        gen = sess._listen_gen
        sess._on_final(
            "stale tail from old listener",
            "en",
            "A",
            {"turn_order": 9, "stt_turn": 9, "listener_id": 1, "stop_commit": True, "listen_gen": gen - 1},
        )
        time.sleep(0.05)
        texts = [c.args[0].get("text") for c in sess.emit.call_args_list if c.args[0].get("type") == "question"]
        self.assertNotIn("stale tail from old listener", texts)

    def test_empty_audio_does_not_invent_a_line(self):
        sess = self._meeting()
        lst = CloudListener(
            api_key="k",
            cfg={"stt": {}},
            on_final=lambda *a: sess._on_final(*a),
            on_partial=sess._on_partial,
            on_error=None,
        )
        lst.stop = mock.Mock()
        sess._listener = lst
        sess._stop_listening()
        questions = [c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "question"]
        self.assertEqual(questions, [])
        flush = next(c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "listen_flush")
        self.assertTrue(flush.get("ok"))
        self.assertFalse(flush.get("timeout"))

    def test_drain_timeout_marks_flush_not_ok(self):
        sess = self._meeting()
        real_hold = Session._hold_or_emit_meeting

        def slow_hold(self, *a, **k):
            time.sleep(0.6)
            return real_hold(self, *a, **k)

        lst = mock.Mock()
        lst.stop = mock.Mock()
        lst.uncovered_tail = mock.Mock(return_value=None)
        sess._listener = lst
        with mock.patch("server.app.MEETING_STOP_DRAIN_SEC", 0.15):
            with mock.patch.object(Session, "_hold_or_emit_meeting", slow_hold):
                sess._enqueue_meeting_final(
                    "I'm going to look to that reaction button",
                    "en",
                    "A",
                    {"turn_order": 1, "first_word_ms": 1000, "last_word_ms": 9000, "n_words": 8},
                )
                sess._stop_listening()
        flush = next(c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "listen_flush")
        self.assertTrue(flush.get("timeout"))
        self.assertFalse(flush.get("ok"))

    def test_history_save_failure_marks_flush_not_ok(self):
        sess = self._meeting()
        sess.user_id = "u1"
        sess.usage_session_id = "s1"
        lst = mock.Mock()
        lst.stop = mock.Mock()
        lst.uncovered_tail = mock.Mock(return_value={
            "text": "Let's get into it",
            "lang": "en",
            "speaker": "A",
            "stt_turn": 3,
            "first_word_ms": 1000,
            "last_word_ms": 2000,
            "n_words": 4,
        })
        sess._listener = lst
        with mock.patch("server.meter.save_history", side_effect=RuntimeError("db")):
            sess._stop_listening()
        questions = [c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "question"]
        self.assertEqual(len(questions), 1)
        flush = next(c.args[0] for c in sess.emit.call_args_list if c.args[0].get("type") == "listen_flush")
        self.assertFalse(flush.get("ok"))
        self.assertFalse(flush.get("timeout"))
