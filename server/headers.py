from __future__ import annotations

import os

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

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


def _header_map(scope: Scope) -> dict[bytes, bytes]:
    return {k.lower(): v for k, v in (scope.get("headers") or [])}


def is_health_path(path: str) -> bool:
    return path.rstrip("/") == "/api/health"


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
    Optional origin lock. Off unless REQUIRE_CLOUDFLARE=1.

    Only checks that the request already passed through Cloudflare (CF-Ray).
    Railway health checks stay open. Do not enable until the zone is orange-clouded
    or /api/health is the only public probe Railway needs.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not cloudflare_required():
            await self.app(scope, receive, send)
            return

        path = scope.get("path") or ""
        if is_health_path(path):
            await self.app(scope, receive, send)
            return

        headers = _header_map(scope)
        if headers.get(b"cf-ray"):
            await self.app(scope, receive, send)
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
