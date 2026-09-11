import unittest
from datetime import datetime, timezone

from server.history_fmt import (
    normalize_scene,
    scene_label,
    session_copy_text,
    session_download_name,
    sources_lines,
)


class HistoryFormatTests(unittest.TestCase):
    def test_download_name_matches_scene(self):
        started = datetime(2026, 8, 28, 10, 15, tzinfo=timezone.utc)
        self.assertEqual(session_download_name("meeting", "lecture", started), "Nodpilot-Lecture-2026-08-28.wav")
        self.assertEqual(
            session_download_name("meeting", "lecture", started, part_name="part-002.wav"),
            "Nodpilot-Lecture-2026-08-28-part2.wav",
        )
        self.assertEqual(session_download_name("interview", "", started), "Nodpilot-Live-QA-2026-08-28.wav")
        self.assertEqual(
            session_download_name("meeting", "meeting", started, kind="notes"),
            "Nodpilot-Meeting-2026-08-28.pdf",
        )
        self.assertEqual(
            session_download_name("meeting", "lecture", started, kind="pdf"),
            "Nodpilot-Lecture-2026-08-28.pdf",
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
        self.assertEqual(scene_label("interview"), "Live Q&A")


class ThinkSourcesExportTests(unittest.TestCase):
    """#182: the sources block a saved Think answer keeps."""

    def test_real_sources_are_exported_with_their_dates_and_the_retrieval_time(self):
        lines = sources_lines(
            {
                "status": "ok",
                "retrieved_at_text": "2026-09-10 04:00 UTC",
                "results": [
                    {"title": "Apple News", "url": "https://example.com/apple", "published_at": "2026-09-10"},
                    {"title": "Other", "url": "https://example.com/other", "published_at": None},
                ],
                "note": "",
            }
        )
        self.assertEqual(
            lines,
            [
                "[1] Apple News（发布时间 2026-09-10）",
                "    https://example.com/apple",
                "[2] Other",
                "    https://example.com/other",
                "检索时间：2026-09-10 04:00 UTC",
            ],
        )

    def test_an_old_record_exports_nothing(self):
        self.assertEqual(sources_lines(None), [])
        self.assertEqual(sources_lines({}), [])
        self.assertEqual(sources_lines({"results": []}), [])

    def test_only_safe_links_are_exported(self):
        lines = sources_lines(
            {"results": [{"title": "bad", "url": "javascript:alert(1)", "published_at": None}, "junk"]}
        )
        self.assertEqual(lines, [], "an unsafe or malformed entry is never written out")

    def test_a_failed_lookup_exports_its_honest_note_and_no_fake_source(self):
        lines = sources_lines({"status": "failed", "results": [], "note": "联网检索失败（TimeoutError）"})
        self.assertEqual(lines, ["联网检索失败（TimeoutError）"])
