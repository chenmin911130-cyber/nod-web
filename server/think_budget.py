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
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from server.db import ThinkSearchDay, ThinkSearchRecord, ThinkSearchState, db_session, utcnow

TOTAL_ROW = "total"

REASON_DAILY = "DailyLimit"
REASON_TOTAL = "TotalLimit"
REASON_STORE = "BudgetStoreUnavailable"

# The status of a row whose lookup was claimed but has not finished yet. A row in
# this state is NOT a result: whoever finds it must wait for the owner instead of
# paying for the same submit a second time.
STATUS_PENDING = "pending"

# Request-id flavours (see build_request_id): an exact submit action vs. a
# session+question fallback. Only the former may be treated as proof of identity.
SUBMIT_PREFIX = "r-"
QUESTION_PREFIX = "q-"


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


def _sanitize_id(raw: Any, *, limit: int = 56) -> str:
    """Keep an id to characters that are safe in a primary key and a log line."""
    return "".join(ch for ch in str(raw or "") if ch.isalnum() or ch in "-_")[:limit]


def build_request_id(submit_id: str = "", *, session_id: str = "", question: str = "") -> str:
    """The identity of ONE submit event — what the dedupe gate is keyed on.

    Two flavours, and the difference matters:

    - ``r-<submit_id>``: the caller KNOWS the identity of this submit action. A
      duplicate delivery of that action (a replay after a reconnect, the same frame
      handed to two workers, a restart mid-lookup) produces the same key, so the
      gate can prove it is the same request and reuse whatever the first one paid
      for. This is what all three submit entries carry: the client stamps text
      submits, and the server derives the identity for auto-voice and manual
      recordings from the thing being committed.
    - ``q-<hash>``: the caller has no submit identity (an older client, an internal
      caller). The key is then only "this session + this exact question", which must
      NOT be treated as proof that two submissions are the same action: a failure
      stored under it may be retried normally, and a genuinely new submit still
      searches. It exists so an identical question inside one session can at least
      reuse a lookup that actually succeeded.
    """
    clean = _sanitize_id(submit_id)
    if clean:
        return f"{SUBMIT_PREFIX}{clean}"
    digest = hashlib.sha1(
        f"{session_id}\x00{(question or '').strip()}".encode("utf-8", "ignore")
    ).hexdigest()[:32]
    return f"{QUESTION_PREFIX}{digest}"


def is_submit_keyed(request_id: str) -> bool:
    """True when the id names a submit action (not merely a question)."""
    return str(request_id or "").startswith(SUBMIT_PREFIX)


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


def claim(
    request_id: str,
    *,
    session_id: str = "",
    session_gen: int = 0,
    question: str = "",
    attempt: int = 1,
    parent_request_id: str = "",
) -> bool | None:
    """Claim one request id BEFORE any request goes out.

    The primary key is the mutex: the first worker to insert owns the lookup, and a
    concurrent worker — another thread, another process, another deploy, a restart
    that came back to the same submit — finds the row and must wait for/reuse the
    owner's snapshot rather than issue a second paid request. The row is written
    before the budget is reserved, so a crash mid-lookup leaves evidence of the
    attempt instead of a request that nobody knows about.

    ``True`` = this caller owns it, ``False`` = someone else does, ``None`` = the
    store could not be trusted (the caller must NOT search; see the module docstring).
    """
    if not request_id:
        return True
    try:
        with db_session() as db:
            if db.get(ThinkSearchRecord, request_id) is not None:
                return False
            try:
                with db.begin_nested():
                    db.add(
                        ThinkSearchRecord(
                            request_id=request_id,
                            session_id=session_id,
                            session_gen=int(session_gen),
                            question_hash=question_hash(question),
                            attempt=int(attempt),
                            parent_request_id=parent_request_id,
                            status=STATUS_PENDING,
                            sources="",
                            retrieved_at=0.0,
                        )
                    )
            except IntegrityError:
                # Lost the insert race: the winner's row is the truth.
                return False
    except Exception as exc:  # a store we cannot trust must never authorise a spend
        logging.getLogger("nod").warning("think_budget claim failed err=%s", type(exc).__name__)
        return None
    return True


def is_pending(snap: dict[str, Any] | None) -> bool:
    """True for a claimed-but-unfinished row: not a result anybody may reuse yet."""
    return bool(snap) and str(snap.get("status") or "") == STATUS_PENDING


def wait_for_snapshot(request_id: str, *, timeout: float, interval: float = 0.25) -> dict[str, Any] | None:
    """Wait (bounded) for the worker that owns ``request_id`` to finish.

    This is the cross-process half of the dedupe: the loser of the claim waits for
    the winner's snapshot instead of paying again. A row that never finishes (the
    owner died mid-lookup) is returned as-is; the caller reports it honestly and an
    explicit user retry is what creates a new, counted attempt.
    """
    if not request_id:
        return None
    deadline = time.monotonic() + max(0.0, float(timeout))
    snap = find_snapshot(request_id)
    while is_pending(snap) and time.monotonic() < deadline:
        time.sleep(min(float(interval), max(0.0, deadline - time.monotonic())))
        snap = find_snapshot(request_id)
    return snap


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


def find_latest_snapshot(
    session_id: str, question: str, *, exclude_request_id: str = ""
) -> dict[str, Any] | None:
    """The newest record for this session + exact question, whatever its status.

    Used to chain a user-initiated retry to the lookup it follows: the client names
    the ANSWER it is retrying, not the request id, so the previous attempt is found
    by what it was about — including a FAILED one, which is exactly the case a retry
    is allowed to re-issue. The caller's OWN row is excluded in the query (it may
    already exist as the claimed-but-pending record of this very retry).
    """
    if not session_id or not question:
        return None
    digest = question_hash(question)
    try:
        with db_session() as db:
            stmt = (
                select(ThinkSearchRecord)
                .where(
                    ThinkSearchRecord.session_id == session_id,
                    ThinkSearchRecord.question_hash == digest,
                )
                .order_by(ThinkSearchRecord.created_at.desc())
                .limit(1)
            )
            if exclude_request_id:
                stmt = stmt.where(ThinkSearchRecord.request_id != exclude_request_id)
            row = db.execute(stmt).scalars().first()
            return _record_payload(row) if row is not None else None
    except Exception as exc:
        logging.getLogger("nod").warning("think_budget latest lookup failed err=%s", type(exc).__name__)
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
