import unittest
from urllib.parse import parse_qs, urlparse


def token_from_app_url(url: str) -> str:
    """Mirror of web/src/native.ts tokenFromAppUrl for the nodpilot:// scheme."""
    parsed = urlparse(url)
    if parsed.scheme != "nodpilot":
        return ""
    host = parsed.hostname or parsed.netloc
    path = parsed.path.lstrip("/")
    if host != "auth" and path != "auth":
        return ""
    return parse_qs(parsed.query).get("token", [""])[0]


class NativeAuthUrlTests(unittest.TestCase):
    def test_token_from_scheme(self):
        self.assertEqual(token_from_app_url("nodpilot://auth?token=abc"), "abc")
        self.assertEqual(token_from_app_url("nodpilot://auth/?token=xyz"), "xyz")

    def test_rejects_other_hosts(self):
        self.assertEqual(token_from_app_url("https://nodpilot.com/login?token=abc"), "")
        self.assertEqual(token_from_app_url("nodpilot://other?token=abc"), "")


if __name__ == "__main__":
    unittest.main()
