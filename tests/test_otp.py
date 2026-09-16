import secrets
import unittest
from unittest import mock

from starlette.testclient import TestClient

from server.mailer import send_otp_email
from server.otp import consume_otp, issue_otp


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
        from server.app import app

        self.client = TestClient(app)
        self.sent: list[tuple[str, str]] = []
        self.patcher = mock.patch("server.commerce.send_otp_email", side_effect=self._send)
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()

    def _send(self, to: str, code: str) -> bool:
        self.sent.append((to, code))
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
        email = _email()
        req = self.client.post("/api/auth/otp/request", json={"email": email, "intent": "login"})
        self.assertEqual(req.status_code, 200, req.text)
        self.assertEqual(req.json()["message"], "Check your email for a 6-digit code. It expires in 10 minutes.")
        self.assertEqual(self.sent, [])
        verify = self.client.post("/api/auth/otp/verify", json={"email": email, "code": "123456", "intent": "login"})
        self.assertEqual(verify.status_code, 401)

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
