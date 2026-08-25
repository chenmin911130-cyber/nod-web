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
        client = TestClient(_app())
        self.assertEqual(client.get("/").status_code, 200)

    def test_origin_lock_blocks_direct_except_health(self):
        os.environ["REQUIRE_CLOUDFLARE"] = "1"
        self.addCleanup(lambda: os.environ.pop("REQUIRE_CLOUDFLARE", None))
        client = TestClient(_app())
        blocked = client.get("/")
        self.assertEqual(blocked.status_code, 403)
        health = client.get("/api/health")
        self.assertEqual(health.status_code, 200)
        allowed = client.get("/", headers={"cf-ray": "abc-SFO"})
        self.assertEqual(allowed.status_code, 200)


if __name__ == "__main__":
    unittest.main()
