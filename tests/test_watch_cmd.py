import unittest


def watch_action(raw: object) -> str:
    """Mirror of web/src/watch.ts watchAction — session and speech actions only."""
    return raw if raw in {"start", "stop", "record", "pause", "resume", "speak", "tts_live", "tts_tap", "tts_female", "tts_male"} else ""


class WatchCommandTests(unittest.TestCase):
    def test_only_session_actions(self):
        self.assertEqual(watch_action("start"), "start")
        self.assertEqual(watch_action("stop"), "stop")
        self.assertEqual(watch_action("record"), "record")
        self.assertEqual(watch_action("pause"), "pause")
        self.assertEqual(watch_action("resume"), "resume")
        self.assertEqual(watch_action("speak"), "speak")
        self.assertEqual(watch_action("tts_live"), "tts_live")
        self.assertEqual(watch_action("tts_tap"), "tts_tap")
        self.assertEqual(watch_action("start_listen"), "")
        self.assertEqual(watch_action("clear"), "")
        self.assertEqual(watch_action(""), "")


if __name__ == "__main__":
    unittest.main()
