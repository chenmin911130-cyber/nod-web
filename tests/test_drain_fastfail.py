"""Issue #165 review P2-5: a failed/stopped drain must return fast.

The old drain() blocked on a single Event with the full 120 s timeout, so a send
failure or a stopped listener held the calling thread until the ceiling. These
tests drive the real CloudListener sender and assert drain returns well before
the cap in the failure cases, and that a failed tail is restored so Retry can
actually send it (no fake success).
"""
from __future__ import annotations

import threading
import time
import unittest

from server import uplink
from server.app import CloudListener, _reset_live_stt

from tests.test_stt_terminate import _connected_ws


class DrainFastFailTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def tearDown(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def _listener(self) -> CloudListener:
        return CloudListener(
            api_key="k",
            cfg={"stt": {}},
            on_final=lambda *a: None,
            on_partial=None,
            on_error=None,
        )

    def _start_sender(self, lst: CloudListener) -> threading.Thread:
        lst._stop.clear()
        lst._was_ready = True
        lst._ready.set()
        t = threading.Thread(target=lst._sender, daemon=True)
        lst._sender_thread = t
        t.start()
        return t

    def test_drain_returns_false_when_sender_send_fails(self) -> None:
        lst = self._listener()
        ws = _connected_ws()
        ws.send.side_effect = RuntimeError("socket blew up")
        lst._ws = ws
        lst._pcm_buf.extend(b"\x07" * 1600)
        t = self._start_sender(lst)
        start = time.monotonic()
        ok = lst.drain(timeout=10.0)
        elapsed = time.monotonic() - start
        self.assertFalse(ok)
        self.assertLess(elapsed, 3.0, f"drain must fail fast, took {elapsed:.2f}s")
        self.assertGreater(len(lst._pcm_buf), 0, "the unsent frame must not be lost")
        lst._stop.set()
        t.join(1.0)

    def test_drain_returns_false_when_already_stopped(self) -> None:
        lst = self._listener()
        lst._stop.set()
        start = time.monotonic()
        self.assertFalse(lst.drain(timeout=10.0))
        self.assertLess(time.monotonic() - start, 1.0)

    def test_drain_fails_fast_when_stopped_mid_wait(self) -> None:
        lst = self._listener()
        # A disconnected ws means the sender can never complete the tail.
        ws = _connected_ws()
        ws.sock.connected = False
        lst._ws = ws
        lst._pcm_buf.extend(b"\x08" * 1600)
        t = self._start_sender(lst)
        stop_at = time.monotonic() + 0.3

        def stopper() -> None:
            while time.monotonic() < stop_at:
                time.sleep(0.05)
            lst._stop.set()

        st = threading.Thread(target=stopper, daemon=True)
        st.start()
        start = time.monotonic()
        ok = lst.drain(timeout=30.0)
        elapsed = time.monotonic() - start
        self.assertFalse(ok)
        self.assertLess(elapsed, 2.0, f"stop must wake the drain promptly, took {elapsed:.2f}s")
        t.join(1.0)


if __name__ == "__main__":
    unittest.main()
