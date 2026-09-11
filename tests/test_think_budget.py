"""#182: the search budget gate — caps, atomicity, persistence, refusal.

These are the tests that stand between a bug and a burned Parallel account:
the 100/101 daily boundary, the 3000/3001 trial boundary, cross-restart
persistence, refusal when the store is unavailable, and concurrency.
"""

import threading
from datetime import datetime, timedelta, timezone
from unittest import mock

import pytest

from server.db import ThinkSearchDay, ThinkSearchRecord, ThinkSearchState, db_session


@pytest.fixture
def budget_env(meter_db):
    engine, session = meter_db
    with mock.patch("server.think_budget.db_session", session):
        yield session


def _attempts(budget_env) -> tuple[int, int]:
    from server.think_budget import TOTAL_ROW

    with budget_env() as db:
        day = db.get(ThinkSearchDay, __import__("server.think_budget", fromlist=["utc_day"]).utc_day())
        total = db.get(ThinkSearchState, TOTAL_ROW)
        return (day.attempts if day else 0, total.attempts if total else 0)


def test_the_daily_boundary_is_exact_and_the_101st_refuses(budget_env):
    from server.think_budget import REASON_DAILY, reserve

    for i in range(100):
        got = reserve(daily_limit=100, total_limit=3000)
        assert got.allowed, f"attempt {i + 1} should be allowed"
    refused = reserve(daily_limit=100, total_limit=3000)
    assert not refused.allowed
    assert refused.reason == REASON_DAILY
    assert refused.day_attempts == 100, "a refusal must not consume anything"
    day, _total = _attempts(budget_env)
    assert day == 100


def test_the_trial_boundary_is_exact_and_the_next_attempt_refuses(budget_env):
    """The cumulative cap is enforced independently of the daily one."""
    from server.think_budget import REASON_TOTAL, reserve

    for _ in range(3):
        assert reserve(daily_limit=100, total_limit=3).allowed
    refused = reserve(daily_limit=100, total_limit=3)
    assert not refused.allowed
    assert refused.reason == REASON_TOTAL
    assert refused.total_attempts == 3, "a refusal must not consume anything"
    _day, total = _attempts(budget_env)
    assert total == 3


def test_the_shipped_caps_match_the_order():
    from server.settings import THINK_SEARCH_DAILY_LIMIT, THINK_SEARCH_TOTAL_LIMIT

    assert THINK_SEARCH_DAILY_LIMIT == 100
    assert THINK_SEARCH_TOTAL_LIMIT == 3000


def test_a_new_utc_day_does_not_reset_the_trial_counter(budget_env):
    from server.think_budget import reserve, utc_day

    today = datetime(2026, 9, 12, 23, 59, tzinfo=timezone.utc)
    tomorrow = today + timedelta(minutes=2)
    assert reserve(daily_limit=2, total_limit=3000, now=today).allowed
    assert reserve(daily_limit=2, total_limit=3000, now=today).allowed
    assert not reserve(daily_limit=2, total_limit=3000, now=today).allowed
    # A fresh UTC day clears the DAILY counter but never the trial total.
    assert reserve(daily_limit=2, total_limit=3000, now=tomorrow).allowed
    assert utc_day(today) != utc_day(tomorrow)
    _day, total = _attempts(budget_env)
    assert total == 3


def test_the_counters_survive_a_restart(budget_env):
    """A 'restart' is a brand-new engine over the same file; the caps must hold."""
    from sqlalchemy import create_engine

    from tests.conftest import isolated_sessionmaker, make_isolated_engine

    engine = make_isolated_engine()
    path = engine.url.database
    with isolated_sessionmaker(engine) as session:
        with mock.patch("server.think_budget.db_session", session):
            from server.think_budget import reserve

            assert reserve(daily_limit=3, total_limit=3000).allowed
            assert reserve(daily_limit=3, total_limit=3000).allowed
    engine.dispose()

    reopened = create_engine(f"sqlite:///{path}")
    with isolated_sessionmaker(reopened) as session2:
        with mock.patch("server.think_budget.db_session", session2):
            from server.think_budget import reserve

            assert reserve(daily_limit=3, total_limit=3000).allowed, "the third attempt is still within the cap"
            refused = reserve(daily_limit=3, total_limit=3000)
            assert not refused.allowed, "a restart must not reset the counters"
            assert refused.day_attempts == 3


def test_an_unavailable_store_refuses_instead_of_guessing():
    from server.think_budget import REASON_STORE, reserve

    with mock.patch("server.think_budget.db_session", side_effect=RuntimeError("db down")):
        got = reserve(daily_limit=100, total_limit=3000)
    assert not got.allowed
    assert got.reason == REASON_STORE


def test_concurrent_workers_cannot_overshoot_the_cap():
    """Separate workers (engines) race for a 5-attempt budget: exactly 5 win."""
    from sqlalchemy import create_engine

    from tests.conftest import isolated_sessionmaker, make_isolated_engine

    bootstrap = make_isolated_engine()
    path = bootstrap.url.database
    bootstrap.dispose()

    results: list[bool] = []
    lock = threading.Lock()

    def worker():
        engine = create_engine(f"sqlite:///{path}", connect_args={"timeout": 30})
        try:
            with isolated_sessionmaker(engine) as session:
                with mock.patch("server.think_budget.db_session", session):
                    from server.think_budget import reserve

                    allowed = reserve(daily_limit=5, total_limit=3000).allowed
        finally:
            engine.dispose()
        with lock:
            results.append(allowed)

    threads = [threading.Thread(target=worker) for _ in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sum(1 for r in results if r) == 5, f"exactly five reservations, got {results}"
    engine = create_engine(f"sqlite:///{path}")
    with engine.connect() as conn:
        from server.think_budget import utc_day

        got = conn.exec_driver_sql(
            "SELECT attempts FROM think_search_days WHERE day = ?", (utc_day(),)
        ).scalar()
    engine.dispose()
    assert got == 5


def test_a_record_round_trips_and_reuses_the_same_request(budget_env):
    from server.think_budget import find_snapshot, record_attempt

    assert find_snapshot("q1") is None
    assert record_attempt(
        "q1",
        question="what is new?",
        session_id="s1",
        session_gen=3,
        status="ok",
        sources={"status": "ok", "results": [{"title": "A", "url": "https://e.com/a", "published_at": None}]},
        retrieved_at=1789012800.0,
    )
    snap = find_snapshot("q1")
    assert snap is not None
    assert snap["status"] == "ok"
    assert snap["session_gen"] == 3
    assert snap["sources"]["results"][0]["url"] == "https://e.com/a"

    with budget_env() as db:
        row = db.get(ThinkSearchRecord, "q1")
        assert "what is new" not in (row.sources or "") + (row.question_hash or ""), "the question text is never stored"


def test_a_retry_reuses_an_ok_search_but_a_different_question_does_not(budget_env):
    from server.think_budget import find_question_snapshot, record_attempt

    record_attempt("q1", question="what is new?", session_id="s1", status="ok", sources={"status": "ok"})
    assert find_question_snapshot("s1", "what is new?") is not None
    assert find_question_snapshot("s1", "what is new") is None, "an exact match is required"
    assert find_question_snapshot("s2", "what is new?") is None, "another session is another question"
    assert find_question_snapshot("s1", "and now?") is None


def test_a_failed_attempt_is_not_reused_by_a_retry(budget_env):
    from server.think_budget import find_question_snapshot, record_attempt

    record_attempt("q1", question="what is new?", session_id="s1", status="failed")
    assert find_question_snapshot("s1", "what is new?") is None, "a failed lookup may be retried for real"


def test_the_request_id_comes_from_the_submit_action_when_there_is_one(budget_env):
    from server.think_budget import build_request_id, is_submit_keyed

    keyed = build_request_id("4f1c9a2e", session_id="s1", question="what is new?")
    assert keyed == "r-4f1c9a2e"
    assert is_submit_keyed(keyed)
    # The same submit action is the same request no matter how it arrives...
    assert build_request_id("4f1c9a2e", session_id="s1", question="what is new?") == keyed
    # ...while a different action on identical text is a different request.
    assert build_request_id("9b7d0c11", session_id="s1", question="what is new?") != keyed

    fallback = build_request_id("", session_id="s1", question="what is new?")
    assert fallback == build_request_id("", session_id="s1", question="what is new?")
    assert not is_submit_keyed(fallback), "a question key is not proof of one submit"
    assert fallback != build_request_id("", session_id="s2", question="what is new?")
    assert fallback != build_request_id("", session_id="s1", question="and now?")
    # A hostile / over-long id is bounded and stripped to a safe alphabet.
    assert build_request_id("a" * 200 + "!$%", session_id="s1", question="q").startswith("r-a")


def test_claiming_a_request_is_exclusive_and_leaves_a_pending_row(budget_env):
    from server.think_budget import claim, find_snapshot, is_pending, record_attempt

    assert claim("r-a") is True, "the first claim owns the lookup"
    assert claim("r-a") is False, "a second claim must not own it again"
    snap = find_snapshot("r-a")
    assert is_pending(snap), "a claimed but unfinished lookup is not a result"

    record_attempt("r-a", question="q", session_id="s1", status="ok", sources={"status": "ok"})
    assert not is_pending(find_snapshot("r-a")), "closing the claim makes it a real result"


def test_a_waiter_sees_the_owners_snapshot_or_an_honest_pending_row(budget_env):
    from server.think_budget import claim, record_attempt, wait_for_snapshot

    assert claim("r-b") is True
    # Nobody finished it: the bounded wait gives up and reports the pending row.
    assert wait_for_snapshot("r-b", timeout=0.01, interval=0.005)["status"] == "pending"
    record_attempt("r-b", question="q", session_id="s1", status="ok", sources={"status": "ok", "results": [1]})
    got = wait_for_snapshot("r-b", timeout=0.5, interval=0.005)
    assert got["status"] == "ok" and got["sources"]["results"] == [1]


def test_a_claim_that_cannot_be_written_refuses_the_search(budget_env):
    from server.think_budget import claim

    with mock.patch("server.think_budget.db_session", side_effect=RuntimeError("store down")):
        assert claim("r-c") is None, "an untrusted store must not authorise a spend"
