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

def _clerk_csp_hosts() -> list[str]:
    try:
        from server.clerk_auth import clerk_browser_hosts

        return [h for h in clerk_browser_hosts() if h and "/" not in h and " " not in h]
    except Exception:
        return []


def content_security_policy() -> str:
    # Tight default, plus the third parties this build actually loads.
    # Custom Clerk domains (clerk.example.com / accounts.example.com) come
    # from the live publishable key — without them Clerk never loads.
    extra = _clerk_csp_hosts()
    extra_https = " ".join(f"https://{h}" for h in extra)
    extra_wss = " ".join(f"wss://{h}" for h in extra)
    extra_h = f" {extra_https}" if extra_https else ""
    extra_w = f" {extra_wss}" if extra_wss else ""
    return (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev https://*.clerk.com "
        f"https://challenges.cloudflare.com https://accounts.google.com https://apis.google.com{extra_h}; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' data: https://fonts.gstatic.com; "
        "img-src 'self' data: blob: https://img.clerk.com https://*.clerk.com https://www.google.com "
        f"https://*.googleusercontent.com{extra_h}; "
        "connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com wss://*.clerk.accounts.dev "
        "https://accounts.google.com https://www.googleapis.com https://streaming.assemblyai.com "
        f"wss://streaming.assemblyai.com https://*.sentry.io https://*.ingest.sentry.io{extra_h}{extra_w}; "
        "frame-src https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com "
        f"https://accounts.google.com{extra_h}; "
        "worker-src 'self' blob:; "
        "media-src 'self' blob:; "
        "object-src 'none'; "
        "base-uri 'self'; "
        f"form-action 'self' https://accounts.google.com{extra_h}; "
        "frame-ancestors 'none'; "
        "upgrade-insecure-requests"
    )


# Snapshot for tests / imports. Middleware rebuilds per request so a live
# Clerk key's custom domain is always included.
CSP = content_security_policy()

ALWAYS_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("Permissions-Policy", PERMISSIONS_POLICY),
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
    Railway sits in front of the container, so     Cloudflare IP allowlists
    cannot be enforced here. A shared origin secret (injected by a
    Cloudflare request-header rule) is the lock. CF-Ray alone is not
    accepted — it can be forged on a direct origin request.
    """
    path = scope.get("path") or ""
    if is_health_path(path):
        return True
    headers = _header_map(scope)
    secret = origin_secret()
    if secret:
        offered = headers.get(ORIGIN_HEADER) or b""
        return hmac.compare_digest(hashlib.sha256(offered).digest(), hashlib.sha256(secret).digest())
    # CF-Ray is trivial to forge on a direct origin hit. If the lock is on,
    # require ORIGIN_SECRET — do not fall back to a spoofable header.
    if cloudflare_required():
        return False
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
                headers.setdefault("Content-Security-Policy", content_security_policy())
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


def host_allowed(scope: Scope, allowed_hosts: set[str]) -> bool:
    """Pure Host-allowlist check used by HostLockMiddleware.

    ``allowed_hosts`` are lowercase hostnames without port. Loopback clients
    with a loopback Host (local dev) are always allowed.
    """
    host = ""
    for raw_key, raw_val in scope.get("headers") or []:
        if raw_key.lower() == b"host":
            host = raw_val.decode("latin1", "replace").split(":", 1)[0].strip().lower()
            break
    if not host:
        return False
    if host in allowed_hosts:
        return True
    # Starlette TestClient uses Host: testserver. Only honour that while
    # pytest is running so a production PUBLIC_URL does not 403 the suite.
    if host == "testserver" and os.environ.get("PYTEST_CURRENT_TEST"):
        return True
    client = scope.get("client") or ("", 0)
    if client[0] in {"127.0.0.1", "::1", "localhost"} and host in {"127.0.0.1", "localhost"}:
        return True
    return False


class HostLockMiddleware:
    """Reject requests whose Host is not the deployment domain.

    A direct hit on the Railway-assigned *.up.railway.app domain would skip
    Cloudflare entirely (WAF, rate limiting, DDoS buffer). This middleware
    answers 403 / 4403 to any Host outside the allowlist, so the only way in
    is through the registered domain. ``/api/health`` stays open so Railway's
    own health check keeps working. Auto-enabled when a non-local PUBLIC_URL
    or ALLOWED_HOSTS is configured (see settings.ALLOWED_HOSTS).
    """

    def __init__(self, app: ASGIApp) -> None:
        from server.settings import ALLOWED_HOSTS, HOST_LOCK

        self.app = app
        self.enabled = bool(HOST_LOCK)
        self.allowed = set(ALLOWED_HOSTS)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        if not self.enabled:
            await self.app(scope, receive, send)
            return
        if is_health_path(scope.get("path") or ""):
            await self.app(scope, receive, send)
            return
        if host_allowed(scope, self.allowed):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4403})
            return
        body = b'{"detail":"Host not allowed"}'
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
