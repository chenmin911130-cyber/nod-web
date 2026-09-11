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
        self.assertEqual(self._answers(sess), ["Will raising the price hurt retention?"])
        self.assertEqual(sess.pipeline.judge_qa.call_count, 1)
        # The judge saw all three fragments, in order, in the prompt.
        prompt = sess.pipeline.judge_qa.call_args.args[0][-1]["content"]
        self.assertLess(prompt.index("如果我们把价格"), prompt.index("会不会影响学生用户留存"))

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
        sess._on_final("大概要多少钱", "zh", None, {"stt_turn": 2, "listener_id": 1})
        self._settle(sess)
        self.assertEqual(sess.pipeline.judge_qa.call_count, 2)

    def test_ready_answers_once_per_turn_and_a_resent_final_is_not_answered_twice(self):
        # Acceptance 7: final re-send / revision of the same turn answers once.
        sess = self._session(judge_stub(qs.VERDICT_READY, question="How should we price it?"))
        meta = {"stt_turn": 9, "listener_id": 1}
        sess._on_final("how should we price it?", "en", None, meta)
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)
        self.assertEqual(sess.pipeline.process_text.call_count, 1)
        # The STT layer re-delivers the same turn (final re-send).
        sess._on_final("how should we price it?", "en", None, dict(meta))
        self._settle(sess)
        self._wait(lambda: not sess._qa_judging)
        self.assertEqual(sess.pipeline.process_text.call_count, 1)
        self.assertEqual(sess._qa_buffer, [])

    def test_a_later_repeat_question_is_not_swallowed_by_text_similarity(self):
        # Acceptance 7: dedupe keys on turn identity, never on text alone.
        sess = self._session(judge_stub(qs.VERDICT_READY, question="What is CAP theorem?"))
        sess._on_final("What is CAP theorem?", "en", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)
        sess._on_final("What is CAP theorem?", "en", None, {"stt_turn": 2, "listener_id": 1})
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
            sess._on_final("what should we charge?", "en", None, {"stt_turn": 1, "listener_id": 1})
            self._settle(sess)
            sess.pipeline.process_text.assert_not_called()
            # Bounded buffer retained; manual submit still possible.
            self.assertEqual(len(sess._qa_buffer), 1)

    def test_judge_exception_never_answers_and_does_not_retry_the_same_version(self):
        bomb = mock.Mock(side_effect=RuntimeError("upstream timeout"))
        sess = self._session(bomb)
        sess._on_final("what should we charge?", "en", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)
        sess.pipeline.process_text.assert_not_called()
        self._settle(sess)
        self._settle(sess)
        self.assertEqual(bomb.call_count, 1, "a failed judgement must not be retried in a loop")

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
        sess._on_final("how should we price it?", "en", None, {"stt_turn": 1, "listener_id": 1})
        sess.set_workspace("meeting")
        self.assertEqual(sess._qa_buffer, [])
        self._settle(sess)
        sess.pipeline.process_text.assert_not_called()

    def test_stop_commit_drops_an_unjudged_or_wait_candidate(self):
        # A Stop must not upgrade "wait" (or an unjudged fragment) into an answer.
        sess = self._session(judge_stub(qs.VERDICT_WAIT))
        sess._on_final("我想知道", "zh", None, {"stt_turn": 1, "listener_id": 1})
        self._settle(sess)
        sess._qa_stop_commit()
        sess.pipeline.process_text.assert_not_called()
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
        sess._on_final("how should we price it?", "en", None, meta)
        sess.ask("typed question instead", None, "ask")
        self.assertEqual(sess._qa_buffer, [])
        self.assertIn("t1:5", sess._qa_answered)
        self.assertEqual(sess._qa_background, ["how should we price it?"])
        sess.pipeline.judge_qa.reset_mock()
        sess._on_final("how should we price it?", "en", None, dict(meta))
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
        sess._on_final("怎么定价比较好？", "zh", None, {"stt_turn": 3, "listener_id": 1})
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
        sess._on_final("那按年付呢？", "zh", None, {"stt_turn": 1, "listener_id": 1})
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
        sess._on_final("how should we price it?", "en", None, {"stt_turn": 1, "listener_id": 1})
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
        sess._on_final("how should we price it?", "en", None, {"stt_turn": 1, "listener_id": 1})
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
        sess._on_final("how should we price it?", "en", None, {"stt_turn": 1, "listener_id": 1})
        sess.cancel_generate()
        self.assertEqual(len(sess._qa_buffer), 1)
        self._settle(sess)
        self._wait(lambda: sess.pipeline.process_text.called)
        self.assertEqual(self._answers(sess), ["How should we price it?"])

    def test_drop_emits_a_reason_and_never_the_text(self):
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
        finally:
            logger.removeHandler(handler)
            logger.setLevel(old_level)
        drops = [r for r in records if r.startswith("qa_drop")]
        self.assertTrue(drops)
        self.assertTrue(any("reason=stop_no_ready_verdict" in r for r in drops), drops)
        self.assertNotIn("SECRET", "\n".join(drops))


if __name__ == "__main__":
    unittest.main()
