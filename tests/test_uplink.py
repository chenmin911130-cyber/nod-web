"""Native PCM uplink + control-WS reattach (#169)."""

from __future__ import annotations

import json
import time
import unittest
from unittest import mock

from datetime import datetime, timezone

from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server import uplink
from server.app import CFG, KEYS, Session, _reset_live_stt, _tick_live_idle_watches
from server.db import HistoryItem, User, db_session
from server.security import issue_jwt, new_id
from server.settings import COOKIE_NAME, UPLINK_ORPHAN_SECONDS


def _emit(_ev: dict) -> None:
    return None


def _session(user_id: str = "user-a") -> Session:
    sess = Session(_emit, json.loads(json.dumps(CFG)), dict(KEYS), user_id)
    sess.close = mock.Mock()  # type: ignore[method-assign]
    return sess


class UplinkRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def tearDown(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def test_register_get_unregister(self) -> None:
        sess = _session()
        uplink.register(sess)
        self.assertIs(uplink.get(sess.audio_token), sess)
        uplink.unregister(sess.audio_token)
        self.assertIsNone(uplink.get(sess.audio_token))

    def test_forged_token_audio_ws_closes_4404(self) -> None:
        from server.app import app

        client = TestClient(app)
        with self.assertRaises(WebSocketDisconnect) as ctx:
            with client.websocket_connect("/ws/audio?token=not-a-real-token"):
                pass
        self.assertEqual(ctx.exception.code, 4404)


class UplinkPcmTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()

    def tearDown(self) -> None:
        uplink.reset()

    def test_audio_ws_pcm_refreshes_last_pcm_at(self) -> None:
        sess = _session()
        sess._listener = object()
        sess._last_pcm_at = 1.0
        uplink.register(sess)
        from server.app import app

        client = TestClient(app)
        with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
            ws.send_bytes(b"\x00\x00" * 160)
            time.sleep(0.05)
        self.assertGreater(sess._last_pcm_at, 1.0)
        self.assertFalse(sess._uplink_connected)


class ParkKeepTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()

    def tearDown(self) -> None:
        uplink.reset()

    def test_control_drop_with_uplink_parks_until_orphan(self) -> None:
        sess = _session()
        sess.usage_session_id = "keep-me"
        sess._listener = object()
        sess._uplink_connected = True
        uplink.register(sess)
        self.assertTrue(uplink.should_park(sess))
        sess._control_lost_at = time.time()
        uplink.park(sess)
        sess.close.assert_not_called()
        self.assertEqual(sess.usage_session_id, "keep-me")
        self.assertIs(uplink.get(sess.audio_token), sess)

        sess._control_lost_at = time.time() - UPLINK_ORPHAN_SECONDS - 1
        uplink.reap(time.time())
        sess.close.assert_called_once()
        self.assertIsNone(uplink.get(sess.audio_token))

    def test_control_and_uplink_drop_reaps_after_60s(self) -> None:
        sess = _session()
        sess._listener = object()
        sess._uplink_connected = False
        sess._control_lost_at = time.time() - 61
        sess._uplink_lost_at = time.time() - 61
        uplink.register(sess)
        uplink.park(sess)
        uplink.reap(time.time())
        sess.close.assert_called_once()
        self.assertIsNone(uplink.get(sess.audio_token))

    def test_parked_stopped_listen_reaps_on_tick(self) -> None:
        sess = _session()
        sess._listener = None
        sess._uplink_connected = True
        sess._control_lost_at = time.time()
        uplink.register(sess)
        uplink.park(sess)
        _tick_live_idle_watches()
        sess.close.assert_called_once()


class AttachTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()

    def tearDown(self) -> None:
        uplink.reset()

    def test_adopt_rejects_other_user(self) -> None:
        sess = _session("owner")
        sess._listener = object()
        sess._uplink_connected = True
        uplink.register(sess)
        uplink.park(sess)
        self.assertIsNone(uplink.adopt(sess.audio_token, "intruder"))
        self.assertIs(uplink.adopt(sess.audio_token, "owner"), sess)

    def test_reattach_replaces_emit_and_sends_attached_phase(self) -> None:
        events: list[dict] = []

        def emit(ev: dict) -> None:
            events.append(ev)

        sess = Session(emit, json.loads(json.dumps(CFG)), dict(KEYS), "owner")
        sess.usage_session_id = "sess-1"
        sess._listener = object()
        sess._uplink_connected = True
        uplink.register(sess)
        uplink.park(sess)
        adopted = uplink.adopt(sess.audio_token, "owner")
        self.assertIs(adopted, sess)
        replacement: list[dict] = []
        sess.emit = replacement.append
        sess.pipeline.emit = replacement.append
        sess.reattach()
        types = [e["type"] for e in replacement]
        self.assertEqual(types[0], "keys_status")
        self.assertEqual(types[1], "ready")
        self.assertIn("attached", types)
        self.assertIn("phase", types)
        attached = next(e for e in replacement if e["type"] == "attached")
        self.assertEqual(attached["usage_session_id"], "sess-1")
        self.assertEqual(sess._control_lost_at, 0.0)


class NoAttachRegressionTests(unittest.TestCase):
    def test_should_park_false_without_uplink(self) -> None:
        sess = _session()
        sess._listener = object()
        sess._uplink_connected = False
        self.assertFalse(uplink.should_park(sess))


def _wait_until(pred, timeout: float = 2.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return
        time.sleep(0.01)
    raise AssertionError("timed out")


def _drain_until(ws, typ: str, limit: int = 30) -> list[dict]:
    events: list[dict] = []
    for _ in range(limit):
        ev = ws.receive_json()
        events.append(ev)
        if ev.get("type") == typ:
            return events
    raise AssertionError(f"no {typ} in {[e.get('type') for e in events]}")


def _authed_client() -> tuple[TestClient, str]:
    from server.app import app

    uid = new_id()
    email = f"{uid}@test.local"
    with db_session() as db:
        db.add(User(id=uid, email=email, password_hash="", recording_consent_at=datetime.now(timezone.utc)))
    token = issue_jwt(uid, email)
    client = TestClient(app)
    client.cookies.set(COOKIE_NAME, token)
    return client, uid


class UplinkWsLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def tearDown(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def test_control_close_cuts_audio_ws_and_skips_metering(self) -> None:
        client, _uid = _authed_client()
        ctrl_cm = client.websocket_connect("/ws")
        control = ctrl_cm.__enter__()
        audio_cm = None
        try:
            events = _drain_until(control, "audio_uplink")
            token = next(e["token"] for e in events if e.get("type") == "audio_uplink")
            audio_cm = client.websocket_connect(f"/ws/audio?token={token}")
            audio = audio_cm.__enter__()
            sess = uplink.get(token)
            self.assertIsNotNone(sess)
            _wait_until(lambda: bool(sess._uplink_connected))
            ctrl_cm.__exit__(None, None, None)
            ctrl_cm = None
            time.sleep(0.15)
            with mock.patch("server.meter.open_usage_session") as opened:
                try:
                    audio.send_bytes(b"\x00" * 16000)
                    time.sleep(0.2)
                except Exception:
                    pass
                opened.assert_not_called()
            self.assertIsNone(sess.usage_session_id)
            self.assertFalse(sess._uplink_connected)
        finally:
            if audio_cm is not None:
                audio_cm.__exit__(None, None, None)
            if ctrl_cm is not None:
                ctrl_cm.__exit__(None, None, None)

    def test_park_drops_control_queue_saves_transcript_then_reattach(self) -> None:
        client, uid = _authed_client()
        ctrl_cm = client.websocket_connect("/ws")
        control = ctrl_cm.__enter__()
        events = _drain_until(control, "audio_uplink")
        token = next(e["token"] for e in events if e.get("type") == "audio_uplink")
        audio_cm = client.websocket_connect(f"/ws/audio?token={token}")
        audio = audio_cm.__enter__()
        try:
            sess = uplink.get(token)
            self.assertIsNotNone(sess)
            sess._listener = object()
            _wait_until(lambda: bool(sess._uplink_connected))
            ctrl_cm.__exit__(None, None, None)
            _wait_until(lambda: uplink.is_parked(token))
            self.assertIs(uplink.get(token), sess)
            for i in range(40):
                sess.emit({"type": "status", "text": f"parked-{i}"})
            sess.usage_session_id = "park-sess"
            sess._workspace = "meeting"
            sess._emit_meeting_line("lock screen still writing", "en")
            with db_session() as db:
                rows = db.query(HistoryItem).filter(HistoryItem.session_id == "park-sess").all()
            self.assertTrue(any("lock screen still writing" in (r.text or "") for r in rows))
            with client.websocket_connect(f"/ws?attach={token}") as control2:
                attached = _drain_until(control2, "attached")
                types = [e.get("type") for e in attached]
                self.assertIn("attached", types)
                self.assertFalse(any(str(e.get("text") or "").startswith("parked-") for e in attached))
                sess.emit({"type": "status", "text": "live-again"})
                live = _drain_until(control2, "status")
                self.assertTrue(any(e.get("text") == "live-again" for e in live))
        finally:
            audio_cm.__exit__(None, None, None)

    def test_watch_copy_keeps_flowing_while_control_is_parked(self) -> None:
        """#219 P1: parking the control socket must not stop the Watch copy stream.

        The phone locking drops the control WS (session parked) while the native
        audio uplink stays up. Translate results must keep being routed to that
        socket before and after the phone reconnects, and the phone must get the
        copy version on the chunk it also consumes.

        The audio frame itself is asserted at the `_send_audio_text` boundary:
        starlette's TestClient gives each websocket its own event loop, so a frame
        pushed from the session's (control) loop can never land on the audio test
        session even though one uvicorn loop serves both in production.
        """
        client, _uid = _authed_client()
        ctrl_cm = client.websocket_connect("/ws")
        control = ctrl_cm.__enter__()
        events = _drain_until(control, "audio_uplink")
        token = next(e["token"] for e in events if e.get("type") == "audio_uplink")
        audio_cm = client.websocket_connect(f"/ws/audio?token={token}")
        audio = audio_cm.__enter__()
        try:
            sess = uplink.get(token)
            self.assertIsNotNone(sess)
            sess._listener = object()
            _wait_until(lambda: bool(sess._uplink_connected))
            sess._workspace = "translate"
            sess.cfg.setdefault("ui", {})["translate_to"] = "zh"
            sess.emit({
                "type": "question",
                "id": "ask-1",
                "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello there",
            })
            native: list[dict] = []
            sess._send_audio_text = native.append
            # Phone locks: control drops, session parked, audio uplink stays.
            ctrl_cm.__exit__(None, None, None)
            ctrl_cm = None
            _wait_until(lambda: uplink.is_parked(token))
            self.assertIsNone(sess._client_emit)
            sess.emit({"type": "chunk", "id": "ask-1", "text": "你好"})
            self.assertEqual([row["translation"] for row in native], ["你好"])
            locked = native[-1]
            self.assertEqual(locked["type"], "watch_copy")
            self.assertEqual(locked["id"], "pair-1")
            self.assertTrue(locked["session_id"])
            # Phone wakes and re-attaches: the same routing must keep working.
            with client.websocket_connect(f"/ws?attach={token}") as control2:
                _drain_until(control2, "attached")
                sess.emit({"type": "chunk", "id": "ask-1", "text": "！"})
                live = _drain_until(control2, "chunk")
                self.assertTrue(any(e.get("copy_seq") for e in live))
                self.assertEqual([row["translation"] for row in native], ["你好", "你好！"])
                self.assertGreater(native[-1]["seq"], locked["seq"])
                self.assertEqual(native[-1]["session_id"], locked["session_id"])
        finally:
            if audio_cm is not None:
                audio_cm.__exit__(None, None, None)
            if ctrl_cm is not None:
                ctrl_cm.__exit__(None, None, None)


if __name__ == "__main__":
    unittest.main()
