from __future__ import annotations

from urllib.parse import urlparse

# WKWebView origins used by the Capacitor iOS shell. These must be listed
# explicitly because credentialed CORS cannot use wildcards.
CAPACITOR_ORIGINS = (
    "capacitor://localhost",
    "ionic://localhost",
    "https://localhost",
)


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
