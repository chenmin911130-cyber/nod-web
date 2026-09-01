from datetime import timedelta
from unittest import mock

import pytest

from server.db import UsageSession, User, utcnow


@pytest.fixture
def meter_env(meter_db):
    engine, session = meter_db
    with mock.patch("server.meter.db_session", session), mock.patch("server.r2.delete_prefix"):
        yield session


def _add_kept_session(session, sid: str, *, started_at, user_id: str = "u1") -> None:
    with session() as db:
        if db.get(User, user_id) is None:
            db.add(User(id=user_id, email=f"{user_id}@test.local"))
        db.add(
            UsageSession(
                id=sid,
                user_id=user_id,
                mode="meeting",
                scene="meeting",
                title=sid,
                started_at=started_at,
                kept=True,
            )
        )


def test_list_history_drops_sessions_older_than_30_days(meter_env):
    from server.meter import list_history

    now = utcnow()
    _add_kept_session(meter_env, "old", started_at=now - timedelta(days=31))
    _add_kept_session(meter_env, "fresh", started_at=now - timedelta(days=1))

    sessions = list_history("u1")
    assert [row["id"] for row in sessions] == ["fresh"]
    with meter_env() as db:
        assert db.get(UsageSession, "old") is None
        assert db.get(UsageSession, "fresh") is not None


def test_list_history_keeps_session_from_day_29(meter_env):
    from server.meter import list_history

    now = utcnow()
    _add_kept_session(meter_env, "edge", started_at=now - timedelta(days=29))

    sessions = list_history("u1")
    assert [row["id"] for row in sessions] == ["edge"]
    with meter_env() as db:
        assert db.get(UsageSession, "edge") is not None
