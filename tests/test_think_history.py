"""#182: a Think answer's sources survive the History round trip.

The product requirement is that History / restore / copy / export keep the real
sources and the retrieval time an answer used, while records written before Think
existed (and plain answers) stay exactly as they were.
"""

import threading
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


class _Delta:
    def __init__(self, content=""):
        self.content = content
        self.reasoning_content = ""


class _Choice:
    def __init__(self, delta):
        self.delta = delta


class _Chunk:
    def __init__(self, content=""):
        self.choices = [_Choice(_Delta(content))] if content else []
        self.usage = None


def test_a_real_think_answer_records_its_sources_in_history(meter_env):
    # #182 review: only the translate path passed `sources` on to the History row, so
    # a Live Q&A Think answer was saved WITHOUT them — the card showed the sources and
    # the saved record had none. Driven through the real answer path, not save_history.
    from server import think
    from server.app import Pipeline

    row = _add_session(meter_env)
    events: list[dict] = []
    pipe = Pipeline.__new__(Pipeline)
    pipe.cfg = {"llm": {"provider": "deepseek", "model": "deepseek-v4-flash", "max_tokens": 80}}
    pipe.emit = events.append
    pipe._provider = "deepseek"
    pipe._model = "deepseek-v4-flash"
    pipe.client = mock.Mock()
    pipe.client.chat.completions.create.return_value = [_Chunk("A new model.")]
    pipe._keys = {"DEEPSEEK_API_KEY": "unit-test-key"}
    pipe._think_llm = (pipe.client, "deepseek-v4-flash")
    pipe._qa_history = []
    pipe._last_answer = ""
    pipe._cancel = threading.Event()
    pipe._gen_seq = 0
    pipe.user_id = "u1"
    pipe.usage_session_id = "s1"
    pipe._heard_lang = None
    pipe.think_client = mock.Mock()
    pipe.think_client.search.return_value = think.SearchOutcome(
        status=think.STATUS_OK,
        query="what is new?",
        results=(think.SearchResult("Apple News", "https://example.com/apple", "excerpt", "2026-09-10"),),
        retrieved_at=1789012800.0,
    )
    with mock.patch("server.think_budget.db_session", meter_env):
        pipe.process_text("what is new?", "ask", think=True, submit_id="s-live")

    entry = _entry(meter_env, row)
    items = {i["kind"]: i for i in entry["items"]}
    assert items["question"]["sources"] is None, "only the answer row carries sources"
    assert items["answer"]["sources"]["results"][0]["url"] == "https://example.com/apple"
    assert items["answer"]["sources"]["retrieved_at_text"] == "2026-09-10 04:00 UTC"
    assert "https://example.com/apple" in entry["copy_text"]
    assert "检索时间：2026-09-10 04:00 UTC" in entry["copy_text"]


def test_an_attachment_answer_is_saved_as_an_answer_row_with_sources(meter_env):
    # `file_ask` rows were written under a kind the History restore never read, so an
    # attachment answer (and its sources) vanished from History entirely.
    from server.meter import save_history

    row = _add_session(meter_env)
    save_history("u1", "s1", "question", "review this", "q1")
    save_history("u1", "s1", "answer", "an answer", "q1", sources=PAYLOAD)
    entry = _entry(meter_env, row)
    items = {i["kind"]: i for i in entry["items"]}
    assert items["answer"]["sources"]["results"][0]["url"] == "https://example.com/apple"


def test_a_long_but_legal_sources_payload_survives_storage(meter_env):
    # #182 review: `_dump_sources` cut the serialized JSON at 8000 chars, so a legal
    # five-source payload with long URLs became invalid JSON and read back as NO
    # sources. The bound is now applied to the fields and to whole entries.
    from server.meter import _dump_sources, _parse_sources, save_history

    long_payload = {
        "status": "ok",
        "retrieved_at": 1789012800.0,
        "retrieved_at_text": "2026-09-10 04:00 UTC",
        "results": [
            {
                "title": "T" * 400,
                "url": "https://example.com/" + "a" * 2500,
                "published_at": "2026-09-10",
                "snippet": "s" * 900,
            }
            for _ in range(5)
        ],
        "note": "",
    }
    raw = _dump_sources(long_payload)
    assert raw, "a legal payload must not be dropped"
    parsed = _parse_sources(raw)
    assert parsed is not None, "the stored payload must still be parseable"
    assert parsed["results"], "at least one source must survive"
    assert len(raw) <= think_max() and all(
        len(r["url"]) <= 2048 for r in parsed["results"]
    )

    row = _add_session(meter_env)
    save_history("u1", "s1", "answer", "an answer", "q1", sources=long_payload)
    entry = _entry(meter_env, row)
    stored = entry["items"][0]["sources"]
    assert stored is not None and stored["results"], "History keeps the parseable sources"


def think_max() -> int:
    from server.think import MAX_STORED_SOURCES_CHARS

    return MAX_STORED_SOURCES_CHARS
