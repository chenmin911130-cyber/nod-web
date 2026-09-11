"""#182: the whole server-side chain, not just its guards.

auto-voice final → semantic buffer → completeness judge (stub) → commit → the
REAL `_run_interview_answer` → the REAL `process_text` → stub Parallel search →
stub DeepSeek stream → `sources` event + answer + history.

The order explicitly forbids "proving the wiring by poking internal guards", so
this drives the path a real spoken question takes, with only the two external
providers stubbed.
"""

import json
import re
import threading
import time
import unittest
from collections import deque
from unittest import mock

from server import think
from server.app import Pipeline, Session
from server.db import ThinkSearchDay, ThinkSearchState
from server.think_budget import utc_day

PAYLOAD = {
    "search_id": "s1",
    "session_id": "x",
    "results": [
        {
            "url": "https://example.com/apple",
            "title": "Apple News",
            "publish_date": "2026-09-10",
            "excerpts": ["Apple announced a new model."],
        }
    ],
}


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


def _judge_stub():
    """Deterministic completeness verdict built from the real judge prompt."""

    def judge(messages, timeout=None):
        frags = re.findall(r"^\[([^\]]+)\]\s(.*)$", messages[-1]["content"], re.M)
        return json.dumps(
            {
                "verdict": "ready",
                "question": frags[-1][1] if frags else "",
                "fragments": [f[0] for f in frags],
                "reason": "stub",
            }
        )

    return judge


class ThinkChainTests(unittest.TestCase):
    def setUp(self):
        from tests.conftest import isolated_sessionmaker, make_isolated_engine

        self.engine = make_isolated_engine()
        self.session_cm = isolated_sessionmaker(self.engine)
        self.session = self.session_cm.__enter__()
        patcher = mock.patch("server.think_budget.db_session", self.session)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.session_cm.__exit__, None, None, None)
        self.addCleanup(self.engine.dispose)

    def _session(self, events, calls, *, deny=False):
        pipe = Pipeline.__new__(Pipeline)
        pipe.cfg = {"llm": {"provider": "deepseek", "model": "deepseek-flash", "max_tokens": 80}}
        pipe.emit = events.append
        pipe._provider = "deepseek"
        pipe._model = "deepseek-flash"
        pipe.client = mock.Mock()
        pipe.client.chat.completions.create.return_value = [_Chunk("Apple announced a new model.")]
        pipe._qa_history = []
        pipe._last_answer = ""
        pipe._cancel = threading.Event()
        pipe._gen_seq = 0
        pipe.user_id = None
        pipe.usage_session_id = "sess-chain"
        pipe._heard_lang = None
        pipe._qa_context = ""
        pipe.judge_qa = _judge_stub()

        def transport(request):
            calls.append(request)
            return PAYLOAD

        pipe.think_client = think.SearchClient(transport, clock=lambda: 1789012800.0)

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
        sess.usage_session_id = "sess-chain"
        sess.emit = events.append
        sess.pipeline = pipe
        sess._qa_schedule_judge = mock.Mock()
        sess._listen_wanted = False
        sess._handoff_listener = None
        sess._paused = False
        sess._engine = "idle"
        if deny:
            denied = mock.Mock(allowed=False, reason="DailyLimit", day_attempts=100, total_attempts=100)
            patcher = mock.patch("server.think_budget.reserve", return_value=denied)
            patcher.start()
            self.addCleanup(patcher.stop)
        return sess

    def _speak(self, sess) -> None:
        """Speak one question the way the STT path delivers it, then settle."""
        sess._on_final("What did Apple announce?", "en", None, {"stt_turn": 1, "listener_id": 1})
        sess._qa_activity_at = time.time() - 120
        sess._qa_timer = None
        sess._qa_last_judge_at = 0.0
        sess._qa_settle_fire()
        self.assertTrue(self._wait(lambda: not sess._qa_judging), "the judge must finish")

    def _wait(self, pred, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if pred():
                return True
            time.sleep(0.01)
        return pred()

    def _counts(self):
        with self.session() as db:
            day = db.get(ThinkSearchDay, utc_day())
            total = db.get(ThinkSearchState, "total")
            return (day.attempts if day else 0, total.attempts if total else 0)

    def test_a_spoken_question_is_searched_once_and_answered_with_its_sources(self):
        events: list[dict] = []
        calls: list[dict] = []
        sess = self._session(events, calls)
        sess.set_think(True)

        self._speak(sess)
        self.assertTrue(
            self._wait(lambda: any(e.get("type") == "done" and e.get("ok") for e in events)),
            "the answer must be delivered",
        )

        self.assertEqual(len(calls), 1, "exactly one search for one spoken question")
        self.assertEqual(self._counts(), (1, 1))

        # The evidence really reached the model's prompt.
        messages = sess.pipeline.client.chat.completions.create.call_args.kwargs["messages"]
        system = [m for m in messages if m["role"] == "system"]
        self.assertTrue(any("https://example.com/apple" in m["content"] for m in system))
        self.assertTrue(any("2026-09-10" in m["content"] for m in system))
        # ...and the answer carries the same real source to the client.
        sources = [e for e in events if e.get("type") == "sources"]
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]["status"], "ok")
        self.assertEqual(sources[0]["results"][0]["url"], "https://example.com/apple")
        self.assertEqual(sources[0]["retrieved_at_text"], "2026-09-10 04:00 UTC")
        # The confirmed Q&A entered the history used by later follow-ups.
        self.assertTrue(any("Apple" in str(h.get("a") or "") for h in sess.pipeline._qa_history))
        # The chain freed the answer slot.
        self.assertFalse(sess._busy)

    def test_a_denied_lookup_still_answers_but_never_claims_a_search(self):
        events: list[dict] = []
        calls: list[dict] = []
        sess = self._session(events, calls, deny=True)
        sess.set_think(True)

        self._speak(sess)
        self.assertTrue(
            self._wait(lambda: any(e.get("type") == "done" and e.get("ok") for e in events)),
            "a refused search must not stop the answer",
        )

        self.assertEqual(calls, [], "no request may leave when the budget refused it")
        self.assertEqual(self._counts(), (0, 0), "a refusal spends nothing")
        sources = [e for e in events if e.get("type") == "sources"]
        self.assertEqual(sources[0]["status"], "failed")
        self.assertIn("额度", sources[0]["note"])
        # The model was never handed evidence it does not have.
        messages = sess.pipeline.client.chat.completions.create.call_args.kwargs["messages"]
        self.assertFalse(any("example.com" in (m.get("content") or "") for m in messages))


if __name__ == "__main__":
    unittest.main()
