import threading
import time
from datetime import datetime, timezone

from server.history_title import (
    TITLE_SOURCE_GENERATED,
    TITLE_SOURCE_PREVIEW,
    TITLE_SOURCE_USER,
    apply_generated_title,
    fallback_title,
    generate_history_title,
    parse_model_title,
    schedule_history_title,
    should_overwrite_title,
    title_input_from_items,
)


def test_parse_model_title_strips_quotes_and_length():
    assert parse_model_title('  "Budget review" \nextra') == "Budget review"
    long_en = parse_model_title("one two three four five six seven eight nine ten eleven")
    assert len(long_en) <= 40
    assert parse_model_title("Unsaved") == ""
    assert parse_model_title("") == ""


def test_title_input_is_bounded_and_skips_notes():
    items = [
        {"kind": "notes", "text": "secret notes"},
        {"kind": "transcript", "text": "Hello team"},
        {"kind": "transcript", "text": "x" * 5000},
    ]
    blob = title_input_from_items(items, limit=80)
    assert "secret notes" not in blob
    assert blob.startswith("Hello team")
    assert len(blob) <= 80


def test_generated_and_user_titles_are_not_preview_overwritten():
    assert should_overwrite_title(TITLE_SOURCE_PREVIEW)
    assert not should_overwrite_title(TITLE_SOURCE_GENERATED)
    assert not should_overwrite_title(TITLE_SOURCE_USER)


def test_fallback_title_is_meeting_and_date():
    when = datetime(2026, 9, 11, 3, 0, tzinfo=timezone.utc)
    assert fallback_title(when) == "Meeting · Sep 11"


def _session(uid: str, sid: str, **kwargs):
    from server.db import HistoryItem, UsageSession, User, db_session, init_db
    from server.security import new_id

    init_db()
    with db_session() as db:
        if db.get(User, uid) is None:
            db.add(User(id=uid, email=f"{uid}@test.local", password_hash=""))
        db.add(UsageSession(id=sid, user_id=uid, mode="meeting", **kwargs))
    return HistoryItem, new_id


def test_keep_schedules_title_without_blocking(monkeypatch):
    from server.db import UsageSession, User, db_session, init_db
    from server.meter import keep_usage_session
    from server.security import new_id

    init_db()
    uid, sid = new_id(), new_id()
    with db_session() as db:
        db.add(User(id=uid, email=f"{uid}@test.local", password_hash=""))
        db.add(UsageSession(id=sid, user_id=uid, mode="meeting", kept=False, title="During the whole session, so"))
    called = []

    def fake_schedule(user_id, session_id, complete=None):
        called.append((user_id, session_id))
        return True

    monkeypatch.setattr("server.history_title.schedule_history_title", fake_schedule)
    keep_usage_session(uid, sid)
    with db_session() as db:
        assert db.get(UsageSession, sid).kept is True
    assert called == [(uid, sid)]


def test_generate_title_uses_stub_and_skips_user_and_discarded():
    from server.db import HistoryItem, UsageSession, db_session
    from server.meter import discard_usage_session
    from server.security import new_id

    uid, sid = new_id(), new_id()
    HistoryItemCls, item_id = _session(uid, sid, kept=True, title="old", title_source=TITLE_SOURCE_PREVIEW)
    with db_session() as db:
        db.add(HistoryItemCls(id=item_id(), user_id=uid, session_id=sid, kind="transcript", text="Q3 budget review with finance."))

    title = generate_history_title(uid, sid, lambda _messages: "Q3 budget review")
    assert title == "Q3 budget review"
    with db_session() as db:
        row = db.get(UsageSession, sid)
        assert row.title == "Q3 budget review"
        assert row.title_source == TITLE_SOURCE_GENERATED

    with db_session() as db:
        row = db.get(UsageSession, sid)
        row.title = "My custom"
        row.title_source = TITLE_SOURCE_USER
    assert generate_history_title(uid, sid, lambda _messages: "model") == "My custom"
    with db_session() as db:
        assert db.get(UsageSession, sid).title == "My custom"

    discard_usage_session(uid, sid)
    assert apply_generated_title(uid, sid, "late") is False


def test_empty_transcript_uses_neutral_fallback():
    from server.db import UsageSession, db_session
    from server.security import new_id

    uid, sid = new_id(), new_id()
    started = datetime(2026, 9, 12, 1, 0, tzinfo=timezone.utc)
    _session(uid, sid, kept=True, started_at=started, title="")
    title = generate_history_title(uid, sid, lambda _messages: (_ for _ in ()).throw(RuntimeError("no call")))
    assert title.startswith("Meeting ·")
    with db_session() as db:
        assert db.get(UsageSession, sid).title_source == TITLE_SOURCE_PREVIEW


def test_schedule_is_single_flight(monkeypatch):
    hold = threading.Event()
    started = []

    def fake_generate(user_id, session_id, complete):
        started.append(session_id)
        hold.wait(0.4)

    monkeypatch.setattr("server.history_title.generate_history_title", fake_generate)
    assert schedule_history_title("u", "s-flight", complete=lambda m: "x")
    time.sleep(0.02)
    assert schedule_history_title("u", "s-flight", complete=lambda m: "x") is False
    hold.set()
    time.sleep(0.05)
    assert started == ["s-flight"]


def test_later_transcript_does_not_clobber_generated_title():
    from server.db import UsageSession, db_session
    from server.meter import save_history
    from server.security import new_id

    uid, sid = new_id(), new_id()
    _session(uid, sid, kept=True, title="Q3 budget review", title_source=TITLE_SOURCE_GENERATED)
    save_history(uid, sid, "transcript", "A much longer later sentence that used to become the title.")
    with db_session() as db:
        row = db.get(UsageSession, sid)
        assert row.title == "Q3 budget review"
        assert row.title_source == TITLE_SOURCE_GENERATED

