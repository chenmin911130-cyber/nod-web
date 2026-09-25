"""Per-listen listen_summary, uplink lag re-anchor, ping counters, health sha (T1)."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import unittest
from unittest import mock

from starlette.testclient import TestClient

from server.app import CFG, KEYS, Session


class _Clock:
    """Tenths-based monotonic clock so 0.1 s steps stay exact."""

    def __init__(self, start: float = 1000.0) -> None:
        self.tenths = int(round(start * 10))

    def monotonic(self) -> float:
        return self.tenths / 10.0

    def advance(self, seconds: float = 0.1) -> None:
        self.tenths += int(round(seconds * 10))


def _bare_session() -> Session:
    return Session.__new__(Session)


def _summary_lines(text: str) -> list[str]:
    return [ln for ln in text.splitlines() if "listen_summary" in ln]


class UplinkLagReanchorTests(unittest.TestCase):
    def test_resume_reanchors_uplink_lag(self):
        sess = _bare_session()
        sess._pcm_rx_bytes = 0
        sess._pcm_rx_first_mono = 0.0
        sess._pcm_rx_anchor_bytes = 0
        sess._pcm_rx_reanchor = False
        clk = _Clock(1000.0)
        frame = b"\x00" * 3200
        with mock.patch("server.app.time.monotonic", clk.monotonic):
            for _ in range(100):
                sess._pcm_rx_note(frame)
                clk.advance(0.1)
            sess._paused = True
            sess._listen_wanted = True
            sess._listener = None
            sess._manual = False
            sess.emit = lambda _ev: None
            sess._start_listening = lambda resume=False: None
            clk.advance(60.0)
            sess.resume_listen()
            sess._pcm_rx_note(frame)
            clk.advance(0.1)
            lag = sess._uplink_lag_ms()
        self.assertIsNotNone(lag)
        self.assertLessEqual(lag, 200)

    def test_unmute_still_reanchors(self):
        sess = Session(lambda _ev: None, json.loads(json.dumps(CFG)), dict(KEYS))
        clk = _Clock(5000.0)
        frame = b"\x00" * 3200
        with mock.patch("server.app.time.monotonic", clk.monotonic):
            for _ in range(10):
                sess._pcm_rx_note(frame)
                clk.advance(0.1)
            sess.set_mic_muted(True)
            clk.advance(30.0)
            sess.set_mic_muted(False)
            sess._pcm_rx_note(frame)
            lag = sess._uplink_lag_ms()
        self.assertIsNotNone(lag)
        self.assertLessEqual(lag, 200)


class ListenSummarySessionTests(unittest.TestCase):
    def _feed_until_tick(self, sess: Session, frame: bytes, *, pre_frames: int = 600) -> str:
        """600 frames then one summary at exactly +60.0 s (one tick, rate over 600 frames)."""
        clk = _Clock(10_000.0)
        with mock.patch("server.app.time.monotonic", clk.monotonic):
            with self.assertLogs("nod", level="INFO") as cap:
                for _ in range(pre_frames):
                    sess._pcm_rx_note(frame)
                    sess._maybe_listen_summary()
                    clk.advance(0.1)
                sess._maybe_listen_summary()
                for _ in range(10):
                    sess._pcm_rx_note(frame)
                    sess._maybe_listen_summary()
                    clk.advance(0.1)
        lines = _summary_lines("\n".join(cap.output))
        self.assertEqual(len(lines), 1, cap.output)
        return lines[0]

    def test_summary_tick_realtime(self):
        sess = _bare_session()
        with mock.patch.dict(os.environ, {"NOD_LISTEN_SUMMARY_S": "60"}):
            line = self._feed_until_tick(sess, b"\x00" * 3200)
        self.assertIn("reason=tick", line)
        self.assertIn("rx_rate=1.000", line)
        self.assertIn("path=control", line)
        self.assertIn("client=web", line)
        lag = int(line.split("uplink_lag_ms=")[1].split()[0])
        self.assertGreaterEqual(lag, -150)
        self.assertLessEqual(lag, 150)

    def test_summary_rate_094(self):
        sess = _bare_session()
        with mock.patch.dict(os.environ, {"NOD_LISTEN_SUMMARY_S": "60"}):
            line = self._feed_until_tick(sess, b"\x00" * 3008)
        self.assertIn("rx_rate=0.940", line)
        lag = int(line.split("uplink_lag_ms=")[1].split()[0])
        self.assertGreaterEqual(lag, 3500)
        self.assertLessEqual(lag, 3800)

    def test_summary_final_on_stop_and_pause(self):
        sess = _bare_session()
        with self.assertLogs("nod", level="INFO") as cap:
            logging.getLogger("nod").info("sentinel")
            sess._maybe_listen_summary("stop")
        self.assertEqual(_summary_lines("\n".join(cap.output)), [])

        clk = _Clock(2000.0)
        with mock.patch("server.app.time.monotonic", clk.monotonic):
            sess._pcm_rx_note(b"\x00" * 3200)
            with self.assertLogs("nod", level="INFO") as cap:
                sess._maybe_listen_summary("stop")
            line = _summary_lines("\n".join(cap.output))[0]
            self.assertIn("reason=stop", line)
            self.assertNotIn("rx_rate=", line)
            with self.assertLogs("nod", level="INFO") as cap2:
                sess._maybe_listen_summary("pause")
            line2 = _summary_lines("\n".join(cap2.output))[0]
            self.assertIn("reason=pause", line2)
            self.assertNotIn("rx_rate=", line2)

    def test_concurrent_callers_log_one_line(self):
        sess = _bare_session()
        with mock.patch("server.app.time.monotonic", return_value=8000.0):
            sess._pcm_rx_note(b"\x00" * 3200)
        entered = threading.Event()
        release = threading.Event()
        logged: list[str] = []

        def blocking_info(_logger, msg, *args, **kwargs):
            if "listen_summary" not in str(msg):
                return
            logged.append(str(msg))
            entered.set()
            if not release.wait(timeout=2):
                raise AssertionError("second caller did not finish")

        def other():
            if not entered.wait(timeout=2):
                raise AssertionError("first caller did not log")
            sess._maybe_listen_summary()
            sess._maybe_listen_summary("pause")
            release.set()

        with mock.patch("server.app.time.monotonic", return_value=8060.0):
            with mock.patch("logging.Logger.info", blocking_info):
                first = threading.Thread(target=sess._maybe_listen_summary)
                second = threading.Thread(target=other)
                first.start()
                second.start()
                first.join(timeout=3)
                second.join(timeout=3)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(len(logged), 1)
        self.assertIn("reason=tick", logged[0])

    def test_summary_disabled(self):
        sess = _bare_session()
        clk = _Clock(3000.0)
        frame = b"\x00" * 3200
        with mock.patch.dict(os.environ, {"NOD_LISTEN_SUMMARY_S": "0"}):
            with mock.patch("server.app.time.monotonic", clk.monotonic):
                with self.assertLogs("nod", level="INFO") as cap:
                    logging.getLogger("nod").info("sentinel")
                    for _ in range(610):
                        sess._pcm_rx_note(frame)
                        sess._maybe_listen_summary()
                        clk.advance(0.1)
                    sess._maybe_listen_summary("stop")
        self.assertEqual(_summary_lines("\n".join(cap.output)), [])

    def test_push_pcm_calls_summary(self):
        sess = Session(lambda _ev: None, json.loads(json.dumps(CFG)), dict(KEYS))
        sess._deliver_pcm = mock.Mock(return_value=True)
        sess._maybe_listen_summary = mock.Mock()
        sess.push_pcm(b"\x00\x01")
        sess._maybe_listen_summary.assert_called_once_with()
        sess._deliver_pcm.return_value = False
        sess._maybe_listen_summary.reset_mock()
        sess.push_pcm(b"\x00\x01")
        sess._maybe_listen_summary.assert_not_called()

    def test_summary_translate_fields(self):
        sess = _bare_session()
        clk = _Clock(4000.0)
        recs = [
            {
                "stream": "s",
                "stt_turn": 1,
                "src": "final",
                "cut_reason": "stall",
                "first_word_ms": 0,
                "last_word_ms": 4000,
            },
            {
                "stream": "s",
                "stt_turn": 2,
                "src": "carry_join",
                "cut_reason": "max",
                "first_word_ms": 0,
                "last_word_ms": 6000,
                "carry_wait_ms": 1200,
            },
            {
                "stream": "s",
                "stt_turn": 2,
                "src": "final",
                "cut_reason": "max",
                "first_word_ms": 0,
                "last_word_ms": 6000,
            },
            {"src": "carry_timer", "carry_wait_ms": 2500},
        ]
        with mock.patch("server.app.time.monotonic", clk.monotonic):
            sess._pcm_rx_note(b"\x00" * 3200)
            for rec in recs:
                sess._log_translate_latency(rec)
            with self.assertLogs("nod", level="INFO") as cap:
                sess._maybe_listen_summary("stop")
        line = _summary_lines("\n".join(cap.output))[0]
        self.assertIn("pieces=4", line)
        self.assertIn("span_p50_ms=5000", line)
        self.assertIn("carry_wait_max_ms=2500", line)
        self.assertIn("carry_timer_pct=25", line)
        self.assertIn("cut_stall=1", line)
        self.assertIn("cut_max=1", line)
        self.assertNotIn("cut_eot", line)


class ListenSummaryPureTests(unittest.TestCase):
    def setUp(self) -> None:
        from server.stt_latency import ListenSummary

        self.ListenSummary = ListenSummary

    def test_empty_fields_all_none(self):
        fields = self.ListenSummary().fields()
        self.assertTrue(fields)
        self.assertTrue(all(v is None for v in fields.values()))

    def test_distinct_key_dedupe(self):
        summary = self.ListenSummary()
        summary.note_piece(
            {"src": "final", "stream": "s", "turn": 1, "line_span_ms": 4000, "cut": "eot"}
        )
        summary.note_piece(
            {"src": "final", "stream": "s", "turn": 1, "line_span_ms": 9000, "cut": "stall"}
        )
        fields = summary.fields()
        self.assertEqual(fields["pieces"], 2)
        self.assertEqual(fields["span_p50_ms"], 4000)
        self.assertEqual(fields["cut_eot"], 1)
        self.assertIsNone(fields["cut_stall"])

    def test_key_bound_512(self):
        summary = self.ListenSummary()
        for i in range(513):
            summary.note_piece(
                {"src": "final", "stream": "s", "turn": i, "line_span_ms": 1000 + i, "cut": "eot"}
            )
        fields = summary.fields()
        self.assertEqual(fields["pieces"], 513)
        self.assertEqual(fields["cut_eot"], 512)
        # Oldest key (span 1000) is dropped; remaining spans are 1001..1512.
        self.assertEqual(fields["span_p50_ms"], 1256)
        self.assertEqual(fields["span_p90_ms"], 1461)

    def test_reset(self):
        summary = self.ListenSummary()
        summary.note_piece({"src": "carry_timer", "carry_wait_ms": 10})
        summary.note_lag(40)
        summary.reset()
        self.assertTrue(all(v is None for v in summary.fields().values()))

    def test_carry_timer_pct_rounding(self):
        summary = self.ListenSummary()
        summary.note_piece({"src": "carry_timer", "carry_wait_ms": 1})
        summary.note_piece({"src": "final", "stream": "s", "turn": 1, "line_span_ms": 10, "cut": "eot"})
        summary.note_piece({"src": "final", "stream": "s", "turn": 2, "line_span_ms": 20, "cut": "max"})
        self.assertEqual(summary.fields()["carry_timer_pct"], 33)
        summary.note_piece({"src": "carry_timer"})
        summary.note_piece({"src": "carry_timer"})
        # 3/5 = 60 exactly; a 2/3 case rounds 66.6 to 67.
        third = self.ListenSummary()
        third.note_piece({"src": "carry_timer"})
        third.note_piece({"src": "carry_timer"})
        third.note_piece({"src": "final"})
        self.assertEqual(third.fields()["carry_timer_pct"], 67)


class FormatListenSummaryTests(unittest.TestCase):
    def test_omits_none_and_keeps_order(self):
        from server.stt_latency import format_listen_summary

        line = format_listen_summary(
            {
                "cut_stall": 1,
                "reason": "tick",
                "rx_rate": None,
                "client": "ios",
                "stream": "3-ab12",
            }
        )
        self.assertEqual(line, "listen_summary stream=3-ab12 reason=tick client=ios cut_stall=1")


class UplinkClientKindTests(unittest.TestCase):
    def test_kind_table(self):
        from server.stt_latency import uplink_client_kind
        cases = [
            ("Nodpilot/96 CFNetwork/1498.700.2 Darwin/23.6.0", "ios"),
            ("okhttp/4.12.0", "android"),
            ("", "unknown"),
            (None, "unknown"),
            ("Mozilla/5.0", "other"),
        ]
        for ua, kind in cases:
            with self.subTest(ua=ua):
                self.assertEqual(uplink_client_kind(ua), kind)


class UplinkWsSummaryTests(unittest.TestCase):
    def setUp(self) -> None:
        from server import uplink

        uplink.reset()

    def tearDown(self) -> None:
        from server import uplink

        uplink.reset()

    def test_ws_audio_records_client_kind(self):
        from server import uplink
        from server.app import app
        from tests.test_uplink import _session

        sess = _session()
        sess._listener = object()
        uplink.register(sess)
        client = TestClient(app)
        with client.websocket_connect(
            f"/ws/audio?token={sess.audio_token}",
            headers={"user-agent": "okhttp/4.12.0"},
        ):
            time.sleep(0.05)
        self.assertEqual(sess._uplink_client, "android")

    def test_uplink_ping_counters_logged(self):
        from server import uplink
        from server.app import app
        from tests.test_uplink import _session

        sess = _session()
        sess._listener = object()
        uplink.register(sess)
        client = TestClient(app)
        with self.assertLogs("nod", level="INFO") as cap:
            with client.websocket_connect(
                f"/ws/audio?token={sess.audio_token}",
                headers={"user-agent": "okhttp/4.12.0"},
            ) as ws:
                ws.send_text(
                    json.dumps(
                        {
                            "type": "ping",
                            "pending_ms": 1200,
                            "enqueued_ms": 60000,
                            "sent_ms": 58800,
                            "dropped_ms": 0,
                            "sock_queue_ms": 0,
                        }
                    )
                )
                time.sleep(0.05)
                ws.send_text(json.dumps({"type": "ping", "pending_ms": 10, "sent_ms": True, "enqueued_ms": -5}))
                time.sleep(0.05)
        text = "\n".join(cap.output)
        self.assertIn(
            "uplink_ping pending_ms=1200 enqueued_ms=60000 sent_ms=58800 dropped_ms=0 sock_queue_ms=0",
            text,
        )
        self.assertIn("client=", text)
        self.assertIn("enqueued_ms=0", text)
        second = [ln for ln in cap.output if "pending_ms=10" in ln][0]
        self.assertNotIn("sent_ms=", second)
        self.assertEqual(sess._uplink_pending_ms, 10)


class HealthShaTests(unittest.TestCase):
    def test_health_reports_sha(self):
        from server.app import health

        sha = "accbf29f882a17ed85fd7d2fa313da2c99533708"
        with mock.patch.dict(os.environ, {"RAILWAY_GIT_COMMIT_SHA": sha}):
            body = health()
        self.assertEqual(body["sha"], "accbf29f882a")
        with mock.patch.dict(os.environ):
            os.environ.pop("RAILWAY_GIT_COMMIT_SHA", None)
            body = health()
        self.assertEqual(body["sha"], "")
