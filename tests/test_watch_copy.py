"""Server Translate emits watch_copy on the audio socket (#219)."""

from __future__ import annotations

import json
import unittest
from unittest import mock

from server.app import CFG, KEYS, Session


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
