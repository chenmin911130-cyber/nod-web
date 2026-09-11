"""#182: the search budget gate — reserved BEFORE any Parallel request.

Why a gate at all: the Parallel key is a real, finite account (the trial assumes
~US$20 of search credit), and a bug that loops a search would burn it silently.
The order therefore requires, all server-side and with no UI:

- at most ONE search per committed question (enforced at the call site),
- a project-wide cap per fixed UTC day (default 100),
- a cumulative trial cap that survives restarts and deploys (default 3000),
- the reservation to be atomic (a guarded UPDATE inside one transaction, so
  concurrent workers cannot overshoot),
- and, when the store cannot be trusted, to REFUSE the search — never to guess.

A reservation is never released. A request that was sent but timed out may still
have been billed, so refunding it would under-count the very thing the gate
exists to measure.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update

from server.db import ThinkSearchDay, ThinkSearchRecord, ThinkSearchState, db_session, utcnow

TOTAL_ROW = "total"

REASON_DAILY = "DailyLimit"
REASON_TOTAL = "TotalLimit"
REASON_STORE = "BudgetStoreUnavailable"


@dataclass(frozen=True)
class Reservation:
    """The gate's verdict for one prospective search."""

    allowed: bool
    reason: str = ""
    day_attempts: int = 0
    total_attempts: int = 0


def utc_day(now: datetime | None = None) -> str:
    """The fixed UTC day bucket (the boundary is UTC, not local time)."""
    stamp = now or datetime.now(timezone.utc)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc).strftime("%Y-%m-%d")


def question_hash(question: str) -> str:
    """A stable hash of the question, for retry matching only (never the text)."""
    return hashlib.sha1((question or "").strip().encode("utf-8", "ignore")).hexdigest()[:40]


def reserve(*, daily_limit: int, total_limit: int, now: datetime | None = None) -> Reservation:
    """Atomically claim one search attempt, or refuse with the reason.

    Both caps are claimed under guarded UPDATEs in one transaction: a cap that is
    already reached makes the statement match zero rows, and the whole reservation
    rolls back, so a refusal costs nothing and a success can never overshoot.
    """
    day = utc_day(now)
    try:
        with db_session() as db:
            _ensure_rows(db, day)
            day_res = db.execute(
                update(ThinkSearchDay)
                .where(ThinkSearchDay.day == day, ThinkSearchDay.attempts < int(daily_limit))
                .values(attempts=ThinkSearchDay.attempts + 1, last_at=utcnow())
            )
            if day_res.rowcount != 1:
                db.rollback()
                return Reservation(False, REASON_DAILY, *_counts(db, day))
            total_res = db.execute(
                update(ThinkSearchState)
                .where(ThinkSearchState.id == TOTAL_ROW, ThinkSearchState.attempts < int(total_limit))
                .values(attempts=ThinkSearchState.attempts + 1, last_at=utcnow())
            )
            if total_res.rowcount != 1:
                db.rollback()
                return Reservation(False, REASON_TOTAL, *_counts(db, day))
            day_attempts = db.execute(
                select(ThinkSearchDay.attempts).where(ThinkSearchDay.day == day)
            ).scalar_one()
            total_attempts = db.execute(
                select(ThinkSearchState.attempts).where(ThinkSearchState.id == TOTAL_ROW)
            ).scalar_one()
    except Exception as exc:  # a store we cannot trust must never authorise a spend
        logging.getLogger("nod").warning("think_budget reserve failed err=%s", type(exc).__name__)
        return Reservation(False, REASON_STORE)
    return Reservation(True, "", day_attempts, total_attempts)


def _ensure_rows(db, day: str) -> None:
    """Create this day's row and the total row if they are missing.

    Two workers can reach this at the same moment, so the insert runs inside a
    SAVEPOINT and a lost race is swallowed: the loser simply finds the winner's
    row and carries on. Without the savepoint the IntegrityError would poison the
    whole reservation transaction and the search would be refused for no reason.
    """
    if db.execute(select(ThinkSearchState.id).where(ThinkSearchState.id == TOTAL_ROW)).first() is None:
        _insert_ignoring_duplicate(db, ThinkSearchState(id=TOTAL_ROW, attempts=0))
    if db.execute(select(ThinkSearchDay.day).where(ThinkSearchDay.day == day)).first() is None:
        _insert_ignoring_duplicate(db, ThinkSearchDay(day=day, attempts=0))
    db.flush()


def _insert_ignoring_duplicate(db, row) -> None:
    from sqlalchemy.exc import IntegrityError

    try:
        with db.begin_nested():
            db.add(row)
    except IntegrityError:
        pass


def _counts(db, day: str) -> tuple[int, int]:
    try:
        day_attempts = db.execute(
            select(ThinkSearchDay.attempts).where(ThinkSearchDay.day == day)
        ).scalar() or 0
        total_attempts = db.execute(
            select(ThinkSearchState.attempts).where(ThinkSearchState.id == TOTAL_ROW)
        ).scalar() or 0
    except Exception:
        return 0, 0
    return int(day_attempts), int(total_attempts)


def record_attempt(
    request_id: str,
    *,
    question: str,
    session_id: str = "",
    session_gen: int = 0,
    attempt: int = 1,
    parent_request_id: str = "",
    status: str = "",
    sources: dict[str, Any] | None = None,
    retrieved_at: float = 0.0,
) -> bool:
    """Persist the dedupe/snapshot record for this request id.

    Returns False when the record could not be written: the answer still goes out
    (the search already happened and may be billed), but the caller is expected to
    log it — a missing record only costs reuse, never correctness.
    """
    if not request_id:
        return False
    payload = ""
    if sources:
        try:
            payload = json.dumps(sources, ensure_ascii=False)[:20000]
        except (TypeError, ValueError):
            payload = ""
    try:
        with db_session() as db:
            row = db.get(ThinkSearchRecord, request_id)
            if row is None:
                db.add(
                    ThinkSearchRecord(
                        request_id=request_id,
                        session_id=session_id,
                        session_gen=int(session_gen),
                        question_hash=question_hash(question),
                        attempt=int(attempt),
                        parent_request_id=parent_request_id,
                        status=status,
                        sources=payload,
                        retrieved_at=float(retrieved_at or 0.0),
                    )
                )
            else:
                row.session_id = session_id or row.session_id
                row.session_gen = int(session_gen or row.session_gen)
                row.question_hash = question_hash(question) or row.question_hash
                row.attempt = int(attempt)
                row.parent_request_id = parent_request_id
                row.status = status
                row.sources = payload
                row.retrieved_at = float(retrieved_at or 0.0)
    except Exception as exc:
        logging.getLogger("nod").warning(
            "think_budget record failed request=%s err=%s", request_id, type(exc).__name__
        )
        return False
    return True


def find_snapshot(request_id: str) -> dict[str, Any] | None:
    """The stored snapshot for this exact request id, if there is one.

    This is what makes a duplicate/concurrent submit of the SAME request free: it
    reuses the search that was already paid for instead of issuing another.
    """
    if not request_id:
        return None
    try:
        with db_session() as db:
            row = db.get(ThinkSearchRecord, request_id)
            if row is None:
                return None
            return _record_payload(row)
    except Exception as exc:
        logging.getLogger("nod").warning(
            "think_budget lookup failed request=%s err=%s", request_id, type(exc).__name__
        )
        return None


def find_question_snapshot(session_id: str, question: str) -> dict[str, Any] | None:
    """The newest OK snapshot for the same session + exact question text.

    Used only for an explicit user retry of the same question. An exact hash match
    is required — a similar question (or the same text in a different turn) is a
    legitimate new question and must be searched on its own.
    """
    if not session_id or not question:
        return None
    digest = question_hash(question)
    try:
        with db_session() as db:
            row = db.execute(
                select(ThinkSearchRecord)
                .where(
                    ThinkSearchRecord.session_id == session_id,
                    ThinkSearchRecord.question_hash == digest,
                    ThinkSearchRecord.status == "ok",
                )
                .order_by(ThinkSearchRecord.created_at.desc())
                .limit(1)
            ).scalars().first()
            return _record_payload(row) if row is not None else None
    except Exception as exc:
        logging.getLogger("nod").warning("think_budget retry lookup failed err=%s", type(exc).__name__)
        return None


def _record_payload(row: ThinkSearchRecord) -> dict[str, Any]:
    sources: dict[str, Any] | None = None
    if row.sources:
        try:
            parsed = json.loads(row.sources)
            sources = parsed if isinstance(parsed, dict) else None
        except (TypeError, ValueError):
            sources = None
    return {
        "request_id": row.request_id,
        "session_id": row.session_id,
        "session_gen": int(row.session_gen or 0),
        "attempt": int(row.attempt or 1),
        "parent_request_id": row.parent_request_id or "",
        "status": row.status or "",
        "sources": sources,
        "retrieved_at": float(row.retrieved_at or 0.0),
    }
