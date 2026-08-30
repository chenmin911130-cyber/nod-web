import base64
import os
import unittest

from server.clerk_auth import _frontend_api, _issuer_allowed, clerk_browser_hosts


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
