"""Replay of a real STT cadence for Live Q&A (#191 acceptance 9).

A long AssemblyAI turn arrives as SEVERAL finals, seconds apart, with partials
for the following words in between. The old interview path only glued two
finals when they landed within a 2s wall clock, so a ~10s turn lost its earlier
half. These tests drive that cadence on a VIRTUAL clock — consecutive finals
are never called back-to-back as if they were a continuation — and assert:

- nothing is judged while the speaker is still talking;
- nothing is dropped when the fragments arrive slowly;
- exactly one answer for the whole candidate, with the context that belongs to
  it, and no second answer for the same turn.
"""

import json
import re
import threading
import time
import unittest
from collections import deque
from unittest import mock

from server import qa_semantic as qs
from server.app import Session


class _Clock:
    """Mutable virtual clock (``time.time`` patch). Deterministic, no sleeping."""

    def __init__(self, t: float = 1000.0):
        self.t = float(t)

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += float(seconds)


def _prompt_fragments(user_content: str) -> list[tuple[str, str]]:
    return [
        (m.group(1), m.group(2).strip())
        for m in re.finditer(r"^\[([^\]]+)\]\s(.*)$", user_content, re.M)
    ]


def judge_stub(verdict: str = "ready", *, question=None, gate=None):
    def judge(messages, timeout=None):
        if gate is not None:
            gate.wait(5)
        frags = _prompt_fragments(messages[-1]["content"])
        q = question if question is not None else (frags[-1][1] if frags else "")
        return json.dumps(
            {
                "verdict": verdict,
                "question": q or "",
                "fragments": [f[0] for f in frags],
                "reason": "stub",
            }
        )

    return judge


class SttCadenceReplayTests(unittest.TestCase):
    def setUp(self):
        self.clock = _Clock()
        self._time_patch = mock.patch("time.time", self.clock)
        self._time_patch.start()

    def tearDown(self):
        self._time_patch.stop()

    def _session(self, judge=None):
        sess = Session.__new__(Session)
        sess.cfg = {"stt": {}, "ui": {}, "llm": {}}
        sess._workspace = "interview"
        sess._listener = object()
        sess._manual = False
        sess._busy = False
        sess._busy_lock = threading.Lock()
        sess._busy_token = None
        sess._pending_q = deque(maxlen=8)
        sess._pending_asks = []
        sess._pending_speaker = None
        sess._recent_finals = []
        sess._follow_lang = None
        sess._follow_switch_lang = None
        sess._follow_switch_hits = 0
        sess._last_voice_at = 0.0
        sess._meeting_flush_timer = None
        sess._meeting_lock = threading.Lock()
        sess.user_id = None
        sess.emit = mock.Mock()
        sess.pipeline = mock.Mock()
        sess.pipeline._qa_history = []
        sess.pipeline._last_answer = ""
        sess.pipeline._cancel = threading.Event()
        sess.pipeline.process_text = mock.Mock()
        sess.pipeline.judge_qa = mock.Mock(side_effect=judge or judge_stub())
        sess._qa_schedule_judge = mock.Mock()
        return sess

    def _wait(self, pred, timeout=3.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if pred():
                return True
            time.sleep(0.01)
        return pred()

    def _settle(self, sess, timeout=3.0):
        """Fire the settle path only after a realistic quiet gap."""
        sess._qa_activity_at = self.clock.t - (qs.DEFAULT_BUFFER_MAX_SECONDS + 1)
        sess._qa_timer = None
        sess._qa_last_judge_at = 0.0
        sess._qa_settle_fire()
        self._wait(lambda: not sess._qa_judging, timeout)

    def test_ten_second_turn_with_slow_arrivals_joins_and_answers_once(self):
        sess = self._session(judge_stub(question="Will raising the price hurt student retention?"))
        turn = {"listener_id": 7}
        # 0.0s: the first third of the turn ends at the STT boundary.
        sess._on_final("如果我们把价格", "zh", None, {"stt_turn": 11, **turn})
        sess._on_partial("如果我们把价格从", "zh")
        # 3.5s later the second third lands (a slow STT turn, not a 2s window).
        self.clock.advance(3.5)
        sess._on_final("从每月十块提高到十五块", "zh", None, {"stt_turn": 12, **turn})
        sess._on_partial("从每月十块提高到", "zh")
        self.assertEqual(sess.pipeline.judge_qa.call_count, 0)
        # 6.3s later the question itself.
        self.clock.advance(6.3)
        sess._on_final("会不会影响学生用户留存？", "zh", None, {"stt_turn": 13, **turn})
        self.assertEqual(len(sess._qa_buffer), 3)
        sess.pipeline.judge_qa.assert_not_called()

        self.clock.advance(1.4)  # the speaker has now been quiet past the settle window
        sess._qa_activity_at = self.clock.t - 1.4
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)

        # One judgement, one answer, and no fragment lost to the slow arrival.
        self.assertEqual(sess.pipeline.judge_qa.call_count, 1)
        prompt = sess.pipeline.judge_qa.call_args.args[0][-1]["content"]
        for piece in ("如果我们把价格", "从每月十块提高到十五块", "会不会影响学生用户留存"):
            self.assertIn(piece, prompt)
        args, _kwargs = sess.pipeline.process_text.call_args
        self.assertEqual(args[0], "Will raising the price hurt student retention?")
        self.assertEqual(sess.pipeline.process_text.call_count, 1)

    def test_partials_keep_the_window_open_and_the_judge_silent(self):
        sess = self._session(judge_stub())
        partials = ("if we", "if we raise", "if we raise the price", "if we raise the price for")
        for i, p in enumerate(partials):
            self.clock.advance(0.6)  # partials arrive faster than the settle window
            sess._on_partial(p, "en")
            if i == 1:
                sess._on_final("if we raise the price", "en", None, {"stt_turn": 1, "listener_id": 3})
            sess._qa_timer = None  # the mocked scheduler never armed a timer
            self.clock.advance(0.6)
        # While speech keeps flowing, the settle path must not judge yet.
        sess._qa_settle_fire()
        sess.pipeline.judge_qa.assert_not_called()
        # Once the speaker stops for the settle window, judgement happens.
        self.clock.advance(1.4)
        sess._qa_activity_at = self.clock.t - 2.0
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)
        self.assertEqual(sess.pipeline.judge_qa.call_count, 1)

    def test_a_final_during_judgement_discards_the_old_verdict(self):
        gate = threading.Event()
        sess = self._session(judge_stub(question="How should we price the new plan?", gate=gate))
        sess._on_final("how should we price", "en", None, {"stt_turn": 1, "listener_id": 4})
        self._settle(sess)
        self._wait(lambda: sess._qa_judging)
        # The speaker carries on while the model is thinking.
        self.clock.advance(1.9)
        sess._on_partial("how should we price the new", "en")
        sess._on_final("the new subscription plan?", "en", None, {"stt_turn": 2, "listener_id": 4})
        gate.set()
        self._wait(lambda: not sess._qa_judging)
        time.sleep(0.05)
        # The stale verdict for one fragment must not answer.
        sess.pipeline.process_text.assert_not_called()
        # The merged candidate is judged again, and answered exactly once.
        sess._qa_timer = None
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)
        self.assertEqual(sess.pipeline.process_text.call_count, 1)
        prompt = sess.pipeline.judge_qa.call_args.args[0][-1]["content"]
        self.assertIn("how should we price", prompt)
        self.assertIn("the new subscription plan?", prompt)

    def test_background_then_question_across_a_long_gap_is_never_pre_answered(self):
        def routed(messages, timeout=None):
            frags = _prompt_fragments(messages[-1]["content"])
            if len(frags) == 1:
                return json.dumps(
                    {
                        "verdict": qs.VERDICT_BACKGROUND,
                        "question": "",
                        "fragments": [frags[0][0]],
                        "reason": "statement",
                    }
                )
            return json.dumps(
                {
                    "verdict": qs.VERDICT_READY,
                    "question": "How should we price it for students?",
                    "fragments": [frags[-1][0]],
                    "reason": "complete",
                }
            )

        sess = self._session(routed)
        sess._on_final("我们准备做订阅制", "zh", None, {"stt_turn": 1, "listener_id": 5})
        self._settle(sess)
        sess.pipeline.process_text.assert_not_called()
        # 20 seconds later the actual question arrives.
        self.clock.advance(20.0)
        sess._on_final("主要面向学生", "zh", None, {"stt_turn": 2, "listener_id": 5})
        sess._on_final("怎么定价比较好？", "zh", None, {"stt_turn": 3, "listener_id": 5})
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)
        self.assertEqual(sess.pipeline.process_text.call_count, 1)
        self.assertEqual(sess.pipeline.process_text.call_args.args[0], "How should we price it for students?")

    def test_reserved_answer_does_not_get_a_second_generation(self):
        # Acceptance 7: once a turn is answered, a re-delivered final for the
        # SAME turn must not start a second generation, even after a quiet gap.
        sess = self._session(judge_stub(question="How should we price it?"))
        meta = {"stt_turn": 21, "listener_id": 6}
        sess._on_final("how should we price it?", "en", None, meta)
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)
        self.clock.advance(30.0)
        sess._on_final("how should we price it?", "en", None, dict(meta))
        self._settle(sess)
        time.sleep(0.05)
        self.assertEqual(sess.pipeline.process_text.call_count, 1)


if __name__ == "__main__":
    unittest.main()
