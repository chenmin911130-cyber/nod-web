import asyncio
import logging
import time
import unittest
from unittest import mock

from starlette.testclient import TestClient

from server.headers import origin_allowed
from server.mailer import send_reset_email
from server.ratelimit import allow
from server.app import (
    ASSEMBLYAI_MODEL,
    WEB_DIST,
    Pipeline,
    _join_speech_frags,
    _meeting_should_hold,
    _same_speech_script,
    _stt_keyterms,
    assemblyai_ws_url,
    clean_transcript,
    model_allowed,
    speaker_from_turn,
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

    def test_auto_omits_language_codes(self):
        url = assemblyai_ws_url({"stt": {}})
        self.assertNotIn("language_codes=", url)
        self.assertIn("prompt=", url)

    def test_locked_language_still_sent(self):
        url = assemblyai_ws_url({"stt": {"language": "zh"}})
        self.assertIn("language_codes=zh", url)
        self.assertNotIn("language_codes=en", url)

    def test_streaming_uses_pro_model_and_keyterms(self):
        self.assertEqual(ASSEMBLYAI_MODEL, "universal-3-5-pro")
        url = assemblyai_ws_url({"stt": {"vocabulary": ["Lisinopril", "ECG"]}})
        self.assertIn("speech_model=universal-3-5-pro", url)
        self.assertIn("speech_models=universal-3-5-pro", url)
        self.assertIn("format_turns=true", url)
        self.assertIn("punctuate=true", url)
        self.assertIn("format_text=true", url)
        self.assertIn("keyterms_prompt=", url)
        self.assertNotIn("word_boost=", url)
        self.assertIn("Lisinopril", url)

    def test_chinese_commerce_keyterms_and_resume_tokens(self):
        from urllib.parse import unquote

        terms = _stt_keyterms({
            "profile": {"resume_summary": "熟悉亚马逊站外引流与联盟营销"},
        })
        for tok in ("引流", "熟悉", "影响", "站外", "联盟营销"):
            self.assertIn(tok, terms)
        url = unquote(assemblyai_ws_url({"stt": {}}))
        self.assertIn("引流", url)
        self.assertIn("熟悉", url)

    def test_meeting_enables_speaker_labels(self):
        url = assemblyai_ws_url({
            "stt": {
                "speaker_labels": True,
                "speakers_expected": 2,
                "listen_scene": "meeting",
            }
        })
        self.assertIn("speaker_labels=true", url)
        self.assertIn("max_speakers=2", url)

    def test_meeting_defaults_to_two_speakers(self):
        url = assemblyai_ws_url({
            "stt": {"speaker_labels": True, "listen_scene": "meeting"},
        })
        self.assertIn("max_speakers=2", url)

    def test_pending_turn_uses_word_majority(self):
        self.assertEqual(
            speaker_from_turn({
                "speaker_label": "PENDING",
                "words": [
                    {"text": "then", "speaker": "A", "word_is_final": True},
                    {"text": "what", "speaker": "A", "word_is_final": True},
                    {"text": "about", "speaker": "B", "word_is_final": True},
                ],
            }),
            "A",
        )
        self.assertIsNone(speaker_from_turn({"speaker_label": "PENDING", "words": []}))


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


def _raw_get(path: str) -> tuple[int | None, bytes]:
    """Drive the ASGI app with a hand-built scope.

    HTTP clients normalise dot segments before they hit the wire, but ASGI
    servers hand the unquoted path straight to the app, so this is the only way
    to reproduce what an attacker sends with curl --path-as-is.
    """
    from server.app import app

    body = bytearray()
    status: dict[str, int] = {}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(msg):
        if msg["type"] == "http.response.start":
            status["code"] = msg["status"]
        elif msg["type"] == "http.response.body":
            body.extend(msg.get("body") or b"")

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.1"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"host", b"127.0.0.1")],
        "client": ("1.2.3.4", 5555),
        "server": ("127.0.0.1", 80),
    }
    asyncio.run(app(scope, receive, send))
    return status.get("code"), bytes(body)


@unittest.skipUnless(WEB_DIST.exists(), "frontend build required for the SPA catch-all route")
class StaticTraversalTests(unittest.TestCase):
    def test_dot_segments_cannot_escape_web_dist(self):
        # WEB_DIST is <repo>/web/dist, so escaping to the repo root takes two
        # levels; anything less lands on a path that never existed anyway.
        for path in (
            "/../../requirements.txt",
            "/a/../../../requirements.txt",
            "/../../data/nod.db",
            "/../../data/auth_secret.key",
        ):
            with self.subTest(path=path):
                _, body = _raw_get(path)
                self.assertNotIn(b"fastapi==", body)
                self.assertNotIn(b"SQLite format", body)
                self.assertIn(b"<", body)  # fell through to index.html

    def test_real_asset_still_served(self):
        code, body = _raw_get("/index.html")
        self.assertEqual(code, 200)
        self.assertTrue(body)


class AdminTokenTests(unittest.TestCase):
    def test_unset_env_leaves_admin_token_empty(self):
        """No fallback in code: an unconfigured deployment gets no admin token.

        Set (not removed) to an empty value so the .env loader, which only
        fills keys that are absent, cannot put a developer's local token back.
        """
        import importlib
        import os

        from server import settings

        with mock.patch.dict(os.environ, {"ADMIN_TOKEN": ""}):
            reloaded = importlib.reload(settings)
            try:
                self.assertEqual(reloaded.ADMIN_TOKEN, "")
            finally:
                importlib.reload(settings)

    def test_login_disabled_when_token_unset(self):
        from server.app import app

        with mock.patch("server.settings.ADMIN_TOKEN", ""):
            client = TestClient(app)
            res = client.post("/api/admin/login", json={"token": "leonardo"})
            self.assertEqual(res.status_code, 503)

    def test_protected_route_closed_when_token_unset(self):
        from server.app import app

        with mock.patch("server.settings.ADMIN_TOKEN", ""):
            client = TestClient(app)
            res = client.get("/api/admin/overview", headers={"X-Admin-Token": "leonardo"})
            self.assertEqual(res.status_code, 503)

    def test_wrong_token_rejected(self):
        from server import ratelimit
        from server.app import app

        ratelimit._hits.clear()
        with mock.patch("server.settings.ADMIN_TOKEN", "configured-token"):
            client = TestClient(app)
            res = client.post("/api/admin/login", json={"token": "leonardo"})
            self.assertEqual(res.status_code, 401)
            ok = client.post("/api/admin/login", json={"token": "configured-token"})
            self.assertEqual(ok.status_code, 200)

    def test_login_is_rate_limited(self):
        from server import ratelimit
        from server.app import app

        ratelimit._hits.clear()
        with mock.patch("server.settings.ADMIN_TOKEN", "configured-token"):
            client = TestClient(app)
            codes = [client.post("/api/admin/login", json={"token": "guess"}).status_code for _ in range(8)]
        self.assertIn(429, codes, f"brute force was never throttled: {codes}")
        self.assertEqual(codes[0], 401)


class ModelWhitelistTests(unittest.TestCase):
    cfg = {
        "llm": {"provider": "deepseek", "model": "deepseek-v4-flash"},
        "models": [{"provider": "deepseek", "model": "deepseek-v4-pro"}],
    }

    def test_listed_models_allowed(self):
        self.assertTrue(model_allowed(self.cfg, "deepseek", "deepseek-v4-pro"))
        self.assertTrue(model_allowed(self.cfg, "deepseek", "deepseek-v4-flash"))

    def test_arbitrary_model_rejected(self):
        self.assertFalse(model_allowed(self.cfg, "openrouter", "openai/o3-pro"))
        self.assertFalse(model_allowed(self.cfg, "deepseek", ""))
        self.assertFalse(model_allowed(self.cfg, "made-up-provider", "deepseek-v4-pro"))


class RateLimitTableTests(unittest.TestCase):
    def test_stale_keys_are_swept(self):
        from server import ratelimit

        with mock.patch.object(ratelimit, "_STALE_AFTER", 0.0), mock.patch.object(ratelimit, "_SWEEP_EVERY", 0.0):
            ratelimit.allow(f"sweep-a-{time.time()}", 5, 60)
            before = len(ratelimit._hits)
            ratelimit.allow(f"sweep-b-{time.time()}", 5, 60)
            self.assertLessEqual(len(ratelimit._hits), before + 1)


class ListenAskRoutingTests(unittest.TestCase):
    def test_listen_ask_emits_question_so_cards_can_bind(self):
        events: list[dict] = []
        pipe = Pipeline.__new__(Pipeline)
        pipe.cfg = {"llm": {"provider": "deepseek", "model": "deepseek-v4-flash", "max_tokens": 80}}
        pipe.emit = events.append
        pipe._provider = "deepseek"
        pipe._model = "deepseek-v4-flash"
        pipe.client = mock.Mock()
        pipe.client.chat.completions.create.return_value = []
        pipe._qa_history = []
        pipe._last_answer = ""
        pipe._cancel = __import__("threading").Event()
        pipe._gen_seq = 0
        pipe.user_id = None
        pipe.usage_session_id = None
        pipe._heard_lang = None

        pipe.process_text("[NOD_ASK:zh]\nListener question: 找到这个联盟营销的网站", "listen_ask")
        question = next(e for e in events if e.get("type") == "question")
        self.assertTrue(question["id"])
        self.assertTrue(question["text"].startswith("[NOD_ASK"))

    def test_cancelled_generation_still_emits_done(self):
        events: list[dict] = []
        pipe = Pipeline.__new__(Pipeline)
        pipe.cfg = {"llm": {"provider": "deepseek", "model": "deepseek-v4-flash", "max_tokens": 80}}
        pipe.emit = events.append
        pipe._provider = "deepseek"
        pipe._model = "deepseek-v4-flash"
        pipe._qa_history = []
        pipe._last_answer = ""
        pipe._cancel = __import__("threading").Event()
        pipe._gen_seq = 0
        pipe.user_id = None
        pipe.usage_session_id = None
        pipe._heard_lang = None

        class _Delta:
            content = "Beijing"
            reasoning_content = None

        class _Choice:
            delta = _Delta()

        class _Chunk:
            choices = [_Choice()]

        def stream():
            pipe._cancel.set()
            yield _Chunk()

        pipe.client = mock.Mock()
        pipe.client.chat.completions.create.return_value = stream()
        pipe.process_text("Where is the capital of China?", "ask")
        self.assertTrue(any(e.get("type") == "done" and e.get("ok") is False for e in events))
        self.assertFalse(any(e.get("type") == "chunk" for e in events))

    def test_translate_prompt_allows_italian(self):
        pipe = Pipeline.__new__(Pipeline)
        pipe.cfg = {"llm": {}}
        messages = pipe._build_messages(
            "Translate to Italian.\nSource language: English.\nTranslate only this line:\nHello there",
            "translate",
        )
        sys_msg = messages[0]["content"]
        self.assertNotIn("that is not Chinese, English, or Japanese", sys_msg)
        self.assertIn("Italian", sys_msg)
        self.assertIn("requested target language", sys_msg)


class MailerEscapeTests(unittest.TestCase):
    def test_feedback_html_is_escaped(self):
        from server import mailer

        sent: dict[str, str] = {}

        def fake_send(to, subject, html, text):
            sent["html"] = html
            return True

        with mock.patch.object(mailer, "send_mail", fake_send):
            mailer.send_feedback_copy("admin@example.com", "a@b.co", "<img src=x onerror=alert(1)>")
        self.assertNotIn("<img", sent["html"])
        self.assertIn("&lt;img", sent["html"])


if __name__ == "__main__":
    logging.basicConfig()
    unittest.main()
