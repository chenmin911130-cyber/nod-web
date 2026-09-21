import hashlib
import secrets
import time
import unittest
from unittest import mock

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from starlette.testclient import TestClient

from server.apple_auth import verify_apple_identity_token
from server.db import User, db_session, utcnow
from server.security import new_id


def _rsa_keys():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = private_key.public_key()
    return private_key, public_key


def _mint_token(
    private_key,
    *,
    sub: str,
    email: str,
    nonce_raw: str,
    aud: str = "com.nodpilot.app",
    iss: str = "https://appleid.apple.com",
    exp_offset: int = 3600,
    email_verified=True,
) -> str:
    nonce = hashlib.sha256(nonce_raw.encode()).hexdigest()
    payload = {
        "iss": iss,
        "aud": aud,
        "sub": sub,
        "email": email,
        "email_verified": email_verified,
        "nonce": nonce,
        "exp": int(time.time()) + exp_offset,
    }
    return jwt.encode(payload, private_key, algorithm="RS256", headers={"kid": "test-kid"})


class AppleVerifyTests(unittest.TestCase):
    def setUp(self):
        self.private_key, self.public_key = _rsa_keys()
        self.patcher = mock.patch("server.apple_auth._apple_jwks_client")
        self.mock_jwks = self.patcher.start()
        client = mock.Mock()
        client.get_signing_key_from_jwt.return_value = mock.Mock(key=self.public_key)
        self.mock_jwks.return_value = client

    def tearDown(self):
        self.patcher.stop()
        from server import apple_auth

        apple_auth._apple_jwks_client.cache_clear()

    def test_valid_token_and_nonce(self):
        nonce = secrets.token_hex(8)
        token = _mint_token(self.private_key, sub="apple-sub-1", email="a@example.com", nonce_raw=nonce)
        payload = verify_apple_identity_token(token, nonce)
        self.assertEqual(payload["sub"], "apple-sub-1")


class AppleApiTests(unittest.TestCase):
    def setUp(self):
        from server.app import app

        self.client = TestClient(app)
        self.private_key, self.public_key = _rsa_keys()
        self.jwks_patcher = mock.patch("server.apple_auth._apple_jwks_client")
        self.mock_jwks = self.jwks_patcher.start()
        client = mock.Mock()
        client.get_signing_key_from_jwt.return_value = mock.Mock(key=self.public_key)
        self.mock_jwks.return_value = client

    def tearDown(self):
        self.jwks_patcher.stop()

    def _post(self, email: str, sub: str, nonce: str | None = None, name: str = "", **token_kw):
        nonce_raw = nonce or secrets.token_hex(8)
        token = _mint_token(self.private_key, sub=sub, email=email, nonce_raw=nonce_raw, **token_kw)
        return self.client.post(
            "/api/auth/apple",
            json={"identity_token": token, "nonce": nonce_raw, "name": name},
        )

    def test_creates_user_with_apple_sign_in(self):
        email = f"apple.{secrets.token_hex(4)}@example.com"
        sub = f"apple-new-{secrets.token_hex(6)}"
        res = self._post(email, sub)
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual(body["user"]["sign_in"], "apple")
        self.assertEqual(body["user"]["email"], email)
        with db_session() as db:
            row = db.query(User).filter(User.email == email).first()
            self.assertEqual(row.apple_sub, sub)

    def test_rejects_bad_audience(self):
        email = f"apple.{secrets.token_hex(4)}@example.com"
        res = self._post(email, "sub-bad-aud", aud="com.evil.app")
        self.assertEqual(res.status_code, 401)

    def test_rejects_bad_nonce(self):
        email = f"apple.{secrets.token_hex(4)}@example.com"
        nonce = secrets.token_hex(8)
        token = _mint_token(self.private_key, sub="sub-nonce", email=email, nonce_raw=nonce)
        res = self.client.post(
            "/api/auth/apple",
            json={"identity_token": token, "nonce": "other-nonce", "name": ""},
        )
        self.assertEqual(res.status_code, 401)

    def test_links_existing_email_user(self):
        email = f"otp.{secrets.token_hex(4)}@example.com"
        with db_session() as db:
            db.add(User(id=new_id(), email=email, password_hash="", name="Ada"))
        sub = f"apple-link-{secrets.token_hex(6)}"
        res = self._post(email, sub)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["user"]["sign_in"], "apple")
        with db_session() as db:
            row = db.query(User).filter(User.email == email).first()
            self.assertEqual(row.apple_sub, sub)

    def test_links_clerk_user_same_email(self):
        email = f"google.{secrets.token_hex(4)}@example.com"
        with db_session() as db:
            db.add(User(id=new_id(), email=email, password_hash="", clerk_id="clerk_1", name="G"))
        res = self._post(email, "apple-clerk-sub")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["user"]["sign_in"], "apple")

    def test_second_login_without_name_keeps_name(self):
        email = f"apple.{secrets.token_hex(4)}@example.com"
        sub = f"apple-name-{secrets.token_hex(6)}"
        first = self._post(email, sub, name="Ada Lo")
        self.assertEqual(first.status_code, 200, first.text)
        second = self._post(email, sub, name="")
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["user"]["name"], "Ada Lo")

    def test_deleted_user_same_email_creates_new(self):
        email = f"dead.{secrets.token_hex(4)}@example.com"
        with db_session() as db:
            db.add(
                User(
                    id=new_id(),
                    email=email,
                    password_hash="",
                    apple_sub="old-sub",
                    deleted_at=utcnow(),
                )
            )
        fresh_sub = f"apple-fresh-{secrets.token_hex(6)}"
        res = self._post(email, fresh_sub)
        self.assertEqual(res.status_code, 200, res.text)
        with db_session() as db:
            live = db.query(User).filter(User.email == email, User.deleted_at.is_(None)).all()
        self.assertEqual(len(live), 1)
        self.assertEqual(live[0].apple_sub, fresh_sub)
