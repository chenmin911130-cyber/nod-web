"""Meeting "incomplete-sentence continuation" (issue #29).

AssemblyAI forces a turn boundary after a short pause, so one spoken sentence can
arrive as two finals and get transcribed + translated as two half-sentence rows.
These tests drive the decision logic and the Session meeting path (new vs extend)
and the worker's turn-order reordering.
"""

import time
import unittest
from collections import deque
from unittest import mock

from server import app as app_mod
from server.app import Session
from server.meeting_lines import decide, ends_sentence, gap_ms, join_meeting_text


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
    sess._meeting_lock = __import__("threading").Lock()
    sess._interview_lock = __import__("threading").Lock()
    sess._meeting_flush_timer = None
    sess._interview_wait_timer = None
    sess._open_line = None
    sess._meeting_gen = 0
    sess._meeting_finals = __import__("queue").Queue()
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

    def test_join_never_drops_right(self):
        self.assertEqual(
            join_meeting_text("中文内容", "English part"),
            "中文内容 English part",
        )
        self.assertEqual(join_meeting_text("中文内容", "继续内容"), "中文内容继续内容")
        self.assertEqual(join_meeting_text("Hello", "world"), "Hello world")

    def test_gap_ms_prefers_word_and_falls_back_to_wall(self):
        prev = {"id": "q1", "text": "x", "speaker": "A", "opened_at": 0.0, "last_final_at": 10.0, "last_word_ms": 100, "n_words": 1, "rev": 0}
        nxt = {"text": "y", "speaker": "A", "first_word_ms": 200, "n_words": 1}
        self.assertEqual(gap_ms(prev, nxt, 12.0), (100.0, True))
        # no word info -> wall clock
        nxt2 = {"text": "y", "speaker": "A", "first_word_ms": None, "n_words": 1}
        self.assertEqual(gap_ms(prev, nxt2, 12.5), (2500.0, False))


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
        sess = _session(user_id="u1", usage_session_id="s1")
        with mock.patch("server.meter.update_history_text") as upd, mock.patch("server.meter.save_history"):
            self._drive_hold(sess, "prioritizing P, performance availability work. So one of the significant", speaker="A")
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
        self._drive_hold(sess, "Let me finish this thought.", speaker="A")
        self._drive_hold(sess, "Next part.", speaker="A")
        qs = _events(sess, "question")
        self.assertEqual(len(qs), 2)  # two separate lines
        self.assertEqual(len(_events(sess, "line_update")), 0)

    def test_tiny_fragment_is_held_then_flushed(self):
        sess = _session()
        self._drive_hold(sess, "So one", speaker="A")
        p = _events(sess, "partial")
        self.assertEqual(len(p), 1)
        self.assertEqual(len(_events(sess, "question")), 0)
        # open line is still None until the held fragment is flushed
        self.assertIsNone(sess._open_line)
        # flush after the timer
        sess._flush_meeting_hold()
        self.assertEqual(len(_events(sess, "question")), 1)
        self.assertIsNotNone(sess._open_line)


class MeetingWorkerOrderTests(unittest.TestCase):
    def test_turns_emit_in_turn_order(self):
        # The listener thread enqueues finals in AssemblyAI's message order; the
        # worker must preserve it (a later turn never lands before an earlier one).
        sess = _session()
        sess._enqueue_meeting_final("third segment here", "A", "A", {"turn_order": 3, "first_word_ms": 300, "n_words": 3})
        sess._enqueue_meeting_final("fourth segment here", "B", "B", {"turn_order": 4, "first_word_ms": 400, "n_words": 3})
        for _ in range(200):
            if len(_events(sess, "question")) >= 2:
                break
            time.sleep(0.01)
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
        # true -> later finals queue but never reach the transcript (only the live
        # partial shows). The fix: no drain when nothing is running, and the worker
        # clears the flag on exit.
        sess = _session()
        sess._reset_turn_state()  # connect -> sync meeting mode
        self.assertEqual(sess._meeting_finals.qsize(), 0, "no drain sentinel before a worker exists")
        # Consecutive real finals must all land (worker processes every one).
        sess._enqueue_meeting_final("first segment here", "A", "A", {"turn_order": 1, "n_words": 3})
        sess._enqueue_meeting_final("second segment here", "B", "B", {"turn_order": 2, "n_words": 3})
        for _ in range(200):
            if len(_events(sess, "question")) >= 2:
                break
            time.sleep(0.01)
        self.assertEqual(len(_events(sess, "question")), 2, "both finals accumulate in the transcript")


if __name__ == "__main__":
    unittest.main()
