"""Pause and STT rotation must not re-emit or re-insert an open Meeting line.

The production Pause path keeps ``_listen_wanted`` true, so ``_collect_handoff``
seals the open line. The client already has that line; sealing must only clear
``_open_line`` and upsert the latest transcript text.
"""

import time
import unittest
from unittest import mock

from sqlalchemy import select

from server.db import HistoryItem, User, db_session
from server.meter import open_usage_session
from server.security import new_id
from tests.test_meeting_merge import _Clock, _events, _session, _wait_for

_LINE = "first line of the meeting"
_CONT = "second line continues the thought"
_META = {"turn_order": 1, "first_word_ms": 1000, "last_word_ms": 5000, "n_words": 6}
_META_CONT = {"turn_order": 2, "first_word_ms": 5400, "last_word_ms": 9000, "n_words": 5}


def _questions(sess, qid=None):
    rows = _events(sess, "question")
    if qid is None:
        return rows
    return [e for e in rows if e.get("id") == qid]


def _transcripts(session_id, qid=None):
    with db_session() as db:
        stmt = select(HistoryItem).where(
            HistoryItem.session_id == session_id,
            HistoryItem.kind == "transcript",
        )
        if qid is not None:
            stmt = stmt.where(HistoryItem.qid == qid)
        rows = db.execute(stmt).scalars().all()
        return [(r.qid, r.text) for r in rows]


def _arm(sess, *, user=True):
    sess._listen_wanted = True
    sess._listener = mock.Mock()
    sess._stop_listener = lambda lst, force_endpoint=False: None
    sess._listen_started_at = time.time()
    if user:
        uid = new_id()
        with db_session() as db:
            db.add(User(id=uid, email=f"{uid}@test.local", password_hash=""))
        sid, _snap = open_usage_session(uid, "meeting")
        if not sid:
            raise AssertionError("open_usage_session failed")
        sess.user_id = uid
        sess.usage_session_id = sid
    return sess


def _one_line(sess, text=_LINE, meta=None):
    sess._enqueue_meeting_final(text, "en", "A", dict(meta or _META))
    _wait_for(sess, "question", 1)
    return _questions(sess)[0]


class SealNoDuplicateTests(unittest.TestCase):
    def test_pause_does_not_reemit_open_line(self):
        sess = _arm(_session())
        clk = _Clock()
        with mock.patch("server.app.time.time", clk):
            opened = _one_line(sess)
            sess.pause_listen()
        self.assertEqual(len(_questions(sess, opened["id"])), 1)
        self.assertIsNone(sess._open_line)
        # A second Pause in the same session adds no question.
        sess._listener = mock.Mock()
        sess.pause_listen()
        self.assertEqual(len(_questions(sess, opened["id"])), 1)
        self.assertIsNone(sess._open_line)

        # No open line: no question events and no transcript rows.
        empty = _arm(_session())
        empty.pause_listen()
        self.assertEqual(_questions(empty), [])
        self.assertEqual(_transcripts(empty.usage_session_id), [])

        # A closed open line (split path) is cleared and not re-emitted.
        closed = _arm(_session())
        closed._open_line = {
            "id": "qclosed",
            "text": "A finished sentence.",
            "speaker": "A",
            "lang": "en",
            "closed": True,
        }
        closed.pause_listen()
        self.assertEqual(_questions(closed), [])
        self.assertIsNone(closed._open_line)
        self.assertEqual(_transcripts(closed.usage_session_id), [])

        # user_id None: still no re-emit, and the seal does not touch the DB.
        anon = _arm(_session(), user=False)
        anon.user_id = None
        anon.usage_session_id = None

        def _boom(*_a, **_k):
            raise AssertionError("db_session called")

        with mock.patch("server.app.time.time", clk), mock.patch("server.meter.db_session", _boom):
            opened_anon = _one_line(anon)
            anon.pause_listen()
        self.assertEqual(len(_questions(anon, opened_anon["id"])), 1)
        self.assertIsNone(anon._open_line)

    def test_pause_keeps_one_history_row_per_line(self):
        sess = _arm(_session())
        clk = _Clock()
        with mock.patch("server.app.time.time", clk):
            opened = _one_line(sess)
            sess.pause_listen()
        rows = _transcripts(sess.usage_session_id, opened["id"])
        self.assertEqual(rows, [(opened["id"], opened["text"])])

    def test_pause_after_extend_keeps_merged_text_once(self):
        sess = _arm(_session())
        clk = _Clock()
        with mock.patch("server.app.time.time", clk):
            opened = _one_line(sess)
            clk.advance(5)
            sess._enqueue_meeting_final(_CONT, "en", "A", dict(_META_CONT))
            sess.pause_listen()
        ups = _events(sess, "line_update")
        self.assertEqual(len(ups), 1)
        self.assertEqual(len(_questions(sess, opened["id"])), 1)
        rows = _transcripts(sess.usage_session_id, opened["id"])
        self.assertEqual(rows, [(opened["id"], ups[-1]["text"])])

    def test_stt_rotation_does_not_reemit_open_line(self):
        sess = _arm(_session())
        sess._paused = False
        sess._start_listening = lambda resume=False: None
        clk = _Clock()
        with mock.patch("server.app.time.time", clk):
            opened = _one_line(sess)
            sess._restart_listener()
        self.assertEqual(len(_questions(sess, opened["id"])), 1)
        self.assertIsNone(sess._open_line)
        self.assertEqual(_transcripts(sess.usage_session_id, opened["id"]), [(opened["id"], opened["text"])])

    def test_first_final_after_resume_opens_new_line(self):
        sess = _arm(_session())
        sess._start_listening = lambda resume=False: None
        clk = _Clock()
        with mock.patch("server.app.time.time", clk):
            opened = _one_line(sess)
            sess.pause_listen()
            clk.advance(5)
            sess.resume_listen()
            sess._enqueue_meeting_final(
                "line after resume",
                "en",
                "A",
                {"turn_order": 3, "first_word_ms": 10000, "last_word_ms": 14000, "n_words": 3},
            )
            _wait_for(sess, "question", 2)
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline and sess._open_line is None:
                time.sleep(0.01)
        ids = [e["id"] for e in _questions(sess)]
        self.assertEqual(len(ids), 2)
        self.assertNotEqual(ids[0], ids[1])
        self.assertEqual(ids[0], opened["id"])
        self.assertIsNotNone(sess._open_line)
        self.assertEqual(sess._open_line["id"], ids[1])
        self.assertEqual(sess._open_line["text"], "line after resume")


if __name__ == "__main__":
    unittest.main()
