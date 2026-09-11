"""#182: a Think answer's sources survive the History round trip.

The product requirement is that History / restore / copy / export keep the real
sources and the retrieval time an answer used, while records written before Think
existed (and plain answers) stay exactly as they were.
"""

from unittest import mock

import pytest

from server.db import HistoryItem, UsageSession, User, utcnow

PAYLOAD = {
    "status": "ok",
    "retrieved_at": 1789012800.0,
    "retrieved_at_text": "2026-09-10 04:00 UTC",
    "results": [
        {"title": "Apple News", "url": "https://example.com/apple", "published_at": "2026-09-10"},
        {"title": "Other", "url": "https://example.com/other", "published_at": None},
    ],
    "note": "",
}


@pytest.fixture
def meter_env(meter_db):
    engine, session = meter_db
    with mock.patch("server.meter.db_session", session):
        yield session


def _add_session(session, sid: str = "s1") -> UsageSession:
    row = UsageSession(
        id=sid,
        user_id="u1",
        mode="interview",
        scene="",
        title="s1",
        started_at=utcnow(),
        kept=True,
    )
    with session() as db:
        if db.get(User, "u1") is None:
            db.add(User(id="u1", email="u1@test.local"))
        db.add(row)
    return row


def _entry(session, row):
    from server.meter import _session_entry

    with session() as db:
        return _session_entry(db, row)


def test_a_think_answer_keeps_its_sources_and_retrieval_time(meter_env):
    from server.meter import save_history

    row = _add_session(meter_env)
    save_history("u1", "s1", "question", "what is new?", "q1")
    save_history("u1", "s1", "answer", "an answer", "q1", sources=PAYLOAD)

    entry = _entry(meter_env, row)
    items = {i["kind"]: i for i in entry["items"]}
    assert items["question"]["sources"] is None
    assert items["answer"]["sources"]["results"][0]["url"] == "https://example.com/apple"
    assert items["answer"]["sources"]["retrieved_at_text"] == "2026-09-10 04:00 UTC"


def test_copy_text_keeps_the_sources_block(meter_env):
    from server.meter import save_history

    row = _add_session(meter_env)
    save_history("u1", "s1", "answer", "an answer", "q1", sources=PAYLOAD)
    entry = _entry(meter_env, row)
    assert "https://example.com/apple" in entry["copy_text"]
    assert "检索时间：2026-09-10 04:00 UTC" in entry["copy_text"]
    assert "（发布时间 2026-09-10）" in entry["copy_text"]


def test_a_plain_answer_and_an_old_record_carry_no_sources(meter_env):
    from server.meter import save_history

    row = _add_session(meter_env)
    save_history("u1", "s1", "answer", "plain answer", "q1")
    entry = _entry(meter_env, row)
    assert entry["items"][0]["sources"] is None, "a plain answer stores nothing"
    assert "[1]" not in entry["copy_text"], "and exports no source block"


def test_a_corrupt_sources_row_never_breaks_history(meter_env):
    row = _add_session(meter_env)
    with meter_env() as db:
        db.add(
            HistoryItem(
                id="h-bad",
                user_id="u1",
                session_id="s1",
                kind="answer",
                qid="q1",
                text="answer",
                sources="{not json",
            )
        )
    entry = _entry(meter_env, row)
    assert entry["items"][0]["sources"] is None
    assert "answer" in entry["items"][0]["text"]
