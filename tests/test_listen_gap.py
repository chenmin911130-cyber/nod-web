"""Listen gap detection (P3)."""

from __future__ import annotations

import json
import unittest
from unittest import mock

from starlette.testclient import TestClient

from server import uplink
from server.history_fmt import session_copy_text
from server.listen_gap import MIN_GAP_MS, GapTracker, recording_rel_ms
from server.app import app
from tests.test_uplink import _session


class GapTrackerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.t0 = 1_000_000.0
        self.tracker = GapTracker()
        self.tracker._store_baseline(self.t0, 0, 0, 0)

    def test_stable_uplink_no_gaps(self) -> None:
        t = self.t0
        enq = 0
        for _ in range(6):
            t += 20.0
            enq += 20_000
            gaps = self.tracker.note_ping(t, enq, 0, 0, False, self.t0, 0.0)
            self.assertEqual(gaps, [])

    def test_capture_call_20s(self) -> None:
        t0 = self.t0
        self.tracker.note_ping(t0 + 5, 0, 0, 0, False, t0, 0.0)
        self.tracker.note_pcm(t0 + 25, t0 + 5)
        gaps = self.tracker.note_ping(t0 + 25, 0, 0, 0, False, t0, 0.0)
        self.assertEqual(len(gaps), 1)
        g = gaps[0]
        self.assertEqual(g.reason, "capture")
        self.assertGreaterEqual(g.to_ms - g.from_ms, 19_000)
        self.assertLessEqual(g.to_ms - g.from_ms, 21_000)
        self.assertGreaterEqual(g.from_ms, recording_rel_ms(t0 + 5, t0, 0.0) - 1000)
        self.assertLessEqual(g.from_ms, recording_rel_ms(t0 + 5, t0, 0.0) + 1000)

    def test_dropped_with_resume_position(self) -> None:
        tr = self.t0 + 10
        self.tracker.note_ping(tr, 20_000, 0, 0, False, self.t0, 0.0)
        self.tracker.note_resume(tr)
        gaps = self.tracker.note_ping(self.t0 + 30, 40_000, 30_000, 0, False, self.t0, 0.0)
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0].reason, "dropped")
        self.assertEqual(gaps[0].to_ms - gaps[0].from_ms, 30_000)
        self.assertEqual(gaps[0].from_ms, recording_rel_ms(tr, self.t0, 0.0))

    def test_server_limited_bytes(self) -> None:
        gaps = self.tracker.note_ping(self.t0 + 20, 20_000, 0, 96_000, False, self.t0, 0.0)
        server = [g for g in gaps if g.reason == "server"]
        self.assertEqual(len(server), 1)
        self.assertEqual(server[0].to_ms - server[0].from_ms, 3000)

    def test_offline_catchup_no_gap(self) -> None:
        t = self.t0
        enq = 0
        for step in range(12):
            t += 20.0
            enq += 20_000
            gaps = self.tracker.note_ping(t, enq, 0, 0, False, self.t0, 0.0)
            self.assertEqual(gaps, [])
        t += 240.0
        enq += 240_000
        gaps = self.tracker.note_ping(t, enq, 0, 0, False, self.t0, 0.0)
        self.assertEqual(gaps, [])

    def test_two_gaps_ids(self) -> None:
        self.tracker.note_pcm(self.t0 + 25, self.t0 + 5)
        self.tracker.note_ping(self.t0 + 25, 0, 0, 0, False, self.t0, 0.0)
        self.tracker.note_ping(self.t0 + 45, 20_000, 0, 0, False, self.t0, 0.0)
        self.tracker.note_pcm(self.t0 + 70, self.t0 + 50)
        gaps = self.tracker.note_ping(self.t0 + 70, 20_000, 0, 0, False, self.t0, 0.0)
        capture = [g for g in gaps if g.reason == "capture"]
        self.assertTrue(capture)
        self.assertEqual(capture[0].id, "gap-2")

    def test_pause_window_no_capture(self) -> None:
        self.tracker.note_pause()
        gaps = self.tracker.note_ping(self.t0 + 60, 0, 0, 0, True, self.t0, 0.0)
        self.assertEqual(gaps, [])
        self.tracker.note_resume_listen(self.t0 + 60)
        gaps = self.tracker.note_ping(self.t0 + 80, 0, 0, 0, False, self.t0, 0.0)
        self.assertEqual(gaps, [])
        gaps = self.tracker.note_ping(self.t0 + 100, 20_000, 0, 0, False, self.t0, 0.0)
        self.assertEqual(gaps, [])

    def test_boundaries(self) -> None:
        gaps = self.tracker.note_ping(self.t0 + 2, 0, 0, 0, False, self.t0, 0.0)
        self.assertEqual(len([g for g in gaps if g.reason == "capture"]), 1)
        self.assertEqual(gaps[0].to_ms - gaps[0].from_ms, MIN_GAP_MS)
        self.tracker = GapTracker()
        self.tracker._store_baseline(self.t0, 0, 0, 0)
        gaps = self.tracker.note_ping(self.t0 + 1.999, 0, 0, 0, False, self.t0, 0.0)
        self.assertEqual(gaps, [])
        self.tracker = GapTracker()
        self.tracker._store_baseline(self.t0, 10_000, 0, 0)
        gaps = self.tracker.note_ping(self.t0 + 20, 5_000, 0, 0, False, self.t0, 0.0)
        self.assertEqual(gaps, [])
        self.tracker = GapTracker()
        self.tracker._store_baseline(self.t0, 0, 0, 0)
        gaps = self.tracker.note_ping(self.t0 + 2, 2000, 1999, 0, False, self.t0, 0.0)
        self.assertEqual(gaps, [])
        self.tracker = GapTracker()
        self.tracker._store_baseline(self.t0, 0, 0, 0)
        gaps = self.tracker.note_ping(self.t0 + 2, 2000, 2000, 0, False, self.t0, 0.0)
        self.assertEqual(len([g for g in gaps if g.reason == "dropped"]), 1)

    def test_triple_signal_one_ping(self) -> None:
        self.tracker.note_resume(self.t0 + 1)
        gaps = self.tracker.note_ping(self.t0 + 20, 0, 30_000, 96_000, False, self.t0, 0.0)
        reasons = {g.reason for g in gaps}
        self.assertEqual(reasons, {"dropped", "capture", "server"})
        self.assertEqual([g.id for g in gaps], ["gap-1", "gap-2", "gap-3"])


class SessionCopyGapTests(unittest.TestCase):
    def test_gap_kind_skipped(self) -> None:
        text = session_copy_text(
            "Title",
            "meeting",
            None,
            [
                {"kind": "gap", "text": "1000-3000"},
                {"kind": "transcript", "text": "hello"},
            ],
        )
        self.assertNotIn("GAP", text)
        self.assertIn("hello", text)


class WsAudioGapTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()

    def tearDown(self) -> None:
        uplink.reset()

    @mock.patch("server.meter.update_history_text")
    def test_ping_emits_listen_gap_and_history(self, mock_update) -> None:
        sess = _session()
        sess._listener = mock.Mock(_stream_id="st")
        sess.usage_session_id = "usage-1"
        t0 = 2_000_000.0
        sess._listen_started_at = t0
        sess._listen_accum_sec = 0.0
        emitted: list[dict] = []
        sess.emit = lambda ev: emitted.append(ev)
        uplink.register(sess)
        sess._gap_tracker._store_baseline(t0, 0, 0, 0)
        sess._gap_tracker.note_pcm(t0 + 25, t0 + 5)
        client = TestClient(app)
        with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
            ws.receive_text()
            with mock.patch("time.time", return_value=t0 + 25):
                ws.send_text(
                    json.dumps(
                        {
                            "type": "ping",
                            "pending_ms": 0,
                            "enqueued_ms": 0,
                            "sent_ms": 0,
                            "dropped_ms": 0,
                        }
                    )
                )
        gap_events = [e for e in emitted if e.get("type") == "listen_gap"]
        self.assertEqual(len(gap_events), 1)
        self.assertEqual(gap_events[0]["id"], "gap-1")
        mock_update.assert_called()
        args, kwargs = mock_update.call_args
        self.assertEqual(kwargs.get("kind"), "gap")
        self.assertEqual(args[2], "gap-1")

    @mock.patch("server.meter.update_history_text")
    def test_parked_control_still_persists_gap(self, mock_update) -> None:
        sess = _session()
        sess._listener = mock.Mock(_stream_id="st")
        sess.usage_session_id = "usage-2"
        t0 = 3_000_000.0
        sess._listen_started_at = t0
        sess._gap_tracker._store_baseline(t0, 0, 0, 0)
        sess._gap_tracker.note_pcm(t0 + 25, t0 + 5)
        uplink.register(sess)
        client = TestClient(app)
        with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
            ws.receive_text()
            with mock.patch("time.time", return_value=t0 + 25):
                ws.send_text(
                    json.dumps({"type": "ping", "enqueued_ms": 0, "dropped_ms": 0, "sent_ms": 0})
                )
        mock_update.assert_called()


if __name__ == "__main__":
    unittest.main()
