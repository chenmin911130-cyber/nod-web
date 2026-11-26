"""Plain-text answer rules and streamed markdown cleanup."""
from __future__ import annotations

import unittest
from unittest import mock

from server.app import Pipeline
from server.plain_text import (
    PLAIN_TEXT_NOTES_RULE,
    PLAIN_TEXT_OUTPUT_RULE,
    PLAIN_TEXT_TRANSLATE_RULE,
    PlainTextSanitizer,
    sanitize_plain_text,
)


def _pipe() -> Pipeline:
    pipe = Pipeline.__new__(Pipeline)
    pipe.cfg = {"profile": {}, "llm": {}, "stt": {}}
    pipe._qa_history = []
    pipe._heard_lang = "en"
    return pipe


def _stream_join(pieces: list[str]) -> str:
    s = PlainTextSanitizer()
    out = "".join(s.feed(p) for p in pieces)
    out += s.flush()
    return out


def _mid_token_chunks(text: str) -> list[str]:
    """Split text into small uneven chunks that cut through tokens/markers."""
    if len(text) <= 2:
        return [text]
    sizes = (2, 3, 1, 4, 2, 1)
    chunks: list[str] = []
    i = 0
    k = 0
    while i < len(text):
        step = sizes[k % len(sizes)]
        chunks.append(text[i:i + step])
        i += step
        k += 1
    return chunks


# Quinn's probes that MUST remain completely unchanged.
UNCHANGED_PROBES = [
    ("math_spaces", "Use 3 * 4 * 5 then stop."),
    ("math_tight", "Use 3*4 then stop."),
    ("math_tight_three", "Use 3*4*5 then stop."),
    ("pow_starstar", "2**10 is 1024."),
    ("pow_ident", "Compute a**b carefully."),
    ("dunder_init", "Implement __init__ and __repr__."),
    ("dunder_name", "if __name__ == '__main__':"),
    ("kwargs", "def f(**kwargs): pass"),
    ("args_star", "def f(*args): pass"),
    ("identifier_under", "Call foo_bar and my_var now."),
    ("double_under_mid", "Use foo__bar as a name."),
    ("csharp_mid", "C# and F# are languages."),
    ("hashtag_nospace", "#hashtag and #CSharp at line start"),
    ("hashtag_space_line", "# hashtag with a space"),
    ("include", "#include <stdio.h>"),
    ("py_comment_col0", "# comment at column 0"),
    ("py_comment_indented4", "    # comment indented 4 spaces"),
    ("neg_tight", "-5 is negative."),
    ("neg_space", "- 5 is written with a space."),
    ("plus_tight", "+5 is positive."),
    ("plus_space", "+ 5 has a space."),
    ("mid_negative", "The result is -5 degrees."),
    ("decimal", "The value is 1.5 and 3.14."),
    ("numbered", "1. First\n2. Second\n3. Third"),
    ("numbered_decimal_mix", "1. Mix 1.5 into the pot.\n2. Wait 2.0 minutes."),
    ("already_indented", "    def foo():\n        return 1\n"),
    ("glob_star_dot", "Match *.* files."),
    ("glob_star_txt", "Match *.txt files."),
    ("plain_bullets", "• already plain\n1. numbered"),
    ("single_hash_title", "# Title\nBody"),
    ("inline_backticks", "Use `code` and `**bold**` and `__init__` here."),
    ("single_star_italic", "This is *italic* text."),
]


class SanitizePlainTextTests(unittest.TestCase):
    def test_strips_bold_headings_bullets_fences_and_think_tags(self):
        src = (
            "## Title\n"
            "* **Ukraine War:** tanks.\n"
            "This is **bold** and *italic* and `code`.\n"
            "```python\n"
            "def reverse_string(s):\n"
            "    return s[::-1]\n"
            "```\n"
            "<think>secret</think>Visible.<thought>nope</thought>\n"
        )
        out = sanitize_plain_text(src)
        self.assertNotIn("**", out)
        self.assertNotIn("```", out)
        self.assertNotIn("## ", out)
        self.assertNotIn("<think>", out)
        self.assertNotIn("<thought>", out)
        self.assertNotIn("secret", out)
        self.assertNotIn("nope", out)
        self.assertIn("Title", out)
        self.assertIn("Ukraine War:", out)
        self.assertIn("• Ukraine War:", out)
        self.assertIn("bold", out)
        # Conservative policy: leave single-asterisk italics and inline backticks alone.
        self.assertIn("*italic*", out)
        self.assertIn("`code`", out)
        self.assertIn("Visible.", out)
        self.assertIn("    def reverse_string(s):", out)
        self.assertIn("    return s[::-1]", out)
        self.assertNotRegex(out, r"(?m)^[ \t]*\* ")

    def test_leaves_math_asterisks_and_already_plain_bullets(self):
        src = "Use 3 * 4 * 5, then:\n• already plain\n1. numbered"
        out = sanitize_plain_text(src)
        self.assertEqual(out, src)

    def test_empty_and_plain_passthrough(self):
        self.assertEqual(sanitize_plain_text(""), "")
        self.assertEqual(
            sanitize_plain_text("Canberra was chosen as a compromise."),
            "Canberra was chosen as a compromise.",
        )

    def test_quinn_unchanged_probes(self):
        for name, src in UNCHANGED_PROBES:
            with self.subTest(name):
                self.assertEqual(sanitize_plain_text(src), src)

    def test_intentional_changes(self):
        self.assertEqual(sanitize_plain_text("This is **bold** text."), "This is bold text.")
        self.assertEqual(sanitize_plain_text("This is __underlined__ text."), "This is underlined text.")
        self.assertEqual(sanitize_plain_text("* one\n- two"), "• one\n• two")
        self.assertEqual(sanitize_plain_text("## Title\nBody"), "Title\nBody")
        self.assertEqual(sanitize_plain_text("Visible.<think>secret</think>End."), "Visible.End.")
        self.assertEqual(sanitize_plain_text("A<thought>hidden</thought>B"), "AB")

    def test_fenced_code_unwraps_without_corrupting_inner_code(self):
        fenced_py = "```python\ndef reverse_string(s):\n    return s[::-1]\n```"
        out_py = sanitize_plain_text(fenced_py)
        self.assertNotIn("```", out_py)
        self.assertIn("    def reverse_string(s):", out_py)
        self.assertIn("        return s[::-1]", out_py)

        fenced_dunder = "```python\ndef __init__(self):\n    self.x = 2**10\n```"
        out_dunder = sanitize_plain_text(fenced_dunder)
        self.assertNotIn("```", out_dunder)
        self.assertIn("    def __init__(self):", out_dunder)
        self.assertIn("        self.x = 2**10", out_dunder)

        fenced_blank = "```\ndef f():\n\n    return 1\n```"
        out_blank = sanitize_plain_text(fenced_blank)
        self.assertNotIn("```", out_blank)
        self.assertIn("    def f():\n\n        return 1", out_blank)


class SanitizerStreamTests(unittest.TestCase):
    def _join(self, pieces: list[str]) -> str:
        return _stream_join(pieces)

    def test_bold_split_across_chunks_never_emits_markers(self):
        s = PlainTextSanitizer()
        a = s.feed("Hello **")
        self.assertNotIn("**", a)
        b = s.feed("world")
        self.assertNotIn("**", b)
        c = s.feed("**!")
        d = s.flush()
        text = a + b + c + d
        self.assertEqual(text, "Hello world!")
        self.assertNotIn("*", text)

    def test_fence_held_until_closed_then_indented(self):
        s = PlainTextSanitizer()
        a = s.feed("Here:\n```python\n")
        self.assertEqual(a, "Here:\n")
        b = s.feed("x = 1\n```")
        c = s.flush()
        text = a + b + c
        self.assertNotIn("```", text)
        self.assertIn("    x = 1", text)

    def test_flush_preserves_unclosed_markers_conservatively(self):
        self.assertEqual(self._join(["**unclosed"]), "**unclosed")
        self.assertEqual(self._join(["hello `code"]), "hello `code")

    def test_matches_sanitize_of_the_whole_string(self):
        full = "* **A:** one\n* **B:** two\n```\nfn()\n```\n"
        self.assertEqual(
            self._join(list(full)),
            sanitize_plain_text(full),
        )
        # Odd splits around markers.
        parts = ["* *", "*A:**", " one\n*", " **B:** two"]
        self.assertEqual(self._join(parts), sanitize_plain_text("".join(parts)))

    def test_stream_specific_probes_match_whole_sanitize(self):
        # 3*4*5 split as 3*4 + *5 and char-by-char -> 3*4*5
        self.assertEqual(self._join(["3*4", "*5"]), "3*4*5")
        self.assertEqual(self._join(list("3*4*5")), "3*4*5")

        # *italic* char-by-char -> *italic*
        self.assertEqual(self._join(list("*italic*")), "*italic*")

        # __init__ char-by-char -> __init__
        self.assertEqual(self._join(list("__init__")), "__init__")

        # **kwargs and 2**10 char-by-char unchanged
        self.assertEqual(self._join(list("**kwargs")), "**kwargs")
        self.assertEqual(self._join(list("2**10")), "2**10")

        # Think tags split across chunks still strip
        self.assertEqual(
            self._join(["Vis", "ible.<thi", "nk>sec", "ret</th", "ink>End."]),
            "Visible.End.",
        )
        self.assertEqual(
            self._join(list("A<thought>hidden</thought>B")),
            "AB",
        )

    def test_all_quinn_probes_match_streamed_mid_token_and_char_by_char(self):
        cases = list(UNCHANGED_PROBES) + [
            ("bold_plain", "This is **bold** text."),
            ("md_underline", "This is __underlined__ text."),
            ("md_bullets", "* one\n- two"),
            ("bullet_bold", "* **Ukraine War:** tanks."),
            ("heading_h2", "## Title\nBody"),
            ("fenced_py", "```python\ndef reverse_string(s):\n    return s[::-1]\n```"),
            ("fenced_dunder", "```python\ndef __init__(self):\n    self.x = 2**10\n```"),
            ("fenced_blank", "```\ndef f():\n\n    return 1\n```"),
            ("think_block", "Visible.<think>secret</think>End."),
            ("thought_block", "A<thought>hidden</thought>B"),
        ]
        for name, src in cases:
            expected = sanitize_plain_text(src)
            with self.subTest(name=name, mode="mid_token"):
                self.assertEqual(self._join(_mid_token_chunks(src)), expected)
            with self.subTest(name=name, mode="char_by_char"):
                self.assertEqual(self._join(list(src)), expected)


class PromptIncludesPlainTextRuleTests(unittest.TestCase):
    def test_ask_file_ask_listen_ask_share_the_rule(self):
        pipe = _pipe()
        ask = pipe._build_messages("What is TCP?", "ask")[0]["content"]
        file_ask = pipe._build_messages("Summarise this file", "file_ask")[0]["content"]
        listen = pipe._build_messages(
            "[NOD_ASK:auto]\nListener question: Why?\nTranscript (use when relevant):\n(empty)",
            "listen_ask",
        )[0]["content"]
        for sys_msg, label in ((ask, "ask"), (file_ask, "file_ask"), (listen, "listen_ask")):
            with self.subTest(label):
                self.assertIn(PLAIN_TEXT_OUTPUT_RULE, sys_msg)
                self.assertIn("plain text only", sys_msg.lower())
                self.assertIn("• ", sys_msg)

    def test_translate_and_notes_use_mode_specific_rules(self):
        pipe = _pipe()
        translate = pipe._build_messages(
            "Translate to Chinese.\nSource language: English.\nTranslate only this line:\nHello",
            "translate",
        )[0]["content"]
        notes = pipe._build_messages(
            "[NOD_NOTES:auto]\nWrite structured notes for a live session\nSome bullets\n",
            "notes",
        )[0]["content"]
        self.assertIn(PLAIN_TEXT_TRANSLATE_RULE, translate)
        self.assertIn("Output ONLY the translation", translate)
        self.assertNotIn(PLAIN_TEXT_OUTPUT_RULE, translate)
        self.assertIn(PLAIN_TEXT_NOTES_RULE, notes)
        self.assertIn("Return JSON only", notes)
        self.assertNotIn(PLAIN_TEXT_OUTPUT_RULE, notes)

    def test_same_messages_are_used_for_gemini_and_deepseek_fallback(self):
        # There is one builder. The DeepSeek fallback reuses the messages,
        # so the rule cannot drift between providers.
        pipe = _pipe()
        a = pipe._build_messages("Explain a hash table.", "ask")
        b = pipe._build_messages("Explain a hash table.", "ask")
        self.assertEqual(a, b)
        self.assertIn(PLAIN_TEXT_OUTPUT_RULE, a[0]["content"])


class ProcessTextStripsMarkdownTests(unittest.TestCase):
    def _pipeline(self, events):
        pipe = Pipeline.__new__(Pipeline)
        pipe.cfg = {"llm": {"provider": "deepseek", "model": "deepseek-v4-flash", "max_tokens": 80}}
        pipe.emit = events.append
        pipe._provider = "deepseek"
        pipe._model = "deepseek-v4-flash"
        pipe._qa_history = []
        pipe._last_answer = ""
        pipe._cancel = __import__("threading").Event()
        pipe._gen_seq = 0
        pipe.user_id = None
        pipe.usage_session_id = None
        pipe._heard_lang = None
        pipe.client = mock.Mock()
        return pipe

    def _chunks(self, parts: list[str]):
        class _Delta:
            def __init__(self, text):
                self.content = text
                self.reasoning_content = None

        class _Choice:
            def __init__(self, text):
                self.delta = _Delta(text)

        class _Chunk:
            def __init__(self, text):
                self.choices = [_Choice(text)]

        return [_Chunk(p) for p in parts]

    def test_ask_stream_emits_cleaned_text(self):
        events: list[dict] = []
        pipe = self._pipeline(events)
        parts = ["## Hello\n", "* **War:** ", "tanks.\n", "```\nx=1\n```"]
        with mock.patch("server.app.chat_completions_with_gemini_fallback", return_value=self._chunks(parts)):
            pipe.process_text("Give a list.", "ask")
        streamed = "".join(e.get("text") or "" for e in events if e.get("type") == "chunk")
        self.assertTrue(any(e.get("type") == "done" and e.get("ok") is True for e in events))
        self.assertNotIn("**", streamed)
        self.assertNotIn("```", streamed)
        self.assertNotIn("## ", streamed)
        self.assertIn("Hello", streamed)
        self.assertIn("War:", streamed)
        self.assertIn("• ", streamed)
        self.assertIn("    x=1", streamed)
        self.assertEqual(pipe._qa_history[-1]["a"], streamed)

    def test_ask_stream_preserves_python_code_math_and_comments(self):
        events: list[dict] = []
        pipe = self._pipeline(events)
        parts = [
            "def __in",
            "it__(self, **kw",
            "args):\n    self.n = 2*",
            "*10\n",
            "Result: 3*4",
            "*5\n",
            "# comment at column 0\n",
        ]
        with mock.patch("server.app.chat_completions_with_gemini_fallback", return_value=self._chunks(parts)):
            pipe.process_text("Show Python code.", "ask")
        streamed = "".join(e.get("text") or "" for e in events if e.get("type") == "chunk")
        self.assertTrue(any(e.get("type") == "done" and e.get("ok") is True for e in events))
        self.assertIn("__init__", streamed)
        self.assertIn("**kwargs", streamed)
        self.assertIn("2**10", streamed)
        self.assertIn("3*4*5", streamed)
        self.assertIn("# comment at column 0", streamed)
        self.assertEqual(pipe._qa_history[-1]["a"], streamed)

    def test_notes_json_is_not_rewritten(self):
        events: list[dict] = []
        pipe = self._pipeline(events)
        raw = '{"summary": "hello **world**"}'
        with mock.patch("server.app.chat_completions_with_gemini_fallback", return_value=self._chunks([raw])):
            pipe.process_text("[NOD_NOTES:auto]\nWrite structured notes\nTalk", "notes")
        streamed = "".join(e.get("text") or "" for e in events if e.get("type") == "chunk")
        self.assertEqual(streamed, raw)


if __name__ == "__main__":
    unittest.main()
