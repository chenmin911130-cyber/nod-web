import tempfile
import unittest
from contextlib import contextmanager
from unittest import mock

from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker

from server.db import Base, UsageSession, User


class KeepUsageSessionNullKeyTests(unittest.TestCase):
    """Fresh create_all makes audio_key/notes_key NOT NULL. None must not be written."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.engine = create_engine(f"sqlite:///{self.tmp.name}/nod.db")
        Base.metadata.create_all(self.engine)
        cols = {c["name"]: c for c in inspect(self.engine).get_columns("usage_sessions")}
        self.assertFalse(cols["audio_key"]["nullable"], "fresh audio_key must be NOT NULL")
        self.assertFalse(cols["notes_key"]["nullable"], "fresh notes_key must be NOT NULL")
        Local = sessionmaker(bind=self.engine, autoflush=False, autocommit=False, expire_on_commit=False)

        @contextmanager
        def isolated():
            s = Local()
            try:
                yield s
                s.commit()
            except Exception:
                s.rollback()
                raise
            finally:
                s.close()

        self.isolated = isolated
        with isolated() as db:
            db.add(User(id="u1", email="keep@test.local"))
            db.add(UsageSession(id="s1", user_id="u1", audio_key="users/u1/sessions/s1/audio/a.wav", notes_key="users/u1/sessions/s1/notes.txt"))

    def test_keep_without_audio_does_not_write_null(self) -> None:
        from server.meter import keep_usage_session

        with mock.patch("server.meter.db_session", self.isolated), mock.patch("server.r2.delete_prefix"):
            keep_usage_session("u1", "s1", keep_content=True, keep_audio=False)
        with self.isolated() as db:
            row = db.get(UsageSession, "s1")
            self.assertIsNotNone(row)
            self.assertTrue(row.kept)
            self.assertEqual(row.audio_key, "")
            self.assertTrue(row.notes_key)

    def test_keep_without_content_does_not_write_null(self) -> None:
        from server.meter import keep_usage_session

        with mock.patch("server.meter.db_session", self.isolated), mock.patch("server.r2.delete_prefix"):
            keep_usage_session("u1", "s1", keep_content=False, keep_audio=True)
        with self.isolated() as db:
            row = db.get(UsageSession, "s1")
            self.assertIsNotNone(row)
            self.assertTrue(row.kept)
            self.assertEqual(row.notes_key, "")
            self.assertTrue(row.audio_key)
