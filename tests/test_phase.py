"""ADR 0001 phase tests: every legacy ``state`` event is immediately paired
with a two-axis ``phase`` event (``capture`` + ``engine``), and ``capture`` is
the single source of truth for microphone/session state.

The old ``state`` field conflated "mic captured something" with "the model is
thinking", so the Watch treated a generating model as "stopped". ``capture``
(off/listening/recording/paused) and ``engine`` (idle/transcribing/generating)
split that apart. These tests drive the methods directly with a
``Session.__new__`` + fake ``emit``, mirroring the pattern used elsewhere.
"""

import unittest
from unittest import mock

from server.app import Session


class _Emitter:
    def __init__(self) -> None:
        self.events: list[dict] = []

    def __call__(self, ev: dict) -> None:
        self.events.append(ev)


def _session(**overrides) -> Session:
    sess = Session.__new__(Session)
    sess.emit = _Emitter()
    sess._manual = False
    sess._listener = None
    sess._paused = False
    sess._engine = "idle"
    sess._listen_accum_sec = 0.0
    sess._listen_started_at = 0.0
    sess._workspace = "interview"
    for key, val in overrides.items():
        setattr(sess, key, val)
    return sess


def _phases(sess: Session) -> list[dict]:
    return [e for e in sess.emit.events if e["type"] == "phase"]


class CaptureAxisTests(unittest.TestCase):
    def test_capture_manual_wins_over_paused_and_listening(self):
        sess = _session(_manual=True, _paused=True, _listener=object())
        self.assertEqual(sess._capture(), "recording")

    def test_capture_paused_wins_over_listening(self):
        sess = _session(_paused=True, _listener=object())
        self.assertEqual(sess._capture(), "paused")

    def test_capture_listening_when_listener_present(self):
        sess = _session(_listener=object())
        self.assertEqual(sess._capture(), "listening")

    def test_capture_off_by_default(self):
        sess = _session()
        self.assertEqual(sess._capture(), "off")


class PhasePairingTests(unittest.TestCase):
    def test_emit_phase_sends_capture_and_engine(self):
        sess = _session(_listener=object())
        sess._emit_phase()
        self.assertEqual(sess.emit.events, [
            {"type": "phase", "capture": "listening", "engine": "idle"},
        ])

    def test_start_emits_phase_right_after_ready(self):
        # Reconnecting clients read `capture` from the first frame after ready.
        sess = _session()
        sess.pipeline = mock.Mock()
        sess.pipeline.key_status.return_value = {"has_llm": True, "has_stt": True}
        sess.start()
        types = [e["type"] for e in sess.emit.events]
        self.assertEqual(types[:3], ["keys_status", "ready", "phase"])
        self.assertEqual(sess.emit.events[2]["capture"], "off")

    def test_think_keeps_capture_and_reports_engine(self):
        # Decoupling: a model generating does NOT read as "stopped" on the Watch.
        sess = _session(_listener=object())
        sess._set_engine("generating")
        sess._emit_phase()
        phase = _phases(sess)[-1]
        self.assertEqual(phase["capture"], "listening")
        self.assertEqual(phase["engine"], "generating")

    def test_set_engine_changes_engine_axis(self):
        sess = _session()
        sess._set_engine("generating")
        sess._emit_phase()
        self.assertEqual(_phases(sess)[-1]["engine"], "generating")


class PauseResumeTests(unittest.TestCase):
    def test_pause_sets_capture_paused_without_listener(self):
        import threading

        lst = mock.Mock()
        sess = _session(_listener=lst, _listen_wanted=True, _workspace="interview")
        sess._listen_mu = threading.RLock()
        sess.pause_listen()
        self.assertTrue(sess._paused)
        self.assertIsNone(sess._listener)
        self.assertEqual(_phases(sess)[-1]["capture"], "paused")

    def test_resume_without_wanted_listen_goes_off(self):
        sess = _session(_paused=True, _listen_wanted=False)
        sess.resume_listen()
        self.assertFalse(sess._paused)
        self.assertEqual(_phases(sess)[-1]["capture"], "off")

    def test_pause_listen_noop_when_nothing_to_pause(self):
        sess = _session()  # no listener, no manual
        sess.pause_listen()
        self.assertFalse(sess._paused)
        # No run/phase emitted; only a status hint.
        self.assertEqual([e["type"] for e in sess.emit.events], ["status"])

    def test_start_stop_listen_clear_pause_latch(self):
        sess = _session(_paused=True, _listener=None, _manual=False)
        sess._offer_save_history = mock.Mock()
        sess.stop_listen()
        self.assertFalse(sess._paused)

        taken = _session(_paused=True, _listener=None, _manual=False, _workspace="interview")
        taken._cancel_interview_wait_timer = mock.Mock()
        taken._flush_interview_wait = mock.Mock()
        taken._cancel_stt_restart_timer = mock.Mock()
        taken._flush_cloud_archive = mock.Mock()
        taken._offer_save_history = mock.Mock()
        taken._on_listen_taken()
        self.assertFalse(taken._paused)


if __name__ == "__main__":
    unittest.main()
