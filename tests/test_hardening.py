import logging
import time
import unittest

from starlette.testclient import TestClient

from server.headers import origin_allowed
from server.mailer import send_reset_email
from server.ratelimit import allow
from server.app import (
    _STT_AUTO_LANGS,
    _join_speech_frags,
    _meeting_should_hold,
    _same_speech_script,
    assemblyai_ws_url,
    clean_transcript,
    split_code_switched,
)
from server.settings import DAILY_STT_SECONDS


class OriginLockTests(unittest.TestCase):
    def test_require_cloudflare_without_secret_is_closed(self):
        scope = {
            "path": "/",
            "scheme": "http",
            "headers": [(b"cf-ray", b"forged-SFO")],
        }
        import os

        os.environ["REQUIRE_CLOUDFLARE"] = "1"
        os.environ.pop("ORIGIN_SECRET", None)
        self.addCleanup(lambda: os.environ.pop("REQUIRE_CLOUDFLARE", None))
        self.assertFalse(origin_allowed(scope))
        self.assertTrue(origin_allowed({"path": "/api/health", "headers": []}))


class TranscriptKeepTests(unittest.TestCase):
    def test_meeting_keeps_short_fillers(self):
        text, reason = clean_transcript("好的", keep_fillers=True)
        self.assertEqual(text, "好的")
        self.assertEqual(reason, "")
        dropped, why = clean_transcript("好的", keep_fillers=False)
        self.assertEqual(dropped, "")
        self.assertEqual(why, "social phrase")

    def test_meeting_does_not_hold_normal_lines(self):
        self.assertFalse(_meeting_should_hold("我们今天下午三点开会"))
        self.assertTrue(_meeting_should_hold("那个"))

    def test_does_not_glue_english_onto_chinese(self):
        self.assertFalse(_same_speech_script("所以你可以不用谈论它了。", "That's a last-minute notification."))
        self.assertEqual(
            _join_speech_frags("所以你可以不用谈论它了。", "That's a last-minute notification."),
            "所以你可以不用谈论它了。",
        )

    def test_splits_mixed_utterance_on_sentence_boundary(self):
        parts = split_code_switched(
            "It's a little surprise. 对，那刚刚好好David给我发了一个他新的PPT。"
        )
        self.assertEqual(len(parts), 2)
        self.assertTrue(parts[0].startswith("It's a little surprise"))
        self.assertTrue(parts[1].startswith("对"))

    def test_auto_stt_lists_english_first(self):
        self.assertEqual(_STT_AUTO_LANGS[0], "en")
        url = assemblyai_ws_url({"stt": {}})
        self.assertIn("language_codes=en", url)
        en = url.index("language_codes=en")
        zh = url.index("language_codes=zh")
        self.assertLess(en, zh)
        self.assertIn("prompt=", url)


class QuotaSettingsTests(unittest.TestCase):
    def test_daily_stt_default_is_two_hours(self):
        self.assertGreaterEqual(DAILY_STT_SECONDS, 2 * 3600)


class RateLimitTests(unittest.TestCase):
    def test_window_rejects_over_limit(self):
        key = f"test-{time.time()}"
        self.assertTrue(allow(key, 3, 60))
        self.assertTrue(allow(key, 3, 60))
        self.assertTrue(allow(key, 3, 60))
        self.assertFalse(allow(key, 3, 60))


class MailerTests(unittest.TestCase):
    def test_reset_failure_does_not_log_token(self):
        token = "super-secret-reset-token"
        with self.assertLogs("nod.mail", level="INFO") as cm:
            send_reset_email("nobody@example.com", token)
        joined = "\n".join(cm.output)
        self.assertNotIn(token, joined)
        self.assertNotIn("/reset?token=", joined)


class ApiGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from server.app import app

        cls.client = TestClient(app)

    def test_stripe_webhook_rejects_unsigned(self):
        res = self.client.post("/api/billing/webhook", content=b"{}", headers={"content-type": "application/json"})
        self.assertIn(res.status_code, (400, 503))

    def test_ws_rejects_anonymous_without_cookie(self):
        with self.client.websocket_connect("/ws") as ws:
            ws.send_text("{}")
            try:
                msg = ws.receive_json()
            except Exception:
                return
            self.assertEqual(msg.get("type"), "auth_required")


if __name__ == "__main__":
    logging.basicConfig()
    unittest.main()
