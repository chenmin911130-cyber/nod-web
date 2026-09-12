"""Server Translate emits watch_copy on the audio socket (#219)."""

from __future__ import annotations

import json
import unittest
from unittest import mock

from server.app import CFG, KEYS, Session, WATCH_COPY_PAGE_MAX, watch_copy_pages


class WatchCopyTests(unittest.TestCase):
    def _session(self):
        events: list[dict] = []
        audio: list[dict] = []
        sess = Session(events.append, json.loads(json.dumps(CFG)), dict(KEYS))
        sess._workspace = "translate"
        sess.cfg.setdefault("ui", {})["translate_to"] = "zh"
        sess.ask = mock.Mock()
        sess._send_audio_text = audio.append
        return sess, events, audio

    def test_passthrough_sends_watch_copy_without_ask(self):
        sess, events, audio = self._session()
        sess._emit_translate_pieces("你好。", "zh", None)
        qs = [e for e in events if e.get("type") == "question"]
        self.assertEqual(len(qs), 1)
        self.assertTrue(qs[0].get("server_translate"))
        self.assertEqual(qs[0].get("translation"), "你好。")
        self.assertEqual(audio[0]["type"], "watch_copy")
        self.assertEqual(audio[0]["original"], "你好。")
        self.assertEqual(audio[0]["translation"], "你好。")
        self.assertTrue(audio[0]["done"])
        self.assertGreater(audio[0]["seq"], 0)
        sess.ask.assert_not_called()

    def test_other_language_asks_and_tags_the_pair(self):
        sess, events, audio = self._session()
        sess._emit_translate_pieces("Hello there", "en", None)
        qs = [e for e in events if e.get("type") == "question"]
        self.assertEqual(len(qs), 1)
        self.assertTrue(qs[0].get("server_translate"))
        self.assertNotIn("translation", qs[0])
        sess.ask.assert_called_once()
        prompt = sess.ask.call_args[0][0]
        self.assertIn(f"[NOD_TRANSLATE:{qs[0]['id']}]", prompt)
        self.assertIn("Translate only this line:\nHello there", prompt)
        self.assertEqual(audio, [])

    def test_llm_chunks_mirror_to_audio_ws(self):
        sess, events, audio = self._session()
        sess.emit({
            "type": "question",
            "id": "ask-1",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate to Chinese.\nTranslate only this line:\nHello there",
        })
        sess.emit({"type": "chunk", "id": "ask-1", "text": "你"})
        sess.emit({"type": "chunk", "id": "ask-1", "text": "好"})
        sess.emit({"type": "done", "id": "ask-1", "ok": True})
        self.assertEqual([row["translation"] for row in audio], ["你", "你好", "你好"])
        self.assertTrue(audio[-1]["done"])
        self.assertEqual(audio[-1]["original"], "Hello there")
        self.assertEqual(audio[-1]["id"], "pair-1")

    def test_chunk_carries_the_copy_version_the_phone_orders_by(self):
        """The same chunk rides the control socket too; it must name its copy version."""
        sess, events, audio = self._session()
        sess.emit({
            "type": "question",
            "id": "ask-1",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello there",
        })
        sess.emit({"type": "chunk", "id": "ask-1", "text": "你好"})
        chunks = [e for e in events if e.get("type") == "chunk"]
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]["copy_id"], "pair-1")
        self.assertEqual(chunks[0]["copy_seq"], audio[0]["seq"])

    def test_parked_control_still_forwards_watch_copy(self):
        """Phone lock screen parks the control emit; the audio path must keep going."""
        sess, events, audio = self._session()
        sess.emit({
            "type": "question",
            "id": "ask-1",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello there",
        })
        sess._detach_control_emit()
        self.assertIsNone(sess._client_emit)
        self.assertIs(sess.emit.__func__, Session._routed_emit)
        sess.emit({"type": "chunk", "id": "ask-1", "text": "你好"})
        self.assertEqual([e["type"] for e in events], ["question"])
        self.assertEqual([row["translation"] for row in audio], ["你好"])

    def test_reattach_keeps_routing_the_watch_copy(self):
        sess, events, audio = self._session()
        sess.emit({
            "type": "question",
            "id": "ask-1",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello there",
        })
        sess._detach_control_emit()
        # What the /ws?attach= branch does on reconnect.
        replacement: list[dict] = []
        sess._client_emit = replacement.append
        sess.emit = sess._routed_emit
        sess.pipeline.emit = sess._routed_emit
        sess.emit({"type": "chunk", "id": "ask-1", "text": "你好"})
        self.assertEqual([e["type"] for e in replacement], ["chunk"])
        self.assertEqual([row["translation"] for row in audio], ["你好"])

    def test_retry_of_the_same_row_does_not_append_to_the_old_answer(self):
        sess, events, audio = self._session()
        sess.emit({
            "type": "question",
            "id": "ask-1",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello there",
        })
        sess.emit({"type": "chunk", "id": "ask-1", "text": "你好"})
        sess.emit({"type": "done", "id": "ask-1", "ok": False})
        # Client retry: same row id, fresh ask + fresh stream.
        sess.emit({
            "type": "question",
            "id": "ask-2",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello there",
        })
        sess.emit({"type": "chunk", "id": "ask-2", "text": "您好"})
        self.assertEqual([row["translation"] for row in audio], ["你好", "你好", "您好"])

    def test_a_new_session_outranks_the_previous_one(self):
        """Session state resets per session; the phone's native dedupe state does not."""
        first, _events, audio = self._session()
        first.emit({
            "type": "question",
            "id": "ask-1",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello there",
        })
        first.emit({"type": "chunk", "id": "ask-1", "text": "你好"})
        second, _events2, audio2 = self._session()
        second._send_audio_text = audio2.append
        second._emit_watch_copy("pair-2", original="Again", translation="再来", done=True)
        self.assertGreater(audio2[0]["seq"], audio[-1]["seq"])
        self.assertNotEqual(audio2[0]["session_id"], audio[-1]["session_id"])
        self.assertTrue(audio[-1]["session_id"])

    def test_meeting_workspace_does_not_copy(self):
        sess, events, audio = self._session()
        sess._workspace = "meeting"
        sess._emit_watch_copy("pair-1", original="hi", translation="你好", done=True)
        self.assertEqual(audio, [])

    def test_model_error_marks_the_copy_failed(self):
        sess, events, audio = self._session()
        sess.emit({
            "type": "question",
            "id": "ask-1",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello there",
        })
        sess.emit({"type": "chunk", "id": "ask-1", "text": "你好"})
        sess.emit({"type": "error", "id": "ask-1", "text": "Generation failed"})
        sess.emit({"type": "done", "id": "ask-1", "ok": False})
        self.assertEqual([row["failed"] for row in audio], [False, True, True])
        self.assertTrue(audio[-1]["done"])
        self.assertFalse(audio[-1]["ok"])
        self.assertEqual(audio[-1]["translation"], "你好")
        # The phone consumes the same done; the failure must ride along so the row
        # is not left looking finished.
        done = [e for e in events if e.get("type") == "done"][0]
        self.assertEqual(done["copy_id"], "pair-1")
        self.assertTrue(done["copy_failed"])

    def test_superseded_ask_is_not_a_failure(self):
        """A cancelled ask emits done(ok=False) with no error; that is not a failure."""
        sess, events, audio = self._session()
        sess.emit({
            "type": "question",
            "id": "ask-1",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello there",
        })
        sess.emit({"type": "chunk", "id": "ask-1", "text": "你好"})
        sess.emit({"type": "done", "id": "ask-1", "ok": False})
        self.assertEqual([row["failed"] for row in audio], [False, False])
        done = [e for e in events if e.get("type") == "done"][0]
        self.assertFalse(done["copy_failed"])

    def test_successful_retry_clears_the_failure(self):
        sess, events, audio = self._session()
        sess.emit({
            "type": "question",
            "id": "ask-1",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello there",
        })
        sess.emit({"type": "error", "id": "ask-1", "text": "Generation failed"})
        sess.emit({"type": "done", "id": "ask-1", "ok": False})
        self.assertTrue(audio[-1]["failed"])
        # Retry of the same row: fresh ask, fresh stream, failure cleared.
        sess.emit({
            "type": "question",
            "id": "ask-2",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello there",
        })
        sess.emit({"type": "chunk", "id": "ask-2", "text": "您好"})
        sess.emit({"type": "done", "id": "ask-2", "ok": True})
        # The retry starts from empty (not appended to the abandoned answer) and
        # the last two rows are the successful ones.
        self.assertEqual([row["translation"] for row in audio[-2:]], ["您好", "您好"])
        self.assertEqual([row["failed"] for row in audio[-2:]], [False, False])
        self.assertTrue(audio[-1]["ok"])

    def test_error_for_another_ask_does_not_touch_the_copy(self):
        sess, events, audio = self._session()
        sess.emit({
            "type": "question",
            "id": "ask-1",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello there",
        })
        sess.emit({"type": "error", "id": "other-ask", "text": "boom"})
        sess.emit({"type": "error", "text": "Recording buffer full"})
        self.assertEqual(audio, [])

    def test_a_reset_mints_a_new_copy_session(self):
        """New / clear / switch mode must start a new copy session (#219)."""
        sess, events, audio = self._session()
        sess.emit({
            "type": "question",
            "id": "ask-1",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello there",
        })
        sess.emit({"type": "chunk", "id": "ask-1", "text": "你好"})
        before = audio[-1]
        self.assertTrue(before["session_id"])
        events.clear()
        sess._qa_reset("test_reset")
        announced = [e for e in events if e.get("type") == "watch_session"]
        self.assertEqual(len(announced), 1)
        self.assertTrue(announced[0]["session_id"])
        self.assertNotEqual(announced[0]["session_id"], before["session_id"])
        self.assertEqual(sess._watch_copy_original, {})
        self.assertEqual(sess._watch_copy_buf, {})
        self.assertEqual(sess._watch_copy_failed, {})
        # A row after the reset carries the new identity, not the old one.
        sess.emit({"type": "question", "id": "ask-2", "text": "[NOD_TRANSLATE:pair-9]\nTranslate only this line:\nAgain"})
        sess.emit({"type": "chunk", "id": "ask-2", "text": "再来"})
        self.assertEqual(audio[-1]["session_id"], announced[0]["session_id"])
        self.assertEqual(audio[-1]["id"], "pair-9")

    def test_reattach_replays_the_session_rows_for_recovery(self):
        """The native replay holds 24 rows; the server fills the rest on reconnect."""
        sess, events, audio = self._session()
        for i in range(30):
            sess.emit({
                "type": "question",
                "id": f"ask-{i}",
                "text": f"[NOD_TRANSLATE:pair-{i}]\nTranslate only this line:\nline {i}",
            })
            sess.emit({"type": "chunk", "id": f"ask-{i}", "text": f"第{i}句"})
            sess.emit({"type": "done", "id": f"ask-{i}", "ok": True})
        events.clear()
        sess.reattach()
        batches = [e for e in events if e.get("type") == "translate_rows"]
        self.assertEqual(len(batches), 1)
        rows = batches[0]["rows"]
        self.assertEqual(len(rows), 30)
        self.assertEqual(rows[0]["id"], "pair-0")
        self.assertEqual(rows[0]["original"], "line 0")
        self.assertEqual(rows[0]["translation"], "第0句")
        self.assertEqual(rows[-1]["id"], "pair-29")
        self.assertGreater(rows[-1]["seq"], rows[0]["seq"])
        self.assertEqual(batches[0]["session_id"], audio[-1]["session_id"])
        self.assertTrue(all("failed" in row for row in rows))
        # A reconnect in a non-translate workspace sends nothing.
        sess._workspace = "meeting"
        events.clear()
        sess.reattach()
        self.assertEqual([e for e in events if e.get("type") == "translate_rows"], [])

    def test_a_long_copy_is_paged_for_the_locked_phone(self):
        """The native path must hand the Watch joinable pages, not one big frame."""
        sess, events, audio = self._session()
        long_text = "甲" * 13000
        sess._emit_watch_copy("pair-1", original="short", translation=long_text, done=True)
        row = audio[-1]
        self.assertNotIn("original_pages", row)
        pages = row["translation_pages"]
        self.assertGreater(len(pages), 1)
        self.assertEqual("".join(pages), long_text)
        self.assertTrue(all(len(page) <= WATCH_COPY_PAGE_MAX for page in pages))
        # A short copy stays a plain string: no doubled payload for the common case.
        sess._emit_watch_copy("pair-2", original="hi", translation="你好", done=True)
        self.assertNotIn("translation_pages", audio[-1])
        self.assertNotIn("original_pages", audio[-1])

    def test_watch_copy_pages_are_lossless(self):
        """Pages re-join to the normalized copy, never exceed the cap, never truncate."""
        from server.app import _watch_copy_normalize

        cases = [
            ("", 12000),
            ("   ", 12000),
            ("hello", 7),
            ("a" * 12000, 12000),
            ("a" * 12001, 12000),
            ("你好" * 7000, 12000),
            ("p1\n\np2\n\n" + "x" * 30000 + "\n\np4", 12000),
            ("z" * 25000, 100),
            ("a。b。" * 7000, 12000),
            ("😀" * 9000, 12000),
        ]
        for raw, cap in cases:
            pages = watch_copy_pages(raw, cap)
            if not raw.strip():
                self.assertEqual(pages, [])
                continue
            self.assertTrue(pages)
            self.assertEqual("".join(pages), _watch_copy_normalize(raw))
            self.assertTrue(all(len(page) <= cap for page in pages), [(len(p), cap) for p in pages])

    def test_the_recovery_batch_pages_and_can_be_asked_for(self):
        """More than one page of rows: the phone can keep fetching, in order."""
        sess, events, audio = self._session()
        for i in range(250):
            sess.emit({
                "type": "question",
                "id": f"ask-{i}",
                "text": f"[NOD_TRANSLATE:pair-{i}]\nTranslate only this line:\nline {i}",
            })
            sess.emit({"type": "chunk", "id": f"ask-{i}", "text": f"第{i}句"})
        # Re-attach sends the newest page and says there is more.
        events.clear()
        sess.reattach()
        first = next(e for e in events if e.get("type") == "translate_rows")
        self.assertEqual(len(first["rows"]), 200)
        self.assertTrue(first["has_more"])
        self.assertEqual(first["rows"][0]["id"], "pair-50")
        self.assertEqual(first["rows"][-1]["id"], "pair-249")
        # The phone asks for what is older than what it got.
        events.clear()
        sess.dispatch({"type": "copy_rows", "before": first["oldest_order"]})
        older = next(e for e in events if e.get("type") == "translate_rows")
        self.assertEqual([row["id"] for row in older["rows"]], [f"pair-{i}" for i in range(50)])
        self.assertFalse(older["has_more"])
        self.assertEqual(older["rows"][0]["translation"], "第0句")
        # A workspace with no copy session still answers (so the phone stops asking).
        sess._workspace = "meeting"
        events.clear()
        sess.dispatch({"type": "copy_rows"})
        empty = next(e for e in events if e.get("type") == "translate_rows")
        self.assertEqual(empty["rows"], [])
        self.assertFalse(empty["has_more"])

    def test_a_cross_session_batch_is_not_replayed(self):
        """Rows of a copy session the phone cleared must not be re-sent."""
        sess, events, audio = self._session()
        sess.emit({"type": "question", "id": "ask-1", "text": "[NOD_TRANSLATE:pair-1]\nTranslate only this line:\nHello"})
        sess.emit({"type": "chunk", "id": "ask-1", "text": "你好"})
        sess._qa_reset("new_session")
        events.clear()
        sess.dispatch({"type": "copy_rows"})
        empty = next(e for e in events if e.get("type") == "translate_rows")
        self.assertEqual(empty["rows"], [])

    def test_the_recovery_cursor_is_stable_when_an_old_sentence_is_retried(self):
        """A retried early sentence keeps its place in the walk (#219 review).

        The cursor must not use the content version: sentence 1 retried now has the
        highest version, so paging by version would drop it from the walk forever.
        """
        sess, events, audio = self._session()
        for i in range(201):
            sess.emit({
                "type": "question",
                "id": f"ask-{i}",
                "text": f"[NOD_TRANSLATE:pair-{i}]\nTranslate only this line:\nline {i}",
            })
            sess.emit({"type": "chunk", "id": f"ask-{i}", "text": f"第{i}句"})
        # Retry sentence 0: same row, new ask, newer version than every later row.
        sess.emit({
            "type": "question",
            "id": "ask-retry",
            "text": "[NOD_TRANSLATE:pair-0]\nTranslate only this line:\nline 0",
        })
        sess.emit({"type": "chunk", "id": "ask-retry", "text": "重译第0句"})
        self.assertGreater(sess._watch_copy_seq_of["pair-0"], sess._watch_copy_seq_of["pair-200"])
        # Walk the whole session the way the phone does.
        seen: list[str] = []
        before = 0
        for _ in range(5):
            events.clear()
            sess.dispatch({"type": "copy_rows", "before": before} if before else {"type": "copy_rows"})
            batch = next(e for e in events if e.get("type") == "translate_rows")
            seen = [row["id"] for row in batch["rows"]] + seen
            if not batch["has_more"]:
                break
            before = batch["oldest_order"]
        self.assertEqual(len(seen), 201)
        self.assertEqual(seen[0], "pair-0")
        self.assertEqual(seen[-1], "pair-200")
        self.assertEqual(len(set(seen)), 201)
        self.assertEqual(seen, [f"pair-{i}" for i in range(201)])

    def test_a_row_updated_during_the_walk_keeps_its_place(self):
        """Content updates while paging must not reorder or duplicate the row."""
        sess, events, audio = self._session()
        for i in range(201):
            sess.emit({
                "type": "question",
                "id": f"ask-{i}",
                "text": f"[NOD_TRANSLATE:pair-{i}]\nTranslate only this line:\nline {i}",
            })
            sess.emit({"type": "chunk", "id": f"ask-{i}", "text": f"第{i}句"})
        events.clear()
        sess.dispatch({"type": "copy_rows"})
        first = next(e for e in events if e.get("type") == "translate_rows")
        self.assertTrue(first["has_more"])
        # The newest sentence keeps streaming while the phone pages back.
        sess.emit({"type": "chunk", "id": "ask-200", "text": "！"})
        events.clear()
        sess.dispatch({"type": "copy_rows", "before": first["oldest_order"]})
        older = next(e for e in events if e.get("type") == "translate_rows")
        ids = [row["id"] for row in older["rows"]] + [row["id"] for row in first["rows"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(ids[0], "pair-0")
        self.assertEqual(ids, [f"pair-{i}" for i in range(201)])
        # The newest page re-fetched after the update carries the new text, still
        # last and still versioned above the older sentences.
        events.clear()
        sess.dispatch({"type": "copy_rows"})
        newest_batch = next(e for e in events if e.get("type") == "translate_rows")
        newest = newest_batch["rows"][-1]
        self.assertEqual(newest["id"], "pair-200")
        self.assertEqual(newest["translation"], "第200句！")
        self.assertGreater(newest["seq"], newest_batch["rows"][0]["seq"])

    def test_the_voice_question_carries_its_sentence_order(self):
        """The phone builds its row from the question, before any copy frame."""
        sess, events, audio = self._session()
        sess._emit_translate_pieces("Hello there", "en", None)
        q = next(e for e in events if e.get("type") == "question")
        self.assertEqual(q["order"], 1)
        self.assertEqual(q["server_translate"], True)
        sess._emit_translate_pieces("Again please", "en", None)
        q2 = [e for e in events if e.get("type") == "question"][-1]
        self.assertEqual(q2["order"], 2)
        # A retry of the first row keeps its order.
        sess.emit({
            "type": "question",
            "id": "ask-retry",
            "text": f"[NOD_TRANSLATE:{q['id']}]\nTranslate only this line:\nHello there",
        })
        sess.emit({"type": "chunk", "id": "ask-retry", "text": "重译"})
        self.assertEqual(sess._watch_copy_order_for(q["id"]), 1)
        self.assertEqual(sess._watch_copy_order_for(q2["id"]), 2)

    def test_a_typed_row_learns_its_order_from_the_ask(self):
        sess, events, audio = self._session()
        sess.emit({
            "type": "question",
            "id": "ask-typed",
            "text": "[NOD_TRANSLATE:typed-1]\nTranslate only this line:\nhello",
        })
        q = next(e for e in events if e.get("type") == "question")
        self.assertEqual(q["order"], 1)
        self.assertEqual(sess._watch_copy_order_for("typed-1"), 1)
