import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from server.site_seo import inject_site_seo, site_canonical_url, site_shell_path

SHELL = """<!doctype html>
<html lang="en">
  <head>
    <link rel="canonical" href="https://nodpilot.com/" />
    <link rel="alternate" hreflang="en" href="https://nodpilot.com/" />
    <link rel="alternate" hreflang="zh-Hans" href="https://nodpilot.com/zh" />
    <link rel="alternate" hreflang="x-default" href="https://nodpilot.com/" />
    <meta property="og:url" content="https://nodpilot.com/" />
  </head>
</html>
"""


class SiteSeoHelpersTests(unittest.TestCase):
    def test_site_shell_path_normalizes_zh_variants(self):
        self.assertEqual(site_shell_path(""), "/")
        self.assertEqual(site_shell_path("zh"), "/zh")
        self.assertEqual(site_shell_path("zh/"), "/zh")
        self.assertEqual(site_shell_path("privacy"), "/privacy")

    def test_site_canonical_url_matches_site_origin_rules(self):
        base = "https://nodpilot.com"
        self.assertEqual(site_canonical_url(base, "/"), "https://nodpilot.com/")
        self.assertEqual(site_canonical_url(base, "zh"), "https://nodpilot.com/zh")
        self.assertEqual(site_canonical_url(base, "privacy"), "https://nodpilot.com/privacy")

    def test_inject_site_seo_sets_page_canonical_and_hreflang_cluster(self):
        out = inject_site_seo(SHELL, "https://nodpilot.com", "/zh")
        self.assertIn('<link rel="canonical" href="https://nodpilot.com/zh" />', out)
        self.assertIn('<link rel="alternate" hreflang="en" href="https://nodpilot.com/" />', out)
        self.assertIn('<link rel="alternate" hreflang="zh-Hans" href="https://nodpilot.com/zh" />', out)
        self.assertIn('<meta property="og:url" content="https://nodpilot.com/zh" />', out)
        self.assertIn('<html lang="zh-Hans"', out)

    def test_inject_site_seo_sets_legal_page_canonical(self):
        out = inject_site_seo(SHELL, "https://nodpilot.com", "privacy")
        self.assertIn('<link rel="canonical" href="https://nodpilot.com/privacy" />', out)
        self.assertIn('<meta property="og:url" content="https://nodpilot.com/privacy" />', out)


@unittest.skipUnless(Path("web/dist/index.html").exists(), "frontend build required for site HTML routes")
class SiteSeoResponseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from server.app import app
        from server.settings import PUBLIC_URL

        cls.client = TestClient(app)
        cls.public_url = PUBLIC_URL.rstrip("/")

    def test_public_pages_emit_own_canonical_in_initial_html(self):
        cases = {
            "/": f"{self.public_url}/",
            "/zh": f"{self.public_url}/zh",
            "/privacy": f"{self.public_url}/privacy",
            "/terms": f"{self.public_url}/terms",
            "/consent": f"{self.public_url}/consent",
        }
        for path, canonical in cases.items():
            res = self.client.get(path)
            self.assertEqual(res.status_code, 200, path)
            self.assertIn(f'<link rel="canonical" href="{canonical}" />', res.text, path)

    def test_zh_hreflang_cluster_present_on_zh_landing(self):
        res = self.client.get("/zh")
        self.assertIn(f'<link rel="alternate" hreflang="en" href="{self.public_url}/" />', res.text)
        self.assertIn(f'<link rel="alternate" hreflang="zh-Hans" href="{self.public_url}/zh" />', res.text)


if __name__ == "__main__":
    unittest.main()
