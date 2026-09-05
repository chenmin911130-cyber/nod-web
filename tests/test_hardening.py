import asyncio
import logging
import time
import unittest
from unittest import mock

from starlette.testclient import TestClient

from server.headers import origin_allowed
from server.mailer import send_otp_email, send_reset_email
from server.ratelimit import allow
from server.app import (
    ASSEMBLYAI_FILE_MODELS,
    ASSEMBLYAI_MODEL,
    MANUAL_MAX_SEC,
    WEB_DIST,
    manual_chunk_ready,
    Pipeline,
    Session,
    _join_speech_frags,
    _meeting_should_hold,
    _same_speech_script,
    _stt_context_terms,
    _stt_keyterms,
    _stt_prompt,
    apply_caption_repair,
    assemblyai_prerecorded_body,
    assemblyai_ws_url,
    clean_transcript,
    guard_question,
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

    def test_prerecorded_uses_file_models_and_detects_language(self):
        body = assemblyai_prerecorded_body({"stt": {"vocabulary": ["Lisinopril"]}}, "https://example/a.wav")
        self.assertEqual(body["speech_models"], ASSEMBLYAI_FILE_MODELS)
        self.assertTrue(body["language_detection"])
        self.assertNotIn("language_code", body)
        self.assertNotIn("speech_model", body)
        self.assertTrue(body["punctuate"])
        self.assertIn("Lisinopril", body["keyterms_prompt"])
        self.assertTrue(body["prompt"])

    def test_prerecorded_locks_language_when_set(self):
        body = assemblyai_prerecorded_body({"stt": {"language": "zh"}}, "https://example/a.wav")
        self.assertEqual(body["language_code"], "zh")
        self.assertNotIn("language_detection", body)

    def test_accurate_stt_uploads_and_polls_completed_text(self):
        from server.app import assemblyai_transcribe_accurate

        upload = mock.Mock()
        upload.raise_for_status.return_value = None
        upload.json.return_value = {"upload_url": "https://example/up.wav"}
        created = mock.Mock()
        created.raise_for_status.return_value = None
        created.json.return_value = {"id": "tr_1"}
        done = mock.Mock()
        done.raise_for_status.return_value = None
        done.json.return_value = {"status": "completed", "text": "Hello from file STT.", "language_code": "en"}
        client = mock.Mock()
        client.post.side_effect = [upload, created]
        client.get.return_value = done
        client.__enter__ = mock.Mock(return_value=client)
        client.__exit__ = mock.Mock(return_value=False)
        with mock.patch("server.app.httpx.Client", return_value=client):
            text, lang = assemblyai_transcribe_accurate("key", b"\x00\x00" * 1600, {"stt": {}})
        self.assertEqual(text, "Hello from file STT.")
        self.assertEqual(lang, "en")
        self.assertEqual(client.post.call_count, 2)
        self.assertIn("/v2/upload", client.post.call_args_list[0].args[0])
        self.assertIn("/v2/transcript", client.post.call_args_list[1].args[0])

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

    def test_record_uses_the_same_max_as_listen(self):
        from server.settings import LISTEN_MAX_SECONDS

        self.assertEqual(MANUAL_MAX_SEC, float(LISTEN_MAX_SECONDS))
        self.assertGreaterEqual(MANUAL_MAX_SEC, 2 * 3600)

    def test_record_chunks_on_pause_or_max_length(self):
        self.assertFalse(manual_chunk_ready(1.0, 1.0))
        self.assertFalse(manual_chunk_ready(3.0, 0.1))
        self.assertTrue(manual_chunk_ready(3.0, 0.7))
        self.assertTrue(manual_chunk_ready(10.0, 0.0))
        self.assertFalse(manual_chunk_ready(0.2, 2.0, force=True))
        self.assertTrue(manual_chunk_ready(0.5, 0.0, force=True))

    def test_stt_context_keeps_names_and_prompt(self):
        terms = _stt_context_terms([
            "David sent the Nodpilot deck.",
            "David will walk through Nodpilot after lunch.",
        ])
        self.assertIn("David", terms)
        self.assertIn("Nodpilot", terms)
        prompt = _stt_prompt({
            "stt": {
                "listen_scene": "meeting",
                "context_prompt": "David sent the Nodpilot deck.",
            }
        })
        self.assertIn("Recent names and topic", prompt)
        self.assertIn("Nodpilot", prompt)

    def test_recording_stays_record_after_translate(self):
        sess = Session.__new__(Session)
        sess._manual = True
        sess._listener = None
        self.assertEqual(sess._capture(), "recording")
        sess._manual = False
        self.assertEqual(sess._capture(), "off")
        sess._listener = object()
        self.assertEqual(sess._capture(), "listening")

    def test_caption_repair_keeps_wild_rewrites_out(self):
        src = "David will walk through Nodpilot after lunch."
        self.assertEqual(apply_caption_repair(src, "Let's summarize the whole meeting instead."), src)
        self.assertEqual(
            apply_caption_repair("David sent the PPT.", "David sent the PPT."),
            "David sent the PPT.",
        )
        self.assertEqual(
            apply_caption_repair("Daved sent the PPT.", "David sent the PPT."),
            "David sent the PPT.",
        )


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

    def test_otp_failure_does_not_log_code(self):
        with mock.patch("server.mailer.send_mail", return_value=False):
            with self.assertLogs("nod.mail", level="INFO") as cm:
                send_otp_email("nobody@example.com", "654321")
        joined = "\n".join(cm.output)
        self.assertNotIn("654321", joined)


class ApiGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from server.app import app

        cls.client = TestClient(app)

    def test_stripe_webhook_rejects_unsigned(self):
        res = self.client.post("/api/billing/webhook", content=b"{}", headers={"content-type": "application/json"})
        self.assertIn(res.status_code, (400, 503))

    def test_stripe_webhook_duplicate_event_is_ignored(self):
        from server.db import StripeEvent, User, db_session
        from server.security import new_id

        uid = new_id()
        with db_session() as db:
            db.add(User(id=uid, email=f"{uid}@test.local", password_hash="", plan="free"))
        payload = {
            "id": f"evt_{uid}",
            "type": "customer.subscription.updated",
            "data": {"object": {"status": "active", "metadata": {"nod_user": uid}}},
        }
        with (
            mock.patch("server.commerce.STRIPE_SECRET_KEY", "sk_test"),
            mock.patch("server.commerce.STRIPE_WEBHOOK_SECRET", "whsec_test"),
            mock.patch("stripe.Webhook.construct_event", return_value=payload),
        ):
            first = self.client.post(
                "/api/billing/webhook",
                content=b"{}",
                headers={"stripe-signature": "t", "content-type": "application/json"},
            )
            second = self.client.post(
                "/api/billing/webhook",
                content=b"{}",
                headers={"stripe-signature": "t", "content-type": "application/json"},
            )
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        with db_session() as db:
            self.assertEqual(db.get(User, uid).plan, "pro")
            self.assertEqual(db.query(StripeEvent).filter(StripeEvent.id == payload["id"]).count(), 1)

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
        "client": ("127.0.0.1", 5555),
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


class InterviewQuestionGuardTests(unittest.TestCase):
    def test_chinese_spoken_prompt_is_accepted(self):
        self.assertEqual(guard_question("告诉我当下经济啊。", []), "accept")
        self.assertEqual(guard_question("为什么", []), "accept")
        self.assertEqual(guard_question("介绍一下你自己", []), "accept")
        self.assertEqual(guard_question("What is OOP?", []), "accept")

    def test_short_chinese_wh_and_a_not_a_are_accepted(self):
        self.assertEqual(guard_question("你是谁", []), "accept")
        self.assertEqual(guard_question("啥意思", []), "accept")
        self.assertEqual(guard_question("谁负责", []), "accept")
        self.assertEqual(guard_question("是不是", []), "accept")
        self.assertEqual(guard_question("有没有", []), "accept")
        self.assertEqual(guard_question("多少钱", []), "accept")

    def test_traditional_chinese_question_cues_are_accepted(self):
        self.assertEqual(guard_question("為什麼", []), "accept")
        self.assertEqual(guard_question("加班嗎", []), "accept")
        self.assertEqual(guard_question("你是誰", []), "accept")
        self.assertEqual(guard_question("告訴我當下經濟啊。", []), "accept")

    def test_japanese_question_cue_is_accepted(self):
        self.assertEqual(guard_question("なぜ", []), "accept")

    def test_fillers_and_non_questions_still_rejected(self):
        self.assertEqual(guard_question("嗯", []), "reject")
        self.assertEqual(guard_question("okay", []), "reject")
        self.assertEqual(guard_question("嗯，不行。", []), "reject")

    def test_short_chinese_statement_waits_instead_of_dropping(self):
        self.assertEqual(guard_question("当下经济情况", []), "wait")

    def test_restated_chinese_question_in_answer_is_not_echo(self):
        # Answers often repeat the question. 15 Han chars is a whole prompt,
        # not the 15-letter English phrase the old gate was tuned for.
        question = "请你详细说明一下当前的经济形势"
        answer = "好的，请你详细说明一下当前的经济形势，我认为增长放缓，出口还行。"
        self.assertEqual(guard_question(question, [], answer), "accept")

    def test_english_answer_substring_is_still_echo(self):
        spoken = "what is your experience"
        answer = "Sure. what is your experience — I would start with Python and APIs."
        self.assertEqual(guard_question(spoken, [], answer), "reject")

    def test_subtitle_word_is_not_a_hallucination(self):
        text, reason = clean_transcript("这个片子没有字幕")
        self.assertEqual(text, "这个片子没有字幕")
        self.assertEqual(reason, "")
        dropped, why = clean_transcript("謝謝收看")
        self.assertEqual(dropped, "")
        self.assertEqual(why, "hallucination")


class InterviewWaitFlushTests(unittest.TestCase):
    def _session(self) -> Session:
        sess = Session.__new__(Session)
        sess.cfg = {"stt": {}, "ui": {}, "llm": {}}
        sess._workspace = "interview"
        sess._listener = object()
        sess._manual = False
        sess._busy = False
        sess._busy_lock = __import__("threading").Lock()
        sess._pending = None
        sess._pending_wait = (None, 0.0, None)
        sess._pending_asks = []
        sess._pending_speaker = None
        sess._recent_finals = []
        sess._follow_lang = None
        sess._follow_switch_lang = None
        sess._follow_switch_hits = 0
        sess._last_voice_at = 0.0
        sess._interview_wait_timer = None
        sess._meeting_flush_timer = None
        sess._meeting_lock = __import__("threading").Lock()
        sess.emit = mock.Mock()
        sess.pipeline = mock.Mock()
        sess.pipeline._qa_history = []
        sess.pipeline._last_answer = ""
        sess.pipeline._cancel = __import__("threading").Event()
        sess.pipeline.process_text = mock.Mock()
        return sess

    def test_chinese_question_starts_answer(self):
        sess = self._session()
        sess._on_final("告诉我当下经济啊。", "zh")
        for _ in range(40):
            if sess.pipeline.process_text.called:
                break
            time.sleep(0.05)
        sess.pipeline.process_text.assert_called_once()
        args, _kwargs = sess.pipeline.process_text.call_args
        self.assertEqual(args[0], "告诉我当下经济啊。")

    def test_reject_clears_partial_so_ui_does_not_stick(self):
        sess = self._session()
        sess._on_final("嗯，不行。", "zh")
        sess.emit.assert_any_call({"type": "partial", "text": ""})
        sess.pipeline.process_text.assert_not_called()

    def test_social_filler_clears_partial_before_guard(self):
        sess = self._session()
        sess._on_final("嗯", "zh")
        sess.emit.assert_any_call({"type": "partial", "text": ""})
        sess.pipeline.process_text.assert_not_called()

    def test_wait_keeps_partial_so_mic_is_visible(self):
        sess = self._session()
        sess._on_final("当下经济", "zh")
        sess.emit.assert_any_call({"type": "partial", "text": "当下经济"})
        sess.pipeline.process_text.assert_not_called()

    def test_wait_join_does_not_insert_space_between_chinese(self):
        sess = self._session()
        sess._pending_wait = ("当下", time.time(), "zh")
        sess._on_final("经济情况", "zh")
        self.assertEqual(sess._pending_wait[0], "当下经济情况")

    def test_wait_flush_starts_answer(self):
        sess = self._session()
        sess._pending_wait = ("当下经济情况", time.time(), "zh")
        sess._flush_interview_wait()
        self.assertEqual(sess._pending_wait, (None, 0.0, None))
        for _ in range(40):
            if sess.pipeline.process_text.called:
                break
            time.sleep(0.05)
        sess.pipeline.process_text.assert_called_once()
        args, _kwargs = sess.pipeline.process_text.call_args
        self.assertEqual(args[0], "当下经济情况")
        self.assertEqual(args[1], "ask")

    def test_answer_cleanup_releases_busy_and_emits_phase(self):
        # The finally block in work() is the only thing that unsticks the UI.
        # If it raises on its first line, busy stays held and no phase ships.
        sess = self._session()
        sess._on_final("告诉我当下经济啊。", "zh")
        for _ in range(60):
            if not sess._busy and sess.emit.call_args_list:
                break
            time.sleep(0.05)
        self.assertFalse(sess._busy, "busy stayed held; next question would be dropped")
        phases = [
            c.args[0]
            for c in sess.emit.call_args_list
            if c.args and c.args[0].get("type") == "phase"
        ]
        self.assertIn("listening", [p.get("capture") for p in phases], f"no terminal phase emitted, got {phases}")

    def test_answer_cleanup_runs_queued_ask(self):
        sess = self._session()
        sess._pending_asks = [("summarize me", "summary", None)]
        sess.ask = mock.Mock()
        sess._on_final("告诉我当下经济啊。", "zh")
        for _ in range(60):
            if sess.ask.called:
                break
            time.sleep(0.05)
        sess.ask.assert_called_once_with("summarize me", None, "summary")

    def test_meeting_hold_flush_does_not_emit_after_leaving_meeting(self):
        sess = self._session()
        sess._workspace = "translate"
        sess._pending_wait = ("那个", time.time(), "zh")
        sess._emit_meeting_line = mock.Mock()
        sess._flush_meeting_hold()
        sess._emit_meeting_line.assert_not_called()
        self.assertEqual(sess._pending_wait, (None, 0.0, None))

    def test_translate_stt_prompt_is_not_interview(self):
        sess = self._session()
        sess._workspace = "translate"
        sess.cfg = {"stt": {"listen_scene": "interview"}, "ui": {}, "llm": {}}
        prompt = _stt_prompt(sess._stt_cfg())
        self.assertNotIn("job interview", prompt.lower())


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

    def test_transient_llm_error_retries_once(self):
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
            content = "Beijing is the capital."
            reasoning_content = None

        class _Choice:
            delta = _Delta()

        class _Chunk:
            choices = [_Choice()]

        pipe.client = mock.Mock()
        pipe.client.chat.completions.create.side_effect = [
            ConnectionError("network timeout"),
            [_Chunk()],
        ]
        pipe.process_text("Where is the capital of China?", "ask")
        self.assertEqual(pipe.client.chat.completions.create.call_count, 2)
        self.assertTrue(any(e.get("type") == "chunk" and "Beijing" in (e.get("text") or "") for e in events))
        self.assertTrue(any(e.get("type") == "done" and e.get("ok") is True for e in events))

    def test_metering_failure_still_emits_done(self):
        # The answer already streamed. If accounting blows up after it, the
        # client never releases the translate gate and sticks on Translating.
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
        pipe.user_id = "u1"
        pipe.usage_session_id = "s1"
        pipe._heard_lang = None

        class _Delta:
            content = "Beijing is the capital."
            reasoning_content = None

        class _Choice:
            delta = _Delta()

        class _Chunk:
            choices = [_Choice()]

        pipe.client = mock.Mock()
        pipe.client.chat.completions.create.return_value = [_Chunk()]

        import server.meter as meter

        with mock.patch.object(meter, "check_can_generate", return_value=(True, {"ok": True})), \
             mock.patch.object(meter, "consume_llm", side_effect=RuntimeError("db is down")):
            pipe.process_text("Where is the capital of China?", "ask")

        self.assertTrue(
            any(e.get("type") == "chunk" and "Beijing" in (e.get("text") or "") for e in events),
            "answer should still stream",
        )
        self.assertTrue(
            any(e.get("type") == "done" for e in events),
            f"no done emitted, client would hang; got {[e.get('type') for e in events]}",
        )

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

    def test_ask_prompt_is_neutral_without_role(self):
        pipe = Pipeline.__new__(Pipeline)
        pipe.cfg = {"profile": {}, "llm": {}, "stt": {}}
        pipe._qa_history = []
        pipe._heard_lang = "zh"
        messages = pipe._build_messages("新西兰今天天气怎么样", "ask")
        sys_msg = messages[0]["content"]
        user_msg = messages[1]["content"]
        self.assertNotIn("Software Engineer", sys_msg)
        self.assertNotIn("interview coach", sys_msg.lower())
        self.assertNotIn("Interviewer question:", user_msg)
        self.assertIn("neutral", sys_msg.lower())
        self.assertIn("Question:", user_msg)

    def test_notes_tag_follows_notes_language(self):
        pipe = Pipeline.__new__(Pipeline)
        pipe.cfg = {"llm": {}}
        messages = pipe._build_messages(
            "[NOD_NOTES:it]\nOUTPUT LANGUAGE (hard rule): Write the entire notes in Italian only.\n"
            "Write structured notes for a live session\nSome bullets\n",
            "notes",
        )
        sys_msg = messages[0]["content"]
        self.assertIn("OUTPUT LANGUAGE", sys_msg)
        self.assertIn("Italian", sys_msg)

    def test_notes_auto_does_not_force_language(self):
        pipe = Pipeline.__new__(Pipeline)
        pipe.cfg = {"llm": {}}
        messages = pipe._build_messages(
            "[NOD_NOTES:auto]\nWrite structured notes for a live session\nSome bullets\n",
            "notes",
        )
        sys_msg = messages[0]["content"]
        self.assertNotIn("OUTPUT LANGUAGE", sys_msg)


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
