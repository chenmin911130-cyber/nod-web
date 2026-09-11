#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Live Q&A (interview) semantic buffer + completeness judgement — issue #191.

Pure logic only: no I/O, no Session/Pipeline imports, so the whole decision
surface is unit-testable without a model or a network.

The old interview path judged a single ``_pending_wait`` tuple with a keyword /
unit-count heuristic (``guard_question``) and glued two finals together only
when they arrived less than 2s apart. That silently dropped the earlier half of
a slow STT turn and answered "several words in". This module replaces the
*completeness* decision with the model's, keeps the fragments in an ordered
buffer keyed by STT turn identity (so a re-sent final / revision replaces its
fragment instead of stacking), and never lets a timer promote a ``wait`` into an
answer.
"""

from __future__ import annotations

import json
import re
from typing import Any, Iterable, Sequence

from server.lang import _same_speech_script

# --- verdicts ---------------------------------------------------------------

VERDICT_WAIT = "wait"
VERDICT_BACKGROUND = "background"
VERDICT_READY = "ready"
VERDICTS = (VERDICT_WAIT, VERDICT_BACKGROUND, VERDICT_READY)

# Bounds. Every one of them is projected from server.settings (env-overridable)
# so production can tune without a UI setting.
DEFAULT_BUFFER_MAX_FRAGS = 8
DEFAULT_BUFFER_MAX_SECONDS = 90.0
DEFAULT_BUFFER_MAX_CHARS = 1200
DEFAULT_BACKGROUND_MAX_FRAGS = 6
DEFAULT_CONTEXT_MAX_CHARS = 600
DEFAULT_PRIOR_QA_PAIRS = 2
DEFAULT_MAX_QUESTION_CHARS = 600

_JSON_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)


# --- fragment identity / buffer ---------------------------------------------


def fragment_identity(meta: dict[str, Any] | None, seq: int) -> str:
    """Stable identity for one STT fragment.

    ``stt_turn`` (+ listener id) is the real STT turn id, so a re-delivered
    final or a revision of the same turn REPLACES its fragment in place instead
    of being appended twice. Fragments that arrive without turn identity (the
    synthetic/stop-commit paths) are each their own fragment.
    """
    m = meta or {}
    turn = m.get("stt_turn")
    if turn is not None:
        return f"t{m.get('listener_id') or 0}:{turn}"
    if m.get("stop_commit") or m.get("fallback"):
        return f"s{seq}"
    return f"f{seq}"


def new_fragment(
    text: str,
    lang: str | None,
    *,
    frag_id: str,
    at: float,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    m = meta or {}
    return {
        "id": frag_id,
        "text": (text or "").strip(),
        "lang": lang,
        "at": float(at),
        "turn": m.get("stt_turn"),
        # #182: which STT connection delivered this fragment (see `_STT_RUN_ID` in
        # app.py). Kept on the fragment so a submit identity can tell a re-delivery
        # from a question on a new stream, whose turn numbers restart.
        "stream": str(m.get("stream") or ""),
        "revision": bool(m.get("revision")),
    }


def trim_fragments(
    fragments: Sequence[dict[str, Any]],
    *,
    now: float,
    max_frags: int = DEFAULT_BUFFER_MAX_FRAGS,
    max_seconds: float = DEFAULT_BUFFER_MAX_SECONDS,
    max_chars: int = DEFAULT_BUFFER_MAX_CHARS,
) -> list[dict[str, Any]]:
    """Drop expired/oversized fragments, newest-first, but never the last one.

    The newest fragment is always kept: an expired residue must not become an
    answer, but dropping the fragment we are about to judge would stall the
    live candidate entirely.
    """
    out = [dict(f) for f in fragments]
    if max_frags > 0 and len(out) > max_frags:
        out = out[-max_frags:]
    if max_seconds > 0 and out:
        cutoff = now - max_seconds
        kept = [f for f in out if float(f.get("at") or 0.0) >= cutoff]
        out = kept or out[-1:]
    if max_chars > 0 and len(out) > 1:
        total = sum(len(str(f.get("text") or "")) for f in out)
        while len(out) > 1 and total > max_chars:
            total -= len(str(out[0].get("text") or ""))
            out.pop(0)
    return out


def merge_fragment(
    fragments: Sequence[dict[str, Any]],
    frag: dict[str, Any],
    *,
    now: float,
    max_frags: int = DEFAULT_BUFFER_MAX_FRAGS,
    max_seconds: float = DEFAULT_BUFFER_MAX_SECONDS,
    max_chars: int = DEFAULT_BUFFER_MAX_CHARS,
) -> tuple[list[dict[str, Any]], str]:
    """Append a fragment, or replace the one with the same identity.

    Returns ``(buffer, action)`` where action is ``"append"`` or ``"revision"``.
    """
    out = [dict(f) for f in fragments]
    fid = str(frag.get("id") or "")
    for i, existing in enumerate(out):
        if str(existing.get("id") or "") == fid:
            merged = {**existing, **frag}
            merged["at"] = float(frag.get("at") or now)
            out[i] = merged
            return trim_fragments(
                out, now=now, max_frags=max_frags, max_seconds=max_seconds, max_chars=max_chars
            ), "revision"
    out.append(dict(frag))
    return trim_fragments(
        out, now=now, max_frags=max_frags, max_seconds=max_seconds, max_chars=max_chars
    ), "append"


def join_pair(left: str, right: str) -> str:
    """Join two same-script speech fragments (the meeting path uses this too)."""
    a = (left or "").strip()
    b = (right or "").strip()
    if not a:
        return b
    if not b:
        return a
    if not _same_speech_script(a, b):
        return a
    if b.startswith(a):
        return b
    if a.startswith(b):
        return a
    if re.search(r"[\u4e00-\u9fff\u3040-\u30FF\uac00-\ud7af]$", a) and re.search(
        r"^[\u4e00-\u9fff\u3040-\u30FF\uac00-\ud7af]", b
    ):
        return a + b
    if a.endswith(("，", "、", ",", "—", "-")):
        return a + b if re.search(r"^[\u4e00-\u9fff\u3040-\u30FF]", b) else f"{a} {b}".strip()
    return f"{a} {b}".strip()


def candidate_text(
    fragments: Sequence[dict[str, Any]],
    *,
    max_chars: int = DEFAULT_BUFFER_MAX_CHARS,
) -> str:
    """The running candidate in arrival order (overlap-deduped, bounded)."""
    out = ""
    for f in fragments:
        t = str(f.get("text") or "").strip()
        if not t:
            continue
        out = t if not out else join_pair(out, t)
    if max_chars > 0 and len(out) > max_chars:
        out = out[-max_chars:]
    return out.strip()


def referenced_texts(
    fragments: Sequence[dict[str, Any]], cited_ids: Iterable[str]
) -> list[str]:
    """Fragment texts the model did NOT cite — i.e. lead-in context for the answer."""
    cited = {str(i) for i in (cited_ids or [])}
    return [str(f.get("text") or "").strip() for f in fragments if str(f.get("id")) not in cited]


# --- judgement prompt -------------------------------------------------------

JUDGE_SYSTEM_PROMPT = (
    "You gate a live voice assistant. You receive, in order, the transcript fragments a "
    "speaker has just produced (ids in brackets), optional background lines from the same "
    "conversation, and recent confirmed Q&A.\n"
    "Decide whether the speaker has finished a question or an explicit request that should "
    "be answered NOW.\n"
    "Reply with JSON only, no markdown:\n"
    '{"verdict":"wait|background|ready","question":"...","fragments":["id"],"reason":"short"}\n'
    "- ready: the fragments form one complete question or explicit request, answerable now. "
    'Integrate them into ONE standalone question in the speaker\'s language, resolving '
    'pronouns and follow-ups from the background and Q&A (e.g. "那按年付呢" right after a '
    'monthly-pricing answer becomes "按年付费的价格是多少？"). A short question can be '
    'complete. An explicit request such as "帮我解释一下这个概念" counts as a request when '
    'the background makes the concept clear.\n'
    "- wait: the speaker is still mid-thought, the text ends like an unfinished sentence "
    "(trailing comma, conjunction, preposition, article, or a dangling clause), or a request "
    "still has no referent. A period or full stop added by the transcriber is NOT evidence "
    "that the speaker finished.\n"
    "- background: statements, opinions, facts, introductions or chatter with no question and "
    "no request. A long statement is still background. Never invent a question.\n"
    "- question: only for ready; the standalone integrated question.\n"
    "- fragments: the bracketed ids you actually used; must be a subset of the given ids and "
    "non-empty for ready.\n"
    "Never guess intent that is not there."
)


def _bounded(text: str, limit: int) -> str:
    t = (text or "").strip()
    if limit > 0 and len(t) > limit:
        return t[:limit].rstrip() + "…"
    return t


def build_judge_messages(
    fragments: Sequence[dict[str, Any]],
    background: Sequence[str] | None = None,
    prior_qa: Sequence[dict[str, Any]] | None = None,
    *,
    max_chars: int = DEFAULT_BUFFER_MAX_CHARS,
    prior_pairs: int = DEFAULT_PRIOR_QA_PAIRS,
) -> list[dict[str, str]]:
    lines: list[str] = []
    total = 0
    for f in fragments:
        t = (f.get("text") or "").strip()
        if not t:
            continue
        total += len(t)
        if max_chars > 0 and total > max_chars and lines:
            break
        lines.append(f"[{f.get('id')}] {t}")
    user = "Fragments in order:\n" + ("\n".join(lines) if lines else "(none)")
    bg = [_bounded(b, 200) for b in (background or []) if (b or "").strip()]
    if bg:
        user += "\n\nBackground (earlier non-question lines):\n" + "\n".join(f"- {b}" for b in bg[-4:])
    qa = list(prior_qa or [])
    if prior_pairs > 0 and qa:
        rows = []
        for h in qa[-prior_pairs:]:
            q = _bounded(str((h or {}).get("q") or ""), 200)
            a = _bounded(str((h or {}).get("a") or ""), 200)
            if q:
                rows.append(f"Q: {q}\nA: {a}")
        if rows:
            user += "\n\nRecent confirmed Q&A:\n" + "\n".join(rows)
    return [
        {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


# --- judgement parsing / validation -----------------------------------------


def _extract_json(raw: str) -> Any:
    if not isinstance(raw, str):
        return None
    txt = _JSON_FENCE.sub("", raw.strip())
    if not txt:
        return None
    try:
        return json.loads(txt)
    except (TypeError, ValueError):
        pass
    start = txt.find("{")
    end = txt.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(txt[start : end + 1])
    except (TypeError, ValueError):
        return None


def parse_judge_reply(
    raw: str | None,
    valid_ids: Iterable[str],
    *,
    max_question_chars: int = DEFAULT_MAX_QUESTION_CHARS,
) -> dict[str, Any] | None:
    """Tolerant parse + strict structure validation.

    Returns ``None`` for anything malformed — the caller must then NOT answer a
    fragment (a bad judgement must never turn into a guessed answer).
    """
    obj = _extract_json(raw or "")
    if not isinstance(obj, dict):
        return None
    verdict = str(obj.get("verdict") or "").strip().lower()
    if verdict not in VERDICTS:
        return None
    allowed = {str(i) for i in valid_ids}
    raw_ids = obj.get("fragments")
    ids: list[str] = []
    if isinstance(raw_ids, list):
        for i in raw_ids:
            s = str(i).strip()
            if s in allowed and s not in ids:
                ids.append(s)
    question = str(obj.get("question") or "").strip()
    if verdict == VERDICT_READY:
        if not ids:
            return None  # a ready verdict must cite the fragments it integrated
        if not question or len(question) > max_question_chars:
            return None
    reason = _bounded(str(obj.get("reason") or ""), 120)
    return {"verdict": verdict, "question": question, "fragments": ids, "reason": reason}


# --- answer context ---------------------------------------------------------


def context_block(
    lines: Sequence[str] | None,
    *,
    max_chars: int = DEFAULT_CONTEXT_MAX_CHARS,
) -> str:
    """Bounded background addendum for the ANSWER system prompt.

    It only carries lines the answer prompt does not already have: the recent
    confirmed Q&A enters through ``Pipeline._qa_history`` and is deliberately not
    repeated here.
    """
    kept: list[str] = []
    total = 0
    for raw in lines or []:
        t = (raw or "").strip()
        if not t:
            continue
        if max_chars > 0 and total + len(t) > max_chars:
            break
        kept.append(t)
        total += len(t)
    if not kept:
        return ""
    return (
        "\n\nBackground from this live conversation (not a question — use only if it helps "
        "answer the question):\n" + "\n".join(f"- {t}" for t in kept)
    )


def background_after(
    existing: Sequence[str],
    new_lines: Sequence[str],
    *,
    max_frags: int = DEFAULT_BACKGROUND_MAX_FRAGS,
) -> list[str]:
    """Append background lines, keeping the newest ``max_frags``."""
    out = [t for t in existing if (t or "").strip()]
    for t in new_lines:
        s = (t or "").strip()
        if s:
            out.append(s)
    if max_frags > 0 and len(out) > max_frags:
        out = out[-max_frags:]
    return out
