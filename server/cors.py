from __future__ import annotations

from urllib.parse import urlparse

from starlette.datastructures import Headers, MutableHeaders
from starlette.middleware.cors import CORSMiddleware
from starlette.types import Message, Send

# WKWebView origins used by the Capacitor iOS shell. These must be listed
# explicitly because credentialed CORS cannot use wildcards.
CAPACITOR_ORIGINS = (
    "capacitor://localhost",
    "ionic://localhost",
    "https://localhost",
)


class OriginLockedCORSMiddleware(CORSMiddleware):
    """Emit Allow-Credentials only when the request Origin is on the allowlist."""

    async def send(self, message: Message, send: Send, request_headers: Headers) -> None:
        if message["type"] != "http.response.start":
            await send(message)
            return
        message.setdefault("headers", [])
        headers = MutableHeaders(scope=message)
        origin = request_headers["Origin"]
        if self.is_allowed_origin(origin=origin):
            headers.update(self.simple_headers)
            self.allow_explicit_origin(headers, origin)
        await send(message)

    def preflight_response(self, request_headers: Headers):
        response = super().preflight_response(request_headers)
        origin = request_headers["origin"]
        if not self.is_allowed_origin(origin=origin):
            if "access-control-allow-credentials" in response.headers:
                del response.headers["access-control-allow-credentials"]
        return response


def cors_origins(public_url: str | None = None) -> list[str]:
    origins = [
        "http://127.0.0.1:5174",
        "http://localhost:5174",
        "http://127.0.0.1:9320",
        "http://localhost:9320",
        *CAPACITOR_ORIGINS,
    ]
    if public_url:
        origin = public_url.rstrip("/")
        origins.append(origin)
        host = urlparse(origin).hostname or ""
        if host.count(".") == 1:
            origins.append(f"{urlparse(origin).scheme}://www.{host}")
    return origins
