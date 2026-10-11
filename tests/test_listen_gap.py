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
        self.tracker._store_baseline(t0 + 5, 0, 0, 0)
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
        self.tracker.note_ping(self.t0 + 5, 0, 0, 0, False, self.t0, 0.0)
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

    def test_reset_between_recordings(self) -> None:
        self.tracker.note_ping(self.t0 + 20, 20_000, 0, 0, False, self.t0, 0.0)
        self.tracker.reset()
        gaps = self.tracker.note_ping(self.t0 + 150, 20_050, 0, 0, False, self.t0, 0.0)
        self.assertEqual(gaps, [])
        gaps = self.tracker.note_ping(self.t0 + 170, 40_050, 0, 0, False, self.t0, 0.0)
        self.assertEqual(gaps, [])
        self.tracker.note_ping(self.t0 + 175, 40_050, 0, 0, False, self.t0, 0.0)
        self.tracker.note_pcm(self.t0 + 195, self.t0 + 175)
        gaps = self.tracker.note_ping(self.t0 + 195, 40_050, 0, 0, False, self.t0, 0.0)
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0].id, "gap-1")
        self.tracker.note_ping(self.t0 + 215, 60_050, 0, 0, False, self.t0, 0.0)
        self.tracker.reset()
        self.tracker.note_ping(self.t0 + 400, 0, 0, 0, False, self.t0, 0.0)
        self.tracker.note_pcm(self.t0 + 420, self.t0 + 400)
        gaps = self.tracker.note_ping(self.t0 + 420, 0, 0, 0, False, self.t0, 0.0)
        self.assertEqual(gaps[0].id, "gap-2")

    def test_capture_spans_ping_boundary_single_gap(self) -> None:
        base = self.t0
        self.tracker._store_baseline(base + 70, 70_000, 0, 0)
        self.tracker.note_ping(base + 90, 90_000, 0, 0, False, base, 0.0)
        self.tracker.note_pcm(base + 125, base + 105)
        g1 = self.tracker.note_ping(base + 110, 90_000, 0, 0, False, base, 0.0)
        self.assertEqual(len(g1), 1)
        self.assertEqual(g1[0].reason, "capture")
        want_from = recording_rel_ms(base + 105, base, 0.0)
        self.assertGreaterEqual(g1[0].from_ms, want_from - 1000)
        self.assertLessEqual(g1[0].from_ms, want_from + 1000)
        self.assertGreaterEqual(g1[0].to_ms - g1[0].from_ms, 19_000)
        self.assertLessEqual(g1[0].to_ms - g1[0].from_ms, 21_000)
        g2 = self.tracker.note_ping(base + 130, 100_000, 0, 0, False, base, 0.0)
        self.assertEqual(len(g2), 1)
        self.assertEqual(g2[0].id, g1[0].id)
        self.assertGreater(g2[0].to_ms, g1[0].to_ms)

    def test_capture_60s_spans_four_pings_single_gap(self) -> None:
        base = self.t0
        self.tracker._store_baseline(base, 0, 0, 0)
        t = base
        enq = 0
        for mark in (20, 40, 60):
            t = base + mark
            enq = mark * 1000
            self.tracker.note_ping(t, enq, 0, 0, False, base, 0.0)
        call_start = base + 65
        call_end = base + 125
        self.tracker.note_pcm(call_end, call_start)
        ids: list[str] = []
        for mark in (80, 100, 120, 140):
            gaps = self.tracker.note_ping(base + mark, enq, 0, 0, False, base, 0.0)
            for g in gaps:
                if g.reason == "capture":
                    ids.append(g.id)
        self.assertTrue(ids)
        self.assertEqual(len(set(ids)), 1)
        last = [g for g in self.tracker.note_ping(base + 140, enq, 0, 0, False, base, 0.0) if g.reason == "capture"]
        if not last:
            last = [g for g in self.tracker.note_ping(base + 160, enq + 20_000, 0, 0, False, base, 0.0) if g.reason == "capture"]
        if last:
            self.assertGreaterEqual(last[0].to_ms - last[0].from_ms, 59_000)
            self.assertLessEqual(last[0].to_ms - last[0].from_ms, 61_000)

    def test_capture_contained_uses_pcm_pause_start(self) -> None:
        base = self.t0
        self.tracker.note_ping(base + 10, 10_000, 0, 0, False, base, 0.0)
        self.tracker.note_pcm(base + 20, base + 10)
        gaps = self.tracker.note_ping(base + 20, 10_000, 0, 0, False, base, 0.0)
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0].from_ms, recording_rel_ms(base + 10, base, 0.0))
        self.assertGreaterEqual(gaps[0].to_ms - gaps[0].from_ms, 9_000)
        self.assertLessEqual(gaps[0].to_ms - gaps[0].from_ms, 11_000)

    def test_missing_fields_skip_signal_and_keep_baseline(self) -> None:
        self.tracker = GapTracker()
        t = self.t0
        for step in range(3):
            gaps = self.tracker.note_ping(t + 20, None, None, 0, False, self.t0, 0.0)
            self.assertEqual(gaps, [])
            t += 20
        gaps = self.tracker.note_ping(t + 20, 0, 0, 0, False, self.t0, 0.0)
        self.assertEqual(gaps, [])
        self.tracker.note_ping(t + 40, 20_000, 0, 0, False, self.t0, 0.0)
        gaps = self.tracker.note_ping(t + 60, 40_000, 0, 0, False, self.t0, 0.0)
        self.assertEqual(gaps, [])

    def test_dropped_position_prefers_pcm_pause_start(self) -> None:
        t_out = self.t0 + 5
        t_back = self.t0 + 35
        self.tracker.note_ping(self.t0, 0, 0, 0, False, self.t0, 0.0)
        self.tracker.note_ping(self.t0 + 20, 20_000, 0, 0, False, self.t0, 0.0)
        self.tracker.note_pcm(t_back, t_out)
        self.tracker.note_resume(t_back)
        gaps = self.tracker.note_ping(self.t0 + 40, 50_000, 30_000, 0, False, self.t0, 0.0)
        dropped = [g for g in gaps if g.reason == "dropped"]
        self.assertEqual(len(dropped), 1)
        self.assertEqual(dropped[0].from_ms, recording_rel_ms(t_out, self.t0, 0.0))
        self.assertNotEqual(dropped[0].from_ms, recording_rel_ms(t_back, self.t0, 0.0))


class SessionLifecycleGapTests(unittest.TestCase):
    def test_start_listening_resets_tracker(self) -> None:
        sess = _session()
        sess._gap_tracker = mock.Mock()
        sess._open_listener = mock.Mock()
        with mock.patch.object(sess, "_claim_listen_start", return_value=True):
            sess._start_listening()
        sess._gap_tracker.reset.assert_called_once()
        sess._start_listening(resume=True)
        sess._gap_tracker.reset.assert_called_once()

    def test_stop_listening_resets_tracker(self) -> None:
        sess = _session()
        tracker = mock.Mock()
        sess._gap_tracker = tracker
        sess._listener = mock.Mock()
        sess._workspace = "meeting"
        sess._stop_flushing = False
        sess._listen_flush_done = False
        sess.emit = mock.Mock()
        sess._stop_listener = mock.Mock()
        sess._flush_translate_carry = mock.Mock()
        sess._maybe_listen_summary = mock.Mock()
        sess._commit_listener_tail = mock.Mock()
        sess._flush_meeting_hold = mock.Mock()
        sess._drain_meeting_after_stop = mock.Mock(return_value=True)
        sess._close_open_line = mock.Mock()
        sess._emit_listen_flush = mock.Mock()
        sess._emit_phase = mock.Mock()
        sess._flush_cloud_archive = mock.Mock()
        sess._cancel_stt_restart_timer = mock.Mock()
        sess._abandon_handoff = mock.Mock()
        sess._stop_listening()
        tracker.reset.assert_called_once()


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
    def test_idle_pings_without_listener_write_nothing(self, mock_update) -> None:
        sess = _session()
        sess._listener = None
        sess.usage_session_id = "usage-ended"
        emitted: list[dict] = []
        sess.emit = lambda ev: emitted.append(ev)
        uplink.register(sess)
        client = TestClient(app)
        t = 4_000_000.0
        with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
            ws.receive_text()
            for step in range(4):
                t += 20.0
                with mock.patch("time.time", return_value=t):
                    ws.send_text(
                        json.dumps(
                            {
                                "type": "ping",
                                "enqueued_ms": 50_000,
                                "dropped_ms": 0,
                                "sent_ms": 0,
                            }
                        )
                    )
        mock_update.assert_not_called()
        self.assertEqual([e for e in emitted if e.get("type") == "listen_gap"], [])

    def test_idle_pings_without_listener_do_not_touch_tracker(self) -> None:
        sess = _session()
        sess._listener = None
        sess.usage_session_id = "usage-ended"
        sess._gap_tracker = mock.Mock()
        uplink.register(sess)
        client = TestClient(app)
        t = 5_000_000.0
        with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
            ws.receive_text()
            for step in range(4):
                t += 20.0
                with mock.patch("time.time", return_value=t):
                    ws.send_text(json.dumps({"type": "ping", "enqueued_ms": 1, "dropped_ms": 0}))
        sess._gap_tracker.note_ping.assert_not_called()

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
        sess._client_emit = None
        t0 = 3_000_000.0
        sess._listen_started_at = t0
        emitted: list[dict] = []
        sess.emit = lambda ev: emitted.append(ev)
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
        gap_ev = [e for e in emitted if e.get("type") == "listen_gap"][0]
        args, kwargs = mock_update.call_args
        self.assertEqual(kwargs.get("kind"), "gap")
        self.assertEqual(args[3], f"{gap_ev['from_ms']}-{gap_ev['to_ms']}")

    @mock.patch("server.app.run_in_threadpool", new_callable=mock.AsyncMock)
    @mock.patch("server.meter.update_history_text")
    def test_history_write_runs_in_threadpool(self, mock_update, mock_pool) -> None:
        async def _run(fn):
            fn()

        mock_pool.side_effect = _run
        sess = _session()
        sess._listener = mock.Mock(_stream_id="st")
        sess.usage_session_id = "usage-3"
        t0 = 6_000_000.0
        sess._listen_started_at = t0
        sess._gap_tracker._store_baseline(t0, 0, 0, 0)
        sess._gap_tracker.note_pcm(t0 + 25, t0 + 5)
        uplink.register(sess)
        client = TestClient(app)
        with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
            ws.receive_text()
            with mock.patch("time.time", return_value=t0 + 25):
                ws.send_text(json.dumps({"type": "ping", "enqueued_ms": 0, "dropped_ms": 0}))
        mock_pool.assert_called()
        mock_update.assert_called()

    @mock.patch("server.meter.update_history_text")
    def test_same_gap_id_upserts_history(self, mock_update) -> None:
        sess = _session()
        sess._listener = mock.Mock(_stream_id="st")
        sess.usage_session_id = "usage-4"
        base = 7_000_000.0
        sess._listen_started_at = base
        tr = sess._gap_tracker
        tr._store_baseline(base + 70, 70_000, 0, 0)
        tr.note_ping(base + 90, 90_000, 0, 0, False, base, 0.0)
        tr.note_pcm(base + 125, base + 105)
        uplink.register(sess)
        client = TestClient(app)
        with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
            ws.receive_text()
            with mock.patch("time.time", return_value=base + 110):
                ws.send_text(json.dumps({"type": "ping", "enqueued_ms": 90_000, "dropped_ms": 0}))
            with mock.patch("time.time", return_value=base + 130):
                ws.send_text(json.dumps({"type": "ping", "enqueued_ms": 110_000, "dropped_ms": 0}))
        qids = [c.args[2] for c in mock_update.call_args_list]
        texts = [c.args[3] for c in mock_update.call_args_list]
        self.assertGreaterEqual(len(qids), 1)
        self.assertEqual(len(set(qids)), 1)
        if len(texts) >= 2:
            self.assertGreater(int(texts[1].split("-")[1]), int(texts[0].split("-")[1]))


if __name__ == "__main__":
    unittest.main()
