import secrets
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from starlette.testclient import TestClient

from server.db import ResetToken, User, db_session, utcnow
from server.security import hash_password, hash_token, new_id, verify_password


class ResetPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from server.app import app

        cls.client = TestClient(app, raise_server_exceptions=False)

    def setUp(self):
        self._allow_patcher = mock.patch("server.ratelimit.allow", return_value=True)
        self._allow_patcher.start()

    def tearDown(self):
        self._allow_patcher.stop()

    def _seed_reset(self, *, password: str = "oldpass12", expired: bool = False, used: bool = False):
        email = f"reset.{secrets.token_hex(4)}@example.com"
        raw = secrets.token_urlsafe(32)
        uid = new_id()
        exp = utcnow() - timedelta(hours=1) if expired else utcnow() + timedelta(hours=2)
        with db_session() as db:
            db.add(
                User(
                    id=uid,
                    email=email,
                    password_hash=hash_password(password),
                    plan="free",
                )
            )
            rid = new_id()
            db.add(
                ResetToken(
                    id=rid,
                    user_id=uid,
                    token_hash=hash_token(raw),
                    expires_at=exp,
                    used_at=utcnow() if used else None,
                )
            )
        return raw, uid, email

    def test_reset_persists_password_and_used_at(self):
        raw, uid, email = self._seed_reset()
        res = self.client.post("/api/auth/reset", json={"token": raw, "password": "newpass99"})
        self.assertEqual(res.status_code, 200, res.text)
        with db_session() as db:
            user = db.get(User, uid)
            self.assertTrue(verify_password("newpass99", user.password_hash))
            self.assertFalse(verify_password("oldpass12", user.password_hash))
            row = db.query(ResetToken).filter(ResetToken.user_id == uid).one()
            self.assertIsNotNone(row.used_at)
        login_ok = self.client.post("/api/auth/login", json={"email": email, "password": "newpass99"})
        self.assertEqual(login_ok.status_code, 200, login_ok.text)
        login_bad = self.client.post("/api/auth/login", json={"email": email, "password": "oldpass12"})
        self.assertEqual(login_bad.status_code, 401)

    def test_reset_second_use_fails(self):
        raw, uid, _ = self._seed_reset()
        first = self.client.post("/api/auth/reset", json={"token": raw, "password": "newpass99"})
        self.assertEqual(first.status_code, 200, first.text)
        second = self.client.post("/api/auth/reset", json={"token": raw, "password": "another99"})
        self.assertEqual(second.status_code, 400)

    def test_reset_expired_and_used_rejected(self):
        raw_exp, _, _ = self._seed_reset(expired=True)
        self.assertEqual(
            self.client.post("/api/auth/reset", json={"token": raw_exp, "password": "newpass99"}).status_code,
            400,
        )
        raw_used, uid, _ = self._seed_reset(used=True)
        self.assertEqual(
            self.client.post("/api/auth/reset", json={"token": raw_used, "password": "newpass99"}).status_code,
            400,
        )
        with db_session() as db:
            self.assertTrue(verify_password("oldpass12", db.get(User, uid).password_hash))

    def test_reset_unknown_token_rejected(self):
        self.assertEqual(
            self.client.post("/api/auth/reset", json={"token": "nope", "password": "newpass99"}).status_code,
            400,
        )

    def test_reset_deleted_user_rejected(self):
        raw, uid, _ = self._seed_reset()
        with db_session() as db:
            user = db.get(User, uid)
            user.deleted_at = utcnow()
        self.assertEqual(
            self.client.post("/api/auth/reset", json={"token": raw, "password": "newpass99"}).status_code,
            400,
        )

    def test_reset_expires_at_naive_sqlite_no_type_error(self):
        raw, uid, _ = self._seed_reset()
        with db_session() as db:
            row = db.query(ResetToken).filter(ResetToken.user_id == uid).one()
            row.expires_at = datetime.utcnow() + timedelta(hours=1)
        res = self.client.post("/api/auth/reset", json={"token": raw, "password": "newpass99"})
        self.assertEqual(res.status_code, 200, res.text)

    def test_reset_expires_at_aware_offset(self):
        raw, uid, _ = self._seed_reset()
        with db_session() as db:
            row = db.query(ResetToken).filter(ResetToken.user_id == uid).one()
            row.expires_at = datetime.now(timezone(timedelta(hours=8))) + timedelta(hours=2)
        res = self.client.post("/api/auth/reset", json={"token": raw, "password": "newpass99"})
        self.assertEqual(res.status_code, 200, res.text)

    def test_reset_rolls_back_on_password_hash_failure(self):
        raw, uid, _ = self._seed_reset()
        with mock.patch("server.commerce.hash_password", side_effect=RuntimeError("boom")):
            res = self.client.post("/api/auth/reset", json={"token": raw, "password": "newpass99"})
        self.assertGreaterEqual(res.status_code, 500)
        with db_session() as db:
            user = db.get(User, uid)
            self.assertTrue(verify_password("oldpass12", user.password_hash))
            row = db.query(ResetToken).filter(ResetToken.user_id == uid).one()
            self.assertIsNone(row.used_at)
        retry = self.client.post("/api/auth/reset", json={"token": raw, "password": "newpass99"})
        self.assertEqual(retry.status_code, 200, retry.text)


class ClerkLinkPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from server.app import app

        cls.client = TestClient(app)

    def _clerk_post(self, *, sub: str, email: str, name: str = ""):
        with (
            mock.patch("server.clerk_auth.verify_clerk_session", return_value={"sub": sub}),
            mock.patch("server.clerk_auth.clerk_profile", return_value=(email, name)),
            mock.patch("server.clerk_auth._token_from_request", return_value="tok"),
        ):
            return self.client.post("/api/auth/clerk", json={"token": "tok"})

    def test_clerk_links_existing_email_user(self):
        email = f"otp.{secrets.token_hex(4)}@example.com"
        uid = new_id()
        with db_session() as db:
            db.add(User(id=uid, email=email, password_hash="", name=""))
        clerk_id = f"clerk_{secrets.token_hex(4)}"
        res = self._clerk_post(sub=clerk_id, email=email, name="Ada")
        self.assertEqual(res.status_code, 200, res.text)
        with db_session() as db:
            row = db.get(User, uid)
            self.assertEqual(row.clerk_id, clerk_id)
            self.assertEqual(row.name, "Ada")
            self.assertEqual(db.query(User).filter(User.email == email).count(), 1)

    def test_clerk_second_login_same_user_keeps_name(self):
        email = f"g.{secrets.token_hex(4)}@example.com"
        clerk_id = f"clerk_{secrets.token_hex(4)}"
        first = self._clerk_post(sub=clerk_id, email=email, name="Ada Lo")
        self.assertEqual(first.status_code, 200, first.text)
        uid = first.json()["user"]["id"]
        second = self._clerk_post(sub=clerk_id, email=email, name="Other")
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["user"]["id"], uid)
        with db_session() as db:
            self.assertEqual(db.get(User, uid).name, "Ada Lo")


if __name__ == "__main__":
    unittest.main()
