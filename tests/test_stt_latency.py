import json
import logging
import threading
import time
import unittest
from unittest import mock

from starlette.testclient import TestClient

from server.app import CFG, KEYS, CloudListener, Session, app
from server.stt_latency import LatencyWindow, STT_LATENCY_WINDOW, percentile, record_stt_latency


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


if __name__ == "__main__":
    unittest.main()
