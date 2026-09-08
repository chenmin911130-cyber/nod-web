"""Native PCM uplink + control-WS reattach (#169)."""

from __future__ import annotations

import json
import time
import unittest
from unittest import mock

from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server import uplink
from server.app import CFG, KEYS, Session, _reset_live_stt, _tick_live_idle_watches
from server.settings import UPLINK_ORPHAN_SECONDS


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


if __name__ == "__main__":
    unittest.main()
