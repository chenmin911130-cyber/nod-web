"""Issue #165 review P2-8: an expired/terminated session rejects late audio.

A session that is decisively over (closed, or listen stolen/stopped with no
listener, no handoff, not paused) must reject a trailing pcm_end and trailing PCM
with the ORIGINAL session + capture identity, so the Watch ends its drain wait
and shows "补传未完成" instead of waiting out the timeout. A transient rebuild,
Pause's late frames, or a live mismatched session must NOT be reported as expired.
"""
from __future__ import annotations

import json
import unittest
from unittest import mock

from server import uplink
from server.app import CFG, Session, _reset_live_stt


def _session(user_id: str = "user-a") -> Session:
    sess = Session(lambda _ev: None, json.loads(json.dumps(CFG)), {}, user_id)
    sess.close = mock.Mock()  # type: ignore[method-assign]
    return sess


class ExpiredRejectTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def tearDown(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def _live(self, sess: Session) -> None:
        sess.usage_session_id = "sess-live"
        sess._listen_wanted = True
        sess._listen_started_at = 0.0
        sess._consent_ok = True
        sess._pcm_rx_bytes = 3200
        sess._stt_tx_bytes = 3200
        sess._listener = mock.Mock()

    def _terminate_session(self, sess: Session) -> None:
        """Bring the session to a decisively-over state (listen ended/stopped)."""
        sess._listen_wanted = False
        sess._paused = False
        sess._listener = None
        sess._handoff_listener = None
        sess._stt_pending_pcm = b""
        sess._listen_ended = True

    def test_expired_end_rejected_with_identity(self) -> None:
        sess = _session()
        self._terminate_session(sess)
        native = mock.Mock()
        sess._send_audio_text = native
        events: list[dict] = []
        sess.emit = events.append
        sess.usage_session_id = "sess-live"  # the (now-terminated) session id
        sess.pcm_end("sess-live", 3200, "cap-a")
        self.assertTrue(native.called, "expired End must reach the native path")
        sent = native.call_args[0][0]
        self.assertEqual(sent["type"], "pcm_rejected")
        self.assertEqual(sent["id"], "sess-live")
        self.assertEqual(sent["capture_id"], "cap-a")
        self.assertIn("补传未完成", sent["text"])
        # No drain may be attempted on a dead session.
        self.assertIsNone(getattr(sess, "_pcm_drain_result", None))

    def test_expired_end_with_old_session_id_rejected(self) -> None:
        """A backfilled End whose id no longer matches the current session still
        rejects with its ORIGINAL identity (not the current session's)."""
        sess = _session()
        self._terminate_session(sess)
        native = mock.Mock()
        sess._send_audio_text = native
        sess.usage_session_id = "sess-new"  # a NEW session took over
        sess.pcm_end("sess-old", 3200, "cap-old")
        sent = native.call_args[0][0]
        self.assertEqual(sent["type"], "pcm_rejected")
        self.assertEqual(sent["id"], "sess-old")
        self.assertEqual(sent["capture_id"], "cap-old")

    def test_expired_pcm_rejected_once(self) -> None:
        sess = _session()
        self._terminate_session(sess)
        sess.usage_session_id = "sess-live"
        sess._listen_wanted = False
        sess._consent_ok = True
        native = mock.Mock()
        sess._send_audio_text = native
        sess.push_pcm(b"\x01" * 1600)
        self.assertTrue(native.called, "trailing PCM on a terminated session must reject")
        self.assertEqual(native.call_args[0][0]["type"], "pcm_rejected")
        native.reset_mock()
        sess.push_pcm(b"\x02" * 1600)
        self.assertFalse(native.called, "reject is single-shot, not spammed per frame")

    def test_paused_session_not_terminated(self) -> None:
        """Pause's late frames must NOT be reported as an expired error."""
        sess = _session()
        self._live(sess)
        sess._paused = True
        sess._listener = None
        sess._handoff_listener = None
        self.assertFalse(sess._session_terminated())

    def test_transient_rebuild_not_terminated(self) -> None:
        """A handoff in progress is still accepting audio, not expired."""
        sess = _session()
        self._live(sess)
        sess._listen_wanted = True
        sess._handoff_listener = mock.Mock()
        self.assertFalse(sess._session_terminated())

    def test_live_but_mismatched_end_ignored_not_rejected(self) -> None:
        """A live/different session must not be rejected by a leftover End."""
        sess = _session()
        self._live(sess)
        native = mock.Mock()
        sess._send_audio_text = native
        events: list[dict] = []
        sess.emit = events.append
        # A mismatched id against a STILL-LIVE session is silently ignored.
        sess.pcm_end("sess-other", 3200, "cap-x")
        self.assertFalse(native.called)
        self.assertEqual(events, [])

    def test_repeated_successful_end_still_republishes(self) -> None:
        """A repeated End of an ALREADY-confirmed drain re-publishes the saved
        result, even though the session is now over — a reconnect must keep it."""
        sess = _session()
        self._live(sess)
        sess.emit = mock.Mock()
        sess.pcm_end("sess-live", 3200, "cap-a")
        saved = sess._pcm_drain_result
        self.assertIsNotNone(saved)
        self._terminate_session(sess)
        events: list[dict] = []
        sess.emit = events.append
        native = mock.Mock()
        sess._send_audio_text = native
        sess.pcm_end("sess-live", 3200, "cap-a")
        self.assertEqual(
            [e for e in events if e.get("type") == "pcm_drained"],
            [{"type": "pcm_drained", "id": "sess-live", "capture_id": "cap-a", "byte_offset": 3200}],
        )
        # A saved success is re-published over the native path (a reconnect must
        # keep the confirm) — it is NOT converted into a rejection.
        sent = native.call_args[0][0]
        self.assertEqual(sent["type"], "pcm_drained")
        self.assertEqual(sent["capture_id"], "cap-a")


if __name__ == "__main__":
    unittest.main()
