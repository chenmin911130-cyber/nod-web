"""Task #1 — disconnect must not lose a meeting session with content.

A meeting session that already produced HistoryItems but was never saved is
recoverable: on close it is kept around (kept=False, ended_at set, not
discarded) so the next connect can re-offer "Save this session to History?".
"""

import collections
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
    mode: str = "meeting",
    scene: str | None = None,
) -> None:
    with session() as db:
        if db.get(User, user_id) is None:
            db.add(User(id=user_id, email=f"{user_id}@test.local"))
        db.add(
            UsageSession(
                id=sid,
                user_id=user_id,
                mode=mode,
                scene=scene if scene is not None else mode,
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


def test_pending_excludes_translate(meter_env):
    """#196: a Translate session has no Save concept, so it is never a pending target."""
    from server.meter import list_pending_history

    _add_unsaved_meeting(meter_env, "tr", mode="translate", ended_at=utcnow())
    assert list_pending_history("u1") == []


def test_newer_translate_does_not_mask_older_meeting(meter_env):
    """The mode filter must run inside the query, before limit(1) — not after it."""
    from server.meter import list_pending_history

    now = utcnow()
    _add_unsaved_meeting(meter_env, "tr", mode="translate", started_at=now, ended_at=now)
    _add_unsaved_meeting(
        meter_env,
        "m",
        mode="meeting",
        started_at=now - timedelta(minutes=60),
        ended_at=now - timedelta(minutes=30),
    )
    assert [row["id"] for row in list_pending_history("u1")] == ["m"]
    assert list_pending_history("u1")[0]["mode"] == "meeting"


def test_pending_keeps_legacy_row_without_mode(meter_env):
    """A legacy row with no mode must keep its recovery entry (never hide a real meeting)."""
    from server.meter import list_pending_history

    _add_unsaved_meeting(meter_env, "legacy", mode="", ended_at=utcnow())
    assert [row["id"] for row in list_pending_history("u1")] == ["legacy"]


def test_kept_translate_still_listed_in_history(meter_env):
    """Filtering the pending side must not change the saved list."""
    from server.meter import list_history, list_pending_history

    _add_unsaved_meeting(meter_env, "tr", mode="translate", ended_at=utcnow(), kept=True)
    assert [row["id"] for row in list_history("u1")] == ["tr"]
    assert list_pending_history("u1") == []


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
    sess._pending_q = collections.deque(maxlen=8)  # _qa_reset drops queued answers
    sess.emit = mock.Mock()
    sess._flush_cloud_archive = mock.Mock()
    sess._stop_listening = mock.Mock()
    sess.pipeline.abort_stream = mock.Mock()
    for key, val in overrides.items():
        setattr(sess, key, val)
    return sess


# --- save_prompt attribution (#196 review) ---------------------------------


def _offer_session(**overrides):
    from server.app import Session

    sess = Session.__new__(Session)
    sess.user_id = "u1"
    sess.usage_session_id = "sess-1"
    sess._workspace = "meeting"
    sess._usage_mode = "meeting"
    sess.emit = mock.Mock()
    for key, val in overrides.items():
        setattr(sess, key, val)
    return sess


def test_save_prompt_carries_the_session_mode():
    """The client binds the announced mode instead of guessing the current pane."""
    sess = _offer_session()
    with mock.patch("server.meter.is_session_kept", return_value=False):
        sess._offer_save_history()
    ev = sess.emit.call_args.args[0]
    assert ev["type"] == "save_prompt"
    assert ev["id"] == "sess-1"
    assert ev["mode"] == "meeting"


def test_save_prompt_refused_for_a_translate_session_in_the_meeting_pane():
    """#196 review: the pane is not the session.

    A Translate session still open when the user switches back to Meeting must not
    emit a save_prompt — the client used to bind that id with the pane mode and
    replace the real meeting's save target.
    """
    sess = _offer_session(_workspace="meeting", _usage_mode="translate")
    with mock.patch("server.meter.is_session_kept", return_value=False):
        sess._offer_save_history()
    sess.emit.assert_not_called()


def test_save_prompt_keeps_offering_for_a_legacy_session_without_a_usage_mode():
    """A session opened before `_usage_mode` existed still offers, as the pane says."""
    sess = _offer_session(_usage_mode="")
    with mock.patch("server.meter.is_session_kept", return_value=False):
        sess._offer_save_history()
    ev = sess.emit.call_args.args[0]
    assert ev["mode"] == "meeting"


def test_save_prompt_not_offered_when_already_kept():
    sess = _offer_session()
    with mock.patch("server.meter.is_session_kept", return_value=True):
        sess._offer_save_history()
    sess.emit.assert_not_called()


def test_saveable_mode_matches_the_pending_filter():
    from server.meter import saveable_mode

    assert saveable_mode("meeting") is True
    assert saveable_mode("lecture") is True
    assert saveable_mode("") is True  # legacy / unknown stays eligible
    assert saveable_mode(None) is True
    assert saveable_mode("translate") is False
    assert saveable_mode("Translate") is False


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
