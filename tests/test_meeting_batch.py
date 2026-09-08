"""Meeting / Lecture buffer PCM during listen and file-transcribe on stop."""
from __future__ import annotations

import time
import unittest
from unittest import mock

from server.app import (
    MANUAL_MIN_SEC,
    SR,
    Session,
    _reset_live_stt,
    _tick_live_idle_watches,
    assemblyai_prerecorded_body,
    meeting_lines_from_file,
)
from server.settings import LISTEN_ZERO_PCM_SECONDS


def _pcm(seconds: float = 0.5, voiced: bool = True) -> bytes:
    sample = b"\x00\x40" if voiced else b"\x00\x00"
    return sample * int(SR * seconds)


class ImmediateThread:
    def __init__(self, target=None, args=(), kwargs=None, daemon=None, name=None):
        self._target = target
        self._args = args or ()
        self._kwargs = kwargs or {}

    def start(self) -> None:
        if self._target:
            self._target(*self._args, **self._kwargs)

    def join(self, timeout=None) -> None:
        return


class MeetingBatchListenTests(unittest.TestCase):
    def setUp(self) -> None:
        _reset_live_stt()

    def tearDown(self) -> None:
        _reset_live_stt()

    def _session(self, workspace: str = "meeting") -> tuple[Session, list]:
        events: list = []
        sess = Session(
            events.append,
            {"llm": {"provider": "deepseek", "model": "x"}, "stt": {}},
            {"ASSEMBLYAI_API_KEY": "k", "DEEPSEEK_API_KEY": "k"},
        )
        sess.set_workspace(workspace, "lecture" if workspace == "meeting" else None)
        sess._ensure_consent = lambda: True  # type: ignore[method-assign]
        sess._ensure_usage = lambda: True  # type: ignore[method-assign]
        sess._archive_append = lambda pcm: None  # type: ignore[method-assign]
        sess.pipeline.repair_caption = lambda src, recent=None: src
        return sess, events

    def test_meeting_lines_from_file_uses_utterances_then_sentences(self) -> None:
        self.assertEqual(
            meeting_lines_from_file(
                "ignored",
                [("Hello there.", "A"), ("We should ship Friday.", "B")],
            ),
            [("Hello there.", "A"), ("We should ship Friday.", "B")],
        )
        self.assertEqual(
            meeting_lines_from_file("Hello there. We should ship Friday."),
            [("Hello there.", None), ("We should ship Friday.", None)],
        )

    def test_prerecorded_body_includes_speaker_labels_for_meeting(self) -> None:
        body = assemblyai_prerecorded_body(
            {"stt": {"speaker_labels": True, "speakers_expected": 2}},
            "https://example/a.wav",
        )
        self.assertTrue(body["speaker_labels"])
        self.assertEqual(body["speakers_expected"], 2)

    def test_meeting_start_listen_does_not_open_cloud_listener(self) -> None:
        sess, events = self._session("meeting")
        with mock.patch("server.app.CloudListener") as cloud:
            sess.start_listen()
        cloud.assert_not_called()
        self.assertTrue(sess._batch_listen)
        self.assertEqual(sess._capture(), "listening")
        sess.push_pcm(_pcm())
        self.assertFalse(any(ev.get("type") == "question" for ev in events))

    def test_translate_start_listen_still_opens_cloud_listener(self) -> None:
        sess, _ = self._session("translate")
        lst = mock.Mock()
        with mock.patch("server.app.CloudListener", return_value=lst) as cloud:
            sess.start_listen()
        cloud.assert_called_once()
        lst.start.assert_called_once()
        self.assertFalse(getattr(sess, "_batch_listen", False))
        self.assertIs(sess._listener, lst)

    def test_stop_transcribes_once_pause_does_not(self) -> None:
        sess, events = self._session("meeting")
        transcribe = mock.Mock(return_value=("We should ship Friday.", "en", []))
        sess._transcribe_batch_pcm = transcribe  # type: ignore[method-assign]
        sess.start_listen()
        sess.push_pcm(_pcm(0.5))
        with mock.patch("server.app.threading.Thread", ImmediateThread):
            sess.pause_listen()
        transcribe.assert_not_called()
        self.assertEqual(sess._capture(), "paused")
        sess.resume_listen()
        self.assertEqual(sess._capture(), "listening")
        self.assertTrue(sess._batch_listen)
        with mock.patch("server.app.threading.Thread", ImmediateThread):
            sess.stop_listen()
        transcribe.assert_called_once()
        questions = [ev for ev in events if ev.get("type") == "question"]
        self.assertGreaterEqual(len(questions), 1)
        self.assertEqual(sess._engine, "idle")
        self.assertEqual(sess._capture(), "off")

    def test_batch_pcm_does_not_meter_until_stop(self) -> None:
        sess, _ = self._session("meeting")
        sess.user_id = "u1"
        sess.usage_session_id = "s1"
        sess._consent_ok = True
        sess._transcribe_batch_pcm = mock.Mock(return_value=("Hello there.", "en", []))  # type: ignore[method-assign]
        consume = mock.Mock(return_value=(True, {"ok": True}))
        sess.start_listen()
        with mock.patch("server.meter.consume_stt", consume):
            sess.push_pcm(_pcm(0.5))
            consume.assert_not_called()
            with mock.patch("server.app.threading.Thread", ImmediateThread):
                with mock.patch("server.meter.save_history"):
                    with mock.patch("server.meter.is_session_kept", return_value=False):
                        sess.stop_listen()
        consume.assert_called_once()
        seconds = consume.call_args[0][1]
        self.assertGreaterEqual(seconds, MANUAL_MIN_SEC)

    def test_transcribing_skips_zero_pcm_stop(self) -> None:
        sess, _ = self._session("meeting")
        sess._batch_listen = False
        sess._listener = None
        sess._listen_wanted = False
        sess._engine = "transcribing"
        sess._paused = False
        sess._idle_check_at = 0.0
        sess._listen_started_at = time.time()
        sess._last_voice_at = time.time()
        sess._last_pcm_at = time.time() - LISTEN_ZERO_PCM_SECONDS - 5
        sess._stop_batch_listen = mock.Mock()  # type: ignore[method-assign]
        sess._stop_listening = mock.Mock()  # type: ignore[method-assign]
        sess._maybe_stop_forgotten_listen()
        sess._stop_batch_listen.assert_not_called()
        sess._stop_listening.assert_not_called()

    def test_idle_watch_ticks_batch_sessions(self) -> None:
        sess, _ = self._session("meeting")
        sess.start_listen()
        sess._idle_check_at = 0.0
        sess._last_pcm_at = time.time() - LISTEN_ZERO_PCM_SECONDS - 5
        sess._last_voice_at = time.time()
        sess._stop_batch_listen = mock.Mock()  # type: ignore[method-assign]
        _tick_live_idle_watches()
        sess._stop_batch_listen.assert_called_once()
