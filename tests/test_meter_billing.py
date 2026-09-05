"""P0 metering & billing tests (money paths).

These are the highest-value backend tests: user consumption is metered, quota
is enforced, plans downgrade on cancellation. All run against an isolated
SQLite engine so they never touch the production ``data/nod.db`` or spend
real provider money (STT/LLM are patched out where they'd be called).
"""

from datetime import datetime, timezone

from unittest import mock

import pytest

from server.db import UsageDay, UsageSession, User
from server.settings import (
    DAILY_STT_SECONDS,
    GLOBAL_DAILY_BUDGET_USD,
    LLM_USD_PER_1K_IN,
    LLM_USD_PER_1K_OUT,
    STT_USD_PER_MINUTE,
)


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _add_user(session, user_id="u1", plan="free", status="trialing"):
    with session() as db:
        db.add(User(id=user_id, email=f"{user_id}@test.local", plan=plan, subscription_status=status))
    return user_id


@pytest.fixture
def meter_env(meter_db):
    """Isolated engine + a db_session the meter functions point at."""
    engine, session = meter_db
    with mock.patch("server.meter.db_session", session):
        yield session


def _seed_usage_session(session, sid, user_id="u1", stt=0.0, inp=0, out=0, cost=0.0):
    """Insert/update a UsageSession so usage_snapshot's SUM sees it."""
    with session() as db:
        row = db.get(UsageSession, sid)
        if row is None:
            row = UsageSession(id=sid, user_id=user_id)
            db.add(row)
            db.flush()
        row.stt_seconds = stt
        row.llm_input_tokens = inp
        row.llm_output_tokens = out
        row.estimated_cost_usd = cost


# --- Cost math -------------------------------------------------------------


def test_cost_stt_is_minutes_times_rate(meter_env):
    from server.meter import _cost_stt

    assert _cost_stt(60.0) == pytest.approx(STT_USD_PER_MINUTE)
    assert _cost_stt(120.0) == pytest.approx(STT_USD_PER_MINUTE * 2)
    assert _cost_stt(0.0) == 0.0


def test_cost_llm_in_out_separate(meter_env):
    from server.meter import _cost_llm

    expected = (1000 / 1000) * LLM_USD_PER_1K_IN + (2000 / 1000) * LLM_USD_PER_1K_OUT
    assert _cost_llm(1000, 2000) == pytest.approx(expected)


# --- Atomic accumulation (no lost updates) --------------------------------


def test_consume_stt_accumulates_into_usage_session(meter_env):
    from server.meter import consume_stt, open_usage_session

    _add_user(meter_env)
    sid, _snap = open_usage_session("u1", "interview")
    assert sid is not None
    consume_stt("u1", 30.0, sid)
    consume_stt("u1", 90.0, sid)
    with meter_env() as db:
        assert db.get(UsageSession, sid).stt_seconds == pytest.approx(120.0)


def test_concurrent_consumes_do_not_lose_updates(meter_env):
    """Two sessions metering the same day must both count.

    server.meter ``_bump`` does arithmetic in SQL (``col + stt``) so
    concurrent writers don't clobber each other. This guards that.
    """
    from server.meter import consume_stt, open_usage_session

    _add_user(meter_env)
    s1, _ = open_usage_session("u1", "interview")
    s2, _ = open_usage_session("u1", "meeting")
    consume_stt("u1", 30.0, s1)
    consume_stt("u1", 45.0, s2)
    consume_stt("u1", 25.0, s1)
    with meter_env() as db:
        assert db.get(UsageSession, s1).stt_seconds == pytest.approx(55.0)
        assert db.get(UsageSession, s2).stt_seconds == pytest.approx(45.0)
        day = db.query(UsageDay).filter(UsageDay.user_id == "u1").one()
        assert day.stt_seconds == pytest.approx(100.0)


# --- Quota enforcement: each axis triggers the right reason ---------------
# These construct state directly rather than going through consume_*, so they
# test the *snapshot boundary logic* (which reason short-circuits first)
# without coupling to the cost math (covered above).


def test_quota_stt_axis(meter_env):
    from server.meter import usage_snapshot

    _add_user(meter_env)
    # Free plan monthly STT cap = 2*3600*31 seconds. Push past it.
    cap = 2 * 3600 * 31
    _seed_usage_session(meter_env, "s1", stt=float(cap))
    snap = usage_snapshot("u1")
    assert snap["ok"] is False
    assert snap["reason"] == "stt"


def test_quota_daily_stt_axis(meter_env):
    from server.meter import usage_snapshot

    _add_user(meter_env)
    # Daily STT cap is DAILY_STT_SECONDS. daily_stt reads UsageDay (the
    # per-day aggregate `_bump` writes), NOT UsageSession. Stay under the
    # monthly cap so only the daily axis fires.
    with meter_env() as db:
        db.add(UsageDay(user_id="u1", day=_today(), stt_seconds=float(DAILY_STT_SECONDS)))
    snap = usage_snapshot("u1")
    assert snap["ok"] is False
    assert snap["reason"] == "daily_stt"


def test_quota_llm_axis(meter_env):
    from server.meter import usage_snapshot

    _add_user(meter_env, plan="free")
    # Free plan llm cap = 100k tokens. Push past it (cost stays under daily $).
    _seed_usage_session(meter_env, "s1", inp=60_000, out=50_000)
    snap = usage_snapshot("u1")
    assert snap["ok"] is False
    assert snap["reason"] == "llm"


def test_quota_daily_cost_axis(meter_env):
    from server.meter import usage_snapshot

    _add_user(meter_env, plan="free")
    # Free daily_cost_usd = 2.0. Write a UsageDay cost above the threshold so
    # the *cost* axis (not the token axis) is what trips. Day must be TODAY.
    with meter_env() as db:
        db.add(UsageDay(user_id="u1", day=_today(), cost_usd=2.5))
    snap = usage_snapshot("u1")
    assert snap["ok"] is False
    assert snap["reason"] == "daily"


def test_quota_global_budget_axis(meter_env):
    from server.meter import usage_snapshot

    _add_user(meter_env)
    with meter_env() as db:
        from server.db import GlobalDay

        db.add(GlobalDay(day=_today(), cost_usd=GLOBAL_DAILY_BUDGET_USD))
    snap = usage_snapshot("u1")
    assert snap["ok"] is False
    assert snap["reason"] == "global"


def test_quota_sessions_axis(meter_env):
    from server.meter import can_start_session, open_usage_session

    _add_user(meter_env, plan="free")
    # Free plan allows 60 sessions.
    for _ in range(60):
        sid, snap = open_usage_session("u1", "interview")
        assert sid, snap.get("reason")
    ok, snap = can_start_session("u1")
    assert ok is False
    assert snap["reason"] == "sessions"


def test_usage_snapshot_sessions_axis(meter_env):
    """item2: the sessions limit lives in usage_snapshot, not can_start_session,
    so /api/me (usage_snapshot) reports reason='sessions'."""

    from server.meter import open_usage_session, usage_snapshot

    _add_user(meter_env, plan="free")
    for _ in range(60):
        sid, snap = open_usage_session("u1", "interview")
        assert sid, snap.get("reason")
    snap = usage_snapshot("u1")
    assert snap["ok"] is False
    assert snap["reason"] == "sessions"


def test_quota_exceeded_logs_reason(meter_env, caplog):
    """item1: a quota block logs the reason + quota fields for observability."""
    from server.app import Session

    events: list[dict] = []
    sess = Session.__new__(Session)
    sess.emit = events.append
    sess.user_id = "u1"
    with caplog.at_level("WARNING", logger="nod"):
        sess._quota_block(
            {"ok": False, "reason": "sessions", "sessions": 60, "session_limit": 60, "daily_cost_usd": 0.0, "global_cost_usd": 0.0}
        )
    assert any("quota_exceeded" in r.message and "sessions" in r.message and "60/60" in r.message for r in caplog.records)


# --- Plan downgrade on cancellation ---------------------------------------


def test_plan_downgrades_when_canceled(meter_env):
    from server.meter import plan_of

    _add_user(meter_env, user_id="c", plan="pro", status="canceled")
    with meter_env() as db:
        assert plan_of(db.get(User, "c"))["id"] == "free"


def test_plan_downgrades_when_unpaid(meter_env):
    from server.meter import plan_of

    _add_user(meter_env, user_id="u", plan="pro", status="unpaid")
    with meter_env() as db:
        assert plan_of(db.get(User, "u"))["id"] == "free"


def test_plan_stays_pro_when_active(meter_env):
    from server.meter import plan_of

    _add_user(meter_env, user_id="p", plan="pro", status="active")
    with meter_env() as db:
        assert plan_of(db.get(User, "p"))["id"] == "pro"


# --- usage_snapshot shape --------------------------------------------------


def test_usage_snapshot_shape(meter_env):
    from server.meter import usage_snapshot

    _add_user(meter_env)
    snap = usage_snapshot("u1")
    assert snap["ok"] is True
    assert snap["plan"] == "free"
    for key in ("stt_seconds", "stt_limit", "llm_tokens", "llm_limit", "sessions", "session_limit"):
        assert key in snap


def test_stream_usage_beats_character_estimate():
    from server.app import estimate_llm_tokens, llm_usage_from_chunk, resolve_llm_usage

    class _U:
        prompt_tokens = 12
        completion_tokens = 34

    class _Ch:
        usage = _U()

    assert llm_usage_from_chunk(_Ch()) == (12, 34)
    assert resolve_llm_usage((12, 34), "hello " * 80, "world " * 80) == (12, 34)
    assert resolve_llm_usage(None, "abcd", "efgh") == estimate_llm_tokens("abcd", "efgh") == (1, 1)


def test_stream_rechecks_quota_every_n_chunks():
    from server.app import LLM_QUOTA_CHECK_EVERY, stream_should_recheck_quota

    assert stream_should_recheck_quota(0) is False
    assert stream_should_recheck_quota(LLM_QUOTA_CHECK_EVERY) is True
    assert stream_should_recheck_quota(LLM_QUOTA_CHECK_EVERY - 1) is False


def test_record_usage_uses_stream_tokens_not_estimate(meter_env):
    from server.app import Pipeline
    from server.meter import consume_llm, open_usage_session

    _add_user(meter_env)
    sid, _ = open_usage_session("u1", "interview")
    events: list[dict] = []
    pipe = Pipeline({"llm": {"provider": "deepseek", "model": "deepseek-chat"}}, {}, events.append)
    pipe.user_id = "u1"
    pipe.usage_session_id = sid
    with mock.patch("server.meter.consume_llm", wraps=consume_llm) as wrapped:
        pipe._record_usage("hello " * 200, "world " * 200, "ask", "q1", False, (9, 11))
        wrapped.assert_called_once()
        assert wrapped.call_args.args[2:4] == (9, 11)
    with meter_env() as db:
        row = db.get(UsageSession, sid)
        assert row.llm_input_tokens == 9
        assert row.llm_output_tokens == 11


def test_mid_stream_quota_aborts_before_done(meter_env):
    from types import SimpleNamespace

    from server.app import LLM_QUOTA_CHECK_EVERY, Pipeline

    events: list[dict] = []
    pipe = Pipeline({"llm": {"provider": "deepseek", "model": "deepseek-chat"}}, {}, events.append)
    pipe.user_id = "u1"

    def _chunk(text: str):
        return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=text, reasoning_content=None))], usage=None)

    chunks = [_chunk("x") for _ in range(LLM_QUOTA_CHECK_EVERY)]
    pipe.client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **_k: chunks)))
    with mock.patch("server.meter.check_can_generate", side_effect=[(True, {"ok": True}), (False, {"ok": False, "reason": "llm"})]):
        pipe.process_text("hello there", mode="ask")
    kinds = [e.get("type") for e in events]
    assert "quota_exceeded" in kinds
    assert kinds[-1] == "done"
    assert any(e.get("type") == "done" and e.get("ok") is False for e in events)
    assert not any(e.get("type") == "done" and e.get("ok") is True for e in events)
