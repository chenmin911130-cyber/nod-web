"""Server Live Q&A emits its own native copy rows on the audio socket.

#219 taught the Translate lane to reach a locked phone: the server mirrors the row
onto the native audio WebSocket, which the iOS uplink keeps alive while the
WebContent process is suspended. Live Q&A (the `interview` workspace) never had
that mirror, so its questions and answers only travelled to the Watch through the
web layer's `buildWatchFace` + `pushWatchStatus` -- exactly the path the lock
screen stops.

These tests drive the real producer (`Session.emit`, the same entry point
`Pipeline.process_text` uses) into the real consumer (`_send_audio_text`, the
function that writes to the audio socket), and assert the row's identity,
ordering, paging and failure semantics.
"""

from __future__ import annotations

import json
import unittest
from unittest import mock

from server.app import CFG, KEYS, Session, WATCH_COPY_PAGE_MAX


class QaCopyTests(unittest.TestCase):
    def _session(self, workspace: str = "interview"):
        events: list[dict] = []
        audio: list[dict] = []
        sess = Session(events.append, json.loads(json.dumps(CFG)), dict(KEYS))
        sess._workspace = workspace
        sess.ask = mock.Mock()
        sess._send_audio_text = audio.append
        return sess, events, audio

    def _ask(self, sess, qid: str, question: str) -> None:
        sess.emit({"type": "question", "id": qid, "text": question})

    # --- the lock-screen path itself -----------------------------------------

    def test_question_and_streamed_answer_reach_the_audio_socket(self):
        """The whole reason for the lane: no control client, audio still flows."""
        sess, events, audio = self._session()
        self._ask(sess, "q-1", "What is the refund window?")
        self.assertEqual(audio[0]["type"], "qa_copy")
        self.assertEqual(audio[0]["id"], "q-1")
        self.assertEqual(audio[0]["question"], "What is the refund window?")
        self.assertEqual(audio[0]["answer"], "")
        self.assertFalse(audio[0]["done"])
        self.assertFalse(audio[0]["failed"])

        # The phone locks: the web layer's sink is parked, the session is not.
        sess._detach_control_emit()
        self.assertIsNone(sess._client_emit)
        parked_from = len(events)
        sess.emit({"type": "chunk", "id": "q-1", "text": "It is "})
        sess.emit({"type": "chunk", "id": "q-1", "text": "30 days."})
        sess.emit({"type": "done", "id": "q-1", "ok": True})

        qa = [row for row in audio if row["type"] == "qa_copy"]
        self.assertEqual([row["answer"] for row in qa], ["", "It is ", "It is 30 days.", "It is 30 days."])
        self.assertTrue(qa[-1]["done"])
        self.assertFalse(qa[-1]["failed"])
        self.assertTrue(qa[-1]["ok"])
        # Parked control emit means the native audio socket is the ONLY copy of the
        # answer: nothing was handed to the (suspended) web layer.
        self.assertEqual(events[parked_from:], [])

    def test_a_replay_of_an_answered_question_is_not_re_emitted_as_new(self):
        """`_replay_pcm_rejection`/reconnect replays must not duplicate a row."""
        sess, _, audio = self._session()
        self._ask(sess, "q-1", "How long?")
        for text in ("Th", "ree", " days."):
            sess.emit({"type": "chunk", "id": "q-1", "text": text})
        sess.emit({"type": "done", "id": "q-1", "ok": True})
        before = len(audio)
        # The audio socket reconnects and the server re-announces the last drain /
        # rejection; no Q&A row is involved, so nothing new may be mirrored.
        sess._replay_pcm_rejection()
        self.assertEqual(len(audio), before)

    def test_a_long_answer_is_paged_for_the_locked_phone(self):
        sess, _, audio = self._session()
        long_answer = "答" * 13000
        self._ask(sess, "q-1", "short question")
        sess.emit({"type": "chunk", "id": "q-1", "text": long_answer})
        row = audio[-1]
        pages = row["answer_pages"]
        self.assertGreater(len(pages), 1)
        self.assertEqual("".join(pages), long_answer)
        self.assertTrue(all(len(page) <= WATCH_COPY_PAGE_MAX for page in pages))
        self.assertNotIn("question_pages", row)
        self.assertTrue(row["done"] is False)

    def test_a_long_question_is_paged_too(self):
        sess, _, audio = self._session()
        long_question = "问" * 13000
        self._ask(sess, "q-1", long_question)
        row = audio[-1]
        self.assertEqual("".join(row["question_pages"]), long_question)
        self.assertNotIn("answer_pages", row)

    # --- identity / staleness across attempts ---------------------------------

    def test_a_late_chunk_from_a_superseded_question_is_dropped(self):
        sess, _, audio = self._session()
        self._ask(sess, "q-1", "First?")
        sess.emit({"type": "chunk", "id": "q-1", "text": "first answer"})
        self._ask(sess, "q-2", "Second?")
        sess.emit({"type": "chunk", "id": "q-2", "text": "second answer"})
        before = len(audio)
        # The old turn's tail lands after the new question was committed.
        sess.emit({"type": "chunk", "id": "q-1", "text": " (late)"})
        sess.emit({"type": "done", "id": "q-1", "ok": False})
        sess.emit({"type": "error", "id": "q-1", "text": "late failure"})
        self.assertEqual(len(audio), before)
        self.assertEqual(audio[-1]["id"], "q-2")
        self.assertEqual(audio[-1]["answer"], "second answer")

    def test_retry_of_the_same_question_starts_a_fresh_answer(self):
        """Retry reuses the turn id; the old text must not be appended to."""
        sess, _, audio = self._session()
        self._ask(sess, "q-1", "How long?")
        sess.emit({"type": "chunk", "id": "q-1", "text": "old partial"})
        sess.emit({"type": "error", "id": "q-1", "text": "model failed"})
        # Retry: the same question id is re-asked.
        self._ask(sess, "q-1", "How long?")
        self.assertEqual(audio[-1]["answer"], "")
        self.assertFalse(audio[-1]["failed"])
        sess.emit({"type": "chunk", "id": "q-1", "text": "fresh answer"})
        self.assertEqual(audio[-1]["answer"], "fresh answer")
        self.assertFalse(audio[-1]["failed"])
        sess.emit({"type": "done", "id": "q-1", "ok": True})
        self.assertEqual(audio[-1]["answer"], "fresh answer")
        self.assertTrue(audio[-1]["done"])

    def test_a_failure_names_its_attempt_and_a_retry_clears_it(self):
        sess, _, audio = self._session()
        self._ask(sess, "q-1", "Will this fail?")
        sess.emit({"type": "error", "id": "q-1", "text": "quota"})
        self.assertTrue(audio[-1]["failed"])
        self.assertFalse(audio[-1]["done"])
        # Done for the same failed attempt keeps the failure so the Watch can say
        # so instead of showing a half answer as live.
        sess.emit({"type": "done", "id": "q-1", "ok": False})
        self.assertTrue(audio[-1]["failed"])
        self.assertTrue(audio[-1]["done"])
        # A successful retry clears it.
        self._ask(sess, "q-1", "Will this fail?")
        self.assertFalse(audio[-1]["failed"])
        sess.emit({"type": "chunk", "id": "q-1", "text": "ok"})
        sess.emit({"type": "done", "id": "q-1", "ok": True})
        self.assertFalse(audio[-1]["failed"])

    def test_a_new_session_outranks_the_previous_one(self):
        """A fresh content session's first row must not read as stale."""
        sess, events, audio = self._session()
        self._ask(sess, "q-1", "Old session?")
        sess.emit({"type": "chunk", "id": "q-1", "text": "old"})
        old = audio[-1]
        sess._watch_copy_reset("test_reset")
        self._ask(sess, "q-2", "New session?")
        new = audio[-1]
        self.assertNotEqual(new["session_id"], old["session_id"])
        self.assertGreater(new["seq"], old["seq"])

    def test_an_internal_prompt_never_becomes_the_watch_question(self):
        sess, _, audio = self._session()
        sess.emit({
            "type": "question",
            "id": "ask-1",
            "text": "[NOD_NOTES:notes-1]\nWrite structured notes",
        })
        sess.emit({
            "type": "question",
            "id": "ask-2",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello",
        })
        self.assertEqual(audio, [])

    # --- the lane must not leak into / out of the others -----------------------

    def test_qa_lane_is_silent_outside_the_interview_workspace(self):
        sess, _, audio = self._session(workspace="translate")
        self._ask(sess, "q-1", "Should not mirror?")
        sess.emit({"type": "chunk", "id": "q-1", "text": "no"})
        self.assertEqual(audio, [])

    def test_switching_mode_resets_the_qa_lane(self):
        """A late Q&A frame must not survive into the next conversation."""
        sess, events, audio = self._session()
        self._ask(sess, "q-1", "Q?")
        sess.emit({"type": "chunk", "id": "q-1", "text": "A"})
        old_session = audio[-1]["session_id"]
        sess.set_workspace("meeting", "meeting", None)
        sess.set_workspace("interview", "interview", None)
        self._ask(sess, "q-2", "New Q?")
        self.assertNotEqual(audio[-1]["session_id"], old_session)
        # The old conversation's state is gone: its late frame cannot overwrite the
        # new question's row.
        self.assertEqual(sess._qa_copy_id, "q-2")
        self.assertEqual(sess._qa_copy_buf, "")

    def test_translate_events_do_not_become_a_qa_row(self):
        """The two lanes share the session but never each other's rows."""
        sess, _, audio = self._session()
        self._ask(sess, "q-1", "Real question?")
        sess.emit({"type": "chunk", "id": "q-1", "text": "real answer"})
        self.assertEqual([row["type"] for row in audio], ["qa_copy", "qa_copy"])
        self.assertEqual(audio[-1]["question"], "Real question?")
        self.assertEqual(audio[-1]["answer"], "real answer")

    def test_the_qa_row_carries_no_translate_binding(self):
        """The lane is keyed on the real turn id, never the translate marker."""
        sess, _, audio = self._session()
        self._ask(sess, "q-1", "Where is the station?")
        row = audio[-1]
        self.assertEqual(row["id"], "q-1")
        self.assertNotIn("copy_seq", row)
        self.assertNotIn("translation", row)
        self.assertNotIn("original", row)
        # Its own stable turn order, not the Translate sentence order.
        self.assertEqual(row["order"], 1)
        self.assertEqual(sess._watch_copy_order, {})
        sess.emit({"type": "chunk", "id": "q-1", "text": "Over there."})
        self.assertEqual(audio[-1]["id"], "q-1")
        self.assertEqual(audio[-1]["order"], 1)

    # --- phone-side recovery after unlock -------------------------------------

    def test_reattach_replays_the_qa_turns_for_the_phone(self):
        sess, events, audio = self._session()
        for i in range(3):
            self._ask(sess, f"q-{i}", f"Question {i}?")
            sess.emit({"type": "chunk", "id": f"q-{i}", "text": f"Answer {i}"})
            sess.emit({"type": "done", "id": f"q-{i}", "ok": True})
        events.clear()
        sess.reattach()
        batches = [e for e in events if e.get("type") == "qa_rows"]
        self.assertEqual(len(batches), 1)
        rows = batches[0]["rows"]
        self.assertEqual([row["id"] for row in rows], ["q-0", "q-1", "q-2"])
        self.assertEqual(rows[0]["question"], "Question 0?")
        self.assertEqual(rows[0]["answer"], "Answer 0")
        self.assertTrue(rows[0]["done"])
        self.assertFalse(rows[0]["failed"])
        self.assertEqual([row["order"] for row in rows], [1, 2, 3])
        self.assertEqual(batches[0]["session_id"], audio[-1]["session_id"])
        # A reconnect in another workspace sends nothing.
        sess._workspace = "meeting"
        events.clear()
        sess.reattach()
        self.assertEqual([e for e in events if e.get("type") == "qa_rows"], [])

    def test_a_completed_turn_keeps_its_last_attempt_for_recovery(self):
        sess, events, _ = self._session()
        self._ask(sess, "q-1", "Retry me?")
        sess.emit({"type": "chunk", "id": "q-1", "text": "stale"})
        sess.emit({"type": "error", "id": "q-1", "text": "boom"})
        sess.emit({"type": "done", "id": "q-1", "ok": False})
        self._ask(sess, "q-1", "Retry me?")
        sess.emit({"type": "chunk", "id": "q-1", "text": "fresh"})
        sess.emit({"type": "done", "id": "q-1", "ok": True})
        events.clear()
        sess.reattach()
        row = next(e for e in events if e.get("type") == "qa_rows")["rows"][0]
        self.assertEqual(row["answer"], "fresh")
        self.assertFalse(row["failed"])
        self.assertTrue(row["done"])

    def test_an_unfinished_turn_is_recoverable_without_a_done(self):
        sess, events, _ = self._session()
        self._ask(sess, "q-1", "Still answering?")
        sess.emit({"type": "chunk", "id": "q-1", "text": "half"})
        events.clear()
        sess.reattach()
        row = next(e for e in events if e.get("type") == "qa_rows")["rows"][0]
        self.assertEqual(row["answer"], "half")
        self.assertFalse(row["done"])


if __name__ == "__main__":
    unittest.main()
