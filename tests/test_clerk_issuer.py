import unittest
from unittest import mock

from server.clerk_auth import _issuer_allowed


class IssuerFailClosedTests(unittest.TestCase):
    def test_issuer_rejected_when_frontend_api_missing(self):
        # Without a publishable key we cannot know the legitimate Clerk issuer,
        # so any issuer must be rejected rather than accepted on a substring
        # like "clerk" or ".accounts.dev" (an attacker controls that issuer's
        # JWKS, so a fail-open here lets a self-signed token through).
        with mock.patch("server.clerk_auth._frontend_api", return_value=""):
            self.assertFalse(_issuer_allowed("https://clerk.accounts.dev"))
            self.assertFalse(_issuer_allowed("https://clerk.evil.com"))
            self.assertFalse(_issuer_allowed("https://evil-clerk.example.com"))

    def test_issuer_still_accepts_configured_frontend_api(self):
        with mock.patch("server.clerk_auth._frontend_api", return_value="clerk.nodpilot.com"):
            self.assertTrue(_issuer_allowed("https://clerk.nodpilot.com"))
            self.assertFalse(_issuer_allowed("https://evil.example"))
