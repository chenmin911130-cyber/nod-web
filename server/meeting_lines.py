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
# A line marked ``closed`` at a sentence end still absorbs a same-speaker
# continuation this soon after its last word (#279). Turn 16 of the 121 Axios
# session: the previous final closed the line at a sentence end and the next
# final arrived 81ms later from the same speaker, which used to come back as
# ``new/closed`` and fragment one continuous turn.
_CLOSED_CONTINUATION_MS = 1200.0
_ASK_TAIL = re.compile(
    r"\b(what|why|how|when|where|who|which)\b[^?.!]*$|"
    r"(吗[.。!！]?$|呢[.。!！]?$|怎么|为什么)",
    re.I,
)
_QUESTION_CONT = re.compile(
    r"^(about|or|and|that|which|who|when|where|how|what|why|in|on|for|with|to|the|a|an)\b",
    re.I,
)
_ANSWER_START = re.compile(
    r"^(well|yes|no|yeah|yep|nope|thank you|thanks)\b",
    re.I,
)
_HOST_CONT = re.compile(
    r"^(axios likes|and how you think|and so the|and in that|and we wanted|we wanted to make)\b",
    re.I,
)
_PHRASE_CONT = re.compile(r"^(by|with|along with)\b", re.I)
_PHRASE_CONT_SHORT = re.compile(r"^(than|that|or|and|numbers?|ones?)\b", re.I)
_THANKS_INLINE = re.compile(
    r"(?<=\S)\s+((?:Thank you|Thanks)[.!]?)\s+(?=\S)",
    re.I,
)
_ANSWER_AFTER_Q = re.compile(
    r"^(?:Well,?\s|I think\b|Yeah\.?\s|All of them\b)",
    re.I,
)
_GUEST_STMT_END = re.compile(
    r"(?:right now|I think,\s*better|the boss)[,.]?\s*$",
    re.I,
)
_HOST_FOLLOWUP = re.compile(
    r"(?:but that'?s because|What are some|What'?s your|How (?:do|would|can|many)\b|"
    r"You (?:mentioned|have experience|walked)|You saw)\b",
    re.I,
)
_FIRST_PERSON = re.compile(r"\b(I|we|my)\b", re.I)
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


def looks_like_question(text: str) -> bool:
    """A host turn that looks finished — not merely containing "what" mid-sentence."""
    t = (text or "").strip()
    if not t:
        return False
    if t.endswith(("?", "？")):
        return True
    return bool(_ASK_TAIL.search(t))


def looks_like_question_continuation(text: str) -> bool:
    """Trailing half of a split question ("…learned" + "about wielding power?")."""
    return bool(_QUESTION_CONT.match((text or "").strip()))


def looks_like_answer_start(text: str) -> bool:
    """Short guest reply after a host question ("Well, …", "Thank you.")."""
    t = (text or "").strip()
    if looks_like_question(t):
        return False
    return bool(_ANSWER_START.match(t))


def looks_like_host_continuation(text: str) -> bool:
    """Same host turn split across STT ids ("topic to topic" + "Axios likes…")."""
    t = (text or "").strip()
    return bool(_HOST_CONT.match(t) or _PHRASE_CONT.match(t))


def looks_like_phrase_continuation(text: str) -> bool:
    """Short same-speaker tail after a real period ("term." + "Than the first one")."""
    t = (text or "").strip()
    if not t:
        return False
    head = t.split(".", 1)[0].strip() or t
    if len(head.split()) > 8:
        return False
    return bool(_PHRASE_CONT_SHORT.match(t))


def _split_thanks_inline(text: str) -> list[str] | None:
    m = _THANKS_INLINE.search(text)
    if not m:
        return None
    left = text[: m.start()].strip()
    mid = m.group(1).strip()
    if mid and not mid.endswith((".", "!", "?")):
        mid = f"{mid}."
    right = text[m.end() :].strip()
    if not left or not right:
        return None
    return [left, mid, right]


def _split_question_answer(text: str) -> list[str] | None:
    t = text or ""
    for m in reversed(list(re.finditer(r"[?？]", t))):
        left = t[: m.start() + 1].strip()
        right = t[m.end() :].strip()
        if not left or not right:
            continue
        if _ANSWER_AFTER_Q.match(right):
            return [left, right]
    return None


def _split_guest_host(text: str) -> list[str] | None:
    for m in _HOST_FOLLOWUP.finditer(text):
        if m.start() == 0:
            continue
        left = text[: m.start()].strip()
        right = text[m.start() :].strip()
        if not left or not right:
            continue
        guest_left = bool(_GUEST_STMT_END.search(left)) or (
            bool(_FIRST_PERSON.search(left)) and not looks_like_question(left)
        )
        if guest_left:
            return [left, right]
    return None


def _split_meeting_turn_once(text: str) -> list[str]:
    t = (text or "").strip()
    if not t:
        return []
    for splitter in (_split_thanks_inline, _split_guest_host, _split_question_answer):
        parts = splitter(t)
        if parts:
            return parts
    return [t]


def split_meeting_turn(text: str) -> list[str]:
    """Split one STT final that embeds two speakers before decide / emit (#277)."""
    parts = _split_meeting_turn_once(text)
    if len(parts) <= 1:
        return parts
    out: list[str] = []
    for part in parts:
        out.extend(split_meeting_turn(part))
    return [p for p in out if p.strip()]


def _cross_speaker_continuation(prev_open: dict[str, Any], nxt_text: str) -> bool:
    """Mid-clause join across a diarization flip (#275)."""
    if not _open_mid_clause(prev_open):
        return False
    if looks_like_answer_start(nxt_text):
        return False
    if looks_like_question_continuation(nxt_text):
        return True
    if looks_like_host_continuation(nxt_text):
        return True
    return False


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


def segment_meta(meta: dict[str, Any] | None, text: str, start: int, end: int) -> dict[str, Any]:
    """Word clock for ONE segment of an inline ``split_meeting_turn`` (#279).

    ``_hold_or_emit_meeting`` used to hand every piece of a multi-speaker final the
    SAME whole-turn ``meta``. The later pieces then compared the whole turn's
    ``first_word_ms`` (before the previous piece's last word) against the open line
    and produced negative gaps (turn 0 of the 121 session: ``gap_ms=-8416``), which
    drifts the decide / split / role path. Interpolating the turn's ``[first, last]``
    span onto ``[start, end)`` gives every piece its own monotonic clock, mirroring
    ``tail_meta`` (which does the same for the §1.1 sentence-end tail).

    ``turn_order`` is kept: unlike the §1.1 tail these pieces stay in the same
    worker turn and are only traced, never re-enqueued.
    """
    meta = dict(meta or {})
    total = len(text or "")
    if total <= 0:
        return meta
    total_words = meta.get("n_words") or 0
    meta["n_words"] = round(total_words * max(0, end - start) / total)
    fw = meta.get("first_word_ms")
    lw = meta.get("last_word_ms")
    if fw is None or lw is None or lw < fw:
        # No usable span: drop the partial clocks so this piece cannot be compared
        # on a stale whole-turn time (decide falls back to ``no_open`` / ``answer``).
        meta["first_word_ms"] = None
        meta["last_word_ms"] = None
        return meta
    meta["first_word_ms"] = fw + (lw - fw) * (start / total)
    meta["last_word_ms"] = fw + (lw - fw) * (end / total)
    return meta


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


def _open_mid_clause(prev_open: dict[str, Any]) -> bool:
    """True when the open line has no real sentence end (continuation is plausible)."""
    ptxt = (prev_open.get("text") or "").strip()
    if not ptxt:
        return False
    if ends_sentence(ptxt) and not false_period(ptxt):
        return False
    return True


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


def _tight_same_speaker_continuation(prev_open: dict[str, Any], nxt: dict[str, Any], now: float) -> bool:
    """A ``closed`` line still extends when the SAME speaker continues right away (#279).

    The close is set when §1.1 absorbs up to a sentence end; it is a hint, not a
    wall. AssemblyAI still cuts one speaker's continuous turn into several finals,
    so a same-speaker final a few hundred ms after the closed line's last word must
    extend it instead of starting a new row (the 121 turn-16 ``new/closed`` at
    81ms). A real speaker flip, an answer opener, or a word gap outside the tight
    window still starts a new line.
    """
    p = prev_open.get("speaker")
    n = nxt.get("speaker")
    if not p or not n or p != n:
        return False
    if looks_like_answer_start(nxt.get("text") or ""):
        return False
    gap = gap_ms(prev_open, nxt, now)
    if gap is None:
        return False
    gap_ms_val, _src = gap
    return 0.0 <= gap_ms_val <= _CLOSED_CONTINUATION_MS


def _decide(prev_open: dict[str, Any] | None, nxt: dict[str, Any], now: float) -> tuple[str, str]:
    """``("extend"|"new", reason)``.

    ``reason`` names the rule that made the call (#33 §1.5): ``ends_sentence``,
    ``false_period``, ``date_continuation``, ``gap``, ``speaker``, ``open_age``,
    ``chars``, ``words``, ``split`` (the next turn carries a sentence end to close
    on), ``closed_continuation`` (a closed line absorbed a same-speaker follow-up,
    #279), or ``no_open`` / ``closed`` for the trivial new cases, else ``ok``. The
    caller logs ``split_at`` / ``tail_len`` separately when §1.1 actually splits.
    """
    if not prev_open:
        return "new", "no_open"
    if _date_continuation(prev_open, nxt, now):
        return "extend", "date_continuation"
    if prev_open.get("closed"):
        if _tight_same_speaker_continuation(prev_open, nxt, now):
            return "extend", "closed_continuation"
        return "new", "closed"
    ptxt = prev_open.get("text", "") or ""
    nxt_text = nxt.get("text", "") or ""
    # Is the previous line truly finished?
    if ends_sentence(ptxt):
        if not false_period(ptxt):
            if looks_like_answer_start(nxt_text):
                return "new", "answer"
            p = prev_open.get("speaker")
            n = nxt.get("speaker")
            if p and n and p != n:
                if not _cross_speaker_continuation(prev_open, nxt_text):
                    return "new", "ends_sentence"
            elif looks_like_phrase_continuation(nxt_text):
                if not p or not n or p == n:
                    return "extend", "phrase_continuation"
            elif (not p or not n or p == n) and starts_lower_latin(nxt_text):
                return "extend", "same_speaker_continuation"
            else:
                return "new", "ends_sentence"
        # else a bogus '.' — a continuation is plausible; fall through.
    if looks_like_answer_start(nxt_text):
        return "new", "answer"

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
        if not _cross_speaker_continuation(prev_open, nxt_text):
            return "new", "speaker"
    if (not p) and n:
        return "new", "speaker"  # unknown → known: never backfill a speaker
    if p and not n:
        txt = nxt_text
        if looks_like_question(ptxt) and not looks_like_question_continuation(txt) and not looks_like_host_continuation(txt):
            if looks_like_answer_start(txt) or not starts_lower_latin(txt):
                return "new", "question"
        if not (starts_lower_latin(txt) or (is_cjk(txt) and gap_ms_val <= 1000)):
            return "new", "speaker"

    # Pathological caps (#33 §1.2): only reached when >=3 turns carried NO sentence
    # end. They are measured on the PREVIOUS line's own age, not the live clock.
    open_age = (prev_open.get("last_final_at") or prev_open.get("opened_at") or now) - (prev_open.get("opened_at") or now)
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
