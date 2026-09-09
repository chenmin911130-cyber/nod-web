"""AssemblyAI streaming audio: 50–1000 ms chunks, not faster than realtime.

https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures
3007 is either a duration violation or audio arriving faster than wall clock.
"""

from __future__ import annotations

import json
import threading
import unittest

from server.app import CloudListener
from server.stt_audio import (
    MIN_CHUNK_BYTES,
    TARGET_CHUNK_BYTES,
    duration_ms,
    error_summary,
    pace_wait_s,
    take_final_frames,
    take_frames,
)

from tests.test_stt_terminate import _connected_ws


class DurationTests(unittest.TestCase):
    def test_100ms_frame_is_3200_bytes(self):
        self.assertEqual(duration_ms(3200), 100.0)

    def test_50ms_floor(self):
        self.assertEqual(duration_ms(1600), 50.0)
        self.assertLess(duration_ms(1599), 50.0)

    def test_1000ms_ceiling(self):
        self.assertEqual(duration_ms(32000), 1000.0)


class FrameSplitTests(unittest.TestCase):
    def test_sub_50ms_stays_buffered(self):
        buf = bytearray(b"\x00" * 800)
        self.assertEqual(take_frames(buf), [])
        self.assertEqual(len(buf), 800)

    def test_final_pads_sub_50ms_tail(self):
        buf = bytearray(b"\x00" * 800)
        frames = take_final_frames(buf)
        self.assertEqual([len(f) for f in frames], [1600])
        self.assertEqual(len(buf), 0)

    def test_50ms_is_emitted(self):
        buf = bytearray(b"\x00" * 1600)
        frames = take_frames(buf)
        self.assertEqual([len(f) for f in frames], [1600])
        self.assertEqual(len(buf), 0)

    def test_prefers_100ms_then_emits_remaining_50ms(self):
        buf = bytearray(b"\x00" * 5000)
        frames = take_frames(buf)
        self.assertEqual([len(f) for f in frames], [3200, 1800])
        self.assertEqual(len(buf), 0)

    def test_splits_over_1000ms(self):
        buf = bytearray(b"\x00" * 40000)
        frames = take_frames(buf)
        self.assertTrue(all(MIN_CHUNK_BYTES <= len(f) <= 32000 for f in frames))
        self.assertEqual(sum(len(f) for f in frames), 40000)
        self.assertTrue(all(len(f) <= TARGET_CHUNK_BYTES for f in frames))


class RealtimePaceTests(unittest.TestCase):
    def test_40fps_of_100ms_audio_must_wait(self):
        # 100 ms audio sent 25 ms after the previous send = 4× realtime.
        self.assertAlmostEqual(pace_wait_s(0.100, 0.025), 0.075, places=3)

    def test_realtime_needs_no_wait(self):
        self.assertEqual(pace_wait_s(0.100, 0.100), 0.0)

    def test_slower_than_realtime_needs_no_wait(self):
        self.assertEqual(pace_wait_s(0.100, 0.150), 0.0)

    def test_first_send_does_not_wait(self):
        self.assertEqual(pace_wait_s(0.0, 0.0), 0.0)


class ErrorSummaryTests(unittest.TestCase):
    def test_keeps_code_and_duration_message(self):
        code, text = error_summary({
            "type": "Error",
            "error_code": 3007,
            "error": "Input duration violation: 25 ms. Expected between 50 and 1000 ms",
        })
        self.assertEqual(code, 3007)
        self.assertIn("Input duration violation", text)
        self.assertIn("25 ms", text)

    def test_keeps_rate_exceeded_message(self):
        code, text = error_summary({
            "type": "Error",
            "error_code": 3007,
            "error": "Audio Transmission Rate Exceeded: Received 1.2 sec. audio in 0.3 sec",
        })
        self.assertEqual(code, 3007)
        self.assertIn("Transmission Rate Exceeded", text)

    def test_does_not_keep_authorization(self):
        _code, text = error_summary({
            "type": "Error",
            "error_code": 1008,
            "error": "Unauthorized",
            "authorization": "secret-token",
            "audio": "AAAA",
        })
        self.assertNotIn("secret-token", text)
        self.assertNotIn("AAAA", text)


class CloudListenerSttSendTests(unittest.TestCase):
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

    def test_does_not_forward_sub_50ms_audio(self):
        lst = self._listener()
        ws = _connected_ws()
        lst._ws = ws
        lst.push_pcm(b"\x00" * 800)
        self._run_sender(lst, 0.15)
        self.assertEqual(self._binary_sends(ws), [])

    def test_forwards_50ms_audio(self):
        lst = self._listener()
        ws = _connected_ws()
        lst._ws = ws
        lst.push_pcm(b"\x00" * 1600)
        self._run_sender(lst, 0.2)
        frames = self._binary_sends(ws)
        self.assertEqual([len(f) for f in frames], [1600])

    def test_does_not_burst_two_100ms_frames_faster_than_realtime(self):
        lst = self._listener()
        ws = _connected_ws()
        lst._ws = ws
        lst.push_pcm(b"\x00" * 3200)
        lst.push_pcm(b"\x00" * 3200)
        self._run_sender(lst, 0.05)
        self.assertEqual([len(f) for f in self._binary_sends(ws)], [3200])

    def test_error_logs_code_message_and_last_chunk(self):
        lst = self._listener()
        lst._record_send(b"\x00" * 800)
        payload = {
            "type": "Error",
            "error_code": 3007,
            "error": "Input duration violation: 25 ms. Expected between 50 and 1000 ms",
        }
        with self.assertLogs("nod", level="WARNING") as cm:
            lst._on_message(None, json.dumps(payload))
        joined = "\n".join(cm.output)
        self.assertIn("3007", joined)
        self.assertIn("Input duration violation", joined)
        self.assertIn("chunk_bytes=800", joined)
        self.assertIn("chunk_ms=25", joined)

    def test_close_3007_logs_last_chunk(self):
        lst = self._listener()
        lst._was_ready = True
        lst._record_send(b"\x00" * 800)
        with self.assertLogs("nod", level="WARNING") as cm:
            lst._on_close(None, 3007, "See Error message for details")
        joined = "\n".join(cm.output)
        self.assertIn("3007", joined)
        self.assertIn("chunk_bytes=800", joined)
        self.assertIn("chunk_ms=25", joined)


if __name__ == "__main__":
    unittest.main()
