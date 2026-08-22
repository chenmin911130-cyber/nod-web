from __future__ import annotations

import logging
import sys
from pathlib import Path

from server.settings import DATA_DIR, SENTRY_DSN


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


def backup_now() -> Path | None:
    from datetime import datetime, timezone
    import shutil

    from server.settings import database_url, is_sqlite

    dest_dir = DATA_DIR / "backups"
    dest_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    if is_sqlite():
        src = Path(database_url().replace("sqlite:///", ""))
        if not src.exists():
            return None
        dest = dest_dir / f"nod-{stamp}.db"
        shutil.copy2(src, dest)
        old = sorted(dest_dir.glob("nod-*.db"))
        for extra in old[:-14]:
            extra.unlink(missing_ok=True)
        return dest
    return None
