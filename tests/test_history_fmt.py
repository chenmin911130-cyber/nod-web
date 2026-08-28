import unittest
from datetime import datetime, timezone

from server.history_fmt import normalize_scene, session_copy_text, session_download_name


class HistoryFormatTests(unittest.TestCase):
    def test_download_name_matches_scene(self):
        started = datetime(2026, 8, 28, 10, 15, tzinfo=timezone.utc)
        self.assertEqual(session_download_name("meeting", "lecture", started), "Lecture-2026-08-28.wav")
        self.assertEqual(
            session_download_name("meeting", "lecture", started, part_name="part-002.wav"),
            "Lecture-2026-08-28-part2.wav",
        )
        self.assertEqual(session_download_name("interview", "", started), "Interview-2026-08-28.wav")
        self.assertEqual(
            session_download_name("meeting", "meeting", started, kind="notes"),
            "Meeting-2026-08-28-notes.txt",
        )

    def test_copy_text_includes_session_body(self):
        text = session_copy_text(
            "Standup",
            "meeting",
            "meeting",
            [
                {"kind": "transcript", "text": "Let's ship Friday."},
                {"kind": "question", "text": "What is the date?"},
                {"kind": "answer", "text": "Friday."},
            ],
        )
        self.assertIn("Standup", text)
        self.assertIn("Meeting", text)
        self.assertIn("Let's ship Friday.", text)
        self.assertIn("Friday.", text)

    def test_normalize_scene(self):
        self.assertEqual(normalize_scene("interview", "meeting"), "interview")
        self.assertEqual(normalize_scene("meeting", "lecture"), "lecture")
        self.assertEqual(normalize_scene("meeting", ""), "meeting")
