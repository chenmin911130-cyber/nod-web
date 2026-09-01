"""Shared pytest fixtures for nod.

The whole point is isolation: tests must NOT touch the real ``data/nod.db``
(or any deployment database). ``server/db.py`` creates its engine at import
time from ``DATA_DIR``, so we point ``DATA_DIR`` at a throwaway directory
BEFORE any server module is imported. Everything below then builds on an
isolated SQLite engine — mirroring the per-test pattern that
``tests/test_keep_usage_null_keys.py`` already uses, but exposed once here.
"""

import os
import tempfile
from contextlib import contextmanager
from pathlib import Path

# --- Isolate the real database before any `server.*` import runs. ----------
# server/db.py does `engine = create_engine(database_url(), ...)` at module
# import time, and database_url() reads DATA_DIR. Pointing it at a temp dir
# here means importing server.db in a test never opens the production DB.
_TEST_DATA_DIR = tempfile.mkdtemp(prefix="nod-test-data-")
os.environ["DATA_DIR"] = _TEST_DATA_DIR

# Never let a test accidentally spend real money / hit real providers.
os.environ.setdefault("ASSEMBLYAI_API_KEY", "test-stt")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-llm")
os.environ.setdefault("OPENROUTER_API_KEY", "test-llm")
# Force quota checks on so metering tests exercise the cap logic.
os.environ.pop("QUOTA_DISABLED", None)
# NOTE: DO NOT set AUTH_DISABLED here. Several hardening tests rely on
# anonymous-origin rejection (WS auth_required, empty admin token, host lock);
# disabling auth globally would make those assertions silently pass vacuously.
os.environ.setdefault("SENTRY_DSN", "")       # no telemetry from tests

import pytest  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from server.db import Base  # noqa: E402

TEST_DATA_DIR = Path(_TEST_DATA_DIR)


def make_isolated_engine():
    """A brand-new SQLite engine in a temp dir with all tables created."""
    tmp = tempfile.mkdtemp(prefix="nod-test-engine-")
    engine = create_engine(f"sqlite:///{Path(tmp).as_posix()}/nod.db")
    Base.metadata.create_all(engine)
    return engine


@contextmanager
def isolated_sessionmaker(engine):
    """A context-manager db_session bound to a given engine.

    Mirrors server.db.db_session semantics but against an isolated engine.
    """
    Local = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)

    @contextmanager
    def session():
        s = Local()
        try:
            yield s
            s.commit()
        except Exception:
            s.rollback()
            raise
        finally:
            s.close()

    try:
        yield session
    finally:
        engine.dispose()


@pytest.fixture
def meter_db():
    """Isolated engine + a db_session the meter functions can be pointed at.

    Usage:
        engine, session = meter_db()
        with mock.patch("server.meter.db_session", session):
            from server.meter import consume_stt
            ...
    """
    engine = make_isolated_engine()
    with isolated_sessionmaker(engine) as session:
        yield engine, session
