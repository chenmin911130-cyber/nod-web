"""Meeting "incomplete-sentence continuation" (issue #29, round 2 — issue #31).

AssemblyAI forces a turn boundary after a short pause, so one spoken sentence can
arrive as two finals and get transcribed + translated as two half-sentence rows.
These tests drive the decision logic and the Session meeting path (new vs extend),
the worker's turn-order reordering, and the round-2 fixes (#31): meta reaches the
open line, the wall-clock fallback is replaced by a next-turn-duration estimate,
the 12s cap is measured on the previous line's own age, held fragments flush
through the worker, and pause/stop drain the worker before closing the open line.

Round-2 rule: every integration case that drives TWO finals patches ``time.time``
so they are >= 5s apart ("no back-to-back calls"), so a fake-green extend (which
only ever extended because the two calls were milliseconds apart) can't pass.
"""

import json
import logging
import os
import queue
import threading
import time
import unittest
from collections import deque
from unittest import mock

from server import app as app_mod
from server.app import CloudListener, Session
from server.meeting_lines import (
    decide,
    decide_full,
    ends_sentence,
    false_period,
    gap_ms,
    join_meeting_text,
    last_sentence_index,
    tail_meta,
)


class _Clock:
    """A controllable ``time.time``: every call inside a turn returns the same
    instant, and ``advance`` moves it for the next turn (a real turn takes ~10s,
    not milliseconds)."""

    def __init__(self) -> None:
        self.t = 100000.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


class _Emitter:
    def __init__(self) -> None:
        self.events: list[dict] = []

    def __call__(self, ev: dict) -> None:
        self.events.append(ev)


def _session(**overrides) -> Session:
    sess = Session.__new__(Session)
    sess.emit = _Emitter()
    sess._manual = False
    sess._listener = None
    sess._paused = False
    sess._engine = "idle"
    sess._workspace = "meeting"
    sess._listen_accum_sec = 0.0
    sess._listen_started_at = 0.0
    sess._last_pcm_at = 0.0
    sess._last_voice_at = 0.0
    sess._pending_q = deque(maxlen=8)
    sess._pending_asks = []
    sess._pending_wait = (None, 0.0, None)
    sess._pending_speaker = None
    sess._meeting_lock = threading.Lock()
    sess._interview_lock = threading.Lock()
    sess._meeting_flush_timer = None
    sess._meeting_worker_thread = None
    sess._pending_meta = None
    sess._interview_wait_timer = None
    sess._open_line = None
    sess._meeting_gen = 0
    sess._meeting_finals = queue.Queue()
    sess._meeting_worker_started = False
    sess._final_seq = 0
    sess._recent_finals = []
    sess._follow_lang = None
    sess._follow_switch_lang = None
    sess._follow_switch_hits = 0
    sess.cfg = {}
    sess.user_id = None
    sess.usage_session_id = None
    # Avoid touching STT / LLM / meter.
    sess._maybe_follow_speech = lambda *a, **k: None
    sess._mark_voice = lambda *a, **k: None
    qid_q = iter(range(100, 1000))

    class _FakePipe:
        _last_answer = ""

        def _new_qid(self):
            return f"q{next(qid_q)}"

    sess.pipeline = _FakePipe()
    for key, val in overrides.items():
        setattr(sess, key, val)
    return sess


def _events(sess: Session, type_: str) -> list[dict]:
    return [e for e in sess.emit.events if e["type"] == type_]


def _wait_for(sess: Session, type_: str, count: int, timeout: float = 2.0) -> None:
    """Block until at least ``count`` events of ``type_`` have been emitted (the
    meeting worker runs on a daemon thread)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if len(_events(sess, type_)) >= count:
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {count} '{type_}' events")


class DecideTests(unittest.TestCase):
    def test_screenshot_pair_extends(self):
        # The reported Safari case: one speaker, no sentence-end on the first
        # turn, word gap under 2.5s -> one merged line, one line_update.
        prev = {
            "id": "q1",
            "text": "prioritizing P, performance availability work. So one of the significant",
            "speaker": "A",
            "opened_at": 1000.0,
            "last_final_at": 1000.0,
            "last_word_ms": 54000,
            "n_words": 8,
            "rev": 0,
        }
        nxt = {
            "text": "features of this particular recent outage last week was, is that the Redis server apparently",
            "speaker": "A",
            "first_word_ms": 55200,
            "last_word_ms": 60000,
            "n_words": 10,
        }
        self.assertEqual(decide(prev, nxt, 1000.0), "extend")

    def test_sentence_end_starts_new(self):
        prev = {
            "id": "q1",
            "text": "Let me finish this thought.",
            "speaker": "A",
            "opened_at": 1000.0,
            "last_final_at": 1000.0,
            "last_word_ms": 1000,
            "n_words": 5,
            "rev": 0,
        }
        nxt = {"text": "Next part.", "speaker": "A", "first_word_ms": 2000, "last_word_ms": 2500, "n_words": 2}
        self.assertEqual(decide(prev, nxt, 1000.0), "new")

    def test_unknown_prev_known_next_is_new(self):
        prev = {"id": "q1", "text": "some text", "speaker": None, "opened_at": 0.0, "last_final_at": 0.0, "last_word_ms": 100, "n_words": 2, "rev": 0}
        nxt = {"text": "next", "speaker": "B", "first_word_ms": 200, "n_words": 1}
        self.assertEqual(decide(prev, nxt, 0.0), "new")

    def test_known_then_unknown_lowercase_extends(self):
        prev = {"id": "q1", "text": "So one of the", "speaker": "A", "opened_at": 0.0, "last_final_at": 0.0, "last_word_ms": 100, "n_words": 4, "rev": 0}
        nxt = {"text": "significant features", "speaker": None, "first_word_ms": 300, "n_words": 2}
        self.assertEqual(decide(prev, nxt, 0.0), "extend")

    def test_known_then_unknown_uppercase_is_new(self):
        prev = {"id": "q1", "text": "So one of the", "speaker": "A", "opened_at": 0.0, "last_final_at": 0.0, "last_word_ms": 100, "n_words": 4, "rev": 0}
        nxt = {"text": "Significant features", "speaker": None, "first_word_ms": 300, "n_words": 2}
        self.assertEqual(decide(prev, nxt, 0.0), "new")

    def test_long_gap_starts_new(self):
        prev = {"id": "q1", "text": "So one", "speaker": "A", "opened_at": 0.0, "last_final_at": 0.0, "last_word_ms": 100, "n_words": 2, "rev": 0}
        nxt = {"text": "significant features", "speaker": "A", "first_word_ms": 6000, "n_words": 2}
        self.assertEqual(decide(prev, nxt, 0.0), "new")

    def test_word_gap_3000ms_is_new(self):
        # Round-2 rule: BOTH word and estimated gaps share the 2.5s threshold.
        prev = {"id": "q1", "text": "So one", "speaker": "A", "opened_at": 0.0, "last_final_at": 0.0, "last_word_ms": 2000, "n_words": 2, "rev": 0}
        nxt = {"text": "features", "speaker": "A", "first_word_ms": 5000, "n_words": 2}
        self.assertEqual(decide(prev, nxt, 0.0), "new")

    def test_est_gap_small_extends_and_large_is_new(self):
        # All word-level missing on prev, but the next turn carries its own span.
        # (now - last_final_at)=1.5s, next-turn duration 1.0s -> est 0.5s -> extend.
        prev = {"id": "q1", "text": "So one", "speaker": "A", "opened_at": 0.0, "last_final_at": 10.0, "last_word_ms": None, "n_words": 2, "rev": 0}
        nxt = {"text": "features now", "speaker": "A", "first_word_ms": 5000, "last_word_ms": 6000, "n_words": 2}
        self.assertEqual(decide(prev, nxt, 11.5), "extend")
        # Longer wall-clock delta (5s) minus 1s duration = 4s -> new.
        self.assertEqual(decide(prev, nxt, 15.0), "new")

    def test_open_age_on_prev_side_not_live_clock(self):
        # A 10s turn must NOT trip the cap just because 'now' moved: the age is
        # measured from last_final_at (kept at the last extend), not now.
        prev = {
            "id": "q1",
            "text": "features here now",
            "speaker": "A",
            "opened_at": 1000.0,
            "last_final_at": 1001.0,  # line opened at 1000, last final at 1001 -> age 1s
            "last_word_ms": 200,
            "n_words": 3,
            "rev": 0,
        }
        nxt = {"text": "more words follow now", "speaker": "A", "first_word_ms": 300, "n_words": 4}
        self.assertEqual(decide(prev, nxt, 12000.0), "extend")

    def test_join_never_drops_right(self):
        self.assertEqual(
            join_meeting_text("中文内容", "English part"),
            "中文内容 English part",
        )
        self.assertEqual(join_meeting_text("中文内容", "继续内容"), "中文内容继续内容")
        self.assertEqual(join_meeting_text("Hello", "world"), "Hello world")

    def test_gap_ms_word_est_none(self):
        prev = {"id": "q1", "text": "x", "speaker": "A", "opened_at": 0.0, "last_final_at": 10.0, "last_word_ms": 100, "n_words": 1, "rev": 0}
        nxt = {"text": "y", "speaker": "A", "first_word_ms": 200, "n_words": 1}
        self.assertEqual(gap_ms(prev, nxt, 12.0), (100.0, "word"))
        # Word-level unavailable on prev, but the NEXT turn carries its own span:
        # wall-clock delta (2.5s) minus the next-turn duration (1s) => est 1.5s.
        prev2 = {"id": "q1", "text": "x", "speaker": "A", "opened_at": 0.0, "last_final_at": 10.0, "last_word_ms": None, "n_words": 1, "rev": 0}
        nxt2 = {"text": "y", "speaker": "A", "first_word_ms": 5000, "last_word_ms": 6000, "n_words": 1}
        self.assertEqual(gap_ms(prev2, nxt2, 12.5), (1500.0, "est"))
        # Neither side has word levels -> None (caller decides a NEW line).
        nxt3 = {"text": "y", "speaker": "A", "first_word_ms": None, "last_word_ms": None, "n_words": 1}
        self.assertIsNone(gap_ms(prev2, nxt3, 12.5))


class MeetingEmitTests(unittest.TestCase):
    def _drive_hold(self, sess: Session, text, lang=None, speaker=None, meta=None):
        sess._hold_or_emit_meeting(text, lang, speaker, meta or {})

    def test_new_turn_emits_question_and_opens_line(self):
        sess = _session()
        self._drive_hold(sess, "The host introduces a tutorial.", speaker="A")
        qs = _events(sess, "question")
        self.assertEqual(len(qs), 1)
        self.assertEqual(qs[0]["text"], "The host introduces a tutorial.")
        self.assertEqual(sess._open_line["id"], qs[0]["id"])
        self.assertEqual(sess._open_line["rev"], 0)
        self.assertEqual(sess._open_line["speaker"], "A")

    def test_extend_emits_line_update_and_updates_history(self):
        # Two finals are >= 10s apart (a real turn duration); BOTH carry word-level
        # meta so the continuation is a genuine word-level extend, not a fake-green
        # extend from two calls being milliseconds apart.
        sess = _session(user_id="u1", usage_session_id="s1")
        clk = _Clock()
        with mock.patch("server.meter.update_history_text") as upd, mock.patch("server.meter.save_history"):
            with mock.patch("server.app.time.time", clk):
                self._drive_hold(
                    sess,
                    "prioritizing P, performance availability work. So one of the significant",
                    speaker="A",
                    meta={"first_word_ms": 54000, "last_word_ms": 55000, "n_words": 8},
                )
                clk.advance(10)
                self._drive_hold(
                    sess,
                    "features of this particular recent outage last week was, is that the Redis server apparently",
                    speaker="A",
                    meta={"first_word_ms": 55200, "last_word_ms": 60000, "n_words": 10},
                )
        qs = _events(sess, "question")
        ups = _events(sess, "line_update")
        self.assertEqual(len(qs), 1)
        self.assertEqual(len(ups), 1)
        self.assertEqual(ups[0]["id"], qs[0]["id"])
        self.assertTrue("features of this particular" in ups[0]["text"])
        self.assertEqual(ups[0]["rev"], 1)
        # history in place, no second transcript row
        upd.assert_called_once()
        self.assertEqual(sess._open_line["rev"], 1)

    def test_sentence_end_closes_line_next_is_new(self):
        sess = _session()
        clk = _Clock()
        with mock.patch("server.app.time.time", clk):
            self._drive_hold(sess, "Let me finish this thought.", speaker="A")
            clk.advance(10)
            self._drive_hold(sess, "Next part.", speaker="A")
        qs = _events(sess, "question")
        self.assertEqual(len(qs), 2)  # two separate lines
        self.assertEqual(len(_events(sess, "line_update")), 0)

    def test_tiny_fragment_is_held_then_flushed_through_worker(self):
        # Round-2 P1-a: the flush re-queues the held fragment to the worker, it
        # does NOT emit directly. So the timer callback never produces a question
        # by itself; the worker's decide path does.
        sess = _session()
        self._drive_hold(sess, "So one", speaker="A")
        p = _events(sess, "partial")
        self.assertEqual(len(p), 1)
        self.assertEqual(len(_events(sess, "question")), 0)
        # open line is still None until the held fragment is flushed
        self.assertIsNone(sess._open_line)
        sess._flush_meeting_hold()  # re-queues to the worker
        _wait_for(sess, "question", 1)
        self.assertEqual(len(_events(sess, "question")), 1)
        self.assertIsNotNone(sess._open_line)

    def test_section1_pair_extends_with_real_turn_gap(self):
        # Issue #31 §1: turn1 '...feels like one message, but' (10s duration) then
        # turn2 10s later, real silence 0.4s -> ONE line + ONE line_update.
        sess = _session()
        clk = _Clock()
        with mock.patch("server.app.time.time", clk):
            self._drive_hold(sess, "it feels like one message, but", speaker="A",
                             meta={"first_word_ms": 23500, "last_word_ms": 33000, "n_words": 30})
            clk.advance(10)
            self._drive_hold(sess, "Under the hood it is a real worker chain", speaker="A",
                             meta={"first_word_ms": 33400, "last_word_ms": 43000, "n_words": 34})
        qs = _events(sess, "question")
        ups = _events(sess, "line_update")
        self.assertEqual(len(qs), 1)
        self.assertEqual(len(ups), 1)
        self.assertEqual(ups[0]["id"], qs[0]["id"])
        self.assertTrue("real worker chain" in ups[0]["text"])
        self.assertEqual(ups[0]["rev"], 1)
        self.assertEqual(sess._open_line["rev"], 1)

    def test_three_segment_chain_bumps_rev_twice(self):
        # Three ~10s turns, all one speaker, small word gaps -> ONE line, rev 2.
        sess = _session()
        clk = _Clock()
        with mock.patch("server.app.time.time", clk):
            self._drive_hold(sess, "segment one of the chain", speaker="A",
                             meta={"first_word_ms": 1000, "last_word_ms": 5000, "n_words": 8})
            clk.advance(10)
            self._drive_hold(sess, "segment two of the chain", speaker="A",
                             meta={"first_word_ms": 5400, "last_word_ms": 9000, "n_words": 9})
            clk.advance(10)
            self._drive_hold(sess, "segment three of the chain", speaker="A",
                             meta={"first_word_ms": 9400, "last_word_ms": 13000, "n_words": 10})
        qs = _events(sess, "question")
        ups = _events(sess, "line_update")
        self.assertEqual(len(qs), 1)
        self.assertEqual(len(ups), 2)
        self.assertEqual(ups[-1]["rev"], 2)
        self.assertEqual(sess._open_line["rev"], 2)

    def test_est_gap_extend_when_word_level_missing(self):
        # Word-level missing on prev, next turn has its own 8s span, wall-clock
        # delta 8.4s -> est silence 0.4s -> extend.
        sess = _session()
        clk = _Clock()
        with mock.patch("server.app.time.time", clk):
            self._drive_hold(sess, "first part of a longer line", speaker="A")
            clk.advance(8.4)
            self._drive_hold(sess, "second part continues the line", speaker="A",
                             meta={"first_word_ms": 8000, "last_word_ms": 16000, "n_words": 12})
        self.assertEqual(len(_events(sess, "line_update")), 1)
        self.assertEqual(sess._open_line["rev"], 1)

    def test_no_ms_anywhere_starts_new(self):
        sess = _session()
        clk = _Clock()
        with mock.patch("server.app.time.time", clk):
            self._drive_hold(sess, "first part of a longer line", speaker="A")
            clk.advance(10)
            self._drive_hold(sess, "second part with no timestamps anywhere", speaker="A")
        self.assertEqual(len(_events(sess, "question")), 2)
        self.assertEqual(len(_events(sess, "line_update")), 0)

    def test_hold_goes_through_worker_not_direct(self):
        # A tiny continuation is held; on flush the worker decides and EXTENDS
        # (line_update), proving the flush did not emit a question directly.
        sess = _session()
        clk = _Clock()
        with mock.patch("server.app.time.time", clk):
            self._drive_hold(sess, "open any software, and follow", speaker="A",
                             meta={"first_word_ms": 1000, "last_word_ms": 6000, "n_words": 8})
            clk.advance(1)
            self._drive_hold(sess, "but", speaker="A",
                             meta={"first_word_ms": 6400, "last_word_ms": 6800, "n_words": 1})
        self.assertEqual(len(_events(sess, "question")), 1, "held fragment not emitted yet")
        with mock.patch("server.app.time.time", clk):
            sess._flush_meeting_hold()
        _wait_for(sess, "line_update", 1)
        self.assertEqual(len(_events(sess, "line_update")), 1, "held fragment extends via worker")
        self.assertEqual(len(_events(sess, "question")), 1, "flush never emitted a question directly")
        self.assertEqual(sess._open_line["rev"], 1)

    def test_held_fragment_merges_with_next_final_and_meta(self):
        # Issue #31 §2.1: a held tiny fragment that joins the next final before the
        # timer fires produces a MERGED meta (earlier first_word_ms, later
        # last_word_ms, n_words summed) on the extended line.
        sess = _session()
        clk = _Clock()
        with mock.patch("server.app.time.time", clk):
            self._drive_hold(sess, "open any software and then", speaker="A",
                             meta={"first_word_ms": 1000, "last_word_ms": 6000, "n_words": 7})
            clk.advance(0.5)
            # "but" is tiny (<8 chars) and gets HELD (pending wait, timer running).
            self._drive_hold(sess, "but", speaker="A",
                             meta={"first_word_ms": 6400, "last_word_ms": 6800, "n_words": 1})
            self.assertEqual(sess._pending_wait[0], "but", "tiny fragment is held")
            clk.advance(0.5)
            # A new final arrives before the 1.0s timer fires -> MERGES with "but".
            self._drive_hold(sess, "and then feature sets", speaker="A",
                             meta={"first_word_ms": 6900, "last_word_ms": 7200, "n_words": 3})
        self.assertEqual(len(_events(sess, "question")), 1)
        self.assertEqual(len(_events(sess, "line_update")), 1)
        self.assertIn("but and then feature sets", _events(sess, "line_update")[0]["text"])
        self.assertEqual(sess._open_line["rev"], 1)
        # Merged meta: earlier first (6400), later last (7200), n_words summed.
        self.assertEqual(sess._open_line["last_word_ms"], 7200)
        self.assertEqual(sess._open_line["n_words"], 7 + 1 + 3)

    def test_pause_drains_buffered_final_before_closing(self):
        # P1-c: a final still buffered in the worker must be drained (emitted)
        # BEFORE the open line is closed, so the line is None after.
        sess = _session(_listener=mock.Mock(), _manual=False)
        sess._stop_listener = lambda lst: None
        clk = _Clock()
        with mock.patch("server.app.time.time", clk):
            sess._enqueue_meeting_final("first line of the meeting", "A", "A",
                                        {"turn_order": 1, "first_word_ms": 1000, "last_word_ms": 5000, "n_words": 6})
            _wait_for(sess, "question", 1)
            clk.advance(5)
            # A second final is still buffered; pause must DRAIN it (emit a
            # line_update extending the open line) BEFORE closing the line.
            sess._enqueue_meeting_final("second line continues the thought", "A", "A",
                                        {"turn_order": 2, "first_word_ms": 5400, "last_word_ms": 9000, "n_words": 7})
            sess.pause_listen()
        # Both finals were processed (the drain happened): line_update for turn2.
        self.assertEqual(len(_events(sess, "question")), 1)
        self.assertEqual(len(_events(sess, "line_update")), 1, "buffered final was drained")
        # AND THEN the open line was closed. If the drain had reopened it AFTER
        # the close, open_line would NOT be None (the P1-c bug).
        self.assertIsNone(sess._open_line, "open line closed after drain")
        # After resume, the next final is a NEW line (open line was cleared).
        clk.advance(5)
        self._drive_hold(sess, "line after resume", speaker="A",
                         meta={"first_word_ms": 10000, "last_word_ms": 14000, "n_words": 4})
        _wait_for(sess, "question", 2)
        self.assertEqual(len(_events(sess, "question")), 2, "resume starts a fresh line")

    def test_speaker_revision_traces_only(self):
        listener = CloudListener.__new__(CloudListener)
        records: list[logging.LogRecord] = []
        handler = logging.Handler()
        handler.emit = records.append  # type: ignore[assignment]
        logger = logging.getLogger("nod")
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        try:
            with mock.patch.dict(os.environ, {"NOD_STT_TRACE": "1"}, clear=False):
                listener._on_message(None, json.dumps({"type": "SpeakerRevision", "turns": [{"turn_number": 1}], "labels": {"A": 1}}))
            self.assertTrue(
                any("stt speaker_revision turns=1 labels=1" in (r.getMessage() or "") for r in records),
                "trace on: a speaker_revision line is logged",
            )
        finally:
            logger.removeHandler(handler)
        # Without trace it produces nothing — no events either (listener has no emit).
        records2: list[logging.LogRecord] = []
        handler2 = logging.Handler()
        handler2.emit = records2.append  # type: ignore[assignment]
        logger.addHandler(handler2)
        try:
            with mock.patch.dict(os.environ, {"NOD_STT_TRACE": ""}, clear=False):
                listener._on_message(None, json.dumps({"type": "SpeakerRevision", "turns": [{"turn_number": 1}]}))
            self.assertNotIn("stt speaker_revision", "\n".join((r.getMessage() or "") for r in records2))
        finally:
            logger.removeHandler(handler2)
            logger.setLevel(logging.WARNING)


    def test_meeting_decision_trace_fields(self):
        # Issue #31 §2.6: the worker-side trace logs the decision diagnostics
        # (gap_ms / gap_src / decision / open_age_ms / speaker_prev / speaker_next)
        # plus text length + hash — never the text itself.
        sess = _session()
        records: list[logging.LogRecord] = []
        handler = logging.Handler()
        handler.emit = records.append  # type: ignore[assignment]
        logger = logging.getLogger("nod")
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        try:
            with mock.patch.dict(os.environ, {"NOD_STT_TRACE": "1"}, clear=False):
                clk = _Clock()
                with mock.patch("server.app.time.time", clk):
                    self._drive_hold(sess, "first part of a longer line", speaker="A")
                    clk.advance(8.4)
                    self._drive_hold(sess, "second part continues the line", speaker="A",
                                     meta={"first_word_ms": 8000, "last_word_ms": 16000, "n_words": 12})
        finally:
            logger.removeHandler(handler)
            logger.setLevel(logging.WARNING)
        joined = "\n".join((r.getMessage() or "") for r in records)
        self.assertIn("decision=extend", joined)
        self.assertIn("gap_src=est", joined)
        self.assertIn("gap_ms=", joined)
        self.assertIn("open_age_ms=", joined)
        self.assertIn("speaker_prev=", joined)
        self.assertIn("speaker_next=", joined)
        self.assertIn("text_len=", joined)
        self.assertIn("text_sha=", joined)


class MeetingWorkerOrderTests(unittest.TestCase):
    def test_turns_emit_in_turn_order(self):
        # The listener thread enqueues finals in AssemblyAI's message order; the
        # worker must preserve it (a later turn never lands before an earlier one).
        sess = _session()
        sess._enqueue_meeting_final("third segment here", "A", "A", {"turn_order": 3, "first_word_ms": 300, "n_words": 3})
        sess._enqueue_meeting_final("fourth segment here", "B", "B", {"turn_order": 4, "first_word_ms": 400, "n_words": 3})
        _wait_for(sess, "question", 2)
        qs = _events(sess, "question")
        self.assertEqual(len(qs), 2)
        self.assertEqual(qs[0]["text"], "third segment here")
        self.assertEqual(qs[1]["text"], "fourth segment here")

    def test_reset_drops_inflight(self):
        # A buffered final for an OLD meeting generation is dropped on flush, so
        # clear / set_workspace cannot write back into a new session.
        sess = _session()
        sess._meeting_gen = 1
        old_buf = {1: (0, "a stale segment", "A", "A", {})}
        sess._flush_meeting_buffer(old_buf)
        self.assertEqual(len(_events(sess, "question")), 0)
        # Same generation is emitted.
        fresh_buf = {1: (1, "a fresh segment", "A", "A", {})}
        sess._flush_meeting_buffer(fresh_buf)
        self.assertEqual(len(_events(sess, "question")), 1)

    def test_first_reset_does_not_poison_worker_and_finals_accumulate(self):
        # Regression: the very first set_workspace (connect syncs meeting mode)
        # calls _reset_turn_state -> _stop_meeting_worker BEFORE any worker has
        # started. Putting a drain sentinel then would be consumed by the worker's
        # first get() and make it exit immediately, with the "started" flag still
        # true -> later finals queue but never reach the transcript. The fix: no
        # drain when nothing is running, and the worker clears the flag on exit.
        sess = _session()
        sess._reset_turn_state()
        self.assertEqual(sess._meeting_finals.qsize(), 0, "no drain sentinel before a worker exists")
        # Consecutive real finals must all land (worker processes every one).
        sess._enqueue_meeting_final("first segment here", "A", "A", {"turn_order": 1, "n_words": 3})
        sess._enqueue_meeting_final("second segment here", "B", "B", {"turn_order": 2, "n_words": 3})
        _wait_for(sess, "question", 2)
        self.assertEqual(len(_events(sess, "question")), 2, "both finals accumulate in the transcript")


class SentenceEndSplitTests(unittest.TestCase):
    """Round 3 (#33): sentence-boundary wrapping, the false period, boundary-word
    dedup, the caps-as-fallback, and split tail meta."""

    def _drive_hold(self, sess: Session, text, lang=None, speaker=None, meta=None):
        sess._hold_or_emit_meeting(text, lang, speaker, meta or {})

    # ---- pure decide / join -------------------------------

    def test_last_sentence_index_ignores_decimal_and_abbreviation(self):
        self.assertIsNone(last_sentence_index("The value is 1.5 for now"))
        self.assertIsNone(last_sentence_index("Use e.g. this"))
        # A single-capital initial ("J. Doe") is NOT a sentence end.
        self.assertIsNone(last_sentence_index("He met J. Doe last"))
        self.assertIsNone(last_sentence_index("A. Smith wrote the note"))
        # A real period after an abbreviation still counts.
        self.assertEqual(last_sentence_index("Use e.g. this. Next"), 14)

    def test_false_period_classifies_function_word_but_not_pronoun(self):
        self.assertTrue(false_period("…changing me into."))
        self.assertTrue(false_period("allowing you to stop.") is False)
        self.assertFalse(false_period("…finished video."))  # 'video' is a noun
        self.assertFalse(false_period("no period here"))  # no trailing '.'

    def test_join_strips_false_period_and_recases(self):
        # §1.3: a bogus '.' after a function word is dropped and the continuation's
        # first letter is lowercased ("A" → "a"), so "...me into." + "A Western…"
        # renders as "...me into a Western…".
        out = join_meeting_text("it keeps changing me into.", "A Western cowboy", gap_ms=242.0)
        self.assertEqual(out, "it keeps changing me into a Western cowboy")
        # The pronoun "I" keeps its capital; a genuine acronym ("NASA") keeps its
        # caps. BOTH lefts end in a FALSE period, so this really exercises
        # _lower_first_char (a plain non-false-period left would not).
        self.assertEqual(join_meeting_text("it was just.", "I really think so", gap_ms=200.0), "it was just I really think so")
        self.assertEqual(join_meeting_text("it was just.", "NASA announced a plan", gap_ms=200.0), "it was just NASA announced a plan")

    def test_join_dedups_boundary_word(self):
        # §1.4: turn 8 ends "know exactly", turn 9 starts "exactly where" → the
        # repeated boundary word is dropped when the gap is small.
        out = join_meeting_text("share it on your socials and know exactly", "exactly where you post", gap_ms=400.0)
        self.assertEqual(out, "share it on your socials and know exactly where you post")
        self.assertEqual(out.count("exactly"), 1)
        # A large gap (over 500ms) does NOT dedup.
        self.assertEqual(
            join_meeting_text("know exactly", "exactly where", gap_ms=600.0),
            "know exactly exactly where",
        )

    def test_false_period_decides_extend_but_pronoun_is_new(self):
        fp_prev = {"id": "q1", "text": "…changing me into.", "speaker": "A",
                   "opened_at": 0.0, "last_final_at": 0.0, "last_word_ms": 1000, "n_words": 4, "rev": 0}
        fp_nxt = {"text": "A Western cowboy. Now more", "speaker": "A",
                  "first_word_ms": 1242, "last_word_ms": 2000, "n_words": 5}
        self.assertEqual(decide(fp_prev, fp_nxt, 0.0), "extend")
        self.assertEqual(decide_full(fp_prev, fp_nxt, 0.0), ("extend", "false_period"))
        # "...allowing you." — a pronoun can legally close a sentence → NEW.
        you_prev = {"id": "q2", "text": "…allowing you.", "speaker": "A",
                    "opened_at": 0.0, "last_final_at": 0.0, "last_word_ms": 1000, "n_words": 3, "rev": 0}
        you_nxt = {"text": "To do things", "speaker": "A",
                   "first_word_ms": 1242, "last_word_ms": 2000, "n_words": 4}
        self.assertEqual(decide(you_prev, you_nxt, 0.0), "new")
        self.assertEqual(decide_full(you_prev, you_nxt, 0.0), ("new", "ends_sentence"))

    def test_true_sentence_end_is_new_despite_tiny_gap(self):
        # §0 "finished video." → next sentence, word gap 81ms. The gap does NOT
        # participate in sentence-end judgement — a real sentence end is always new.
        prev = {"id": "q1", "text": "this is the finished video.", "speaker": "A",
                "opened_at": 0.0, "last_final_at": 0.0, "last_word_ms": 1000, "n_words": 5, "rev": 0}
        nxt = {"text": "Next up we move on", "speaker": "A",
               "first_word_ms": 1081, "last_word_ms": 1800, "n_words": 6}
        self.assertEqual(decide(prev, nxt, 0.0), "new")
        self.assertEqual(decide_full(prev, nxt, 0.0), ("new", "ends_sentence"))

    def test_caps_hardcut_only_when_no_sentence_end(self):
        # §1.2: prev+nxt both without any sentence end AND chars > 900 → hard cut.
        prev = {"id": "q1", "text": "word " * 110, "speaker": "A",
                "opened_at": 0.0, "last_final_at": 0.0, "last_word_ms": 1000, "n_words": 110, "rev": 0}
        nxt = {"text": "word " * 110, "speaker": "A",
               "first_word_ms": 1200, "last_word_ms": 2000, "n_words": 110}
        self.assertGreater(len(prev["text"]) + len(nxt["text"]), 900)
        self.assertEqual(decide(prev, nxt, 0.0), "new")
        self.assertEqual(decide_full(prev, nxt, 0.0), ("new", "chars"))
        # Same size, but the next turn closes on a sentence end → still extend.
        nxt2 = dict(nxt)
        nxt2["text"] = "word " * 108 + "finished here. more"
        self.assertEqual(decide(prev, nxt2, 0.0), "extend")
        self.assertEqual(decide_full(prev, nxt2, 0.0), ("extend", "split"))

    def test_tail_meta_first_word_in_range(self):
        # §2 item 6: the split tail's interpolated first_word_ms lies inside the
        # turn's [first, last]; turn_order is dropped.
        text = "exactly where you post your weekly updates on all your social media channels. Also, make sure to stay"
        split_at = last_sentence_index(text)
        self.assertIsNotNone(split_at)
        tm = tail_meta({"first_word_ms": 30400, "last_word_ms": 43000, "n_words": 20, "turn_order": 9}, text, split_at)
        self.assertTrue(30400 <= tm["first_word_ms"] <= 43000, f"tail first_word_ms {tm['first_word_ms']}")
        self.assertEqual(tm["last_word_ms"], 43000)
        self.assertGreater(tm["n_words"], 0)
        self.assertNotIn("turn_order", tm)

    # ---- session-level split -------------------------------

    def test_split_at_last_sentence_end_opens_tail(self):
        # §0 row 3: turn 8 (open, internal period) + turn 9 carrying a sentence end
        # → one line_update (prev closed at "…social media channels.") + a new
        # question (the tail), with the boundary word "exactly" appearing once.
        sess = _session()
        clk = _Clock()
        turn8 = ("you should share a brief update. covering all your product news across "
                 "every one of your social media channels and know exactly")
        turn9 = "exactly where you post your weekly updates on all your social media channels. Also, make sure to stay"
        with mock.patch("server.app.time.time", clk):
            self._drive_hold(sess, turn8, speaker="A",
                             meta={"first_word_ms": 5000, "last_word_ms": 30000, "n_words": 30})
            clk.advance(10)
            self._drive_hold(sess, turn9, speaker="A",
                             meta={"first_word_ms": 30400, "last_word_ms": 43000, "n_words": 20})
        ups = _events(sess, "line_update")
        qs = _events(sess, "question")
        self.assertEqual(len(ups), 1)
        self.assertEqual(len(qs), 2, "turn 8 line + the split tail line")
        # The absorbed line was closed at the sentence end, and the tail is a NEW
        # line (not smeared into the merged line).
        self.assertTrue(ups[0]["text"].endswith("social media channels."))
        self.assertNotIn("Also, make sure to stay", ups[0]["text"])
        self.assertEqual(ups[0]["text"].count("exactly"), 1, "boundary word deduped")
        # The tail became the new open line (same speaker, open, rev reset).
        self.assertEqual(qs[1]["text"], "Also, make sure to stay")
        self.assertEqual(qs[1]["speaker"], "A")
        self.assertEqual(sess._open_line["text"], "Also, make sure to stay")
        self.assertNotIn("closed", sess._open_line)
        self.assertEqual(sess._open_line["speaker"], "A")

    def test_tail_extends_via_word_gap_on_next_final(self):
        # §2 item 6: after the split the tail is the open line; the next final
        # compares a word-level gap against it and extends.
        sess = _session()
        clk = _Clock()
        turn8 = ("you should share a brief update. covering all your product news across "
                 "every one of your social media channels and know exactly")
        turn9 = "exactly where you post your weekly updates on all your social media channels. Also, make sure to stay"
        with mock.patch("server.app.time.time", clk):
            self._drive_hold(sess, turn8, speaker="A",
                             meta={"first_word_ms": 5000, "last_word_ms": 30000, "n_words": 30})
            clk.advance(10)
            self._drive_hold(sess, turn9, speaker="A",
                             meta={"first_word_ms": 30400, "last_word_ms": 43000, "n_words": 20})
            self.assertEqual(sess._open_line["text"], "Also, make sure to stay")
            self.assertEqual(sess._open_line["last_word_ms"], 43000)
            clk.advance(10)
            self._drive_hold(sess, "until the end of the video", speaker="A",
                             meta={"first_word_ms": 43400, "last_word_ms": 45000, "n_words": 6})
        self.assertEqual(len(_events(sess, "line_update")), 2, "tail extended via a word-level gap")
        self.assertEqual(sess._open_line["text"], "Also, make sure to stay until the end of the video")

    def test_no_sentence_end_merges_wholesale_stays_open(self):
        # §2 item 4: an incoming turn with NO sentence end is merged wholesale and
        # the line stays open (no split, no closed flag).
        sess = _session()
        clk = _Clock()
        with mock.patch("server.app.time.time", clk):
            self._drive_hold(sess, "first part without any stop", speaker="A",
                             meta={"first_word_ms": 1000, "last_word_ms": 5000, "n_words": 6})
            clk.advance(10)
            self._drive_hold(sess, "second part still one thought", speaker="A",
                             meta={"first_word_ms": 5200, "last_word_ms": 9000, "n_words": 8})
        self.assertEqual(len(_events(sess, "question")), 1)
        self.assertEqual(len(_events(sess, "line_update")), 1)
        self.assertEqual(sess._open_line["text"], "first part without any stop second part still one thought")
        self.assertNotIn("closed", sess._open_line, "merged line stays open")


if __name__ == "__main__":
    unittest.main()
