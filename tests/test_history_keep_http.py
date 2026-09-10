import unittest

from starlette.testclient import TestClient


class HistoryKeepHttpTests(unittest.TestCase):
    def test_bearer_keep_marks_owned_session(self):
        from server.app import app
        from server.db import UsageSession, User, db_session
        from server.security import issue_jwt, new_id

        uid = new_id()
        sid = new_id()
        email = f"{uid}@test.local"
        with db_session() as db:
            db.add(User(id=uid, email=email, password_hash=""))
            db.add(UsageSession(id=sid, user_id=uid, mode="meeting", kept=False))
        token = issue_jwt(uid, email)
        client = TestClient(app)
        kept = client.post(
            f"/api/account/history/{sid}/keep",
            headers={"Host": "nodpilot.com", "Authorization": f"Bearer {token}"},
        )
        self.assertEqual(kept.status_code, 200, kept.text)
        self.assertEqual(kept.json().get("id"), sid)
        with db_session() as db:
            row = db.get(UsageSession, sid)
            self.assertTrue(row.kept)
        again = client.post(
            f"/api/account/history/{sid}/keep",
            headers={"Host": "nodpilot.com", "Authorization": f"Bearer {token}"},
        )
        self.assertEqual(again.status_code, 200, again.text)

    def test_keep_rejects_other_user_and_anonymous(self):
        from server.app import app
        from server.db import UsageSession, User, db_session
        from server.security import issue_jwt, new_id

        owner = new_id()
        other = new_id()
        sid = new_id()
        with db_session() as db:
            db.add(User(id=owner, email=f"{owner}@test.local", password_hash=""))
            db.add(User(id=other, email=f"{other}@test.local", password_hash=""))
            db.add(UsageSession(id=sid, user_id=owner, mode="meeting", kept=False))
        client = TestClient(app)
        anon = client.post(
            f"/api/account/history/{sid}/keep",
            headers={"Host": "nodpilot.com"},
        )
        self.assertEqual(anon.status_code, 401)
        stolen = client.post(
            f"/api/account/history/{sid}/keep",
            headers={
                "Host": "nodpilot.com",
                "Authorization": f"Bearer {issue_jwt(other, f'{other}@test.local')}",
            },
        )
        self.assertEqual(stolen.status_code, 404)
        with db_session() as db:
            self.assertFalse(db.get(UsageSession, sid).kept)
