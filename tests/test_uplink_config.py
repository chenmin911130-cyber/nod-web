"""Server uplink_config frame on /ws/audio accept (T3)."""

from __future__ import annotations

import json
import os
import time
import unittest
from contextlib import contextmanager
from unittest import mock

from starlette.testclient import TestClient
from starlette.websockets import WebSocket, WebSocketDisconnect

_ENV_KEYS = (
    "NOD_UPLINK_CONFIG",
    "NOD_UPLINK_PACE",
    "NOD_UPLINK_CATCHUP_RATE",
    "NOD_UPLINK_COALESCE_MAX",
    "NOD_STT_CATCHUP_RATE",
    "NOD_STT_PACE_MODE",
)


@contextmanager
def uplink_env(**updates: str):
    saved = {key: os.environ.get(key) for key in _ENV_KEYS}
    for key in _ENV_KEYS:
        os.environ.pop(key, None)
    for key, value in updates.items():
        os.environ[key] = value
    try:
        yield
    finally:
        for key in _ENV_KEYS:
            os.environ.pop(key, None)
        for key, value in saved.items():
            if value is not None:
                os.environ[key] = value


def _configs(payloads: list[str]) -> list[dict]:
    found = []
    for raw in payloads:
        try:
            obj = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(obj, dict) and obj.get("type") == "uplink_config":
            found.append(obj)
    return found


@contextmanager
def recording_send_text():
    calls: list[str] = []
    original = WebSocket.send_text

    async def spy(self, data):
        calls.append(data)
        await original(self, data)

    with mock.patch("starlette.websockets.WebSocket.send_text", autospec=True, side_effect=spy):
        yield calls


class UplinkConfigEnvTests(unittest.TestCase):
    def test_env_table(self):
        from server.stt_audio import uplink_config_from_env

        cases = [
            ("defaults", {}, {"pace": "cumulative", "catchup_rate": 1.5, "coalesce_max": 3, "v": 1}),
            ("disabled", {"NOD_UPLINK_CONFIG": "0"}, None),
            ("legacy", {"NOD_UPLINK_PACE": "legacy"}, {"pace": "legacy"}),
            ("bogus pace", {"NOD_UPLINK_PACE": "bogus"}, {"pace": "cumulative"}),
            ("rate capped by server", {"NOD_UPLINK_CATCHUP_RATE": "9"}, {"catchup_rate": 1.5}),
            (
                "rate follows server cap",
                {"NOD_UPLINK_CATCHUP_RATE": "9", "NOD_STT_CATCHUP_RATE": "2.0"},
                {"catchup_rate": 2.0},
            ),
            (
                "rate under server cap",
                {"NOD_UPLINK_CATCHUP_RATE": "1.8", "NOD_STT_CATCHUP_RATE": "2.0"},
                {"catchup_rate": 1.8},
            ),
            ("rate not a number", {"NOD_UPLINK_CATCHUP_RATE": "abc"}, {"catchup_rate": 1.5}),
            ("rate floor", {"NOD_UPLINK_CATCHUP_RATE": "0.5"}, {"catchup_rate": 1.0}),
            ("frame mode forces 1", {"NOD_STT_PACE_MODE": "frame", "NOD_UPLINK_CATCHUP_RATE": "1.8"}, {"catchup_rate": 1.0}),
            ("coalesce floor", {"NOD_UPLINK_COALESCE_MAX": "0"}, {"coalesce_max": 1}),
            ("coalesce cap", {"NOD_UPLINK_COALESCE_MAX": "50"}, {"coalesce_max": 10}),
            ("coalesce fallback", {"NOD_UPLINK_COALESCE_MAX": "x"}, {"coalesce_max": 3}),
        ]
        for name, env, expect in cases:
            with self.subTest(name=name):
                with uplink_env(**env):
                    got = uplink_config_from_env()
                if expect is None:
                    self.assertIsNone(got)
                    continue
                self.assertIsInstance(got, dict)
                self.assertEqual(got["type"], "uplink_config")
                self.assertIsInstance(got["catchup_rate"], (int, float))
                self.assertNotIsInstance(got["catchup_rate"], bool)
                for key, value in expect.items():
                    self.assertEqual(got[key], value)


class UplinkConfigSocketTests(unittest.TestCase):
    def setUp(self) -> None:
        from server import uplink

        uplink.reset()

    def tearDown(self) -> None:
        from server import uplink

        uplink.reset()

    def test_ws_audio_sends_config_first(self):
        from server import uplink
        from server.app import app
        from tests.test_uplink import _session

        sess = _session()
        sess._listener = object()
        uplink.register(sess)
        client = TestClient(app)
        with uplink_env():
            with recording_send_text() as calls:
                with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
                    time.sleep(0.05)
                    _ = ws
        configs = _configs(calls)
        self.assertEqual(len(configs), 1)
        self.assertEqual(json.loads(calls[0])["type"], "uplink_config")

    def test_forged_token_gets_no_config(self):
        from server.app import app

        client = TestClient(app)
        with uplink_env():
            with recording_send_text() as calls:
                with self.assertRaises(WebSocketDisconnect) as ctx:
                    with client.websocket_connect("/ws/audio?token=not-a-real-token"):
                        pass
        self.assertEqual(ctx.exception.code, 4404)
        self.assertEqual(_configs(calls), [])

    def test_config_disabled_sends_nothing(self):
        from server import uplink
        from server.app import app
        from tests.test_uplink import _session

        sess = _session()
        sess._listener = object()
        uplink.register(sess)
        client = TestClient(app)
        with uplink_env(NOD_UPLINK_CONFIG="0"):
            with recording_send_text() as calls:
                with client.websocket_connect(f"/ws/audio?token={sess.audio_token}"):
                    time.sleep(0.05)
        self.assertEqual(_configs(calls), [])

    def test_config_log_line(self):
        from server import uplink
        from server.app import app
        from tests.test_uplink import _session

        sess = _session()
        sess._listener = object()
        uplink.register(sess)
        client = TestClient(app)
        with uplink_env():
            with self.assertLogs("nod", level="INFO") as cap:
                with client.websocket_connect(f"/ws/audio?token={sess.audio_token}"):
                    time.sleep(0.05)
        self.assertIn(
            "uplink_config pace=cumulative catchup_rate=1.5 coalesce_max=3",
            "\n".join(cap.output),
        )


if __name__ == "__main__":
    unittest.main()
