import threading
import time
import unittest
from unittest import mock

from server.app import Session
from server.settings import LISTEN_IDLE_SECONDS, LISTEN_MAX_SECONDS


class ForgottenListenTests(unittest.TestCase):
    def _session(self) -> Session:
        sess = Session.__new__(Session)
        sess._listener = object()
        sess._listen_wanted = True
        sess._idle_check_at = 0.0
        sess._listen_started_at = time.time()
        sess._last_voice_at = time.time()
        sess.pipeline = mock.Mock()
        sess.pipeline._cancel = threading.Event()
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
