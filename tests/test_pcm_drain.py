"""Watch End pcm_end / pcm_drained (#165). Old clients omit pcm_end."""

from __future__ import annotations

import json
import threading
import time
import unittest
from unittest import mock

from starlette.testclient import TestClient

from server import uplink
from server.app import CFG, CloudListener, Session, UnsentHandoff, _reset_live_stt, STT_PCM_HOLD_MAX
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

    def test_take_unsent_returns_buf_then_queue(self) -> None:
        lst = _listener()
        lst._q.put_nowait(b"\x02" * 50)
        lst._pcm_buf.extend(b"\x01" * 100)
        got = lst.take_unsent()
        self.assertEqual(got.kind, "ready")
        self.assertEqual(got.pcm, b"\x01" * 100 + b"\x02" * 50)
        self.assertEqual(bytes(lst._pcm_buf), b"")

    def test_take_unsent_keeps_failure_when_sender_blocked(self) -> None:
        lst = _listener()
        started = threading.Event()

        def blocking_send(*_a, **_k):
            started.set()
            time.sleep(3.5)
            raise RuntimeError("still sending")

        ws = _connected_ws()
        ws.send.side_effect = blocking_send
        lst._ws = ws
        lst._stop.clear()
        payload = b"\x03" * 1600
        lst._pcm_buf.extend(payload)
        t = threading.Thread(target=lst._sender, daemon=True)
        lst._sender_thread = t
        t.start()
        lst._drain.set()
        self.assertTrue(started.wait(1.0))
        got = lst.take_unsent(timeout=2.0)
        self.assertEqual(got.kind, "blocked")
        self.assertTrue(t.is_alive())
        lst._stop.set()
        t.join(5.0)

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
        payload_early = b"\x07" * 1600
        payload_late = b"\x08" * 1600
        old = _listener()
        old._pcm_buf.extend(payload_early)
        old._q.put_nowait(payload_late)
        old._stop.clear()
        sess._listener = old
        sess._pcm_rx_bytes = 3200
        sess._stt_tx_bytes = 0
        sess._pcm_end_id = "sess-live"
        sess._pcm_end_capture = "cap-a"
        sess._pcm_end_offset = 3200
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
            [{"type": "pcm_drained", "id": "sess-live", "capture_id": "cap-a", "byte_offset": 3200}],
        )
        sent = [
            c.args[0]
            for c in new._ws.send.call_args_list
            if c.args and isinstance(c.args[0], (bytes, bytearray))
        ]
        joined = b"".join(sent)
        self.assertEqual(joined[:1600], payload_early)
        self.assertEqual(joined[1600:3200], payload_late)
        self.assertGreaterEqual(sess._stt_tx_bytes, 3200)


def _binary_sent(ws) -> list[bytes]:
    return [
        c.args[0]
        for c in ws.send.call_args_list
        if c.args and isinstance(c.args[0], (bytes, bytearray))
    ]


def _start_sender(lst: CloudListener, ws=None) -> mock.Mock:
    sock = ws or _connected_ws()
    lst._ws = sock
    lst._stop.clear()
    lst._was_ready = True
    lst._ready.set()
    t = threading.Thread(target=lst._sender, daemon=True)
    lst._sender_thread = t
    t.start()
    return sock


def _fake_listener_factory(sess: Session, *, on_start=None, fail_first: list | None = None):
    created: list[CloudListener] = []

    def factory(**kwargs):
        if fail_first:
            fail_first.pop()
            lst = CloudListener(**kwargs)
            lst.start = mock.Mock(side_effect=RuntimeError("handshake failed"))  # type: ignore[method-assign]
            created.append(lst)
            return lst
        lst = CloudListener(**kwargs)

        def start() -> None:
            if on_start:
                on_start(lst)
            _start_sender(lst)

        lst.start = start  # type: ignore[method-assign]
        created.append(lst)
        return lst

    return factory, created


class HandoffLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def tearDown(self) -> None:
        uplink.reset()
        _reset_live_stt()
        if getattr(self, "_new", None) and getattr(self._new, "_sender_thread", None):
            self._new._stop.set()
            self._new._sender_thread.join(1.0)

    def _live_session(self) -> Session:
        sess = _session()
        sess.usage_session_id = "sess-live"
        sess._listen_wanted = True
        sess._listen_started_at = time.time()
        sess.pipeline._keys["ASSEMBLYAI_API_KEY"] = "k"
        return sess

    def test_pause_terminate_then_final_then_close(self) -> None:
        finals: list[str] = []
        sess = self._live_session()
        lst = CloudListener(
            api_key="k",
            cfg={"stt": {}},
            on_final=lambda text, *a: finals.append(text),
            on_partial=None,
            on_error=None,
        )
        order: list[str] = []
        ws = _connected_ws()

        def send(payload, *a, **k):
            order.append("send")
            if isinstance(payload, str) and "Terminate" in payload:
                lst._on_message(None, json.dumps({
                    "type": "Turn",
                    "end_of_turn": True,
                    "turn_is_formatted": True,
                    "transcript": "last words",
                }))
                lst._on_message(None, json.dumps({"type": "Termination"}))

        def close():
            order.append("close")

        def sock_close():
            order.append("sock.close")

        ws.send.side_effect = send
        ws.close.side_effect = close
        ws.sock.close.side_effect = sock_close
        _start_sender(lst, ws)
        sess._listener = lst
        sess.pause_listen()
        self.assertIn("last words", finals)
        self.assertTrue(sess._paused)
        self.assertTrue(sess._listen_wanted)
        self.assertIsNone(sess._listener)
        self.assertNotIn("sock.close", order[:1])
        self.assertIn("send", order)
        self.assertLess(order.index("send"), order.index("close"))
        if "sock.close" in order:
            self.assertLess(order.index("send"), order.index("sock.close"))

    def test_restart_sends_abc_once_in_order(self) -> None:
        sess = self._live_session()
        payload_a = b"\x0a" * 1600
        payload_b = b"\x0b" * 1600
        payload_c = b"\x0c" * 1600
        old = _listener()
        old._pcm_buf.extend(payload_a)
        old._q.put_nowait(payload_b)
        sess._listener = old
        sess._pcm_rx_bytes = 3200
        sess._stt_tx_bytes = 0
        sess._pcm_end_id = "sess-live"
        sess._pcm_end_capture = "cap-a"
        sess._pcm_end_offset = 4800
        events: list[dict] = []
        sess.emit = events.append
        in_start = threading.Event()

        def on_start(lst: CloudListener) -> None:
            in_start.set()
            sess._hold_incoming_pcm(payload_c)

        factory, created = _fake_listener_factory(sess, on_start=on_start)
        with (
            mock.patch("server.app.CloudListener", side_effect=factory),
            mock.patch("server.app._adopt_live_stt", return_value=None),
            mock.patch("server.app._ensure_idle_watch_thread"),
            mock.patch("server.app._drop_live_stt"),
        ):
            sess._restart_listener()
        self.assertTrue(in_start.is_set())
        new = sess._listener
        self.assertIsNotNone(new)
        self._new = new
        deadline = time.time() + 3.0
        while time.time() < deadline and not any(e.get("type") == "pcm_drained" for e in events):
            time.sleep(0.05)
        if getattr(new, "_sender_thread", None):
            new._stop.set()
            new._sender_thread.join(1.0)
        drained = [e for e in events if e.get("type") == "pcm_drained"]
        self.assertEqual(
            drained,
            [{"type": "pcm_drained", "id": "sess-live", "capture_id": "cap-a", "byte_offset": 4800}],
        )
        joined = b"".join(_binary_sent(new._ws))
        self.assertEqual(joined[:1600], payload_a)
        self.assertEqual(joined[1600:3200], payload_b)
        self.assertEqual(joined[3200:4800], payload_c)
        self.assertEqual(joined.count(payload_a), 1)
        self.assertEqual(joined.count(payload_b), 1)
        self.assertEqual(joined.count(payload_c), 1)

    def test_handshake_fail_keeps_pending_then_retry_sends_once(self) -> None:
        sess = self._live_session()
        payload = b"\x11" * 1600
        old = _listener()
        old._pcm_buf.extend(payload)
        sess._listener = old
        sess._pcm_rx_bytes = 1600
        sess._stt_tx_bytes = 0
        sess._pcm_end_id = "sess-live"
        sess._pcm_end_capture = "cap-a"
        sess._pcm_end_offset = 1600
        events: list[dict] = []
        sess.emit = events.append
        fail_first = [True]
        created: list[CloudListener] = []

        def factory(**kwargs):
            lst = CloudListener(**kwargs)
            created.append(lst)
            if fail_first:
                fail_first.pop()

                def boom() -> None:
                    raise RuntimeError("handshake failed")

                lst.start = boom  # type: ignore[method-assign]
                return lst

            def start() -> None:
                _start_sender(lst)

            lst.start = start  # type: ignore[method-assign]
            return lst

        with (
            mock.patch("server.app.CloudListener", side_effect=factory),
            mock.patch("server.app._adopt_live_stt", return_value=None),
            mock.patch("server.app._ensure_idle_watch_thread"),
            mock.patch("server.app._drop_live_stt"),
        ):
            sess._restart_listener()
            sess._cancel_stt_restart_timer()
            self.assertEqual(bytes(sess._stt_pending_pcm), payload)
            self.assertIsNone(sess._listener)
            sess._restart_if_listening()
        new = sess._listener
        self.assertIsNotNone(new)
        self._new = new
        deadline = time.time() + 3.0
        while time.time() < deadline and not any(e.get("type") == "pcm_drained" for e in events):
            time.sleep(0.05)
        if getattr(new, "_sender_thread", None):
            new._stop.set()
            new._sender_thread.join(1.0)
        joined = b"".join(_binary_sent(new._ws))
        self.assertEqual(joined[:1600], payload)
        self.assertEqual(joined.count(payload), 1)
        self.assertEqual(
            [e for e in events if e.get("type") == "pcm_drained"],
            [{"type": "pcm_drained", "id": "sess-live", "capture_id": "cap-a", "byte_offset": 1600}],
        )

    def test_blocked_handoff_does_not_publish_or_drain(self) -> None:
        sess = self._live_session()
        started = threading.Event()
        block = threading.Event()
        lst = _listener()

        def blocking_send(payload, *a, **k):
            if isinstance(payload, (bytes, bytearray)):
                started.set()
                block.wait(10)
                raise RuntimeError("send failed")

        ws = _connected_ws()
        ws.send.side_effect = blocking_send
        lst._ws = ws
        lst._pcm_buf.extend(b"\x22" * 1600)
        t = threading.Thread(target=lst._sender, daemon=True)
        lst._sender_thread = t
        lst._stop.clear()
        t.start()
        lst._drain.set()
        self.assertTrue(started.wait(1.0))
        sess._listener = lst
        sess._pcm_rx_bytes = 1600
        sess._stt_tx_bytes = 0
        sess._pcm_end_id = "sess-live"
        sess._pcm_end_capture = "cap-a"
        sess._pcm_end_offset = 1600
        events: list[dict] = []
        sess.emit = events.append
        with (
            mock.patch("server.app.CloudListener") as factory,
            mock.patch("server.app._adopt_live_stt", return_value=None),
            mock.patch("server.app._ensure_idle_watch_thread"),
            mock.patch("server.app._drop_live_stt"),
        ):
            sess._restart_listener()
            factory.assert_not_called()
        self.assertTrue(sess._handoff_blocked)
        self.assertIs(sess._handoff_listener, lst)
        self.assertIsNone(sess._listener)
        self.assertEqual([e for e in events if e.get("type") == "pcm_drained"], [])
        self.addCleanup(lambda: (block.set(), t.join(5.0)))

    def test_blocked_then_send_fail_recovers_once(self) -> None:
        sess = self._live_session()
        started = threading.Event()
        block = threading.Event()
        payload = b"\x33" * 1600
        lst = _listener()

        def blocking_send(payload_sent, *a, **k):
            if isinstance(payload_sent, (bytes, bytearray)):
                started.set()
                block.wait(10)
                raise RuntimeError("send failed")

        ws = _connected_ws()
        ws.send.side_effect = blocking_send
        lst._ws = ws
        lst._pcm_buf.extend(payload)
        t = threading.Thread(target=lst._sender, daemon=True)
        lst._sender_thread = t
        lst._stop.clear()
        t.start()
        lst._drain.set()
        self.assertTrue(started.wait(1.0))
        sess._listener = lst
        sess._pcm_rx_bytes = 1600
        sess._stt_tx_bytes = 0
        sess._pcm_end_id = "sess-live"
        sess._pcm_end_capture = "cap-a"
        sess._pcm_end_offset = 1600
        events: list[dict] = []
        sess.emit = events.append
        factory, created = _fake_listener_factory(sess)
        with (
            mock.patch("server.app.CloudListener", side_effect=factory),
            mock.patch("server.app._adopt_live_stt", return_value=None),
            mock.patch("server.app._ensure_idle_watch_thread"),
            mock.patch("server.app._drop_live_stt"),
        ):
            sess._restart_listener()
            self.assertTrue(sess._handoff_blocked)
            block.set()
            deadline = time.time() + 3.0
            while time.time() < deadline and sess._listener is None:
                time.sleep(0.05)
            new = sess._listener
            self.assertIsNotNone(new)
            self._new = new
            while time.time() < deadline and not any(e.get("type") == "pcm_drained" for e in events):
                time.sleep(0.05)
            sess.pcm_end("sess-live", 1600, "cap-a")
        if getattr(new, "_sender_thread", None):
            new._stop.set()
            new._sender_thread.join(1.0)
        joined = b"".join(_binary_sent(new._ws))
        self.assertEqual(joined[:1600], payload)
        self.assertEqual(joined.count(payload), 1)
        drained = [e for e in events if e.get("type") == "pcm_drained"]
        self.assertEqual(len(drained), 2)
        self.assertEqual(drained[0]["byte_offset"], 1600)

    def test_blocked_unblocks_while_paused_does_not_reopen_stt(self) -> None:
        sess = self._live_session()
        started = threading.Event()
        block = threading.Event()
        payload = b"\x44" * 1600
        lst = _listener()

        def blocking_send(payload_sent, *a, **k):
            if isinstance(payload_sent, (bytes, bytearray)):
                started.set()
                block.wait(10)
                raise RuntimeError("send failed")

        ws = _connected_ws()
        ws.send.side_effect = blocking_send
        lst._ws = ws
        lst._pcm_buf.extend(payload)
        t = threading.Thread(target=lst._sender, daemon=True)
        lst._sender_thread = t
        lst._stop.clear()
        t.start()
        lst._drain.set()
        self.assertTrue(started.wait(1.0))
        sess._listener = lst
        factory, _created = _fake_listener_factory(sess)
        with (
            mock.patch("server.app.CloudListener", side_effect=factory),
            mock.patch("server.app._adopt_live_stt", return_value=None),
            mock.patch("server.app._ensure_idle_watch_thread"),
            mock.patch("server.app._drop_live_stt"),
        ):
            sess.pause_listen()
            self.assertTrue(sess._paused)
            self.assertTrue(sess._handoff_blocked)
            block.set()
            deadline = time.time() + 3.0
            while time.time() < deadline and sess._handoff_blocked:
                time.sleep(0.05)
        self.assertTrue(sess._paused)
        self.assertTrue(sess._listen_wanted)
        self.assertIsNone(sess._listener)
        self.assertEqual(bytes(sess._stt_pending_pcm), payload)
        self.assertFalse(sess._handoff_blocked)

    def test_prefix_not_replayed_after_tail_rebuild(self) -> None:
        sess = self._live_session()
        prefix = b"\x55" * 1600
        tail = b"\x66" * 1600
        old = _listener()
        old._pcm_buf.extend(tail)
        sess._listener = old
        sess._pcm_rx_bytes = 3200
        sess._stt_tx_bytes = 1600
        sess._pcm_end_id = "sess-live"
        sess._pcm_end_capture = "cap-a"
        sess._pcm_end_offset = 3200
        events: list[dict] = []
        sess.emit = events.append
        factory, _created = _fake_listener_factory(sess)
        with (
            mock.patch("server.app.CloudListener", side_effect=factory),
            mock.patch("server.app._adopt_live_stt", return_value=None),
            mock.patch("server.app._ensure_idle_watch_thread"),
            mock.patch("server.app._drop_live_stt"),
        ):
            sess._restart_listener()
        new = sess._listener
        self.assertIsNotNone(new)
        self._new = new
        deadline = time.time() + 3.0
        while time.time() < deadline and not any(e.get("type") == "pcm_drained" for e in events):
            time.sleep(0.05)
        if getattr(new, "_sender_thread", None):
            new._stop.set()
            new._sender_thread.join(1.0)
        joined = b"".join(_binary_sent(new._ws))
        self.assertNotIn(prefix, joined)
        self.assertEqual(joined[:1600], tail)
        self.assertEqual(joined.count(tail), 1)
        self.assertGreaterEqual(sess._stt_tx_bytes, 3200)

    def test_lost_pcm_drained_retry_does_not_resend_audio(self) -> None:
        sess = self._live_session()
        payload = b"\x77" * 1600
        old = _listener()
        old._pcm_buf.extend(payload)
        sess._listener = old
        sess._pcm_rx_bytes = 1600
        sess._stt_tx_bytes = 0
        sess._pcm_end_id = "sess-live"
        sess._pcm_end_capture = "cap-a"
        sess._pcm_end_offset = 1600
        events: list[dict] = []
        sess.emit = events.append
        factory, _created = _fake_listener_factory(sess)
        with (
            mock.patch("server.app.CloudListener", side_effect=factory),
            mock.patch("server.app._adopt_live_stt", return_value=None),
            mock.patch("server.app._ensure_idle_watch_thread"),
            mock.patch("server.app._drop_live_stt"),
        ):
            sess._restart_listener()
        new = sess._listener
        self.assertIsNotNone(new)
        self._new = new
        deadline = time.time() + 3.0
        while time.time() < deadline and not any(e.get("type") == "pcm_drained" for e in events):
            time.sleep(0.05)
        before = list(_binary_sent(new._ws))
        events.clear()
        sess.pcm_end("sess-live", 1600, "cap-a")
        after = _binary_sent(new._ws)
        self.assertEqual(after, before)
        self.assertEqual(
            events,
            [{"type": "pcm_drained", "id": "sess-live", "capture_id": "cap-a", "byte_offset": 1600}],
        )
        if getattr(new, "_sender_thread", None):
            new._stop.set()
            new._sender_thread.join(1.0)

    def test_end_during_blocked_handoff_does_not_succeed(self) -> None:
        sess = self._live_session()
        started = threading.Event()
        block = threading.Event()
        lst = _listener()

        def blocking_send(payload, *a, **k):
            if isinstance(payload, (bytes, bytearray)):
                started.set()
                block.wait(10)
                raise RuntimeError("send failed")

        ws = _connected_ws()
        ws.send.side_effect = blocking_send
        lst._ws = ws
        lst._pcm_buf.extend(b"\x88" * 1600)
        t = threading.Thread(target=lst._sender, daemon=True)
        lst._sender_thread = t
        lst._stop.clear()
        t.start()
        lst._drain.set()
        self.assertTrue(started.wait(1.0))
        sess._listener = lst
        sess._pcm_rx_bytes = 1600
        sess._stt_tx_bytes = 0
        events: list[dict] = []
        sess.emit = events.append
        with mock.patch("server.app.CloudListener") as factory:
            sess._restart_listener()
            sess.pcm_end("sess-live", 1600, "cap-a")
            factory.assert_not_called()
        self.assertEqual([e for e in events if e.get("type") == "pcm_drained"], [])
        self.assertEqual(sess._pcm_end_id, "sess-live")
        self.addCleanup(lambda: (block.set(), t.join(5.0)))



class HandoffConcurrencyTests(unittest.TestCase):
    """Fable #165 review: the four handoff/retry races and failure branches.

    These drive the REAL Session entry points (push_pcm, pause_listen,
    _try_complete_handoff, _complete_blocked_handoff) rather than calling the
    stash helper directly, so the routing and completion coordination are
    exercised end-to-end.
    """

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

    def test_push_pcm_reroutes_frame_when_listener_appears_mid_hold(self) -> None:
        """Issue 1: routing and enqueue must be coordinated with the handoff switch.

        Reproduce the real TOCTOU through the REAL push_pcm entry: the frame
        arrives while there is no live listener, then a handoff installs one
        exactly when the hold is attempted. The frame must be re-routed to the new
        listener, never silently dropped.
        """
        sess = self._live_session()
        sess._listener = None
        sess._handoff_listener = None
        new = mock.Mock()

        def appear_then_refuse(pcm):
            # The new listener is installed at this exact instant; the hold now
            # refuses because a listener is present (the old code path).
            sess._listener = new
            return False

        with mock.patch.object(sess, "_hold_incoming_pcm", side_effect=appear_then_refuse):
            sess.push_pcm(b"\x5e" * 1600)
        # The frame must NOT have been dropped into the void — it reaches `new`.
        calls = [c.args[0] for c in new.push_pcm.call_args_list
                 if c.args and isinstance(c.args[0], (bytes, bytearray))]
        self.assertTrue(
            any(b"\x5e" * 1600 in (frame or b"") for frame in calls),
            f"frame dropped on handoff switch; saw {len(calls)} push calls",
        )

    def test_concurrent_completion_paths_start_one_listener(self) -> None:
        """Issue 2: auto-recovery and Retry must not both complete one handoff."""
        sess = self._live_session()
        lst = mock.Mock()
        lst.take_unsent.return_value = b"\x99" * 1600
        sess._listener = None
        sess._handoff_listener = lst
        sess._handoff_collected = False
        sess._start_listening = mock.Mock()
        real_stash = sess._stash_unsent

        def slow_stash(l):
            time.sleep(0.05)  # widen the race window so both paths see collected=False
            return real_stash(l)

        sess._stash_unsent = slow_stash
        workers = [
            threading.Thread(target=sess._try_complete_handoff),
            threading.Thread(target=lambda: sess._complete_blocked_handoff(lst)),
        ]
        for t in workers:
            t.start()
        for t in workers:
            t.join(4)

        sess._start_listening.assert_called_once()
        # Exactly one collection: the unsent tail is not replayed twice.
        self.assertEqual(bytes(sess._stt_pending_pcm), b"\x99" * 1600)
        self.assertIsNone(sess._handoff_listener)

    def test_hold_overflow_is_reported_not_silently_dropped(self) -> None:
        """Issue 3: a full 2 MiB hold must surface a failure, not log+drop."""
        sess = self._live_session()
        sess._listener = None
        sess._handoff_listener = None
        sess._pcm_hold = bytearray(STT_PCM_HOLD_MAX)  # capacity exhausted
        events: list[dict] = []
        sess.emit = events.append
        sess.push_pcm(b"\xaa" * 1600)
        # No live listener + full hold: the frame cannot be kept. The client must
        # be told, not left with a silent gap in the transcript.
        self.assertTrue(
            any(e.get("type") in ("error", "status") for e in events),
            f"no explicit failure surfaced; events={events!r}",
        )

    def test_pause_after_blocked_does_not_reopen_stt(self) -> None:
        """Issue 4: Pause pressed while the handoff is already blocked must be honored.

        First reconnect/Retry drives the listener into a blocked handoff, then the
        user presses Pause. After the block clears, STT must NOT auto-reopen.
        """
        sess = self._live_session()
        started = threading.Event()
        block = threading.Event()
        payload = b"\x4e" * 1600
        lst = _listener()

        def blocking_send(payload_sent, *a, **k):
            if isinstance(payload_sent, (bytes, bytearray)):
                started.set()
                block.wait(10)
                raise RuntimeError("send failed")

        ws = _connected_ws()
        ws.send.side_effect = blocking_send
        lst._ws = ws
        lst._pcm_buf.extend(payload)
        t = threading.Thread(target=lst._sender, daemon=True)
        lst._sender_thread = t
        lst._stop.clear()
        t.start()
        lst._drain.set()
        self.assertTrue(started.wait(1.0))
        sess._listener = lst
        events: list[dict] = []
        sess.emit = events.append
        factory, _created = _fake_listener_factory(sess)
        with (
            mock.patch("server.app.CloudListener", side_effect=factory),
            mock.patch("server.app._adopt_live_stt", return_value=None),
            mock.patch("server.app._ensure_idle_watch_thread"),
            mock.patch("server.app._drop_live_stt"),
        ):
            # Establish the blocked handoff FIRST (a reconnect/Retry is in flight),
            # THEN the user presses Pause while listener is None.
            sess._restart_listener()
            self.assertTrue(sess._handoff_blocked)
            self.assertIsNone(sess._listener)
            sess.pause_listen()
            self.assertTrue(sess._paused)
            # Unblock the sender; the waiter must NOT auto-reopen STT (Pause honored).
            block.set()
            deadline = time.time() + 3.0
            while time.time() < deadline and sess._handoff_blocked:
                time.sleep(0.05)
        self.assertTrue(sess._paused)
        self.assertTrue(sess._listen_wanted)
        self.assertIsNone(sess._listener)
        self.assertFalse(sess._handoff_blocked)
        self.assertEqual(bytes(sess._stt_pending_pcm), payload)
        self.addCleanup(lambda: (block.set(), t.join(5.0)))



    def test_park_overflow_is_retained_and_reattached_not_false_success(self) -> None:
        """Fable follow-up P1: the overflow failure must survive a parked control emit.

        Lock screen / control-connection park replaces self.emit with a sink, so a
        fire-and-forget emit would erase the notice AND the dropped frame. The stall
        must be retained, pushed over the native audio path, re-emitted on reattach,
        and must never let the session claim complete success.
        """
        sess = self._live_session()
        sess._listener = None
        sess._handoff_listener = None
        sess._pcm_hold = bytearray(STT_PCM_HOLD_MAX)  # capacity exhausted
        # Park the control emit (phone lock screen): the control sink is dropped,
        # but the session keeps routing — a parked session still owns the
        # audio-reachable Watch copy path (#219 P1).
        sess._detach_control_emit()
        self.assertIsNone(sess._client_emit)
        self.assertIs(sess.emit.__func__, Session._routed_emit)
        self.assertIs(sess.pipeline.emit.__func__, Session._routed_emit)
        native = mock.Mock()
        sess._send_audio_text = native
        # The overflow frame cannot be held; only the native path can reach the device.
        sess.push_pcm(b"\xab" * 1600)
        # 1) The failure is RETAINED as session state (queryable after park) ...
        self.assertTrue(sess._pcm_stall_reported)
        # ... and is pushed over the native-reachable channel as a session-identity
        # pcm_stall frame (not a dropped generic error), so the device can route it.
        native.assert_called_once()
        sent = native.call_args[0][0]
        self.assertEqual(sent["type"], "pcm_stall")
        self.assertEqual(sent["id"], "sess-live")
        self.assertIn("incomplete", sent["text"])
        # 2) The already-buffered original audio is NOT clobbered by the overflow.
        self.assertEqual(len(sess._pcm_hold), STT_PCM_HOLD_MAX)
        # 3) Reconnect: re-emit the retained failure so the user (re)sees it.
        events: list[dict] = []
        sess.emit = events.append
        sess.reattach()
        self.assertTrue(
            any(e.get("type") == "error" for e in events),
            f"retained stall not re-emitted on reattach; events={events!r}",
        )
        # 4) A dropped window must NOT be reported as a complete/drained success.
        sess._listener = mock.Mock()
        sess._listener.drain.return_value = True
        sess._stt_pending_pcm = b""
        sess._pcm_hold = bytearray()
        sess._pcm_rx_bytes = 1600
        sess._stt_tx_bytes = 1600
        sess._pcm_end_id = "sess-live"
        sess._pcm_end_capture = "cap-a"
        sess._pcm_end_offset = 1600
        before = len(events)
        sess._finish_pcm_end_if_ready()
        self.assertEqual(
            [e for e in events[before:] if e.get("type") == "pcm_drained"],
            [],
            "session claimed complete success after an overflow drop",
        )


    def test_overflow_stall_survives_recovery_frames_and_reattach(self) -> None:
        """Fable follow-up #1: a later successful frame must NOT clear the incomplete
        state. Overflow -> recovery -> a real frame arrives -> reattach/End: the
        failure stays visible and no pcm_drained is fabricated."""
        sess = self._live_session()
        sess._listener = None
        sess._handoff_listener = None
        sess._pcm_hold = bytearray(STT_PCM_HOLD_MAX)
        native = mock.Mock()
        sess._send_audio_text = native
        # Overflow marks the session incomplete.
        sess.push_pcm(b"\xac" * 1600)
        self.assertTrue(sess._pcm_stall_reported)
        native.reset_mock()
        # Recovery: a new listener is installed and the hold is flushed to it,
        # then a real frame arrives through the normal path.
        lst = mock.Mock()
        lst.drain.return_value = True
        lst.take_unsent.return_value = b""
        sess._listener = lst
        sess._pcm_hold = bytearray()
        sess._pcm_rx_bytes = 1600
        sess._stt_tx_bytes = 3200
        sess.push_pcm(b"\xad" * 1600)
        # The incomplete state must persist after the recovery frame.
        self.assertTrue(
            sess._pcm_stall_reported,
            "a successful frame after recovery cleared the incomplete state",
        )
        # Reattach still re-announces the failure.
        events: list[dict] = []
        sess.emit = events.append
        sess.reattach()
        self.assertTrue(
            any(e.get("type") == "error" for e in events),
            f"stall not re-emitted on reattach after recovery; events={events!r}",
        )
        # End must not fabricate a drain over a dropped window (the stall guard,
        # not just the rx undercount, blocks it).
        sess._pcm_end_id = "sess-live"
        sess._pcm_end_capture = "cap-a"
        sess._pcm_end_offset = 3200
        before = len(events)
        sess._finish_pcm_end_if_ready()
        self.assertEqual(
            [e for e in events[before:] if e.get("type") == "pcm_drained"],
            [],
            "End fabricated pcm_drained after an overflow drop",
        )
