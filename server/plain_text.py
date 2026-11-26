"""Plain-text output rules for answers shown as-is in the web Notes/Ask
card, the iOS/Capacitor wrap of that UI, and the Watch ``Text(...)``.

None of those clients render markdown, so models must not emit it. The
system-prompt constant is the primary control (Gemini and the DeepSeek
fallback share ``Pipeline._build_messages``). ``PlainTextSanitizer`` is a
hold-back cleaner for leftover markers on a streamed body; it is not used
on the notes JSON stream, which must stay valid JSON.
"""
from __future__ import annotations

import re

# Appended to the ask / file_ask / listen_ask system prompts. Translate and
# notes use the shorter variants below so they do not fight those modes'
# "output only the translation" / "return JSON only" rules.
PLAIN_TEXT_OUTPUT_RULE = (
    "OUTPUT FORMAT (hard rule): Write plain text only. "
    "Do not use markdown: no ** or * for emphasis, no # headings, "
    "no backtick code fences or inline backticks, and no [text](url) links. "
    "Do not start list items with *, - or +. "
    "For lists, use '1. ' numbered lines or lines that start with '• ' "
    "(the bullet character), one item per line. "
    "For code, indent the lines and keep line breaks; do not wrap them in fences. "
    "Keep paragraph and line breaks. Never output <think> or <thought> tags."
)

PLAIN_TEXT_TRANSLATE_RULE = (
    "OUTPUT FORMAT (hard rule): Plain text only — no markdown, no ** or * "
    "emphasis, no # headings, no backticks. Output only the translation."
)

PLAIN_TEXT_NOTES_RULE = (
    "Every JSON string value is plain text only: no markdown, no ** or * "
    "emphasis, no # headings, no backtick fences. Do not wrap the JSON "
    "in a markdown fence."
)

_THINK_BLOCK_RE = re.compile(r"<(think|thought)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_THINK_TAG_RE = re.compile(r"</?(?:think|thought)\b[^>]*>", re.IGNORECASE)
_FENCE_RE = re.compile(r"```[^\n`]*\n?(.*?)```", re.DOTALL)
_FENCE_OPEN_RE = re.compile(r"```[a-zA-Z0-9_+\-]*")
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
_UNDER_RE = re.compile(r"__(.+?)__")
# *italic* / *word* but not 3 * 4 * 5 (spaces inside) and not leftover **.
_ITALIC_RE = re.compile(r"(?<!\*)\*([^*\s][^*]*?[^*\s]|[^*\s])\*(?!\*)")
_INLINE_CODE_RE = re.compile(r"`([^`]+)`")
_HEADING_RE = re.compile(r"(?m)^[ \t]{0,3}#{1,6}[ \t]+")
_BULLET_RE = re.compile(r"(?m)^[ \t]*[*+\-][ \t]+")
# Incomplete constructs that must stay in the hold-back buffer.
_INCOMPLETE_THINK_RE = re.compile(
    r"<(?:t(?:h(?:i(?:n(?:k\b[^>]*)?)?)?)?|t(?:h(?:o(?:u(?:g(?:h(?:t\b[^>]*)?)?)?)?)?)?|/(?:t(?:h(?:i(?:n(?:k\b[^>]*)?)?)?)?|t(?:h(?:o(?:u(?:g(?:h(?:t\b[^>]*)?)?)?)?)?)?))?(?:>.*)?$",
    re.IGNORECASE | re.DOTALL,
)
_OPEN_TAGS = ("<think>", "<thought>")


def sanitize_plain_text(text: str) -> str:
    """Strip leftover markdown markers and thinking tags from a complete string."""
    if not text:
        return text
    text = _THINK_BLOCK_RE.sub("", text)
    text = _THINK_TAG_RE.sub("", text)

    def _unfence(match: re.Match[str]) -> str:
        body = match.group(1)
        lines = body.strip("\n").split("\n")
        indented = "\n".join(("    " + line if line.strip() else line) for line in lines)
        return "\n" + indented + "\n"

    text = _FENCE_RE.sub(_unfence, text)
    text = _FENCE_OPEN_RE.sub("", text)
    text = _BOLD_RE.sub(r"\1", text)
    text = _UNDER_RE.sub(r"\1", text)
    text = text.replace("**", "")
    text = _ITALIC_RE.sub(r"\1", text)
    text = _INLINE_CODE_RE.sub(r"\1", text)
    text = text.replace("`", "")
    text = _HEADING_RE.sub("", text)
    text = _BULLET_RE.sub("• ", text)
    return text



def _unclosed_fence_start(raw: str) -> int:
    """Start index of an opening ``` that has not yet been closed, else -1."""
    last_open = -1
    idx = 0
    open_ = False
    while True:
        i = raw.find("```", idx)
        if i < 0:
            break
        if not open_:
            last_open = i
            open_ = True
        else:
            last_open = -1
            open_ = False
        idx = i + 3
    return last_open


def _incomplete_tail_len(raw: str) -> int:
    """How many trailing characters might still change once more text arrives."""
    if not raw:
        return 0
    low = raw.lower()
    hold = 0

    for tag in _OPEN_TAGS:
        start = low.rfind(tag)
        close = low.rfind(f"</{tag[1:]}")
        if start >= 0 and start > close:
            hold = max(hold, len(raw) - start)

    # Prefix of an opening/closing think tag at the very end, e.g. "<th".
    for i in range(len(raw) - 1, max(-1, len(raw) - 16), -1):
        if raw[i] == "<" and _INCOMPLETE_THINK_RE.search(raw[i:]):
            # Only hold if this suffix is not already a complete tag (those
            # are handled above / by sanitize).
            suffix = raw[i:]
            if ">" not in suffix or _THINK_BLOCK_RE.search(suffix) is None:
                if re.fullmatch(
                    r"</?(?:t|th|thi|thin|think|thought|think\b[^>]*|thought\b[^>]*)>?",
                    suffix,
                    flags=re.IGNORECASE,
                ) or (
                    suffix.startswith("<") and ">" not in suffix
                    and re.match(r"</?(?:t|th|thi|thin|think|thou|thoug|though|thought)", suffix, re.I)
                ):
                    hold = max(hold, len(raw) - i)
            break

    fence_open = _unclosed_fence_start(raw)
    if fence_open >= 0:
        hold = max(hold, len(raw) - fence_open)
    elif not raw.endswith("```") and (raw.endswith("`") or raw.endswith("``")):
        # Trailing 1-2 backticks may grow into a fence or close inline code.
        # A string that already ends with a closed ``` is stable.
        n = 2 if raw.endswith("``") else 1
        hold = max(hold, n)

    if raw.count("**") % 2 == 1:
        hold = max(hold, len(raw) - raw.rfind("**"))
    elif raw.endswith("*"):
        hold = max(hold, 1)

    if raw.count("__") % 2 == 1:
        hold = max(hold, len(raw) - raw.rfind("__"))

    heading = re.search(r"(?:\A|\n)[ \t]{0,3}#{1,6}$", raw)
    if heading:
        start = heading.start()
        if start > 0 and raw[start] == "\n":
            start += 1
        hold = max(hold, len(raw) - start)

    bullet = re.search(r"(?:\A|\n)[ \t]*[*+\-]$", raw)
    if bullet:
        start = bullet.start() if bullet.start() == 0 or raw[bullet.start()] != "\n" else bullet.start() + 1
        hold = max(hold, len(raw) - start)

    return min(hold, len(raw))



def _is_stable_prefix(s: str) -> bool:
    if not s:
        return True
    if _unclosed_fence_start(s) >= 0:
        return False
    if s.count("**") % 2 == 1 or s.count("__") % 2 == 1:
        return False
    return _incomplete_tail_len(s) == 0


def _commit_len(raw: str) -> int:
    """Longest prefix that sanitize_plain_text will not revise when more text arrives."""
    end = len(raw) - _incomplete_tail_len(raw)
    while end > 0 and not _is_stable_prefix(raw[:end]):
        end -= 1
    return end


class PlainTextSanitizer:
    """Hold back incomplete markdown so streamed chunks never flash raw markers."""

    def __init__(self) -> None:
        self._raw = ""
        self._emitted = ""

    def feed(self, piece: str) -> str:
        if not piece:
            return ""
        self._raw += piece
        return self._delta(final=False)

    def flush(self) -> str:
        return self._delta(final=True)

    def _delta(self, *, final: bool) -> str:
        if final:
            cleaned = sanitize_plain_text(self._raw)
        else:
            committed = self._raw[:_commit_len(self._raw)]
            cleaned = sanitize_plain_text(committed)
        if cleaned.startswith(self._emitted):
            delta = cleaned[len(self._emitted):]
        else:
            # Should not happen with a prefix-stable sanitize; skip a
            # duplicate rather than rewind a already-sent chunk.
            delta = ""
        self._emitted = cleaned
        return delta
