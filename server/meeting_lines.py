"""Meeting "incomplete-sentence continuation" decision logic.

AssemblyAI forces a turn boundary after a short (max_turn_silence) pause, so one
spoken sentence can arrive as two finals (the observed "half-sentence" transcript
+ translation). This module decides, for a new final, whether it CONTINUES the
currently-open meeting line (``extend``) or starts a new one (``new``).

Round 3 (#33): the sentence-boundary rules are the primary signal; the word/char/
age caps are only a pathological fallback for >=3 turns that carry no sentence end
at all; and AssemblyAI's strong-cut "." is recognised as a FALSE period when the
last word is a function word (it is not a real sentence boundary).

Everything here is pure and unit-testable (``tests/test_meeting_merge.py``); the
``Session`` wires only the date/state and emits the events.
"""

from __future__ import annotations

import re
from typing import Any

_ENDS_SENTENCE = ("。", "！", "？", ".", "!", "?", "…")
_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3040-\u30FF\uac00-\ud7af]")
# A sentence-end punctuation followed by whitespace or end-of-text.
_SENTENCE_END_RE = re.compile(r"[.!?…。！？](?=\s|$)")
# Function words that cannot legally close a sentence — STT appends a bogus "." at
# a strong cut, so "…changing me into." is really mid-sentence (#33 §1.3).
_FALSE_PERIOD_WORDS = frozenset({
    "a", "an", "the", "and", "or", "but", "so", "to", "of", "for", "with",
    "into", "onto", "from", "by", "at", "in", "on", "as", "than", "that",
    "which", "who", "because", "if", "when", "while", "until", "is", "are",
    "was", "were", "be", "been", "very", "really", "just", "like", "about",
    "over", "under", "through",
})
# Abbreviations / initials whose "." is not a real sentence boundary.
_ABBR_TOKENS = frozenset({
    "e.g", "i.e", "mr", "dr", "vs", "etc", "ms", "mrs", "no", "st",
    "inc", "ltd", "jr", "sr",
})
# Words that keep their capital when a continuation is re-cased after a false
# period (#33 §1.3): "I", "I'm", "I'll", "I've", "I'd".
_I_WORDS = ("i", "i'm", "i'll", "i've", "i'd")


def ends_sentence(text: str) -> bool:
    t = (text or "").strip()
    return bool(t) and t.endswith(_ENDS_SENTENCE)


def starts_lower_latin(text: str) -> bool:
    """AssemblyAI ``format_turns`` keeps a continuation lowercase ("features …")."""
    t = (text or "").strip()
    return bool(t) and t[0].islower() and t[0].isascii() and t[0].isalpha()


def is_cjk(text: str) -> bool:
    return bool(_CJK_RE.search(text or ""))


# --------------------------------------------------------------------------- #
# Round-3 helpers (#33)
# --------------------------------------------------------------------------- #

def _token_before(text: str, idx: int) -> str:
    """The word token ending just before ``idx`` (a token may contain interior
    periods, e.g. ``e.g``, ``1.5``)."""
    j = idx - 1
    while j >= 0 and (text[j].isalpha() or text[j] == "."):
        j -= 1
    return text[j + 1:idx]


def _is_real_sentence_end(text: str, match: re.Match) -> bool:
    """A sentence-end char that is NOT a decimal point or an abbreviation's "."."""
    ch = match.group(0)
    if ch in "。！？…":
        return True
    if ch in "!?":
        return True
    # Latin '.': reject a decimal ("1.5"), an abbreviation ("e.g.", "Mr."), and
    # a single-capital initial ("J. Doe").
    idx = match.start()
    if idx > 0 and text[idx - 1].isdigit():
        return False
    raw_token = _token_before(text, idx)
    token = raw_token.casefold()
    if token in _ABBR_TOKENS:
        return False
    if raw_token and len(raw_token) == 1 and raw_token.isupper():
        return False
    return True


def last_sentence_index(text: str, *, skip_false_period: bool = False) -> int | None:
    """Index just after the LAST real sentence end in ``text``, or ``None``.

    Round-3 split (#33 §1.1): extend absorbs only up to this point and the
    remainder opens a new line. Also used by the limit fallback (§1.2) to decide
    whether a line can still be closed cleanly at a sentence boundary.

    ``skip_false_period`` is Meeting-only. Translate (#105) keeps the default so
    a trailing function-word '.' still counts as the last end; Meeting skips it
    so that period cannot close the line early.
    """
    t = text or ""
    best: int | None = None
    for m in _SENTENCE_END_RE.finditer(t):
        if not _is_real_sentence_end(t, m):
            continue
        if skip_false_period and false_period(t[: m.end()]):
            continue
        best = m.end()
    return best


def _last_word(text: str) -> str:
    """The final Latin word (punctuation stripped, casefolded)."""
    m = re.search(r"([A-Za-z']+)[.!?…。！？]*$", (text or "").strip())
    return m.group(1).casefold() if m else ""


def _word_at_start(text: str) -> str:
    """The first Latin word (punctuation stripped, casefolded)."""
    m = re.match(r"\s*([A-Za-z']+)", text or "")
    return m.group(1).casefold() if m else ""


def false_period(text: str) -> bool:
    """True when ``text`` ends with a '.' that STT added at a strong cut — the last
    word is a function word, so it cannot legally close a sentence (#33 §1.3)."""
    t = (text or "").strip()
    if not t.endswith("."):
        return False
    return _last_word(t) in _FALSE_PERIOD_WORDS


_MONTH_WORDS = frozenset({
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
})
_AMBIGUOUS_MONTHS = frozenset({"may", "march", "august"})
_DATE_PREP = frozenset({"on", "in", "of", "this", "next", "last"})
_DATE_START_RE = re.compile(
    r"^\s*(?:the\s+)?(?:\d{1,2}(?:st|nd|rd|th)|(?:19|20)\d{2})\b",
    re.IGNORECASE,
)


def _last_word_raw(text: str) -> str:
    m = re.search(r"([A-Za-z']+)[.!?…。！？]*$", (text or "").strip())
    return m.group(1) if m else ""


def _prev_word(text: str) -> str:
    m = re.search(r"([A-Za-z']+)\s+[A-Za-z']+[.!?…。！？]*$", (text or "").strip())
    return m.group(1).casefold() if m else ""


def completable_date_end(text: str) -> bool:
    """True when ``text`` ends with a month that the next turn can complete.

    Months that are also English words (May / March / August) need a capital or
    a date preposition so ``I may.`` is not treated as a date.
    """
    t = (text or "").strip()
    if not t.endswith("."):
        return False
    raw = _last_word_raw(t)
    word = raw.casefold()
    if word not in _MONTH_WORDS:
        return False
    if word in _AMBIGUOUS_MONTHS:
        return raw[:1].isupper() or _prev_word(t) in _DATE_PREP
    return True


def date_continuation_start(text: str) -> bool:
    """True when ``text`` starts with an ordinal, calendar day, or year."""
    return bool(_DATE_START_RE.match(text or ""))


def _date_continuation(prev_open: dict[str, Any], nxt: dict[str, Any], now: float) -> bool:
    """Same speaker, word-level gap 0–500ms, month period + ordinal/year start."""
    p = prev_open.get("speaker")
    n = nxt.get("speaker")
    if not p or not n or p != n:
        return False
    gap = gap_ms(prev_open, nxt, now)
    if gap is None:
        return False
    gap_ms_val, src = gap
    if src != "word" or gap_ms_val < 0 or gap_ms_val > 500:
        return False
    ptxt = prev_open.get("text", "") or ""
    ntxt = nxt.get("text", "") or ""
    return completable_date_end(ptxt) and date_continuation_start(ntxt)


def _pure_latin(word: str) -> bool:
    return bool(word) and all(c.isascii() and c.isalpha() for c in word)


def _lower_first_char(text: str) -> str:
    """Lowercase the first alphabetic char of ``text`` unless it is an ``I`` word
    or a genuine acronym (>=2 uppercase letters, e.g. "NASA"). A lone "A" IS the
    article and gets lowercased."""
    m = re.match(r"\s*([A-Za-z']+)", text or "")
    if not m:
        return text
    word = m.group(1)
    # The pronoun "I"/"I'm"/... keeps its capital even as a continuation; a
    # genuine acronym (>=2 uppercase letters, e.g. "NASA") keeps its caps. The
    # I-words are matched case-insensitively (STT may carry them lowercased),
    # while the acronym check looks at the ORIGINAL casing.
    if word.casefold() in _I_WORDS or (word.isupper() and len(word) > 1):
        return text
    first = next((i for i, c in enumerate(text) if c.isalpha()), None)
    if first is None:
        return text
    return text[:first] + text[first].lower() + text[first + 1:]


def tail_meta(meta: dict[str, Any] | None, text: str, split_at: int) -> dict[str, Any]:
    """Meta for the NEW line opened from the tail after a 1.1 split (#33).

    ``first_word_ms`` is interpolated at the split point (the exact first-word time
    of the tail is unavailable); ``last_word_ms`` stays at the turn end; ``n_words``
    is scaled to the tail's share of the turn. ``turn_order`` is dropped (the turn
    was already dequeued).
    """
    meta = dict(meta or {})
    meta.pop("turn_order", None)
    total = len(text or "")
    total_words = meta.get("n_words") or 0
    if total > 0:
        frac = float(split_at) / total
        fw = meta.get("first_word_ms")
        lw = meta.get("last_word_ms")
        if fw is not None and lw is not None and lw >= fw:
            meta["first_word_ms"] = fw + (lw - fw) * frac
        else:
            meta["first_word_ms"] = None
        meta["last_word_ms"] = lw
        meta["n_words"] = round(total_words * (1 - frac))
    return meta


def join_meeting_text(left: str, right: str, gap_ms: float | None = None) -> str:
    """Merge two fragments, NEVER dropping the right side.

    Unlike ``_join_speech_frags`` (which returns ``a`` on a script change and
    loses the right-hand text), this always keeps both. A mixed-language meeting
    line is allowed; CJK↔CJK joins directly, CJK↔Latin adds a space.

    Round 3 (#33):
    - §1.4 boundary dedup: when ``gap_ms`` is not None and <= 500 and the first
      word of ``right`` repeats the last word of ``left``, drop it (turn 8 "know
      exactly" / turn 9 "exactly where").
    - §1.3 false period: when ``left`` ends with a bogus '.', drop that '.' and
      re-case the continuation's first letter (unless an ``I`` word / acronym).
    """
    a = (left or "").strip()
    b = (right or "").strip()
    if not a:
        return b
    if not b:
        return a
    # §1.4 boundary duplicate word.
    if gap_ms is not None and gap_ms <= 500:
        aw = _last_word(a)
        bw = _word_at_start(b)
        if aw and bw and aw == bw and _pure_latin(aw) and len(aw) >= 4:
            b = re.sub(r"^\s*[A-Za-z']+", "", b, count=1).lstrip()
            if not b:
                return a
    # §1.3 false period: strip the bogus '.' and re-case the continuation.
    # Date continuation (#33 increment): strip the month's cut '.' without
    # recasing the ordinal / year ("September." + "6th" → "September 6th").
    if completable_date_end(a) and date_continuation_start(b):
        a = a[:-1].rstrip()
    elif false_period(a):
        a = a[:-1].rstrip()
        b = _lower_first_char(b)
    if _CJK_RE.search(a) and _CJK_RE.search(b):
        return a + b
    if a.endswith(("，", "、", ",", "—", "-")):
        return f"{a}{b}" if _CJK_RE.search(b) else f"{a} {b}".strip()
    return f"{a} {b}".strip()


def gap_ms(prev_open: dict[str, Any] | None, nxt: dict[str, Any], now: float) -> tuple[float, str] | None:
    """(gap in ms, source) between the open line and the new turn.

    ``source`` is ``"word"`` (word-level ``first_word_ms - last_word_ms``, the
    true silence), or ``"est"`` (estimated: word-level missing on the PREVIOUS
    line but the NEXT turn carries its own span, so we subtract the next turn's
    duration from the wall-clock delta). ``None`` when neither is usable, which
    the caller treats as a ``new`` line.
    """
    if not prev_open:
        return None
    fw = (nxt or {}).get("first_word_ms")
    lw = prev_open.get("last_word_ms")
    if fw is not None and lw is not None and fw >= lw:
        return float(fw - lw), "word"
    nf = (nxt or {}).get("first_word_ms")
    nl = (nxt or {}).get("last_word_ms")
    if nf is not None and nl is not None and nl >= nf:
        delta = now - (prev_open.get("last_final_at") or now)
        if delta < 0:
            return None
        return float(delta * 1000.0 - (nl - nf)), "est"
    return None


def _decide(prev_open: dict[str, Any] | None, nxt: dict[str, Any], now: float) -> tuple[str, str]:
    """``("extend"|"new", reason)``.

    ``reason`` names the rule that made the call (#33 §1.5): ``ends_sentence``,
    ``false_period``, ``date_continuation``, ``gap``, ``speaker``, ``open_age``,
    ``chars``, ``words``, ``split`` (the next turn carries a sentence end to close
    on), or ``no_open`` / ``closed`` for the trivial new cases, else ``ok``. The
    caller logs ``split_at`` / ``tail_len`` separately when §1.1 actually splits.
    """
    if not prev_open:
        return "new", "no_open"
    if _date_continuation(prev_open, nxt, now):
        return "extend", "date_continuation"
    if prev_open.get("closed"):
        return "new", "closed"
    ptxt = prev_open.get("text", "") or ""
    # Is the previous line truly finished?
    if ends_sentence(ptxt):
        if not false_period(ptxt):
            return "new", "ends_sentence"
        # else a bogus '.' — a continuation is plausible; fall through.

    gap = gap_ms(prev_open, nxt, now)
    if gap is None:
        return "new", "gap"
    gap_ms_val, _word_based = gap
    # Both word-level and estimated gaps share the 2.5s threshold.
    if gap_ms_val > 2500:
        return "new", "gap"

    p = prev_open.get("speaker")
    n = nxt.get("speaker")
    if p and n and p != n:
        return "new", "speaker"
    if (not p) and n:
        return "new", "speaker"  # unknown → known: never backfill a speaker
    if p and not n:
        txt = nxt.get("text", "") or ""
        if not (starts_lower_latin(txt) or (is_cjk(txt) and gap_ms_val <= 1000)):
            return "new", "speaker"

    # Pathological caps (#33 §1.2): only reached when >=3 turns carried NO sentence
    # end. They are measured on the PREVIOUS line's own age, not the live clock.
    open_age = (prev_open.get("last_final_at") or prev_open.get("opened_at") or now) - (prev_open.get("opened_at") or now)
    nxt_text = nxt.get("text", "") or ""
    if open_age > 30:
        reason = "open_age"
    elif len(ptxt) + len(nxt_text) > 900:
        reason = "chars"
    elif (prev_open.get("n_words") or 0) + (nxt.get("n_words") or 0) > 150:
        reason = "words"
    else:
        reason = None
    if reason:
        # If the next turn still carries a sentence end, extend — §1.1 will close
        # the line cleanly at it. Only hard-cut when nothing can close on a
        # sentence boundary.
        if last_sentence_index(nxt_text) is not None:
            return "extend", "split"
        return "new", reason

    # All pass → extend. Attribute the reason: a false period let a bogus '.'
    # continue; a sentence end in the next turn means §1.1 splits; else plain ok.
    if false_period(ptxt):
        return "extend", "false_period"
    if last_sentence_index(nxt_text) is not None:
        return "extend", "split"
    return "extend", "ok"


def decide(prev_open: dict[str, Any] | None, nxt: dict[str, Any], now: float) -> str:
    """The decision string (backward-compatible with round-2 callers/tests)."""
    return _decide(prev_open, nxt, now)[0]


def decide_full(prev_open: dict[str, Any] | None, nxt: dict[str, Any], now: float) -> tuple[str, str]:
    """The decision string plus the trace/acceptance reason."""
    return _decide(prev_open, nxt, now)
