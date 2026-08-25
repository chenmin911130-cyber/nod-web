from __future__ import annotations

import hashlib
import hmac
import os

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

ORIGIN_HEADER = b"x-nod-origin"

HSTS = "max-age=63072000; includeSubDomains; preload"

# microphone=(self): Nod's product is live browser-mic capture. camera/geo stay off.
PERMISSIONS_POLICY = "camera=(), microphone=(self), geolocation=()"

# Tight default, plus the third parties this build actually loads.
# Do not add https: / http: wildcards.
CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev https://*.clerk.com "
    "https://challenges.cloudflare.com https://accounts.google.com https://apis.google.com; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' data: https://fonts.gstatic.com; "
    "img-src 'self' data: blob: https://img.clerk.com https://*.clerk.com https://www.google.com "
    "https://*.googleusercontent.com; "
    "connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com wss://*.clerk.accounts.dev "
    "https://accounts.google.com https://www.googleapis.com https://streaming.assemblyai.com "
    "wss://streaming.assemblyai.com https://*.sentry.io https://*.ingest.sentry.io; "
    "frame-src https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com "
    "https://accounts.google.com; "
    "worker-src 'self' blob:; "
    "media-src 'self' blob:; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self' https://accounts.google.com; "
    "frame-ancestors 'none'; "
    "upgrade-insecure-requests"
)

ALWAYS_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("Permissions-Policy", PERMISSIONS_POLICY),
    ("Content-Security-Policy", CSP),
    ("X-DNS-Prefetch-Control", "off"),
    ("Cross-Origin-Opener-Policy", "same-origin-allow-popups"),
)


def forwarded_https(scope: Scope) -> bool:
    if scope.get("scheme") == "https":
        return True
    for raw_key, raw_val in scope.get("headers") or []:
        if raw_key.lower() == b"x-forwarded-proto":
            return raw_val.split(b",", 1)[0].strip().lower() == b"https"
    return False


def cloudflare_required() -> bool:
    return os.environ.get("REQUIRE_CLOUDFLARE", "").strip().lower() in ("1", "true", "yes")


def origin_secret() -> bytes:
    return os.environ.get("ORIGIN_SECRET", "").strip().encode("utf-8")


def _header_map(scope: Scope) -> dict[bytes, bytes]:
    return {k.lower(): v for k, v in (scope.get("headers") or [])}


def is_health_path(path: str) -> bool:
    return path.rstrip("/") == "/api/health"


def origin_allowed(scope: Scope) -> bool:
    """
    Railway sits in front of the container, so Cloudflare IP allowlists
    cannot be enforced here. A shared origin secret (injected by a
    Cloudflare request-header rule) is the lock that cannot be spoofed
    by Host-headering the old Railway IP. CF-Ray is a weaker fallback.
    """
    path = scope.get("path") or ""
    if is_health_path(path):
        return True
    headers = _header_map(scope)
    secret = origin_secret()
    if secret:
        offered = headers.get(ORIGIN_HEADER) or b""
        return hmac.compare_digest(hashlib.sha256(offered).digest(), hashlib.sha256(secret).digest())
    if cloudflare_required():
        return bool(headers.get(b"cf-ray"))
    return True


class SecurityHeadersMiddleware:
    """Pure ASGI wrapper so WebSocket upgrades are not broken by BaseHTTPMiddleware."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        https = forwarded_https(scope)

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(raw=message.setdefault("headers", []))
                for key, value in ALWAYS_HEADERS:
                    headers.setdefault(key, value)
                if https:
                    headers.setdefault("Strict-Transport-Security", HSTS)
            await send(message)

        await self.app(scope, receive, send_wrapper)


class CloudflareOriginMiddleware:
    """
    Origin lock. Off until ORIGIN_SECRET or REQUIRE_CLOUDFLARE is set.

    Railway health checks stay open. WebSocket upgrades are checked too —
    the handshake is ASGI type websocket, not http.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        if origin_allowed(scope):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4403})
            return
        body = b'{"detail":"Direct origin access is blocked"}'
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
