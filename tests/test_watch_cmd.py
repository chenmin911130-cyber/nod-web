import unittest


def watch_action(raw: object) -> str:
    """Mirror of web/src/watch.ts watchAction — session and speech actions only."""
    return raw if raw in {"start", "stop", "record", "pause", "resume", "speak", "save", "discard", "tts_live", "tts_tap", "tts_female", "tts_male"} else ""


def watch_listen_mode(raw: object) -> str:
    """Mirror of web/src/watch.ts watchListenMode — picker values only."""
    value = raw.strip().lower() if isinstance(raw, str) else ""
    return value if value in {"meeting", "lecture", "interview", "translate"} else ""


def watch_speech_should_play(source: str) -> bool:
    """Mirror of web/src/watch.ts watchSpeechShouldPlay — leftover files must stay silent."""
    return source == "live"


def watch_speech_file_should_play(at: float | None, now: float) -> bool:
    """A speech file is a live Play tap only when the timestamp is fresh."""
    if at is None:
        return False
    return now - at <= 8


def watch_pcm_should_buffer(reachable: bool) -> bool:
    return not reachable


def watch_live_stream_should_reset(*, listening: bool, reachable: bool) -> bool:
    return listening and not reachable


def watch_flush_should_send(pending_bytes: int) -> bool:
    return pending_bytes > 0


def watch_listen_control_should_apply_mode(*, action: str, session_paused: bool, run: str) -> bool:
    """Mirror of web/src/watch.ts watchListenControlShouldApplyMode."""
    if action not in {"start", "record"}:
        return False
    if session_paused:
        return False
    if action == "record" and run in {"listen", "record"}:
        return False
    return True


class WatchCommandTests(unittest.TestCase):
    def test_only_session_actions(self):
        self.assertEqual(watch_action("start"), "start")
        self.assertEqual(watch_action("stop"), "stop")
        self.assertEqual(watch_action("record"), "record")
        self.assertEqual(watch_action("pause"), "pause")
        self.assertEqual(watch_action("resume"), "resume")
        self.assertEqual(watch_action("speak"), "speak")
        self.assertEqual(watch_action("save"), "save")
        self.assertEqual(watch_action("discard"), "discard")
        self.assertEqual(watch_action("tts_live"), "tts_live")
        self.assertEqual(watch_action("tts_tap"), "tts_tap")
        self.assertEqual(watch_action("start_listen"), "")
        self.assertEqual(watch_action("clear"), "")
        self.assertEqual(watch_action(""), "")

    def test_listen_mode_is_separate_from_action(self):
        self.assertEqual(watch_listen_mode("interview"), "interview")
        self.assertEqual(watch_listen_mode("Lecture"), "lecture")
        self.assertEqual(watch_listen_mode("start"), "")
        self.assertEqual(watch_listen_mode(""), "")

    def test_mode_only_applies_on_fresh_listen_or_record(self):
        self.assertTrue(watch_listen_control_should_apply_mode(action="start", session_paused=False, run="idle"))
        self.assertTrue(watch_listen_control_should_apply_mode(action="record", session_paused=False, run="idle"))
        self.assertFalse(watch_listen_control_should_apply_mode(action="pause", session_paused=False, run="listen"))
        self.assertFalse(watch_listen_control_should_apply_mode(action="resume", session_paused=True, run="idle"))
        self.assertFalse(watch_listen_control_should_apply_mode(action="stop", session_paused=False, run="listen"))
        self.assertFalse(watch_listen_control_should_apply_mode(action="start", session_paused=True, run="idle"))
        self.assertFalse(watch_listen_control_should_apply_mode(action="record", session_paused=False, run="listen"))
        self.assertFalse(watch_listen_control_should_apply_mode(action="", session_paused=False, run="idle"))
        self.assertFalse(watch_listen_control_should_apply_mode(action="save", session_paused=False, run="idle"))
        self.assertFalse(watch_listen_control_should_apply_mode(action="discard", session_paused=False, run="idle"))

    def test_opening_watch_does_not_autoplay_leftover_speech(self):
        self.assertFalse(watch_speech_should_play("file"))
        self.assertFalse(watch_speech_should_play("context"))
        self.assertFalse(watch_speech_should_play("queued"))
        self.assertTrue(watch_speech_should_play("live"))
        self.assertFalse(watch_speech_file_should_play(None, 1000))
        self.assertFalse(watch_speech_file_should_play(880, 1000))
        self.assertTrue(watch_speech_file_should_play(995, 1000))

    def test_disconnect_flushes_unsent_pcm_without_start_listen(self):
        self.assertFalse(watch_pcm_should_buffer(True))
        self.assertTrue(watch_pcm_should_buffer(False))
        self.assertTrue(watch_live_stream_should_reset(listening=True, reachable=False))
        self.assertFalse(watch_live_stream_should_reset(listening=True, reachable=True))
        self.assertTrue(watch_flush_should_send(3200))
        self.assertFalse(watch_flush_should_send(0))


if __name__ == "__main__":
    unittest.main()
