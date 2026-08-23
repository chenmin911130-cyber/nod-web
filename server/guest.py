from __future__ import annotations

import hashlib

from sqlalchemy import select

from server.db import GlobalDay, GuestUsage, db_session, utcnow
from server.settings import GLOBAL_DAILY_BUDGET_USD, GUEST_LLM_TOKENS, GUEST_STT_SECONDS, LLM_USD_PER_1K_IN, LLM_USD_PER_1K_OUT, STT_USD_PER_MINUTE


def _day() -> str:
    return utcnow().strftime("%Y-%m-%d")


def _cost_stt(seconds: float) -> float:
    return (seconds / 60.0) * STT_USD_PER_MINUTE


def _cost_llm(inp: int, out: int) -> float:
    return (inp / 1000.0) * LLM_USD_PER_1K_IN + (out / 1000.0) * LLM_USD_PER_1K_OUT


def ip_hash(ip: str) -> str:
    if not ip:
        return ""
    return hashlib.sha256(ip.encode("utf-8")).hexdigest()[:32]


def ensure_guest(guest_id: str, ip: str = "") -> None:
    with db_session() as db:
        row = db.get(GuestUsage, guest_id)
        if row is None:
            db.add(GuestUsage(guest_id=guest_id, ip_hash=ip_hash(ip)))
        elif ip and not row.ip_hash:
            row.ip_hash = ip_hash(ip)
            row.updated_at = utcnow()


def guest_usage_snapshot(guest_id: str) -> dict:
    with db_session() as db:
        row = db.get(GuestUsage, guest_id)
        stt = float(row.stt_seconds) if row else 0.0
        tokens = int(row.llm_tokens) if row else 0
        glob = db.get(GlobalDay, _day())
        global_cost = float(glob.cost_usd) if glob else 0.0
        ok = True
        reason = ""
        if stt >= GUEST_STT_SECONDS:
            ok, reason = False, "guest_stt"
        elif tokens >= GUEST_LLM_TOKENS:
            ok, reason = False, "guest_llm"
        elif global_cost >= GLOBAL_DAILY_BUDGET_USD:
            ok, reason = False, "global"
        return {
            "ok": ok,
            "reason": reason,
            "guest": True,
            "plan": "guest",
            "plan_name": "Guest trial",
            "stt_seconds": round(stt, 2),
            "stt_limit": GUEST_STT_SECONDS,
            "llm_tokens": tokens,
            "llm_limit": GUEST_LLM_TOKENS,
            "sessions": 1 if stt > 0 or tokens > 0 else 0,
            "session_limit": 1,
            "daily_cost_usd": 0.0,
            "daily_cost_limit": 0.0,
            "global_cost_usd": round(global_cost, 4),
            "global_cost_limit": GLOBAL_DAILY_BUDGET_USD,
            "consent": True,
        }


def _bump_global(db, stt: float, inp: int, out: int, cost: float) -> None:
    day = _day()
    glob = db.get(GlobalDay, day)
    if glob is None:
        glob = GlobalDay(day=day)
        db.add(glob)
        db.flush()
    glob.stt_seconds += stt
    glob.llm_tokens += inp + out
    glob.cost_usd += cost


def consume_guest_stt(guest_id: str, seconds: float) -> tuple[bool, dict]:
    snap = guest_usage_snapshot(guest_id)
    if not snap.get("ok"):
        return False, snap
    cost = _cost_stt(seconds)
    with db_session() as db:
        row = db.execute(select(GuestUsage).where(GuestUsage.guest_id == guest_id)).scalar_one_or_none()
        if row is None:
            row = GuestUsage(guest_id=guest_id)
            db.add(row)
            db.flush()
        row.stt_seconds += seconds
        row.updated_at = utcnow()
        _bump_global(db, seconds, 0, 0, cost)
    snap = guest_usage_snapshot(guest_id)
    return bool(snap.get("ok")), snap


def check_guest_can_generate(guest_id: str) -> tuple[bool, dict]:
    snap = guest_usage_snapshot(guest_id)
    return bool(snap.get("ok")), snap


def consume_guest_llm(guest_id: str, inp: int, out: int) -> tuple[bool, dict]:
    snap = guest_usage_snapshot(guest_id)
    if not snap.get("ok"):
        return False, snap
    cost = _cost_llm(inp, out)
    with db_session() as db:
        row = db.execute(select(GuestUsage).where(GuestUsage.guest_id == guest_id)).scalar_one_or_none()
        if row is None:
            row = GuestUsage(guest_id=guest_id)
            db.add(row)
            db.flush()
        row.llm_tokens += inp + out
        row.updated_at = utcnow()
        _bump_global(db, 0, inp, out, cost)
    snap = guest_usage_snapshot(guest_id)
    return bool(snap.get("ok")), snap
