import os
import unittest

from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from server.headers import (
    HSTS,
    CloudflareOriginMiddleware,
    SecurityHeadersMiddleware,
    content_security_policy,
)


def _app():
    async def home(_request):
        return PlainTextResponse("ok")

    async def health(_request):
        return PlainTextResponse("ok")

    inner = Starlette(
        routes=[
            Route("/", home),
            Route("/api/health", health),
        ]
    )
    return SecurityHeadersMiddleware(CloudflareOriginMiddleware(inner))


class SecurityHeadersTests(unittest.TestCase):
    def test_baseline_headers_on_http(self):
        client = TestClient(_app())
        res = client.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["x-content-type-options"], "nosniff")
        self.assertEqual(res.headers["x-frame-options"], "DENY")
        self.assertEqual(res.headers["referrer-policy"], "strict-origin-when-cross-origin")
        self.assertIn("microphone=(self)", res.headers["permissions-policy"])
        self.assertIn("camera=()", res.headers["permissions-policy"])
        csp = res.headers["content-security-policy"]
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertIn("object-src 'none'", csp)
        self.assertNotIn("https:", csp.split("default-src", 1)[1].split(";", 1)[0])
        self.assertNotIn("Strict-Transport-Security", res.headers)

    def test_hsts_only_on_https(self):
        client = TestClient(_app())
        res = client.get("/", headers={"x-forwarded-proto": "https"})
        self.assertEqual(res.headers["strict-transport-security"], HSTS)

    def test_origin_lock_off_by_default(self):
        os.environ.pop("REQUIRE_CLOUDFLARE", None)
        os.environ.pop("ORIGIN_SECRET", None)
        client = TestClient(_app())
        self.assertEqual(client.get("/").status_code, 200)

    def test_origin_lock_blocks_direct_except_health(self):
        os.environ.pop("ORIGIN_SECRET", None)
        os.environ["REQUIRE_CLOUDFLARE"] = "1"
        self.addCleanup(lambda: os.environ.pop("REQUIRE_CLOUDFLARE", None))
        client = TestClient(_app())
        blocked = client.get("/")
        self.assertEqual(blocked.status_code, 403)
        health = client.get("/api/health")
        self.assertEqual(health.status_code, 200)
        spoofed = client.get("/", headers={"cf-ray": "abc-SFO"})
        self.assertEqual(spoofed.status_code, 403)

    def test_origin_secret_beats_spoofed_cf_ray(self):
        os.environ["ORIGIN_SECRET"] = "origin-test-secret"
        os.environ.pop("REQUIRE_CLOUDFLARE", None)
        self.addCleanup(lambda: os.environ.pop("ORIGIN_SECRET", None))
        client = TestClient(_app())
        self.assertEqual(client.get("/", headers={"cf-ray": "spoofed"}).status_code, 403)
        self.assertEqual(client.get("/api/health").status_code, 200)
        self.assertEqual(client.get("/", headers={"x-nod-origin": "wrong"}).status_code, 403)
        self.assertEqual(client.get("/", headers={"x-nod-origin": "origin-test-secret"}).status_code, 200)

    def test_csp_allows_clerk_custom_domain_from_live_key(self):
        import base64

        payload = base64.b64encode(b"clerk.nodpilot.com$").decode("ascii").rstrip("=")
        os.environ["CLERK_PUBLISHABLE_KEY"] = f"pk_live_{payload}"
        self.addCleanup(lambda: os.environ.pop("CLERK_PUBLISHABLE_KEY", None))
        client = TestClient(_app())
        csp = client.get("/").headers["content-security-policy"]
        self.assertIn("https://clerk.nodpilot.com", csp)
        self.assertIn("https://accounts.nodpilot.com", csp)
        self.assertIn("wss://clerk.nodpilot.com", csp)
        self.assertIn("clerk.nodpilot.com", content_security_policy())

    def test_csp_allows_cloudflare_insights_and_google_gsi_style(self):
        csp = content_security_policy()
        script = csp.split("script-src", 1)[1].split(";", 1)[0]
        style = csp.split("style-src", 1)[1].split(";", 1)[0]
        connect = csp.split("connect-src", 1)[1].split(";", 1)[0]
        self.assertIn("https://static.cloudflareinsights.com", script)
        self.assertIn("https://accounts.google.com", style)
        self.assertIn("https://cloudflareinsights.com", connect)

    def test_csp_allows_clerk_protect_hosts(self):
        csp = content_security_policy()
        script = csp.split("script-src", 1)[1].split(";", 1)[0]
        connect = csp.split("connect-src", 1)[1].split(";", 1)[0]
        frame = csp.split("frame-src", 1)[1].split(";", 1)[0]
        self.assertIn("https://*.protect.clerk.com", script)
        self.assertIn("https://*.protect.clerk.com:*", connect)
        self.assertIn("https://*.protect.clerk.com", frame)


if __name__ == "__main__":
    unittest.main()
