from __future__ import annotations

import logging
import sqlite3
import sys
import time
from pathlib import Path

from server.settings import DATA_DIR, SENTRY_DSN, database_url, is_sqlite

BACKUP_KEEP_DAYS = 30
BACKUP_MAX_FILES = 120


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
        force=True,
    )
    if SENTRY_DSN:
        try:
            import sentry_sdk
            from sentry_sdk.integrations.fastapi import FastApiIntegration
            from sentry_sdk.integrations.starlette import StarletteIntegration

            sentry_sdk.init(dsn=SENTRY_DSN, integrations=[StarletteIntegration(), FastApiIntegration()], traces_sample_rate=0.05)
            logging.getLogger("nod").info("sentry enabled")
        except Exception:
            logging.getLogger("nod").exception("sentry init failed")


def _sqlite_path() -> Path | None:
    url = database_url()
    if not url.startswith("sqlite:///"):
        return None
    src = Path(url[len("sqlite:///"):])
    return src if src.exists() else None


def prune_backups(dest_dir: Path) -> None:
    cutoff = time.time() - BACKUP_KEEP_DAYS * 86400
    for path in dest_dir.glob("nod-*.db"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError:
            continue
    kept = sorted(dest_dir.glob("nod-*.db"), key=lambda p: p.stat().st_mtime)
    for extra in kept[:-BACKUP_MAX_FILES]:
        extra.unlink(missing_ok=True)


def backup_now() -> Path | None:
    from datetime import datetime, timezone

    dest_dir = DATA_DIR / "backups"
    dest_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    if not is_sqlite():
        return None
    src = _sqlite_path()
    if src is None:
        return None
    dest = dest_dir / f"nod-{stamp}.db"
    src_conn = sqlite3.connect(str(src), timeout=30)
    try:
        dest_conn = sqlite3.connect(str(dest), timeout=30)
        try:
            src_conn.backup(dest_conn)
        finally:
            dest_conn.close()
    finally:
        src_conn.close()
    prune_backups(dest_dir)
    return dest
