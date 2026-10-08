"""In-memory native audio uplink registry (#169)."""

from __future__ import annotations

import threading
import time
from typing import Any

from server.settings import LISTEN_OFFLINE_GRACE_SECONDS, UPLINK_ORPHAN_SECONDS

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
    if getattr(session, "_listener", None) is None:
        return False
    # #279: a session whose native uplink ever attached must survive a control drop
    # even when the audio socket is momentarily gone — the phone reconnects with
    # ?attach= and the same /ws/audio keeps feeding. Without `_uplink_seen` a
    # transient uplink loss closed the session, stopped listening and sealed the
    # open meeting line. Old clients never set either flag, so they still close.
    return bool(getattr(session, "_uplink_connected", False)) or bool(
        getattr(session, "_uplink_seen", False)
    )


def adopt(token: str | None, user_id: str | None) -> Any | None:
    if not token or user_id is None:
        return None
    with _lock:
        sess = _by_token.get(token)
        if sess is None:
            return None
        if getattr(sess, "user_id", None) != user_id:
            return None
        if getattr(sess, "_closed", False):
            return None
        # #279: a reconnect can arrive BEFORE the previous control socket's finally
        # parks the session. Returning None there minted a second Session with its
        # own audio_uplink token — the phone opened a second /ws/audio and the two
        # sessions fought over the STT slot. Adopt the still-live session instead;
        # the superseded socket is fenced off by `_control_owner`.
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
                notice = getattr(sess, "_offline_notice", None)
                stop_at = (
                    float(notice.get("at") or 0.0)
                    if isinstance(notice, dict)
                    else 0.0
                )
                if stop_at > 0 and now - stop_at < UPLINK_ORPHAN_SECONDS:
                    continue
                to_close.append((token, sess))
            elif now - lost >= UPLINK_ORPHAN_SECONDS:
                to_close.append((token, sess))
            elif (not uplink_on) and uplink_lost and now - uplink_lost >= max(
                UPLINK_DROP_REAP_SECONDS, float(LISTEN_OFFLINE_GRACE_SECONDS)
            ):
                to_close.append((token, sess))
            # Audio can close before the control socket parks, leaving
            # _uplink_lost_at at 0. The control-loss clock is the only one,
            # and a live listener still gets the offline grace.
            elif (not uplink_on) and (not uplink_lost) and now - lost >= max(
                UPLINK_DROP_REAP_SECONDS, float(LISTEN_OFFLINE_GRACE_SECONDS)
            ):
                to_close.append((token, sess))
        for token, _sess in to_close:
            _parked.pop(token, None)
            _by_token.pop(token, None)
    for _token, sess in to_close:
        sess.close()
