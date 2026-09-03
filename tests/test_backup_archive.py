import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from server.app import SR, Session
from server.logging_setup import BACKUP_KEEP_DAYS, BACKUP_MAX_FILES, backup_now, prune_backups


class SqliteBackupTests(unittest.TestCase):
    def test_backup_includes_wal_writes_that_copy2_would_miss(self):
        tmp = Path(tempfile.mkdtemp())
        src = tmp / "nod.db"
        dest_dir = tmp / "backups"
        dest_dir.mkdir()
        conn = sqlite3.connect(src)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA wal_autocheckpoint=0")
        conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, v TEXT)")
        conn.execute("INSERT INTO items(v) VALUES ('checkpointed')")
        conn.commit()
        conn.execute("INSERT INTO items(v) VALUES ('still-in-wal')")
        conn.commit()
        self.assertTrue((tmp / "nod.db-wal").exists())

        with (
            mock.patch("server.logging_setup.DATA_DIR", tmp),
            mock.patch("server.logging_setup.database_url", return_value=f"sqlite:///{src.as_posix()}"),
            mock.patch("server.logging_setup.is_sqlite", return_value=True),
        ):
            dest = backup_now()
        self.assertIsNotNone(dest)
        assert dest is not None
        copied = sqlite3.connect(dest)
        rows = {row[0] for row in copied.execute("SELECT v FROM items")}
        copied.close()
        conn.close()
        self.assertIn("checkpointed", rows)
        self.assertIn("still-in-wal", rows)

    def test_prune_keeps_thirty_days_and_caps_file_count(self):
        self.assertGreaterEqual(BACKUP_KEEP_DAYS, 30)
        self.assertGreaterEqual(BACKUP_MAX_FILES, 30)
        tmp = Path(tempfile.mkdtemp()) / "backups"
        tmp.mkdir()
        now = time.time()
        old = tmp / "nod-20200101-000000.db"
        old.write_bytes(b"old")
        os.utime(old, (now - 40 * 86400, now - 40 * 86400))
        for i in range(BACKUP_MAX_FILES + 5):
            p = tmp / f"nod-202608{i:02d}-000000.db"
            p.write_bytes(b"x")
            os.utime(p, (now - i * 3600, now - i * 3600))
        prune_backups(tmp)
        left = list(tmp.glob("nod-*.db"))
        self.assertNotIn(old, left)
        self.assertLessEqual(len(left), BACKUP_MAX_FILES)


class ArchiveUploadTests(unittest.TestCase):
    def test_failed_r2_upload_keeps_local_pcm(self):
        tmp = Path(tempfile.mkdtemp())
        pcm = tmp / "part.pcm"
        pcm.write_bytes(b"\x00" * (SR * 2 + 64))
        sess = Session.__new__(Session)
        sess.user_id = "user-1"
        sess.usage_session_id = "sess-1"
        sess._archive_fp = None
        sess._archive_path = str(pcm)
        sess._archive_bytes = SR * 2 + 64
        sess._archive_part = 1
        sess._archive_total = SR * 2 + 64
        with mock.patch("server.r2.put_bytes", return_value=False):
            self.assertFalse(sess._upload_current_part())
        sess._archive_close(unlink=False)
        self.assertTrue(pcm.exists())

    def test_put_bytes_returns_false_on_client_error(self):
        from server import r2

        with (
            mock.patch.object(r2, "cloud_enabled", return_value=True),
            mock.patch.object(r2, "_client") as client,
        ):
            client.return_value.put_object.side_effect = RuntimeError("network")
            self.assertFalse(r2.put_bytes("k", b"body", "audio/wav"))

    def test_flush_does_not_delete_pcm_when_upload_fails(self):
        tmp = Path(tempfile.mkdtemp())
        pcm = tmp / "part.pcm"
        pcm.write_bytes(b"\x00" * (SR * 2 + 64))
        sess = Session.__new__(Session)
        sess.user_id = "user-1"
        sess.usage_session_id = "sess-1"
        sess._archive_fp = None
        sess._archive_path = str(pcm)
        sess._archive_bytes = SR * 2 + 64
        sess._archive_part = 1
        sess._archive_total = SR * 2 + 64
        with (
            mock.patch("server.r2.enabled", return_value=True),
            mock.patch.object(sess, "_upload_current_part", return_value=False),
            mock.patch("server.meter.write_session_notes"),
        ):
            sess._flush_cloud_archive(final=True)
        self.assertTrue(pcm.exists())

    def test_flush_deletes_pcm_when_upload_succeeds(self):
        tmp = Path(tempfile.mkdtemp())
        pcm = tmp / "part.pcm"
        pcm.write_bytes(b"\x00" * (SR * 2 + 64))
        sess = Session.__new__(Session)
        sess.user_id = "user-1"
        sess.usage_session_id = "sess-1"
        sess._archive_fp = None
        sess._archive_path = str(pcm)
        sess._archive_bytes = SR * 2 + 64
        sess._archive_part = 1
        sess._archive_total = SR * 2 + 64
        with (
            mock.patch("server.r2.enabled", return_value=True),
            mock.patch.object(sess, "_upload_current_part", return_value=True),
            mock.patch("server.meter.write_session_notes"),
        ):
            sess._flush_cloud_archive(final=True)
        self.assertFalse(pcm.exists())

    def test_rotate_keeps_pcm_when_upload_fails(self):
        tmp = Path(tempfile.mkdtemp())
        pcm = tmp / "part.pcm"
        pcm.write_bytes(b"\x00" * (SR * 2 + 64))
        sess = Session.__new__(Session)
        sess._archive_fp = None
        sess._archive_path = str(pcm)
        sess._archive_bytes = SR * 2 + 64
        sess._archive_part = 1
        with mock.patch.object(sess, "_upload_current_part", return_value=False):
            sess._archive_rotate()
        self.assertTrue(pcm.exists())
        self.assertEqual(sess._archive_part, 2)
