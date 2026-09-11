import unittest

from starlette.testclient import TestClient

from server.cors import CAPACITOR_ORIGINS, cors_origins


class CorsOriginsTests(unittest.TestCase):
    def test_dev_and_capacitor_origins_always_present(self):
        origins = cors_origins(None)
        self.assertIn("http://127.0.0.1:5174", origins)
        self.assertIn("capacitor://localhost", origins)
        self.assertIn("ionic://localhost", origins)
        self.assertIn("https://localhost", origins)
        self.assertEqual(set(CAPACITOR_ORIGINS), set(CAPACITOR_ORIGINS) & set(origins))

    def test_public_url_pairs_www(self):
        origins = cors_origins("https://nodpilot.com")
        self.assertIn("https://nodpilot.com", origins)
        self.assertIn("https://www.nodpilot.com", origins)
        self.assertIn("capacitor://localhost", origins)


class CorsCredentialHeadersTests(unittest.TestCase):
    def setUp(self):
        from server.app import app

        self.client = TestClient(app)

    def test_allowed_origin_gets_credentials(self):
        origin = "http://127.0.0.1:5174"
        res = self.client.get("/api/health", headers={"Origin": origin})
        self.assertEqual(res.headers.get("access-control-allow-origin"), origin)
        self.assertEqual(res.headers.get("access-control-allow-credentials"), "true")

    def test_disallowed_origin_has_no_credentials(self):
        res = self.client.get("/api/health", headers={"Origin": "https://evil.example"})
        self.assertIsNone(res.headers.get("access-control-allow-origin"))
        self.assertIsNone(res.headers.get("access-control-allow-credentials"))

    def test_disallowed_preflight_has_no_credentials(self):
        res = self.client.options(
            "/api/health",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
            },
        )
        self.assertEqual(res.status_code, 400)
        self.assertIsNone(res.headers.get("access-control-allow-origin"))
        self.assertIsNone(res.headers.get("access-control-allow-credentials"))


if __name__ == "__main__":
    unittest.main()
