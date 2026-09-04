from __future__ import annotations

import os
import secrets
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            raw = line.strip()
            if not raw or raw.startswith("#") or "=" not in raw:
                continue
            key, value = raw.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        pass


_load_dotenv()
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
MAIL_FROM = (os.environ.get("MAIL_FROM") or "Nodpilot <noreply@nodpilot.com>").strip()
CONTACT_EMAIL = (os.environ.get("CONTACT_EMAIL") or "hello@nodpilot.com").strip()
CF_ACCOUNT_ID = (os.environ.get("CF_ACCOUNT_ID") or os.environ.get("R2_ACCOUNT_ID") or "").strip()
CF_API_TOKEN = (os.environ.get("CF_API_TOKEN") or os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()

SENTRY_DSN = (os.environ.get("SENTRY_DSN") or "").strip()
R2_ACCOUNT_ID = (os.environ.get("R2_ACCOUNT_ID") or "").strip()
R2_ACCESS_KEY_ID = (os.environ.get("R2_ACCESS_KEY_ID") or "").strip()
R2_SECRET_ACCESS_KEY = (os.environ.get("R2_SECRET_ACCESS_KEY") or "").strip()
R2_BUCKET = (os.environ.get("R2_BUCKET") or "").strip()
# No fallback: an unset ADMIN_TOKEN disables the admin surface rather than
# opening it with a guessable default.
ADMIN_TOKEN = (os.environ.get("ADMIN_TOKEN") or "").strip()
ADMIN_COOKIE = "nod_admin"


def _www_siblings(hosts: set[str]) -> set[str]:
    """Pair apex and www so PUBLIC_URL=https://nodpilot.com also serves www."""
    extra: set[str] = set()
    for host in hosts:
        if host.startswith("www.") and host.count(".") >= 2:
            extra.add(host[4:])
        elif host.count(".") == 1:
            extra.add(f"www.{host}")
    return hosts | extra


def _allowed_hosts(public_url: str | None = None) -> set[str]:
    """Hosts the app will answer to, for the HostLock middleware.

    Built from ALLOWED_HOSTS (comma-separated, optional) plus the host of
    PUBLIC_URL when it is a real deployment domain. Apex and www are paired
    so a single PUBLIC_URL does not 403 the other. When the result is
    non-empty the lock is ON: any request whose Host is not listed (e.g. a
    direct hit on the *.up.railway.app domain) is rejected at the edge of
    the app, so DDoS / brute-force traffic cannot bypass Cloudflare.
    """
    hosts: set[str] = set()
    raw = os.environ.get("ALLOWED_HOSTS", "").strip()
    for h in raw.split(","):
        h = h.strip().lower()
        if h and h not in ("127.0.0.1", "localhost"):
            hosts.add(h)
    pu = PUBLIC_URL if public_url is None else public_url
    if pu:
        try:
            pu_host = (urlparse(pu).hostname or "").strip().lower()
        except ValueError:
            pu_host = ""
        if pu_host and pu_host not in ("127.0.0.1", "localhost"):
            hosts.add(pu_host)
    return _www_siblings(hosts)


ALLOWED_HOSTS = _allowed_hosts()
# Auto-enabled: a non-local PUBLIC_URL (production) turns the lock on;
# local development keeps it off so 127.0.0.1 / testserver flows are untouched.
HOST_LOCK = bool(ALLOWED_HOSTS)

STT_USD_PER_MINUTE = float(os.environ.get("STT_USD_PER_MINUTE") or "0.01")
LLM_USD_PER_1K_IN = float(os.environ.get("LLM_USD_PER_1K_IN") or "0.00014")
LLM_USD_PER_1K_OUT = float(os.environ.get("LLM_USD_PER_1K_OUT") or "0.00028")
GLOBAL_DAILY_BUDGET_USD = float(os.environ.get("GLOBAL_DAILY_BUDGET_USD") or "25")
# Off unless QUOTA_DISABLED=1. Daily STT is the spend control (2 hours).
QUOTA_DISABLED = os.environ.get("QUOTA_DISABLED", "0").strip().lower() in ("1", "true", "yes")
DAILY_STT_SECONDS = max(60, int(float(os.environ.get("DAILY_STT_SECONDS") or str(2 * 3600))))
MAX_AUDIO_HOURS = max(0.5, float(os.environ.get("MAX_AUDIO_HOURS") or "8"))
HISTORY_RETENTION_DAYS = max(1, int(float(os.environ.get("HISTORY_RETENTION_DAYS") or "30")))
LISTEN_IDLE_SECONDS = max(60, int(float(os.environ.get("LISTEN_IDLE_SECONDS") or str(15 * 60))))
LISTEN_MAX_SECONDS = max(LISTEN_IDLE_SECONDS, int(float(os.environ.get("LISTEN_MAX_SECONDS") or str(2 * 3600))))
# A live AssemblyAI socket with ZERO bytes arriving must be torn down quickly.
# Such a socket is ALWAYS a dead/never-started client mic, never a quiet room —
# a quiet room still streams silence frames, so it keeps _last_pcm_at fresh and
# never trips this. 15-min idle stays the fallback for the quiet-room case.
LISTEN_ZERO_PCM_SECONDS = max(10, int(float(os.environ.get("LISTEN_ZERO_PCM_SECONDS") or "25")))

PLANS: dict[str, dict] = {
    "free": {
        "id": "free",
        "name": "Trial",
        "stt_seconds": 2 * 3600 * 31,
        "llm_tokens": 100_000,
        "sessions": 60,
        "daily_cost_usd": 2.0,
        "price_cents": 0,
        "interval": None,
        "blurb": "Free trial. Two hours of live transcription each day.",
    },
    "pro": {
        "id": "pro",
        "name": "Pro",
        "stt_seconds": 2 * 3600 * 31,
        "llm_tokens": 2_000_000,
        "sessions": 1000,
        "daily_cost_usd": 12.0,
        "price_cents": 1200,
        "interval": "month",
        "blurb": "Two hours of live transcription each day and a higher generation cap.",
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
