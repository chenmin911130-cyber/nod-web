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
    pipe._qa_history = []
    pipe._last_answer = ""
    pipe._cancel = threading.Event()
    pipe._gen_seq = 0
    pipe.user_id = None
    pipe.usage_session_id = None
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

    def test_think_scopes_the_search_to_ask_modes_only(self):
        # file_ask is an ask: it carries the enhancement too.
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = _client(results=[("A", "https://e.com/a", None)])
        pipe.process_text("review this", "file_ask", think=True)
        self.assertEqual(len(_events(events, "sources")), 1)


if __name__ == "__main__":
    unittest.main()
