"""A Meeting revision may replace a line only when that line is exactly one turn.

AssemblyAI re-sends a turn (the formatted final after End). If that turn was
merged into another line, or split across lines, the revision must be consumed
and leave every line's text alone. A line that is still exactly that one turn
is replaced, even after a newer line has opened.
"""

import json
import time
import unittest
from unittest import mock

from server.app import CloudListener
from tests.test_meeting_merge import _Clock, _events, _session, _wait_for
from tests.test_meeting_seal_no_duplicate import _arm, _transcripts

_LISTENER = 7
_MERGED = "so one of the significant features of this particular outage"


def _meeting(**overrides):
    sess = _session(**overrides)
    sess._stt_line_by_turn = {}
    return sess


def _meta(turn, first, last, n_words, *, listener=_LISTENER, revision=False):
    meta = {
        "stt_turn": turn,
        "turn_order": turn,
        "listener_id": listener,
        "first_word_ms": first,
        "last_word_ms": last,
        "n_words": n_words,
    }
    if revision:
        meta["revision"] = True
    return meta


def _feed(sess, text, meta, speaker="A"):
    sess._on_final(text, "en", speaker, meta)


def _wait_pending(sess, text, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if sess._pending_wait[0] == text:
            return
        time.sleep(0.01)
    raise AssertionError(f"pending {sess._pending_wait[0]!r} != {text!r}")


def _wait_open(sess, text, timeout=2.0):
    """The worker emits ``question`` before it assigns ``_open_line``."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = sess._open_line
        if line and line.get("text") == text:
            return
        time.sleep(0.01)
    got = None if not sess._open_line else sess._open_line.get("text")
    raise AssertionError(f"open line {got!r} != {text!r}")


def _wait_transcript(session_id, qid, text, timeout=2.0):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        rows = _transcripts(session_id, qid)
        last = rows
        if rows == [(qid, text)]:
            return
        time.sleep(0.01)
    raise AssertionError(f"history {last!r} != {(qid, text)!r}")


class MeetingRevisionScopeTests(unittest.TestCase):
    def test_revision_of_merged_turn_keeps_merged_line(self):
        sess = _arm(_meeting())
        clk = _Clock()
        revised = "Features of this particular outage."
        with mock.patch("server.app.time.time", clk):
            _feed(sess, "so one of the significant", _meta(1, 1000, 4000, 5))
            _wait_for(sess, "question", 1)
            clk.advance(1)
            _feed(sess, "features of this particular outage", _meta(2, 5000, 8000, 5))
            _wait_for(sess, "line_update", 1)
            _wait_open(sess, _MERGED)
            _feed(sess, revised, _meta(2, 5000, 8200, 5, revision=True))
            time.sleep(0.15)
        self.assertEqual(sess._open_line["text"], _MERGED)
        self.assertFalse(any(e.get("text") == revised for e in _events(sess, "line_update")))
        self.assertEqual(len(_events(sess, "question")), 1)
        qid = _events(sess, "question")[0]["id"]
        _wait_transcript(sess.usage_session_id, qid, _MERGED)
        # Same stt_turn on another listener is a separate key, so it is a new
        # final and must not revise the merged line.
        _feed(
            sess,
            "Cross stream must not land here.",
            _meta(2, 20000, 24000, 6, listener=99, revision=True),
        )
        _wait_for(sess, "question", 2)
        self.assertEqual(len(_events(sess, "line_update")), 1)
        self.assertEqual(_events(sess, "line_update")[0]["text"], _MERGED)
        crossed = [e for e in _events(sess, "question") if e["text"] == "Cross stream must not land here."]
        self.assertEqual(len(crossed), 1)
        self.assertNotEqual(crossed[0]["id"], qid)
        _wait_transcript(sess.usage_session_id, qid, _MERGED)

    def test_revision_of_sole_turn_line_still_replaces(self):
        sess = _arm(_meeting())
        clk = _Clock()
        second = "We shipped the fix today."
        third = "We shipped the fix today, finally."
        with mock.patch("server.app.time.time", clk):
            _feed(sess, "We shipped the fix.", _meta(1, 1000, 4000, 4))
            _wait_for(sess, "question", 1)
            _wait_open(sess, "We shipped the fix.")
            qid = _events(sess, "question")[0]["id"]
            _feed(sess, second, _meta(1, 1000, 4500, 5, revision=True))
            _wait_for(sess, "line_update", 1)
            self.assertEqual(sess._open_line["text"], second)
            _feed(sess, third, _meta(1, 1000, 5000, 6, revision=True))
            _wait_for(sess, "line_update", 2)
        self.assertEqual(sess._open_line["text"], third)
        self.assertEqual(_events(sess, "line_update")[-1]["text"], third)
        self.assertEqual(_events(sess, "line_update")[-1]["id"], qid)
        _wait_transcript(sess.usage_session_id, qid, third)

        # The listener drops a revision whose text matches the committed turn,
        # so the session never sees it and emits nothing further.
        calls = []
        lst = CloudListener(
            api_key="k",
            cfg={"stt": {}},
            on_final=lambda *args: calls.append(args) or sess._on_final(*args),
            on_partial=None,
            on_error=None,
        )
        lst._stop.set()
        payload = json.dumps({
            "type": "Turn",
            "end_of_turn": True,
            "turn_is_formatted": True,
            "turn_order": 40,
            "transcript": "Identical wording stays once.",
            "words": [{"start": 90000, "end": 94000, "text": "Identical"}],
        })
        n_q = len(_events(sess, "question"))
        lst._on_message(None, payload)
        _wait_for(sess, "question", n_q + 1)
        n_ev = len(sess.emit.events)
        lst._on_message(None, payload)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(sess.emit.events), n_ev)
        _wait_transcript(sess.usage_session_id, qid, third)

    def test_revision_of_sole_turn_line_after_newer_line_opened(self):
        sess = _meeting()
        clk = _Clock()
        revised = "We shipped it today."
        newer = "Next speaker opens a new line."
        with mock.patch("server.app.time.time", clk):
            _feed(sess, "We shipped it.", _meta(1, 1000, 3000, 3), speaker="A")
            _wait_for(sess, "question", 1)
            q1 = _events(sess, "question")[0]["id"]
            clk.advance(1)
            _feed(sess, newer, _meta(2, 8000, 11000, 6), speaker="B")
            _wait_for(sess, "question", 2)
            _wait_open(sess, newer)
            q2 = sess._open_line["id"]
            self.assertNotEqual(q2, q1)
            self.assertEqual(sess._open_line["text"], newer)
            before = len(sess.emit.events)
            _feed(sess, revised, _meta(1, 1000, 3200, 4, revision=True), speaker="A")
            _wait_for(sess, "line_update", 1)
        new_events = sess.emit.events[before:]
        self.assertTrue(new_events)
        self.assertTrue(all(e.get("id") != q2 for e in new_events))
        self.assertEqual(new_events[0]["type"], "line_update")
        self.assertEqual(new_events[0]["id"], q1)
        self.assertEqual(new_events[0]["text"], revised)
        self.assertEqual(sess._open_line["id"], q2)
        self.assertEqual(sess._open_line["text"], newer)

    def test_revision_of_line_opener_after_extend_is_skipped(self):
        sess = _meeting(user_id=None, usage_session_id=None)

        def _boom(*_a, **_k):
            raise AssertionError("db_session called")

        clk = _Clock()
        revised = "So one of the significant."
        with mock.patch("server.app.time.time", clk), mock.patch("server.db.db_session", _boom), mock.patch("server.meter.db_session", _boom):
            _feed(sess, "so one of the significant", _meta(1, 1000, 4000, 5))
            _wait_for(sess, "question", 1)
            clk.advance(1)
            _feed(sess, "features of this particular outage", _meta(2, 5000, 8000, 5))
            _wait_for(sess, "line_update", 1)
            _wait_open(sess, _MERGED)
            _feed(sess, revised, _meta(1, 1000, 4200, 5, revision=True))
            time.sleep(0.15)
        self.assertEqual(sess._open_line["text"], _MERGED)
        self.assertEqual(len(_events(sess, "question")), 1)
        self.assertEqual(len(_events(sess, "line_update")), 1)
        self.assertFalse(any(e.get("text") == revised for e in _events(sess, "line_update")))

    def test_revision_of_split_turn_is_skipped(self):
        sess = _meeting()
        clk = _Clock()
        opener = (
            "you should share a brief update. covering all your product news across "
            "every one of your social media channels and know exactly"
        )
        incoming = "exactly where you post your weekly updates on all your social media channels. Also, make sure to stay"
        revised = incoming + " longer"
        head = (
            "you should share a brief update. covering all your product news across "
            "every one of your social media channels and know exactly where you post "
            "your weekly updates on all your social media channels."
        )
        tail = "Also, make sure to stay"
        with mock.patch("server.app.time.time", clk):
            _feed(sess, opener, _meta(1, 5000, 30000, 30))
            _wait_for(sess, "question", 1)
            clk.advance(10)
            _feed(sess, incoming, _meta(2, 30400, 43000, 20))
            _wait_for(sess, "line_update", 1)
            _wait_for(sess, "question", 2)
            _wait_open(sess, tail)
            self.assertEqual(_events(sess, "line_update")[0]["text"], head)
            _feed(sess, revised, _meta(2, 30400, 45000, 22, revision=True))
            time.sleep(0.15)
        self.assertEqual(len(_events(sess, "line_update")), 1)
        self.assertEqual(_events(sess, "line_update")[0]["text"], head)
        self.assertEqual(len(_events(sess, "question")), 2)
        self.assertEqual(_events(sess, "question")[0]["text"], opener)
        self.assertEqual(_events(sess, "question")[1]["text"], tail)
        self.assertEqual(sess._open_line["text"], tail)

    def test_revision_of_unseen_turn_is_enqueued(self):
        sess = _meeting()
        clk = _Clock()
        text = "A turn that was never delivered."
        with mock.patch("server.app.time.time", clk):
            _feed(sess, text, _meta(9, 1000, 4000, 6, revision=True))
            _wait_for(sess, "question", 1)
        self.assertEqual(_events(sess, "question")[0]["text"], text)
        self.assertIsNone(sess.user_id)

    def test_held_partial_revision_is_skipped_but_held_whole_turn_is_replaced(self):
        clk = _Clock()
        whole = _meeting()
        with mock.patch("server.app.time.time", clk):
            _feed(whole, "but", _meta(1, 1000, 1500, 1))
            _wait_pending(whole, "but")
            _feed(whole, "however", _meta(1, 1000, 1800, 1, revision=True))
        self.assertEqual(whole._pending_wait[0], "however")
        self.assertTrue(any(
            e.get("type") == "partial" and e.get("text") == "however" for e in whole.emit.events
        ))

        partial = _meeting()
        revised = "I think, better How should we proceed from here?"
        with mock.patch("server.app.time.time", clk):
            _feed(partial, "I think, better How do", _meta(3, 2000, 6000, 5))
            _wait_for(partial, "question", 1)
            _wait_open(partial, "I think, better")
            _wait_pending(partial, "How do")
            _feed(partial, revised, _meta(3, 2000, 7000, 8, revision=True))
            time.sleep(0.15)
        self.assertEqual(partial._pending_wait[0], "How do")
        self.assertEqual(partial._open_line["text"], "I think, better")
        self.assertEqual(_events(partial, "question")[0]["text"], "I think, better")
        self.assertEqual(_events(partial, "line_update"), [])
        self.assertFalse(any(e.get("text") == revised for e in partial.emit.events))
