import unittest

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


if __name__ == "__main__":
    unittest.main()
