import unittest


WATCH_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000


def is_fresh_watch_report(at: int, now: int) -> bool:
    return now - at >= 0 and now - at <= WATCH_REPORT_MAX_AGE_MS


def is_watch_report_scene(scene: str, mode: str) -> bool:
    if mode in {"translate", "interview"}:
        return False
    return (scene or "").lower() in {"meeting", "lecture", ""}


def should_restore_watch_report(*, mark, listening: bool, busy: bool, has_workspace: bool) -> bool:
    if not mark:
        return False
    if listening or busy or has_workspace:
        return False
    return True


def pick_watch_report_session(sessions):
    for session in sessions:
        if is_watch_report_scene(session.get("scene") or "", session.get("mode") or ""):
            return session
    return None


def _cap_transcript(lines, budget=120_000):
    """Mirror of capTranscript: keep the tail by character budget, not a fixed count."""
    chars = 0
    start = len(lines)
    for i in range(len(lines) - 1, -1, -1):
        entry = lines[i]
        text = entry.get("text") if isinstance(entry, dict) else entry
        chars += len((text or "")) + 16
        if chars > budget:
            break
        start = i
    return lines[start:]


def snapshot_from_workspace(mode: str, scene: str, notes: str, lines):
    if not is_watch_report_scene(scene, mode):
        return None
    return {
        "mode": "meeting",
        "scene": "lecture" if scene == "lecture" else "meeting",
        "notes": notes,
        "lines": _cap_transcript(lines),
    }


class WatchReportTests(unittest.TestCase):
    def test_fresh_mark_expires_after_a_day(self):
        now = 1_000_000_000_000
        self.assertTrue(is_fresh_watch_report(now - 60_000, now))
        self.assertFalse(is_fresh_watch_report(now - WATCH_REPORT_MAX_AGE_MS - 1, now))

    def test_restore_only_when_workspace_is_empty(self):
        mark = {"at": 1}
        self.assertTrue(
            should_restore_watch_report(mark=mark, listening=False, busy=False, has_workspace=False)
        )
        self.assertFalse(
            should_restore_watch_report(mark=mark, listening=True, busy=False, has_workspace=False)
        )
        self.assertFalse(
            should_restore_watch_report(mark=mark, listening=False, busy=True, has_workspace=False)
        )
        self.assertFalse(
            should_restore_watch_report(mark=mark, listening=False, busy=False, has_workspace=True)
        )
        self.assertFalse(
            should_restore_watch_report(mark=None, listening=False, busy=False, has_workspace=False)
        )

    def test_pick_skips_translate_and_interview(self):
        lecture = {"mode": "meeting", "scene": "lecture"}
        self.assertEqual(
            pick_watch_report_session(
                [
                    {"mode": "translate", "scene": "meeting"},
                    {"mode": "interview", "scene": "interview"},
                    lecture,
                ]
            ),
            lecture,
        )
        self.assertIsNone(pick_watch_report_session([{"mode": "translate", "scene": "meeting"}]))

    def test_snapshot_keeps_meeting_or_lecture_only(self):
        lines = [{"id": "1", "ts": "01:00", "text": "Hello"}]
        self.assertEqual(snapshot_from_workspace("meeting", "lecture", "Notes", lines)["scene"], "lecture")
        self.assertIsNone(snapshot_from_workspace("interview", "interview", "Notes", lines))
        self.assertIsNone(snapshot_from_workspace("translate", "meeting", "Notes", lines))


if __name__ == "__main__":
    unittest.main()
