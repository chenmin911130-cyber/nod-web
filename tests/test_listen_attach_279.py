"""#279: a control re-attach must not open a second /ws/audio or seal the open line.

Real-device 121 (Axios) evidence:

* `/ws?attach=` re-ran ``reattach``, which re-announced ``audio_uplink`` while the
  native uplink was still streaming, so the phone opened a SECOND ``/ws/audio``.
* A transient control drop closed the still-listening session, which flushed an
  empty ``listen_flush`` and cleared the open meeting line, so the next final came
  back ``new/closed`` and the transcript fragmented.
* ``split_meeting_turn`` handed every piece the whole turn's word clock, producing
  negative inter-piece ``gap_ms`` (turn 0: -8416).

These tests use the production websocket endpoints; the meeting pieces are driven
through the real ``Session`` (no fake minisession), with ``user_id=None`` so no
history/metering runs.
"""

from __future__ import annotations

import json
import time
import unittest
from datetime import datetime, timezone

from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server import uplink
from server.app import CFG, KEYS, Session, _reset_live_stt
from server.db import User, db_session
from server.meeting_lines import gap_ms, segment_meta, split_meeting_turn
from server.security import issue_jwt, new_id
from server.settings import COOKIE_NAME


def _noop(_ev: dict) -> None:
    return None


class _Collector:
    def __init__(self) -> None:
        self.events: list[dict] = []

    def __call__(self, ev: dict) -> None:
        self.events.append(ev)

    def of(self, type_: str) -> list[dict]:
        return [e for e in self.events if e.get("type") == type_]


def _session(user_id: str | None = None) -> Session:
    sink = _Collector()
    sess = Session(sink, json.loads(json.dumps(CFG)), dict(KEYS), user_id)
    sess._test_sink = sink
    return sess


WELCOME_THANKS = (
    "Mr. President, welcome to the Axios Show. Thank you. We wanted to make this more "
    "of a conversation than a typical interview where we're just going to hop around "
    "from topic to topic, and we wanted to do Axios likes to do one big thing. And so "
    "the one big thing we want to talk about is power and how you think about it and "
    "how you wield it."
)

TURN_META = {"first_word_ms": 1000, "last_word_ms": 30000, "n_words": 40, "turn_order": 1}


def _segment_offsets(text: str, parts: list[str]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    cursor = 0
    for piece in parts:
        start = text.find(piece, cursor)
        if start < 0:
            start = cursor
        end = start + len(piece)
        out.append((start, end))
        cursor = end
    return out


class SegmentMetaTests(unittest.TestCase):
    """#279 requirement 3: every inline split piece gets its own clock."""

    def test_segment_meta_interpolates_and_scales(self) -> None:
        meta = segment_meta({"first_word_ms": 1000, "last_word_ms": 5000, "n_words": 10}, "abcdefghij", 5, 10)
        self.assertEqual(meta["first_word_ms"], 3000)
        self.assertEqual(meta["last_word_ms"], 5000)
        self.assertEqual(meta["n_words"], 5)

    def test_segment_meta_without_span_drops_stale_clock(self) -> None:
        meta = segment_meta({"first_word_ms": None, "last_word_ms": 9000, "n_words": 10}, "abcdefghij", 5, 10)
        self.assertIsNone(meta["first_word_ms"])
        self.assertIsNone(meta["last_word_ms"])
        self.assertEqual(meta["n_words"], 5)

    def test_inline_split_pieces_never_compare_a_negative_gap(self) -> None:
        parts = split_meeting_turn(WELCOME_THANKS)
        self.assertGreaterEqual(len(parts), 3, "the Axios welcome splits at least three ways")
        metas = [segment_meta(TURN_META, WELCOME_THANKS, s, e) for s, e in _segment_offsets(WELCOME_THANKS, parts)]
        for i in range(1, len(metas)):
            self.assertGreaterEqual(
                metas[i]["first_word_ms"], metas[i - 1]["last_word_ms"], "piece clocks stay monotonic"
            )
            prev_open = {
                "text": parts[i - 1],
                "speaker": "B",
                "opened_at": 0.0,
                "last_final_at": 0.0,
                "last_word_ms": metas[i - 1]["last_word_ms"],
            }
            nxt = {
                "text": parts[i],
                "speaker": "B",
                "first_word_ms": metas[i]["first_word_ms"],
                "last_word_ms": metas[i]["last_word_ms"],
            }
            gap = gap_ms(prev_open, nxt, 0.0)
            self.assertIsNotNone(gap)
            self.assertGreaterEqual(gap[0], 0.0, f"piece {i} gap must not be negative")

    def test_inline_split_emits_separate_lines_through_session(self) -> None:
        sess = _session()
        sess._hold_or_emit_meeting(WELCOME_THANKS, "en", "B", dict(TURN_META))
        texts = [e["text"] for e in sess._test_sink.of("question")]
        self.assertGreaterEqual(len(texts), 3)
        self.assertTrue(any("Thank you" in t for t in texts))
        # The line opened after the split carries the tail's own clock, never the
        # whole turn's first word.
        self.assertIsNotNone(sess._open_line)


class ClosedLineContinuationTests(unittest.TestCase):
    """#279 requirement 2 regression: a wrongly-closed line must still extend."""

    def test_closed_same_speaker_tiny_gap_extends(self) -> None:
        from server.meeting_lines import decide_full

        prev = {
            "id": "q1",
            "text": "and that is the whole point.",
            "speaker": "B",
            "opened_at": 0.0,
            "last_final_at": 0.0,
            "last_word_ms": 10000,
            "n_words": 7,
            "rev": 1,
            "closed": True,
        }
        nxt = {
            "text": "we wanted to make this more of a conversation",
            "speaker": "B",
            "first_word_ms": 10081,
            "last_word_ms": 13000,
            "n_words": 9,
        }
        self.assertEqual(decide_full(prev, nxt, 0.0), ("extend", "closed_continuation"))

    def test_closed_speaker_flip_still_new(self) -> None:
        from server.meeting_lines import decide_full

        prev = {
            "id": "q1",
            "text": "and that is the whole point.",
            "speaker": "B",
            "opened_at": 0.0,
            "last_final_at": 0.0,
            "last_word_ms": 10000,
            "n_words": 7,
            "rev": 1,
            "closed": True,
        }
        nxt = {
            "text": "What do you mean by that?",
            "speaker": "A",
            "first_word_ms": 10081,
            "last_word_ms": 12000,
            "n_words": 6,
        }
        self.assertEqual(decide_full(prev, nxt, 0.0), ("new", "closed"))

    def test_closed_long_gap_still_new(self) -> None:
        from server.meeting_lines import decide_full

        prev = {
            "id": "q1",
            "text": "and that is the whole point.",
            "speaker": "B",
            "opened_at": 0.0,
            "last_final_at": 0.0,
            "last_word_ms": 10000,
            "n_words": 7,
            "rev": 1,
            "closed": True,
        }
        nxt = {
            "text": "Meanwhile the other story",
            "speaker": "B",
            "first_word_ms": 14500,
            "last_word_ms": 17000,
            "n_words": 4,
        }
        self.assertEqual(decide_full(prev, nxt, 0.0), ("new", "closed"))

    def test_session_extends_closed_line_on_next_same_speaker_final(self) -> None:
        sess = _session()
        # Turn 1 opens without a sentence end.
        sess._hold_or_emit_meeting(
            "the one big thing we want to talk about", "en", "B",
            {"first_word_ms": 1000, "last_word_ms": 5000, "n_words": 9},
        )
        self.assertIsNotNone(sess._open_line)
        self.assertNotEqual(sess._open_line.get("closed"), True)
        # Turn 2 extends and carries a sentence end at the very end, so §1.1
        # absorbs it and marks the line closed (no tail to open).
        sess._hold_or_emit_meeting(
            "is power and how you think about it.", "en", "B",
            {"first_word_ms": 5081, "last_word_ms": 8000, "n_words": 8},
        )
        self.assertTrue(sess._open_line.get("closed"))
        # 81ms later the same speaker continues: this must extend, not start new.
        before_q = len(sess._test_sink.of("question"))
        before_up = len(sess._test_sink.of("line_update"))
        sess._hold_or_emit_meeting(
            "and so the one big thing we want to talk about is power", "en", "B",
            {"first_word_ms": 8081, "last_word_ms": 12000, "n_words": 12},
        )
        self.assertEqual(len(sess._test_sink.of("question")), before_q, "closed line extended, no new row")
        self.assertEqual(len(sess._test_sink.of("line_update")), before_up + 1)
        self.assertNotEqual(sess._open_line.get("closed"), True)


class ReattachTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def tearDown(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def test_reattach_does_not_reannounce_or_seal_while_listening(self) -> None:
        events: list[dict] = []
        sess = Session(events.append, json.loads(json.dumps(CFG)), dict(KEYS), "owner")
        sess._listener = object()
        sess._uplink_connected = True
        sess._open_line = {"id": "q1", "text": "half a sentence", "speaker": "B", "rev": 0}
        open_before = dict(sess._open_line)
        uplink.register(sess)
        sess.reattach()
        self.assertFalse(any(e["type"] == "audio_uplink" for e in events))
        self.assertFalse(any(e["type"] == "listen_flush" for e in events))
        self.assertEqual(sess._open_line, open_before)
        self.assertEqual(sess._listen_flush_seq, 0)

    def test_reattach_reannounces_only_when_the_uplink_is_gone(self) -> None:
        events: list[dict] = []
        sess = Session(events.append, json.loads(json.dumps(CFG)), dict(KEYS), "owner")
        sess._listener = object()
        sess._uplink_connected = False
        sess._uplink_seen = True
        uplink.register(sess)
        sess.reattach()
        tokens = [e["token"] for e in events if e["type"] == "audio_uplink"]
        self.assertEqual(tokens, [sess.audio_token])


class ParkAndAdoptTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def tearDown(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def test_should_park_keeps_a_listening_session_whose_uplink_was_seen(self) -> None:
        sess = _session()
        sess._listener = object()
        sess._uplink_connected = False
        sess._uplink_seen = True
        self.assertTrue(uplink.should_park(sess))

    def test_should_park_still_false_without_any_uplink(self) -> None:
        sess = _session()
        sess._listener = object()
        sess._uplink_connected = False
        sess._uplink_seen = False
        self.assertFalse(uplink.should_park(sess))

    def test_adopt_takes_the_live_session_before_its_park(self) -> None:
        sess = _session("owner")
        sess._listener = object()
        sess._uplink_connected = True
        uplink.register(sess)
        # The previous control socket has not reached its finally yet (not parked).
        self.assertFalse(uplink.is_parked(sess.audio_token))
        self.assertIs(uplink.adopt(sess.audio_token, "owner"), sess)

    def test_adopt_rejects_a_closed_session(self) -> None:
        sess = _session("owner")
        sess._closed = True
        uplink.register(sess)
        self.assertIsNone(uplink.adopt(sess.audio_token, "owner"))


def _wait_until(pred, timeout: float = 2.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return
        time.sleep(0.01)
    raise AssertionError("timed out")


def _drain_until(ws, typ: str, limit: int = 40) -> list[dict]:
    events: list[dict] = []
    for _ in range(limit):
        ev = ws.receive_json()
        events.append(ev)
        if ev.get("type") == typ:
            return events
    raise AssertionError(f"no {typ} in {[e.get('type') for e in events]}")


def _authed_client() -> tuple[TestClient, str]:
    from server.app import app

    uid = new_id()
    email = f"{uid}@test.local"
    with db_session() as db:
        db.add(User(id=uid, email=email, password_hash="", recording_consent_at=datetime.now(timezone.utc)))
    token = issue_jwt(uid, email)
    client = TestClient(app)
    client.cookies.set(COOKIE_NAME, token)
    return client, uid


class ControlReattachWsTests(unittest.TestCase):
    def setUp(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def tearDown(self) -> None:
        uplink.reset()
        _reset_live_stt()

    def test_attach_reuses_the_live_session_and_a_superseded_socket_cannot_kill_it(self) -> None:
        client, _uid = _authed_client()
        ctrl_cm = client.websocket_connect("/ws")
        control = ctrl_cm.__enter__()
        token = next(e["token"] for e in _drain_until(control, "audio_uplink") if e.get("type") == "audio_uplink")
        audio_cm = client.websocket_connect(f"/ws/audio?token={token}")
        audio_cm.__enter__()
        try:
            sess = uplink.get(token)
            self.assertIsNotNone(sess)
            sess._listener = object()
            _wait_until(lambda: bool(sess._uplink_connected))
            with client.websocket_connect(f"/ws?attach={token}") as control2:
                attached = _drain_until(control2, "attached")
                self.assertIs(uplink.get(token), sess, "attach reuses the same Session")
                self.assertFalse(
                    any(e.get("type") == "audio_uplink" for e in attached),
                    "attach while the uplink is live must not re-announce the token",
                )
                # The superseded control socket closes. It must not park/close the
                # session or silence the socket that now owns it (#279).
                ctrl_cm.__exit__(None, None, None)
                ctrl_cm = None
                time.sleep(0.1)
                self.assertIs(uplink.get(token), sess)
                self.assertIsNotNone(sess._listener)
                self.assertEqual(sess._listen_flush_seq, 0, "no empty listen_flush on attach")
                self.assertFalse(uplink.is_parked(token), "the new control socket owns it, not a park")
                sess.emit({"type": "status", "text": "still-live"})
                live = _drain_until(control2, "status")
                self.assertTrue(any(e.get("text") == "still-live" for e in live))
        finally:
            if ctrl_cm is not None:
                ctrl_cm.__exit__(None, None, None)
            audio_cm.__exit__(None, None, None)

    def test_control_close_parks_a_seen_uplink_session_instead_of_stopping(self) -> None:
        client, _uid = _authed_client()
        ctrl_cm = client.websocket_connect("/ws")
        control = ctrl_cm.__enter__()
        token = next(e["token"] for e in _drain_until(control, "audio_uplink") if e.get("type") == "audio_uplink")
        audio_cm = client.websocket_connect(f"/ws/audio?token={token}")
        audio_cm.__enter__()
        try:
            sess = uplink.get(token)
            sess._listener = object()
            _wait_until(lambda: bool(sess._uplink_connected))
            # The audio socket is momentarily gone while the phone is listening;
            # the control drop must keep the session instead of stopping it.
            sess._uplink_connected = False
            ctrl_cm.__exit__(None, None, None)
            ctrl_cm = None
            _wait_until(lambda: uplink.is_parked(token))
            self.assertIsNotNone(sess._listener)
            self.assertEqual(sess._listen_flush_seq, 0)
            self.assertFalse(getattr(sess, "_closed", False))
        finally:
            if ctrl_cm is not None:
                ctrl_cm.__exit__(None, None, None)
            audio_cm.__exit__(None, None, None)

    def test_second_audio_ws_while_one_is_live_is_refused(self) -> None:
        client, _uid = _authed_client()
        ctrl_cm = client.websocket_connect("/ws")
        control = ctrl_cm.__enter__()
        token = next(e["token"] for e in _drain_until(control, "audio_uplink") if e.get("type") == "audio_uplink")
        audio_cm = client.websocket_connect(f"/ws/audio?token={token}")
        audio_cm.__enter__()
        try:
            sess = uplink.get(token)
            _wait_until(lambda: bool(sess._uplink_connected))
            first = sess._audio_ws
            self.assertIsNotNone(first)
            with self.assertRaises(WebSocketDisconnect) as ctx:
                with client.websocket_connect(f"/ws/audio?token={token}"):
                    pass
            self.assertEqual(ctx.exception.code, 4409)
            self.assertIs(sess._audio_ws, first, "the live audio socket is not replaced")
        finally:
            audio_cm.__exit__(None, None, None)
            ctrl_cm.__exit__(None, None, None)


if __name__ == "__main__":
    unittest.main()
