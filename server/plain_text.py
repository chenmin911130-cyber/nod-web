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
_THINK_OPEN_OR_CLOSE_RE = re.compile(r"<(/?)(think|thought)\b[^>]*>", re.IGNORECASE)
_THINK_TAIL_PREFIXES = ("<think", "</think", "<thought", "</thought")
_THINK_TAIL_ATTR_RE = re.compile(r"^</?(?:think|thought)\s", re.IGNORECASE)

_FENCE_RE = re.compile(r"```[^\n`]*\n?(.*?)```", re.DOTALL)
_FENCE_OPEN_LINE_RE = re.compile(r"^```[^\n`]*\n?")
_INLINE_CODE_RE = re.compile(r"(`+)(?!`)(.+?)(?<!`)\1(?!`)")

# Word-boundary emphasis only; never touch intraword ** / __ or arithmetic.
_BOLD_RE = re.compile(
    r"(?<![A-Za-z0-9_*])\*\*(?!\s|\*)([^*\n]+?)(?<!\s)\*\*(?![A-Za-z0-9_*])"
)
_UNDER_RE = re.compile(
    r"(?<![A-Za-z0-9_])__(?!\s|_)([^_\n]+?)(?<!\s)__(?![A-Za-z0-9_])"
)
_BOLD_OPENER_RE = re.compile(r"(?<![A-Za-z0-9_*])\*\*(?:(?!\s|\*)|$)")
_UNDER_OPENER_RE = re.compile(r"(?<![A-Za-z0-9_])__(?:(?!\s|_)|$)")

# ATX headings: 2..6 hashes + space at column 0 only (single # comments survive).
_HEADING_RE = re.compile(r"^#{2,6}[ \t]+")
# Bullets: optional 0-3 spaces, * or - (never +), space, then a letter.
_BULLET_RE = re.compile(r"^[ ]{0,3}[*\-][ \t]+(?=[^\W\d_])")
_BULLET_START_RE = re.compile(r"^[ ]{0,3}[*\-][ \t]+")
_BULLET_PREFIX_RE = re.compile(r"^[ ]{0,3}[*\-][ \t]*$")
_LEADING_SPACES_RE = re.compile(r"^[ ]{1,3}$")
_HEADING_PREFIX_RE = re.compile(r"^#{1,6}$")

# Indented code blocks (4+ spaces / tab) or unfenced Python statement lines.
_CODE_LINE_RE = re.compile(
    r"^(?:[ ]{4}|\t)"
    r"|^[ ]{0,3}(?:(?:async[ ]+)?def|class|if|elif|for|while|return|import)[ \t]"
    r"|^[ ]{0,3}return$"
    r"|^[ ]{0,3}from[ \t]+[A-Za-z0-9_.]+[ \t]+import[ \t]"
)

# Standard Python dunder names kept intact even in plain prose (e.g. __init__).
_PYTHON_DUNDERS = frozenset({
    "init", "new", "del", "repr", "str", "bytes", "format",
    "lt", "le", "eq", "ne", "gt", "ge", "hash", "bool",
    "getattr", "getattribute", "setattr", "delattr", "dir",
    "get", "set", "delete", "slots", "call", "len", "getitem",
    "setitem", "delitem", "missing", "iter", "next", "reversed",
    "contains", "add", "sub", "mul", "matmul", "truediv",
    "floordiv", "mod", "divmod", "pow", "lshift", "rshift",
    "and", "xor", "or", "neg", "pos", "abs", "invert",
    "complex", "int", "float", "index", "round", "trunc",
    "floor", "ceil", "enter", "exit", "await", "aiter", "anext",
    "aenter", "aexit", "name", "main", "doc", "dict", "class",
    "bases", "mro", "module", "qualname", "file", "path",
    "package", "spec", "loader", "cached", "builtins", "all",
    "version", "author", "annotations", "defaults", "kwdefaults",
    "closure", "code", "globals", "func", "self", "wrapped",
    "args", "origin", "parameters", "copy", "deepcopy", "reduce",
    "getstate", "setstate", "sizeof", "fspath", "buffer",
    "subclasses", "instancecheck", "subclasscheck", "prepare",
    "debug", "future", "import",
})


def _is_code_line(line: str) -> bool:
    return bool(_CODE_LINE_RE.match(line))


def _unfence(match: re.Match[str]) -> str:
    body = match.group(1)
    lines = body.strip("\n").split("\n")
    indented = "\n".join(("    " + line if line.strip() else line) for line in lines)
    return "\n" + indented + "\n"


def _strip_underline(seg: str) -> str:
    def _replace(match: re.Match[str]) -> str:
        inner = match.group(1)
        if inner in _PYTHON_DUNDERS:
            return match.group(0)
        start, end = match.span()
        if start > 0 and seg[start - 1] in ("'", '"', "."):
            return match.group(0)
        if end < len(seg) and seg[end] in ("'", '"', "("):
            return match.group(0)
        return inner

    return _UNDER_RE.sub(_replace, seg)


def _sanitize_inline_prose(line: str) -> str:
    """Strip conservative ** / __ outside inline backtick spans."""
    out: list[str] = []
    pos = 0
    for m in _INLINE_CODE_RE.finditer(line):
        if m.start() > pos:
            part = _BOLD_RE.sub(r"\1", line[pos:m.start()])
            out.append(_strip_underline(part))
        out.append(m.group(0))
        pos = m.end()
    if pos < len(line):
        part = _BOLD_RE.sub(r"\1", line[pos:])
        out.append(_strip_underline(part))
    return "".join(out)


def _sanitize_prose(chunk: str) -> str:
    if not chunk:
        return chunk
    out: list[str] = []
    for line_with_nl in chunk.splitlines(keepends=True):
        if line_with_nl.endswith("\r\n"):
            line, nl = line_with_nl[:-2], "\r\n"
        elif line_with_nl.endswith("\n"):
            line, nl = line_with_nl[:-1], "\n"
        else:
            line, nl = line_with_nl, ""
        if _is_code_line(line):
            out.append(line + nl)
            continue
        line = _sanitize_inline_prose(line)
        line = _HEADING_RE.sub("", line)
        line = _BULLET_RE.sub("• ", line)
        out.append(line + nl)
    return "".join(out)


def sanitize_plain_text(text: str) -> str:
    """Conservatively strip leftover markdown markers and thinking tags."""
    if not text:
        return text
    text = _THINK_BLOCK_RE.sub("", text)
    text = _THINK_TAG_RE.sub("", text)

    out: list[str] = []
    pos = 0
    for m in _FENCE_RE.finditer(text):
        if m.start() > pos:
            out.append(_sanitize_prose(text[pos:m.start()]))
        out.append(_unfence(m))
        pos = m.end()

    tail = text[pos:]
    if tail:
        fence_idx = tail.find("```")
        if fence_idx >= 0:
            if fence_idx > 0:
                out.append(_sanitize_prose(tail[:fence_idx]))
            # Unclosed fence: drop only the opening ``` marker line; leave body untouched.
            out.append(_FENCE_OPEN_LINE_RE.sub("", tail[fence_idx:], count=1))
        else:
            out.append(_sanitize_prose(tail))
    return "".join(out)


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
    n = len(raw)
    hold = 0

    # 1. Unclosed <think> / <thought> block.
    open_pos = -1
    open_tag = ""
    for m in _THINK_OPEN_OR_CLOSE_RE.finditer(raw):
        is_close = bool(m.group(1))
        tag = m.group(2).lower()
        if not is_close:
            if open_pos < 0:
                open_pos = m.start()
                open_tag = tag
        elif open_pos >= 0 and tag == open_tag:
            open_pos = -1
            open_tag = ""
    if open_pos >= 0:
        hold = max(hold, n - open_pos)

    # 2. Partial opening/closing think tag at the very end (no '>' yet).
    lt = raw.rfind("<")
    gt = raw.rfind(">")
    if lt > gt:
        tail_low = raw[lt:].lower()
        if any(p.startswith(tail_low) for p in _THINK_TAIL_PREFIXES) or _THINK_TAIL_ATTR_RE.match(tail_low):
            hold = max(hold, n - lt)

    # 3. Unclosed fenced code block ```...
    fence_open = _unclosed_fence_start(raw)
    if fence_open >= 0:
        hold = max(hold, n - fence_open)
        return min(hold, n)

    after_fence = 0
    for m in _FENCE_RE.finditer(raw):
        after_fence = m.end()

    # 4. Trailing 1-2 backticks could grow into a ``` fence.
    tail_after_fence = raw[after_fence:]
    if tail_after_fence.endswith("``"):
        hold = max(hold, 2)
    elif tail_after_fence.endswith("`"):
        hold = max(hold, 1)

    line_start = max(after_fence, raw.rfind("\n") + 1)
    line = raw[line_start:]
    if not line:
        return min(hold, n)

    # 5. Inline backtick spans on the current line.
    last_code_end = 0
    for m in _INLINE_CODE_RE.finditer(line):
        last_code_end = m.end()
        if m.end() == len(line):
            hold = max(hold, n - (line_start + m.start()))
    unmatched_bt = line.find("`", last_code_end)
    if unmatched_bt >= 0:
        hold = max(hold, n - (line_start + unmatched_bt))

    if _is_code_line(line):
        return min(hold, n)

    # 6. Bold (**) and underline (__) spans after the last closed inline code span.
    seg = line[last_code_end:]
    seg_offset = line_start + last_code_end
    if seg:
        last_bold_end = 0
        for m in _BOLD_RE.finditer(seg):
            last_bold_end = m.end()
            if m.end() == len(seg):
                hold = max(hold, n - (seg_offset + m.start()))
        bold_open = _BOLD_OPENER_RE.search(seg, last_bold_end)
        if bold_open:
            hold = max(hold, n - (seg_offset + bold_open.start()))
        elif seg.endswith("*"):
            hold = max(hold, 1)

        last_under_end = 0
        for m in _UNDER_RE.finditer(seg):
            last_under_end = m.end()
            if m.end() == len(seg):
                hold = max(hold, n - (seg_offset + m.start()))
        under_open = _UNDER_OPENER_RE.search(seg, last_under_end)
        if under_open:
            hold = max(hold, n - (seg_offset + under_open.start()))
        elif seg.endswith("_"):
            hold = max(hold, 1)

    # 7. Line-start prefixes that could become indented code, heading, or bullet.
    if _LEADING_SPACES_RE.fullmatch(line) or _HEADING_PREFIX_RE.fullmatch(line) or _BULLET_PREFIX_RE.fullmatch(line):
        hold = max(hold, len(line))
    else:
        bm = _BULLET_START_RE.match(line)
        if bm:
            # If the hold-back reaches the start of the bullet body (e.g. "* **Title**"
            # or "* <think>...</think>"), hold the bullet marker too so "* " is not
            # emitted before it converts to "• ".
            if n - hold <= line_start + bm.end():
                hold = max(hold, len(line))
            elif not _THINK_TAG_RE.sub("", _THINK_BLOCK_RE.sub("", line[bm.end():])):
                hold = max(hold, len(line))

    return min(hold, n)


def _is_stable_prefix(s: str) -> bool:
    if not s:
        return True
    if _unclosed_fence_start(s) >= 0:
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
            self._emitted = cleaned
            return delta
        # Should not happen with a prefix-stable sanitize; skip rather than
        # rewind or corrupt the emitted prefix.
        return ""
