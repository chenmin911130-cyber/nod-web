import base64
import os
import unittest
from unittest import mock

import httpx

from fastapi import HTTPException

from server.clerk_auth import (
    _frontend_api,
    _issuer_allowed,
    clerk_browser_hosts,
    clerk_client_ip,
    clerk_fapi_target,
    clerk_js_filename_allowed,
    clerk_js_source_url,
    clerk_proxy_public_url,
    enable_clerk_fapi_proxy,
    forward_clerk_fapi,
    load_clerk_browser_js,
    load_clerk_js_asset,
    reset_clerk_js_cache,
    rewrite_clerk_location,
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


class ClerkFapiProxyTests(unittest.TestCase):
    def setUp(self):
        os.environ["CLERK_PUBLISHABLE_KEY"] = _live_key("clerk.nodpilot.com")
        os.environ["PUBLIC_URL"] = "https://nodpilot.com"
        os.environ["CLERK_SECRET_KEY"] = "sk_test_proxy"

    def tearDown(self):
        for key in ("CLERK_PUBLISHABLE_KEY", "PUBLIC_URL", "CLERK_SECRET_KEY"):
            os.environ.pop(key, None)

    def test_target_url(self):
        self.assertEqual(
            clerk_fapi_target("v1/client/sign_ins"),
            "https://clerk.nodpilot.com/v1/client/sign_ins",
        )
        self.assertEqual(clerk_proxy_public_url(), "https://nodpilot.com/__clerk")

    def test_rejects_dotdot_and_absolute_url(self):
        with self.assertRaises(HTTPException) as raised:
            clerk_fapi_target("../v1/client")
        self.assertEqual(raised.exception.status_code, 400)
        with self.assertRaises(HTTPException) as raised:
            clerk_fapi_target("https://evil.example/v1")
        self.assertEqual(raised.exception.status_code, 400)

    def test_client_ip_prefers_cloudflare(self):
        ip = clerk_client_ip(
            {"X-Forwarded-For": "1.1.1.1, 2.2.2.2", "CF-Connecting-IP": "203.0.113.9"},
            "10.0.0.1",
        )
        self.assertEqual(ip, "203.0.113.9")

    def test_client_ip_ignores_spoofed_xff(self):
        ip = clerk_client_ip({"X-Forwarded-For": "1.1.1.1"}, "10.0.0.1")
        self.assertEqual(ip, "10.0.0.1")

    def test_location_rewrite(self):
        self.assertEqual(
            rewrite_clerk_location(
                "https://clerk.nodpilot.com/v1/client",
                "clerk.nodpilot.com",
                "https://nodpilot.com/__clerk",
            ),
            "https://nodpilot.com/__clerk/v1/client",
        )
        self.assertEqual(
            rewrite_clerk_location(
                "https://frontend-api.clerk.dev/v1/oauth",
                "clerk.nodpilot.com",
                "https://nodpilot.com/__clerk",
            ),
            "https://nodpilot.com/__clerk/v1/oauth",
        )

    def test_forwards_required_headers(self):
        captured: dict = {}
        fake = mock.Mock()
        fake.status_code = 200
        fake.content = b'{"ok":true}'
        fake.headers = httpx.Headers(
            {
                "content-type": "application/json",
                "location": "https://clerk.nodpilot.com/v1/x",
            }
        )

        def capture(_method, url, **kwargs):
            captured["url"] = url
            captured["headers"] = kwargs["headers"]
            return fake

        with mock.patch("server.clerk_auth.httpx.request", side_effect=capture):
            res = forward_clerk_fapi(
                "POST",
                "v1/client/sign_ins",
                "__clerk_api_version=2025-11-10",
                b"{}",
                {
                    "cf-connecting-ip": "203.0.113.9",
                    "content-type": "application/json",
                    "cdn-loop": "cloudflare; loops=1",
                    "cf-ray": "abc123",
                    "cf-visitor": '{"scheme":"https"}',
                },
                "10.0.0.1",
            )
        self.assertEqual(
            captured["url"],
            "https://clerk.nodpilot.com/v1/client/sign_ins?__clerk_api_version=2025-11-10",
        )
        self.assertEqual(captured["headers"]["Clerk-Proxy-Url"], "https://nodpilot.com/__clerk")
        self.assertEqual(captured["headers"]["Clerk-Secret-Key"], "sk_test_proxy")
        self.assertEqual(captured["headers"]["X-Forwarded-For"], "203.0.113.9")
        self.assertNotIn("cdn-loop", {k.lower() for k in captured["headers"]})
        self.assertNotIn("cf-ray", {k.lower() for k in captured["headers"]})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["location"], "https://nodpilot.com/__clerk/v1/x")

    def test_clears_dashboard_proxy_url(self):
        listed = mock.Mock()
        listed.raise_for_status = mock.Mock()
        listed.json.return_value = {
            "data": [
                {
                    "id": "dmn_1",
                    "name": "nodpilot.com",
                    "frontend_api_url": "https://clerk.nodpilot.com",
                    "proxy_url": "https://nodpilot.com/__clerk",
                }
            ]
        }
        patched = mock.Mock(status_code=200, text="{}")
        with (
            mock.patch("server.clerk_auth.clerk_proxy_enable_allowed", return_value=True),
            mock.patch("server.clerk_auth.httpx.get", return_value=listed) as get,
            mock.patch("server.clerk_auth.httpx.patch", return_value=patched) as patch,
        ):
            enable_clerk_fapi_proxy()
        get.assert_called_once()
        patch.assert_called_once()
        self.assertIsNone(patch.call_args.kwargs["json"]["proxy_url"])

    def test_leaves_unrelated_proxy_url(self):
        listed = mock.Mock()
        listed.raise_for_status = mock.Mock()
        listed.json.return_value = {
            "data": [
                {
                    "id": "dmn_1",
                    "name": "nodpilot.com",
                    "frontend_api_url": "https://clerk.nodpilot.com",
                    "proxy_url": "https://other.example/proxy",
                }
            ]
        }
        with (
            mock.patch("server.clerk_auth.clerk_proxy_enable_allowed", return_value=True),
            mock.patch("server.clerk_auth.httpx.get", return_value=listed),
            mock.patch("server.clerk_auth.httpx.patch") as patch,
        ):
            enable_clerk_fapi_proxy()
        patch.assert_not_called()
