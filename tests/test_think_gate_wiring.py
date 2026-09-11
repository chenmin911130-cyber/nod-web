"""#182: the budget gate as the answer path actually uses it.

These drive `process_text` with a stub search backend and a real isolated budget
store, so they cover the wiring the pure gate tests cannot: a refusal must send
no request, a duplicate request must not pay twice, and a model retry must never
re-run the search.
"""

import threading
import unittest
from unittest import mock

from server import think
from server.app import Pipeline, build_think_client
from server.db import ThinkSearchDay, ThinkSearchState
from server.think_budget import utc_day


class _Delta:
    def __init__(self, content=""):
        self.content = content
        self.reasoning_content = ""


class _Choice:
    def __init__(self, delta):
        self.delta = delta


class _Chunk:
    def __init__(self, content=""):
        self.choices = [_Choice(_Delta(content))] if content else []
        self.usage = None


PAYLOAD = {
    "search_id": "s1",
    "session_id": "x",
    "results": [
        {"url": "https://e.com/a", "title": "Apple", "publish_date": "2026-09-10", "excerpts": ["body"]}
    ],
}


def _pipe(events, calls):
    pipe = Pipeline.__new__(Pipeline)
    pipe.cfg = {"llm": {"provider": "deepseek", "model": "deepseek-flash", "max_tokens": 80}}
    pipe.emit = events.append
    pipe._provider = "deepseek"
    pipe._model = "deepseek-flash"
    pipe.client = mock.Mock()
    pipe.client.chat.completions.create.return_value = [_Chunk("Beijing.")]
    pipe._qa_history = []
    pipe._last_answer = ""
    pipe._cancel = threading.Event()
    pipe._gen_seq = 0
    pipe.user_id = None
    pipe.usage_session_id = "sess-1"
    pipe._heard_lang = None

    def transport(request):
        calls.append(request)
        return PAYLOAD

    pipe.think_client = think.SearchClient(transport, clock=lambda: 1789012800.0)
    return pipe


class ThinkClientWiringTests(unittest.TestCase):
    """The path that a missing import once made un-callable (no test touched it)."""

    def test_a_key_builds_a_parallel_client_and_no_key_does_not(self):
        with mock.patch.dict("os.environ", {"PARALLEL_API_KEY": "unit-test-key"}, clear=False):
            client = build_think_client({"llm": {"model": "deepseek-flash"}})
        self.assertIsNotNone(client)
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertIsNone(build_think_client({}))


class ThinkGateWiringTests(unittest.TestCase):
    def setUp(self):
        import pytest

        from tests.conftest import isolated_sessionmaker, make_isolated_engine

        self.engine = make_isolated_engine()
        self.session_cm = isolated_sessionmaker(self.engine)
        self.session = self.session_cm.__enter__()
        patcher = mock.patch("server.think_budget.db_session", self.session)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.session_cm.__exit__, None, None, None)
        self.addCleanup(self.engine.dispose)

    def _counts(self):
        with self.session() as db:
            day = db.get(ThinkSearchDay, utc_day())
            total = db.get(ThinkSearchState, "total")
            return (day.attempts if day else 0, total.attempts if total else 0)

    def test_a_refusal_sends_no_request_and_says_why(self):
        events: list[dict] = []
        calls: list[dict] = []
        pipe = _pipe(events, calls)
        denied = mock.Mock(allowed=False, reason="DailyLimit", day_attempts=100, total_attempts=100)
        with mock.patch("server.think_budget.reserve", return_value=denied):
            pipe.process_text("what is new?", "ask", think=True)

        self.assertEqual(calls, [], "a refused search must not touch the network")
        sources = [e for e in events if e.get("type") == "sources"]
        self.assertEqual(sources[0]["status"], "failed")
        self.assertIn("额度", sources[0]["note"])
        self.assertTrue(
            any(e.get("type") == "status" and "quota" in (e.get("text") or "").lower() for e in events),
            "the existing status position must say the quota was reached",
        )
        # The answer itself still goes out (Think off-equivalent behaviour).
        self.assertTrue([e for e in events if e.get("type") == "done"][-1]["ok"])

    def test_a_duplicate_request_reuses_the_snapshot_instead_of_paying_again(self):
        events: list[dict] = []
        calls: list[dict] = []
        pipe = _pipe(events, calls)
        # One submit action, delivered twice (a double forward, a replay after a
        # reconnect): the same submit id both times.
        pipe.process_text("what is new?", "ask", think=True, submit_id="submit-1")
        pipe.process_text("what is new?", "ask", think=True, submit_id="submit-1")

        self.assertEqual(len(calls), 1, "the same submit id must be searched once")
        self.assertEqual(self._counts(), (1, 1), "and must consume exactly one attempt")
        self.assertEqual(
            len([e for e in events if e.get("type") == "sources" and e.get("status") == "ok"]), 2,
            "both answers still show the (reused) sources",
        )

    def test_the_same_text_in_a_new_submit_is_a_new_question(self):
        # A submit identity is per ACTION, not per text: asking the identical
        # question again is a legitimate new question and searches on its own.
        events: list[dict] = []
        calls: list[dict] = []
        pipe = _pipe(events, calls)
        pipe.process_text("what is new?", "ask", think=True, submit_id="submit-1")
        pipe.process_text("what is new?", "ask", think=True, submit_id="submit-2")
        self.assertEqual(len(calls), 2, "a new submit action searches again")
        self.assertEqual(self._counts(), (2, 2))

    def test_a_submit_another_worker_already_claimed_is_never_searched_again(self):
        # Cross-process / cross-restart: the claim row exists (another worker, or the
        # same submit coming back after a restart) before this one starts. It must
        # wait for that result — not buy the lookup a second time.
        events: list[dict] = []
        calls: list[dict] = []
        pipe = _pipe(events, calls)
        from server import think_budget

        self.assertTrue(
            think_budget.claim("r-shared-submit", session_id="sess-1", question="what is new?")
        )
        # The owner is gone / still working: the bounded wait is what matters, and
        # the test does not spend it.
        with mock.patch("server.app.THINK_SEARCH_TIMEOUT_SECONDS", -2.0):
            pipe.process_text("what is new?", "ask", think=True, submit_id="shared-submit")

        self.assertEqual(calls, [], "a claimed submit must not be searched twice")
        self.assertEqual(self._counts(), (0, 0), "and must reserve no budget")
        sources = [e for e in events if e.get("type") == "sources"][0]
        self.assertEqual(sources["status"], "failed")
        self.assertIn("进行中", sources["note"])
        self.assertTrue([e for e in events if e.get("type") == "done"][-1]["ok"])

    def test_a_retry_reuses_a_successful_lookup_instead_of_paying_twice(self):
        # The user retries the same question: the order says an existing result is
        # reused, so the retry must not reserve or search.
        events: list[dict] = []
        calls: list[dict] = []
        pipe = _pipe(events, calls)
        pipe.process_text("what is new?", "ask", think=True, submit_id="submit-1")
        self.assertEqual(self._counts(), (1, 1))

        pipe.process_text("what is new?", "ask", think=True, retry_of="submit-1", submit_id="submit-retry")

        self.assertEqual(len(calls), 1, "an OK lookup is reused, never re-bought")
        self.assertEqual(self._counts(), (1, 1), "and consumes no extra attempt")
        self.assertEqual(
            [e for e in events if e.get("type") == "sources"][-1]["status"], "ok"
        )
        # The reused outcome still carries the excerpt the first lookup stored, so the
        # retry answers from the same facts instead of from bare links (#182 review).
        messages = pipe.client.chat.completions.create.call_args.kwargs["messages"]
        self.assertTrue(any("body" in (m.get("content") or "") for m in messages))

    def test_a_retry_after_a_failure_creates_one_counted_attempt_with_its_parent(self):
        events: list[dict] = []
        calls: list[dict] = []

        def flaky(request):
            calls.append(request)
            if len(calls) == 1:
                raise TimeoutError("could not tell whether it was received")
            return PAYLOAD

        pipe = _pipe(events, calls)
        pipe.think_client = think.SearchClient(flaky, clock=lambda: 1789012800.0)
        pipe.process_text("what is new?", "ask", think=True, submit_id="submit-first")
        self.assertEqual(self._counts(), (1, 1), "the failed attempt stays consumed")

        pipe.process_text(
            "what is new?", "ask", think=True, retry_of="submit-first", submit_id="submit-retry"
        )

        self.assertEqual(len(calls), 2, "an unknown/failed lookup may be retried for real")
        self.assertEqual(self._counts(), (2, 2), "and the retry is counted as its own attempt")
        from server.think_budget import find_snapshot

        record = find_snapshot("r-submit-retry")
        self.assertIsNotNone(record)
        self.assertEqual(record["attempt"], 2)
        self.assertEqual(record["parent_request_id"], "r-submit-first")
        self.assertEqual(record["status"], "ok")

    def test_a_timed_out_lookup_keeps_the_budget_and_is_not_resent(self):
        # The order's rule: a request that was sent but timed out may have been
        # billed, so the attempt stays consumed and nothing is automatically
        # re-sent — the budget must never be released and retried for free.
        events: list[dict] = []
        calls: list[dict] = []

        def transport(request):
            calls.append(request)
            raise TimeoutError("remote may have received it")

        pipe = _pipe(events, calls)
        pipe.think_client = think.SearchClient(transport, clock=lambda: 1789012800.0)
        pipe.process_text("what is new?", "ask", think=True)

        self.assertEqual(len(calls), 1, "the search is never automatically re-sent")
        self.assertEqual(self._counts(), (1, 1), "the attempt stays consumed")

    def test_a_file_ask_retry_reuses_the_lookup_by_its_raw_question(self):
        # #182 review: the retry has to carry the question the user actually asked, not
        # the card's display title. With the raw text the search identity matches and
        # the lookup already paid for is reused; with the display title
        # ("how is the bonus computed? (payroll.txt)") it would be a new, counted search.
        events: list[dict] = []
        calls: list[dict] = []
        pipe = _pipe(events, calls)
        prompt = "--- Attached: payroll.txt ---\nPRIVATE PAYROLL\n\nhow is the bonus computed?"
        pipe.process_text(
            prompt, "file_ask", think=True,
            search_text="how is the bonus computed?", submit_id="submit-1",
        )
        self.assertEqual(len(calls), 1)

        pipe.process_text(
            prompt, "file_ask", think=True,
            search_text="how is the bonus computed?", retry_of="q-first", submit_id="submit-retry",
        )
        self.assertEqual(len(calls), 1, "the same raw question reuses the paid lookup")
        self.assertEqual(self._counts(), (1, 1), "and spends no second attempt")
        # The attachment still reaches the model on the retry.
        messages = pipe.client.chat.completions.create.call_args.kwargs["messages"]
        self.assertTrue(any("PRIVATE PAYROLL" in (m.get("content") or "") for m in messages))

    def test_a_model_retry_never_re_searches(self):
        events: list[dict] = []
        calls: list[dict] = []
        pipe = _pipe(events, calls)
        pipe.client.chat.completions.create.side_effect = [ConnectionError("network"), [_Chunk("ok")]]
        with mock.patch("time.sleep", return_value=None):
            pipe.process_text("what is new?", "ask", think=True)
        self.assertEqual(len(calls), 1, "the model retry must not spend a second search")
        self.assertEqual(self._counts(), (1, 1))
        self.assertTrue([e for e in events if e.get("type") == "done"][-1]["ok"])


if __name__ == "__main__":
    unittest.main()
