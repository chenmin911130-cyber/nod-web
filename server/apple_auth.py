from __future__ import annotations

import hashlib
import logging
from functools import lru_cache

import jwt
from fastapi import HTTPException
from jwt import PyJWKClient

from server.settings import APPLE_BUNDLE_ID, APPLE_JWKS_URL

log = logging.getLogger("nod.apple")

APPLE_ISSUER = "https://appleid.apple.com"


@lru_cache(maxsize=1)
def _apple_jwks_client() -> PyJWKClient:
    return PyJWKClient(APPLE_JWKS_URL, cache_keys=True)


def _nonce_hash(raw_nonce: str) -> str:
    return hashlib.sha256((raw_nonce or "").encode("utf-8")).hexdigest()


def apple_name_from_parts(given: str = "", family: str = "") -> str:
    parts = [p.strip() for p in (given, family) if (p or "").strip()]
    return " ".join(parts)[:120]


def verify_apple_identity_token(token: str, nonce: str) -> dict:
    raw = (token or "").strip()
    if not raw or not (nonce or "").strip():
        raise HTTPException(401, "Apple sign-in failed")
    try:
        key = _apple_jwks_client().get_signing_key_from_jwt(raw)
        payload = jwt.decode(
            raw,
            key.key,
            algorithms=["RS256"],
            audience=APPLE_BUNDLE_ID,
            issuer=APPLE_ISSUER,
        )
    except jwt.PyJWTError:
        log.info("apple jwt verify failed")
        raise HTTPException(401, "Apple sign-in failed") from None
    except Exception:
        log.exception("apple jwt verify error")
        raise HTTPException(401, "Apple sign-in failed") from None
    if payload.get("nonce") != _nonce_hash(nonce):
        raise HTTPException(401, "Apple sign-in failed")
    return payload


def apple_email_verified(payload: dict) -> bool:
    flag = payload.get("email_verified")
    return flag is True or flag == "true" or flag == 1 or flag == "1"
