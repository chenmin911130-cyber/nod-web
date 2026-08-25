from __future__ import annotations

import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR") or (ROOT / "data"))
PUBLIC_URL = (os.environ.get("PUBLIC_URL") or os.environ.get("RAILWAY_PUBLIC_DOMAIN") or "").strip()
if PUBLIC_URL and not PUBLIC_URL.startswith("http"):
    PUBLIC_URL = "https://" + PUBLIC_URL
if not PUBLIC_URL:
    PUBLIC_URL = "http://127.0.0.1:9320"

def _load_auth_secret() -> str:
    env = (os.environ.get("AUTH_SECRET") or "").strip()
    if env:
        return env
    # No env var: persist a generated secret next to the database so JWTs
    # survive restarts (on Railway DATA_DIR is the mounted /data volume).
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / "auth_secret.key"
    try:
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    except OSError:
        pass
    secret = secrets.token_hex(32)
    path.write_text(secret, encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return secret


AUTH_SECRET = _load_auth_secret()
AUTH_DISABLED = os.environ.get("AUTH_DISABLED", "").strip().lower() in ("1", "true", "yes")
COOKIE_NAME = "nod_session"
TOKEN_DAYS = 14

CLERK_PUBLISHABLE_KEY = (os.environ.get("CLERK_PUBLISHABLE_KEY") or "").strip()
CLERK_SECRET_KEY = (os.environ.get("CLERK_SECRET_KEY") or "").strip()

STRIPE_SECRET_KEY = (os.environ.get("STRIPE_SECRET_KEY") or "").strip()
STRIPE_WEBHOOK_SECRET = (os.environ.get("STRIPE_WEBHOOK_SECRET") or "").strip()
STRIPE_PRICE_PRO = (os.environ.get("STRIPE_PRICE_PRO") or "").strip()

RESEND_API_KEY = (os.environ.get("RESEND_API_KEY") or "").strip()
SMTP_HOST = (os.environ.get("SMTP_HOST") or "").strip()
SMTP_PORT = int(os.environ.get("SMTP_PORT") or "587")
SMTP_USER = (os.environ.get("SMTP_USER") or "").strip()
SMTP_PASSWORD = (os.environ.get("SMTP_PASSWORD") or "").strip()
MAIL_FROM = (os.environ.get("MAIL_FROM") or "Nod <noreply@localhost>").strip()

SENTRY_DSN = (os.environ.get("SENTRY_DSN") or "").strip()
R2_ACCOUNT_ID = (os.environ.get("R2_ACCOUNT_ID") or "").strip()
R2_ACCESS_KEY_ID = (os.environ.get("R2_ACCESS_KEY_ID") or "").strip()
R2_SECRET_ACCESS_KEY = (os.environ.get("R2_SECRET_ACCESS_KEY") or "").strip()
R2_BUCKET = (os.environ.get("R2_BUCKET") or "").strip()
ADMIN_TOKEN = (os.environ.get("ADMIN_TOKEN") or "leonardo").strip()
ADMIN_COOKIE = "nod_admin"

STT_USD_PER_MINUTE = float(os.environ.get("STT_USD_PER_MINUTE") or "0.01")
LLM_USD_PER_1K_IN = float(os.environ.get("LLM_USD_PER_1K_IN") or "0.00014")
LLM_USD_PER_1K_OUT = float(os.environ.get("LLM_USD_PER_1K_OUT") or "0.00028")
GLOBAL_DAILY_BUDGET_USD = float(os.environ.get("GLOBAL_DAILY_BUDGET_USD") or "25")
# Test phase: limits off unless QUOTA_DISABLED=0
QUOTA_DISABLED = os.environ.get("QUOTA_DISABLED", "1").strip().lower() in ("1", "true", "yes")

PLANS: dict[str, dict] = {
    "free": {
        "id": "free",
        "name": "Trial",
        "stt_seconds": 20 * 60,
        "llm_tokens": 100_000,
        "sessions": 20,
        "daily_cost_usd": 1.5,
        "price_cents": 0,
        "interval": None,
        "blurb": "Free trial. Enough for a real interview, meeting, or caption session.",
    },
    "pro": {
        "id": "pro",
        "name": "Pro",
        "stt_seconds": 8 * 3600,
        "llm_tokens": 2_000_000,
        "sessions": 1000,
        "daily_cost_usd": 12.0,
        "price_cents": 1200,
        "interval": "month",
        "blurb": "Eight hours of live transcription and a higher generation cap each month.",
    },
}


def database_url() -> str:
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if url:
        if url.startswith("postgres://"):
            url = "postgresql://" + url[len("postgres://") :]
        return url
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{(DATA_DIR / 'nod.db').as_posix()}"


def is_sqlite() -> bool:
    return database_url().startswith("sqlite")
