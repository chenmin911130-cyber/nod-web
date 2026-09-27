"""Meeting line caps (#332).

A closed line (and a line that already ends a real sentence) must not absorb
another same-speaker continuation once it has reached the soft cap. The hard
fallback is tighter than the old 30s / 900 chars / 150 words.

``split_index`` is imported inside the tests that use it so a missing symbol
on the baseline does not hide the other assertions.
"""

import unittest
from unittest import mock

from server.meeting_lines import decide_full
from tests.test_meeting_merge import _Clock, _events, _session


def _gap_nxt(text: str, *, last_ms: int, gap_ms: int, n_words: int = 4) -> dict:
    return {
        "text": text,
        "speaker": "A",
        "first_word_ms": last_ms + gap_ms,
        "last_word_ms": last_ms + gap_ms + 2000,
        "n_words": n_words,
    }


def _line(text: str, *, closed: bool = False, opened_at: float = 0.0, last_final_at: float = 0.0,
          last_word_ms: int = 1000, n_words: int = 4) -> dict:
    prev = {
        "id": "q1",
        "text": text,
        "speaker": "A",
        "opened_at": opened_at,
        "last_final_at": last_final_at,
        "last_word_ms": last_word_ms,
        "n_words": n_words,
        "rev": 0,
    }
    if closed:
        prev["closed"] = True
    return prev


class MeetingLineCapTests(unittest.TestCase):
    def test_closed_latin_over_soft_cap_is_closed_cap(self) -> None:
        # 210 >= 200. Baseline returns extend/closed_continuation.
        prev = _line("a" * 209 + ".", closed=True, last_word_ms=10000)
        nxt = _gap_nxt("features continue from here", last_ms=10000, gap_ms=81)
        self.assertEqual(decide_full(prev, nxt, 0.0), ("new", "closed_cap"))

    def test_closed_short_latin_still_closed_continuation(self) -> None:
        prev = _line("and that is the whole point.", closed=True, last_word_ms=10000, n_words=7)
        nxt = _gap_nxt(
            "we wanted to make this more of a conversation",
            last_ms=10000, gap_ms=81, n_words=9,
        )
        self.assertEqual(len(prev["text"]), 28)
        self.assertEqual(decide_full(prev, nxt, 0.0), ("extend", "closed_continuation"))

    def test_closed_cjk_soft_cap(self) -> None:
        long_prev = _line("会" * 84 + "。", closed=True, last_word_ms=5000)
        short_prev = _line("会" * 59 + "。", closed=True, last_word_ms=5000)
        nxt = _gap_nxt("继续说下去", last_ms=5000, gap_ms=200)
        self.assertEqual(len(long_prev["text"]), 85)
        self.assertEqual(len(short_prev["text"]), 60)
        self.assertEqual(decide_full(long_prev, nxt, 0.0), ("new", "closed_cap"))
        self.assertEqual(decide_full(short_prev, nxt, 0.0), ("extend", "closed_continuation"))

    def test_closed_age_soft_cap(self) -> None:
        text = "short closed line that stays under the char cap."
        self.assertLessEqual(len(text), 50)
        prev = _line(text, closed=True, opened_at=0.0, last_final_at=13.0, last_word_ms=10000)
        nxt = _gap_nxt("and the same speaker continues", last_ms=10000, gap_ms=81)
        # now=0 keeps the :641 `or` fallback from treating opened_at=0 as missing.
        self.assertEqual(decide_full(prev, nxt, 0.0), ("new", "closed_cap"))

    def test_same_speaker_continuation_over_soft_cap_is_closed_cap(self) -> None:
        # Not closed, but a real sentence end, 210 chars, lowercase follow-up.
        # Baseline returns extend/same_speaker_continuation.
        prev = _line("a" * 209 + ".", last_word_ms=10000)
        nxt = _gap_nxt("the rest of the thought continues", last_ms=10000, gap_ms=200)
        self.assertEqual(decide_full(prev, nxt, 0.0), ("new", "closed_cap"))

    def test_hard_char_cap(self) -> None:
        prev = _line("word " * 66, last_word_ms=1000, n_words=10)
        self.assertEqual(len(prev["text"]), 330)
        nxt = _gap_nxt("still continuing the thought", last_ms=1000, gap_ms=200, n_words=5)
        self.assertEqual(decide_full(prev, nxt, 0.0), ("new", "chars"))
        nxt_end = _gap_nxt("still continuing the thought.", last_ms=1000, gap_ms=200, n_words=5)
        self.assertEqual(decide_full(prev, nxt_end, 0.0), ("extend", "split"))

    def test_hard_open_age_cap(self) -> None:
        prev = _line("still talking", opened_at=0.0, last_final_at=13.0, last_word_ms=1000, n_words=2)
        nxt = _gap_nxt("more words now", last_ms=1000, gap_ms=200, n_words=3)
        self.assertEqual(decide_full(prev, nxt, 0.0), ("new", "open_age"))

    def test_split_index(self) -> None:
        from server.meeting_lines import last_sentence_index, split_index

        incoming = "ends here. Another one. And more"
        first = len("ends here.")
        last = len("ends here. Another one.")
        self.assertEqual(first, 10)
        self.assertEqual(last, 23)
        # 150 + 23 = 173 does not exceed the Latin soft cap of 200.
        self.assertEqual(split_index("x" * 150, incoming), last)
        # 177 + 23 = 200 is not strictly over; 178 + 23 = 201 is.
        self.assertEqual(split_index("x" * 177, incoming), last)
        self.assertEqual(split_index("x" * 178, incoming), first)
        self.assertEqual(split_index("short", incoming), last)
        self.assertEqual(split_index("", incoming), last_sentence_index(incoming, skip_false_period=True))

        abbr = "e.g. this and 1.5 more. Next"
        abbr_at = split_index("x" * 150, abbr)
        self.assertEqual(abbr[:abbr_at], "e.g. this and 1.5 more.")

        false_in = "… changing me into. rest"
        false_at = split_index("short", false_in)
        self.assertEqual(false_at, last_sentence_index(false_in, skip_false_period=True))
        self.assertNotEqual(false_at, false_in.index("into.") + len("into."))

        self.assertIsNone(split_index("short", "no sentence end here"))

    def test_threshold_edges(self) -> None:
        # Soft chars are inclusive; age and the hard caps stay exclusive (`>`).
        exact = _line("a" * 199 + ".", closed=True, last_word_ms=10000)
        under = _line("a" * 198 + ".", closed=True, last_word_ms=10000)
        nxt = _gap_nxt("features continue from here", last_ms=10000, gap_ms=81)
        self.assertEqual(len(exact["text"]), 200)
        self.assertEqual(len(under["text"]), 199)
        self.assertEqual(decide_full(exact, nxt, 0.0), ("new", "closed_cap"))
        self.assertEqual(decide_full(under, nxt, 0.0), ("extend", "closed_continuation"))

        cjk_exact = _line("会" * 79 + "。", closed=True, last_word_ms=5000)
        cjk_under = _line("会" * 78 + "。", closed=True, last_word_ms=5000)
        cjk_nxt = _gap_nxt("继续说", last_ms=5000, gap_ms=200)
        self.assertEqual(decide_full(cjk_exact, cjk_nxt, 0.0), ("new", "closed_cap"))
        self.assertEqual(decide_full(cjk_under, cjk_nxt, 0.0), ("extend", "closed_continuation"))

        mixed = _line("a" * 79 + "中", closed=True, last_word_ms=5000)
        self.assertEqual(len(mixed["text"]), 80)
        self.assertEqual(decide_full(mixed, cjk_nxt, 0.0), ("new", "closed_cap"))

        aged = _line("and that is the whole point.", closed=True, opened_at=0.0,
                     last_final_at=12.0, last_word_ms=10000)
        self.assertEqual(decide_full(aged, nxt, 0.0), ("extend", "closed_continuation"))

        missing = {
            "id": "q1",
            "text": "and that is the whole point.",
            "speaker": "A",
            "closed": True,
            "last_word_ms": 10000,
            "n_words": 7,
        }
        self.assertEqual(decide_full(missing, nxt, 5.0), ("extend", "closed_continuation"))

        open_exact = _line("w" * 200, last_word_ms=1000, n_words=1)
        open_over = _line("w" * 201, last_word_ms=1000, n_words=1)
        hard_nxt = _gap_nxt("w" * 120, last_ms=1000, gap_ms=200, n_words=1)
        self.assertEqual(len(open_exact["text"]) + len(hard_nxt["text"]), 320)
        self.assertEqual(decide_full(open_exact, hard_nxt, 0.0), ("extend", "ok"))
        self.assertEqual(decide_full(open_over, hard_nxt, 0.0), ("new", "chars"))

        age_exact = _line("still talking", opened_at=0.0, last_final_at=12.0, last_word_ms=1000, n_words=2)
        age_nxt = _gap_nxt("more words now", last_ms=1000, gap_ms=200, n_words=3)
        self.assertEqual(decide_full(age_exact, age_nxt, 0.0), ("extend", "ok"))

        words_exact = _line("still talking", last_word_ms=1000, n_words=30)
        words_nxt = _gap_nxt("more words now", last_ms=1000, gap_ms=200, n_words=25)
        words_over = dict(words_nxt)
        words_over["n_words"] = 26
        self.assertEqual(decide_full(words_exact, words_nxt, 0.0), ("extend", "ok"))
        self.assertEqual(decide_full(words_exact, words_over, 0.0), ("new", "words"))


def _drive(sess, text: str, meta: dict) -> None:
    sess._hold_or_emit_meeting(text, "en", "A", meta)


class MeetingLineCapSessionTests(unittest.TestCase):
    def test_session_continuation_chain_respects_cap(self) -> None:
        finals = []
        first = ("we continue the same thought without ending " * 5)[:150]
        if first[-1] in ".!?。！？…":
            first = first[:-1] + "x"
        finals.append(first)
        for i in range(2, 7):
            body = f"the talk continues with the same speaker on piece {i} "
            text = (body + ("word " * 30))[:149].rstrip() + "."
            self.assertTrue(text[0].islower())
            self.assertTrue(text.endswith("."))
            self.assertGreaterEqual(len(text), 140)
            self.assertLessEqual(len(text), 160)
            finals.append(text)

        sess = _session()
        clk = _Clock()
        cursor = 0
        limit = 320 + max(len(t) for t in finals)
        with mock.patch("server.app.time.time", clk):
            for text in finals:
                _drive(sess, text, {
                    "first_word_ms": cursor,
                    "last_word_ms": cursor + 4000,
                    "n_words": 20,
                })
                cursor += 4300
        questions = _events(sess, "question")
        updates = _events(sess, "line_update")
        self.assertGreaterEqual(len(questions), 3)
        for ev in questions + updates:
            self.assertLessEqual(len(ev["text"]), limit)

    def test_session_split_stops_at_first_sentence_when_over_soft_cap(self) -> None:
        sess = _session()
        clk = _Clock()
        incoming = "ends here. Another sentence. And more"
        with mock.patch("server.app.time.time", clk):
            _drive(sess, "x" * 180, {"first_word_ms": 1000, "last_word_ms": 4000, "n_words": 1})
            clk.advance(0.1)
            _drive(sess, incoming, {"first_word_ms": 4300, "last_word_ms": 8000, "n_words": 6})
        updates = _events(sess, "line_update")
        questions = _events(sess, "question")
        self.assertTrue(updates, "expected a line_update")
        self.assertTrue(updates[-1]["text"].endswith("ends here."), updates[-1]["text"])
        self.assertNotIn("Another sentence.", updates[-1]["text"])
        self.assertTrue(any(q["text"] == "Another sentence. And more" for q in questions))
