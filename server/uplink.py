"""In-memory native audio uplink registry (#169)."""

from __future__ import annotations

import threading
import time
from typing import Any

from server.settings import UPLINK_ORPHAN_SECONDS

_lock = threading.Lock()
_by_token: dict[str, Any] = {}
_parked: dict[str, float] = {}

UPLINK_DROP_REAP_SECONDS = 60.0


def reset() -> None:
    with _lock:
        _by_token.clear()
        _parked.clear()


def register(session: Any) -> None:
    token = session.audio_token
    with _lock:
        _by_token[token] = session


def get(token: str | None) -> Any | None:
    if not token:
        return None
    with _lock:
        return _by_token.get(token)


def unregister(token: str | None) -> None:
    if not token:
        return
    with _lock:
        _by_token.pop(token, None)
        _parked.pop(token, None)


def park(session: Any) -> None:
    token = session.audio_token
    with _lock:
        _parked[token] = time.time()
        _by_token[token] = session


def is_parked(token: str | None) -> bool:
    if not token:
        return False
    with _lock:
        return token in _parked


def should_park(session: Any) -> bool:
    return getattr(session, "_listener", None) is not None and bool(
        getattr(session, "_uplink_connected", False)
    )


def adopt(token: str | None, user_id: str | None) -> Any | None:
    if not token or user_id is None:
        return None
    with _lock:
        sess = _by_token.get(token)
        if sess is None or token not in _parked:
            return None
        if getattr(sess, "user_id", None) != user_id:
            return None
        _parked.pop(token, None)
        return sess


def reap(now: float) -> None:
    to_close: list[tuple[str, Any]] = []
    with _lock:
        for token, parked_at in list(_parked.items()):
            sess = _by_token.get(token)
            if sess is None:
                _parked.pop(token, None)
                continue
            lost = float(getattr(sess, "_control_lost_at", 0.0) or parked_at)
            listener_gone = getattr(sess, "_listener", None) is None
            uplink_on = bool(getattr(sess, "_uplink_connected", False))
            uplink_lost = float(getattr(sess, "_uplink_lost_at", 0.0) or 0.0)
            if listener_gone:
                to_close.append((token, sess))
            elif now - lost >= UPLINK_ORPHAN_SECONDS:
                to_close.append((token, sess))
            elif (not uplink_on) and uplink_lost and now - uplink_lost >= UPLINK_DROP_REAP_SECONDS:
                to_close.append((token, sess))
            elif (not uplink_on) and (not uplink_lost) and now - lost >= UPLINK_DROP_REAP_SECONDS:
                to_close.append((token, sess))
        for token, _sess in to_close:
            _parked.pop(token, None)
            _by_token.pop(token, None)
    for _token, sess in to_close:
        sess.close()
