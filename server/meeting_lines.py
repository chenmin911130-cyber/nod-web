"""Meeting "incomplete-sentence continuation" decision logic.

AssemblyAI forces a turn boundary after a short (max_turn_silence) pause, so one
spoken sentence can arrive as two finals (the observed "half-sentence" transcript
+ translation). This module decides, for a new final, whether it CONTINUES the
currently-open meeting line (``extend``) or starts a new one (``new``).

Everything here is pure and unit-testable (``tests/test_meeting_merge.py``); the
``Session`` wires only the date/state and emits the events.
"""

from __future__ import annotations

import re
from typing import Any

_ENDS_SENTENCE = ("。", "！", "？", ".", "!", "?", "…")
_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3040-\u30FF\uac00-\ud7af]")


def ends_sentence(text: str) -> bool:
    t = (text or "").strip()
    return bool(t) and t.endswith(_ENDS_SENTENCE)


def starts_lower_latin(text: str) -> bool:
    """AssemblyAI ``format_turns`` keeps a continuation lowercase ("features …")."""
    t = (text or "").strip()
    return bool(t) and t[0].islower() and t[0].isascii() and t[0].isalpha()


def is_cjk(text: str) -> bool:
    return bool(_CJK_RE.search(text or ""))


def join_meeting_text(left: str, right: str) -> str:
    """Merge two fragments, NEVER dropping the right side.

    Unlike ``_join_speech_frags`` (which returns ``a`` on a script change and
    loses the right-hand text), this always keeps both. A mixed-language meeting
    line is allowed; CJK↔CJK joins directly, CJK↔Latin adds a space.
    """
    a = (left or "").strip()
    b = (right or "").strip()
    if not a:
        return b
    if not b:
        return a
    if _CJK_RE.search(a) and _CJK_RE.search(b):
        return a + b
    if a.endswith(("，", "、", ",", "—", "-")):
        return f"{a}{b}" if _CJK_RE.search(b) else f"{a} {b}".strip()
    return f"{a} {b}".strip()


def gap_ms(prev_open: dict[str, Any] | None, nxt: dict[str, Any], now: float) -> tuple[float, bool] | None:
    """(gap in ms, whether it is word-level) between the open line and the new turn.

    Prefer word-level ``first_word_ms - last_word_ms``; when either is missing or
    negative (a pause ends the AssemblyAI session and resets the ms clock), fall
    back to wall-clock ``now - last_final_at``.
    """
    if not prev_open:
        return None
    fw = (nxt or {}).get("first_word_ms")
    lw = prev_open.get("last_word_ms")
    if fw is not None and lw is not None and fw >= lw:
        return float(fw - lw), True
    delta = now - (prev_open.get("last_final_at") or now)
    if delta < 0:
        return None
    return float(delta * 1000.0), False


def decide(prev_open: dict[str, Any] | None, nxt: dict[str, Any], now: float) -> str:
    """``"extend"`` (continue the open line) or ``"new"`` (start a fresh line).

    All of §2.2's rules must pass to extend; any failure is a new line.
    """
    if not prev_open:
        return "new"
    if prev_open.get("closed"):
        return "new"
    if ends_sentence(prev_open.get("text", "")):
        return "new"

    gap = gap_ms(prev_open, nxt, now)
    if gap is None:
        return "new"
    gap_ms_val, word_based = gap
    if word_based and gap_ms_val > 2500:
        return "new"
    if not word_based and gap_ms_val > 3000:
        return "new"

    p = prev_open.get("speaker")
    n = nxt.get("speaker")
    if p and n and p != n:
        return "new"
    if (not p) and n:
        return "new"  # unknown → known: never backfill a speaker
    if p and not n:
        txt = nxt.get("text", "")
        if not (starts_lower_latin(txt) or (is_cjk(txt) and gap_ms_val <= 1000)):
            return "new"

    if now - (prev_open.get("opened_at") or now) > 12:
        return "new"
    if len(prev_open.get("text", "")) + len(nxt.get("text", "")) > 480:
        return "new"
    if (prev_open.get("n_words") or 0) + (nxt.get("n_words") or 0) > 80:
        return "new"
    return "extend"
