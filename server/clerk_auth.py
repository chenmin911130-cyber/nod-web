from __future__ import annotations

import logging
from functools import lru_cache

import httpx
import jwt
from fastapi import HTTPException, Request
from jwt import PyJWKClient

from server.settings import CLERK_SECRET_KEY, PUBLIC_URL

log = logging.getLogger("nod.clerk")

AUTHORIZED_PARTIES = [
    origin
    for origin in (
        PUBLIC_URL.rstrip("/"),
        "http://127.0.0.1:5174",
        "http://localhost:5174",
        "http://127.0.0.1:9320",
        "http://localhost:9320",
    )
    if origin
]


def _azp_allowed(azp: str) -> bool:
    if azp in AUTHORIZED_PARTIES:
        return True
    return azp.startswith("https://") and azp.endswith(".up.railway.app")


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


def verify_clerk_session(token: str) -> dict:
    if not CLERK_SECRET_KEY:
        raise HTTPException(503, "Google sign-in is not configured")
    if not token:
        raise HTTPException(401, "Missing Google session")
    try:
        unverified = jwt.decode(token, options={"verify_signature": False, "verify_exp": False})
    except jwt.PyJWTError as exc:
        raise HTTPException(401, "Invalid Google session") from exc
    issuer = str(unverified.get("iss") or "")
    if not issuer or "clerk" not in issuer.lower():
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
    azp = str(payload.get("azp") or payload.get("aud") or "")
    if azp and not _azp_allowed(azp):
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
