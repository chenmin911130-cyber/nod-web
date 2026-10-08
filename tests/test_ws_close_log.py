"""WebSocket close-code diagnostics (ticket K)."""

from __future__ import annotations

import json
import logging
import re
import time
from unittest import mock

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server import uplink
from server.app import CFG, KEYS, Session, app


def _audio_session(user_id: str = "user-a", usage_session_id: str = "sess-a") -> Session:
    sess = Session(lambda _ev: None, json.loads(json.dumps(CFG)), dict(KEYS), user_id)
    sess.close = mock.Mock()  # type: ignore[method-assign]
    sess.usage_session_id = usage_session_id
    return sess


def _ws_close_lines(caplog) -> list[str]:
    return [r.message for r in caplog.records if "ws_close" in r.message]


@pytest.fixture(autouse=True)
def _reset_uplink() -> None:
    uplink.reset()
    yield
    uplink.reset()


def test_control_ws_close_logs_code(caplog) -> None:
    caplog.set_level(logging.INFO, logger="nod")
    client = TestClient(app)
    with mock.patch("server.app.is_local_scope", return_value=True):
        with client.websocket_connect("/ws") as ws:
            ws.close(4000)
    lines = _ws_close_lines(caplog)
    assert any("ws_close kind=control code=4000" in ln for ln in lines)


def test_audio_ws_close_logs_code_and_dur(caplog) -> None:
    caplog.set_level(logging.INFO, logger="nod")
    sess = _audio_session()
    uplink.register(sess)
    client = TestClient(app)
    with client.websocket_connect(f"/ws/audio?token={sess.audio_token}") as ws:
        time.sleep(0.01)
        ws.close(1001)
    lines = _ws_close_lines(caplog)
    hit = [ln for ln in lines if "kind=audio code=1001" in ln]
    assert hit, lines
    m = re.search(r"dur_s=([0-9.]+)", hit[0])
    assert m is not None
    assert float(m.group(1)) >= 0.0


def test_forged_token_audio_ws_no_ws_close_log(caplog) -> None:
    caplog.set_level(logging.INFO, logger="nod")
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as ctx:
        with client.websocket_connect("/ws/audio?token=not-a-real-token"):
            pass
    assert ctx.value.code == 4404
    assert _ws_close_lines(caplog) == []
