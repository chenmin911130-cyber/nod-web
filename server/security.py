from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Cookie, Header, HTTPException, Request

from server.db import User, db_session
from server.settings import AUTH_DISABLED, AUTH_SECRET, COOKIE_NAME, GUEST_TOKEN_DAYS, TOKEN_DAYS

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(password: str, stored: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), stored.encode("utf-8"))
    except ValueError:
        return False


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_id() -> str:
    return secrets.token_hex(16)


def issue_jwt(user_id: str, email: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "email": email,
        "typ": "user",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=TOKEN_DAYS)).timestamp()),
    }
    return jwt.encode(payload, AUTH_SECRET, algorithm="HS256")


def issue_guest_jwt(guest_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": guest_id,
        "typ": "guest",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=GUEST_TOKEN_DAYS)).timestamp()),
    }
    return jwt.encode(payload, AUTH_SECRET, algorithm="HS256")


def decode_jwt(token: str) -> dict:
    return jwt.decode(token, AUTH_SECRET, algorithms=["HS256"])


def valid_email(email: str) -> bool:
    return bool(EMAIL_RE.match((email or "").strip().lower()))


def cookie_kwargs(https: bool) -> dict:
    return {
        "key": COOKIE_NAME,
        "httponly": True,
        "samesite": "lax",
        "secure": https,
        "max_age": TOKEN_DAYS * 86400,
        "path": "/",
    }


def read_token(request: Request, cookie: str | None = None, authorization: str | None = None) -> str:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization.split(" ", 1)[1].strip()
    if cookie:
        return cookie
    return (request.cookies.get(COOKIE_NAME) or "").strip()


def guest_from_token(token: str) -> str | None:
    if not token:
        return None
    try:
        payload = decode_jwt(token)
    except jwt.PyJWTError:
        return None
    if payload.get("typ") != "guest":
        return None
    guest_id = payload.get("sub")
    return str(guest_id) if guest_id else None


def user_from_token(token: str) -> User | None:
    if not token:
        return None
    try:
        payload = decode_jwt(token)
    except jwt.PyJWTError:
        return None
    if payload.get("typ") == "guest":
        return None
    uid = payload.get("sub")
    if not uid:
        return None
    with db_session() as db:
        user = db.get(User, uid)
        if user is None or user.deleted_at is not None:
            return None
        db.expunge(user)
        return user


def current_user(
    request: Request,
    nod_session: str | None = Cookie(default=None, alias=COOKIE_NAME),
    authorization: str | None = Header(default=None),
) -> User:
    token = read_token(request, nod_session, authorization)
    user = user_from_token(token)
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in")
    return user


def optional_user(
    request: Request,
    nod_session: str | None = Cookie(default=None, alias=COOKIE_NAME),
    authorization: str | None = Header(default=None),
) -> User | None:
    token = read_token(request, nod_session, authorization)
    return user_from_token(token)


def require_admin(x_admin_token: str | None = Header(default=None)) -> None:
    from server.settings import ADMIN_TOKEN

    if not ADMIN_TOKEN or not x_admin_token or not hmac.compare_digest(x_admin_token, ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="Admin token required")


def auth_bypass() -> bool:
    return AUTH_DISABLED
