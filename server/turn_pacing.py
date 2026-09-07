"""Translate-only turn pacing and sentence-tail carry (#105).

ForceEndpoint decisions are pure: CloudListener only sends when these
return a cut reason. split_carry is the §B head/tail split so a mid-sentence
cut does not emit a half line.
"""

from __future__ import annotations

import os
import re
from typing import Any

from server.meeting_lines import false_period, last_sentence_index

_DEFAULT_MIN_MS = 7000
_DEFAULT_GAP_MS = 350
_DEFAULT_MAX_MS = 15000
_CJK_END_RE = re.compile(r"[。！？…]")


def turn_pacing_from_env() -> dict[str, int]:
    return {
        "min_ms": _env_int("NOD_TR_CUT_MIN_MS", _DEFAULT_MIN_MS),
        "gap_ms": _env_int("NOD_TR_CUT_GAP_MS", _DEFAULT_GAP_MS),
        "max_ms": _env_int("NOD_TR_CUT_MAX_MS", _DEFAULT_MAX_MS),
    }


def cut_decision(words: list[dict], cfg: dict, force_inflight: bool) -> str:
    """Return 'none' | 'pause' | 'max' for a Translate partial."""
    if force_inflight:
        return "none"
    open_ms, gap_ms = word_span_ms(words)
    if open_ms is None or gap_ms is None:
        return "none"
    min_ms = int((cfg or {}).get("min_ms", _DEFAULT_MIN_MS))
    need_gap = int((cfg or {}).get("gap_ms", _DEFAULT_GAP_MS))
    max_ms = int((cfg or {}).get("max_ms", _DEFAULT_MAX_MS))
    if open_ms >= max_ms:
        return "max"
    if open_ms >= min_ms and gap_ms >= need_gap:
        return "pause"
    return "none"


def word_span_ms(words: list[dict] | None) -> tuple[int | None, int | None]:
    """(open_ms, gap_ms) from AssemblyAI word timings, or (None, None)."""
    if not isinstance(words, list) or len(words) < 2:
        return None, None
    try:
        start0 = words[0]["start"]
        end_last = words[-1]["end"]
        start_last = words[-1]["start"]
        end_prev = words[-2]["end"]
        open_ms = int(end_last) - int(start0)
        gap_ms = int(start_last) - int(end_prev)
    except (KeyError, TypeError, IndexError, ValueError):
        return None, None
    return open_ms, gap_ms


def split_carry(text: str) -> tuple[str, str]:
    """Split at the last credible sentence end: (head_to_emit, tail_to_carry).

    A false period (function-word + '.') is skipped so "make sure to stay in."
    stays in the tail. CJK 。！？ count even without a following space.
    """
    raw = text or ""
    limit = len(raw)
    while limit > 0:
        prefix = raw[:limit]
        cut = _last_credible_cut(prefix)
        if cut is None:
            return "", raw.strip()
        head = raw[:cut].strip()
        if false_period(head):
            limit = cut - 1
            continue
        return head, raw[cut:].strip()
    return "", raw.strip()


def _last_credible_cut(text: str) -> int | None:
    cut = last_sentence_index(text)
    cjk: int | None = None
    for m in _CJK_END_RE.finditer(text or ""):
        cjk = m.end()
    if cut is None:
        return cjk
    if cjk is None:
        return cut
    return max(cut, cjk)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default
