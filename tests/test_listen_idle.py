import threading
import time
import unittest
from unittest import mock

from server.app import Session, _adopt_live_stt, _reset_live_stt, _tick_live_idle_watches
from server.settings import (
    LISTEN_IDLE_SECONDS,
    LISTEN_MAX_SECONDS,
    LISTEN_ZERO_PCM_SECONDS,
    LISTEN_ZERO_PCM_WATCH_SECONDS,
)


class ForgottenListenTests(unittest.TestCase):
    def setUp(self) -> None:
        _reset_live_stt()

    def tearDown(self) -> None:
        _reset_live_stt()

    def _session(self) -> Session:
        sess = Session.__new__(Session)
        sess._listener = object()
        sess._listen_wanted = True
        sess._idle_check_at = 0.0
        sess._listen_started_at = time.time()
        sess._listen_accum_sec = 0.0
        sess._last_voice_at = time.time()
        sess._last_pcm_at = time.time()
        sess.pipeline = mock.Mock()
        sess.pipeline._cancel = threading.Event()
        sess._listen_mic = "phone"
        sess._offer_save_history = mock.Mock()
        sess.emit = mock.Mock()
        sess._stop_listening = mock.Mock()
        return sess

    def test_silence_stops_listen_without_cancelling_generate(self):
        sess = self._session()
        sess._last_voice_at = time.time() - LISTEN_IDLE_SECONDS - 1
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_called_once()
        self.assertFalse(sess._listen_wanted)
        self.assertFalse(sess.pipeline._cancel.is_set())
        status = sess.emit.call_args[0][0]
        self.assertEqual(status["type"], "status")
        self.assertIn("silence", status["text"].lower())

    def test_recent_voice_keeps_listening(self):
        sess = self._session()
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_not_called()
        self.assertTrue(sess._listen_wanted)

    def test_max_listen_stops_even_with_voice(self):
        sess = self._session()
        sess._listen_started_at = time.time() - LISTEN_MAX_SECONDS - 1
        sess._last_voice_at = time.time()
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_called_once()
        self.assertFalse(sess.pipeline._cancel.is_set())
        status = sess.emit.call_args[0][0]
        self.assertIn("hours", status["text"].lower())

    def test_live_idle_watch_stops_listen_without_pcm(self):
        """AssemblyAI bills open sockets. Idle stop used to run only inside push_pcm."""
        sess = self._session()
        lst = sess._listener
        sess._last_voice_at = time.time() - LISTEN_IDLE_SECONDS - 1
        sess._listen_started_at = sess._last_voice_at
        _adopt_live_stt("user-1:meeting", lst, sess)
        _tick_live_idle_watches()
        sess._stop_listening.assert_called_once()
        self.assertFalse(sess._listen_wanted)

    def test_resume_after_long_pause_rewinds_voice_clock(self):
        """A pause > 15 min must not read as silence the instant we resume.

        Regression: resume_listen opened the stream but left ``_last_voice_at``
        at its pre-pause value, so the idle watch thread (running 5s after
        ``_idle_check_at = 0``) saw ``now - last >= LISTEN_IDLE_SECONDS`` and
        stopped the freshly resumed session. Rewind the VOICE clock on resume and
        start a NEW segment clock (``_listen_started_at = now``); the pause's
        listened time stays banked in ``_listen_accum_sec``, so a long pause
        neither consumes nor bypasses the 2h cap (which is ACCUMULATED listen time).
        """
        sess = self._session()
        sess._paused = True
        sess._listen_wanted = True
        sess._listener = None
        # Simulate a long pause: last voice long ago, segment start far in the
        # past, but only 5 min of REAL listening banked. A long pause must not
        # read as silence (voice clock) NOR as "2h elapsed": the 2h quota is the
        # ACCUMULATED listen time, which a pause does not consume.
        sess._listen_accum_sec = 300.0
        sess._last_voice_at = time.time() - LISTEN_IDLE_SECONDS - 300
        sess._listen_started_at = time.time() - LISTEN_MAX_SECONDS - 300
        sess._start_listening = mock.Mock()
        sess.resume_listen()
        sess._start_listening.assert_called_once_with(resume=True)
        self.assertFalse(sess._paused)
        self.assertGreater(sess._last_voice_at, time.time() - 1)
        # Resume starts a NEW segment clock (so the past pause isn't counted) and
        # keeps the banked quota; neither the 2h cap nor idle is immediately hit.
        self.assertGreater(sess._listen_started_at, time.time() - 1)
        self.assertEqual(sess._listen_accum_sec, 300.0)
        self.assertTrue(
            sess._listen_accum_sec + (time.time() - sess._listen_started_at) < LISTEN_MAX_SECONDS
        )

    def test_accumulated_listen_cap_hits_after_a_pause(self) -> None:
        """The 2h cap is ACCUMULATED real listening time, so it holds across a
        pause and stops once the sum reaches the cap (even right after resume)."""
        sess = self._session()
        # Segment A banked 100s; segment B is already just short of the cap.
        sess._listen_accum_sec = 100.0
        sess._listen_started_at = time.time() - (LISTEN_MAX_SECONDS - 100)
        sess._last_voice_at = time.time()
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_called_once()
        self.assertFalse(sess._listen_wanted)

    def test_zero_pcm_stops_listen_even_with_voice(self) -> None:
        """A live socket with ZERO bytes for the zero-PCM window is a dead/never-started
        mic, never a quiet room (a quiet room still streams silence frames). Stop it fast
        even if voice was seen recently — the idle clock would wait a full 15 min."""
        sess = self._session()
        sess._last_pcm_at = time.time() - LISTEN_ZERO_PCM_SECONDS - 1
        sess._last_voice_at = time.time()  # recent voice: only the zero-PCM guard fires
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_called_once()
        self.assertFalse(sess._listen_wanted)

    def test_zero_pcm_guard_not_fired_on_recent_pcm(self) -> None:
        """Any arriving PCM refreshes _last_pcm_at, so a quiet-but-streaming room is never
        torn down by the zero-PCM guard (the 15-min idle clock owns that case)."""
        sess = self._session()
        sess._last_pcm_at = time.time()
        sess._last_voice_at = time.time()
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_not_called()

    def test_muted_stream_keeps_listen_alive(self) -> None:
        """Mute is server-side: the client keeps streaming frames and set_mic_muted
        keeps the socket up, we just drop them. push_pcm must still refresh
        _last_pcm_at, or a 25s mute would trip the zero-PCM guard and kill a
        perfectly good mic with 'No microphone audio received'."""
        sess = self._session()
        sess._mic_muted = True
        sess._listener = object()
        sess._last_pcm_at = time.time() - LISTEN_ZERO_PCM_SECONDS - 10
        sess.push_pcm(b"\x00\x01frame")  # client still streams; we drop it
        # The clock must refresh even though the frame is discarded:
        self.assertGreater(sess._last_pcm_at, time.time() - 1)
        # And the guard must NOT fire while muted + streaming:
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_not_called()

    def test_watch_mic_zero_pcm_waits_past_phone_window(self) -> None:
        """Watch mic sessions keep listening while backlog is still in flight."""
        sess = self._session()
        sess._listen_mic = "watch"
        sess._last_pcm_at = time.time() - 60
        sess._last_voice_at = time.time()
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_not_called()
        self.assertTrue(sess._listen_wanted)

    def test_watch_mic_zero_pcm_stops_after_watch_window(self) -> None:
        sess = self._session()
        sess._listen_mic = "watch"
        sess._last_pcm_at = time.time() - LISTEN_ZERO_PCM_WATCH_SECONDS - 20
        sess._last_voice_at = time.time()
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_called_once()
        self.assertFalse(sess._listen_wanted)

    def test_phone_mic_zero_pcm_still_stops_at_30s(self) -> None:
        sess = self._session()
        sess._listen_mic = "phone"
        sess._last_pcm_at = time.time() - 30
        sess._last_voice_at = time.time()
        sess._maybe_stop_forgotten_listen()
        sess._stop_listening.assert_called_once()
        self.assertFalse(sess._listen_wanted)

    def test_start_listen_without_mic_is_phone(self) -> None:
        sess = Session.__new__(Session)
        sess._manual = False
        sess._paused = True
        sess._listener = object()
        sess._listen_wanted = False
        sess.start_listen()
        self.assertEqual(sess._listen_mic, "phone")

    def test_start_listen_watch_mic(self) -> None:
        sess = Session.__new__(Session)
        sess._manual = False
        sess._paused = True
        sess._listener = object()
        sess._listen_wanted = False
        sess.start_listen(mic="watch")
        self.assertEqual(sess._listen_mic, "watch")
