"""Meeting line extend/revise must upsert History rows with kind=transcript (Ticket C)."""

import time
from unittest import mock

import pytest
from sqlalchemy import select

from server.db import HistoryItem, UsageSession, User, utcnow
from tests.test_meeting_merge import _Clock, _events, _session, _wait_for


@pytest.fixture
def meter_env(meter_db):
    engine, session = meter_db
    with mock.patch("server.meter.db_session", session):
        yield session


def _add_user(session, user_id: str = "u1") -> str:
    with session() as db:
        if db.get(User, user_id) is None:
            db.add(User(id=user_id, email=f"{user_id}@test.local"))
    return user_id


def _add_usage_session(session, sid: str, user_id: str = "u1") -> str:
    with session() as db:
        if db.get(UsageSession, sid) is None:
            db.add(
                UsageSession(
                    id=sid,
                    user_id=user_id,
                    mode="meeting",
                    scene="meeting",
                    title=sid,
                    started_at=utcnow(),
                )
            )
    return sid


def _history_rows(session, usage_session_id: str) -> list[HistoryItem]:
    with session() as db:
        return list(
            db.execute(
                select(HistoryItem)
                .where(HistoryItem.session_id == usage_session_id)
                .order_by(HistoryItem.created_at.asc())
            ).scalars()
        )


def _wait_for_history_row(session, sid: str, qid: str, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if [r for r in _history_rows(session, sid) if r.qid == qid]:
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for history row qid={qid}")


def _wait_for_history_text(session, sid: str, qid: str, text: str, timeout: float = 2.0) -> HistoryItem:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rows = [r for r in _history_rows(session, sid) if r.qid == qid]
        if len(rows) == 1 and rows[0].text == text:
            return rows[0]
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for history text qid={qid}")


def _drive_enqueue(sess, text, speaker="A", turn_order=1, meta_extra=None):
    meta = {
        "turn_order": turn_order,
        "first_word_ms": 1000 * turn_order,
        "last_word_ms": 5000 * turn_order,
        "n_words": 8,
    }
    if meta_extra:
        meta.update(meta_extra)
    sess._enqueue_meeting_final(text, "en", speaker, meta)


def test_extend_updates_transcript_row_in_place(meter_env):
    from server.meter import open_usage_session

    _add_user(meter_env)
    sid, _ = open_usage_session("u1", "meeting")
    sess = _session(user_id="u1", usage_session_id=sid)
    clk = _Clock()
    with mock.patch("server.app.time.time", clk):
        _drive_enqueue(
            sess,
            "prioritizing P, performance availability work. So one of the significant",
            turn_order=1,
            meta_extra={"first_word_ms": 54000, "last_word_ms": 55000, "n_words": 8},
        )
        _wait_for(sess, "question", 1)
        qid = _events(sess, "question")[0]["id"]
        clk.advance(10)
        _drive_enqueue(
            sess,
            "features of this particular recent outage last week was, is that the Redis server apparently",
            turn_order=2,
            meta_extra={"first_word_ms": 55200, "last_word_ms": 60000, "n_words": 10},
        )
        _wait_for(sess, "line_update", 1)
        merged = _events(sess, "line_update")[-1]["text"]
    row = _wait_for_history_text(meter_env, sid, qid, merged)
    assert row.kind == "transcript"


def test_extend_with_speaker_keeps_kind_and_sets_speaker(meter_env):
    from server.meter import open_usage_session

    _add_user(meter_env)
    sid, _ = open_usage_session("u1", "meeting")
    sess = _session(user_id="u1", usage_session_id=sid)
    clk = _Clock()
    with mock.patch("server.app.time.time", clk):
        _drive_enqueue(
            sess,
            "So one of the significant",
            speaker="A",
            turn_order=1,
            meta_extra={"first_word_ms": 1000, "last_word_ms": 5000, "n_words": 4},
        )
        _wait_for(sess, "question", 1)
        qid = _events(sess, "question")[0]["id"]
        clk.advance(10)
        _drive_enqueue(
            sess,
            "features of this particular recent outage",
            speaker="A",
            turn_order=2,
            meta_extra={"first_word_ms": 6000, "last_word_ms": 12000, "n_words": 6},
        )
        _wait_for(sess, "line_update", 1)
        merged = _events(sess, "line_update")[-1]["text"]
    row = _wait_for_history_text(meter_env, sid, qid, merged)
    assert row.kind == "transcript"
    assert row.speaker == "A"
    all_rows = _history_rows(meter_env, sid)
    assert [r for r in all_rows if r.kind == "A"] == []


def test_revision_updates_transcript_row_in_place(meter_env):
    from server.meter import open_usage_session

    _add_user(meter_env)
    sid, _ = open_usage_session("u1", "meeting")
    sess = _session(user_id="u1", usage_session_id=sid)
    clk = _Clock()
    with mock.patch("server.app.time.time", clk):
        _drive_enqueue(sess, "first version of the spoken line", turn_order=1)
        _wait_for(sess, "question", 1)
        qid = _events(sess, "question")[0]["id"]
        _wait_for_history_row(meter_env, sid, qid)
        revised = "first revised version of the spoken line"
        sess._revise_meeting_line(qid, revised, "en", "A", {"last_word_ms": 9000, "n_words": 8})
        assert len(_events(sess, "line_update")) == 1
    row = _wait_for_history_text(meter_env, sid, qid, revised)
    assert row.kind == "transcript"


def test_extend_with_empty_speaker_no_stray_kind_row(meter_env):
    from server.meter import open_usage_session

    _add_user(meter_env)
    sid, _ = open_usage_session("u1", "meeting")
    sess = _session(user_id="u1", usage_session_id=sid)
    clk = _Clock()
    with mock.patch("server.app.time.time", clk):
        _drive_enqueue(sess, "So one of the significant", speaker="", turn_order=1)
        _wait_for(sess, "question", 1)
        qid = _events(sess, "question")[0]["id"]
        clk.advance(10)
        _drive_enqueue(sess, "features merged in place", speaker="", turn_order=2)
        _wait_for(sess, "line_update", 1)
        merged = _events(sess, "line_update")[-1]["text"]
    row = _wait_for_history_text(meter_env, sid, qid, merged)
    assert row.kind == "transcript"


def test_user_id_none_skips_db_on_extend():
    sess = _session(user_id=None, usage_session_id=None)
    clk = _Clock()
    with mock.patch("server.app.time.time", clk):
        _drive_enqueue(sess, "So one of the significant", turn_order=1)
        _wait_for(sess, "question", 1)
        clk.advance(10)
        _drive_enqueue(sess, "continuation fragment", turn_order=2)
        _wait_for(sess, "line_update", 1)
    assert len(_events(sess, "line_update")) == 1
