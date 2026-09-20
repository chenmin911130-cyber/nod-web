from __future__ import annotations

import hmac
import secrets
from datetime import datetime, timedelta, timezone

from server.db import EmailOtp, db_session, utcnow
from server.security import hash_token, new_id

OTP_TTL = timedelta(minutes=10)
OTP_MAX_ATTEMPTS = 5
OTP_OK = "Check your email for a 6-digit code. It expires in 10 minutes."


def new_otp_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _row_reusable(row: EmailOtp, now: datetime) -> bool:
    expires = _aware(row.expires_at)
    if expires is None or expires < now:
        return False
    if int(row.attempts or 0) > OTP_MAX_ATTEMPTS:
        return False
    plain = (getattr(row, "code_plain", None) or "").strip()
    return len(plain) == 6


def reusable_otp_code(email: str) -> str | None:
    now = utcnow()
    with db_session() as db:
        row = (
            db.query(EmailOtp)
            .filter(EmailOtp.email == email, EmailOtp.used_at.is_(None))
            .order_by(EmailOtp.created_at.desc())
            .first()
        )
        if row is None or not _row_reusable(row, now):
            return None
        return (row.code_plain or "").strip()


def persist_otp(email: str, code: str, intent: str, name: str = "", consent: bool = False) -> None:
    now = utcnow()
    with db_session() as db:
        for row in (
            db.query(EmailOtp)
            .filter(EmailOtp.email == email, EmailOtp.used_at.is_(None))
            .all()
        ):
            row.used_at = now
        db.add(
            EmailOtp(
                id=new_id(),
                email=email,
                code_hash=hash_token(code),
                code_plain=code,
                intent=intent if intent in {"login", "signup"} else "login",
                name=(name or "").strip()[:120],
                consent=bool(consent),
                expires_at=now + OTP_TTL,
            )
        )


def issue_otp(email: str, intent: str, name: str = "", consent: bool = False) -> str:
    """Create or reuse an OTP row and return the plaintext code (tests / local dev)."""
    existing = reusable_otp_code(email)
    if existing:
        return existing
    code = new_otp_code()
    persist_otp(email, code, intent, name, consent)
    return code


def consume_otp(email: str, code: str) -> EmailOtp | None:
    raw = "".join(ch for ch in (code or "") if ch.isdigit())
    if len(raw) != 6:
        return None
    offered = hash_token(raw)
    now = utcnow()
    with db_session() as db:
        row = (
            db.query(EmailOtp)
            .filter(EmailOtp.email == email, EmailOtp.used_at.is_(None))
            .order_by(EmailOtp.created_at.desc())
            .first()
        )
        expires = _aware(row.expires_at) if row is not None else None
        if row is None or expires is None or expires < now:
            return None
        row.attempts = int(row.attempts or 0) + 1
        if row.attempts > OTP_MAX_ATTEMPTS:
            row.used_at = now
            return None
        if not hmac.compare_digest(row.code_hash, offered):
            return None
        row.used_at = now
        row.code_plain = ""
        db.flush()
        db.expunge(row)
        return row
