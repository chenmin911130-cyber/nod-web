from __future__ import annotations

import base64
import logging
import os
import re
import sys
import time
from functools import lru_cache
from urllib.parse import urlparse

import httpx
import jwt
from fastapi import HTTPException, Request
from jwt import PyJWKClient
from starlette.responses import Response as StarletteResponse

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


CLERK_JS_DIST = "/npm/@clerk/clerk-js@5/dist"
CLERK_JS_ENTRY = "clerk.browser.js"
CLERK_JS_PATH = f"{CLERK_JS_DIST}/{CLERK_JS_ENTRY}"
CLERK_JS_DIR = "/clerk-js"
CLERK_JS_MIN_BYTES = 10_000
CLERK_JS_TTL_S = 3600
# webpack names: framework_clerk.browser_<6hex>_<semver>.js
_CLERK_JS_FILE_RE = re.compile(
    r"^(?:clerk\.browser\.js|[a-z0-9-]+_clerk\.browser_[a-f0-9]{6,16}_\d+\.\d+\.\d+\.js)$"
)
_clerk_js_assets: dict[str, tuple[bytes, str, float]] = {}


def reset_clerk_js_cache() -> None:
    _clerk_js_assets.clear()


def clerk_js_filename_allowed(name: str) -> bool:
    return bool(name) and "/" not in name and ".." not in name and bool(_CLERK_JS_FILE_RE.fullmatch(name))


def clerk_js_source_url(name: str = CLERK_JS_ENTRY) -> str:
    """Absolute URL of a clerk-js file on this instance's Frontend API host."""
    if not clerk_js_filename_allowed(name):
        return ""
    host = _frontend_api()
    if not host:
        return ""
    return f"https://{host}{CLERK_JS_DIST}/{name}"


def load_clerk_js_asset(name: str) -> tuple[bytes, str]:
    """Fetch one clerk-js file from the Frontend API and cache it.

    The entry script is served from this origin so script-src 'self' can
    run it. Webpack then loads framework/vendors/ui-common chunks from the
    same directory as the entry. Serving only clerk.browser.js left those
    chunks as 404s on nodpilot.com.
    """
    if not clerk_js_filename_allowed(name):
        raise HTTPException(status_code=404, detail="Not found")
    now = time.monotonic()
    cached = _clerk_js_assets.get(name)
    if cached and now - cached[2] < CLERK_JS_TTL_S:
        return cached[0], cached[1]
    url = clerk_js_source_url(name)
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
        log.warning("clerk-js fetch failed file=%s err=%s", name, ex)
        raise HTTPException(status_code=502, detail="Could not load Google sign-in") from ex
    body = res.content or b""
    ctype = (res.headers.get("content-type") or "application/javascript").split(";", 1)[0].strip()
    min_bytes = CLERK_JS_MIN_BYTES if name == CLERK_JS_ENTRY else 32
    if res.status_code != 200 or len(body) < min_bytes or body.lstrip()[:1] == b"<" or "html" in ctype.lower():
        log.warning("clerk-js rejected file=%s status=%s type=%s bytes=%s", name, res.status_code, ctype, len(body))
        raise HTTPException(status_code=502, detail="Could not load Google sign-in")
    media = ctype or "application/javascript"
    _clerk_js_assets[name] = (body, media, now)
    return body, media


def load_clerk_browser_js() -> tuple[bytes, str]:
    return load_clerk_js_asset(CLERK_JS_ENTRY)


CLERK_PROXY_PATH = "/__clerk"
_HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        "host",
        "content-length",
        # nodpilot.com is itself on Cloudflare. Forwarding these to
        # clerk.nodpilot.com (also Cloudflare) produces a 403 challenge and
        # breaks every Clerk fetch that went through /__clerk.
        "cdn-loop",
        "cf-ray",
        "cf-visitor",
        "cf-ew-via",
        "cf-worker",
        "cf-warp-tag-id",
        "true-client-ip",
    }
)


def clerk_proxy_public_url() -> str:
    """Absolute Frontend API proxy URL Clerk JS and the Dashboard expect."""
    public = (os.environ.get("PUBLIC_URL") or PUBLIC_URL or "").strip()
    if public and "://" not in public:
        public = "https://" + public
    host = (urlparse(public).hostname or "").lower()
    if not host or host in {"127.0.0.1", "localhost"}:
        fapi = _frontend_api()
        if fapi.startswith("clerk.") and fapi.count(".") >= 2:
            public = "https://" + fapi.split(".", 1)[1]
        else:
            return ""
    return public.rstrip("/") + CLERK_PROXY_PATH


def clerk_fapi_target(path: str) -> str:
    raw = (path or "").lstrip("/")
    if ".." in raw or "://" in raw:
        raise HTTPException(status_code=400, detail="Invalid path")
    host = _frontend_api()
    if not host:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured")
    return f"https://{host}/{raw}" if raw else f"https://{host}/"


def clerk_client_ip(headers: dict[str, str], peer: str = "") -> str:
    # Prefer Cloudflare's connecting IP. Do not trust the leftmost
    # X-Forwarded-For: the client can set it before Cloudflare appends.
    lowered = {k.lower(): v for k, v in headers.items()}
    cf = (lowered.get("cf-connecting-ip") or "").strip()
    if cf:
        return cf.split(",", 1)[0].strip()[:64]
    return (peer or "0.0.0.0")[:64]


def rewrite_clerk_location(location: str, fapi_host: str, proxy_public: str) -> str:
    if not location or not fapi_host or not proxy_public:
        return location
    prefixes = [
        f"https://{fapi_host}",
        f"http://{fapi_host}",
        "https://frontend-api.clerk.dev",
        "https://frontend-api.clerk.services",
    ]
    for prefix in prefixes:
        if location == prefix or location.startswith(prefix + "/") or location.startswith(prefix + "?"):
            return proxy_public.rstrip("/") + location[len(prefix) :]
    return location


def forward_clerk_fapi(
    method: str,
    path: str,
    query: str,
    body: bytes,
    incoming: dict[str, str],
    peer: str,
) -> StarletteResponse:
    secret = (os.environ.get("CLERK_SECRET_KEY") or CLERK_SECRET_KEY or "").strip()
    proxy_public = clerk_proxy_public_url()
    if not secret or not proxy_public:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured")
    target = clerk_fapi_target(path)
    if query:
        target = f"{target}?{query}"
    fapi_host = _frontend_api()
    out: dict[str, str] = {}
    for key, value in incoming.items():
        low = key.lower()
        if low in _HOP_HEADERS or low in {"clerk-secret-key", "clerk-proxy-url"}:
            continue
        out[key] = value
    out["Host"] = fapi_host
    out["Clerk-Proxy-Url"] = proxy_public
    out["Clerk-Secret-Key"] = secret
    out["X-Forwarded-For"] = clerk_client_ip(incoming, peer)
    try:
        res = httpx.request(
            method.upper(),
            target,
            content=body or None,
            headers=out,
            timeout=30.0,
            follow_redirects=False,
        )
    except httpx.HTTPError as ex:
        log.warning("clerk fapi proxy failed err=%s", ex)
        raise HTTPException(status_code=502, detail="Could not reach Google sign-in") from ex
    excluded = {"transfer-encoding", "connection", "keep-alive", "content-encoding", "content-length"}
    response = StarletteResponse(content=res.content, status_code=res.status_code)
    for key, value in res.headers.multi_items():
        if key.lower() in excluded:
            continue
        if key.lower() == "location":
            value = rewrite_clerk_location(value, fapi_host, proxy_public)
        if key.lower() == "set-cookie":
            response.headers.append("set-cookie", value)
        else:
            response.headers[key] = value
    return response


def clerk_proxy_enable_allowed() -> bool:
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return False
    if "pytest" in sys.modules:
        return False
    joined = " ".join(sys.argv).lower()
    return "unittest" not in joined and "pytest" not in joined


def _clerk_domain_row(rows: list, wanted: str) -> dict | None:
    chosen = None
    for row in rows:
        if not isinstance(row, dict) or not row.get("id"):
            continue
        hay = " ".join(str(row.get(k) or "") for k in ("name", "frontend_api_url", "accounts_url"))
        if wanted and wanted in hay:
            return row
        if "nodpilot.com" in hay.lower() and chosen is None:
            chosen = row
    if chosen is None and len(rows) == 1 and isinstance(rows[0], dict):
        return rows[0]
    return chosen


def enable_clerk_fapi_proxy() -> None:
    """Clear a /__clerk Dashboard proxy so browsers use the clerk.* CNAME.

    #250 set proxy_url to https://nodpilot.com/__clerk and pointed Clerk JS
    at that path. Production /__clerk returns Cloudflare 403 (the app sits
    on Cloudflare and was forwarding cdn-loop to Clerk's Cloudflare), so
    every Google sign-in fetch failed. The publishable key already encodes
    clerk.nodpilot.com, which serves the Frontend API directly.
    """
    if not clerk_proxy_enable_allowed():
        return
    secret = (os.environ.get("CLERK_SECRET_KEY") or CLERK_SECRET_KEY or "").strip()
    if not secret:
        return
    auth = {"Authorization": f"Bearer {secret}", "Content-Type": "application/json"}
    try:
        listed = httpx.get("https://api.clerk.com/v1/domains", headers=auth, timeout=15.0)
        listed.raise_for_status()
        payload = listed.json()
    except Exception as ex:
        log.warning("clerk domains list failed err=%s", ex)
        return
    rows = payload if isinstance(payload, list) else (payload.get("data") or payload.get("domains") or [])
    if not isinstance(rows, list):
        return
    chosen = _clerk_domain_row(rows, _frontend_api())
    if not chosen:
        log.warning("clerk proxy_url skipped: no matching domain")
        return
    current = str(chosen.get("proxy_url") or "").rstrip("/")
    if not current:
        return
    ours = clerk_proxy_public_url().rstrip("/")
    if current != ours and not current.endswith("/__clerk"):
        log.warning("clerk proxy_url left untouched: %s", current)
        return
    domain_id = chosen["id"]
    try:
        patched = httpx.patch(
            f"https://api.clerk.com/v1/domains/{domain_id}",
            headers=auth,
            json={"proxy_url": None},
            timeout=20.0,
        )
        if patched.status_code >= 400:
            log.warning("clerk proxy_url clear status=%s body=%s", patched.status_code, patched.text[:300])
            return
        log.info("clerk proxy_url cleared domain=%s", domain_id)
    except Exception as ex:
        log.warning("clerk proxy_url clear failed err=%s", ex)


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
