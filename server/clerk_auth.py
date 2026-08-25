from __future__ import annotations

import base64
import logging
from functools import lru_cache
from urllib.parse import urlparse

import httpx
import jwt
from fastapi import HTTPException, Request
from jwt import PyJWKClient

from server.settings import CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, PUBLIC_URL

log = logging.getLogger("nod.clerk")


def _frontend_api() -> str:
    """Hostname encoded in the Clerk publishable key, e.g. foo.clerk.accounts.dev."""
    key = CLERK_PUBLISHABLE_KEY
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
    host = urlparse(issuer).hostname or ""
    if expected and (host == expected or issuer.rstrip("/") == f"https://{expected}"):
        return True
    if expected:
        log.warning("clerk iss mismatch iss=%s expected=%s", host, expected)
        return False
    return "clerk" in issuer.lower() or host.endswith(".accounts.dev")


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
