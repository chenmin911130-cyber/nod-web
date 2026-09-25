"""Translate ForceEndpoint pacing and sentence-tail carry (#105)."""
from __future__ import annotations

import json
import threading
import time
import unittest
from collections import deque
from unittest import mock

from server.app import CloudListener, Session
from server.meeting_lines import join_meeting_text
from server.turn_pacing import (
    cut_decision,
    cut_decision_timer,
    split_carry,
    turn_pacing_from_env,
    word_span_ms,
)

from tests.test_stt_terminate import _connected_ws


CFG = {"min_ms": 3000, "gap_ms": 350, "max_ms": 8000, "stall_ms": 700}


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
        words = [{"start": 0, "end": 2000}, {"start": 2800, "end": 2900}]
        self.assertEqual(cut_decision(words, CFG, False), "none")

    def test_pause_cut(self):
        self.assertEqual(cut_decision(_words(5000, 400), CFG, False), "pause")

    def test_long_enough_but_gap_too_small(self):
        self.assertEqual(cut_decision(_words(5000, 120), CFG, False), "none")

    def test_max_cut_ignores_gap(self):
        self.assertEqual(cut_decision(_words(8500, 120), CFG, False), "max")

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

    def test_last_sentence_index_default_still_counts_function_word_period(self):
        # Meeting skip_false_period must not leak into Translate carry (#33 / #105).
        from server.meeting_lines import last_sentence_index
        text = "We finished that part. changing me into."
        self.assertEqual(last_sentence_index(text), len(text))
        head, tail = split_carry(text)
        self.assertEqual(head, "We finished that part.")
        self.assertEqual(tail, "changing me into.")


class TurnPacingEnvTests(unittest.TestCase):
    def test_defaults(self):
        with mock.patch.dict("os.environ", {
            "NOD_TR_CUT_MIN_MS": "",
            "NOD_TR_CUT_GAP_MS": "",
            "NOD_TR_CUT_MAX_MS": "",
            "NOD_TR_CUT_STALL_MS": "",
        }):
            cfg = turn_pacing_from_env()
        self.assertEqual(cfg["min_ms"], 3000)
        self.assertEqual(cfg["gap_ms"], 350)
        self.assertEqual(cfg["max_ms"], 8000)
        self.assertEqual(cfg["stall_ms"], 700)

    def test_stall_env_zero(self):
        with mock.patch.dict("os.environ", {"NOD_TR_CUT_STALL_MS": "0"}):
            cfg = turn_pacing_from_env()
        self.assertEqual(cfg["stall_ms"], 0)


class TimerCutDecisionTests(unittest.TestCase):
    def test_before_min(self):
        self.assertEqual(cut_decision_timer(2900, 900, CFG, False), "none")

    def test_stall_after_min(self):
        self.assertEqual(cut_decision_timer(3100, 900, CFG, False), "stall")

    def test_stall_not_long_enough(self):
        self.assertEqual(cut_decision_timer(3100, 300, CFG, False), "none")

    def test_max(self):
        self.assertEqual(cut_decision_timer(8100, 0, CFG, False), "max")

    def test_inflight(self):
        self.assertEqual(cut_decision_timer(8100, 900, CFG, True), "none")

    def test_stall_disabled_only_max(self):
        cfg = {**CFG, "stall_ms": 0}
        self.assertEqual(cut_decision_timer(3100, 900, cfg, False), "none")
        self.assertEqual(cut_decision_timer(8100, 0, cfg, False), "max")


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


class CloudListenerTimerCutTests(unittest.TestCase):
    def _listener(self, pacing: bool = True) -> CloudListener:
        stt: dict = {"turn_pacing": dict(CFG)} if pacing else {}
        return CloudListener(
            api_key="test-key",
            cfg={"stt": stt},
            on_final=lambda *a: None,
            on_partial=lambda *a: None,
            on_error=None,
        )

    def _run_sender_once(self, lst: CloudListener) -> None:
        lst._maybe_queue_translate_cut_timer()
        lst._flush_force_endpoint()

    def test_one_word_zh_max_cut(self):
        lst = self._listener(True)
        ws = _connected_ws()
        lst._ws = ws
        times = iter([0.0, 8.2])
        lst._clock = lambda: next(times)
        lst._on_message(None, json.dumps({
            "type": "Turn",
            "end_of_turn": False,
            "turn_order": 3,
            "transcript": "好",
            "words": [{"start": 0, "end": 100, "text": "好"}],
        }))
        with self.assertLogs("nod", level="INFO") as cap:
            self._run_sender_once(lst)
        texts = [
            json.loads(c[0][0])
            for c in ws.send.call_args_list
            if c[0] and isinstance(c[0][0], str)
        ]
        self.assertIn({"type": "ForceEndpoint"}, texts)
        joined = "\n".join(cap.output)
        self.assertIn("translate_cut reason=max", joined)
        self.assertIn("src=timer", joined)

    def test_stall_without_text_change(self):
        lst = self._listener(True)
        ws = _connected_ws()
        lst._ws = ws
        clock_times = [0.0, 4.0]

        def fake_clock() -> float:
            if len(clock_times) > 1:
                return clock_times.pop(0)
            return clock_times[0]

        lst._clock = fake_clock
        lst._on_message(None, json.dumps({
            "type": "Turn",
            "end_of_turn": False,
            "turn_order": 2,
            "transcript": "hello",
            "words": [{"start": 0, "end": 100, "text": "hello"}],
        }))
        with self.assertLogs("nod", level="INFO") as cap:
            self._run_sender_once(lst)
        self.assertIn("translate_cut reason=stall", "\n".join(cap.output))

    def test_text_change_resets_stall(self):
        lst = self._listener(True)
        ws = _connected_ws()
        lst._ws = ws
        times = iter([0.0, 3.0, 3.2])
        lst._clock = lambda: next(times)
        lst._on_message(None, json.dumps({
            "type": "Turn",
            "end_of_turn": False,
            "turn_order": 2,
            "transcript": "hello",
            "words": [{"start": 0, "end": 100, "text": "hello"}],
        }))
        lst._on_message(None, json.dumps({
            "type": "Turn",
            "end_of_turn": False,
            "turn_order": 2,
            "transcript": "hello world",
            "words": [{"start": 0, "end": 100, "text": "hello"}],
        }))
        self._run_sender_once(lst)
        texts = [
            json.loads(c[0][0])
            for c in ws.send.call_args_list
            if c[0] and isinstance(c[0][0], str)
        ]
        self.assertEqual(texts, [])

    def test_eot_clears_open_turn(self):
        lst = self._listener(True)
        ws = _connected_ws()
        lst._ws = ws
        times = iter([0.0, 9.0])
        lst._clock = lambda: next(times)
        lst._on_message(None, json.dumps({
            "type": "Turn",
            "end_of_turn": False,
            "turn_order": 3,
            "transcript": "hello",
            "words": [{"start": 0, "end": 100, "text": "hello"}],
        }))
        lst._on_message(None, json.dumps({
            "type": "Turn",
            "end_of_turn": True,
            "turn_is_formatted": True,
            "turn_order": 3,
            "transcript": "hello.",
            "words": [{"start": 0, "end": 100, "text": "hello"}],
        }))
        self._run_sender_once(lst)
        texts = [
            json.loads(c[0][0])
            for c in ws.send.call_args_list
            if c[0] and isinstance(c[0][0], str)
        ]
        self.assertEqual(texts, [])

    def test_new_turn_resets_clock(self):
        lst = self._listener(True)
        ws = _connected_ws()
        lst._ws = ws
        times = iter([0.0, 4.0, 4.5])
        lst._clock = lambda: next(times)
        lst._on_message(None, json.dumps({
            "type": "Turn",
            "end_of_turn": False,
            "turn_order": 3,
            "transcript": "one",
            "words": [{"start": 0, "end": 50, "text": "one"}],
        }))
        lst._on_message(None, json.dumps({
            "type": "Turn",
            "end_of_turn": True,
            "turn_is_formatted": True,
            "turn_order": 3,
            "transcript": "one.",
            "words": [{"start": 0, "end": 50, "text": "one"}],
        }))
        lst._on_message(None, json.dumps({
            "type": "Turn",
            "end_of_turn": False,
            "turn_order": 4,
            "transcript": "two",
            "words": [{"start": 0, "end": 50, "text": "two"}],
        }))
        self._run_sender_once(lst)
        texts = [
            json.loads(c[0][0])
            for c in ws.send.call_args_list
            if c[0] and isinstance(c[0][0], str)
        ]
        self.assertEqual(texts, [])

    def test_inflight_blocks_second_timer_cut(self):
        lst = self._listener(True)
        ws = _connected_ws()
        lst._ws = ws
        lst._force_inflight = time.time()
        times = iter([0.0, 9.0])
        lst._clock = lambda: next(times)
        lst._on_message(None, json.dumps({
            "type": "Turn",
            "end_of_turn": False,
            "turn_order": 1,
            "transcript": "x",
            "words": [{"start": 0, "end": 50, "text": "x"}],
        }))
        self._run_sender_once(lst)
        texts = [
            json.loads(c[0][0])
            for c in ws.send.call_args_list
            if c[0] and isinstance(c[0][0], str)
        ]
        self.assertEqual(texts, [])

    def test_on_final_meta_cut_reason(self):
        finals: list[tuple] = []
        lst = self._listener(True)
        lst.on_final = lambda *a: finals.append(a)
        lst._cut_reason_by_turn[3] = "max"
        lst._stt_tx_bytes = 32000
        lst._on_message(None, json.dumps({
            "type": "Turn",
            "end_of_turn": True,
            "turn_is_formatted": True,
            "turn_order": 3,
            "transcript": "Done.",
            "words": [{"start": 0, "end": 100, "text": "Done"}],
        }))
        self.assertEqual(finals[0][3]["cut_reason"], "max")
        self.assertEqual(finals[0][3]["commit_audio_ms"], 1000)
        lst2 = self._listener(True)
        finals2: list[tuple] = []
        lst2.on_final = lambda *a: finals2.append(a)
        lst2._on_message(None, json.dumps({
            "type": "Turn",
            "end_of_turn": True,
            "turn_is_formatted": True,
            "turn_order": 4,
            "transcript": "Natural.",
            "words": [{"start": 0, "end": 100, "text": "Natural"}],
        }))
        self.assertEqual(finals2[0][3]["cut_reason"], "eot")

    def test_meeting_no_timer_cut(self):
        lst = self._listener(False)
        ws = _connected_ws()
        lst._ws = ws
        times = iter([0.0, 9.0])
        lst._clock = lambda: next(times)
        lst._on_message(None, json.dumps({
            "type": "Turn",
            "end_of_turn": False,
            "turn_order": 1,
            "transcript": "hello",
            "words": [{"start": 0, "end": 100, "text": "hello"}],
        }))
        self._run_sender_once(lst)
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
    sess._effective_stt_lang = lambda: None
    sess._listen_gen = 0
    sess._closed = False
    sess._record_stt_latency = lambda *a, **k: None
    sess._tr_piece = {}
    sess._tr_piece_mu = threading.Lock()
    qid = iter(range(1, 100))

    class _Pipe:
        _last_answer = ""

        def _new_qid(self):
            return f"q{next(qid)}"

    sess.pipeline = _Pipe()
    sess.ask = lambda *a, **k: None
    sess._send_audio_text = lambda *a, **k: None
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

    def test_carry_deadline_flushes_tail(self):
        sess = _translate_session()
        sess._translate_carry_init()
        sess._carry_max_ms = 50
        with self.assertLogs("nod", level="INFO") as cap:
            sess._on_final("We know exactly")
            time.sleep(0.15)
        qs = [e for e in sess.emit.events if e["type"] == "question"]
        self.assertEqual(len(qs), 1)
        self.assertEqual(qs[0]["text"], "We know exactly")
        self.assertEqual(sess._translate_carry, "")
        self.assertIn("translate_carry_flush reason=deadline", "\n".join(cap.output))

    def test_next_final_before_deadline_cancels_timer(self):
        sess = _translate_session()
        sess._carry_max_ms = 500
        sess._on_final("We know exactly")
        sess._on_final("where to go. And then")
        qs = [e for e in sess.emit.events if e["type"] == "question"]
        self.assertEqual(len(qs), 1)
        time.sleep(0.6)
        qs2 = [e for e in sess.emit.events if e["type"] == "question"]
        self.assertEqual(len(qs2), 1)

    def test_deadline_seq_guard(self):
        sess = _translate_session()
        sess._translate_carry_init()
        sess._translate_carry = "tail bit"
        sess._carry_seq = 2
        old = 1
        sess._carry_deadline(old)
        qs = [e for e in sess.emit.events if e["type"] == "question"]
        self.assertEqual(qs, [])

    def test_carry_zero_disables_deadline(self):
        sess = _translate_session()
        sess._translate_carry_init()
        sess._carry_max_ms = 0
        sess._on_final("We know exactly")
        self.assertIsNone(getattr(sess, "_carry_timer", None))
        self.assertEqual(sess._translate_carry, "We know exactly")

    def test_tail_emitted_as_partial(self):
        sess = _translate_session()
        sess._on_final("First one. And then")
        partials = [e for e in sess.emit.events if e["type"] == "partial"]
        self.assertTrue(any(p.get("text") == "And then" for p in partials))

    def test_partial_prefixed_with_carry(self):
        sess = _translate_session()
        sess._translate_carry = "And then"
        sess._on_partial("we walked")
        partials = [e for e in sess.emit.events if e["type"] == "partial"]
        self.assertEqual(partials[-1]["text"], join_meeting_text("And then", "we walked"))
        sess.emit.events.clear()
        sess._translate_carry = ""
        sess._on_partial("solo")
        partials = [e for e in sess.emit.events if e["type"] == "partial"]
        self.assertEqual(partials[-1]["text"], "solo")

    def test_pause_and_stop_cancel_timer(self):
        sess = _translate_session()
        sess._carry_max_ms = 500
        sess._on_final("We know exactly")
        self.assertIsNotNone(sess._carry_timer)
        sess.pause_listen = Session.pause_listen.__get__(sess, Session)
        sess._handoff_listener = object()
        sess._listen_wanted = True
        sess._listen_started_at = time.time()
        sess._listen_accum_sec = 0.0
        with mock.patch.object(sess, "_collect_handoff", lambda *a: None):
            with mock.patch.object(sess, "_flush_meeting_hold", lambda: None):
                with mock.patch.object(sess, "_stop_meeting_worker", lambda **k: None):
                    with mock.patch.object(sess, "_close_open_line", lambda: None):
                        sess._listener = None
                        sess._handoff_listener = object()
                        sess.pause_listen()
        time.sleep(0.6)
        qs = [e for e in sess.emit.events if e["type"] == "question"]
        self.assertEqual(len(qs), 1)

    def test_close_cancels_timer(self):
        sess = _translate_session()
        sess._carry_max_ms = 500
        sess._on_final("We know exactly")
        with mock.patch.object(sess, "_stop_listening", lambda: None):
            with mock.patch.object(sess, "_detach_control_emit", lambda: None):
                with mock.patch.object(sess, "_close_audio_uplink", lambda: None):
                    with mock.patch.object(sess, "_flush_cloud_archive", lambda **k: None):
                        with mock.patch.object(sess, "_qa_reset", lambda *a: None):
                            sess.usage_session_id = None
                            sess.user_id = None
                            sess.pipeline.abort_stream = lambda: None
                            sess.close()
        time.sleep(0.6)
        qs = [e for e in sess.emit.events if e["type"] == "question"]
        self.assertEqual(qs, [])

    def test_locked_language_gate_applies_to_tail_partial(self):
        sess = _translate_session()
        sess._speech_allowed = lambda *a, **k: False
        sess._on_final("First one. And then")
        partials = [e for e in sess.emit.events if e["type"] == "partial"]
        self.assertFalse(any(p.get("text") == "And then" for p in partials))

    def test_non_atomic_carry_window_duplicates_with_deadline(self):
        """Documents the pre-fix race: read carry, deadline flush, then join."""
        sess = _translate_session()
        sess._set_translate_carry("We know exactly")
        seq = sess._carry_seq
        with sess._carry_mu:
            carry = (sess._translate_carry or "").strip()
            created = sess._carry_created_mono
        sess._carry_deadline(seq)
        joined = join_meeting_text(carry, "where to go.")
        head, _tail = split_carry(joined)
        if head:
            sess._emit_translate_pieces(head, "en", None)
        qs = [e for e in sess.emit.events if e["type"] == "question"]
        self.assertEqual(len(qs), 2)
        texts = [q["text"] for q in qs]
        self.assertIn("We know exactly", texts)
        self.assertTrue(any("where to go" in t for t in texts))

    def test_take_translate_carry_atomic_with_deadline_race(self):
        sess = _translate_session()
        sess._set_translate_carry("We know exactly")
        stale_seq = sess._carry_seq
        with sess._carry_mu:
            carry, _created = sess._take_translate_carry_locked()
        self.assertEqual(carry, "We know exactly")
        sess._carry_deadline(stale_seq)
        joined = join_meeting_text(carry, "where to go.")
        head, _tail = split_carry(joined)
        sess._emit_translate_pieces(head, "en", None)
        qs = [e for e in sess.emit.events if e["type"] == "question"]
        self.assertEqual(len(qs), 1)
        self.assertIn("We know exactly", qs[0]["text"])
        self.assertIn("where to go", qs[0]["text"])

    def test_on_final_carry_join_single_question(self):
        sess = _translate_session()
        sess._set_translate_carry("We know exactly")
        sess._on_final("where to go.", "en", None, {})
        qs = [e for e in sess.emit.events if e["type"] == "question"]
        self.assertEqual(len(qs), 1)
        self.assertIn("We know exactly", qs[0]["text"])
        self.assertIn("where to go", qs[0]["text"])


class SttCfgPacingTests(unittest.TestCase):
    def test_translate_has_pacing_meeting_does_not(self):
        sess = _translate_session()
        tr = sess._stt_cfg()["stt"]
        self.assertEqual(tr["turn_pacing"]["min_ms"], 3000)
        self.assertEqual(tr.get("max_turn_silence"), "1200")
        self.assertFalse(tr.get("speaker_labels"))
        sess._workspace = "meeting"
        mt = sess._stt_cfg()["stt"]
        self.assertNotIn("turn_pacing", mt)
        self.assertTrue(mt.get("speaker_labels"))
        self.assertEqual(mt.get("max_turn_silence"), "1200")

    def test_max_turn_silence_env_override(self):
        sess = _translate_session()
        with mock.patch.dict("os.environ", {"NOD_TR_MAX_TURN_SILENCE": "1600"}):
            tr = sess._stt_cfg()["stt"]
        self.assertEqual(tr.get("max_turn_silence"), "1600")

    def test_interview_no_max_turn_silence_key(self):
        sess = _translate_session()
        sess._workspace = "interview"
        stt = sess._stt_cfg()["stt"]
        self.assertNotIn("max_turn_silence", stt)


if __name__ == "__main__":
    unittest.main()
