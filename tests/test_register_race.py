import unittest
import uuid
from unittest import mock

from starlette.testclient import TestClient

from server.app import app


class RegisterConflictTests(unittest.TestCase):
    def test_duplicate_email_insert_race_is_409_not_500(self):
        client = TestClient(app)
        email = f"race-conflict-{uuid.uuid4().hex[:12]}@test.com"
        ok = client.post(
            "/api/auth/register",
            json={"email": email, "password": "password123", "consent": True},
        )
        self.assertEqual(ok.status_code, 200)
        # Simulate the check-then-insert race: the duplicate check reads nothing
        # (the user "appears" only after the check), so the INSERT hits the
        # email unique constraint. The endpoint must turn that into 409, not 500.
        with mock.patch("sqlalchemy.orm.Query.first", return_value=None):
            res = client.post(
                "/api/auth/register",
                json={"email": email, "password": "password123", "consent": True},
            )
        self.assertEqual(res.status_code, 409, res.text)
