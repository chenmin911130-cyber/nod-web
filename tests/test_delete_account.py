import unittest
from unittest import mock

from starlette.testclient import TestClient

from server.settings import COOKIE_NAME


class DeleteAccountApiTests(unittest.TestCase):
    def test_delete_account_then_me_is_401(self):
        from server.app import app
        from server.db import HistoryItem, UsageDay, UsageSession, User, db_session
        from server.security import issue_jwt, new_id

        uid = new_id()
        sid = new_id()
        hid = new_id()
        email = f"{uid}@test.local"
        with db_session() as db:
            db.add(User(id=uid, email=email, password_hash=""))
            db.add(UsageSession(id=sid, user_id=uid, mode="meeting"))
            db.add(HistoryItem(id=hid, user_id=uid, session_id=sid, kind="line", text="hi"))
            db.add(UsageDay(user_id=uid, day="2026-09-07"))
        token = issue_jwt(uid, email)
        client = TestClient(app)
        with mock.patch("server.r2.delete_prefix"):
            wiped = client.delete("/api/account", cookies={COOKIE_NAME: token})
        self.assertEqual(wiped.status_code, 200, wiped.text)
        self.assertTrue(wiped.json().get("ok"))
        me = client.get("/api/me", cookies={COOKIE_NAME: token}, headers={"Host": "nodpilot.com"})
        self.assertEqual(me.status_code, 401)
        with db_session() as db:
            self.assertEqual(db.query(HistoryItem).filter(HistoryItem.user_id == uid).count(), 0)
            self.assertEqual(db.query(UsageSession).filter(UsageSession.user_id == uid).count(), 0)
            self.assertEqual(db.query(UsageDay).filter(UsageDay.user_id == uid).count(), 0)
            user = db.get(User, uid)
            self.assertIsNotNone(user)
            self.assertIsNotNone(user.deleted_at)
