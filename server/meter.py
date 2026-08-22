from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import delete, func, select

from server.db import GlobalDay, HistoryItem, UsageDay, UsageSession, User, db_session, utcnow
from server.security import new_id
from server.settings import (
    GLOBAL_DAILY_BUDGET_USD,
    LLM_USD_PER_1K_IN,
    LLM_USD_PER_1K_OUT,
    PLANS,
    STT_USD_PER_MINUTE,
)


def _day() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _month_start() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def plan_of(user: User) -> dict:
    pid = user.plan if user.plan in PLANS else "free"
    if user.subscription_status in ("canceled", "unpaid", "incomplete_expired"):
        pid = "free"
    return PLANS[pid]


def _cost_stt(seconds: float) -> float:
    return (seconds / 60.0) * STT_USD_PER_MINUTE


def _cost_llm(inp: int, out: int) -> float:
    return (inp / 1000.0) * LLM_USD_PER_1K_IN + (out / 1000.0) * LLM_USD_PER_1K_OUT


def usage_snapshot(user_id: str) -> dict:
    with db_session() as db:
        user = db.get(User, user_id)
        if user is None:
            return {"ok": False, "reason": "no_user"}
        plan = plan_of(user)
        start = _month_start()
        stt = (
            db.execute(
                select(func.coalesce(func.sum(UsageSession.stt_seconds), 0)).where(
                    UsageSession.user_id == user_id,
                    UsageSession.started_at >= start,
                )
            ).scalar()
            or 0
        )
        inp = (
            db.execute(
                select(func.coalesce(func.sum(UsageSession.llm_input_tokens), 0)).where(
                    UsageSession.user_id == user_id,
                    UsageSession.started_at >= start,
                )
            ).scalar()
            or 0
        )
        out = (
            db.execute(
                select(func.coalesce(func.sum(UsageSession.llm_output_tokens), 0)).where(
                    UsageSession.user_id == user_id,
                    UsageSession.started_at >= start,
                )
            ).scalar()
            or 0
        )
        sessions = (
            db.execute(
                select(func.count()).select_from(UsageSession).where(
                    UsageSession.user_id == user_id,
                    UsageSession.started_at >= start,
                )
            ).scalar()
            or 0
        )
        day_row = db.execute(select(UsageDay).where(UsageDay.user_id == user_id, UsageDay.day == _day())).scalar_one_or_none()
        glob = db.get(GlobalDay, _day())
        tokens = int(inp) + int(out)
        daily_cost = float(day_row.cost_usd) if day_row else 0.0
        global_cost = float(glob.cost_usd) if glob else 0.0
        reason = ""
        ok = True
        if stt >= plan["stt_seconds"]:
            ok, reason = False, "stt"
        elif tokens >= plan["llm_tokens"]:
            ok, reason = False, "llm"
        elif sessions >= plan["sessions"] and sessions > 0 and plan["sessions"] <= sessions:
            # still allow continuing an open session; new sessions blocked separately
            pass
        if daily_cost >= plan["daily_cost_usd"]:
            ok, reason = False, "daily"
        if global_cost >= GLOBAL_DAILY_BUDGET_USD:
            ok, reason = False, "global"
        return {
            "ok": ok,
            "reason": reason,
            "plan": plan["id"],
            "plan_name": plan["name"],
            "stt_seconds": round(float(stt), 2),
            "stt_limit": plan["stt_seconds"],
            "llm_tokens": tokens,
            "llm_limit": plan["llm_tokens"],
            "sessions": int(sessions),
            "session_limit": plan["sessions"],
            "daily_cost_usd": round(daily_cost, 4),
            "daily_cost_limit": plan["daily_cost_usd"],
            "global_cost_usd": round(global_cost, 4),
            "global_cost_limit": GLOBAL_DAILY_BUDGET_USD,
            "consent": bool(user.recording_consent_at),
        }


def can_start_session(user_id: str) -> tuple[bool, dict]:
    snap = usage_snapshot(user_id)
    if not snap.get("ok"):
        return False, snap
    if snap["sessions"] >= snap["session_limit"]:
        snap["ok"] = False
        snap["reason"] = "sessions"
        return False, snap
    return True, snap


def open_usage_session(user_id: str, mode: str) -> tuple[str | None, dict]:
    ok, snap = can_start_session(user_id)
    if not ok:
        return None, snap
    sid = new_id()
    with db_session() as db:
        db.add(
            UsageSession(
                id=sid,
                user_id=user_id,
                mode=mode or "interview",
                title=f"{(mode or 'interview').title()} · {utcnow().strftime('%b %d %H:%M')}",
            )
        )
    snap = usage_snapshot(user_id)
    snap["session_id"] = sid
    return sid, snap


def close_usage_session(session_id: str | None) -> None:
    if not session_id:
        return
    with db_session() as db:
        row = db.get(UsageSession, session_id)
        if row and row.ended_at is None:
            row.ended_at = utcnow()


def _bump(db, user_id: str, stt: float, inp: int, out: int, cost: float) -> None:
    day = _day()
    row = db.execute(select(UsageDay).where(UsageDay.user_id == user_id, UsageDay.day == day)).scalar_one_or_none()
    if row is None:
        row = UsageDay(user_id=user_id, day=day)
        db.add(row)
        db.flush()
    row.stt_seconds += stt
    row.llm_tokens += inp + out
    row.cost_usd += cost
    row.request_count += 1
    glob = db.get(GlobalDay, day)
    if glob is None:
        glob = GlobalDay(day=day)
        db.add(glob)
        db.flush()
    glob.stt_seconds += stt
    glob.llm_tokens += inp + out
    glob.cost_usd += cost


def consume_stt(user_id: str, seconds: float, session_id: str | None) -> tuple[bool, dict]:
    snap = usage_snapshot(user_id)
    if not snap.get("ok"):
        return False, snap
    cost = _cost_stt(seconds)
    with db_session() as db:
        if session_id:
            row = db.get(UsageSession, session_id)
            if row:
                row.stt_seconds += seconds
                row.estimated_cost_usd += cost
        _bump(db, user_id, seconds, 0, 0, cost)
    snap = usage_snapshot(user_id)
    return bool(snap.get("ok")), snap


def check_can_generate(user_id: str) -> tuple[bool, dict]:
    snap = usage_snapshot(user_id)
    return bool(snap.get("ok")), snap


def consume_llm(
    user_id: str,
    session_id: str | None,
    inp: int,
    out: int,
) -> tuple[bool, dict]:
    cost = _cost_llm(inp, out)
    with db_session() as db:
        if session_id:
            row = db.get(UsageSession, session_id)
            if row:
                row.llm_input_tokens += inp
                row.llm_output_tokens += out
                row.estimated_cost_usd += cost
        _bump(db, user_id, 0, inp, out, cost)
    snap = usage_snapshot(user_id)
    return bool(snap.get("ok")), snap


def save_history(user_id: str, session_id: str | None, kind: str, text: str, qid: str = "") -> None:
    if not session_id or not (text or "").strip():
        return
    with db_session() as db:
        db.add(
            HistoryItem(
                id=new_id(),
                user_id=user_id,
                session_id=session_id,
                kind=kind,
                qid=qid,
                text=text[:20000],
            )
        )
        row = db.get(UsageSession, session_id)
        if row and kind in ("question", "transcript") and not row.title.startswith("Q ·"):
            preview = text.strip().split("\n")[0][:80]
            if preview:
                row.title = preview


def list_history(user_id: str, limit: int = 40) -> list[dict]:
    with db_session() as db:
        sessions = db.execute(
            select(UsageSession)
            .where(UsageSession.user_id == user_id)
            .order_by(UsageSession.started_at.desc())
            .limit(limit)
        ).scalars().all()
        out = []
        for s in sessions:
            items = db.execute(
                select(HistoryItem)
                .where(HistoryItem.session_id == s.id)
                .order_by(HistoryItem.created_at.asc())
                .limit(80)
            ).scalars().all()
            out.append(
                {
                    "id": s.id,
                    "mode": s.mode,
                    "title": s.title,
                    "started_at": s.started_at.isoformat() if s.started_at else None,
                    "ended_at": s.ended_at.isoformat() if s.ended_at else None,
                    "stt_seconds": round(s.stt_seconds, 2),
                    "llm_tokens": s.llm_input_tokens + s.llm_output_tokens,
                    "cost_usd": round(s.estimated_cost_usd, 4),
                    "items": [{"kind": i.kind, "text": i.text, "at": i.created_at.isoformat() if i.created_at else None} for i in items],
                }
            )
        return out


def delete_user_data(user_id: str) -> None:
    with db_session() as db:
        db.execute(delete(HistoryItem).where(HistoryItem.user_id == user_id))
        db.execute(delete(UsageSession).where(UsageSession.user_id == user_id))
        db.execute(delete(UsageDay).where(UsageDay.user_id == user_id))
        user = db.get(User, user_id)
        if user:
            user.deleted_at = utcnow()
            user.email = f"deleted-{user_id[:10]}@invalid.local"
            user.password_hash = hash_placeholder()
            user.name = ""
            user.stripe_customer_id = ""
            user.stripe_subscription_id = ""
            user.recording_consent_at = None


def hash_placeholder() -> str:
    from server.security import hash_password

    return hash_password(new_id())


def admin_overview() -> dict:
    with db_session() as db:
        days = db.execute(select(GlobalDay).order_by(GlobalDay.day.desc()).limit(14)).scalars().all()
        users = db.execute(select(func.count()).select_from(User).where(User.deleted_at.is_(None))).scalar() or 0
        top = db.execute(
            select(UsageDay.user_id, func.sum(UsageDay.cost_usd))
            .group_by(UsageDay.user_id)
            .order_by(func.sum(UsageDay.cost_usd).desc())
            .limit(10)
        ).all()
        return {
            "users": int(users),
            "days": [{"day": d.day, "cost_usd": round(d.cost_usd, 4), "stt_seconds": round(d.stt_seconds, 1), "llm_tokens": d.llm_tokens} for d in days],
            "top_users": [{"user_id": uid, "cost_usd": round(float(cost or 0), 4)} for uid, cost in top],
            "global_daily_budget_usd": GLOBAL_DAILY_BUDGET_USD,
        }
