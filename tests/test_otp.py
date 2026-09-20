import secrets
import unittest
from unittest import mock

from starlette.testclient import TestClient

from server.mailer import send_otp_email
from server.otp import OTP_MAX_ATTEMPTS, consume_otp, issue_otp


def _email() -> str:
    return f"otp.{secrets.token_hex(6)}@example.com"


class OtpUnitTests(unittest.TestCase):
    def test_consume_rejects_wrong_and_replayed_codes(self):
        email = _email()
        code = issue_otp(email, "login")
        self.assertIsNone(consume_otp(email, "000000"))
        row = consume_otp(email, code)
        self.assertIsNotNone(row)
        self.assertEqual(row.email, email)
        self.assertIsNone(consume_otp(email, code))


class MailerOtpTests(unittest.TestCase):
    def test_failed_send_does_not_log_code(self):
        with mock.patch("server.mailer.send_mail", return_value=False):
            with self.assertLogs("nod.mail", level="INFO") as cm:
                send_otp_email("nobody@example.com", "654321")
        joined = "\n".join(cm.output)
        self.assertNotIn("654321", joined)


class OtpApiTests(unittest.TestCase):
    def setUp(self):
        from server import ratelimit
        from server.app import app

        ratelimit._hits.clear()
        self.client = TestClient(app)
        self.sent: list[tuple[str, str]] = []
        self.no_account: list[str] = []
        self.patcher = mock.patch("server.commerce.send_otp_email", side_effect=self._send)
        self.patcher2 = mock.patch("server.commerce.send_otp_no_account_email", side_effect=self._no_account)
        self.patcher.start()
        self.patcher2.start()

    def tearDown(self):
        self.patcher2.stop()
        self.patcher.stop()

    def _send(self, to: str, code: str) -> bool:
        self.sent.append((to, code))
        return True

    def _no_account(self, to: str) -> bool:
        self.no_account.append(to)
        return True

    def test_signup_otp_creates_account(self):
        email = _email()
        req = self.client.post(
            "/api/auth/otp/request",
            json={"email": email, "intent": "signup", "name": "Ada", "consent": True},
        )
        self.assertEqual(req.status_code, 200, req.text)
        self.assertEqual(len(self.sent), 1)
        code = self.sent[0][1]
        verify = self.client.post(
            "/api/auth/otp/verify",
            json={"email": email, "code": code, "intent": "signup", "consent": True},
        )
        self.assertEqual(verify.status_code, 200, verify.text)
        body = verify.json()
        self.assertTrue(body["ok"])
        self.assertTrue(body["created"])
        self.assertEqual(body["user"]["email"], email)
        self.assertTrue(body["user"]["consent"])
        self.assertEqual(body["user"]["sign_in"], "email")

    def test_login_unknown_email_does_not_send_or_leak(self):
        from server.db import EmailOtp, db_session

        email = _email()
        req = self.client.post("/api/auth/otp/request", json={"email": email, "intent": "login"})
        self.assertEqual(req.status_code, 200, req.text)
        self.assertEqual(req.json()["message"], "Check your email for a 6-digit code. It expires in 10 minutes.")
        self.assertEqual(self.sent, [])
        self.assertEqual(self.no_account, [email])
        with db_session() as db:
            rows = db.query(EmailOtp).filter(EmailOtp.email == email).count()
        self.assertEqual(rows, 0)
        verify = self.client.post("/api/auth/otp/verify", json={"email": email, "code": "123456", "intent": "login"})
        self.assertEqual(verify.status_code, 401)

    def test_resend_reuses_same_code(self):
        email = _email()
        first = self.client.post(
            "/api/auth/otp/request",
            json={"email": email, "intent": "signup", "name": "Ada", "consent": True},
        )
        self.assertEqual(first.status_code, 200, first.text)
        code_a = self.sent[0][1]
        second = self.client.post(
            "/api/auth/otp/request",
            json={"email": email, "intent": "signup", "name": "Ada", "consent": True},
        )
        self.assertEqual(second.status_code, 200, second.text)
        code_b = self.sent[1][1]
        self.assertEqual(code_a, code_b)
        verify = self.client.post(
            "/api/auth/otp/verify",
            json={"email": email, "code": code_a, "intent": "signup", "consent": True},
        )
        self.assertEqual(verify.status_code, 200, verify.text)

    def test_resend_after_max_wrong_attempts_issues_fresh_code(self):
        email = _email()
        self.client.post(
            "/api/auth/otp/request",
            json={"email": email, "intent": "signup", "consent": True},
        )
        dead_code = self.sent[0][1]
        for _ in range(OTP_MAX_ATTEMPTS):
            bad = self.client.post(
                "/api/auth/otp/verify",
                json={"email": email, "code": "000000", "intent": "signup", "consent": True},
            )
            self.assertEqual(bad.status_code, 401)
        resend = self.client.post(
            "/api/auth/otp/request",
            json={"email": email, "intent": "signup", "consent": True},
        )
        self.assertEqual(resend.status_code, 200, resend.text)
        fresh_code = self.sent[1][1]
        self.assertNotEqual(dead_code, fresh_code)
        ok = self.client.post(
            "/api/auth/otp/verify",
            json={"email": email, "code": fresh_code, "intent": "signup", "consent": True},
        )
        self.assertEqual(ok.status_code, 200, ok.text)
        replay_dead = self.client.post(
            "/api/auth/otp/verify",
            json={"email": email, "code": dead_code, "intent": "signup", "consent": True},
        )
        self.assertEqual(replay_dead.status_code, 401)

    def test_resend_mail_failure_keeps_existing_code(self):
        email = _email()
        self.client.post(
            "/api/auth/otp/request",
            json={"email": email, "intent": "signup", "consent": True},
        )
        code = self.sent[0][1]
        with mock.patch("server.commerce.send_otp_email", return_value=False):
            retry = self.client.post(
                "/api/auth/otp/request",
                json={"email": email, "intent": "signup", "consent": True},
            )
        self.assertEqual(retry.status_code, 503, retry.text)
        verify = self.client.post(
            "/api/auth/otp/verify",
            json={"email": email, "code": code, "intent": "signup", "consent": True},
        )
        self.assertEqual(verify.status_code, 200, verify.text)

    def test_login_unknown_email_rate_limited_per_mailbox(self):
        email = _email()
        for _ in range(4):
            res = self.client.post("/api/auth/otp/request", json={"email": email, "intent": "login"})
            self.assertEqual(res.status_code, 200, res.text)
        blocked = self.client.post("/api/auth/otp/request", json={"email": email, "intent": "login"})
        self.assertEqual(blocked.status_code, 429)

    def test_otp_request_global_limit_allows_burst(self):
        from server import ratelimit

        ratelimit._hits.clear()
        for i in range(21):
            email = f"burst.{i}.{secrets.token_hex(4)}@example.com"
            res = self.client.post(
                "/api/auth/otp/request",
                json={"email": email, "intent": "signup", "consent": True},
                headers={"x-forwarded-for": f"10.0.0.{i % 250 + 1}"},
            )
            self.assertEqual(res.status_code, 200, res.text)

    def test_existing_user_can_sign_in_with_otp(self):
        email = _email()
        from server.db import User, db_session
        from server.security import new_id

        with db_session() as db:
            db.add(User(id=new_id(), email=email, password_hash="", name="Old"))
        req = self.client.post("/api/auth/otp/request", json={"email": email, "intent": "login"})
        self.assertEqual(req.status_code, 200, req.text)
        code = self.sent[0][1]
        verify = self.client.post("/api/auth/otp/verify", json={"email": email, "code": code, "intent": "login"})
        self.assertEqual(verify.status_code, 200, verify.text)
        self.assertFalse(verify.json()["created"])

    def test_wrong_code_then_replay_fail(self):
        email = _email()
        self.client.post(
            "/api/auth/otp/request",
            json={"email": email, "intent": "signup", "consent": True},
        )
        code = self.sent[0][1]
        bad = self.client.post("/api/auth/otp/verify", json={"email": email, "code": "000000", "intent": "signup"})
        self.assertEqual(bad.status_code, 401)
        ok = self.client.post(
            "/api/auth/otp/verify",
            json={"email": email, "code": code, "intent": "signup", "consent": True},
        )
        self.assertEqual(ok.status_code, 200, ok.text)
        replay = self.client.post(
            "/api/auth/otp/verify",
            json={"email": email, "code": code, "intent": "signup", "consent": True},
        )
        self.assertEqual(replay.status_code, 401)

    def test_robots_welcomes_ai_crawlers_but_blocks_app(self):
        res = self.client.get("/robots.txt")
        self.assertEqual(res.status_code, 200)
        text = res.text
        self.assertIn("User-agent: GPTBot", text)
        self.assertIn("User-agent: PerplexityBot", text)
        self.assertIn("Disallow: /app", text)
        self.assertIn("Disallow: /api/", text)
        self.assertIn("Allow: /", text)

    def test_index_html_redirects_to_root(self):
        res = self.client.get("/index.html", follow_redirects=False)
        self.assertEqual(res.status_code, 301)
        self.assertEqual(res.headers.get("location"), "/")

    def test_zh_trailing_slash_redirects(self):
        res = self.client.get("/zh/", follow_redirects=False)
        self.assertEqual(res.status_code, 301)
        self.assertEqual(res.headers.get("location"), "/zh")

    def test_sitemap_lists_legal_pages_not_auth(self):
        res = self.client.get("/sitemap.xml")
        self.assertEqual(res.status_code, 200)
        text = res.text
        self.assertRegex(text, r"<loc>https?://[^<]+/</loc>")
        self.assertIn("/zh</loc>", text)
        self.assertIn("/privacy", text)
        self.assertIn("/terms", text)
        self.assertIn("/consent", text)
        self.assertNotIn("/login", text)
        self.assertNotIn("/signup", text)


class PublicUserSignInTests(unittest.TestCase):
    def test_sign_in_follows_clerk_id(self):
        from server.commerce import _public_user
        from server.db import User, db_session
        from server.security import new_id

        email_id = new_id()
        google_id = new_id()
        with db_session() as db:
            db.add(User(id=email_id, email=f"e.{email_id[:8]}@example.com", password_hash="", name="E"))
            db.add(User(
                id=google_id,
                email=f"g.{google_id[:8]}@example.com",
                password_hash="",
                name="G",
                clerk_id="user_clerk_test",
            ))
        with db_session() as db:
            email_user = db.get(User, email_id)
            google_user = db.get(User, google_id)
            self.assertIsNotNone(email_user)
            self.assertIsNotNone(google_user)
            self.assertEqual(_public_user(email_user)["sign_in"], "email")
            self.assertEqual(_public_user(google_user)["sign_in"], "google")
