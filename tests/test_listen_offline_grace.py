"""Phone offline while listening: keep the session through the grace window."""

from __future__ import annotations

import time
import unittest
from unittest import mock

from server import uplink
from server.app import Session, _adopt_live_stt, _reset_live_stt, _tick_live_idle_watches
from server.settings import LISTEN_OFFLINE_GRACE_SECONDS, UPLINK_ORPHAN_SECONDS


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

    def test_reap_without_uplink_lost_clock_uses_control_grace(self) -> None:
        """Audio can drop before park, so _uplink_lost_at stays 0 and only the control clock exists."""
        sess = self._parked()
        sess._uplink_lost_at = 0.0
        sess._control_lost_at = time.time() - 90
        uplink.reap(time.time())
        sess.close.assert_not_called()
        self.assertIs(uplink.get(sess.audio_token), sess)

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


class OfflineStopReapTickTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def tearDown(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def _offline_tick_session(self) -> Session:
        sess = Session.__new__(Session)
        sess.audio_token = "tok-offline-reap"
        sess.user_id = "user-1"
        sess._closed = False
        listener = object()
        sess._listener = listener
        sess._listen_wanted = True
        sess._paused = False
        sess._idle_check_at = 0.0
        sess._listen_started_at = time.time()
        sess._listen_accum_sec = 0.0
        sess._last_voice_at = time.time()
        sess._listen_mic = "phone"
        sess._uplink_connected = False
        sess._uplink_seen = True
        sess._control_lost_at = 0.0
        sess._client_emit = None
        sess._offline_notice = None
        sess.usage_session_id = "sess-1"
        sess._workspace = "meeting"
        sess._usage_mode = "meeting"
        sess._engine = "idle"
        sess._manual = False
        sess._mic_muted = False
        sess._pcm_unmetered = 0
        sess._watch_copy_session = "copy-1"
        sess.pipeline = mock.Mock()
        sess.pipeline.key_status.return_value = {"has_llm": False, "has_stt": False}
        sess.close = mock.Mock()
        sess.emit = mock.Mock()

        def offer() -> None:
            sess.emit({
                "type": "save_prompt",
                "id": "sess-1",
                "mode": "meeting",
                "text": "Save this session to History?",
            })

        sess._offer_save_history = offer

        def stop() -> None:
            sess._listener = None

        sess._stop_listening = mock.Mock(side_effect=stop)
        uplink.register(sess)
        uplink.park(sess)
        _adopt_live_stt("user-1:meeting", listener, sess)
        return sess

    def test_offline_stop_survives_same_tick_reap(self) -> None:
        sess = self._offline_tick_session()
        now = time.time()
        past = now - LISTEN_OFFLINE_GRACE_SECONDS - 1
        sess._last_pcm_at = past
        sess._uplink_lost_at = past
        _tick_live_idle_watches()
        sess.close.assert_not_called()
        self.assertIs(uplink.adopt(sess.audio_token, "user-1"), sess)

        replay: list[dict] = []
        sess.emit = replay.append
        sess._client_emit = replay.append
        sess.reattach()
        offline = [
            ev for ev in replay
            if ev.get("type") == "status" and "offline" in str(ev.get("text") or "")
        ]
        prompts = [ev for ev in replay if ev.get("type") == "save_prompt"]
        self.assertEqual(len(offline), 1)
        self.assertEqual(len(prompts), 1)

    def test_offline_stop_reaped_after_orphan_from_stop(self) -> None:
        now = time.time()
        sess = self._offline_tick_session()
        sess._listener = None
        sess._offline_notice = {
            "status": "offline stop",
            "save_prompt": True,
            "at": now - UPLINK_ORPHAN_SECONDS - 1,
        }
        sess._control_lost_at = now - 2000
        uplink.reap(now)
        sess.close.assert_called_once()

        uplink.reset()
        sess2 = self._offline_tick_session()
        sess2._listener = None
        sess2._offline_notice = {
            "status": "offline stop",
            "save_prompt": True,
            "at": now - (UPLINK_ORPHAN_SECONDS - 10),
        }
        sess2._control_lost_at = now - 2000
        sess2.close = mock.Mock()
        uplink.reap(now)
        sess2.close.assert_not_called()
        self.assertIs(uplink.get(sess2.audio_token), sess2)

    def test_flushed_notice_then_drop_closes_immediately(self) -> None:
        sess = self._offline_tick_session()
        sess._listener = None
        sess._offline_notice = None
        sess._control_lost_at = time.time()
        uplink.reap(time.time())
        sess.close.assert_called_once()
        self.assertIsNone(uplink.get(sess.audio_token))

    def test_offline_stop_retained_pcm_not_metered(self) -> None:
        sess = self._offline_tick_session()
        now = time.time()
        past = now - LISTEN_OFFLINE_GRACE_SECONDS - 1
        sess._last_pcm_at = past
        sess._uplink_lost_at = past
        _tick_live_idle_watches()
        self.assertIsInstance(sess._offline_notice, dict)
        sess._consent_ok = True
        sess._pcm_unmetered = 0
        frame = b"\x01" * 16000
        with (
            mock.patch("server.meter.consume_stt") as consume,
            mock.patch.object(sess, "_ensure_usage", return_value=True),
        ):
            consume.return_value = (True, {"ok": True})
            sess.push_pcm(frame)
        consume.assert_not_called()

    def test_offline_stop_retained_pcm_rejects_trailing_once(self) -> None:
        sess = self._offline_tick_session()
        now = time.time()
        past = now - LISTEN_OFFLINE_GRACE_SECONDS - 1
        sess._last_pcm_at = past
        sess._uplink_lost_at = past
        _tick_live_idle_watches()
        self.assertIsInstance(sess._offline_notice, dict)
        sess._listen_ended = True
        sess._listen_wanted = False
        sess._consent_ok = True
        sess._pcm_unmetered = 0
        sess._pcm_end_capture = "cap-offline"
        frame = b"\x02" * 16000
        with (
            mock.patch("server.meter.consume_stt") as consume,
            mock.patch.object(sess, "_ensure_usage", return_value=True),
            mock.patch.object(sess, "_reject_pcm_ended") as reject,
        ):
            consume.return_value = (True, {"ok": True})
            sess.push_pcm(frame)
            sess.push_pcm(frame)
        consume.assert_not_called()
        reject.assert_called_once_with("sess-1", "cap-offline", "session_ended")

    def test_offline_stop_reattach_continue_listen_survives_reap(self) -> None:
        sess = self._offline_tick_session()
        now = time.time()
        token = sess.audio_token
        usage_id = sess.usage_session_id
        past = now - LISTEN_OFFLINE_GRACE_SECONDS - 1
        sess._last_pcm_at = past
        sess._uplink_lost_at = past
        _tick_live_idle_watches()
        self.assertIsInstance(sess._offline_notice, dict)

        adopted = uplink.adopt(token, "user-1")
        self.assertIs(adopted, sess)
        self.assertEqual(sess.usage_session_id, usage_id)

        replay: list[dict] = []
        sess.emit = replay.append
        sess._client_emit = replay.append
        sess.reattach()
        self.assertIsNone(sess._offline_notice)

        sess._consent_ok = True

        def start(resume: bool = False) -> None:
            sess._listener = object()
            sess._listen_ended = False
            sess._listen_flush_done = False

        sess._start_listening = start
        with (
            mock.patch.object(sess, "_ensure_consent", return_value=True),
            mock.patch.object(sess, "_ensure_usage", return_value=True),
        ):
            sess.start_listen()

        self.assertIsNotNone(sess._listener)
        self.assertTrue(sess._listen_wanted)

        uplink.park(sess)
        sess._uplink_connected = False
        sess._uplink_lost_at = now - 30
        sess.close = mock.Mock()
        uplink.reap(now)
        sess.close.assert_not_called()
        self.assertIs(uplink.get(token), sess)
        self.assertEqual(sess.usage_session_id, usage_id)


class ReapNeverSilentlyClosesLiveListenTests(unittest.TestCase):
    _GRACE = 300

    def setUp(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def tearDown(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def _live_parked_session(self, *, in_live_stt: bool = True) -> Session:
        sess = Session.__new__(Session)
        sess.audio_token = "tok-live-reap"
        sess.user_id = "user-1"
        sess._closed = False
        listener = object()
        sess._listener = listener
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
        sess._control_lost_at = time.time()
        sess._uplink_lost_at = time.time()
        sess._client_emit = None
        sess._offline_notice = None
        sess.usage_session_id = "sess-live"
        sess._workspace = "meeting"
        sess._usage_mode = "meeting"
        sess._engine = "idle"
        sess._manual = False
        sess._mic_muted = False
        sess._pcm_unmetered = 0
        sess._watch_copy_session = "copy-1"
        sess.pipeline = mock.Mock()
        sess.pipeline.key_status.return_value = {"has_llm": False, "has_stt": False}
        sess.close = mock.Mock()
        sess.emit = mock.Mock()

        def offer() -> None:
            sess.emit({
                "type": "save_prompt",
                "id": "sess-live",
                "mode": "meeting",
                "text": "Save this session to History?",
            })

        sess._offer_save_history = offer

        def stop() -> None:
            sess._listener = None

        sess._stop_listening = mock.Mock(side_effect=stop)
        uplink.register(sess)
        uplink.park(sess)
        if in_live_stt:
            _adopt_live_stt("user-1:meeting", listener, sess)
        return sess

    def test_control_orphan_before_uplink_grace_skips_reap(self) -> None:
        now = time.time()
        sess = self._live_parked_session()
        sess._control_lost_at = now - 650
        sess._uplink_lost_at = now - 200
        sess._uplink_connected = False
        with (
            mock.patch("server.uplink.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
            mock.patch("server.app.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
        ):
            with mock.patch.object(sess, "_abandon_forgotten_listen") as abandon:
                uplink.reap(now)
        sess.close.assert_not_called()
        abandon.assert_not_called()
        self.assertIsNotNone(sess._listener)

    def test_watchdog_stops_after_uplink_grace_then_reattach_replays_once(self) -> None:
        now = time.time()
        sess = self._live_parked_session()
        sess._control_lost_at = now - 650
        sess._uplink_lost_at = now - 200
        sess._uplink_connected = False
        with (
            mock.patch("server.uplink.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
            mock.patch("server.app.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
        ):
            uplink.reap(now)
            self.assertIsNotNone(sess._listener)

            past = now - self._GRACE - 1
            sess._uplink_lost_at = past
            sess._last_pcm_at = past
            _tick_live_idle_watches()

        sess.close.assert_not_called()
        notice = getattr(sess, "_offline_notice", None)
        self.assertIsInstance(notice, dict)
        self.assertGreater(float(notice.get("at") or 0.0), 0.0)

        replay: list[dict] = []
        sess.emit = replay.append
        sess._client_emit = replay.append
        adopted = uplink.adopt(sess.audio_token, "user-1")
        self.assertIs(adopted, sess)
        sess.reattach()
        offline = [
            ev for ev in replay
            if ev.get("type") == "status" and "offline" in str(ev.get("text") or "")
        ]
        prompts = [ev for ev in replay if ev.get("type") == "save_prompt"]
        self.assertEqual(len(offline), 1)
        self.assertEqual(len(prompts), 1)

    def test_control_orphan_stops_live_listen_then_reaps_from_at(self) -> None:
        now = time.time()
        sess = self._live_parked_session()
        sess._uplink_connected = True
        sess._uplink_lost_at = 0.0
        sess._control_lost_at = now - UPLINK_ORPHAN_SECONDS - 50
        with (
            mock.patch("server.uplink.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
            mock.patch("server.app.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
        ):
            with mock.patch.object(
                sess, "_abandon_forgotten_listen", wraps=sess._abandon_forgotten_listen
            ) as abandon:
                uplink.reap(now)
            abandon.assert_called_once()
        sess.close.assert_not_called()
        notice = sess._offline_notice
        self.assertIsInstance(notice, dict)
        stop_at = float(notice["at"])

        sess.close.reset_mock()
        notice["at"] = now - (UPLINK_ORPHAN_SECONDS - 10)
        sess._listener = None
        with (
            mock.patch("server.uplink.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
            mock.patch("server.app.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
        ):
            uplink.reap(now)
        sess.close.assert_not_called()

        notice["at"] = now - UPLINK_ORPHAN_SECONDS - 1
        with (
            mock.patch("server.uplink.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
            mock.patch("server.app.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
        ):
            uplink.reap(now)
        sess.close.assert_called_once()

    def test_reap_stops_when_not_on_idle_watch_list(self) -> None:
        now = time.time()
        sess = self._live_parked_session(in_live_stt=False)
        past = now - self._GRACE - 1
        sess._uplink_lost_at = past
        sess._last_pcm_at = past
        sess._control_lost_at = now - 120
        with (
            mock.patch("server.uplink.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
            mock.patch("server.app.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
        ):
            with mock.patch.object(
                sess,
                "_abandon_forgotten_listen",
                wraps=Session._abandon_forgotten_listen.__get__(sess, Session),
            ) as abandon:
                uplink.reap(now)
            abandon.assert_called_once()
        sess.close.assert_not_called()
        self.assertIsInstance(sess._offline_notice, dict)

    def test_abandon_runs_without_holding_uplink_lock(self) -> None:
        now = time.time()
        sess = self._live_parked_session()
        sess._uplink_connected = True
        sess._control_lost_at = now - UPLINK_ORPHAN_SECONDS - 1

        def abandon(text: str, *, offline: bool = False) -> None:
            acquired = uplink._lock.acquire(blocking=False)
            self.assertTrue(acquired, "reap must not call _abandon while holding uplink._lock")
            uplink._lock.release()
            Session._abandon_forgotten_listen(sess, text, offline=offline)

        with (
            mock.patch("server.uplink.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
            mock.patch("server.app.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
        ):
            with mock.patch.object(sess, "_abandon_forgotten_listen", side_effect=abandon):
                uplink.reap(now)

    def test_abandon_that_keeps_listener_does_not_recurse(self) -> None:
        now = time.time()
        sess = self._live_parked_session()
        sess._uplink_connected = True
        sess._control_lost_at = now - UPLINK_ORPHAN_SECONDS - 1
        token = sess.audio_token
        with (
            mock.patch("server.uplink.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
            mock.patch("server.app.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
        ):
            with mock.patch.object(sess, "_abandon_forgotten_listen") as abandon:
                uplink.reap(now)
        abandon.assert_called_once()
        sess.close.assert_not_called()
        self.assertIs(uplink.get(token), sess)
        self.assertIsNotNone(sess._listener)

    def test_abandon_failure_falls_back_to_close(self) -> None:
        now = time.time()
        sess = self._live_parked_session()
        sess._uplink_connected = True
        sess._control_lost_at = now - UPLINK_ORPHAN_SECONDS - 1
        token = sess.audio_token
        with (
            mock.patch("server.uplink.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
            mock.patch("server.app.LISTEN_OFFLINE_GRACE_SECONDS", self._GRACE),
        ):
            with (
                mock.patch.object(sess, "_abandon_forgotten_listen", side_effect=RuntimeError("boom")),
                self.assertLogs("nod", level="ERROR") as logs,
            ):
                uplink.reap(now)
        sess.close.assert_called_once()
        self.assertIsNone(uplink.get(token))
        self.assertTrue(any("reap abandon failed" in m for m in logs.output))
