import unittest
from unittest import mock

from server.meter import _session_files
from server.r2 import pcm_to_wav


class SessionFilesTests(unittest.TestCase):
    def test_pcm_to_wav_is_riff(self):
        wav = pcm_to_wav(b"\x00\x01" * 8)
        self.assertTrue(wav.startswith(b"RIFF"))
        self.assertEqual(wav[8:12], b"WAVE")

    def test_missing_prefix_parts_are_not_listed(self):
        with mock.patch("server.r2.list_keys", return_value=[]):
            files = _session_files("s1", "users/u1/s1/", "", "meeting", "meeting", None)
        self.assertFalse(any(item["kind"] == "audio" for item in files))
