"""When R2 is not configured, Keep recording still stores WAV on disk."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from server import r2
from server.r2 import pcm_to_wav


class LocalAudioStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.root = self.tmp / "audio-store"
        self.patches = [
            mock.patch.object(r2, "cloud_enabled", return_value=False),
            mock.patch.object(r2, "_local_root", return_value=self.root),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self) -> None:
        for item in self.patches:
            item.stop()

    def test_put_get_list_roundtrip(self):
        wav = pcm_to_wav(b"\x00\x01" * 32)
        key = "users/u1/sessions/s1/audio/part-001.wav"
        self.assertTrue(r2.put_bytes(key, wav, "audio/wav"))
        self.assertEqual(r2.get_bytes(key)[:12], wav[:12])
        self.assertTrue(wav.startswith(b"RIFF"))
        keys = r2.list_keys("users/u1/sessions/s1/audio/")
        self.assertEqual(keys, [key])

    def test_rejects_path_escape(self):
        with self.assertRaises(ValueError):
            r2._local_path("../secret.wav")
        self.assertFalse(r2.put_bytes("../secret.wav", b"nope", "audio/wav"))

    def test_keep_history_writes_wav_without_r2(self):
        from server.app import SR, Session

        pcm = b"\x00\x01" * (SR + 64)
        sess = Session.__new__(Session)
        sess.user_id = "user-1"
        sess.usage_session_id = "sess-1"
        sess._consent_ok = True
        sess._archive_fp = None
        sess._archive_path = None
        sess._archive_bytes = 0
        sess._archive_total = 0
        sess._archive_part = 1
        sess.emit = mock.Mock()
        sess.pipeline = mock.Mock()
        with (
            mock.patch.object(r2, "cloud_enabled", return_value=False),
            mock.patch.object(r2, "_local_root", return_value=self.root),
            mock.patch("server.meter.set_session_file"),
            mock.patch("server.meter.write_session_notes"),
            mock.patch("server.meter.keep_usage_session") as keep,
        ):
            sess._archive_append(pcm)
            sess.keep_history()
        keep.assert_called_once_with("user-1", "sess-1", keep_content=True, keep_audio=True)
        keys = r2.list_keys("users/user-1/sessions/sess-1/audio/")
        self.assertEqual(keys, ["users/user-1/sessions/sess-1/audio/part-001.wav"])
        wav = r2.get_bytes(keys[0])
        self.assertTrue(wav.startswith(b"RIFF"))
        self.assertEqual(wav[8:12], b"WAVE")
