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
        pipe._new_qid = lambda: "q-fixed"
        pipe.process_text("what is new?", "ask", think=True)
        pipe.process_text("what is new?", "ask", think=True)

        self.assertEqual(len(calls), 1, "the same request id must be searched once")
        self.assertEqual(self._counts(), (1, 1), "and must consume exactly one attempt")
        self.assertEqual(
            len([e for e in events if e.get("type") == "sources" and e.get("status") == "ok"]), 2,
            "both answers still show the (reused) sources",
        )

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

    def test_a_retry_reuses_a_successful_lookup_instead_of_paying_twice(self):
        # The user retries the same question in the same session: the order says
        # an existing result is reused, so the retry must not reserve or search.
        events: list[dict] = []
        calls: list[dict] = []
        pipe = _pipe(events, calls)
        pipe._new_qid = lambda: "q-first"
        pipe.process_text("what is new?", "ask", think=True)
        self.assertEqual(self._counts(), (1, 1))

        pipe._new_qid = lambda: "q-retry"
        pipe.process_text("what is new?", "ask", think=True, retry_of="q-first")

        self.assertEqual(len(calls), 1, "an OK lookup is reused, never re-bought")
        self.assertEqual(self._counts(), (1, 1), "and consumes no extra attempt")
        self.assertEqual(
            [e for e in events if e.get("type") == "sources"][-1]["status"], "ok"
        )

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
        pipe._new_qid = lambda: "q-first"
        pipe.process_text("what is new?", "ask", think=True)
        self.assertEqual(self._counts(), (1, 1), "the failed attempt stays consumed")

        pipe._new_qid = lambda: "q-retry"
        pipe.process_text("what is new?", "ask", think=True, retry_of="q-first")

        self.assertEqual(len(calls), 2, "an unknown/failed lookup may be retried for real")
        self.assertEqual(self._counts(), (2, 2), "and the retry is counted as its own attempt")
        from server.think_budget import find_snapshot

        record = find_snapshot("q-retry")
        self.assertEqual(record["attempt"], 2)
        self.assertEqual(record["parent_request_id"], "q-first")
        self.assertEqual(record["status"], "ok")

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
