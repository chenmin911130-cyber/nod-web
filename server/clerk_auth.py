from __future__ import annotations

import base64
import logging
import os
import time
from functools import lru_cache
from urllib.parse import urlparse

import httpx
import jwt
from fastapi import HTTPException, Request
from jwt import PyJWKClient

from server.settings import CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, PUBLIC_URL

log = logging.getLogger("nod.clerk")


def _publishable_key() -> str:
    return (os.environ.get("CLERK_PUBLISHABLE_KEY") or CLERK_PUBLISHABLE_KEY or "").strip()


def _frontend_api() -> str:
    """Hostname encoded in the Clerk publishable key, e.g. clerk.nodpilot.com."""
    key = _publishable_key()
    if not key or "_" not in key:
        return ""
    try:
        raw = key.split("_", 2)[2]
        padded = raw + "=" * (-len(raw) % 4)
        decoded = base64.b64decode(padded).decode("utf-8").rstrip("$").strip()
        host = decoded.replace("https://", "").replace("http://", "").split("/")[0]
        if "." not in host or " " in host or len(host) < 8:
            return ""
        return host
    except Exception:
        return ""


def clerk_browser_hosts() -> list[str]:
    """Custom Clerk Frontend API + account-portal hosts the browser must reach.

    Production keys encode clerk.example.com. Clerk's satellite is usually
    accounts.example.com. Without these in CSP, Clerk never loads and the
    Google button stays disabled.
    """
    hosts: list[str] = []
    fapi = _frontend_api()
    if fapi:
        hosts.append(fapi)
        if fapi.startswith("clerk.") and fapi.count(".") >= 2:
            satellite = "accounts." + fapi.split(".", 1)[1]
            if satellite not in hosts:
                hosts.append(satellite)
    public = (os.environ.get("PUBLIC_URL") or PUBLIC_URL or "").strip()
    if public and "://" not in public:
        public = "https://" + public
    apex = (urlparse(public).hostname or "").lower()
    if apex.startswith("www."):
        apex = apex[4:]
    if apex and "." in apex and apex not in {"127.0.0.1", "localhost"}:
        for prefix in ("clerk", "accounts"):
            host = f"{prefix}.{apex}"
            if host not in hosts:
                hosts.append(host)
    return hosts


CLERK_JS_PATH = "/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
CLERK_JS_MIN_BYTES = 10_000
CLERK_JS_TTL_S = 3600
_clerk_js_cache: tuple[bytes, str, float] | None = None


def reset_clerk_js_cache() -> None:
    global _clerk_js_cache
    _clerk_js_cache = None


def clerk_js_source_url() -> str:
    """Absolute URL of clerk.browser.js on this instance's Frontend API host."""
    host = _frontend_api()
    if not host:
        return ""
    return f"https://{host}{CLERK_JS_PATH}"


def load_clerk_browser_js() -> tuple[bytes, str]:
    """Fetch clerk-js from the instance Frontend API and cache it.

    Browsers were failing to execute the third-party script on
    clerk.nodpilot.com (0-byte blocked loads). Serving the same file from
    this origin keeps script-src 'self'.
    """
    global _clerk_js_cache
    now = time.monotonic()
    if _clerk_js_cache and now - _clerk_js_cache[2] < CLERK_JS_TTL_S:
        return _clerk_js_cache[0], _clerk_js_cache[1]
    url = clerk_js_source_url()
    if not url:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured")
    host = urlparse(url).hostname or ""
    if host != _frontend_api():
        raise HTTPException(status_code=503, detail="Google sign-in is not configured")
    try:
        res = httpx.get(
            url,
            timeout=20.0,
            follow_redirects=True,
            headers={"Accept": "application/javascript,*/*"},
        )
    except httpx.HTTPError as ex:
        log.warning("clerk-js fetch failed err=%s", ex)
        raise HTTPException(status_code=502, detail="Could not load Google sign-in") from ex
    body = res.content or b""
    ctype = (res.headers.get("content-type") or "application/javascript").split(";", 1)[0].strip()
    if res.status_code != 200 or len(body) < CLERK_JS_MIN_BYTES or body.lstrip()[:1] == b"<" or "html" in ctype.lower():
        log.warning("clerk-js rejected status=%s type=%s bytes=%s", res.status_code, ctype, len(body))
        raise HTTPException(status_code=502, detail="Could not load Google sign-in")
    media = ctype or "application/javascript"
    _clerk_js_cache = (body, media, now)
    return body, media


def _origin(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if not url:
        return ""
    if not url.startswith("http"):
        url = "https://" + url
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


def _dev_origins() -> list[str]:
    hosts = ("127.0.0.1", "localhost")
    ports = (5173, 5174, 9320, 8080)
    return [f"http://{host}:{port}" for host in hosts for port in ports]


def _app_origins() -> set[str]:
    origins = {origin for origin in (_origin(PUBLIC_URL), *_dev_origins()) if origin}
    fapi = _frontend_api()
    if fapi:
        origins.add(f"https://{fapi}")
    for host in clerk_browser_hosts():
        origins.add(f"https://{host}")
    return origins


def _azp_allowed(azp: str, request: Request | None, issuer: str) -> bool:
    if not azp:
        return True
    allowed = _app_origins()
    issuer_origin = _origin(issuer)
    if issuer_origin:
        allowed.add(issuer_origin)
    if request is not None:
        req_origin = _origin(request.headers.get("origin") or "")
        if req_origin:
            allowed.add(req_origin)
    if azp in allowed:
        return True
    if azp.startswith("https://") and azp.endswith(".up.railway.app"):
        return True
    if azp.startswith("https://") and (
        azp.endswith(".clerk.accounts.dev") or azp.endswith(".accounts.dev")
    ):
        return True
    parsed = urlparse(azp)
    if parsed.hostname in {"localhost", "127.0.0.1"}:
        return True
    return False


def _issuer_allowed(issuer: str) -> bool:
    if not issuer:
        return False
    expected = _frontend_api()
    if not expected:
        # No publishable key means we cannot name the legitimate issuer.
        # Fail closed: accepting "clerk" or ".accounts.dev" on a substring
        # would let a self-signed token from an attacker's JWKS through.
        return False
    host = urlparse(issuer).hostname or ""
    if host == expected or issuer.rstrip("/") == f"https://{expected}":
        return True
    log.warning("clerk iss mismatch iss=%s expected=%s", host, expected)
    return False


@lru_cache(maxsize=8)
def _jwks_client(issuer: str) -> PyJWKClient:
    return PyJWKClient(f"{issuer.rstrip('/')}/.well-known/jwks.json", cache_keys=True)


def _token_from_request(request: Request, body_token: str = "") -> str:
    raw = (body_token or "").strip()
    if raw:
        return raw
    auth = (request.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return ""


def verify_clerk_session(token: str, request: Request | None = None) -> dict:
    if not CLERK_SECRET_KEY:
        raise HTTPException(503, "Google sign-in is not configured")
    if not token:
        raise HTTPException(401, "Missing Google session")
    try:
        unverified = jwt.decode(token, options={"verify_signature": False, "verify_exp": False})
    except jwt.PyJWTError as exc:
        raise HTTPException(401, "Invalid Google session") from exc
    issuer = str(unverified.get("iss") or "")
    if not _issuer_allowed(issuer):
        raise HTTPException(401, "Invalid Google session")
    try:
        key = _jwks_client(issuer).get_signing_key_from_jwt(token)
        payload = jwt.decode(
            token,
            key.key,
            algorithms=["RS256"],
            options={"verify_aud": False},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(401, "Google session expired. Try again.") from exc
    azp = str(payload.get("azp") or "")
    if isinstance(payload.get("aud"), str) and not azp:
        azp = payload["aud"]
    if azp and not _azp_allowed(azp, request, issuer):
        log.warning("clerk azp rejected: %s", azp)
        raise HTTPException(401, "Invalid Google session")
    if not payload.get("sub"):
        raise HTTPException(401, "Invalid Google session")
    return payload


def clerk_profile(user_id: str) -> tuple[str, str]:
    try:
        res = httpx.get(
            f"https://api.clerk.com/v1/users/{user_id}",
            headers={"Authorization": f"Bearer {CLERK_SECRET_KEY}"},
            timeout=12,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(502, "Could not reach Google sign-in") from exc
    if res.status_code >= 400:
        log.warning("clerk user fetch failed status=%s body=%s", res.status_code, res.text[:300])
        raise HTTPException(401, "Google sign-in failed")
    data = res.json()
    emails = data.get("email_addresses") or []
    primary_id = data.get("primary_email_address_id")
    email = ""
    for row in emails:
        if row.get("id") == primary_id or not email:
            email = (row.get("email_address") or "").strip().lower()
            if row.get("id") == primary_id:
                break
    if not email:
        raise HTTPException(400, "Google did not return an email")
    name = " ".join(part for part in (data.get("first_name"), data.get("last_name")) if part).strip()
    return email, name[:120]
