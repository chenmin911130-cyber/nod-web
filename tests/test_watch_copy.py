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
        sess._maybe_watch_copy({
            "type": "question",
            "id": "ask-1",
            "text": "[NOD_TRANSLATE:pair-1]\nTranslate to Chinese.\nTranslate only this line:\nHello there",
        })
        sess._maybe_watch_copy({"type": "chunk", "id": "ask-1", "text": "你"})
        sess._maybe_watch_copy({"type": "chunk", "id": "ask-1", "text": "好"})
        sess._maybe_watch_copy({"type": "done", "id": "ask-1", "ok": True})
        self.assertEqual([row["translation"] for row in audio], ["你", "你好", "你好"])
        self.assertTrue(audio[-1]["done"])
        self.assertEqual(audio[-1]["original"], "Hello there")
        self.assertEqual(audio[-1]["id"], "pair-1")

    def test_meeting_workspace_does_not_copy(self):
        sess, events, audio = self._session()
        sess._workspace = "meeting"
        sess._emit_watch_copy("pair-1", original="hi", translation="你好", done=True)
        self.assertEqual(audio, [])
