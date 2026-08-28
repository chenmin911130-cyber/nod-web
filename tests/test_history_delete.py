import unittest
from unittest import mock


class DeleteHistoryTests(unittest.TestCase):
    def _db(self, row):
        db = mock.MagicMock()
        db.get.return_value = row
        cm = mock.MagicMock()
        cm.__enter__.return_value = db
        cm.__exit__.return_value = False
        return cm

    def test_delete_own_session(self):
        from server.meter import delete_history_session

        row = mock.Mock(user_id="me")
        with (
            mock.patch("server.meter.db_session", return_value=self._db(row)),
            mock.patch("server.meter.discard_usage_session") as discard,
        ):
            self.assertTrue(delete_history_session("me", "s1"))
            discard.assert_called_once_with("me", "s1")

    def test_delete_rejects_other_user(self):
        from server.meter import delete_history_session

        row = mock.Mock(user_id="other")
        with (
            mock.patch("server.meter.db_session", return_value=self._db(row)),
            mock.patch("server.meter.discard_usage_session") as discard,
        ):
            self.assertFalse(delete_history_session("me", "s1"))
            discard.assert_not_called()

    def test_delete_missing_session(self):
        from server.meter import delete_history_session

        with (
            mock.patch("server.meter.db_session", return_value=self._db(None)),
            mock.patch("server.meter.discard_usage_session") as discard,
        ):
            self.assertFalse(delete_history_session("me", "s1"))
            discard.assert_not_called()
