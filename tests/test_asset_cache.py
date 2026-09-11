import tempfile
import unittest
from pathlib import Path

from starlette.applications import Starlette
from starlette.testclient import TestClient

from server.app import ASSET_CACHE, HTML_NO_CACHE, ImmutableStaticFiles, app


class HashedAssetCacheTests(unittest.TestCase):
    def test_hashed_assets_are_immutable(self):
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            (folder / "main-test.js").write_text("ok", encoding="utf-8")
            inner = Starlette()
            inner.mount("/assets", ImmutableStaticFiles(directory=str(folder)))
            res = TestClient(inner).get("/assets/main-test.js")
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.headers["cache-control"], ASSET_CACHE)
            self.assertIn("immutable", res.headers["cache-control"])

    def test_html_stays_uncached(self):
        res = TestClient(app).get("/robots.txt")
        self.assertNotEqual(res.headers.get("cache-control", ""), ASSET_CACHE)
        self.assertEqual(HTML_NO_CACHE["Cache-Control"], "no-store, no-cache, must-revalidate, max-age=0")


if __name__ == "__main__":
    unittest.main()
