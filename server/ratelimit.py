from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

_lock = threading.Lock()
_hits: dict[str, deque[float]] = defaultdict(deque)
_ws_conns: dict[str, int] = defaultdict(int)

MAX_WS_FRAME = 48 * 1024
MAX_WS_CONNS = 8
WS_FRAMES_PER_SEC = 40

# x-forwarded-for is attacker-controlled unless the origin only accepts traffic
# from the edge, so bound the table: a spoofed header must not be able to grow
# it without limit.
_SWEEP_EVERY = 60.0
_STALE_AFTER = 3600.0
_MAX_KEYS = 50_000
_last_sweep = 0.0


def _sweep_locked(now: float) -> None:
    global _last_sweep
    if now - _last_sweep < _SWEEP_EVERY and len(_hits) <= _MAX_KEYS:
        return
    _last_sweep = now
    for key in [k for k, q in _hits.items() if not q or q[-1] <= now - _STALE_AFTER]:
        _hits.pop(key, None)
    while len(_hits) > _MAX_KEYS:
        _hits.pop(next(iter(_hits)), None)


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()[:64]
    return (request.client.host if request.client else "unknown")[:64]


def ws_client_ip(host: str | None, headers: dict[str, str] | None = None) -> str:
    headers = {k.lower(): v for k, v in (headers or {}).items()}
    forwarded = headers.get("cf-connecting-ip") or headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()[:64]
    return (host or "unknown")[:64]


def allow(key: str, limit: int, window: float) -> bool:
    now = time.monotonic()
    with _lock:
        _sweep_locked(now)
        q = _hits[key]
        cutoff = now - window
        while q and q[0] <= cutoff:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True


def rate_limit(scope: str, limit: int, window: float):
    def _check(request: Request) -> None:
        ip = client_ip(request)
        if not allow(f"{scope}:{ip}", limit, window):
            raise HTTPException(status_code=429, detail="Too many requests. Try again shortly.")

    return _check


def ws_connect(ip: str) -> bool:
    with _lock:
        if _ws_conns[ip] >= MAX_WS_CONNS:
            return False
        _ws_conns[ip] += 1
        return True


def ws_disconnect(ip: str) -> None:
    with _lock:
        n = _ws_conns.get(ip, 0) - 1
        if n <= 0:
            _ws_conns.pop(ip, None)
        else:
            _ws_conns[ip] = n
