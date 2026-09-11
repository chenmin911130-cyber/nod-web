"""Think (#182): submit-time snapshot + the answer path.

Two things are pinned here and nowhere else:

1. The switch is read ONCE, at the moment a question is submitted. A question
   that is queued (because an answer is in flight) or retried keeps the value it
   was submitted with, while the user is free to flip the switch for the next
   one. New / clear / workspace switch turns it back off.
2. A Think answer really looks the question up (through the injected client),
   runs the model in thinking mode, attaches the sources the lookup returned,
   and never dresses up a lookup that did not happen — or the chain of thought —
   as the answer.
"""

import threading
import time
import unittest
import uuid
from unittest import mock

from server import think
from server.app import Pipeline, Session


class _Delta:
    def __init__(self, content="", reasoning=""):
        self.content = content
        self.reasoning_content = reasoning


class _Choice:
    def __init__(self, delta):
        self.delta = delta


class _Chunk:
    def __init__(self, content="", reasoning=""):
        self.choices = [_Choice(_Delta(content, reasoning))] if (content or reasoning) else []
        self.usage = None


def _pipe(events: list[dict]) -> Pipeline:
    pipe = Pipeline.__new__(Pipeline)
    pipe.cfg = {"llm": {"provider": "deepseek", "model": "deepseek-flash", "max_tokens": 80}}
    pipe.emit = events.append
    pipe._provider = "deepseek"
    pipe._model = "deepseek-flash"
    pipe.client = mock.Mock()
    pipe.client.chat.completions.create.return_value = [_Chunk(content="Beijing.")]
    # The Think answer is pinned to DeepSeek direct (#182): the tests give the pipe
    # that credential + the client it should build, and a session of its own so one
    # test's dedupe record can never answer another test's question.
    pipe._keys = {"DEEPSEEK_API_KEY": "unit-test-key"}
    pipe._think_llm = (pipe.client, "deepseek-v4-flash")
    pipe._qa_history = []
    pipe._last_answer = ""
    pipe._cancel = threading.Event()
    pipe._gen_seq = 0
    pipe.user_id = None
    pipe.usage_session_id = f"sess-{uuid.uuid4().hex[:10]}"
    pipe._heard_lang = None
    return pipe


def _client(results=(), status=None, error=""):
    """A SearchClient over a fake transport — deterministic, no network."""
    def transport(request):
        if status == think.STATUS_FAILED:
            raise TimeoutError("upstream stalled")
        return {
            "results": [
                {
                    "title": t,
                    "url": u,
                    "content": "snippet",
                    "published_date": p,
                }
                for (t, u, p) in results
            ]
        }

    return think.SearchClient(transport, clock=lambda: 1789012800.0)


def _events(events, kind):
    return [e for e in events if e.get("type") == kind]


class SubmitSnapshotTests(unittest.TestCase):
    """The switch is session-scoped and frozen per submit."""

    def _session(self):
        sess = Session.__new__(Session)
        sess.cfg = {"stt": {}, "ui": {}, "llm": {}}
        sess._workspace = "interview"
        sess._listener = object()
        sess._manual = False
        sess._busy = False
        sess._busy_lock = threading.Lock()
        sess._busy_token = None
        sess._pending_q = __import__("collections").deque(maxlen=8)
        sess._pending_asks = []
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
        sess._qa_schedule_judge = mock.Mock()
        sess._listen_wanted = False
        sess._handoff_listener = None
        sess._paused = False
        sess._engine = "idle"
        return sess

    def test_think_defaults_off_and_is_session_scoped(self):
        sess = self._session()
        self.assertFalse(sess._think_snapshot())
        sess.set_think(True)
        self.assertTrue(sess._think_snapshot())
        # New / clear / workspace switch / close start a fresh session.
        sess._qa_reset("new_session")
        self.assertFalse(sess._think_snapshot())

    def test_a_direct_ask_carries_the_value_at_submit(self):
        sess = self._session()
        sess.set_think(True)
        sess.ask("what is new?", None, "ask")
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        self.assertIs(sess.pipeline.process_text.call_args.kwargs.get("think"), True)

    def test_a_queued_ask_keeps_its_submit_value_across_a_toggle(self):
        sess = self._session()
        self.assertIsNotNone(sess._claim_busy())  # an answer is already in flight
        sess.set_think(True)
        sess.ask("queued while busy?", None, "ask")
        sess.pipeline.process_text.assert_not_called()
        # The user flips the switch off while the first question waits.
        sess.set_think(False)
        sess.ask("a later question?", None, "ask")
        self.assertEqual(len(sess._pending_asks), 2)
        sess._release_busy(sess._busy_token)
        sess._drain_pending_ask()
        # The queued question uses the value it was submitted with; the next one
        # uses the value the switch has now.
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.call_count == 2))
        calls = sess.pipeline.process_text.call_args_list
        self.assertIs(calls[0].kwargs.get("think"), True)
        self.assertIs(calls[1].kwargs.get("think"), False)

    def test_the_value_the_client_froze_with_the_message_wins(self):
        # #182 review: the backend read the session switch and ignored the `think`
        # field the client sent, so a toggle flipped while the question was in flight
        # changed a question that was already submitted.
        sess = self._session()
        sess.set_think(True)  # the server's current value — NOT what must run
        sess.dispatch(
            {"type": "ask", "text": "what is new?", "think": False, "submit_id": "submit-frozen"}
        )
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        call = sess.pipeline.process_text.call_args
        self.assertIs(call.kwargs.get("think"), False, "the message value must win")
        self.assertEqual(call.kwargs.get("submit_id"), "submit-frozen")
        # ...and a message without the field still uses the session value.
        sess.pipeline.process_text.reset_mock()
        sess.dispatch({"type": "ask", "text": "another?", "submit_id": "submit-2"})
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        self.assertIs(sess.pipeline.process_text.call_args.kwargs.get("think"), True)

    def test_a_new_listen_session_keeps_the_switch_and_a_new_session_resets_it(self):

        # #182 review: (re)starting to listen inside one conversation used to run the
        # same reset as New, dropping Think without telling anyone. It is a listen
        # session, not a new conversation: the switch survives, and when a real reset
        # does turn it off the server says so instead of letting the client lie.
        sess = self._session()
        sess.set_think(True)
        sess._open_listener = mock.Mock()
        sess._claim_listen_start = mock.Mock(return_value=True)
        sess._release_listen_start = mock.Mock()
        sess.pipeline.assemblyai_key = mock.Mock(return_value="key")
        sess._start_listening()
        self.assertTrue(sess._think_snapshot(), "a new listen session must not drop Think")
        self.assertEqual([e for e in sess.emit.call_args_list if e.args[0].get("type") == "think"], [])

        # A real session reset (New / clear / workspace switch) still returns to the
        # default — and announces it.
        sess._qa_reset("turn_reset")
        self.assertFalse(sess._think_snapshot())
        think_events = [e.args[0] for e in sess.emit.call_args_list if e.args[0].get("type") == "think"]
        self.assertEqual(think_events, [{"type": "think", "on": False}])

    def test_a_manual_recording_carries_think_at_the_confirm_instant(self):
        # #182 review: the manual (tap-to-confirm) recording was the entry that
        # forgot Think entirely, so the switch was on and the answer was not.
        sess = self._session()
        sess.set_think(True)
        sess._manual = True
        sess._manual_lock = threading.Lock()
        sess._manual_jobs = 0
        sess._manual_buf = bytearray(b"\x00\x01" * 20000)
        sess._manual_offset = 0
        sess._live_manual_captions = mock.Mock(return_value=False)
        sess._offer_save_history = mock.Mock()
        sess._emit_phase = mock.Mock()
        sess._set_engine = mock.Mock()
        sess._qa_on_manual_submit = mock.Mock()
        sess._speech_allowed = mock.Mock(return_value=True)
        sess._polish_manual_text = mock.Mock(side_effect=lambda text: text)
        sess._transcribe_manual_pcm = mock.Mock(return_value=("how should we price it?", "en"))
        sess._set_engine = mock.Mock()
        sess.usage_session_id = "sess-manual"

        with mock.patch("server.app.threading.Thread") as thread:
            sess._stop_manual()
        # The recording is transcribed on a worker; run that worker's body inline so
        # the test sees the submit it makes.
        started = thread.call_args.kwargs
        self.assertEqual(started["target"], sess._finish_manual)
        sess._finish_manual(started["args"][0], **started["kwargs"])

        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        call = sess.pipeline.process_text.call_args
        self.assertIs(call.kwargs.get("think"), True, "the manual entry must carry Think")
        self.assertTrue(call.kwargs.get("submit_id"), "and its own submit identity")

    def test_the_auto_voice_commit_freezes_think_at_commit_time(self):
        # _qa_commit is the auto-voice submit point; the value it passes to the
        # start point is the session value at that instant, and nothing later.
        sess = self._session()
        sess.set_think(True)
        sess._start_interview_answer = mock.Mock(return_value=True)
        sess._qa_init()
        frag = {"id": "f1", "text": "怎么定价？", "lang": "zh"}
        verdict = {"verdict": "ready", "question": "怎么定价？", "fragments": ["f1"]}
        with sess._qa_lock():
            sess._qa_buffer = [dict(frag)]
            sess._qa_version = 3
        version = sess._qa_version
        gen = sess._qa_gen
        sess._qa_commit("怎么定价？", [frag], verdict=verdict, trigger="judge", version=version, gen=gen)
        self.assertIs(sess._start_interview_answer.call_args.kwargs.get("think"), True)
        sess.set_think(False)
        with sess._qa_lock():
            sess._qa_buffer = [dict(frag)]
            sess._qa_version += 1
        sess._qa_commit(
            "怎么定价？", [frag], verdict=verdict, trigger="judge",
            version=sess._qa_version, gen=sess._qa_gen,
        )
        self.assertIs(sess._start_interview_answer.call_args.kwargs.get("think"), False)

    def test_a_queued_auto_answer_keeps_its_commit_value(self):
        sess = self._session()
        sess._qa_init()
        self.assertIsNotNone(sess._claim_busy())  # holding the answer slot
        sess.set_think(True)
        self.assertTrue(
            sess._start_interview_answer("how should we price it?", "en", "", gen=sess._qa_gen, think=True)
        )
        self.assertEqual(len(sess._pending_q), 1)
        sess.set_think(False)  # flipped while the question waits
        sess._release_busy(sess._busy_token)
        # Hand the slot over exactly like the finishing answer does.
        item = sess._pending_q.popleft()
        sess._run_interview_answer(item[0], item[1], item[2], session_gen=item[3], think=item[4])
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        self.assertIs(sess.pipeline.process_text.call_args.kwargs.get("think"), True)

    def _wait(self, pred, timeout=3.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if pred():
                return True
            time.sleep(0.01)
        return pred()


class ThinkAnswerPathTests(unittest.TestCase):
    """process_text: a real lookup, real sources, honest failure, quiet CoT."""

    def test_think_off_never_searches_and_keeps_thinking_disabled(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = _client(results=[("A", "https://e.com/a", None)])
        pipe.process_text("what is new?", "ask")
        self.assertEqual(_events(events, "sources"), [])
        kwargs = pipe.client.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["extra_body"], {"thinking": {"type": "disabled"}})

    def test_think_on_searches_once_and_runs_in_thinking_mode(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = mock.Mock()
        pipe.think_client.search.return_value = think.SearchOutcome(
            status=think.STATUS_OK,
            query="what is new?",
            results=(think.SearchResult("A", "https://e.com/a", "snippet", "2026-09-10"),),
            retrieved_at=1789012800.0,
        )
        pipe.process_text("what is new?", "ask", think=True)
        pipe.think_client.search.assert_called_once()
        # The lookup happened before the model call, with the question only.
        self.assertEqual(pipe.think_client.search.call_args.args[0], "what is new?")
        kwargs = pipe.client.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["extra_body"]["thinking"], {"type": "enabled"})
        self.assertIn("reasoning_effort", kwargs["extra_body"])
        # The evidence rides in the ONE existing system prompt (like the #191
        # background block) rather than adding a second system message.
        system = [m for m in kwargs["messages"] if m["role"] == "system"]
        self.assertEqual(len(system), 1)
        self.assertTrue(any("https://e.com/a" in m["content"] for m in system))
        self.assertTrue(any("2026-09-10 04:00 UTC" in m["content"] for m in system))
        # And the client gets the sources with the answer.
        sources = _events(events, "sources")
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]["status"], "ok")
        self.assertEqual(sources[0]["results"][0]["url"], "https://e.com/a")
        self.assertEqual(sources[0]["retrieved_at_text"], "2026-09-10 04:00 UTC")
        self.assertEqual(sources[0]["note"], "")
        self.assertTrue(_events(events, "done")[-1]["ok"])

    def test_an_unconfigured_lookup_is_reported_not_faked(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = None
        with mock.patch("server.app.build_think_client", return_value=None):
            pipe.process_text("what is new?", "ask", think=True)
        sources = _events(events, "sources")
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]["status"], "failed")
        self.assertEqual(sources[0]["results"], [])
        self.assertTrue(sources[0]["note"])  # explicit: the lookup did not run
        # The answer still goes out (recording/answering must not break), and it
        # is not presented as a fresh lookup.
        self.assertTrue(_events(events, "done")[-1]["ok"])

    def test_a_failed_lookup_is_reported(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = _client(status=think.STATUS_FAILED)
        pipe.process_text("what is new?", "ask", think=True)
        sources = _events(events, "sources")[0]
        self.assertEqual(sources["status"], "failed")
        self.assertIn("TimeoutError", sources["note"])
        self.assertEqual(sources["results"], [])

    def test_an_empty_lookup_is_reported(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = _client(results=[])
        pipe.process_text("what is new?", "ask", think=True)
        sources = _events(events, "sources")[0]
        self.assertEqual(sources["status"], "empty")
        self.assertTrue(sources["note"])

    def test_think_never_searches_a_non_answer_mode(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = mock.Mock()
        pipe.process_text("Write structured notes", "notes", think=True)
        pipe.think_client.search.assert_not_called()
        self.assertEqual(_events(events, "sources"), [])

    def test_the_chain_of_thought_is_not_dumped_into_a_think_answer(self):
        # With thinking on, an empty body must fail loudly instead of showing the
        # model's internal reasoning as the answer (#182).
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.client.chat.completions.create.return_value = [_Chunk(reasoning="internal musings")]
        pipe.think_client = _client(results=[])
        pipe.process_text("what is new?", "ask", think=True)
        self.assertEqual([e.get("text") for e in _events(events, "chunk")], [])
        self.assertTrue(any("empty response" in (e.get("text") or "") for e in _events(events, "error")))
        self.assertFalse(_events(events, "done")[-1]["ok"])

    def test_the_non_think_fallback_still_uses_reasoning_when_the_body_is_empty(self):
        # Guard against over-blocking: the pre-existing behaviour for a normal
        # (non-Think) answer is unchanged.
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.client.chat.completions.create.return_value = [_Chunk(reasoning="fallback body")]
        pipe.process_text("what is new?", "ask")
        self.assertEqual([e.get("text") for e in _events(events, "chunk")], ["fallback body"])

    def test_the_search_gets_the_users_question_not_the_attachment_body(self):
        # #182 review: the prompt for an attachment question STARTS with the
        # extracted file body, and the lookup was handed that prompt — the private
        # attachment was uploaded to the search provider and the real question was
        # buried past the query bound. The search term is the typed question only.
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = mock.Mock()
        pipe.think_client.search.return_value = think.SearchOutcome(
            status=think.STATUS_OK,
            query="what is new?",
            results=(think.SearchResult("A", "https://e.com/a", "snippet", None),),
            retrieved_at=1789012800.0,
        )
        private_body = "CONFIDENTIAL SALARY DATA 123456"
        prompt = f"--- Attached: payroll.csv ---\n{private_body}\n\nwhat is new?"
        pipe.process_text(prompt, "file_ask", think=True, search_text="what is new?")
        searched = pipe.think_client.search.call_args.args[0]
        self.assertEqual(searched, "what is new?")
        self.assertNotIn("CONFIDENTIAL", searched)
        # ...while the model still gets the whole attachment.
        messages = pipe.client.chat.completions.create.call_args.kwargs["messages"]
        self.assertTrue(any(private_body in (m.get("content") or "") for m in messages))

    def test_an_attachment_only_question_is_never_searched(self):
        # Nothing to look up: no request, no budget reserved — and the answer says
        # the lookup did not happen instead of pretending it did.
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = mock.Mock()
        reserved = mock.Mock(allowed=True, reason="", day_attempts=1, total_attempts=1)
        with mock.patch("server.think_budget.reserve", return_value=reserved) as reserve:
            pipe.process_text(
                "--- Attached: payroll.csv ---\nPRIVATE PAYROLL\n",
                "file_ask",
                think=True,
                search_text="",
            )
        pipe.think_client.search.assert_not_called()
        reserve.assert_not_called()
        sources = _events(events, "sources")[0]
        self.assertEqual(sources["status"], "failed")
        self.assertEqual(sources["results"], [])
        self.assertIn("附件", sources["note"])

    def test_a_think_answer_is_pinned_to_deepseek_direct(self):
        # #182 review: the enhanced path must not follow the session provider. With
        # OpenRouter selected, the Think answer still runs on the pinned DeepSeek
        # client + model, in thinking mode.
        events: list[dict] = []
        pipe = _pipe(events)
        session_client = mock.Mock()
        session_client.chat.completions.create.return_value = [_Chunk(content="wrong path")]
        pinned_client = mock.Mock()
        pinned_client.chat.completions.create.return_value = [_Chunk(content="right path")]
        pipe.client = session_client
        pipe._provider = "openrouter"
        pipe._model = "some/router-model"
        pipe._think_llm = (pinned_client, "deepseek-v4-flash")
        pipe.think_client = _client(results=[("A", "https://e.com/a", None)])

        pipe.process_text("what is new?", "ask", think=True)
        session_client.chat.completions.create.assert_not_called()
        kwargs = pinned_client.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["model"], "deepseek-v4-flash")
        self.assertEqual(kwargs["extra_body"]["thinking"], {"type": "enabled"})

        # Without Think the same pipe answers through the session client, untouched.
        pipe.process_text("what is new?", "ask")
        session_kwargs = session_client.chat.completions.create.call_args.kwargs
        self.assertEqual(session_kwargs["model"], "some/router-model")
        self.assertNotIn("extra_body", session_kwargs)

    def test_a_missing_deepseek_key_falls_back_instead_of_dying(self):
        # No DeepSeek credential at all is the only case where the pin cannot hold:
        # the answer still goes out on the session client, and it is logged — never
        # silent — but it does not claim to be the specified direct connection.
        events: list[dict] = []
        pipe = _pipe(events)
        pipe._keys = {}
        pipe._think_llm = None
        pipe._provider = "openrouter"
        pipe._model = "some/router-model"
        pipe.think_client = _client(results=[("A", "https://e.com/a", None)])
        with mock.patch("server.app.logging") as logging_mock:
            pipe.process_text("what is new?", "ask", think=True)
        kwargs = pipe.client.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["model"], "some/router-model")
        self.assertNotIn("extra_body", kwargs)
        self.assertTrue(logging_mock.getLogger.return_value.warning.called)

    def test_think_scopes_the_search_to_ask_modes_only(self):
        # file_ask is an ask: it carries the enhancement too — and the evidence has
        # to reach the prompt file_ask actually builds (it returns early, so a
        # lookup whose evidence only lands in the plain-ask prompt is a silent
        # no-op for attachment questions).
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = _client(results=[("A", "https://e.com/a", "2026-09-10")])
        pipe.process_text("review this", "file_ask", think=True)
        self.assertEqual(len(_events(events, "sources")), 1)
        kwargs = pipe.client.chat.completions.create.call_args.kwargs
        system = [m for m in kwargs["messages"] if m["role"] == "system"]
        self.assertTrue(
            any("https://e.com/a" in m["content"] for m in system),
            "the evidence must reach the file_ask prompt too",
        )


if __name__ == "__main__":
    unittest.main()
