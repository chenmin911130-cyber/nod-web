import secrets
import threading
import unittest
from unittest import mock

from sqlalchemy.exc import IntegrityError
from starlette.testclient import TestClient

from server.db import Order, StripeEvent, User, db_session
from server.security import new_id


def _webhook_payload(*, eid: str, uid: str, order_id: str | None = None):
    meta = {"nod_user": uid}
    if order_id:
        meta["order_id"] = order_id
    return {
        "id": eid,
        "type": "customer.subscription.updated",
        "data": {"object": {"status": "active", "metadata": meta, "customer": "cus_test"}},
    }


class StripeWebhookTxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from server.app import app

        cls.client = TestClient(app, raise_server_exceptions=False)

    def _post(self, payload):
        with (
            mock.patch("server.commerce.STRIPE_SECRET_KEY", "sk_test"),
            mock.patch("server.commerce.STRIPE_WEBHOOK_SECRET", "whsec_test"),
            mock.patch("stripe.Webhook.construct_event", return_value=payload),
        ):
            return self.client.post(
                "/api/billing/webhook",
                content=b"{}",
                headers={"stripe-signature": "t", "content-type": "application/json"},
            )

    def test_success_persists_event_user_and_order(self):
        uid = new_id()
        oid = new_id()
        eid = f"evt_{secrets.token_hex(4)}"
        with db_session() as db:
            db.add(User(id=uid, email=f"{uid}@test.local", password_hash="", plan="free"))
            db.add(Order(id=oid, user_id=uid, plan="pro", status="pending"))
        res = self._post(_webhook_payload(eid=eid, uid=uid, order_id=oid))
        self.assertEqual(res.status_code, 200, res.text)
        with db_session() as db:
            self.assertIsNotNone(db.get(StripeEvent, eid))
            self.assertEqual(db.get(User, uid).plan, "pro")
            self.assertEqual(db.get(Order, oid).status, "paid")

    def test_duplicate_event_is_idempotent(self):
        uid = new_id()
        eid = f"evt_{secrets.token_hex(4)}"
        payload = _webhook_payload(eid=eid, uid=uid)
        with db_session() as db:
            db.add(User(id=uid, email=f"{uid}@test.local", password_hash="", plan="free"))
        first = self._post(payload)
        second = self._post(payload)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        with db_session() as db:
            self.assertEqual(db.query(StripeEvent).filter(StripeEvent.id == eid).count(), 1)
            self.assertEqual(db.get(User, uid).plan, "pro")

    def test_apply_failure_rolls_back_dedup_row(self):
        from server import commerce

        uid = new_id()
        eid = f"evt_{secrets.token_hex(4)}"
        payload = _webhook_payload(eid=eid, uid=uid)
        with db_session() as db:
            db.add(User(id=uid, email=f"{uid}@test.local", password_hash="", plan="free"))
        real = commerce._stripe_apply_event
        state = {"n": 0}

        def flaky(db, etype, data):
            state["n"] += 1
            if state["n"] == 1:
                raise RuntimeError("injected apply failure")
            return real(db, etype, data)

        with mock.patch("server.commerce._stripe_apply_event", side_effect=flaky):
            fail = self._post(payload)
            ok = self._post(payload)
        self.assertGreaterEqual(fail.status_code, 500)
        self.assertEqual(ok.status_code, 200, ok.text)
        with db_session() as db:
            self.assertIsNotNone(db.get(StripeEvent, eid))
            self.assertEqual(db.get(User, uid).plan, "pro")

    def test_non_dedup_integrity_error_not_swallowed(self):
        uid = new_id()
        eid = f"evt_{secrets.token_hex(4)}"
        payload = _webhook_payload(eid=eid, uid=uid)
        with db_session() as db:
            db.add(User(id=uid, email=f"{uid}@test.local", password_hash="", plan="free"))

        def boom(*_a, **_k):
            raise IntegrityError("stmt", {}, Exception("other constraint"))

        with mock.patch("server.commerce._stripe_apply_event", side_effect=boom):
            res = self._post(payload)
        self.assertEqual(res.status_code, 503, res.text)
        with db_session() as db:
            self.assertIsNone(db.get(StripeEvent, eid))
            self.assertEqual(db.get(User, uid).plan, "free")

    def test_concurrent_same_event_id(self):
        uid = new_id()
        eid = f"evt_{secrets.token_hex(4)}"
        payload = _webhook_payload(eid=eid, uid=uid)
        with db_session() as db:
            db.add(User(id=uid, email=f"{uid}@test.local", password_hash="", plan="free"))
        barrier = threading.Barrier(2)
        codes: list[int] = []

        def worker():
            barrier.wait()
            codes.append(self._post(payload).status_code)

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertTrue(all(c == 200 for c in codes), codes)
        with db_session() as db:
            self.assertEqual(db.query(StripeEvent).filter(StripeEvent.id == eid).count(), 1)
            self.assertEqual(db.get(User, uid).plan, "pro")

    def test_bad_signature_writes_nothing(self):
        with db_session() as db:
            before = db.query(StripeEvent).count()
        with (
            mock.patch("server.commerce.STRIPE_SECRET_KEY", "sk_test"),
            mock.patch("server.commerce.STRIPE_WEBHOOK_SECRET", "whsec_test"),
            mock.patch("stripe.Webhook.construct_event", side_effect=ValueError("bad sig")),
        ):
            res = self.client.post(
                "/api/billing/webhook",
                content=b"{}",
                headers={"stripe-signature": "t", "content-type": "application/json"},
            )
        self.assertEqual(res.status_code, 400)
        with db_session() as db:
            self.assertEqual(db.query(StripeEvent).count(), before)


if __name__ == "__main__":
    unittest.main()
