"""Task #1 — disconnect must not lose a meeting session with content.

A meeting session that already produced HistoryItems but was never saved is
recoverable: on close it is kept around (kept=False, ended_at set, not
discarded) so the next connect can re-offer "Save this session to History?".
"""

from datetime import timedelta
from unittest import mock

import pytest

from server.db import HistoryItem, UsageSession, User, utcnow


@pytest.fixture
def meter_env(meter_db):
    engine, session = meter_db
    with mock.patch("server.meter.db_session", session), mock.patch("server.r2.delete_prefix"):
        yield session


def _add_unsaved_meeting(
    session,
    sid: str,
    *,
    user_id: str = "u1",
    ended_at=None,
    kept=False,
    started_at=None,
    with_item=True,
) -> None:
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
                started_at=started_at or utcnow(),
                ended_at=ended_at,
                kept=kept,
            )
        )
        if with_item:
            db.add(HistoryItem(id=f"{sid}-i", user_id=user_id, session_id=sid, kind="transcript", text="hello"))


def test_close_usage_session_keeps_sessions_count_unchanged(meter_env):
    from server.meter import close_usage_session, usage_snapshot

    _add_unsaved_meeting(meter_env, "s1", ended_at=None, kept=False)
    before = usage_snapshot("u1")["sessions"]
    close_usage_session("s1")
    after = usage_snapshot("u1")["sessions"]
    assert before == after == 0  # kept=False never counts toward the cap
    with meter_env() as db:
        row = db.get(UsageSession, "s1")
        assert row is not None
        assert row.ended_at is not None
        assert row.kept is False
        assert row.discarded_at is None


def test_pending_history_returns_recoverable_session(meter_env):
    from server.meter import list_pending_history

    _add_unsaved_meeting(meter_env, "s1", ended_at=utcnow())
    pending = list_pending_history("u1")
    assert [row["id"] for row in pending] == ["s1"]
    assert pending[0]["mode"] == "meeting"
    assert pending[0]["items"][0]["text"] == "hello"


def test_keep_after_pending_appears_in_list_history(meter_env):
    from server.meter import keep_usage_session, list_history, list_pending_history

    _add_unsaved_meeting(meter_env, "s1", ended_at=utcnow())
    assert list_history("u1") == []  # not saved yet
    keep_usage_session("u1", "s1")
    assert [row["id"] for row in list_history("u1")] == ["s1"]
    assert list_pending_history("u1") == []  # no longer pending


def test_discard_after_pending_removes_it(meter_env):
    from server.meter import discard_usage_session, list_pending_history

    _add_unsaved_meeting(meter_env, "s1", ended_at=utcnow())
    discard_usage_session("u1", "s1")
    assert list_pending_history("u1") == []
    with meter_env() as db:
        row = db.get(UsageSession, "s1")
        assert row.discarded_at is not None


def test_pending_older_than_24h_is_purged(meter_env):
    from server.meter import list_pending_history, purge_expired_history

    _add_unsaved_meeting(meter_env, "old", ended_at=utcnow() - timedelta(hours=25))
    _add_unsaved_meeting(meter_env, "fresh", ended_at=utcnow() - timedelta(hours=1))
    purge_expired_history("u1")
    assert [row["id"] for row in list_pending_history("u1")] == ["fresh"]
    with meter_env() as db:
        assert db.get(UsageSession, "old").discarded_at is not None
        assert db.get(UsageSession, "fresh").discarded_at is None


def test_save_history_with_speaker_roundtrips(meter_env):
    from server.meter import list_history, save_history

    _add_unsaved_meeting(meter_env, "s1", kept=True)
    save_history("u1", "s1", "transcript", "hello alice", speaker="Speaker 1")
    sessions = list_history("u1")
    assert [row["id"] for row in sessions] == ["s1"]
    item = sessions[0]["items"][-1]
    assert item["text"] == "hello alice"
    assert item["speaker"] == "Speaker 1"


def test_list_history_flags_truncation_at_2000(meter_env):
    from server.meter import list_history

    _add_unsaved_meeting(meter_env, "s1", kept=True, with_item=False)
    with meter_env() as db:
        for i in range(2001):
            db.add(HistoryItem(id=f"s1-i{i}", user_id="u1", session_id="s1", kind="transcript", text=f"line {i}"))
    sessions = list_history("u1")
    assert sessions[0]["items_truncated"] is True
    assert len(sessions[0]["items"]) == 2000


# --- Session.close routing -------------------------------------------------


def _session(**overrides):
    from server.app import Session

    sess = Session.__new__(Session)
    sess.user_id = "user-1"
    sess.usage_session_id = "sess-1"
    sess.pipeline = mock.Mock()
    sess.pipeline.usage_session_id = "sess-1"
    sess._workspace = "meeting"
    sess.emit = mock.Mock()
    sess._flush_cloud_archive = mock.Mock()
    sess._stop_listening = mock.Mock()
    sess.pipeline.abort_stream = mock.Mock()
    for key, val in overrides.items():
        setattr(sess, key, val)
    return sess


def test_close_meeting_with_content_does_not_discard():
    sess = _session()
    with (
        mock.patch("server.meter.is_session_kept", return_value=False),
        mock.patch("server.meter.session_has_history", return_value=True),
        mock.patch("server.meter.close_usage_session") as close,
        mock.patch("server.meter.discard_usage_session") as discard,
    ):
        sess.close()
    close.assert_called_once_with("sess-1")
    discard.assert_not_called()
    assert sess.usage_session_id is None
    assert sess.pipeline.usage_session_id is None


def test_close_meeting_without_content_discards():
    sess = _session()
    with (
        mock.patch("server.meter.is_session_kept", return_value=False),
        mock.patch("server.meter.session_has_history", return_value=False),
        mock.patch("server.meter.close_usage_session") as close,
        mock.patch("server.meter.discard_usage_session") as discard,
    ):
        sess.close()
    discard.assert_called_once_with("user-1", "sess-1")
    close.assert_not_called()


def test_close_kept_session_just_closes():
    sess = _session()
    with (
        mock.patch("server.meter.is_session_kept", return_value=True),
        mock.patch("server.meter.close_usage_session") as close,
        mock.patch("server.meter.discard_usage_session") as discard,
    ):
        sess.close()
    close.assert_called_once_with("sess-1")
    discard.assert_not_called()
