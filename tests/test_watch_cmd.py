import unittest


def watch_action(raw: object) -> str:
    """Mirror of web/src/watch.ts watchAction — only start/stop reach start_listen."""
    return raw if raw in {"start", "stop"} else ""


class WatchCommandTests(unittest.TestCase):
    def test_only_start_and_stop(self):
        self.assertEqual(watch_action("start"), "start")
        self.assertEqual(watch_action("stop"), "stop")
        self.assertEqual(watch_action("start_listen"), "")
        self.assertEqual(watch_action("clear"), "")
        self.assertEqual(watch_action(""), "")


if __name__ == "__main__":
    unittest.main()
