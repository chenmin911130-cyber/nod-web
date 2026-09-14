import base64
import os
import unittest
from unittest import mock

from fastapi import HTTPException

from server.clerk_auth import (
    _frontend_api,
    _issuer_allowed,
    clerk_browser_hosts,
    clerk_js_source_url,
    load_clerk_browser_js,
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
