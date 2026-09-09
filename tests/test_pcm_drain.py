"""Watch End pcm_end / pcm_drained (#165). Old clients omit pcm_end."""

from __future__ import annotations

import json
import threading
import time
import unittest
from unittest import mock

from starlette.testclient import TestClient

from server import uplink
from server.app import CFG, CloudListener, Session, _reset_live_stt
from tests.test_stt_terminate import _connected_ws


def _session(user_id: str = "user-a") -> Session:
    sess = Session(lambda _ev: None, json.loads(json.dumps(CFG)), {}, user_id)
    sess.close = mock.Mock()  # type: ignore[method-assign]
    return sess


def _live(sess: Session, *, rx: int = 6400) -> mock.Mock:
    sess.usage_session_id = "sess-live"
    sess._pcm_rx_bytes = rx
    sess._stt_tx_bytes = rx
    lst = mock.Mock()
    lst.drain.return_value = True
    lst.take_unsent.return_value = b""
    sess._listener = lst
    return lst


class PcmEndTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def tearDown(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def test_wrong_session_id_does_not_drain(self) -> None:
        sess = _session()
        lst = _live(sess)
        events: list[dict] = []
        sess.emit = events.append
        sess.pcm_end("sess-old", 3200, "cap-a")
        lst.drain.assert_not_called()
        self.assertEqual(events, [])

    def test_empty_id_does_not_drain(self) -> None:
        sess = _session()
        lst = _live(sess)
        sess.emit = mock.Mock()
        sess.pcm_end("", 3200, "cap-a")
        lst.drain.assert_not_called()
        sess.emit.assert_not_called()

    def test_empty_capture_does_not_drain(self) -> None:
        sess = _session()
        lst = _live(sess)
        events: list[dict] = []
        sess.emit = events.append
        sess.pcm_end("sess-live", 6400, "")
        lst.drain.assert_not_called()
        self.assertEqual(events, [])

    def test_matching_id_drains_then_emits(self) -> None:
        sess = _session()
        lst = _live(sess)
        events: list[dict] = []
        sess.emit = events.append
        sess.pcm_end("sess-live", 6400, "cap-a")
        lst.drain.assert_called_once()
        self.assertEqual(
            events,
            [{"type": "pcm_drained", "id": "sess-live", "capture_id": "cap-a", "byte_offset": 6400}],
        )

    def test_drain_false_does_not_emit(self) -> None:
        sess = _session()
        lst = _live(sess)
        lst.drain.return_value = False
        events: list[dict] = []
        sess.emit = events.append
        sess.pcm_end("sess-live", 6400, "cap-a")
        lst.drain.assert_called_once()
        self.assertEqual(events, [])
        self.assertEqual(sess._pcm_end_id, "sess-live")
        self.assertIsNone(getattr(sess, "_pcm_drain_result", None))

    def test_drain_does_not_emit_when_stt_tx_behind_offset(self) -> None:
        sess = _session()
        lst = _live(sess, rx=6400)
        sess._stt_tx_bytes = 1600
        events: list[dict] = []
        sess.emit = events.append
        sess.pcm_end("sess-live", 6400, "cap-a")
        lst.drain.assert_called_once()
        self.assertEqual(events, [])
        self.assertEqual(sess._pcm_end_id, "sess-live")
        self.assertIsNone(getattr(sess, "_pcm_drain_result", None))

    def test_listener_none_does_not_emit(self) -> None:
        sess = _session()
        sess.usage_session_id = "sess-live"
        sess._pcm_rx_bytes = 6400
        sess._listener = None
        events: list[dict] = []
        sess.emit = events.append
        sess.pcm_end("sess-live", 6400, "cap-a")
        self.assertEqual(events, [])
        self.assertEqual(sess._pcm_end_id, "sess-live")

    def test_waits_until_bytes_arrive(self) -> None:
        sess = _session()
        lst = _live(sess, rx=0)
        events: list[dict] = []
        sess.emit = events.append
        sess.pcm_end("sess-live", 1600, "cap-a")
        lst.drain.assert_not_called()
        self.assertEqual(events, [])
        sess._pcm_rx_bytes = 1600
        lst.drain.side_effect = lambda *a, **k: setattr(sess, "_stt_tx_bytes", 1600) or True
        sess._finish_pcm_end_if_ready()
        lst.drain.assert_called_once()
        self.assertEqual(events[0]["type"], "pcm_drained")
        self.assertEqual(events[0]["capture_id"], "cap-a")

    def test_parked_emit_replays_on_reattach(self) -> None:
        sess = _session()
        lst = _live(sess)
        sess._detach_control_emit()
        sess.pcm_end("sess-live", 6400, "cap-a")
        lst.drain.assert_called_once()
        self.assertEqual(
            sess._pcm_drain_result,
            {"type": "pcm_drained", "id": "sess-live", "capture_id": "cap-a", "byte_offset": 6400},
        )
        events: list[dict] = []
        sess.emit = events.append
        sess.pipeline.emit = events.append
        sess.reattach()
        drained = [e for e in events if e.get("type") == "pcm_drained"]
        self.assertEqual(
            drained,
            [{"type": "pcm_drained", "id": "sess-live", "capture_id": "cap-a", "byte_offset": 6400}],
        )

    def test_retry_replays_saved_drain(self) -> None:
        sess = _session()
        lst = _live(sess)
        events: list[dict] = []
        sess.emit = events.append
        sess.pcm_end("sess-live", 6400, "cap-a")
        lst.drain.reset_mock()
        events.clear()
        sess.pcm_end("sess-live", 6400, "cap-a")
        lst.drain.assert_not_called()
        self.assertEqual(events[0]["type"], "pcm_drained")

    def test_resume_keeps_pcm_rx_bytes(self) -> None:
        sess = _session()
        sess.usage_session_id = "sess-live"
        sess._pcm_rx_bytes = 320_000
        sess._pcm_end_id = "sess-live"
        sess._pcm_end_capture = "cap-a"
        sess._pcm_end_offset = 640_000
        sess._listen_wanted = True
        sess.pipeline._keys["ASSEMBLYAI_API_KEY"] = "k"
        lst = mock.Mock()
        lst.drain.return_value = True
        with (
            mock.patch("server.app.CloudListener", return_value=lst),
            mock.patch("server.app._adopt_live_stt", return_value=None),
            mock.patch("server.app._ensure_idle_watch_thread"),
        ):
            sess._open_listener(resume=True)
        self.assertEqual(sess._pcm_rx_bytes, 320_000)
        self.assertEqual(sess._pcm_end_id, "sess-live")
        self.assertEqual(sess._pcm_end_capture, "cap-a")
        self.assertEqual(sess._pcm_end_offset, 640_000)

    def test_new_listen_resets_pcm_rx_bytes(self) -> None:
        sess = _session()
        sess._pcm_rx_bytes = 320_000
        sess._pcm_end_id = "sess-old"
        sess._pcm_drain_result = {"type": "pcm_drained", "id": "sess-old"}
        sess._listen_wanted = True
        sess.pipeline._keys["ASSEMBLYAI_API_KEY"] = "k"
        lst = mock.Mock()
        with (
            mock.patch("server.app.CloudListener", return_value=lst),
            mock.patch("server.app._adopt_live_stt", return_value=None),
            mock.patch("server.app._ensure_idle_watch_thread"),
        ):
            sess._open_listener(resume=False)
        self.assertEqual(sess._pcm_rx_bytes, 0)
        self.assertEqual(sess._stt_tx_bytes, 0)
        self.assertIsNone(sess._pcm_end_id)
        self.assertIsNone(sess._pcm_drain_result)

    def test_stop_listen_without_pcm_end_still_stops(self) -> None:
        sess = _session()
        sess._manual = False
        sess._paused = False
        sess._listen_wanted = True
        sess._listener = object()
        sess._stop_listening = mock.Mock()
        sess._offer_save_history = mock.Mock()
        sess.stop_listen()
        sess._stop_listening.assert_called_once()

    def test_audio_ws_pcm_end_wrong_id_ignored(self) -> None:
        from server.app import app

        sess = _session()
        lst = _live(sess, rx=3200)
        events: list[dict] = []
        sess.emit = events.append
        uplink.register(sess)
        client = TestClient(app)
        with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
            ws.send_text(json.dumps({"type": "pcm_end", "id": "sess-old", "byte_offset": 3200, "capture_id": "cap-a"}))
        lst.drain.assert_not_called()
        self.assertEqual(events, [])


def _listener() -> CloudListener:
    return CloudListener(
        api_key="k",
        cfg={"stt": {}},
        on_final=lambda *a: None,
        on_partial=None,
        on_error=None,
    )


class SttSocketDrainTests(unittest.TestCase):
    def test_disconnected_socket_does_not_count_as_sent(self) -> None:
        lst = _listener()
        lst._ws = mock.Mock()
        lst._ws.sock = None
        self.assertFalse(lst._send_stt_frame(b"\x00" * 1600))

    def test_drain_fails_when_stt_socket_disconnected(self) -> None:
        lst = _listener()
        lst._ws = mock.Mock()
        lst._ws.sock = None
        lst._stop.clear()
        lst._pcm_buf.extend(b"\x00" * 1600)
        t = threading.Thread(target=lst._sender, daemon=True)
        t.start()
        ok = lst.drain(timeout=0.4)
        lst._stop.set()
        t.join(0.5)
        self.assertFalse(ok)
        self.assertGreater(len(lst._pcm_buf), 0)

    def test_failed_drain_tail_restores_unsent_frames(self) -> None:
        lst = _listener()
        lst._ws = mock.Mock()
        lst._ws.sock = None
        lst._stop.clear()
        payload = b"\x01" * 1600
        lst._pcm_buf.extend(payload)
        lst._send_drain_tail()
        self.assertTrue(lst._drain_send_failed)
        self.assertFalse(lst._drained.is_set())
        self.assertEqual(bytes(lst._pcm_buf), payload)

    def test_drain_retry_after_disconnect_sends_restored_tail(self) -> None:
        lst = _listener()
        lst._ws = mock.Mock()
        lst._ws.sock = None
        lst._stop.clear()
        payload = b"\x02" * 1600
        lst._pcm_buf.extend(payload)
        t = threading.Thread(target=lst._sender, daemon=True)
        t.start()
        self.assertFalse(lst.drain(timeout=0.4))
        self.assertGreater(len(lst._pcm_buf), 0)
        ws = _connected_ws()
        lst._ws = ws
        ok = lst.drain(timeout=0.4)
        lst._stop.set()
        t.join(0.5)
        self.assertTrue(ok)
        sent = [c.args[0] for c in ws.send.call_args_list if c.args and isinstance(c.args[0], (bytes, bytearray))]
        self.assertTrue(any(frame[: len(payload)] == payload for frame in sent))

    def test_connected_empty_drain_succeeds(self) -> None:
        lst = _listener()
        lst._ws = _connected_ws()
        lst._stop.clear()
        t = threading.Thread(target=lst._sender, daemon=True)
        t.start()
        ok = lst.drain(timeout=0.4)
        lst._stop.set()
        t.join(0.5)
        self.assertTrue(ok)

    def test_take_unsent_returns_queue_then_buf(self) -> None:
        lst = _listener()
        lst._q.put_nowait(b"\x02" * 50)
        lst._pcm_buf.extend(b"\x01" * 100)
        got = lst.take_unsent()
        self.assertEqual(got, b"\x02" * 50 + b"\x01" * 100)
        self.assertEqual(bytes(lst._pcm_buf), b"")

    def test_restart_without_unsent_does_not_emit_pcm_drained(self) -> None:
        sess = _session()
        sess.usage_session_id = "sess-live"
        sess._listen_wanted = True
        sess._pcm_rx_bytes = 1600
        sess._stt_tx_bytes = 0
        sess._pcm_end_id = "sess-live"
        sess._pcm_end_capture = "cap-a"
        sess._pcm_end_offset = 1600
        old = mock.Mock()
        old.take_unsent.return_value = b""
        sess._listener = old
        new = mock.Mock()
        new.drain.return_value = True
        new.start = mock.Mock()
        sess.pipeline._keys["ASSEMBLYAI_API_KEY"] = "k"
        events: list[dict] = []
        sess.emit = events.append
        with (
            mock.patch("server.app.CloudListener", return_value=new),
            mock.patch("server.app._adopt_live_stt", return_value=None),
            mock.patch("server.app._ensure_idle_watch_thread"),
            mock.patch("server.app._drop_live_stt"),
        ):
            sess._restart_listener()
        self.assertEqual([e for e in events if e.get("type") == "pcm_drained"], [])
        self.assertEqual(sess._pcm_end_id, "sess-live")

    def test_restart_listener_sends_handoff_tail_then_confirms(self) -> None:
        sess = _session()
        sess.usage_session_id = "sess-live"
        sess._listen_wanted = True
        sess.pipeline._keys["ASSEMBLYAI_API_KEY"] = "k"
        payload = b"\x07" * 1600
        old = _listener()
        old._pcm_buf.extend(payload)
        old._stop.clear()
        sess._listener = old
        sess._pcm_rx_bytes = 1600
        sess._stt_tx_bytes = 0
        sess._pcm_end_id = "sess-live"
        sess._pcm_end_capture = "cap-a"
        sess._pcm_end_offset = 1600
        events: list[dict] = []
        sess.emit = events.append

        def factory(**kwargs):
            lst = CloudListener(**kwargs)

            def start() -> None:
                lst._stop.clear()
                lst._ws = _connected_ws()
                lst._sender_thread = threading.Thread(target=lst._sender, daemon=True)
                lst._sender_thread.start()

            lst.start = start  # type: ignore[method-assign]
            return lst

        with (
            mock.patch("server.app.CloudListener", side_effect=factory),
            mock.patch("server.app._adopt_live_stt", return_value=None),
            mock.patch("server.app._ensure_idle_watch_thread"),
            mock.patch("server.app._drop_live_stt"),
        ):
            sess._restart_listener()
        new = sess._listener
        self.assertIsNotNone(new)
        deadline = time.time() + 2.0
        while time.time() < deadline and not any(e.get("type") == "pcm_drained" for e in events):
            time.sleep(0.05)
        if getattr(new, "_sender_thread", None):
            new._stop.set()
            new._sender_thread.join(1.0)
        drained = [e for e in events if e.get("type") == "pcm_drained"]
        self.assertEqual(
            drained,
            [{"type": "pcm_drained", "id": "sess-live", "capture_id": "cap-a", "byte_offset": 1600}],
        )
        sent = [
            c.args[0]
            for c in new._ws.send.call_args_list
            if c.args and isinstance(c.args[0], (bytes, bytearray))
        ]
        self.assertTrue(any(frame[: len(payload)] == payload for frame in sent))
        self.assertGreaterEqual(sess._stt_tx_bytes, 1600)
