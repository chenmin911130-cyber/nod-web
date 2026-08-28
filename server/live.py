from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict, deque
from typing import Any

log = logging.getLogger("nod.live")

_WINDOW = 3600.0
_lock = threading.Lock()
_sessions: dict[int, Any] = {}
_events: dict[str, deque[float]] = defaultdict(deque)


def reset() -> None:
    with _lock:
        _sessions.clear()
        _events.clear()


def attach(session: Any) -> None:
    with _lock:
        _sessions[id(session)] = session


def detach(session: Any) -> None:
    with _lock:
        _sessions.pop(id(session), None)


def mark(kind: str) -> None:
    now = time.monotonic()
    with _lock:
        q = _events[kind]
        q.append(now)
        _trim_locked(q, now)


def note_event(obj: dict) -> None:
    kind = obj.get("type")
    if kind == "error":
        mark("errors")
    elif kind == "quota_exceeded":
        mark("quota")


def snapshot() -> dict[str, int]:
    now = time.monotonic()
    with _lock:
        listening = 0
        generating = 0
        for sess in _sessions.values():
            if getattr(sess, "_listener", None) is not None:
                listening += 1
            if getattr(sess, "_busy", False):
                generating += 1
        return {
            "live_ws": len(_sessions),
            "live_listening": listening,
            "live_generating": generating,
            "errors_1h": _count_locked("errors", now),
            "quota_blocks_1h": _count_locked("quota", now),
            "ws_rejected_1h": _count_locked("ws_rejected", now),
        }


def log_snapshot() -> None:
    snap = snapshot()
    log.info(
        "live ws=%s listening=%s generating=%s errors_1h=%s quota_1h=%s rejected_1h=%s",
        snap["live_ws"],
        snap["live_listening"],
        snap["live_generating"],
        snap["errors_1h"],
        snap["quota_blocks_1h"],
        snap["ws_rejected_1h"],
    )


def _trim_locked(q: deque[float], now: float) -> None:
    cutoff = now - _WINDOW
    while q and q[0] <= cutoff:
        q.popleft()


def _count_locked(kind: str, now: float) -> int:
    q = _events.get(kind)
    if not q:
        return 0
    _trim_locked(q, now)
    return len(q)
