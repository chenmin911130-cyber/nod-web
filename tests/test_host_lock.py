import unittest
from unittest import mock

from server.headers import HostLockMiddleware, host_allowed
from server.ratelimit import allow, rate_limit_global, ws_connect, ws_disconnect
from server.settings import _allowed_hosts


def _scope(path: str = "/", host: str = "www.nodpilot.com", client: tuple | None = ("1.2.3.4", 5555), stype: str = "http") -> dict:
    return {
        "type": stype,
        "asgi": {"version": "3.0", "spec_version": "2.1"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"host", host.encode())],
        "client": client,
        "server": ("127.0.0.1", 80),
    }


class HostAllowedTests(unittest.TestCase):
    """Pure host_allowed() checks."""

    def test_whitelisted_host_allowed(self):
        self.assertTrue(host_allowed(_scope(host="www.nodpilot.com"), {"www.nodpilot.com", "nodpilot.com"}))

    def test_foreign_host_rejected(self):
        self.assertFalse(host_allowed(_scope(host="nod-web-production.up.railway.app"), {"www.nodpilot.com"}))

    def test_case_and_port_insensitive(self):
        self.assertTrue(host_allowed(_scope(host="WWW.NODPILOT.COM:443"), {"www.nodpilot.com"}))

    def test_local_loopback_open_for_dev(self):
        self.assertTrue(host_allowed(_scope(host="127.0.0.1", client=("127.0.0.1", 5555)), {"www.nodpilot.com"}))
        self.assertTrue(host_allowed(_scope(host="localhost", client=("127.0.0.1", 5555)), set()))

    def test_missing_host_rejected(self):
        scope = _scope()
        scope["headers"] = []
        self.assertFalse(host_allowed(scope, {"www.nodpilot.com"}))

    def test_testserver_allowed_only_under_pytest(self):
        import os

        scope = _scope(host="testserver")
        self.assertTrue(host_allowed(scope, {"www.nodpilot.com"}))
        previous = os.environ.get("PYTEST_CURRENT_TEST")
        try:
            os.environ.pop("PYTEST_CURRENT_TEST", None)
            self.assertFalse(host_allowed(scope, {"www.nodpilot.com"}))
        finally:
            if previous is not None:
                os.environ["PYTEST_CURRENT_TEST"] = previous


class AllowedHostsTests(unittest.TestCase):
    def test_apex_public_url_also_allows_www(self):
        hosts = _allowed_hosts("https://nodpilot.com")
        self.assertIn("nodpilot.com", hosts)
        self.assertIn("www.nodpilot.com", hosts)

    def test_www_public_url_also_allows_apex(self):
        hosts = _allowed_hosts("https://www.nodpilot.com")
        self.assertIn("www.nodpilot.com", hosts)
        self.assertIn("nodpilot.com", hosts)

    def test_local_public_url_keeps_lock_off(self):
        with mock.patch.dict("os.environ", {"ALLOWED_HOSTS": ""}, clear=False):
            self.assertEqual(_allowed_hosts("http://127.0.0.1:9320"), set())

    def test_railway_host_does_not_gain_www_sibling(self):
        hosts = _allowed_hosts("https://nod-web-production.up.railway.app")
        self.assertIn("nod-web-production.up.railway.app", hosts)
        self.assertNotIn("www.nod-web-production.up.railway.app", hosts)


class HostLockMiddlewareTests(unittest.TestCase):
    def _run(self, mw: HostLockMiddleware, scope: dict) -> int:
        out: dict = {}

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(msg):
            if msg["type"] == "http.response.start":
                out["status"] = msg["status"]
            elif msg["type"] == "websocket.close":
                out["status"] = msg.get("code", 1000)

        import asyncio

        asyncio.run(mw(scope, receive, send))
        return out.get("status", 0)

    def _middleware(self, enabled: bool = True, allowed: set | None = None) -> HostLockMiddleware:
        mw = HostLockMiddleware.__new__(HostLockMiddleware)
        mw.enabled = enabled
        mw.allowed = allowed if allowed is not None else {"www.nodpilot.com"}
        mw.app = mock.AsyncMock()
        mw.app.side_effect = lambda scope, receive, send: None
        return mw

    def test_foreign_host_gets_403(self):
        code = self._run(self._middleware(), _scope(host="nod-web-production.up.railway.app"))
        self.assertEqual(code, 403)

    def test_whitelisted_host_passes(self):
        mw = self._middleware()
        code = self._run(mw, _scope(host="www.nodpilot.com"))
        self.assertEqual(code, 0)  # reached the app, no early reject
        mw.app.assert_awaited_once()

    def test_health_path_stays_open(self):
        mw = self._middleware()
        code = self._run(mw, _scope(path="/api/health", host="nod-web-production.up.railway.app"))
        self.assertEqual(code, 0)
        mw.app.assert_awaited_once()

    def test_websocket_foreign_host_closed_4403(self):
        code = self._run(self._middleware(), _scope(host="nod-web-production.up.railway.app", stype="websocket"))
        self.assertEqual(code, 4403)

    def test_disabled_middleware_lets_everything_through(self):
        mw = self._middleware(enabled=False)
        code = self._run(mw, _scope(host="nod-web-production.up.railway.app"))
        self.assertEqual(code, 0)
        mw.app.assert_awaited_once()


class GlobalRateLimitTests(unittest.TestCase):
    def test_global_window_rejects_over_limit(self):
        key = f"gtest-{__import__('time').time()}"
        limit, window = 3, 60
        for _ in range(3):
            self.assertTrue(allow(f"global:{key}", limit, window))
        self.assertFalse(allow(f"global:{key}", limit, window))

    def test_rate_limit_global_uses_global_key(self):
        from fastapi import HTTPException

        key = f"grl-{__import__('time').time()}"
        check = rate_limit_global(key, 2, 60)
        check()  # 1
        check()  # 2
        with self.assertRaises(HTTPException) as ctx:
            check()  # 3 -> 429
        self.assertEqual(ctx.exception.status_code, 429)


class GlobalWsLimitTests(unittest.TestCase):
    def tearDown(self):
        from server import ratelimit

        ratelimit._ws_total = 0
        ratelimit._ws_conns.clear()

    def test_global_cap_rejects_when_full(self):
        from server import ratelimit

        with mock.patch.object(ratelimit, "MAX_WS_TOTAL", 4):
            ok = [ws_connect(f"10.0.0.{i}") for i in range(4)]
            self.assertTrue(all(ok))
            # fifth connection from a fresh IP must be refused by the global cap
            self.assertFalse(ws_connect("10.0.0.99"))
            ws_disconnect("10.0.0.0")
            self.assertTrue(ws_connect("10.0.0.99"))

    def test_per_ip_cap_still_applies(self):
        from server import ratelimit

        with mock.patch.object(ratelimit, "MAX_WS_TOTAL", 1000):
            for _ in range(ratelimit.MAX_WS_CONNS):
                self.assertTrue(ws_connect("10.1.1.1"))
            self.assertFalse(ws_connect("10.1.1.1"))

    def test_disconnect_without_connect_does_not_loosen_cap(self):
        from server import ratelimit

        with mock.patch.object(ratelimit, "MAX_WS_TOTAL", 2):
            self.assertTrue(ws_connect("10.0.0.1"))
            self.assertTrue(ws_connect("10.0.0.2"))
            ws_disconnect("10.9.9.9")
            self.assertFalse(ws_connect("10.0.0.3"))


if __name__ == "__main__":
    unittest.main()
