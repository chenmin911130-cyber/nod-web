"""Watch End pcm_end / pcm_drained (#165). Old clients omit pcm_end."""

from __future__ import annotations

import json
import unittest
from unittest import mock

from starlette.testclient import TestClient

from server import uplink
from server.app import CFG, Session, _reset_live_stt


def _session(user_id: str = "user-a") -> Session:
    sess = Session(lambda _ev: None, json.loads(json.dumps(CFG)), {}, user_id)
    sess.close = mock.Mock()  # type: ignore[method-assign]
    return sess


class PcmEndTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def tearDown(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def test_wrong_session_id_does_not_drain(self) -> None:
        sess = _session()
        sess.usage_session_id = "sess-live"
        sess._pcm_rx_bytes = 3200
        lst = mock.Mock()
        sess._listener = lst
        events: list[dict] = []
        sess.emit = events.append
        sess.pcm_end("sess-old", 3200)
        lst.drain.assert_not_called()
        self.assertEqual(events, [])

    def test_empty_id_does_not_drain(self) -> None:
        sess = _session()
        sess.usage_session_id = "sess-live"
        sess._pcm_rx_bytes = 3200
        lst = mock.Mock()
        sess._listener = lst
        sess.emit = mock.Mock()
        sess.pcm_end("", 3200)
        lst.drain.assert_not_called()
        sess.emit.assert_not_called()

    def test_matching_id_drains_then_emits(self) -> None:
        sess = _session()
        sess.usage_session_id = "sess-live"
        sess._pcm_rx_bytes = 6400
        lst = mock.Mock()
        sess._listener = lst
        events: list[dict] = []
        sess.emit = events.append
        sess.pcm_end("sess-live", 6400)
        lst.drain.assert_called_once()
        self.assertEqual(events, [{"type": "pcm_drained", "id": "sess-live", "byte_offset": 6400}])

    def test_waits_until_bytes_arrive(self) -> None:
        sess = _session()
        sess.usage_session_id = "sess-live"
        sess._pcm_rx_bytes = 0
        lst = mock.Mock()
        sess._listener = lst
        events: list[dict] = []
        sess.emit = events.append
        sess.pcm_end("sess-live", 1600)
        lst.drain.assert_not_called()
        self.assertEqual(events, [])
        sess._pcm_rx_bytes = 1600
        sess._finish_pcm_end_if_ready()
        lst.drain.assert_called_once()
        self.assertEqual(events[0]["type"], "pcm_drained")

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
        sess.usage_session_id = "sess-live"
        sess._pcm_rx_bytes = 3200
        lst = mock.Mock()
        sess._listener = lst
        events: list[dict] = []
        sess.emit = events.append
        uplink.register(sess)
        client = TestClient(app)
        with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
            ws.send_text(json.dumps({"type": "pcm_end", "id": "sess-old", "byte_offset": 3200}))
        lst.drain.assert_not_called()
        self.assertEqual(events, [])
