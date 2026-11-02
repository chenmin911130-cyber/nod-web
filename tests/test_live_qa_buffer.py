"""Live Q&A semantic continuation + completeness triggering (issue #191).

Session-level tests with a DETERMINISTIC judge stub: no paid model, no network.
The stub reads the fragment ids straight out of the judgement prompt, so the
"integrated question" it returns is grounded in the real buffer — exactly the
shape the server validates.

Determinism rules used here:
- ``sess._qa_schedule_judge`` is replaced by a Mock and the settle fire is
  driven synchronously (``_settle``), so a stray wall-clock timer can never
  double-judge mid-test.
- one test (``test_real_settle_timer_answers_a_short_complete_question``)
  exercises the REAL timer with a shortened settle window, because
  "a complete short question must not be over-waited" is an acceptance item.
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

SETTLE_PAD = 0.5


def _prompt_fragments(user_content: str) -> list[tuple[str, str]]:
    return [
        (m.group(1), m.group(2).strip())
        for m in re.finditer(r"^\[([^\]]+)\]\s(.*)$", user_content, re.M)
    ]


def judge_stub(verdict: str = "ready", *, question=None, reason="stub", fragments=None, raw=None, delay=0.0, gate=None):
    """Deterministic stand-in for ``Pipeline.judge_qa``."""

    def judge(messages, timeout=None):
        if gate is not None:
            gate.wait(5)
        if delay:
            time.sleep(delay)
        if raw is not None:
            return raw
        frags = _prompt_fragments(messages[-1]["content"])
        ids = [f[0] for f in frags]
        cited = ids if fragments is None else fragments
        q = question
        if q is None and verdict == qs.VERDICT_READY:
            q = frags[-1][1] if frags else ""
        return json.dumps(
            {"verdict": verdict, "question": q or "", "fragments": cited, "reason": reason}
        )

    return judge


class _QaBase(unittest.TestCase):
    def _session(self, judge=None, workspace="interview"):
        sess = Session.__new__(Session)
        sess.cfg = {"stt": {}, "ui": {}, "llm": {}}
        sess._workspace = workspace
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
        sess.pipeline.judge_qa = mock.Mock(
            side_effect=judge if judge is not None else judge_stub(qs.VERDICT_WAIT)
        )
        sess._qa_schedule_judge = mock.Mock()
        # enough state for set_workspace / _reset_turn_state to run
        sess._listen_wanted = False
        sess._handoff_listener = None
        sess._paused = False
        sess._engine = "idle"
        return sess

    def _wait(self, pred, timeout=3.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if pred():
                return True
            time.sleep(0.01)
        return pred()

    def _settle(self, sess, timeout=3.0) -> None:
        """Make the candidate look quiet, then fire the settle path once."""
        sess._qa_activity_at = time.time() - (qs.DEFAULT_BUFFER_MAX_SECONDS + 1)
        sess._qa_timer = None
        sess._qa_last_judge_at = 0.0
        sess._qa_settle_fire()
        self._wait(lambda: not sess._qa_judging, timeout)

    def _answers(self, sess) -> list[str]:
        return [c.args[0] for c in sess.pipeline.process_text.call_args_list]

    def _events(self, sess) -> list[dict]:
        return [c.args[0] for c in sess.emit.call_args_list if c.args]


class SemanticBufferTests(_QaBase):
    def test_fragments_accumulate_across_slow_stt_boundaries(self):
        # Acceptance 1: three fragments, seconds apart (a slow long STT turn),
        # must join into ONE candidate and be answered once.
        sess = self._session(judge_stub(qs.VERDICT_READY, question="Will raising the price hurt retention?"))
        sess._on_final("如果我们把价格", "zh", None, {"stt_turn": 1, "listener_id": 1})
        sess.pipeline.judge_qa.assert_not_called()
        sess._on_final("从每月十块提高到十五块", "zh", None, {"stt_turn": 2, "listener_id": 1})
        sess._on_final("会不会影响学生用户留存？", "zh", None, {"stt_turn": 3, "listener_id": 1})
        self.assertEqual(len(sess._qa_buffer), 3)
        sess.pipeline.judge_qa.assert_not_called()  # no model call per fragment
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)
        joined = "如果我们把价格从每月十块提高到十五块会不会影响学生用户留存？"
        self.assertEqual(self._answers(sess), [joined])
        self.assertEqual(sess.pipeline.judge_qa.call_count, 0)

    def test_revision_of_same_turn_replaces_instead_of_stacking(self):
        sess = self._session(judge_stub(qs.VERDICT_WAIT))
        sess._on_final("we price it at ten", "en", None, {"stt_turn": 4, "listener_id": 1})
        sess._on_final("we price it at ten dollars", "en", None, {"stt_turn": 4, "listener_id": 1, "revision": True})
        self.assertEqual(len(sess._qa_buffer), 1)
        self.assertEqual(sess._qa_buffer[0]["text"], "we price it at ten dollars")

    def test_background_statement_is_not_answered_and_is_kept(self):
        # Acceptance 2/4: background statements must not trigger an answer, but
        # they stay available for the later question.
        sess = self._session(judge_stub(qs.VERDICT_BACKGROUND))
        sess._on_final("我们准备做订阅制", "zh", None, {"stt_turn": 1, "listener_id": 1})
        sess._on_final("主要面向学生", "zh", None, {"stt_turn": 2, "listener_id": 1})
        self._settle(sess)
        sess.pipeline.process_text.assert_not_called()
        self.assertEqual(sess._qa_buffer, [])
        self.assertEqual(sess._qa_background, ["我们准备做订阅制", "主要面向学生"])
        self.assertEqual(qs.VERDICT_BACKGROUND, "background")

    def test_wait_verdict_keeps_listening_and_does_not_answer(self):
        # Acceptance 3: a pause after "我想知道……" must not force an answer.
        sess = self._session(judge_stub(qs.VERDICT_WAIT))
        sess._on_final("我想知道", "zh", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)
        sess.pipeline.process_text.assert_not_called()
        self.assertEqual(len(sess._qa_buffer), 1)
        statuses = [e for e in self._events(sess) if e.get("type") == "status"]
        self.assertTrue(any("Keep listening" in str(e.get("text")) for e in statuses))

    def test_wait_verdict_is_not_rejudged_until_a_new_fragment_arrives(self):
        sess = self._session(judge_stub(qs.VERDICT_WAIT))
        sess._on_final("我想知道", "zh", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)
        self.assertEqual(sess.pipeline.judge_qa.call_count, 1)
        # Re-firing the settle path for the SAME buffer version must not re-bill.
        self._settle(sess)
        self.assertEqual(sess.pipeline.judge_qa.call_count, 1)
        # A new fragment re-opens judgement.
        sess._on_final("大概要多少", "zh", None, {"stt_turn": 2, "listener_id": 1})
        self._settle(sess)
        self.assertEqual(sess.pipeline.judge_qa.call_count, 1)
        self._wait(lambda: sess.pipeline.process_text.called)

    def test_ready_answers_once_per_turn_and_a_resent_final_is_not_answered_twice(self):
        # Acceptance 7: final re-send / revision of the same turn answers once.
        sess = self._session(judge_stub(qs.VERDICT_READY, question="How should we price it?"))
        meta = {"stt_turn": 9, "listener_id": 1}
        sess._on_final("how should we price it", "en", None, meta)
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)
        self.assertEqual(sess.pipeline.process_text.call_count, 1)
        # The STT layer re-delivers the same turn (final re-send).
        sess._on_final("how should we price it", "en", None, dict(meta))
        self._settle(sess)
        self._wait(lambda: not sess._qa_judging)
        self.assertEqual(sess.pipeline.process_text.call_count, 1)
        self.assertEqual(sess._qa_buffer, [])

    def test_a_later_repeat_question_is_not_swallowed_by_text_similarity(self):
        # Acceptance 7: dedupe keys on turn identity, never on text alone.
        sess = self._session(judge_stub(qs.VERDICT_READY, question="What is CAP theorem?"))
        sess._on_final("What is CAP theorem", "en", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)
        sess._on_final("What is CAP theorem", "en", None, {"stt_turn": 2, "listener_id": 1})
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.call_count == 2)
        self.assertEqual(sess.pipeline.process_text.call_count, 2)

    def test_partial_invalidates_an_in_flight_verdict(self):
        # Acceptance 7: if the speaker continues while the model decides, the
        # stale verdict must not answer.
        gate = threading.Event()
        sess = self._session(judge_stub(qs.VERDICT_READY, question="stale?", gate=gate))
        sess._on_final("how should we", "en", None, {"stt_turn": 1, "listener_id": 1})
        sess._qa_activity_at = time.time() - (qs.DEFAULT_BUFFER_MAX_SECONDS + 1)
        sess._qa_settle_fire()
        self._wait(lambda: sess._qa_judging)
        sess._on_partial("how should we price", "en")  # speaker resumed
        gate.set()
        self._wait(lambda: not sess._qa_judging)
        time.sleep(0.05)
        sess.pipeline.process_text.assert_not_called()

    def test_stale_generation_after_reset_cannot_answer(self):
        # Acceptance 8: New / clear while a judgement is in flight.
        gate = threading.Event()
        sess = self._session(judge_stub(qs.VERDICT_READY, question="late?", gate=gate))
        sess._on_final("tell me about pricing", "en", None, {"stt_turn": 1, "listener_id": 1})
        sess._qa_activity_at = time.time() - (qs.DEFAULT_BUFFER_MAX_SECONDS + 1)
        sess._qa_settle_fire()
        self._wait(lambda: sess._qa_judging)
        sess._qa_reset("clear")
        gate.set()
        self._wait(lambda: not sess._qa_judging)
        time.sleep(0.05)
        sess.pipeline.process_text.assert_not_called()

    def test_judge_failure_invalid_reply_and_timeout_never_answer(self):
        bad = (
            judge_stub(raw=""),
            judge_stub(raw="not json at all"),
            judge_stub(raw="{verdict: ready"),
            mock.Mock(side_effect=lambda messages, timeout=None: None),
        )
        for stub in bad:
            sess = self._session(stub)
            sess._on_final("what should we charge", "en", None, {"stt_turn": 1, "listener_id": 1})
            self._settle(sess)
            sess.pipeline.process_text.assert_not_called()
            # Bounded buffer retained; manual submit still possible.
            self.assertEqual(len(sess._qa_buffer), 1)

    def test_judge_exception_never_answers_and_does_not_retry_the_same_version(self):
        bomb = mock.Mock(side_effect=RuntimeError("upstream timeout"))
        sess = self._session(bomb)
        sess._on_final("what should we charge", "en", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)
        sess.pipeline.process_text.assert_not_called()
        self._settle(sess)
        self._settle(sess)
        self.assertEqual(bomb.call_count, 1, "a failed judgement must not be retried in a loop")

    def test_a_verdict_invalidated_by_continuation_is_rejudged_once(self):
        # Acceptance 7/8: the speaker continues (partials only, no new final)
        # while the model is thinking. The discarded verdict must not be
        # forgotten — once speech is quiet again the SAME candidate is judged
        # once more and answered, and it is never re-judged in a loop.
        gate = threading.Event()
        sess = self._session(judge_stub(qs.VERDICT_READY, question="How should we price it?", gate=gate))
        sess._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
        sess._qa_activity_at = time.time() - (qs.DEFAULT_BUFFER_MAX_SECONDS + 1)
        sess._qa_settle_fire()
        self._wait(lambda: sess._qa_judging)
        sess._on_partial("how should we price it for", "en")  # speech resumed
        gate.set()
        self._wait(lambda: not sess._qa_judging)
        time.sleep(0.05)
        sess.pipeline.process_text.assert_not_called()
        # Second pass over the SAME (unchanged) buffer version.
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)
        self.assertEqual(sess.pipeline.process_text.call_count, 1)
        self.assertEqual(sess.pipeline.judge_qa.call_count, 2)
        # And it stays quiet from here: no per-timer re-judge loop.
        self._settle(sess)
        self._settle(sess)
        self.assertEqual(sess.pipeline.judge_qa.call_count, 2)

    def test_no_model_call_for_partials_alone(self):
        # Acceptance: partials only hint that the speaker continues.
        sess = self._session(judge_stub(qs.VERDICT_READY))
        for t in ("if we", "if we raise", "if we raise the price"):
            sess._on_partial(t, "en")
        sess.pipeline.judge_qa.assert_not_called()
        sess.pipeline.process_text.assert_not_called()

    def test_judgement_does_not_touch_capture_or_engine(self):
        gate = threading.Event()
        sess = self._session(judge_stub(qs.VERDICT_WAIT, gate=gate))
        sess._qa_engine = sess._engine = "transcribing"
        sess._paused = False
        sess._on_final("我想知道", "zh", None, {"stt_turn": 1, "listener_id": 1})
        sess.emit.reset_mock()
        sess._qa_activity_at = time.time() - (qs.DEFAULT_BUFFER_MAX_SECONDS + 1)
        sess._qa_settle_fire()
        self._wait(lambda: sess._qa_judging)
        gate.set()
        self._wait(lambda: not sess._qa_judging)
        phases = [e for e in self._events(sess) if e.get("type") in ("phase", "state")]
        self.assertEqual(phases, [], f"a judgement must not move capture/engine: {phases}")

    def test_workspace_switch_drops_the_candidate(self):
        sess = self._session(judge_stub(qs.VERDICT_READY))
        sess._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
        sess.set_workspace("meeting")
        self.assertEqual(sess._qa_buffer, [])
        self._settle(sess)
        sess.pipeline.process_text.assert_not_called()

    def test_stop_commit_force_submits_a_wait_candidate(self):
        sess = self._session(judge_stub(qs.VERDICT_WAIT))
        sess._on_final("我想知道", "zh", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)
        sess._qa_stop_commit()
        self._wait(lambda: sess.pipeline.process_text.called)
        self.assertEqual(self._answers(sess), ["我想知道"])
        self.assertEqual(sess._qa_buffer, [])

    def test_stop_commit_submits_a_still_valid_ready_verdict(self):
        sess = self._session(judge_stub(qs.VERDICT_WAIT))
        frag = qs.new_fragment("how should we price it?", "en", frag_id="t1:1", at=time.time())
        sess._qa_buffer = [frag]
        sess._qa_version = 7
        sess._qa_verdict = {
            "version": 7,
            "verdict": qs.VERDICT_READY,
            "question": "How should we price it?",
            "fragments": ["t1:1"],
        }
        sess._qa_stop_commit()
        self._wait(lambda: sess.pipeline.process_text.called)
        self.assertEqual(self._answers(sess), ["How should we price it?"])

    def test_manual_submit_suppresses_the_same_candidate_and_keeps_unrelated_ones(self):
        # Acceptance: manual submit wins; the same candidate is not auto-answered
        # afterwards, and unrelated candidates are kept as background.
        sess = self._session(judge_stub(qs.VERDICT_READY, question="auto?"))
        meta = {"stt_turn": 5, "listener_id": 1}
        sess._on_final("how should we price it", "en", None, meta)
        sess.ask("typed question instead", None, "ask")
        self.assertEqual(sess._qa_buffer, [])
        self.assertIn("t1:5", sess._qa_answered)
        self.assertEqual(sess._qa_background, ["how should we price it"])
        sess.pipeline.judge_qa.reset_mock()
        sess._on_final("how should we price it", "en", None, dict(meta))
        self._settle(sess)
        sess.pipeline.judge_qa.assert_not_called()
        self.assertTrue(sess._qa_candidate_id == "")

    def test_fragments_arriving_while_answering_form_a_second_candidate(self):
        # Acceptance: later fragments go to an independent candidate and are not
        # folded into the question already being answered.
        gate = threading.Event()
        first = judge_stub(qs.VERDICT_READY, question="first question?")
        second = judge_stub(qs.VERDICT_READY, question="second question?")

        def routed(messages, timeout=None):
            return first(messages, timeout) if "first" in messages[-1]["content"] else second(messages, timeout)

        sess = self._session(routed)
        calls: list[str] = []

        def fake_pt(text, mode, *a, **kw):
            calls.append(text)
            if len(calls) == 1:
                gate.wait(5)

        sess.pipeline.process_text = fake_pt
        sess._on_final("first question?", "en", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)
        self._wait(lambda: len(calls) == 1)
        # The speaker keeps talking while the answer streams.
        sess._on_final("second question?", "en", None, {"stt_turn": 2, "listener_id": 1})
        self._settle(sess)
        gate.set()
        self._wait(lambda: len(calls) == 2, timeout=5)
        self.assertEqual(calls, ["first question?", "second question?"])

    def test_real_settle_timer_answers_a_short_complete_question(self):
        # Acceptance: a complete short question must not be over-waited.
        import server.app as app_mod

        sess = self._session(judge_stub(qs.VERDICT_READY, question="Why?"))
        del sess._qa_schedule_judge  # restore the real timer
        old = app_mod.QA_SETTLE_SECONDS
        app_mod.QA_SETTLE_SECONDS = 0.2
        try:
            sess._on_final("Why?", "en", None, {"stt_turn": 1, "listener_id": 1})
            started = time.time()
            self._wait(lambda: sess.pipeline.process_text.called, timeout=3)
            self.assertTrue(sess.pipeline.process_text.called, "a complete short question was never answered")
            self.assertLess(time.time() - started, 2.5)
        finally:
            app_mod.QA_SETTLE_SECONDS = old

    def test_session_background_does_not_leak_between_sessions(self):
        sess_a = self._session(judge_stub(qs.VERDICT_BACKGROUND))
        sess_a._on_final("we plan a subscription", "en", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess_a)
        self.assertEqual(sess_a._qa_background, ["we plan a subscription"])
        sess_b = self._session(judge_stub(qs.VERDICT_BACKGROUND))
        self.assertEqual(getattr(sess_b, "_qa_background", []), [])


class JudgePromptPrivacyTests(_QaBase):
    def test_default_logs_do_not_carry_the_transcript(self):
        # The structured qa_* logs must carry ids/counts/reasons, never the text.
        import logging

        records: list[str] = []

        class _Handler(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage())

        logger = logging.getLogger("nod")
        handler = _Handler()
        logger.addHandler(handler)
        old_level = logger.level
        logger.setLevel(logging.INFO)
        try:
            sess = self._session(judge_stub(qs.VERDICT_READY, question="SECRET integrated question"))
            sess._on_final("SECRET transcript words here", "en", None, {"stt_turn": 1, "listener_id": 1})
            self._settle(sess)
            self._wait(lambda: sess.pipeline.process_text.called)
        finally:
            logger.removeHandler(handler)
            logger.setLevel(old_level)
        qa_logs = [r for r in records if r.startswith("qa_")]
        self.assertTrue(qa_logs, "expected qa_* observability logs")
        joined = "\n".join(qa_logs)
        self.assertNotIn("SECRET transcript words here", joined)
        self.assertNotIn("SECRET integrated question", joined)
        self.assertTrue(any("qa_frag" in r for r in qa_logs))
        self.assertTrue(any("qa_submit" in r for r in qa_logs))


class AnswerContextTests(_QaBase):
    """#191 acceptance 2/5/6: background + the previous round must reach the
    ANSWER as context, without rewriting the user-visible question."""

    def test_background_and_uncited_lead_in_become_the_answer_context(self):
        seen: dict[str, str] = {}

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
                    "question": "How should we price it?",
                    "fragments": [frags[-1][0]],
                    "reason": "complete",
                }
            )

        sess = self._session(routed)

        def fake_pt(text, mode, *a, **kw):
            seen["text"] = text
            seen["ctx"] = sess.pipeline._qa_context

        sess.pipeline.process_text = fake_pt
        sess._on_final("我们准备做订阅制", "zh", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)
        self.assertEqual(sess._qa_background, ["我们准备做订阅制"])
        # The new question: a lead-in the model does NOT cite + the question it does.
        sess._on_final("他们可能不愿意按月付钱", "zh", None, {"stt_turn": 2, "listener_id": 1})
        sess._on_final("怎么定价比较好", "zh", None, {"stt_turn": 3, "listener_id": 1})
        self._settle(sess)
        self._wait(lambda: "text" in seen)
        # The user-visible question is the integrated question only.
        self.assertEqual(seen["text"], "How should we price it?")
        self.assertNotIn("我们准备做订阅制", seen["text"])
        # The background and the uncited lead-in ride along as answer context.
        self.assertIn("我们准备做订阅制", seen["ctx"])
        self.assertIn("他们可能不愿意按月付钱", seen["ctx"])
        self.assertNotIn("怎么定价比较好", seen["ctx"])
        # And the addendum is scoped to this generation only.
        self._wait(lambda: sess.pipeline._qa_context == "")
        self.assertEqual(sess.pipeline._qa_context, "")

    def test_self_follow_up_question_only_carries_prior_round_context(self):
        # Acceptance 6: "那按年付呢" after a pricing answer must be answered with
        # the previous round available (that comes from _qa_history, which the
        # prompt already carries — not duplicated into the context block).
        seen: dict[str, str] = {}
        sess = self._session(judge_stub(qs.VERDICT_READY, question="按年付费的价格是多少？"))
        sess.pipeline._qa_history = [
            {"qid": "1", "q": "订阅制怎么定价？", "a": "按月十块。"},
        ]

        def fake_pt(text, mode, *a, **kw):
            seen["text"] = text
            seen["ctx"] = sess.pipeline._qa_context

        sess.pipeline.process_text = fake_pt
        sess._on_final("那按年付费", "zh", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)
        self._wait(lambda: "text" in seen)
        self.assertEqual(seen["text"], "按年付费的价格是多少？")
        self.assertNotIn("按月十块", seen["ctx"])

    def test_a_new_session_context_does_not_leak_into_the_next_answer(self):
        sess = self._session(judge_stub(qs.VERDICT_READY, question="q1?"))
        sess._qa_background = ["session A only"]
        seen: dict[str, str] = {}
        sess.pipeline.process_text = lambda text, mode, *a, **kw: seen.update(
            text=text, ctx=sess.pipeline._qa_context
        )
        frag = qs.new_fragment("q1?", "en", frag_id="t1:1", at=time.time())
        sess._qa_buffer = [frag]
        sess._qa_version = 4
        sess._qa_verdict = {
            "version": 4,
            "verdict": qs.VERDICT_READY,
            "question": "q1?",
            "fragments": ["t1:1"],
        }
        sess._qa_stop_commit()
        self._wait(lambda: "text" in seen)
        self.assertIn("session A only", seen["ctx"])
        sess._qa_reset("clear")
        self.assertEqual(sess._qa_background, [])


class PromptContextTests(unittest.TestCase):
    """Pipeline-level: the context addendum lands in the ask SYSTEM prompt."""

    def _pipe(self):
        from server.app import Pipeline

        pipe = Pipeline.__new__(Pipeline)
        pipe.cfg = {
            "llm": {"provider": "deepseek", "model": "deepseek-v4-flash"},
            "stt": {},
            "ui": {},
            "profile": {},
        }
        pipe.emit = mock.Mock()
        pipe._provider = "deepseek"
        pipe._model = "deepseek-v4-flash"
        pipe._qa_history = []
        pipe._last_answer = ""
        pipe._heard_lang = None
        pipe._qa_context = ""
        return pipe

    def test_context_block_reaches_the_ask_system_prompt_only(self):
        pipe = self._pipe()
        pipe._qa_context = qs.context_block(["we plan a subscription for students"])
        msgs = pipe._build_messages("How should we price it?", "ask")
        self.assertIn("we plan a subscription for students", msgs[0]["content"])
        self.assertNotIn("we plan a subscription for students", msgs[1]["content"])
        self.assertIn("How should we price it?", msgs[1]["content"])

    def test_no_context_leaves_the_prompt_untouched(self):
        pipe = self._pipe()
        msgs = pipe._build_messages("How should we price it?", "ask")
        self.assertNotIn("Background from this live conversation", msgs[0]["content"])

    def test_prior_qa_route_is_unchanged(self):
        pipe = self._pipe()
        pipe._qa_history = [{"qid": "1", "q": "订阅制怎么定价？", "a": "按月十块。"}]
        pipe._qa_context = qs.context_block(["we plan a subscription"])
        msgs = pipe._build_messages("那按年付呢？", "ask")
        self.assertIn("Recent confirmed Q&A", msgs[0]["content"])
        self.assertIn("按月十块", msgs[0]["content"])
        self.assertIn("we plan a subscription", msgs[0]["content"])

    def test_context_block_is_bounded(self):
        pipe = self._pipe()
        pipe._qa_context = qs.context_block(["x" * 200, "y" * 200, "z" * 200], max_chars=300)
        msgs = pipe._build_messages("q?", "ask")
        self.assertNotIn("z" * 200, msgs[0]["content"])


class LifecycleTests(_QaBase):
    """#191: New / workspace switch / stop / disconnect / cancel must have an
    explicit invalidation rule for timer, buffer, in-flight judgement and queue."""

    def test_close_drops_the_candidate_without_answering(self):
        sess = self._session(judge_stub(qs.VERDICT_READY, question="late?"))
        sess._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
        # A ready verdict already computed but not yet committed.
        sess._qa_verdict = {
            "version": sess._qa_version,
            "verdict": qs.VERDICT_READY,
            "question": "late?",
            "fragments": ["t1:1"],
        }
        # Keep the teardown focused on the QA contract.
        sess._detach_control_emit = mock.Mock()
        sess._close_audio_uplink = mock.Mock()
        sess._stop_listening = mock.Mock()
        sess.pipeline.abort_stream = mock.Mock()
        sess._flush_cloud_archive = mock.Mock()
        sess.usage_session_id = None
        sess.audio_token = "tok"
        sess._closed = False
        sess.close()
        sess.pipeline.process_text.assert_not_called()
        self.assertEqual(sess._qa_buffer, [])

    def test_fresh_listen_session_resets_the_candidate(self):
        sess = self._session(judge_stub(qs.VERDICT_READY))
        sess._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
        gen = sess._qa_gen
        sess._listen_wanted = False  # room for assertion; the socket is not started
        with mock.patch("server.app.CloudListener"):
            sess._open_listener(resume=False)
        self.assertEqual(sess._qa_buffer, [])
        self.assertGreater(sess._qa_gen, gen)
        sess.pipeline.process_text.assert_not_called()

    def test_new_speech_after_a_pause_extends_the_candidate(self):
        # The same listening session continues across a pause: the earlier
        # fragment is kept and new speech extends the same candidate.
        sess = self._session(judge_stub(qs.VERDICT_WAIT))
        sess._on_final("我想知道", "zh", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)  # first judgement: still incomplete
        self.assertEqual(len(sess._qa_buffer), 1)
        sess._on_partial("大概要多少", "zh")  # speech resumed
        sess._on_final("大概要多少钱", "zh", None, {"stt_turn": 2, "listener_id": 1})
        self.assertEqual(len(sess._qa_buffer), 2)
        self.assertIsNone(sess._qa_verdict)  # the old verdict was invalidated

    def test_cancel_generate_does_not_swallow_the_pending_candidate(self):
        # Cancel stops the current generation; the candidate is a separate
        # concern and must still be answerable (manual or a later judgement).
        sess = self._session(judge_stub(qs.VERDICT_READY, question="How should we price it?"))
        sess._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
        sess.cancel_generate()
        self.assertEqual(len(sess._qa_buffer), 1)
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)
        self.assertEqual(self._answers(sess), ["How should we price it?"])

    def test_stop_commit_submits_without_logging_transcript_in_qa_drop(self):
        records: list[str] = []
        import logging

        class _Handler(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage())

        logger = logging.getLogger("nod")
        handler = _Handler()
        logger.addHandler(handler)
        old_level = logger.level
        logger.setLevel(logging.INFO)
        try:
            sess = self._session(judge_stub(qs.VERDICT_WAIT))
            sess._on_final("SECRET turn text", "en", None, {"stt_turn": 1, "listener_id": 1})
            sess._qa_stop_commit()
            self._wait(lambda: sess.pipeline.process_text.called)
        finally:
            logger.removeHandler(handler)
            logger.setLevel(old_level)
        drops = [r for r in records if r.startswith("qa_drop")]
        self.assertFalse(drops)
        self.assertNotIn("SECRET", "\n".join(records))

    def test_local_obvious_question_skips_the_model_judge(self):
        sess = self._session(judge_stub(qs.VERDICT_WAIT))
        sess._on_final("Why?", "en", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)
        sess.pipeline.judge_qa.assert_not_called()
        self.assertEqual(self._answers(sess), ["Why?"])

    def test_wait_verdict_emits_qa_wait_and_force_submits_after_cap(self):
        import server.app as app_mod

        old = app_mod.QA_WAIT_FORCE_SUBMIT_SECONDS
        app_mod.QA_WAIT_FORCE_SUBMIT_SECONDS = 0.05
        try:
            sess = self._session(judge_stub(qs.VERDICT_WAIT))
            sess._on_final("我想知道", "zh", None, {"stt_turn": 1, "listener_id": 1})
            self._settle(sess)
            waits = [e for e in self._events(sess) if e.get("type") == "qa_wait"]
            self.assertTrue(waits)
            self.assertEqual(waits[-1].get("text"), "我想知道")
            time.sleep(0.12)
            self._wait(lambda: sess.pipeline.process_text.called, timeout=2)
            self.assertEqual(self._answers(sess), ["我想知道"])
        finally:
            app_mod.QA_WAIT_FORCE_SUBMIT_SECONDS = old


class ReviewFixTests(_QaBase):
    """Blockers from the #191 review: the input prefilter and the post-hoc commit."""

    def _start_judge(self, sess) -> bool:
        """Fire the settle path and return once the judge worker is in flight."""
        sess._qa_activity_at = time.time() - (qs.DEFAULT_BUFFER_MAX_SECONDS + 1)
        sess._qa_timer = None
        sess._qa_last_judge_at = 0.0
        sess._qa_settle_fire()
        return self._wait(lambda: sess._qa_judging)

    def test_short_follow_up_reaches_the_model_instead_of_the_prefilter(self):
        # `guard_question` rejected "按年付" BEFORE the buffer (6 units, no question
        # word → its 4..7 fallback is "reject"), so a legitimate short follow-up was
        # never judged at all. The prefilter is gone: identity is the only dedupe.
        from server.app import guard_question

        self.assertEqual(guard_question("按年付", [], None), "reject")

        sess = self._session(judge_stub(qs.VERDICT_WAIT))
        sess._on_final("订阅怎么定价比较好", "zh", None, {"stt_turn": 1, "listener_id": 1})
        sess._on_final("按年付", "zh", None, {"stt_turn": 2, "listener_id": 1})
        self.assertEqual([f["text"] for f in sess._qa_buffer], ["订阅怎么定价比较好", "按年付"])
        self._settle(sess)
        prompt = sess.pipeline.judge_qa.call_args.args[0][-1]["content"]
        self.assertIn("按年付", prompt)
        self.assertEqual(sess.pipeline.judge_qa.call_count, 1)

    def test_answer_echo_is_no_longer_dropped_before_the_model(self):
        # An echo of the previous answer was another `guard_question` reject path
        # ("_is_answer_echo"): the user restating the answer as a lead-in is a turn.
        sess = self._session(judge_stub(qs.VERDICT_WAIT))
        sess.pipeline._last_answer = "订阅制就是按月付费"
        sess._on_final("订阅制就是按月付费", "zh", None, {"stt_turn": 1, "listener_id": 1})
        self.assertEqual(len(sess._qa_buffer), 1)

    def test_the_same_question_twice_is_a_new_turn_not_a_similarity_drop(self):
        # The text-ratio reject (>0.9 against a recent question) swallowed a question
        # the user asked twice; dedupe must be by turn identity, not by text.
        from server.app import guard_question

        self.assertEqual(guard_question("订阅怎么定价比较好？", ["订阅怎么定价比较好？"], None), "reject")

        sess = self._session(judge_stub(qs.VERDICT_READY, question="订阅怎么定价比较好？"))
        sess._on_final("订阅怎么定价比较好", "zh", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)
        sess._on_final("订阅怎么定价比较好", "zh", None, {"stt_turn": 2, "listener_id": 1})
        self.assertEqual([f["text"] for f in sess._qa_buffer], ["订阅怎么定价比较好"])
        self._settle(sess)
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.call_count == 2))
        self.assertEqual(sess.pipeline.judge_qa.call_count, 2)

    def test_manual_submit_during_judgement_never_answers_the_old_candidate(self):
        gate = threading.Event()
        sess = self._session(judge_stub(qs.VERDICT_READY, question="stale", gate=gate))
        sess._start_interview_answer = mock.Mock()
        sess._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
        self.assertTrue(self._start_judge(sess))
        sess._qa_on_manual_submit()  # the user typed/recorded while the model thought
        gate.set()
        self.assertTrue(self._wait(lambda: not sess._qa_judging))
        sess._start_interview_answer.assert_not_called()
        self.assertEqual(sess._qa_buffer, [])
        self.assertEqual(sess.pipeline.process_text.call_count, 0)

    def test_new_session_during_judgement_never_answers_the_old_candidate(self):
        gate = threading.Event()
        sess = self._session(judge_stub(qs.VERDICT_READY, question="from the old session", gate=gate))
        sess._start_interview_answer = mock.Mock()
        sess._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
        self.assertTrue(self._start_judge(sess))
        sess._qa_reset("new_session")  # New / clear / workspace switch
        gate.set()
        self.assertTrue(self._wait(lambda: not sess._qa_judging))
        sess._start_interview_answer.assert_not_called()
        self.assertEqual(sess._qa_buffer, [])

    def test_a_commit_for_a_superseded_candidate_is_refused(self):
        # The narrow window the review called out: the worker validated the version,
        # released the lock, and only THEN committed. A manual submit / New / a new
        # fragment landing in that window must make the commit a no-op.
        sess = self._session(judge_stub(qs.VERDICT_READY))
        sess._start_interview_answer = mock.Mock()
        sess._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
        version, gen = sess._qa_version, sess._qa_gen
        frags = [dict(f) for f in sess._qa_buffer]
        verdict = {
            "version": version,
            "verdict": qs.VERDICT_READY,
            "question": "how should we price it?",
            "fragments": [frags[0]["id"]],
        }
        # (a) a manual submit moved the candidate on (generation + version bumped)
        sess._qa_on_manual_submit()
        self.assertFalse(
            sess._qa_commit("stale", frags, verdict=verdict, trigger="judge", version=version, gen=gen)
        )
        sess._start_interview_answer.assert_not_called()
        self.assertEqual(sess._qa_buffer, [])
        # (b) same generation, but the buffer moved on (a new fragment)
        sess2 = self._session(judge_stub(qs.VERDICT_READY))
        sess2._start_interview_answer = mock.Mock()
        sess2._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
        v2, g2 = sess2._qa_version, sess2._qa_gen
        frags2 = [dict(f) for f in sess2._qa_buffer]
        sess2._on_final("那按年付呢", "zh", None, {"stt_turn": 2, "listener_id": 1})
        self.assertFalse(
            sess2._qa_commit("stale", frags2, verdict=verdict, trigger="judge", version=v2, gen=g2)
        )
        sess2._start_interview_answer.assert_not_called()
        # the follow-up that arrived while the verdict was in flight survives
        self.assertEqual([f["text"] for f in sess2._qa_buffer], ["how should we price it", "那按年付呢"])

    def test_a_demote_for_a_superseded_candidate_keeps_the_new_fragments(self):
        sess = self._session(judge_stub(qs.VERDICT_BACKGROUND))
        sess._on_final("我们准备做订阅制", "zh", None, {"stt_turn": 1, "listener_id": 1})
        version, gen = sess._qa_version, sess._qa_gen
        frags = [dict(f) for f in sess._qa_buffer]
        sess._on_final("那按年付呢", "zh", None, {"stt_turn": 2, "listener_id": 1})
        self.assertFalse(
            sess._qa_demote_to_background(
                frags, {"verdict": qs.VERDICT_BACKGROUND}, version=version, gen=gen
            )
        )
        self.assertEqual([f["text"] for f in sess._qa_buffer], ["我们准备做订阅制", "那按年付呢"])
        self.assertEqual(sess._qa_background, [])

    def test_a_partial_during_judgement_discards_the_verdict(self):
        # A partial bumps neither the version nor the generation — it only proves
        # the speaker is still going. Without an activity re-check at commit time
        # the old answer lands while the user is mid-sentence.
        gate = threading.Event()
        sess = self._session(judge_stub(qs.VERDICT_READY, question="stale", gate=gate))
        sess._start_interview_answer = mock.Mock()
        sess._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
        version = sess._qa_version
        self.assertTrue(self._start_judge(sess))
        sess._on_partial("that depends on", "en")
        self.assertEqual(sess._qa_version, version)  # the partial changed no version
        gate.set()
        self.assertTrue(self._wait(lambda: not sess._qa_judging))
        sess._start_interview_answer.assert_not_called()
        self.assertEqual(len(sess._qa_buffer), 1)  # kept for the next judgement

    def test_a_commit_after_a_partial_is_refused_with_matching_version_and_gen(self):
        # The exact window: version AND generation still match, but the activity
        # clock moved. This checks the guard directly, because the worker's own
        # activity check happens earlier (before it calls the commit).
        sess = self._session(judge_stub(qs.VERDICT_READY))
        sess._start_interview_answer = mock.Mock()
        sess._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
        version, gen = sess._qa_version, sess._qa_gen
        frags = [dict(f) for f in sess._qa_buffer]
        judged_at = time.time()
        sess._on_partial("still going", "en")
        self.assertEqual((sess._qa_version, sess._qa_gen), (version, gen))
        verdict = {
            "version": version,
            "verdict": qs.VERDICT_READY,
            "question": "how should we price it?",
            "fragments": [frags[0]["id"]],
        }
        self.assertFalse(
            sess._qa_commit(
                "how should we price it?",
                frags,
                verdict=verdict,
                trigger="judge",
                version=version,
                gen=gen,
                judged_at=judged_at,
            )
        )
        sess._start_interview_answer.assert_not_called()
        self.assertEqual(len(sess._qa_buffer), 1)  # not consumed by the stale commit

    def test_an_answer_start_after_a_reset_is_refused(self):
        # The commit validated the candidate and released its lock; a New that lands
        # before the answer starts must not start it (the start point re-checks the
        # generation), and neither may the run itself generate.
        sess = self._session(judge_stub(qs.VERDICT_READY))
        sess._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
        gen = sess._qa_gen
        session_gen = sess._qa_session_gen
        sess._qa_reset("new_session")
        self.assertFalse(sess._start_interview_answer("how should we price it?", "en", "", gen=gen))
        sess.pipeline.process_text.assert_not_called()
        self.assertFalse(sess._busy)
        sess._run_interview_answer("how should we price it?", "en", "", session_gen=session_gen)
        sess.pipeline.process_text.assert_not_called()
        self.assertEqual(sess._engine, "idle")

    def test_the_current_generation_still_starts(self):
        # Guard against over-blocking: with a live generation the answer starts.
        sess = self._session(judge_stub(qs.VERDICT_READY))
        sess._qa_init()
        gen = sess._qa_gen = 7
        self.assertTrue(sess._start_interview_answer("how should we price it?", "en", "", gen=gen))
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))

    def test_a_stale_background_verdict_does_not_wipe_new_fragments(self):
        # A background verdict computed for an older snapshot must not clear the
        # follow-up that landed while the model was thinking.
        gate = threading.Event()
        sess = self._session(judge_stub(qs.VERDICT_BACKGROUND, gate=gate))
        sess._on_final("我们准备做订阅制", "zh", None, {"stt_turn": 1, "listener_id": 1})
        self.assertTrue(self._start_judge(sess))
        sess._on_final("那按年付呢", "zh", None, {"stt_turn": 2, "listener_id": 1})
        gate.set()
        self.assertTrue(self._wait(lambda: not sess._qa_judging))
        self.assertEqual([f["text"] for f in sess._qa_buffer], ["我们准备做订阅制", "那按年付呢"])
        self.assertEqual(sess._qa_background, [])

    def test_the_worker_commit_call_site_passes_judged_at(self):
        # The case above drove `_qa_commit(judged_at=...)` BY HAND, so it stayed green
        # while the production call site never passed the argument and the guard was
        # dead code in the worker. This drives the real worker and injects the race
        # where it actually happens: after the worker's own activity check, before the
        # commit guard.
        sess = self._session(judge_stub(qs.VERDICT_READY, question="stale"))
        sess._start_interview_answer = mock.Mock()
        sess._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
        seen: dict = {}
        real_commit = sess._qa_commit

        def racing_commit(*args, **kwargs):
            seen["judged_at"] = kwargs.get("judged_at")
            sess._on_partial("that depends on", "en")  # the speaker resumed
            return real_commit(*args, **kwargs)

        sess._qa_commit = racing_commit
        self._settle(sess)
        self.assertIsNotNone(seen["judged_at"], "the worker must pass the judgement clock")
        sess._start_interview_answer.assert_not_called()
        self.assertEqual(len(sess._qa_buffer), 1)  # kept for the next judgement

    def test_a_commit_refused_by_a_resumed_speaker_is_rejudged_once_quiet(self):
        # The review blocker: the worker marks the version "judged" BEFORE it calls
        # the commit, so a partial that lands between the worker's own activity
        # check and the commit's re-check left the candidate marked done while the
        # commit was refused. No later settle would ever look at it again and, with
        # no further final, the question hung unanswered forever. Once the speaker
        # is quiet again the SAME candidate must be judged and answered once.
        sess = self._session(judge_stub(qs.VERDICT_READY, question="How should we price it?"))
        sess._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
        version = sess._qa_version
        real_commit = sess._qa_commit
        # The reviewer's window: the speaker resumes ONCE, right after the worker's
        # own activity check and before the commit guard re-checks the clock. Then
        # the room goes quiet and no further final ever arrives.
        resumed = {"done": False}

        def resumed_speaker_commit(*args, **kwargs):
            if not resumed["done"]:
                resumed["done"] = True
                sess._on_partial("that depends on", "en")
            return real_commit(*args, **kwargs)

        sess._qa_commit = resumed_speaker_commit
        self._settle(sess)
        self.assertEqual(sess.pipeline.process_text.call_count, 0)
        self.assertEqual(len(sess._qa_buffer), 1)
        # Nothing new was said — only the quiet gap passed. The candidate is still
        # the current one, so it must not be written off as "already judged".
        self.assertFalse(sess._qa_version_done(version))
        self._settle(sess)  # the speaker has been quiet past the settle window
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        self.assertEqual(sess.pipeline.judge_qa.call_count, 2)
        self.assertEqual(self._answers(sess), ["How should we price it?"])

    def test_a_refused_commit_recovers_through_the_real_settle_timer(self):
        # The same recovery, but down the REAL timer chain: after the refusal the
        # reschedule must actually arm a timer, because once the speaker stops that
        # timer is the only thing that comes back for the candidate.
        import server.app as app_mod

        sess = self._session(judge_stub(qs.VERDICT_READY, question="How should we price it?"))
        del sess._qa_schedule_judge  # restore the real settle timer
        old_settle = app_mod.QA_SETTLE_SECONDS
        old_interval = app_mod.QA_MIN_JUDGE_INTERVAL_SECONDS
        app_mod.QA_SETTLE_SECONDS = 0.2
        app_mod.QA_MIN_JUDGE_INTERVAL_SECONDS = 0.2
        try:
            sess._on_final("how should we price it", "en", None, {"stt_turn": 1, "listener_id": 1})
            real_commit = sess._qa_commit
            resumed = {"done": False}

            def resumed_speaker_commit(*args, **kwargs):
                if not resumed["done"]:
                    resumed["done"] = True
                    sess._on_partial("that depends on", "en")
                return real_commit(*args, **kwargs)

            sess._qa_commit = resumed_speaker_commit
            self.assertTrue(self._wait(lambda: sess.pipeline.judge_qa.call_count == 1))
            self.assertTrue(
                self._wait(lambda: sess.pipeline.process_text.called, timeout=5),
                "the candidate was never judged again after the speaker went quiet",
            )
            self.assertEqual(self._answers(sess), ["How should we price it?"])
        finally:
            app_mod.QA_SETTLE_SECONDS = old_settle
            app_mod.QA_MIN_JUDGE_INTERVAL_SECONDS = old_interval

    def test_a_stale_run_releases_the_busy_claim_it_already_took(self):
        # `_start_interview_answer` claims the busy token and only THEN calls the run,
        # which re-checks the generation. The early return used to sit before the
        # `finally`, so the claim was never released: the session stayed busy and every
        # later question queued behind an answer that never existed.
        sess = self._session(judge_stub(qs.VERDICT_READY))
        sess._qa_init()
        session_gen = sess._qa_session_gen
        self.assertIsNotNone(sess._claim_busy())  # as the start point takes it
        sess._qa_reset("new_session")  # New lands between the start check and the run
        sess._run_interview_answer("how should we price it?", "en", "", session_gen=session_gen)
        self.assertFalse(sess._busy)
        self.assertIsNone(sess._busy_token)
        self.assertEqual(sess._engine, "idle")
        sess.pipeline.process_text.assert_not_called()

    def test_the_slot_a_stale_run_gives_up_still_answers_the_queue(self):
        # Releasing must hand the slot over, not drop it.
        sess = self._session(judge_stub(qs.VERDICT_READY))
        sess._qa_init()
        session_gen = sess._qa_session_gen
        self.assertIsNotNone(sess._claim_busy())
        sess._qa_reset("new_session")
        # queued in the NEW session, so it is still live when the stale run gives up
        sess._pending_q.append(("what about annual billing?", "en", "", sess._qa_session_gen, False, "s-queued"))
        sess._run_interview_answer("how should we price it?", "en", "", session_gen=session_gen)
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        self.assertEqual(self._answers(sess), ["what about annual billing?"])

    def test_a_reset_drops_answers_queued_for_the_abandoned_session(self):
        # A queued question is dequeued with no generation to check against, so a
        # reset that leaves it in the queue starts the old session's question later.
        sess = self._session(judge_stub(qs.VERDICT_READY))
        sess._qa_init()
        sess._pending_q.append(("how should we price it?", "en", "", sess._qa_session_gen, False, "s-queued"))
        sess._qa_reset("new_listen")
        self.assertEqual(list(sess._pending_q), [])

    def test_a_new_before_the_answer_body_runs_stops_the_generation(self):
        # The run re-checks the generation before it creates the thread; a New that
        # lands in the gap BEFORE the body executes used to reach `process_text`
        # anyway, because only the pre-thread check existed.
        sess = self._session(judge_stub(qs.VERDICT_READY))
        sess._qa_init()
        gen = sess._qa_gen
        bodies: list = []

        class _DeferredThread:
            def __init__(self, target=None, daemon=None, args=(), **kwargs):
                bodies.append(target)

            def start(self):
                pass  # the body has not run yet

        with mock.patch("server.app.threading.Thread", _DeferredThread):
            self.assertTrue(sess._start_interview_answer("how should we price it?", "en", "", gen=gen))
        self.assertEqual(len(bodies), 1)
        sess._qa_reset("new_session")  # New lands in the gap, before the body runs
        bodies[0]()  # the body now runs for the abandoned session
        sess.pipeline.process_text.assert_not_called()
        self.assertFalse(sess._busy)
        self.assertEqual(sess._engine, "idle")

    def test_a_reset_between_the_start_checks_never_tags_the_new_session(self):
        # The candidate check and the session tag are two separate reads. A reset
        # landing between them used to tag the old question with the NEW session, so
        # the run's own generation check passed and the question was answered into
        # the session that had just replaced it.
        sess = self._session(judge_stub(qs.VERDICT_READY))
        sess._qa_init()
        gen = sess._qa_gen
        real_check = sess._qa_gen_current

        def check_then_reset(g):
            ok = real_check(g)  # the candidate still looks current
            sess._qa_reset("new_session")  # New lands right after that check
            return ok

        sess._qa_gen_current = check_then_reset
        sess._start_interview_answer("how should we price it?", "en", "", gen=gen)
        sess.pipeline.process_text.assert_not_called()
        self.assertFalse(sess._busy)  # the refused run released its claim

    def test_a_question_in_hand_when_the_session_resets_never_runs(self):
        # `_qa_reset` clears the queue, but an item that was ALREADY taken out of
        # it (the drain pops, then runs) carried no identity to check, so the old
        # session's question started anyway. The identity travels with the item.
        sess = self._session(judge_stub(qs.VERDICT_READY))
        sess._qa_init()
        gen = sess._qa_gen
        self.assertIsNotNone(sess._claim_busy())  # the previous answer holds the slot
        self.assertTrue(sess._start_interview_answer("from the old session", "en", "", gen=gen))
        self.assertEqual(len(sess._pending_q), 1)
        item = sess._pending_q.popleft()  # the slot frees exactly here
        sess._qa_reset("new_session")  # and New lands before the item runs
        sess._run_interview_answer(item[0], item[1], item[2], session_gen=item[3], think=item[4], submit_id=item[5])
        sess.pipeline.process_text.assert_not_called()
        self.assertFalse(sess._busy)

    def test_a_manual_submit_does_not_drop_a_question_already_committed(self):
        # The manual submit supersedes the PENDING candidate (it bumps the candidate
        # epoch) but it is not a session reset: a question that was already committed
        # and queued is not the manual candidate, and the issue spec keeps candidates
        # unrelated to the manual input. It must still be answered.
        sess = self._session(judge_stub(qs.VERDICT_READY))
        sess._qa_init()
        self.assertIsNotNone(sess._claim_busy())  # the previous answer holds the slot
        self.assertTrue(sess._start_interview_answer("how should we price it?", "en", "", gen=sess._qa_gen))
        sess._qa_on_manual_submit()  # the user types a question while the slot is busy
        sess._finish_interview_answer(sess._busy_token)
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        self.assertEqual(self._answers(sess), ["how should we price it?"])

    def test_the_current_background_verdict_still_demotes(self):
        sess = self._session(judge_stub(qs.VERDICT_BACKGROUND))
        sess._on_final("我们准备做订阅制", "zh", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)
        self.assertEqual(sess._qa_buffer, [])
        self.assertEqual(sess._qa_background, ["我们准备做订阅制"])


if __name__ == "__main__":
    unittest.main()
