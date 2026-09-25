"""STT sender pacing: cumulative clock with bounded catch-up (ticket A2)."""

from __future__ import annotations

import os
import threading
import unittest
from unittest import mock

from server.app import CloudListener
from server.stt_audio import PaceClock, catchup_rate_from_env, pace_mode_from_env

from tests.test_stt_terminate import _connected_ws

SEND_OVERHEAD_S = 0.0005
SLEEP_OVERSHOOT_S = 0.0003
FRAME_S = 0.1


def _run_paced_sends(
    clock: PaceClock,
    *,
    open_at: float,
    frame_times: list[float],
    frame_dur: float = FRAME_S,
) -> tuple[float, list[float]]:
    """Simulate sender loop at given arrival times; returns (final_now, wait_log)."""
    clock.open(open_at)
    now = open_at
    waits: list[float] = []
    for arrive in frame_times:
        now = max(now, arrive)
        if clock.mode == "cumulative" and clock.open_at is not None:
            assert clock.audio_sent_s <= now - clock.open_at + 1e-6
        w = clock.wait_s(now, frame_dur)
        waits.append(w)
        if w > 0:
            now += w + SLEEP_OVERSHOOT_S + SEND_OVERHEAD_S
        else:
            now += SEND_OVERHEAD_S
        clock.record(now, frame_dur)
    return now, waits


class PaceClockDriftTests(unittest.TestCase):
    def _frame_mode_slip(self) -> float:
        """Legacy per-frame anchor with sleep overshoot (no arrival gating)."""
        clock = PaceClock(mode="frame", catchup_rate=1.5)
        clock.open(0.0)
        now = 0.0
        for _ in range(600):
            w = clock.wait_s(now, FRAME_S)
            now += w + SEND_OVERHEAD_S
            if w > 0:
                now += 0.00076
            clock.record(now, FRAME_S)
        return now - 60.0

    def test_frame_mode_accumulates_slip(self):
        slip = self._frame_mode_slip()
        self.assertGreaterEqual(slip, 0.45)

    def test_cumulative_mode_stays_on_schedule(self):
        clock = PaceClock(mode="cumulative", catchup_rate=1.5)
        frame_times = [i * FRAME_S for i in range(600)]
        final_now, _ = _run_paced_sends(clock, open_at=0.0, frame_times=frame_times)
        slip = (final_now + FRAME_S) - 60.0
        self.assertLess(abs(slip), 0.05)
        self.assertAlmostEqual(clock.audio_sent_s, 60.0, places=3)


class PaceClockCatchupTests(unittest.TestCase):
    def test_burst_catchup_respects_rate_and_budget(self):
        clock = PaceClock(mode="cumulative", catchup_rate=1.5)
        open_at = 0.0
        clock.open(open_at)
        now = 3.0
        waits: list[float] = []
        for i in range(30):
            w = clock.wait_s(now, FRAME_S)
            waits.append(w)
            if i > 0:
                self.assertGreaterEqual(w, FRAME_S / 1.5 - 1e-6)
            self.assertGreaterEqual(w, 0.0)
            now += w + SEND_OVERHEAD_S
            clock.record(now, FRAME_S)
            self.assertLessEqual(clock.audio_sent_s, now - open_at + 1e-9)
        self.assertTrue(any(w > 0 for w in waits))

    def test_catchup_rate_one_spaces_at_realtime(self):
        clock = PaceClock(mode="cumulative", catchup_rate=1.0)
        clock.open(0.0)
        now = 5.0
        spacing: list[float] = []
        prev = now
        for _ in range(10):
            w = clock.wait_s(now, FRAME_S)
            now += w
            clock.record(now, FRAME_S)
            spacing.append(now - prev)
            prev = now
        for gap in spacing[1:]:
            self.assertAlmostEqual(gap, FRAME_S, places=3)


class PaceClockSeededTests(unittest.TestCase):
    def test_preloaded_audio_not_faster_than_realtime(self):
        clock = PaceClock(mode="cumulative", catchup_rate=1.5)
        clock.open(0.0)
        now = 0.0
        send_times: list[float] = []
        for _ in range(100):
            w = clock.wait_s(now, FRAME_S)
            now += w + SEND_OVERHEAD_S
            clock.record(now, FRAME_S)
            send_times.append(now)
        self.assertGreaterEqual(send_times[-1], 9.9)


class PaceClockGapTests(unittest.TestCase):
    def test_after_silence_realtime_frames_go_immediately(self):
        clock = PaceClock(mode="cumulative", catchup_rate=1.5)
        clock.open(0.0)
        # In sync at 60 s: cumulative schedule caught up to wall clock.
        clock._sched = 60.0
        clock._last_at = 59.9
        clock._last_dur = FRAME_S
        clock._audio_sent_s = 60.0
        now = 60.0
        for i in range(5):
            arrive = 60.0 + i * FRAME_S
            now = max(now, arrive)
            w = clock.wait_s(now, FRAME_S)
            self.assertAlmostEqual(w, 0.0, places=9)
            now += SEND_OVERHEAD_S
            clock.record(now, FRAME_S)

    def test_backlog_after_gap_limited_to_catchup_rate(self):
        clock = PaceClock(mode="cumulative", catchup_rate=1.5)
        clock.open(0.0)
        now = 10.0
        waits: list[float] = []
        for _ in range(20):
            w = clock.wait_s(now, FRAME_S)
            waits.append(w)
            now += w + SEND_OVERHEAD_S
            clock.record(now, FRAME_S)
        for i, w in enumerate(waits):
            if i == 0:
                continue
            self.assertGreaterEqual(w, FRAME_S / 1.5 - 1e-6)


class PaceClockEdgeTests(unittest.TestCase):
    def test_record_before_open_anchors(self):
        clock = PaceClock(mode="cumulative")
        clock.record(1.0, 0.1)
        self.assertEqual(clock.open_at, 1.0)

    def test_restart_resets(self):
        clock = PaceClock(mode="cumulative")
        clock.open(0.0)
        clock.record(0.1, 0.1)
        clock.reset()
        self.assertIsNone(clock.open_at)
        self.assertEqual(clock.audio_sent_s, 0.0)


class EnvTests(unittest.TestCase):
    def test_pace_mode_frame(self):
        with mock.patch.dict(os.environ, {"NOD_STT_PACE_MODE": "frame"}, clear=False):
            self.assertEqual(pace_mode_from_env(), "frame")
            clock = PaceClock(mode=pace_mode_from_env())
            self.assertEqual(clock.mode, "frame")

    def test_catchup_rate_bad_values(self):
        for raw, expected in [("abc", 1.5), ("0.5", 1.0), ("9", 2.0), ("", 1.5)]:
            with self.subTest(raw=raw):
                env = {"NOD_STT_CATCHUP_RATE": raw} if raw else {}
                with mock.patch.dict(os.environ, env, clear=True):
                    self.assertEqual(catchup_rate_from_env(), expected)


class CloudListenerPaceTests(unittest.TestCase):
    def _listener(self) -> CloudListener:
        return CloudListener(
            api_key="test-key",
            cfg={"stt": {}},
            on_final=lambda *a: None,
            on_partial=None,
            on_error=None,
        )

    def _binary_sends(self, ws) -> list[bytes]:
        out: list[bytes] = []
        for call in ws.send.call_args_list:
            if call[0] and isinstance(call[0][0], (bytes, bytearray)):
                out.append(bytes(call[0][0]))
        return out

    def _run_sender(self, lst: CloudListener, timeout: float) -> None:
        lst._stop.clear()
        t = threading.Thread(target=lst._sender, daemon=True)
        t.start()
        t.join(timeout)
        lst._stop.set()
        t.join(0.5)

    def test_sender_paces_five_frames_with_cumulative_clock(self):
        lst = self._listener()
        lst._pace = PaceClock(mode="cumulative", catchup_rate=1.5)
        ws = _connected_ws()
        lst._ws = ws
        lst._on_open(ws)
        self.assertIsNotNone(lst._pace.open_at)
        for _ in range(5):
            lst.push_pcm(b"\x00" * 3200)
        self._run_sender(lst, 0.55)
        frames = self._binary_sends(ws)
        self.assertEqual(len(frames), 5)
        self.assertEqual(lst._pcm_backlog_ms(), 0)


if __name__ == "__main__":
    unittest.main()
