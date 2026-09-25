import json
import logging
import threading
import time
import unittest
from unittest import mock

from starlette.testclient import TestClient

from server.app import CFG, KEYS, CloudListener, Session, app
from server.stt_latency import LatencyWindow, STT_LATENCY_WINDOW, percentile, record_stt_latency, record_translate_latency


def _turn_payload(
    text: str,
    *,
    formatted: bool,
    end: bool = True,
    turn_order: int = 1,
    start_ms: int = 1000,
    end_ms: int = 2000,
) -> str:
    return json.dumps(
        {
            "type": "Turn",
            "end_of_turn": end,
            "turn_is_formatted": formatted,
            "turn_order": turn_order,
            "transcript": text,
            "words": [{"start": start_ms, "end": end_ms, "text": text.split()[0] if text else "x"}],
        }
    )


class PercentileTests(unittest.TestCase):
    def test_percentile_edges(self):
        self.assertIsNone(percentile([], 50))
        self.assertEqual(percentile([10], 95), 10.0)
        vals = list(range(1, 101))
        self.assertAlmostEqual(percentile(vals, 50), 50.0, delta=1.0)
        self.assertAlmostEqual(percentile(vals, 95), 95.0, delta=1.0)


class LatencyWindowTests(unittest.TestCase):
    def test_window_expires_and_counts(self):
        w = LatencyWindow(seconds=3600)
        base = 1_000_000.0
        for _ in range(3):
            w.add("format_wait_ms", 100, base)
        snap = w.snapshot(base + 10)
        self.assertEqual(snap["format_wait_ms"]["n"], 3)
        self.assertTrue(w.snapshot(base + 3601) == {})


class CloudListenerLatencyTests(unittest.TestCase):
    def setUp(self) -> None:
        STT_LATENCY_WINDOW._samples.clear()

    def test_format_wait_on_unformatted_then_formatted(self):
        finals: list[tuple] = []
        lst = CloudListener(
            api_key="k",
            cfg={"stt": {}},
            on_final=lambda *a: finals.append(a),
            on_partial=None,
            on_error=None,
        )
        times = iter([10.0, 10.7, 10.7, 10.7])
        with mock.patch("server.app.time.monotonic", side_effect=lambda: next(times)):
            lst._on_message(None, _turn_payload("hello world", formatted=False, turn_order=5))
            lst._on_message(None, _turn_payload("Hello world.", formatted=True, turn_order=5))
        self.assertEqual(len(finals), 1)
        meta = finals[0][3]
        self.assertEqual(meta["__commit_mono__"], 10.7)
        self.assertEqual(meta["format_wait_ms"], 700)

    def test_formatted_only_has_no_format_wait(self):
        finals: list[tuple] = []
        lst = CloudListener(
            api_key="k",
            cfg={"stt": {}},
            on_final=lambda *a: finals.append(a),
            on_partial=None,
            on_error=None,
        )
        lst._on_message(None, _turn_payload("Only formatted.", formatted=True, turn_order=3))
        self.assertEqual(len(finals), 1)
        self.assertNotIn("format_wait_ms", finals[0][3])

    def test_asr_lag_and_backlog(self):
        finals: list[tuple] = []
        lst = CloudListener(
            api_key="k",
            cfg={"stt": {}},
            on_final=lambda *a: finals.append(a),
            on_partial=None,
            on_error=None,
        )
        lst._stt_tx_bytes = 320000
        with lst._pcm_mu:
            lst._q_bytes = 3200
        lst._on_message(
            None,
            _turn_payload("lag check", formatted=True, turn_order=1, start_ms=1000, end_ms=9400),
        )
        meta = finals[0][3]
        self.assertEqual(meta["asr_lag_ms"], 600)
        self.assertEqual(meta["backlog_ms"], 100)

    def test_log_line_has_no_transcript(self):
        STT_LATENCY_WINDOW._samples.clear()
        meta = {
            "stt_turn": 2,
            "format_wait_ms": 50,
            "asr_lag_ms": 60,
            "backlog_ms": 10,
            "__commit_mono__": time.monotonic(),
            "n_words": 3,
            "stream": "s1",
        }
        secret = "super-secret-transcript-xyzzy"
        with self.assertLogs("nod", level="INFO") as cap:
            record_stt_latency(
                workspace="meeting",
                meta=meta,
                hold_ms=None,
                speaker_labels=0,
                max_turn_silence=1600,
                stream="s1",
            )
        joined = "\n".join(cap.output)
        self.assertIn("stt_latency", joined)
        self.assertNotIn(secret, joined)


class SessionHoldLatencyTests(unittest.TestCase):
    def setUp(self) -> None:
        STT_LATENCY_WINDOW._samples.clear()

    def test_hold_ms_on_emit_after_hold(self):
        sess = Session(lambda _ev: None, json.loads(json.dumps(CFG)), dict(KEYS))
        sess._workspace = "meeting"
        sess._enqueue_meeting_final = lambda c, l, s, m: sess._hold_or_emit_meeting(c, l, s, m)
        times = iter([20.0, 21.0, 21.0, 21.0])
        with mock.patch("server.app.time.monotonic", side_effect=lambda: next(times)):
            with mock.patch("server.app.threading.Timer") as timer_cls:
                timer_cls.side_effect = lambda _delay, fn: mock.Mock(start=lambda: None)
                sess._hold_or_emit_meeting("wait", "en", None, {"__commit_mono__": 19.0, "stt_turn": 1})
                sess._flush_meeting_hold()
        snap = STT_LATENCY_WINDOW.snapshot(time.time())
        self.assertEqual(snap.get("hold_ms", {}).get("n"), 1)
        self.assertEqual(snap["hold_ms"]["p50"], 1000)

    def test_direct_emit_has_no_hold_ms(self):
        sess = Session(lambda _ev: None, json.loads(json.dumps(CFG)), dict(KEYS))
        sess._workspace = "meeting"
        with mock.patch("server.app.time.monotonic", return_value=30.0):
            sess._emit_meeting_line(
                "Complete sentence here.",
                "en",
                meta={"__commit_mono__": 29.0, "stt_turn": 4, "stream": "x"},
            )
        snap = STT_LATENCY_WINDOW.snapshot(time.time())
        self.assertNotIn("hold_ms", snap)
        self.assertEqual(snap.get("pipeline_ms", {}).get("n"), 1)


class HealthLatencyTests(unittest.TestCase):
    def test_health_includes_stt_latency(self):
        STT_LATENCY_WINDOW._samples.clear()
        with TestClient(app) as client:
            body = client.get("/api/health").json()
        self.assertIn("ok", body)
        self.assertIn("stt", body)
        self.assertIn("audio", body)
        self.assertIn("auth", body)
        self.assertIn("stt_latency", body)
        self.assertEqual(body["stt_latency"], {})


class LatencyWindowThreadTests(unittest.TestCase):
    def test_concurrent_add_snapshot(self):
        w = LatencyWindow(seconds=3600)
        base = time.time()
        errors: list[BaseException] = []

        def adder() -> None:
            try:
                for i in range(200):
                    w.add("pipeline_ms", i % 50, base)
            except BaseException as e:
                errors.append(e)

        threads = [threading.Thread(target=adder) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        snap = w.snapshot(base + 1)
        self.assertGreaterEqual(snap["pipeline_ms"]["n"], 200)


def _translate_session_latency() -> Session:
    from tests.test_turn_pacing import _translate_session

    sess = _translate_session()
    emitted: list[dict] = []

    def routed(ev: dict) -> None:
        emitted.append(ev)
        sess._note_translate_timing(ev)

    sess._client_emit = routed
    sess._routed_emit = Session._routed_emit.__get__(sess, Session)
    sess._maybe_watch_copy = lambda ev: None
    sess._maybe_qa_copy = lambda ev: None
    sess._send_audio_text = lambda *a: None
    return sess


class TranslateLatencyLineTests(unittest.TestCase):
    def setUp(self) -> None:
        STT_LATENCY_WINDOW._samples.clear()

    def test_full_piece_latency_line(self):
        sess = _translate_session_latency()
        piece_id = "line42"
        meta = {
            "stt_turn": 7,
            "stream": "s9",
            "cut_reason": "eot",
            "first_word_ms": 1000,
            "last_word_ms": 4000,
            "asr_lag_ms": 50,
            "backlog_ms": 10,
            "commit_audio_ms": 500,
        }
        sess._start_voice_translate(piece_id, "hello", "en", meta)
        ask_id = "gen1"
        with self.assertLogs("nod", level="INFO") as cap:
            sess._routed_emit({
                "type": "question",
                "id": ask_id,
                "text": f"[NOD_TRANSLATE:{piece_id}]\nTranslate only this line:\nhello",
            })
            sess._routed_emit({"type": "chunk", "id": ask_id, "text": "你"})
            sess._routed_emit({"type": "chunk", "id": ask_id, "text": "好"})
            sess._routed_emit({"type": "done", "id": ask_id, "ok": True})
        lines = [ln for ln in "\n".join(cap.output).splitlines() if "translate_latency" in ln]
        self.assertEqual(len(lines), 1)
        line = lines[0]
        self.assertIn(f"piece={piece_id}", line)
        self.assertIn("cut=eot", line)
        self.assertIn("queue_wait_ms=", line)
        self.assertIn("llm_ttft_ms=", line)
        self.assertIn("llm_total_ms=", line)
        self.assertIn("speech_to_chunk_ms=", line)
        snap = STT_LATENCY_WINDOW.snapshot(time.time())
        self.assertEqual(snap.get("tr_speech_to_chunk_ms", {}).get("n"), 1)

    def test_passthrough_logs_without_llm(self):
        sess = _translate_session_latency()
        with self.assertLogs("nod", level="INFO") as cap:
            sess._log_translate_latency(
                {"piece": "p1", "cut_reason": "eot", "chars": 3, "lang": "zh"},
                passthrough=1,
            )
        line = "\n".join(cap.output)
        self.assertIn("passthrough=1", line)
        self.assertNotIn("llm_ttft_ms=", line)

    def test_error_logs_failed(self):
        sess = _translate_session_latency()
        piece_id = "p2"
        sess._start_voice_translate(piece_id, "x", "en", {"cut_reason": "eot"})
        ask_id = "g2"
        with self.assertLogs("nod", level="INFO") as cap:
            sess._routed_emit({
                "type": "question",
                "id": ask_id,
                "text": f"[NOD_TRANSLATE:{piece_id}]\nx",
            })
            sess._routed_emit({"type": "error", "id": ask_id, "text": "fail"})
        self.assertIn("failed=1", "\n".join(cap.output))


class ClientTimingDispatchTests(unittest.TestCase):
    def test_client_timing_logged(self):
        sess = Session(lambda _ev: None, json.loads(json.dumps(CFG)), dict(KEYS))
        with self.assertLogs("nod", level="INFO") as cap:
            sess.dispatch({"type": "client_timing", "id": "q1", "ttfc_ms": 812, "done_ms": 1500})
        self.assertIn("translate_client id=q1 ttfc_ms=812 done_ms=1500", "\n".join(cap.output))

    def test_garbage_client_timing_no_crash(self):
        sess = Session(lambda _ev: None, json.loads(json.dumps(CFG)), dict(KEYS))
        sess.dispatch({"type": "client_timing", "id": "q1", "ttfc_ms": "nope", "done_ms": None})
        sess.dispatch({"type": "client_timing"})


class UplinkPingPendingTests(unittest.TestCase):
    def setUp(self) -> None:
        from server import uplink

        uplink.reset()

    def tearDown(self) -> None:
        from server import uplink

        uplink.reset()

    def test_ping_without_pending_ms(self):
        from server.app import app
        from tests.test_uplink import _session

        sess = _session()
        sess._listener = object()
        from server import uplink

        uplink.register(sess)
        client = TestClient(app)
        with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
            ws.send_text(json.dumps({"type": "ping"}))
            time.sleep(0.05)
        self.assertFalse(hasattr(sess, "_uplink_pending_ms"))

    def test_ping_with_pending_ms(self):
        from server.app import app
        from tests.test_uplink import _session

        sess = _session()
        lst = CloudListener(
            api_key="k",
            cfg={"stt": {}},
            on_final=lambda *a: None,
            on_partial=None,
            on_error=None,
            stream_id="st1",
        )
        sess._listener = lst
        from server import uplink

        uplink.register(sess)
        client = TestClient(app)
        with self.assertLogs("nod", level="INFO") as cap:
            with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                ws.send_text(json.dumps({"type": "ping", "pending_ms": 2400}))
                time.sleep(0.05)
        self.assertEqual(sess._uplink_pending_ms, 2400)
        self.assertIn("uplink_ping pending_ms=2400", "\n".join(cap.output))


if __name__ == "__main__":
    unittest.main()
