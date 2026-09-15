import base64
import os
import unittest
from unittest import mock

from fastapi import HTTPException

from server.clerk_auth import (
    _azp_allowed,
    _frontend_api,
    _issuer_allowed,
    clerk_browser_hosts,
    clerk_js_filename_allowed,
    clerk_js_source_url,
    load_clerk_browser_js,
    load_clerk_js_asset,
    reset_clerk_js_cache,
)


def _live_key(host: str) -> str:
    payload = base64.b64encode(f"{host}$".encode("ascii")).decode("ascii").rstrip("=")
    return f"pk_live_{payload}"


class ClerkCustomDomainTests(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("CLERK_PUBLISHABLE_KEY", None)

    def test_frontend_api_from_live_key(self):
        os.environ["CLERK_PUBLISHABLE_KEY"] = _live_key("clerk.nodpilot.com")
        self.assertEqual(_frontend_api(), "clerk.nodpilot.com")

    def test_browser_hosts_include_satellite(self):
        os.environ["CLERK_PUBLISHABLE_KEY"] = _live_key("clerk.nodpilot.com")
        hosts = clerk_browser_hosts()
        self.assertIn("clerk.nodpilot.com", hosts)
        self.assertIn("accounts.nodpilot.com", hosts)

    def test_issuer_allows_custom_frontend_api(self):
        os.environ["CLERK_PUBLISHABLE_KEY"] = _live_key("clerk.nodpilot.com")
        self.assertTrue(_issuer_allowed("https://clerk.nodpilot.com"))
        self.assertFalse(_issuer_allowed("https://evil.example"))

    def test_clerk_js_url_stays_on_frontend_api(self):
        os.environ["CLERK_PUBLISHABLE_KEY"] = _live_key("clerk.nodpilot.com")
        self.assertEqual(
            clerk_js_source_url(),
            "https://clerk.nodpilot.com/npm/@clerk/clerk-js@5/dist/clerk.browser.js",
        )
        self.assertEqual(
            clerk_js_source_url("ui-common_clerk.browser_0cc2cc_5.127.2.js"),
            "https://clerk.nodpilot.com/npm/@clerk/clerk-js@5/dist/ui-common_clerk.browser_0cc2cc_5.127.2.js",
        )

    def test_clerk_js_filename_allowlist(self):
        self.assertTrue(clerk_js_filename_allowed("clerk.browser.js"))
        self.assertTrue(clerk_js_filename_allowed("framework_clerk.browser_0cc2cc_5.127.2.js"))
        self.assertTrue(clerk_js_filename_allowed("ui-common_clerk.browser_0cc2cc_5.127.2.js"))
        self.assertFalse(clerk_js_filename_allowed("../clerk.browser.js"))
        self.assertFalse(clerk_js_filename_allowed("evil.js"))
        self.assertFalse(clerk_js_filename_allowed("framework_clerk.browser_0cc2cc_5.127.2.js/../x"))


class ClerkJsProxyTests(unittest.TestCase):
    def setUp(self):
        reset_clerk_js_cache()
        os.environ["CLERK_PUBLISHABLE_KEY"] = _live_key("clerk.nodpilot.com")

    def tearDown(self):
        reset_clerk_js_cache()
        os.environ.pop("CLERK_PUBLISHABLE_KEY", None)

    def test_rejects_html_challenge(self):
        fake = mock.Mock(status_code=200, content=b"<!doctype html><html>challenge</html>", headers={"content-type": "text/html"})
        with mock.patch("server.clerk_auth.httpx.get", return_value=fake):
            with self.assertRaises(HTTPException) as raised:
                load_clerk_browser_js()
        self.assertEqual(raised.exception.status_code, 502)

    def test_rejects_unknown_clerk_js_file(self):
        with self.assertRaises(HTTPException) as raised:
            load_clerk_js_asset("not-clerk.js")
        self.assertEqual(raised.exception.status_code, 404)

    def test_caches_javascript(self):
        body = b"!" + (b"clerk" * 3000)
        fake = mock.Mock(status_code=200, content=body, headers={"content-type": "application/javascript"})
        with mock.patch("server.clerk_auth.httpx.get", return_value=fake) as get:
            first, media = load_clerk_browser_js()
            second, _ = load_clerk_browser_js()
        self.assertEqual(first, body)
        self.assertEqual(second, body)
        self.assertEqual(media, "application/javascript")
        self.assertEqual(get.call_count, 1)


class ClerkAzpTests(unittest.TestCase):
    def setUp(self):
        os.environ["CLERK_PUBLISHABLE_KEY"] = _live_key("clerk.nodpilot.com")

    def tearDown(self):
        os.environ.pop("CLERK_PUBLISHABLE_KEY", None)

    def test_allows_nod_origins_and_capacitor(self):
        with mock.patch("server.clerk_auth.PUBLIC_URL", "https://nodpilot.com"):
            issuer = "https://clerk.nodpilot.com"
            self.assertTrue(_azp_allowed("https://nodpilot.com", issuer))
            self.assertTrue(_azp_allowed("https://www.nodpilot.com", issuer))
            self.assertTrue(_azp_allowed("https://clerk.nodpilot.com", issuer))
            self.assertTrue(_azp_allowed("https://accounts.nodpilot.com", issuer))
            self.assertTrue(_azp_allowed("capacitor://localhost", issuer))
            self.assertTrue(_azp_allowed("ionic://localhost", issuer))
            self.assertTrue(_azp_allowed("https://localhost", issuer))
            self.assertTrue(_azp_allowed("http://127.0.0.1:5174", issuer))
            self.assertTrue(_azp_allowed("", issuer))

    def test_rejects_request_origin_and_railway(self):
        with mock.patch("server.clerk_auth.PUBLIC_URL", "https://nodpilot.com"):
            issuer = "https://clerk.nodpilot.com"
            self.assertFalse(_azp_allowed("https://evil.example", issuer))
            self.assertFalse(_azp_allowed("https://nod-web-production.up.railway.app", issuer))
            self.assertFalse(_azp_allowed("https://foo.clerk.accounts.dev", issuer))


class ClerkProxyGoneTests(unittest.TestCase):
    def test_fapi_proxy_path_is_not_mounted(self):
        from starlette.testclient import TestClient

        from server.app import app
        from server.commerce import router

        paths = [getattr(route, "path", "") for route in router.routes]
        self.assertFalse(any(path.startswith("/__clerk") for path in paths))
        res = TestClient(app).get("/__clerk/v1/environment")
        self.assertEqual(res.status_code, 404)
