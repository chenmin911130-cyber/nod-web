import secrets
import unittest
from unittest import mock

from starlette.testclient import TestClient


def _set_cookie(res) -> str:
    return (res.headers.get("set-cookie") or "").lower()


class SessionCookieFlagTests(unittest.TestCase):
    def setUp(self):
        from server.app import app

        self.client = TestClient(app)

    def test_logout_clears_httponly_and_samesite(self):
        res = self.client.post("/api/auth/logout")
        self.assertEqual(res.status_code, 200)
        header = _set_cookie(res)
        self.assertIn("nod_session=", header)
        self.assertIn("httponly", header)
        self.assertIn("samesite=lax", header)

    def test_logout_secure_when_forwarded_https(self):
        res = self.client.post(
            "/api/auth/logout",
            headers={"x-forwarded-proto": "https, http"},
        )
        header = _set_cookie(res)
        self.assertIn("httponly", header)
        self.assertIn("secure", header)

    def test_login_sets_httponly_and_secure_on_https(self):
        sent: list[str] = []

        def _send(_to: str, code: str) -> bool:
            sent.append(code)
            return True

        email = f"cookie.{secrets.token_hex(6)}@example.com"
        with mock.patch("server.commerce.send_otp_email", side_effect=_send):
            req = self.client.post(
                "/api/auth/otp/request",
                json={"email": email, "intent": "signup", "name": "Ada", "consent": True},
            )
            self.assertEqual(req.status_code, 200, req.text)
            res = self.client.post(
                "/api/auth/otp/verify",
                json={"email": email, "code": sent[0], "intent": "signup", "consent": True},
                headers={"x-forwarded-proto": "https"},
            )
        self.assertEqual(res.status_code, 200, res.text)
        header = _set_cookie(res)
        self.assertIn("nod_session=", header)
        self.assertIn("httponly", header)
        self.assertIn("secure", header)
        self.assertIn("samesite=lax", header)


class AdminCookieFlagTests(unittest.TestCase):
    def test_admin_logout_clears_httponly_and_secure(self):
        from server.app import app

        with mock.patch("server.settings.ADMIN_TOKEN", "configured-token"):
            client = TestClient(app)
            res = client.post("/api/admin/logout", headers={"x-forwarded-proto": "https"})
        self.assertEqual(res.status_code, 200)
        header = _set_cookie(res)
        self.assertIn("nod_admin=", header)
        self.assertIn("httponly", header)
        self.assertIn("secure", header)


class SecurityTxtTests(unittest.TestCase):
    def test_security_txt_lists_contact(self):
        from server.app import app
        from server.settings import CONTACT_EMAIL

        res = TestClient(app).get("/.well-known/security.txt")
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/plain", res.headers["content-type"])
        self.assertIn(f"Contact: mailto:{CONTACT_EMAIL}", res.text)
        self.assertIn("Expires:", res.text)
        self.assertIn("/.well-known/security.txt", res.text)


if __name__ == "__main__":
    unittest.main()
