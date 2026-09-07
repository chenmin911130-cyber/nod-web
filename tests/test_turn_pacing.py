"""Translate ForceEndpoint pacing and sentence-tail carry (#105)."""
from __future__ import annotations

import json
import threading
import unittest
from collections import deque
from unittest import mock

from server.app import CloudListener, Session
from server.meeting_lines import join_meeting_text
from server.turn_pacing import cut_decision, split_carry, turn_pacing_from_env, word_span_ms

from tests.test_stt_terminate import _connected_ws


CFG = {"min_ms": 7000, "gap_ms": 350, "max_ms": 15000}


def _words(open_ms: int, gap_ms: int) -> list[dict]:
    """Two words whose span matches open_ms / gap_ms."""
    # w0: start=0 end=open_ms-gap_ms-something...
    # open = w1.end - w0.start = open_ms
    # gap = w1.start - w0.end = gap_ms
    w0_end = max(0, open_ms - 200)
    w1_start = w0_end + gap_ms
    w1_end = open_ms  # since w0.start = 0
    if w1_start > w1_end:
        w1_end = w1_start + 50
    return [
        {"start": 0, "end": w0_end, "text": "aaa"},
        {"start": w1_start, "end": w1_end, "text": "bbb"},
    ]


class CutDecisionTests(unittest.TestCase):
    def test_too_short_even_with_a_gap(self):
        self.assertEqual(cut_decision(_words(5000, 800), CFG, False), "none")

    def test_pause_cut(self):
        self.assertEqual(cut_decision(_words(8000, 400), CFG, False), "pause")

    def test_long_enough_but_gap_too_small(self):
        self.assertEqual(cut_decision(_words(8000, 120), CFG, False), "none")

    def test_max_cut_ignores_gap(self):
        self.assertEqual(cut_decision(_words(15500, 120), CFG, False), "max")

    def test_inflight_blocks(self):
        self.assertEqual(cut_decision(_words(8000, 400), CFG, True), "none")

    def test_one_word(self):
        self.assertEqual(cut_decision([{"start": 0, "end": 8000}], CFG, False), "none")

    def test_missing_end(self):
        self.assertEqual(
            cut_decision([{"start": 0}, {"start": 8000, "end": 8300}], CFG, False),
            "none",
        )

    def test_word_span_none_on_short(self):
        self.assertEqual(word_span_ms([{"start": 0, "end": 10}]), (None, None))


class SplitCarryTests(unittest.TestCase):
    def test_latin_sentence_then_tail(self):
        head, tail = split_carry("We finished the video. Now let's talk about")
        self.assertEqual(head, "We finished the video.")
        self.assertEqual(tail, "Now let's talk about")

    def test_false_period_stays_in_tail(self):
        head, tail = split_carry("make sure to stay in.")
        self.assertEqual(head, "")
        self.assertEqual(tail, "make sure to stay in.")

    def test_cjk_sentence(self):
        head, tail = split_carry("这是第一句。然后我们")
        self.assertEqual(head, "这是第一句。")
        self.assertEqual(tail, "然后我们")

    def test_no_sentence_end(self):
        head, tail = split_carry("We know exactly")
        self.assertEqual(head, "")
        self.assertEqual(tail, "We know exactly")


class TurnPacingEnvTests(unittest.TestCase):
    def test_defaults(self):
        with mock.patch.dict("os.environ", {
            "NOD_TR_CUT_MIN_MS": "",
            "NOD_TR_CUT_GAP_MS": "",
            "NOD_TR_CUT_MAX_MS": "",
        }):
            cfg = turn_pacing_from_env()
        self.assertEqual(cfg["min_ms"], 7000)
        self.assertEqual(cfg["gap_ms"], 350)
        self.assertEqual(cfg["max_ms"], 15000)


class CloudListenerPacingTests(unittest.TestCase):
    def _partial(self, open_ms: int, gap_ms: int) -> str:
        words = _words(open_ms, gap_ms)
        return json.dumps({
            "type": "Turn",
            "end_of_turn": False,
            "transcript": "hello there",
            "words": words,
        })

    def _listener(self, pacing: bool) -> CloudListener:
        stt: dict = {}
        if pacing:
            stt["turn_pacing"] = dict(CFG)
        return CloudListener(
            api_key="test-key",
            cfg={"stt": stt},
            on_final=lambda *a: None,
            on_partial=lambda *a: None,
            on_error=None,
        )

    def _run_sender(self, lst: CloudListener, timeout: float = 0.25) -> None:
        lst._stop.clear()
        t = threading.Thread(target=lst._sender, daemon=True)
        t.start()
        t.join(timeout)
        lst._stop.set()
        t.join(0.5)

    def test_pause_partial_sends_force_endpoint_text_frame(self):
        lst = self._listener(True)
        ws = _connected_ws()
        lst._ws = ws
        lst._on_message(None, self._partial(8000, 400))
        self._run_sender(lst, 0.2)
        texts = [
            json.loads(c[0][0])
            for c in ws.send.call_args_list
            if c[0] and isinstance(c[0][0], str)
        ]
        self.assertIn({"type": "ForceEndpoint"}, texts)

    def test_does_not_resend_while_inflight(self):
        lst = self._listener(True)
        ws = _connected_ws()
        lst._ws = ws
        lst._on_message(None, self._partial(8000, 400))
        lst._flush_force_endpoint()
        ws.send.reset_mock()
        lst._on_message(None, self._partial(12000, 400))
        lst._flush_force_endpoint()
        texts = [
            json.loads(c[0][0])
            for c in ws.send.call_args_list
            if c[0] and isinstance(c[0][0], str)
        ]
        self.assertEqual(texts, [])

    def test_formatted_eot_clears_inflight(self):
        lst = self._listener(True)
        ws = _connected_ws()
        lst._ws = ws
        lst._on_message(None, self._partial(8000, 400))
        lst._flush_force_endpoint()
        lst._on_message(None, json.dumps({
            "type": "Turn",
            "end_of_turn": True,
            "turn_is_formatted": True,
            "transcript": "hello there.",
            "words": _words(8000, 400),
        }))
        self.assertEqual(lst._force_inflight, 0.0)
        ws.send.reset_mock()
        lst._on_message(None, self._partial(8000, 400))
        lst._flush_force_endpoint()
        texts = [
            json.loads(c[0][0])
            for c in ws.send.call_args_list
            if c[0] and isinstance(c[0][0], str)
        ]
        self.assertIn({"type": "ForceEndpoint"}, texts)

    def test_meeting_cfg_sends_no_text_frame(self):
        lst = self._listener(False)
        ws = _connected_ws()
        lst._ws = ws
        lst._on_message(None, self._partial(8000, 400))
        lst._flush_force_endpoint()
        texts = [
            c for c in ws.send.call_args_list
            if c[0] and isinstance(c[0][0], str)
        ]
        self.assertEqual(texts, [])


class _Emitter:
    def __init__(self) -> None:
        self.events: list[dict] = []

    def __call__(self, ev: dict) -> None:
        self.events.append(ev)


def _translate_session() -> Session:
    sess = Session.__new__(Session)
    sess.emit = _Emitter()
    sess.cfg = {"stt": {}, "ui": {}}
    sess._workspace = "translate"
    sess._translate_carry = ""
    sess._recent_finals = []
    sess._pending_q = deque(maxlen=8)
    sess._pending_wait = (None, 0.0, None)
    sess._follow_lang = None
    sess._follow_switch_lang = None
    sess._follow_switch_hits = 0
    sess._paused = False
    sess._manual = False
    sess._listener = None
    sess._listen_wanted = False
    sess._maybe_follow_speech = lambda *a, **k: None
    sess._mark_voice = lambda *a, **k: None
    sess._speech_allowed = lambda *a, **k: True
    sess._offer_save_history = lambda *a, **k: None
    sess._emit_phase = lambda *a, **k: None
    qid = iter(range(1, 100))

    class _Pipe:
        _last_answer = ""

        def _new_qid(self):
            return f"q{next(qid)}"

    sess.pipeline = _Pipe()
    return sess


class TranslateCarrySessionTests(unittest.TestCase):
    def test_no_sentence_holds_carry(self):
        sess = _translate_session()
        sess._on_final("We know exactly")
        qs = [e for e in sess.emit.events if e["type"] == "question"]
        self.assertEqual(qs, [])
        self.assertEqual(sess._translate_carry, "We know exactly")

    def test_next_final_emits_joined_head(self):
        sess = _translate_session()
        sess._on_final("We know exactly")
        sess._on_final("where to go. And then")
        qs = [e for e in sess.emit.events if e["type"] == "question"]
        self.assertEqual(len(qs), 1)
        want = join_meeting_text("We know exactly", "where to go.")
        self.assertEqual(qs[0]["text"], want)
        self.assertEqual(sess._translate_carry, "And then")

    def test_second_join_without_sentence_emits_all(self):
        sess = _translate_session()
        sess._on_final("We know exactly")
        sess._on_final("where to go. And then")
        sess.emit.events.clear()
        sess._on_final("keep walking toward")
        qs = [e for e in sess.emit.events if e["type"] == "question"]
        self.assertEqual(len(qs), 1)
        want = join_meeting_text("And then", "keep walking toward")
        self.assertEqual(qs[0]["text"], want)
        self.assertEqual(sess._translate_carry, "")

    def test_stop_listen_flushes_carry(self):
        sess = _translate_session()
        sess._on_final("We know exactly")
        sess.emit.events.clear()
        sess.stop_listen()
        qs = [e for e in sess.emit.events if e["type"] == "question"]
        self.assertEqual(len(qs), 1)
        self.assertEqual(qs[0]["text"], "We know exactly")
        self.assertEqual(sess._translate_carry, "")

    def test_meeting_does_not_use_carry(self):
        sess = _translate_session()
        sess._workspace = "meeting"
        sess._enqueue_meeting_final = mock.Mock()
        sess._on_final("We know exactly")
        sess._on_final("where to go. And then")
        sess._enqueue_meeting_final.assert_called()
        self.assertEqual(sess._translate_carry, "")
        qs = [e for e in sess.emit.events if e["type"] == "question"]
        self.assertEqual(qs, [])


class SttCfgPacingTests(unittest.TestCase):
    def test_translate_has_pacing_meeting_does_not(self):
        sess = _translate_session()
        tr = sess._stt_cfg()["stt"]
        self.assertEqual(tr["turn_pacing"]["min_ms"], 7000)
        self.assertFalse(tr.get("speaker_labels"))
        sess._workspace = "meeting"
        mt = sess._stt_cfg()["stt"]
        self.assertNotIn("turn_pacing", mt)
        self.assertTrue(mt.get("speaker_labels"))


if __name__ == "__main__":
    unittest.main()
