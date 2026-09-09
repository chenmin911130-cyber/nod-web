"""Issue #165 P1: a large seed/hold send must not drop newly-arrived frames.

The old sender drained the whole dispatch buffer into a local list and sent it
frame-by-frame at realtime pace without re-reading the queue, so a 1 MiB seed
(33 s of audio) starved the 240-item queue and drop-oldest kicked in. This
module drives the REAL CloudListener sender and Session entry points with a
byte-budgeted, ordering-preserving sender and asserts no frame is lost, repeat
counted, or reordered.

These tests do not sleep tens of seconds: they patch the pace so the sender
runs at the test's speed, and use event ordering to layout the timeline.
"""
from __future__ import annotations

import threading
import time
import unittest
from unittest import mock

from server import uplink
from server.app import (
    CFG,
    PCM_ACCEPTED,
    PCM_BACKPRESSURE,
    PCM_TERMINATED,
    STT_PCM_BUF_MAX,
    CloudListener,
    Session,
    _reset_live_stt,
)

from tests.test_pcm_drain import _session
from tests.test_stt_terminate import _connected_ws


def _listener() -> CloudListener:
    return CloudListener(
        api_key="k",
        cfg={"stt": {}},
        on_final=lambda *a: None,
        on_partial=None,
        on_error=None,
    )


class SenderBudgetTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()
        _reset_live_stt()
        # Run the sender as fast as the test's clock allows (no realtime pacing).
        self._pace = mock.patch("server.app.pace_wait_s", return_value=0.0)
        self._pace.start()

    def tearDown(self) -> None:
        self._pace.stop()
        uplink.reset()
        _reset_live_stt()

    def _connected_sender(self, lst: CloudListener) -> mock.Mock:
        ws = _connected_ws()
        lst._ws = ws
        lst._stop.clear()
        lst._was_ready = True
        lst._ready.set()
        t = threading.Thread(target=lst._sender, daemon=True)
        lst._sender_thread = t
        t.start()
        return ws

    def _binary(self, ws) -> list[bytes]:
        return [
            c.args[0]
            for c in ws.send.call_args_list
            if c.args and isinstance(c.args[0], (bytes, bytearray))
        ]

    def _complete(self, lst: CloudListener) -> None:
        lst._stop.set()
        t = getattr(lst, "_sender_thread", None)
        if t:
            t.join(1.0)

    def test_push_pcm_returns_explicit_result(self) -> None:
        lst = _listener()
        self.assertEqual(lst.push_pcm(b"\x01" * 1600), PCM_ACCEPTED)
        got = lst.take_unsent(timeout=0.5)
        self.assertEqual(got.kind, "ready")
        self.assertEqual(len(got.pcm), 1600)

    def test_budget_backpressures_at_byte_boundary(self) -> None:
        lst = _listener()
        # Fill the budget with one frame, then verify a byte over it is refused
        # rather than silently dropping the oldest (old queue maxsize=240).
        frame = b"\x02" * (STT_PCM_BUF_MAX // 2)
        self.assertEqual(lst.push_pcm(frame), PCM_ACCEPTED)
        self.assertEqual(lst.push_pcm(frame), PCM_ACCEPTED)
        self.assertEqual(
            lst.push_pcm(b"\x03" * 1600),
            PCM_BACKPRESSURE,
            "over-budget push must be refused, not drop-oldest",
        )

    def test_large_seed_plus_live_frames_all_sent_in_order(self) -> None:
        """P1 core: seed >= 1 MiB, inject >= 300 live 3200-byte frames.

        Every byte must be sent exactly once, in order (seed first), and the
        wired pcm_end must only report success after the tail is sent.
        """
        lst = _listener()
        ws = self._connected_sender(lst)
        seed = bytes([0x11]) * (1024 * 1024)
        lst.seed_unsent(seed)
        live = [bytes([0x22 | (i % 8)]) * 3200 for i in range(300)]
        for frame in live:
            self.assertEqual(lst.push_pcm(frame), PCM_ACCEPTED)
        ok = lst.drain(timeout=5.0)
        self._complete(lst)
        self.assertTrue(ok, "drain must succeed once the tail is actually sent")
        sent = b"".join(self._binary(ws))
        expected = seed + b"".join(live)
        self.assertEqual(sent, expected, "outbound must equal seed + all live frames, in order")
        # Raw byte accounting: every byte delivered exactly once, no repeats.
        self.assertEqual(len(sent), len(expected))

    def test_end_only_succeeds_after_tail_sent(self) -> None:
        """P1: pcm_drained is emitted only after the tail is actually sent.

        Drives the REAL pcm_end -> _finish_pcm_end_if_ready -> listener.drain
        chain. With the sender not yet able to send (drain returns False), no
        pcm_drained is emitted; once the drain succeeds and the Session re-arms
        (a later frame arrives), the completion offset is confirmed and emitted.
        """
        sess = _session()
        sess.usage_session_id = "sess-live"
        sess._listen_wanted = True
        sess._listen_started_at = time.time()
        sess._consent_ok = True
        sess.pipeline._keys["ASSEMBLYAI_API_KEY"] = "k"
        lst = mock.Mock()
        lst.drain.return_value = False  # tail not sent yet
        lst.push_pcm.return_value = PCM_ACCEPTED
        sess._listener = lst
        sess._pcm_rx_bytes = 4800
        sess._stt_tx_bytes = 0
        sess._pcm_end_id = "sess-live"
        sess._pcm_end_capture = "cap-a"
        sess._pcm_end_offset = 4800
        events: list[dict] = []
        sess.emit = events.append
        sess.pcm_end("sess-live", 4800, "cap-a")
        self.assertEqual(
            [e.get("type") for e in events],
            [],
            "drain not ready -> must NOT claim complete success even though offset is set",
        )
        # The sender catches up; a later frame re-arms the drain.
        lst.drain.return_value = True
        sess._stt_tx_bytes = 4800
        sess.push_pcm(b"\x66" * 1600)
        drained = [e for e in events if e.get("type") == "pcm_drained"]
        self.assertEqual(
            drained,
            [{"type": "pcm_drained", "id": "sess-live", "capture_id": "cap-a", "byte_offset": 4800}],
            "tail sent -> Session confirms at the exact completion offset",
        )


class SessionBudgetOverloadTests(unittest.TestCase):
    """P1 #4: reaching the byte budget latches incomplete + keeps original,
    and is never reported as a successful drain."""

    def setUp(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def tearDown(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def _live_session(self) -> Session:
        sess = _session()
        sess.usage_session_id = "sess-live"
        sess._listen_wanted = True
        sess._listen_started_at = time.time()
        sess._consent_ok = True
        sess.pipeline._keys["ASSEMBLYAI_API_KEY"] = "k"
        sess._paused = False
        return sess

    def test_full_listener_latches_incomplete_and_keeps_original(self) -> None:
        sess = self._live_session()
        sess._listener = None
        sess._handoff_listener = None
        # A live listener whose byte budget is already exhausted.
        lst = mock.Mock()
        lst.push_pcm.return_value = PCM_BACKPRESSURE
        sess._listener = lst
        events: list[dict] = []
        sess.emit = events.append
        sess.push_pcm(b"\x44" * 1600)
        self.assertTrue(
            sess._pcm_stall_reported,
            "budget exhaustion must latch incomplete, not pass silently",
        )
        self.assertEqual(
            [e.get("type") for e in events if e.get("type") == "pcm_drained"],
            [],
            "an overflow frame must never be acked as complete success",
        )

    def test_stopped_listener_returns_terminated(self) -> None:
        lst = _listener()
        lst._stop.set()
        self.assertEqual(lst.push_pcm(b"\x45" * 1600), PCM_TERMINATED)

    def test_handoff_hold_flush_backpressure_keeps_hold(self) -> None:
        """P1 #1: a hold flush refused by a full listener must move back to the
        hold (not be lost), and must not fabricate success."""
        sess = self._live_session()
        sess._pcm_hold = bytearray(b"\x46" * 1600)
        lst = mock.Mock()
        lst.push_pcm.return_value = PCM_BACKPRESSURE
        sess._flush_pcm_hold_into(lst)
        self.assertEqual(len(sess._pcm_hold), 1600, "refused hold bytes must be preserved")
        self.assertTrue(sess._pcm_stall_reported)


if __name__ == "__main__":
    unittest.main()
