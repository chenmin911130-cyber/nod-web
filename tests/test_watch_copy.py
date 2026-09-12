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
