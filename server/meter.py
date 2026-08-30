from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError

from server.db import Feedback, GlobalDay, HistoryItem, UsageDay, UsageSession, User, db_session, utcnow
from server.security import new_id
from server.settings import (
    DAILY_STT_SECONDS,
    GLOBAL_DAILY_BUDGET_USD,
    LLM_USD_PER_1K_IN,
    LLM_USD_PER_1K_OUT,
    PLANS,
    QUOTA_DISABLED,
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


def stt_limit_seconds(user: User) -> int | None:
    """Monthly transcription cap in seconds. None means unlimited."""
    if QUOTA_DISABLED:
        return None
    raw = getattr(user, "stt_limit_seconds", None)
    if raw is not None:
        return max(0, int(raw))
    return int(plan_of(user)["stt_seconds"])


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
        daily_stt = float(day_row.stt_seconds) if day_row else 0.0
        global_cost = float(glob.cost_usd) if glob else 0.0
        reason = ""
        ok = True
        cap = stt_limit_seconds(user)
        daily_stt_limit = None if QUOTA_DISABLED else DAILY_STT_SECONDS
        if cap is not None and float(stt) >= cap:
            ok, reason = False, "stt"
        if not QUOTA_DISABLED:
            if ok and daily_stt_limit is not None and daily_stt >= daily_stt_limit:
                ok, reason = False, "daily_stt"
            if ok and tokens >= plan["llm_tokens"]:
                ok, reason = False, "llm"
            if daily_cost >= plan["daily_cost_usd"]:
                ok, reason = False, "daily"
            if global_cost >= GLOBAL_DAILY_BUDGET_USD:
                ok, reason = False, "global"
        return {
            "ok": ok,
            "reason": reason,
            "quota_disabled": QUOTA_DISABLED,
            "plan": plan["id"],
            "plan_name": plan["name"],
            "stt_seconds": round(float(stt), 2),
            "stt_limit": cap if cap is not None else plan["stt_seconds"],
            "stt_limit_seconds": cap,
            "daily_stt_seconds": round(daily_stt, 2),
            "daily_stt_limit": daily_stt_limit or 0,
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


def has_recording_consent(user_id: str) -> bool:
    with db_session() as db:
        user = db.get(User, user_id)
        return bool(user and user.recording_consent_at and user.deleted_at is None)


def can_start_session(user_id: str) -> tuple[bool, dict]:
    snap = usage_snapshot(user_id)
    if not snap.get("ok"):
        return False, snap
    if QUOTA_DISABLED:
        return True, snap
    if snap["sessions"] >= snap["session_limit"]:
        snap["ok"] = False
        snap["reason"] = "sessions"
        return False, snap
    return True, snap


def open_usage_session(user_id: str, mode: str, scene: str = "") -> tuple[str | None, dict]:
    from server.history_fmt import normalize_scene, scene_label

    ok, snap = can_start_session(user_id)
    if not ok:
        return None, snap
    sid = new_id()
    scene = normalize_scene(mode, scene)
    with db_session() as db:
        db.add(
            UsageSession(
                id=sid,
                user_id=user_id,
                mode=mode or "interview",
                scene=scene,
                title=f"{scene_label(scene)} · {utcnow().strftime('%b %d %H:%M')}",
                kept=False,
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


def is_session_kept(session_id: str | None) -> bool:
    if not session_id:
        return False
    with db_session() as db:
        row = db.get(UsageSession, session_id)
        return bool(row and row.kept)


def keep_usage_session(
    user_id: str,
    session_id: str,
    keep_content: bool = True,
    keep_audio: bool = True,
) -> None:
    if not user_id or not session_id:
        return
    if not keep_content and not keep_audio:
        discard_usage_session(user_id, session_id)
        return
    from server.r2 import delete_prefix

    with db_session() as db:
        row = db.get(UsageSession, session_id)
        if not row or row.user_id != user_id:
            return
        row.kept = True
        if row.ended_at is None:
            row.ended_at = utcnow()
        if not keep_audio:
            delete_prefix(f"users/{user_id}/sessions/{session_id}/audio/")
            row.audio_key = None
        if not keep_content:
            db.execute(delete(HistoryItem).where(HistoryItem.session_id == session_id))
            if row.notes_key:
                delete_prefix(f"users/{user_id}/sessions/{session_id}/")
            row.notes_key = None


def discard_usage_session(user_id: str | None, session_id: str | None) -> None:
    if not user_id or not session_id:
        return
    from server.r2 import delete_prefix

    delete_prefix(f"users/{user_id}/sessions/{session_id}/")
    with db_session() as db:
        row = db.get(UsageSession, session_id)
        if not row or row.user_id != user_id:
            return
        db.execute(delete(HistoryItem).where(HistoryItem.session_id == session_id))
        db.delete(row)


def delete_history_session(user_id: str, session_id: str) -> bool:
    if not user_id or not session_id:
        return False
    with db_session() as db:
        row = db.get(UsageSession, session_id)
        if not row or row.user_id != user_id:
            return False
    discard_usage_session(user_id, session_id)
    return True


def _ensure_row(db, build, exists) -> None:
    """Insert a counter row, tolerating a concurrent insert of the same key.

    A SAVEPOINT keeps the losing race from poisoning the caller's transaction.
    """
    if exists():
        return
    sp = db.begin_nested()
    try:
        db.add(build())
        sp.commit()
    except IntegrityError:
        sp.rollback()


def _bump(db, user_id: str, stt: float, inp: int, out: int, cost: float) -> None:
    day = _day()
    _ensure_row(
        db,
        lambda: UsageDay(user_id=user_id, day=day),
        lambda: db.execute(
            select(UsageDay.id).where(UsageDay.user_id == user_id, UsageDay.day == day)
        ).scalar_one_or_none()
        is not None,
    )
    # Arithmetic stays in SQL: read-modify-write in Python loses increments
    # when two sessions meter the same day at once.
    db.execute(
        update(UsageDay)
        .where(UsageDay.user_id == user_id, UsageDay.day == day)
        .values(
            stt_seconds=UsageDay.stt_seconds + stt,
            llm_tokens=UsageDay.llm_tokens + inp + out,
            cost_usd=UsageDay.cost_usd + cost,
            request_count=UsageDay.request_count + 1,
        )
    )
    _ensure_row(db, lambda: GlobalDay(day=day), lambda: db.get(GlobalDay, day) is not None)
    db.execute(
        update(GlobalDay)
        .where(GlobalDay.day == day)
        .values(
            stt_seconds=GlobalDay.stt_seconds + stt,
            llm_tokens=GlobalDay.llm_tokens + inp + out,
            cost_usd=GlobalDay.cost_usd + cost,
        )
    )


def consume_stt(user_id: str, seconds: float, session_id: str | None) -> tuple[bool, dict]:
    snap = usage_snapshot(user_id)
    if not snap.get("ok"):
        return False, snap
    cost = _cost_stt(seconds)
    with db_session() as db:
        if session_id:
            db.execute(
                update(UsageSession)
                .where(UsageSession.id == session_id)
                .values(
                    stt_seconds=UsageSession.stt_seconds + seconds,
                    estimated_cost_usd=UsageSession.estimated_cost_usd + cost,
                )
            )
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
            db.execute(
                update(UsageSession)
                .where(UsageSession.id == session_id)
                .values(
                    llm_input_tokens=UsageSession.llm_input_tokens + inp,
                    llm_output_tokens=UsageSession.llm_output_tokens + out,
                    estimated_cost_usd=UsageSession.estimated_cost_usd + cost,
                )
            )
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
            .where(UsageSession.user_id == user_id, UsageSession.kept.is_(True))
            .order_by(UsageSession.started_at.desc())
            .limit(limit)
        ).scalars().all()
        out: list[dict] = []
        file_refs: list[tuple] = []
        for s in sessions:
            items = db.execute(
                select(HistoryItem)
                .where(HistoryItem.session_id == s.id)
                .order_by(HistoryItem.created_at.asc())
                .limit(80)
            ).scalars().all()
            from server.history_fmt import normalize_scene, session_copy_text

            scene = normalize_scene(s.mode, getattr(s, "scene", "") or "")
            item_rows = [{"kind": i.kind, "text": i.text, "at": i.created_at.isoformat() if i.created_at else None, "qid": i.qid} for i in items]
            out.append(
                {
                    "id": s.id,
                    "mode": s.mode,
                    "scene": scene,
                    "title": s.title,
                    "started_at": s.started_at.isoformat() if s.started_at else None,
                    "ended_at": s.ended_at.isoformat() if s.ended_at else None,
                    "stt_seconds": round(s.stt_seconds, 2),
                    "llm_tokens": s.llm_input_tokens + s.llm_output_tokens,
                    "cost_usd": round(s.estimated_cost_usd, 4),
                    "items": item_rows,
                    "copy_text": session_copy_text(s.title, s.mode, scene, item_rows),
                    "files": [],
                }
            )
            file_refs.append((s.id, s.mode, scene, s.started_at, s.audio_key or "", s.notes_key or ""))
    for entry, (sid, mode, scene, started, audio_key, notes_key) in zip(out, file_refs):
        entry["files"] = _session_files(sid, audio_key, notes_key, mode, scene, started)
    return out


def _session_files(
    session_id: str,
    audio_key: str,
    notes_key: str,
    mode: str = "",
    scene: str = "",
    started_at=None,
) -> list[dict]:
    from urllib.parse import quote

    from server.history_fmt import session_download_name
    from server.r2 import list_keys

    files = []
    key = audio_key or ""
    if key.endswith("/"):
        for item in list_keys(key):
            part = item.rsplit("/", 1)[-1]
            if not part:
                continue
            name = session_download_name(mode, scene, started_at, part_name=part)
            files.append({"kind": "audio", "name": name, "href": f"/api/account/files/{session_id}/audio?part={quote(part)}&filename={quote(name)}"})
        if not files and key:
            name = session_download_name(mode, scene, started_at)
            files.append({"kind": "audio", "name": name, "href": f"/api/account/files/{session_id}/audio?filename={quote(name)}"})
    elif key:
        name = session_download_name(mode, scene, started_at)
        files.append({"kind": "audio", "name": name, "href": f"/api/account/files/{session_id}/audio?filename={quote(name)}"})
    pdf_name = session_download_name(mode, scene, started_at, kind="pdf")
    files.insert(0, {"kind": "pdf", "name": pdf_name, "href": ""})
    return files


def set_session_file(session_id: str, *, audio_key: str | None = None, notes_key: str | None = None) -> None:
    with db_session() as db:
        row = db.get(UsageSession, session_id)
        if not row:
            return
        if audio_key:
            row.audio_key = audio_key
        if notes_key:
            row.notes_key = notes_key


def session_file_url(user_id: str, session_id: str, kind: str, part: str | None = None, filename: str = "") -> str:
    from server.history_fmt import session_download_name
    from server.r2 import list_keys, presign

    with db_session() as db:
        row = db.get(UsageSession, session_id)
        if not row or row.user_id != user_id:
            return ""
        key = row.audio_key if kind == "audio" else row.notes_key if kind == "notes" else ""
        mode = row.mode
        scene = getattr(row, "scene", "") or ""
        started = row.started_at
    if not key:
        return ""
    if kind == "audio" and key.endswith("/"):
        keys = list_keys(key)
        if part:
            safe = part.replace("\\", "/").split("/")[-1]
            key = next((item for item in keys if item.rsplit("/", 1)[-1] == safe), "")
        else:
            key = keys[0] if keys else ""
            part = key.rsplit("/", 1)[-1] if key else part
    if not filename:
        filename = session_download_name(mode, scene, started, kind=kind, part_name=part)
    return presign(key, filename=filename) if key else ""


def write_session_notes(user_id: str, session_id: str) -> None:
    from server.r2 import enabled, put_bytes

    if not enabled() or not session_id:
        return
    with db_session() as db:
        session = db.get(UsageSession, session_id)
        if not session or session.user_id != user_id:
            return
        items = db.execute(
            select(HistoryItem)
            .where(HistoryItem.session_id == session_id)
            .order_by(HistoryItem.created_at.asc())
            .limit(400)
        ).scalars().all()
        title = session.title or "Nod session"
        mode = session.mode
        started = session.started_at.isoformat() if session.started_at else ""
    lines = [f"# {title}", "", f"Mode: {mode}", f"Started: {started}", ""]
    for item in items:
        label = (item.kind or "note").upper()
        lines.append(f"## {label}")
        lines.append(item.text.strip())
        lines.append("")
    body = "\n".join(lines).strip() + "\n"
    key = f"users/{user_id}/sessions/{session_id}/notes.txt"
    if put_bytes(key, body.encode("utf-8"), "text/plain; charset=utf-8"):
        set_session_file(session_id, notes_key=key)


def delete_user_data(user_id: str) -> None:
    from server.r2 import delete_prefix

    delete_prefix(f"users/{user_id}/")
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
    today = _day()
    start = datetime.strptime(today, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    with db_session() as db:
        days = db.execute(select(GlobalDay).order_by(GlobalDay.day.desc()).limit(14)).scalars().all()
        users = db.execute(select(func.count()).select_from(User).where(User.deleted_at.is_(None))).scalar() or 0
        signups_today = db.execute(
            select(func.count()).select_from(User).where(User.deleted_at.is_(None), User.created_at >= start)
        ).scalar() or 0
        no_consent = db.execute(
            select(func.count()).select_from(User).where(User.deleted_at.is_(None), User.recording_consent_at.is_(None))
        ).scalar() or 0
        open_sessions = db.execute(select(func.count()).select_from(UsageSession).where(UsageSession.ended_at.is_(None))).scalar() or 0
        feedback_n = db.execute(select(func.count()).select_from(Feedback)).scalar() or 0
        glob = db.get(GlobalDay, today)
        top = db.execute(
            select(UsageDay.user_id, func.sum(UsageDay.cost_usd))
            .group_by(UsageDay.user_id)
            .order_by(func.sum(UsageDay.cost_usd).desc())
            .limit(10)
        ).all()
        return {
            "users": int(users),
            "signups_today": int(signups_today),
            "no_consent": int(no_consent),
            "open_sessions": int(open_sessions),
            "feedback": int(feedback_n),
            "stt_seconds_today": round(float(glob.stt_seconds), 1) if glob else 0,
            "cost_usd_today": round(float(glob.cost_usd), 4) if glob else 0,
            "days": [{"day": d.day, "cost_usd": round(d.cost_usd, 4), "stt_seconds": round(d.stt_seconds, 1), "llm_tokens": d.llm_tokens} for d in days],
            "top_users": [{"user_id": uid, "cost_usd": round(float(cost or 0), 4)} for uid, cost in top],
            "global_daily_budget_usd": GLOBAL_DAILY_BUDGET_USD,
            "quota_disabled": QUOTA_DISABLED,
            **_live_counts(),
        }


def _live_counts() -> dict[str, int]:
    from server.live import snapshot

    return snapshot()


def _user_usage_maps(db, user_ids: list[str]) -> dict[str, dict]:
    if not user_ids:
        return {}
    rows = db.execute(
        select(
            UsageSession.user_id,
            func.coalesce(func.sum(UsageSession.stt_seconds), 0),
            func.coalesce(func.sum(UsageSession.llm_input_tokens + UsageSession.llm_output_tokens), 0),
            func.coalesce(func.sum(UsageSession.estimated_cost_usd), 0),
            func.count(),
            func.max(UsageSession.started_at),
        )
        .where(UsageSession.user_id.in_(user_ids))
        .group_by(UsageSession.user_id)
    ).all()
    out = {}
    for uid, stt, tokens, cost, n, last in rows:
        out[uid] = {
            "stt_seconds": round(float(stt or 0), 1),
            "llm_tokens": int(tokens or 0),
            "cost_usd": round(float(cost or 0), 4),
            "sessions": int(n or 0),
            "last_seen": last.isoformat() if last else None,
        }
    return out


def _public_admin_user(user: User, usage: dict | None = None) -> dict:
    u = usage or {}
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "plan": user.plan,
        "subscription_status": user.subscription_status,
        "consent": bool(user.recording_consent_at),
        "google": bool(user.clerk_id),
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "stt_seconds": u.get("stt_seconds", 0),
        "llm_tokens": u.get("llm_tokens", 0),
        "cost_usd": u.get("cost_usd", 0),
        "sessions": u.get("sessions", 0),
        "last_seen": u.get("last_seen"),
        "stt_limit_seconds": user.stt_limit_seconds,
    }


def admin_users(q: str = "", limit: int = 80) -> list[dict]:
    from sqlalchemy import or_

    with db_session() as db:
        stmt = select(User).where(User.deleted_at.is_(None)).order_by(User.created_at.desc())
        needle = (q or "").strip()
        if needle:
            like = f"%{needle}%"
            stmt = stmt.where(or_(User.email.ilike(like), User.name.ilike(like)))
        users = db.execute(stmt.limit(max(1, min(limit, 200)))).scalars().all()
        usage = _user_usage_maps(db, [u.id for u in users])
        return [_public_admin_user(u, usage.get(u.id)) for u in users]


def admin_user_detail(user_id: str) -> dict | None:
    with db_session() as db:
        user = db.get(User, user_id)
        if user is None or user.deleted_at is not None:
            return None
        usage = _user_usage_maps(db, [user.id]).get(user.id) or {}
    return {
        **_public_admin_user(user, usage),
        "usage": usage_snapshot(user.id),
        "history": list_history(user.id, 30),
    }


def admin_set_stt_limit(user_id: str, minutes: float | None) -> dict | None:
    with db_session() as db:
        user = db.get(User, user_id)
        if user is None or user.deleted_at is not None:
            return None
        if minutes is None:
            user.stt_limit_seconds = None
        else:
            user.stt_limit_seconds = max(0, int(round(float(minutes) * 60)))
    return admin_user_detail(user_id)


def admin_sessions(limit: int = 60) -> list[dict]:
    with db_session() as db:
        rows = db.execute(select(UsageSession).order_by(UsageSession.started_at.desc()).limit(max(1, min(limit, 200)))).scalars().all()
        emails = {}
        ids = {r.user_id for r in rows}
        if ids:
            for u in db.execute(select(User).where(User.id.in_(ids))).scalars().all():
                emails[u.id] = u.email
        return [
            {
                "id": s.id,
                "user_id": s.user_id,
                "email": emails.get(s.user_id, ""),
                "mode": s.mode,
                "title": s.title,
                "started_at": s.started_at.isoformat() if s.started_at else None,
                "ended_at": s.ended_at.isoformat() if s.ended_at else None,
                "stt_seconds": round(s.stt_seconds, 2),
                "llm_tokens": s.llm_input_tokens + s.llm_output_tokens,
                "cost_usd": round(s.estimated_cost_usd, 4),
            }
            for s in rows
        ]


def admin_feedback(limit: int = 80) -> list[dict]:
    with db_session() as db:
        rows = db.execute(select(Feedback).order_by(Feedback.created_at.desc()).limit(max(1, min(limit, 200)))).scalars().all()
        return [
            {
                "id": r.id,
                "user_id": r.user_id,
                "email": r.email,
                "message": r.message,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]
