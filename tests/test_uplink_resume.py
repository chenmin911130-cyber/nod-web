""" /ws/audio rx_ack and uplink_resume (ticket J)."""

from __future__ import annotations

import json
import threading
import time
import unittest

from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect, WebSocketState

from server import ratelimit, uplink
from server.app import app
from tests.test_uplink import _session
from tests.test_uplink_config import recording_send_text, uplink_env


def _json_text(raw: str) -> dict:
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise AssertionError(raw)
    return obj


def _seen_rx(sess) -> int:
    total = getattr(sess, "_uplink_rx_total", None)
    if total is not None:
        return int(total or 0)
    return int(getattr(sess, "_uplink_prev_conn_rx", 0) or 0)


def _wait_rx(sess, n: int) -> int:
    seen = 0
    for _ in range(50):
        seen = _seen_rx(sess)
        if seen == n:
            break
        time.sleep(0.02)
    return seen


def _recv_text(ws, timeout: float) -> dict | None:
    done = threading.Event()
    box: dict = {}

    def run() -> None:
        try:
            box["msg"] = _json_text(ws.receive_text())
        except Exception as exc:  # pragma: no cover - surfaced to the caller
            box["err"] = exc
        finally:
            done.set()

    threading.Thread(target=run, daemon=True).start()
    if not done.wait(timeout):
        return None
    if "err" in box:
        raise box["err"]
    return box["msg"]


def _wait_ack(ws, rx: int, timeout: float = 4.0) -> dict | None:
    ack = None
    deadline = time.time() + timeout
    while time.time() < deadline:
        msg = _recv_text(ws, max(0.1, deadline - time.time()))
        if msg is None:
            break
        if msg.get("type") == "rx_ack":
            ack = msg
            if msg.get("rx") == rx:
                break
    return ack


class UplinkResumeTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()
        ratelimit._hits.clear()

    def tearDown(self) -> None:
        uplink.reset()
        ratelimit._hits.clear()

    def test_rx_ack_increases_to_total_bytes(self) -> None:
        sess = _session()
        pushed: list[bytes] = []
        sess.push_pcm = pushed.append  # type: ignore[method-assign]
        uplink.register(sess)
        client = TestClient(app)
        frame = b"\x00" * 3200
        with uplink_env():
            with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                first = _json_text(ws.receive_text())
                self.assertEqual(first["type"], "uplink_resume")
                self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_config")
                for _ in range(5):
                    ws.send_bytes(frame)
                acks: list[dict] = []
                deadline = time.time() + 3.5
                while time.time() < deadline and (not acks or acks[-1]["rx"] < 16000):
                    msg = _json_text(ws.receive_text())
                    if msg.get("type") == "rx_ack":
                        acks.append(msg)
                        if msg["rx"] >= 16000:
                            break
        rxs = [a["rx"] for a in acks]
        self.assertGreaterEqual(len(rxs), 1)
        self.assertEqual(rxs, sorted(rxs))
        self.assertEqual(len(rxs), len(set(rxs)))
        self.assertEqual(rxs[-1], 16000)

    def test_reconnect_resume_before_config(self) -> None:
        sess = _session()
        sess.push_pcm = lambda pcm: None  # type: ignore[method-assign]
        uplink.register(sess)
        client = TestClient(app)
        frame = b"\x01" * 3200
        with uplink_env():
            with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_resume")
                self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_config")
                for _ in range(5):
                    ws.send_bytes(frame)
                seen = 0
                for _ in range(50):
                    seen = int(getattr(sess, "_uplink_rx_total", 0) or 0)
                    if seen == 16000:
                        break
                    time.sleep(0.02)
                self.assertEqual(seen, 16000)
            self.assertEqual(int(getattr(sess, "_uplink_rx_total", 0) or 0), 16000)
            with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                first = _json_text(ws.receive_text())
                self.assertEqual(int(getattr(sess, "_uplink_rx_total", 0) or 0), 16000)
                second = _json_text(ws.receive_text())
        self.assertEqual(first, {"type": "uplink_resume", "prev_rx": 16000})
        self.assertEqual(second["type"], "uplink_config")

    def test_first_connection_prev_rx_zero(self) -> None:
        sess = _session()
        uplink.register(sess)
        client = TestClient(app)
        with uplink_env():
            with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                first = _json_text(ws.receive_text())
                self.assertEqual(first, {"type": "uplink_resume", "prev_rx": 0})
                second = _json_text(ws.receive_text())
        self.assertEqual(second["type"], "uplink_config")

    def test_rate_limited_frames_still_count(self) -> None:
        sess = _session()
        pushed: list[bytes] = []
        sess.push_pcm = pushed.append  # type: ignore[method-assign]
        uplink.register(sess)
        client = TestClient(app)
        frame = b"\x02" * 100
        n = ratelimit.WS_FRAMES_PER_SEC + 5
        with uplink_env():
            with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_resume")
                self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_config")
                for _ in range(n):
                    ws.send_bytes(frame)
                total = n * len(frame)
                ack = None
                deadline = time.time() + 3.5
                while time.time() < deadline:
                    msg = _json_text(ws.receive_text())
                    if msg.get("type") == "rx_ack" and msg.get("rx") == total:
                        ack = msg
                        break
        self.assertEqual(ack, {"type": "rx_ack", "rx": total})
        limited = int(getattr(sess, "_uplink_limited_bytes", 0) or 0)
        self.assertGreater(limited, 0)
        self.assertEqual(sum(len(p) for p in pushed) + limited, total)

    def test_live_second_socket_4409_does_not_clear_or_resume(self) -> None:
        sess = _session()
        sess.push_pcm = lambda pcm: None  # type: ignore[method-assign]
        uplink.register(sess)
        client = TestClient(app)
        with uplink_env():
            with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_resume")
                self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_config")
                ws.send_bytes(b"\x03" * 1000)
                for _ in range(50):
                    if int(getattr(sess, "_uplink_rx_total", 0) or 0) == 1000:
                        break
                    time.sleep(0.02)
                self.assertEqual(int(getattr(sess, "_uplink_rx_total", 0) or 0), 1000)
                with recording_send_text() as calls:
                    with self.assertRaises(WebSocketDisconnect) as ctx:
                        with client.websocket_connect(f"/ws/audio?token={sess.audio_token}"):
                            pass
                self.assertEqual(ctx.exception.code, 4409)
                resumes = [c for c in calls if _json_text(c).get("type") == "uplink_resume"]
                self.assertEqual(resumes, [])
                self.assertEqual(int(getattr(sess, "_uplink_rx_total", 0) or 0), 1000)

    def test_forged_token_4404_sends_nothing(self) -> None:
        client = TestClient(app)
        with uplink_env():
            with recording_send_text() as calls:
                with self.assertRaises(WebSocketDisconnect) as ctx:
                    with client.websocket_connect("/ws/audio?token=not-a-real-token"):
                        pass
        self.assertEqual(ctx.exception.code, 4404)
        self.assertEqual(calls, [])

    def test_flap_keeps_prev_rx_when_middle_sends_nothing(self) -> None:
        sess = _session()
        sess.push_pcm = lambda pcm: None  # type: ignore[method-assign]
        uplink.register(sess)
        client = TestClient(app)
        frame = b"\x07" * 3200
        with uplink_env():
            with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_resume")
                self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_config")
                for _ in range(3):
                    ws.send_bytes(frame)
                self.assertEqual(_wait_rx(sess, 9600), 9600)
            with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                first = _json_text(ws.receive_text())
                self.assertEqual(first, {"type": "uplink_resume", "prev_rx": 9600})
            with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                third = _json_text(ws.receive_text())
        self.assertEqual(third, {"type": "uplink_resume", "prev_rx": 9600})

    def test_later_connection_ack_and_resume_are_cumulative(self) -> None:
        sess = _session()
        sess.push_pcm = lambda pcm: None  # type: ignore[method-assign]
        uplink.register(sess)
        client = TestClient(app)
        frame = b"\x08" * 3200
        with uplink_env():
            with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_resume")
                self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_config")
                for _ in range(3):
                    ws.send_bytes(frame)
                self.assertEqual(_wait_rx(sess, 9600), 9600)
            with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                second = _json_text(ws.receive_text())
                self.assertEqual(second, {"type": "uplink_resume", "prev_rx": 9600})
                ws.send_bytes(frame)
                ack = _wait_ack(ws, 12800)
            with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                third = _json_text(ws.receive_text())
        self.assertEqual(ack, {"type": "rx_ack", "rx": 12800})
        self.assertEqual(third, {"type": "uplink_resume", "prev_rx": 12800})

    def test_resume_includes_frame_blocked_in_push(self) -> None:
        sess = _session()
        gate = threading.Event()
        entered = threading.Event()

        def push(pcm: bytes) -> None:
            entered.set()
            gate.wait(5)

        sess.push_pcm = push  # type: ignore[method-assign]
        uplink.register(sess)
        frame = b"\x09" * 3200
        box: dict = {}
        try:
            with uplink_env(), TestClient(app) as client:
                def open_next() -> None:
                    try:
                        with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws2:
                            box["msg"] = _json_text(ws2.receive_text())
                    except Exception as exc:
                        box["err"] = exc

                with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                    self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_resume")
                    self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_config")
                    ws.send_bytes(frame)
                    self.assertTrue(entered.wait(3))
                    ws.close()
                    # push_pcm still owns the receive loop, so the queued disconnect has
                    # not been applied. Drop CONNECTED only long enough for the new
                    # socket to get past 4409, then put it back so the old loop can
                    # read that disconnect and exit.
                    old = sess._audio_ws
                    old.client_state = WebSocketState.DISCONNECTED
                    opener = threading.Thread(target=open_next)
                    opener.start()
                    time.sleep(0.4)
                    old.client_state = WebSocketState.CONNECTED
                    gate.set()
                    opener.join(5)
        finally:
            gate.set()
        self.assertNotIn("err", box)
        self.assertEqual(box.get("msg"), {"type": "uplink_resume", "prev_rx": 3200})

    def test_new_listen_does_not_rewind_rx_total(self) -> None:
        sess = _session()
        sess.push_pcm = lambda pcm: None  # type: ignore[method-assign]
        uplink.register(sess)
        client = TestClient(app)
        frame = b"\x0a" * 3200
        with uplink_env():
            with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_resume")
                self.assertEqual(_json_text(ws.receive_text())["type"], "uplink_config")
                ws.send_bytes(frame)
                ws.send_bytes(frame)
                self.assertEqual(_wait_ack(ws, 6400), {"type": "rx_ack", "rx": 6400})
                sess._pcm_rx_bytes = 0
                sess._listen_gen = getattr(sess, "_listen_gen", 0) + 1
                ws.send_bytes(frame)
                ack = _wait_ack(ws, 9600)
        self.assertEqual(ack, {"type": "rx_ack", "rx": 9600})


if __name__ == "__main__":
    unittest.main()
