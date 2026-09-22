"""Phone offline while listening: keep the session through the grace window."""

from __future__ import annotations

import time
import unittest
from unittest import mock

from server import uplink
from server.app import Session


def _clear_listener(sess: Session) -> None:
    sess._listener = None


class OfflineGraceTests(unittest.TestCase):
    def _session(self) -> Session:
        sess = Session.__new__(Session)
        sess._listener = object()
        sess._listen_wanted = True
        sess._paused = False
        sess._idle_check_at = 0.0
        sess._listen_started_at = time.time()
        sess._listen_accum_sec = 0.0
        sess._last_voice_at = time.time()
        sess._last_pcm_at = time.time()
        sess._listen_mic = "phone"
        sess._uplink_connected = False
        sess._uplink_seen = True
        sess._uplink_lost_at = 0.0
        sess._control_lost_at = 0.0
        sess._client_emit = mock.Mock()
        sess.pipeline = mock.Mock()
        sess._offer_save_history = mock.Mock()
        sess.emit = mock.Mock()
        sess._stop_listening = mock.Mock(side_effect=lambda: _clear_listener(sess))
        return sess

    def _status_texts(self, sess: Session) -> list[str]:
        texts: list[str] = []
        for call in sess.emit.call_args_list:
            ev = call.args[0]
            if isinstance(ev, dict) and ev.get("type") == "status":
                texts.append(str(ev.get("text") or ""))
        return texts

    def test_link_down_inside_grace_keeps_listening(self) -> None:
        sess = self._session()
        now = time.time()
        sess._last_pcm_at = now - 60
        sess._uplink_lost_at = now - 60
        sess._maybe_stop_forgotten_listen()
        self.assertIsNotNone(sess._listener)
        self.assertTrue(sess._listen_wanted)
        self.assertFalse(any("No microphone audio" in text for text in self._status_texts(sess)))
        sess._stop_listening.assert_not_called()

    def test_link_down_past_grace_stops_with_offline_status(self) -> None:
        sess = self._session()
        now = time.time()
        sess._last_pcm_at = now - 121
        sess._uplink_lost_at = now - 121
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_called_once()
        sess._offer_save_history.assert_called_once()
        texts = self._status_texts(sess)
        self.assertTrue(any("offline" in text for text in texts))
        self.assertFalse(any("No microphone audio" in text for text in texts))

    def test_start_replays_parked_offline_stop_once(self) -> None:
        sess = self._session()
        now = time.time()
        sess._last_pcm_at = now - 121
        sess._uplink_lost_at = now - 121
        sess._client_emit = None
        sess.user_id = "user-1"
        sess.usage_session_id = "sess-1"
        sess._workspace = "meeting"
        sess._usage_mode = "meeting"
        sess._engine = "idle"
        sess._manual = False
        sess._watch_copy_session = "copy-1"
        sess.pipeline.key_status.return_value = {"has_llm": False, "has_stt": False}

        def offer() -> None:
            sess.emit({
                "type": "save_prompt",
                "id": "sess-1",
                "mode": "meeting",
                "text": "Save this session to History?",
            })

        sess._offer_save_history = offer
        sess._maybe_stop_forgotten_listen()

        replay: list[dict] = []
        sess.emit = replay.append
        sess._client_emit = replay.append
        sess.start()
        types = [ev["type"] for ev in replay]
        self.assertLess(types.index("ready"), types.index("phase"))
        offline = [
            ev for ev in replay
            if ev.get("type") == "status" and "offline" in str(ev.get("text") or "")
        ]
        prompts = [ev for ev in replay if ev.get("type") == "save_prompt"]
        self.assertEqual(len(offline), 1)
        self.assertEqual(len(prompts), 1)
        self.assertGreater(types.index("status"), types.index("phase"))
        phase_at = types.index("phase")
        self.assertGreater(replay.index(offline[0]), phase_at)
        self.assertGreater(replay.index(prompts[0]), phase_at)

        again: list[dict] = []
        sess.emit = again.append
        sess.start()
        self.assertFalse(any(
            ev.get("type") == "status" and "offline" in str(ev.get("text") or "")
            for ev in again
        ))
        self.assertFalse(any(ev.get("type") == "save_prompt" for ev in again))

    def test_reattach_replays_parked_offline_stop_once(self) -> None:
        """?attach= calls reattach(), not start(). The notice has to ride that path."""
        sess = self._session()
        now = time.time()
        sess._last_pcm_at = now - 121
        sess._uplink_lost_at = now - 121
        sess._client_emit = None
        sess.user_id = "user-1"
        sess.usage_session_id = "sess-1"
        sess._workspace = "meeting"
        sess._usage_mode = "meeting"
        sess._engine = "idle"
        sess._manual = False
        sess._watch_copy_session = "copy-1"
        sess.pipeline.key_status.return_value = {"has_llm": False, "has_stt": False}

        def offer() -> None:
            sess.emit({
                "type": "save_prompt",
                "id": "sess-1",
                "mode": "meeting",
                "text": "Save this session to History?",
            })

        sess._offer_save_history = offer
        sess._maybe_stop_forgotten_listen()

        replay: list[dict] = []
        sess.emit = replay.append
        sess._client_emit = replay.append
        sess.reattach()
        types = [ev["type"] for ev in replay]
        self.assertLess(types.index("ready"), types.index("phase"))
        offline = [
            ev for ev in replay
            if ev.get("type") == "status" and "offline" in str(ev.get("text") or "")
        ]
        prompts = [ev for ev in replay if ev.get("type") == "save_prompt"]
        self.assertEqual(len(offline), 1)
        self.assertEqual(len(prompts), 1)
        phase_at = types.index("phase")
        self.assertGreater(replay.index(offline[0]), phase_at)
        self.assertGreater(replay.index(prompts[0]), phase_at)

        again: list[dict] = []
        sess.emit = again.append
        sess.reattach()
        self.assertFalse(any(
            ev.get("type") == "status" and "offline" in str(ev.get("text") or "")
            for ev in again
        ))
        self.assertFalse(any(ev.get("type") == "save_prompt" for ev in again))

    def test_connected_uplink_still_stops_on_zero_pcm(self) -> None:
        sess = self._session()
        sess._uplink_connected = True
        sess._uplink_seen = True
        sess._last_pcm_at = time.time() - 30
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_called_once()
        self.assertFalse(sess._listen_wanted)
        texts = self._status_texts(sess)
        self.assertTrue(any("No microphone audio" in text for text in texts))
        self.assertFalse(any("offline" in text for text in texts))

    def test_unseen_uplink_still_stops_on_zero_pcm(self) -> None:
        sess = self._session()
        sess._uplink_connected = False
        sess._uplink_seen = False
        sess._last_pcm_at = time.time() - 30
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_called_once()
        texts = self._status_texts(sess)
        self.assertTrue(any("No microphone audio" in text for text in texts))

    def test_missing_drop_clock_falls_back_to_zero_pcm(self) -> None:
        sess = self._session()
        sess._uplink_lost_at = 0.0
        sess._control_lost_at = 0.0
        sess._last_pcm_at = time.time() - 30
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_called_once()
        texts = self._status_texts(sess)
        self.assertTrue(any("No microphone audio" in text for text in texts))
        self.assertFalse(any("offline" in text for text in texts))

    def test_control_lost_clock_keeps_listen_inside_grace(self) -> None:
        sess = self._session()
        now = time.time()
        sess._uplink_lost_at = 0.0
        sess._control_lost_at = now - 60
        sess._last_pcm_at = now - 60
        sess._maybe_stop_forgotten_listen()
        self.assertIsNotNone(sess._listener)
        self.assertTrue(sess._listen_wanted)
        sess._stop_listening.assert_not_called()

    def test_control_lost_clock_stops_after_grace(self) -> None:
        sess = self._session()
        now = time.time()
        sess._uplink_lost_at = 0.0
        sess._control_lost_at = now - 121
        sess._last_pcm_at = now - 121
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_called_once()
        texts = self._status_texts(sess)
        self.assertTrue(any("offline" in text for text in texts))
        self.assertFalse(any("No microphone audio" in text for text in texts))

    def test_paused_listen_is_not_stopped_by_offline_grace(self) -> None:
        sess = self._session()
        now = time.time()
        sess._paused = True
        sess._last_pcm_at = now - 121
        sess._uplink_lost_at = now - 121
        sess._maybe_stop_forgotten_listen()
        self.assertIsNotNone(sess._listener)
        self.assertTrue(sess._paused)
        self.assertTrue(sess._listen_wanted)
        sess._stop_listening.assert_not_called()

    def test_silence_rule_still_stops_inside_grace(self) -> None:
        from server.settings import LISTEN_IDLE_SECONDS

        sess = self._session()
        now = time.time()
        sess._uplink_lost_at = now - 60
        sess._last_pcm_at = now - 60
        sess._last_voice_at = now - LISTEN_IDLE_SECONDS - 1
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_called_once()
        texts = self._status_texts(sess)
        self.assertTrue(any("silence" in text.lower() for text in texts))
        self.assertFalse(any("offline" in text for text in texts))
        self.assertFalse(any("No microphone audio" in text for text in texts))

    def test_watch_mic_link_down_stops_at_grace_not_watch_window(self) -> None:
        sess = self._session()
        sess._listen_mic = "watch"
        now = time.time()
        sess._last_pcm_at = now - 121
        sess._uplink_lost_at = now - 121
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_called_once()
        texts = self._status_texts(sess)
        self.assertTrue(any("offline" in text for text in texts))
        self.assertFalse(any("No microphone audio" in text for text in texts))


class OfflineGraceReapTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()

    def tearDown(self) -> None:
        uplink.reset()

    def _parked(self) -> Session:
        sess = Session.__new__(Session)
        sess.audio_token = "tok-grace"
        sess.user_id = "user-a"
        sess._closed = False
        sess._listener = object()
        sess._uplink_connected = False
        sess._uplink_seen = True
        sess._control_lost_at = time.time() - 90
        sess._uplink_lost_at = time.time() - 90
        sess.close = mock.Mock()
        uplink.register(sess)
        uplink.park(sess)
        return sess

    def test_reap_keeps_listener_inside_grace_and_closes_after(self) -> None:
        sess = self._parked()
        uplink.reap(time.time())
        sess.close.assert_not_called()
        self.assertIs(uplink.get(sess.audio_token), sess)

        sess._uplink_lost_at = time.time() - 130
        sess._control_lost_at = time.time() - 130
        uplink.reap(time.time())
        sess.close.assert_called_once()
        self.assertIsNone(uplink.get(sess.audio_token))

    def test_reap_closes_immediately_when_listener_is_gone(self) -> None:
        sess = self._parked()
        sess._listener = None
        sess._uplink_lost_at = time.time()
        sess._control_lost_at = time.time()
        uplink.reap(time.time())
        sess.close.assert_called_once()
        self.assertIsNone(uplink.get(sess.audio_token))

    def test_reap_closes_orphan_after_600s(self) -> None:
        from server.settings import UPLINK_ORPHAN_SECONDS

        sess = self._parked()
        sess._uplink_connected = True
        sess._uplink_lost_at = 0.0
        sess._control_lost_at = time.time() - UPLINK_ORPHAN_SECONDS - 1
        uplink.reap(time.time())
        sess.close.assert_called_once()
        self.assertIsNone(uplink.get(sess.audio_token))
