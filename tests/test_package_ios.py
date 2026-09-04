import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "package-ios.sh"


class PackageIosTests(unittest.TestCase):
    def test_script_exists(self):
        self.assertTrue(SCRIPT.is_file())

    def test_linux_exits_with_mac_instructions(self):
        if sys.platform == "darwin":
            self.skipTest("this host is a Mac; the Darwin path is for the user's machine")
        proc = subprocess.run(
            ["bash", str(SCRIPT)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 1)
        self.assertIn("Mac", proc.stderr)
        self.assertIn("npm run cap:ios", proc.stderr)
        self.assertNotIn("xcodebuild", proc.stderr.lower())


if __name__ == "__main__":
    unittest.main()
