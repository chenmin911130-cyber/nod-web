import unittest

from server.app import WEB_DIST, spa_kind, static_media_type


class SpaKindTests(unittest.TestCase):
    def test_known_marketing_pages_are_site(self):
        for path in ("privacy", "/privacy", "zh", "login", "terms", "zh/extra"):
            self.assertEqual(spa_kind(path), "site", path)

    def test_workspace_is_app(self):
        self.assertEqual(spa_kind("app"), "app")
        self.assertEqual(spa_kind("app/listen"), "app")

    def test_unknown_api_is_api(self):
        self.assertEqual(spa_kind("api/sessions"), "api")
        self.assertEqual(spa_kind("api/pricing"), "api")
        self.assertEqual(spa_kind("api"), "api")

    def test_garbage_is_unknown(self):
        self.assertEqual(spa_kind("nonexistent-xyz"), "unknown")
        self.assertEqual(spa_kind("../../requirements.txt"), "unknown")

    def test_webp_is_image_webp(self):
        self.assertEqual(static_media_type("landing/hero-meeting.webp"), "image/webp")
        self.assertEqual(static_media_type("/landing/hero-meeting-768.webp"), "image/webp")
        self.assertIsNone(static_media_type("readme"))


@unittest.skipUnless(WEB_DIST.exists(), "frontend build required for the SPA catch-all route")
class SpaHttpTests(unittest.TestCase):
    def setUp(self):
        from starlette.testclient import TestClient

        from server.app import app

        self.client = TestClient(app)

    def test_unknown_path_is_html_404(self):
        res = self.client.get("/nonexistent-xyz")
        self.assertEqual(res.status_code, 404)
        self.assertIn("text/html", res.headers["content-type"])
        self.assertIn("noindex", res.text.lower())
        self.assertNotIn("Listen. Understand. Remember.", res.text)

    def test_unknown_api_is_json_404(self):
        res = self.client.get("/api/sessions")
        self.assertEqual(res.status_code, 404)
        self.assertIn("application/json", res.headers["content-type"])
        self.assertEqual(res.json()["detail"], "Not found")

    def test_privacy_still_serves_the_spa(self):
        res = self.client.get("/privacy")
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/html", res.headers["content-type"])


if __name__ == "__main__":
    unittest.main()
