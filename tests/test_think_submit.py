"""Think (#182): submit-time snapshot + the answer path.

Two things are pinned here and nowhere else:

1. The switch is read ONCE, at the moment a question is submitted. A question
   that is queued (because an answer is in flight) or retried keeps the value it
   was submitted with, while the user is free to flip the switch for the next
   one. New / clear / workspace switch turns it back off.
2. A Think answer really looks the question up (through the injected client),
   runs the model in thinking mode, attaches the sources the lookup returned,
   and never dresses up a lookup that did not happen — or the chain of thought —
   as the answer.
"""

import base64
import threading
import time
import unittest
import uuid
from unittest import mock

from server import think
from server.app import Pipeline, Session


class _Delta:
    def __init__(self, content="", reasoning=""):
        self.content = content
        self.reasoning_content = reasoning


class _Choice:
    def __init__(self, delta):
        self.delta = delta


class _Chunk:
    def __init__(self, content="", reasoning=""):
        self.choices = [_Choice(_Delta(content, reasoning))] if (content or reasoning) else []
        self.usage = None


def _pipe(events: list[dict]) -> Pipeline:
    pipe = Pipeline.__new__(Pipeline)
    pipe.cfg = {"llm": {"provider": "deepseek", "model": "deepseek-flash", "max_tokens": 80}}
    pipe.emit = events.append
    pipe._provider = "deepseek"
    pipe._model = "deepseek-flash"
    pipe.client = mock.Mock()
    pipe.client.chat.completions.create.return_value = [_Chunk(content="Beijing.")]
    # The Think answer is pinned to DeepSeek direct (#182): the tests give the pipe
    # that credential + the client it should build, and a session of its own so one
    # test's dedupe record can never answer another test's question.
    pipe._keys = {"DEEPSEEK_API_KEY": "unit-test-key"}
    pipe._think_llm = (pipe.client, "deepseek-v4-flash")
    pipe._qa_history = []
    pipe._last_answer = ""
    pipe._cancel = threading.Event()
    pipe._gen_seq = 0
    pipe.user_id = None
    pipe.usage_session_id = f"sess-{uuid.uuid4().hex[:10]}"
    pipe._heard_lang = None
    return pipe


def _client(results=(), status=None, error=""):
    """A SearchClient over a fake transport — deterministic, no network."""
    def transport(request):
        if status == think.STATUS_FAILED:
            raise TimeoutError("upstream stalled")
        return {
            "results": [
                {
                    "title": t,
                    "url": u,
                    "content": "snippet",
                    "published_date": p,
                }
                for (t, u, p) in results
            ]
        }

    return think.SearchClient(transport, clock=lambda: 1789012800.0)


def _events(events, kind):
    return [e for e in events if e.get("type") == kind]


class SubmitSnapshotTests(unittest.TestCase):
    """The switch is session-scoped and frozen per submit."""

    def _session(self):
        sess = Session.__new__(Session)
        sess.cfg = {"stt": {}, "ui": {}, "llm": {}}
        sess._workspace = "interview"
        sess._listener = object()
        sess._manual = False
        sess._busy = False
        sess._busy_lock = threading.Lock()
        sess._busy_token = None
        sess._pending_q = __import__("collections").deque(maxlen=8)
        sess._pending_asks = []
        sess._recent_finals = []
        sess._follow_lang = None
        sess._follow_switch_lang = None
        sess._follow_switch_hits = 0
        sess._last_voice_at = 0.0
        sess._meeting_flush_timer = None
        sess._meeting_lock = threading.Lock()
        sess.user_id = None
        sess.emit = mock.Mock()
        sess.pipeline = mock.Mock()
        sess.pipeline._qa_history = []
        sess.pipeline._last_answer = ""
        sess.pipeline._cancel = threading.Event()
        sess.pipeline.process_text = mock.Mock()
        sess._qa_schedule_judge = mock.Mock()
        sess._listen_wanted = False
        sess._handoff_listener = None
        sess._paused = False
        sess._engine = "idle"
        return sess

    def test_think_defaults_off_and_is_session_scoped(self):
        sess = self._session()
        self.assertFalse(sess._think_snapshot())
        sess.set_think(True)
        self.assertTrue(sess._think_snapshot())
        # New / clear / workspace switch / close start a fresh session.
        sess._qa_reset("new_session")
        self.assertFalse(sess._think_snapshot())

    def test_a_direct_ask_carries_the_value_at_submit(self):
        sess = self._session()
        sess.set_think(True)
        sess.ask("what is new?", None, "ask")
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        self.assertIs(sess.pipeline.process_text.call_args.kwargs.get("think"), True)

    def test_a_queued_ask_keeps_its_submit_value_across_a_toggle(self):
        sess = self._session()
        self.assertIsNotNone(sess._claim_busy())  # an answer is already in flight
        sess.set_think(True)
        sess.ask("queued while busy?", None, "ask")
        sess.pipeline.process_text.assert_not_called()
        # The user flips the switch off while the first question waits.
        sess.set_think(False)
        sess.ask("a later question?", None, "ask")
        self.assertEqual(len(sess._pending_asks), 2)
        sess._release_busy(sess._busy_token)
        sess._drain_pending_ask()
        # The queued question uses the value it was submitted with; the next one
        # uses the value the switch has now.
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.call_count == 2))
        calls = sess.pipeline.process_text.call_args_list
        self.assertIs(calls[0].kwargs.get("think"), True)
        self.assertIs(calls[1].kwargs.get("think"), False)

    def test_the_voice_submit_id_is_session_scoped_and_process_independent(self):
        # #182 review: the fragment ids fold in `id(listener)` (a memory address), so a
        # submit identity built from them could be reused by a re-created listener, or
        # collide across sessions and get a legitimate search refused. It is now a
        # function of values that outlive the process: usage session, Q&A session
        # epoch, the fragment's STT turn, and the question itself.
        #
        # The fragments come from the REAL constructor (not a hand-built dict), because
        # the turn lives at the top level (`turn`) and there is no `meta` — reading
        # `meta["stt_turn"]` silently fell back to the listener-bearing id.
        from server import qa_semantic

        sess = self._session()
        sess._qa_init()
        sess.usage_session_id = "sess-a"

        def frag(turn, listener, stream="1-runA"):
            return qa_semantic.new_fragment(
                "怎么定价？", "zh", frag_id=f"t{listener}:{turn}", at=1.0,
                meta={"stt_turn": turn, "listener_id": listener, "stream": stream},
            )

        first_frag = frag(7, 140234)
        # Pin the real shape this fix depends on.
        self.assertEqual(first_frag["turn"], 7)
        self.assertEqual(first_frag["stream"], "1-runA")
        self.assertNotIn("meta", first_frag)

        first = sess._candidate_submit_id("怎么定价？", [first_frag])
        # The same commit always maps to the same identity (a re-delivered candidate
        # dedupes)...
        self.assertEqual(first, sess._candidate_submit_id("怎么定价？", [frag(7, 140234)]))
        # ...and it does not depend on the listener address inside the fragment id.
        self.assertEqual(first, sess._candidate_submit_id("怎么定价？", [frag(7, 999)]))
        # A fragment that carries no STT turn keeps its synthetic id (s<n>/f<n>),
        # which is process-independent by construction.
        synth = qa_semantic.new_fragment("怎么定价？", "zh", frag_id="s3", at=1.0)
        self.assertIsNone(synth["turn"])
        self.assertEqual(
            sess._candidate_submit_id("怎么定价？", [synth]),
            sess._candidate_submit_id("怎么定价？", [dict(synth)]),
        )
        # Another session, another question, another turn, another listen session:
        # all different identities, so none of them can collide with this one.
        sess.usage_session_id = "sess-b"
        self.assertNotEqual(first, sess._candidate_submit_id("怎么定价？", [frag(7, 140234)]))
        sess.usage_session_id = "sess-a"
        self.assertNotEqual(first, sess._candidate_submit_id("怎么交付？", [frag(7, 140234)]))
        self.assertNotEqual(first, sess._candidate_submit_id("怎么定价？", [frag(8, 140234)]))
        sess._qa_session_gen += 1
        self.assertNotEqual(first, sess._candidate_submit_id("怎么定价？", [frag(7, 140234)]))

    def test_a_new_stt_stream_is_a_new_submit_for_the_same_turn_and_question(self):
        # #182 review: a resume creates a new CloudListener whose STT turn numbers
        # restart from the beginning, so (epoch, turn, question) alone let a NEW
        # question collide with an older paid lookup. The stream identity — unique per
        # connection AND per process run — is part of the submit identity.
        from server import qa_semantic

        sess = self._session()
        sess._qa_init()
        sess.usage_session_id = "sess-a"
        sess._qa_session_gen = 4

        def frag(turn, stream):
            return qa_semantic.new_fragment(
                "怎么定价？", "zh", frag_id=f"t1:{turn}", at=1.0,
                meta={"stt_turn": turn, "listener_id": 1, "stream": stream},
            )

        resumed = sess._candidate_submit_id("怎么定价？", [frag(1, "2-runA")])
        # The same fragment re-delivered on the same stream is the same submit…
        self.assertEqual(resumed, sess._candidate_submit_id("怎么定价？", [frag(1, "2-runA")]))
        # …while the same turn number on a NEW stream (pause → resume) is not.
        self.assertNotEqual(resumed, sess._candidate_submit_id("怎么定价？", [frag(1, "3-runA")]))
        # A different process run cannot collide either.
        self.assertNotEqual(resumed, sess._candidate_submit_id("怎么定价？", [frag(1, "2-runB")]))

    def test_a_cleared_session_drops_a_text_submit_still_waiting_to_start(self):
        # #182 review: the text worker had no session check (the voice worker has had
        # one since #191), so a question whose turn was abandoned could still generate
        # — and, with Think on, search — into the new session.
        sess = self._session()
        sess.set_think(True)
        with mock.patch("server.app.threading.Thread") as thread:
            sess.ask("what is new?", None, "ask", submit_id="submit-1")
        self.assertIsNotNone(sess._busy_token, "the submit took the answer slot")
        body = thread.call_args.kwargs["target"]

        # A New / clear lands before the worker body actually runs.
        sess._qa_reset("turn_reset")
        body()

        sess.pipeline.process_text.assert_not_called()
        self.assertFalse(sess._busy, "and the busy slot must be released")

    def test_a_cleared_session_drops_a_manual_recording_mid_transcription(self):
        # The transcription takes long enough for a New to land; the recording must
        # not answer (or search) in the session that replaced it.
        sess = self._session()
        sess.set_think(True)
        sess._manual = False
        sess._qa_on_manual_submit = mock.Mock()
        sess._polish_manual_text = mock.Mock(side_effect=lambda text, **_: text)
        sess._speech_allowed = mock.Mock(return_value=True)
        sess._set_engine = mock.Mock()
        sess._emit_phase = mock.Mock()
        sess._transcribe_manual_pcm = mock.Mock(return_value=("how should we price it?", "en"))
        sess._qa_init()
        stale_gen = sess._qa_session_gen

        sess._finish_manual(b"\x00" * 8000, think=True, submit_ref="manual-1", submit_session_gen=stale_gen - 1)
        sess.pipeline.process_text.assert_not_called()
        sess._qa_on_manual_submit.assert_not_called()

        # The same recording in the CURRENT session still submits.
        sess._finish_manual(b"\x00" * 8000, think=True, submit_ref="manual-2", submit_session_gen=stale_gen)
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        self.assertIs(sess.pipeline.process_text.call_args.kwargs.get("think"), True)

    def test_a_stale_manual_recording_never_reaches_the_new_mode(self):
        # #182 review: the mode dispatch (`_on_final` for Translate / Meeting) ran
        # BEFORE the ownership check, so a recording whose mode changed during
        # transcription still landed in the new mode.
        sess = self._session()
        sess._qa_init()
        stale_gen = sess._qa_session_gen
        sess._workspace = "translate"  # the mode moved on while transcribing
        sess._on_final = mock.Mock()
        sess._transcribe_manual_pcm = mock.Mock(return_value=("some words", "en"))
        sess._polish_manual_text = mock.Mock(side_effect=lambda text, **_: text)
        sess._set_engine = mock.Mock()
        sess._emit_phase = mock.Mock()

        sess._finish_manual(b"\x00" * 8000, submit_ref="m1", submit_session_gen=stale_gen - 1)

        sess._on_final.assert_not_called()
        sess.pipeline.process_text.assert_not_called()
        sess._set_engine.assert_not_called()
        sess._emit_phase.assert_not_called()
        self.assertEqual(sess.emit.call_args_list, [], "an abandoned worker emits nothing")

    def test_a_stale_manual_recording_does_not_even_start_transcribing(self):
        # The session can also move on between the confirm and the worker starting.
        sess = self._session()
        sess._qa_init()
        sess._transcribe_manual_pcm = mock.Mock(return_value=("some words", "en"))
        sess._set_engine = mock.Mock()
        sess._finish_manual(b"\x00" * 8000, submit_session_gen=sess._qa_session_gen - 1)
        sess._transcribe_manual_pcm.assert_not_called()
        sess._set_engine.assert_not_called()

    def test_a_stale_transcription_failure_does_not_touch_the_new_session(self):
        # The failure branch had no ownership check either: an abandoned worker could
        # report an error into the live session and mark its engine idle.
        sess = self._session()
        sess._qa_init()
        stale_gen = sess._qa_session_gen
        sess._transcribe_manual_pcm = mock.Mock(side_effect=RuntimeError("socket lost"))
        sess._set_engine = mock.Mock()
        sess._emit_phase = mock.Mock()

        # Not stale yet when it starts, stale by the time it fails.
        with mock.patch.object(sess, "_manual_session_stale", side_effect=[False, True]):
            sess._finish_manual(b"\x00" * 8000, submit_session_gen=stale_gen)

        self.assertEqual([e.args[0] for e in sess.emit.call_args_list if e.args[0].get("type") == "error"], [])
        # Only the initial "transcribing" was set; the failure must not force idle.
        self.assertEqual([c.args for c in sess._set_engine.call_args_list], [("transcribing",)])
        sess._emit_phase.assert_not_called()

    def test_a_recording_cleared_while_polishing_never_reaches_the_new_session(self):
        # #182 review: `_polish_manual_text` is not local — with earlier context it
        # makes an 8s model request — and ownership was never re-checked after it, so a
        # recording could still be dispatched (and search) after a clear / mode switch.
        sess = self._session()
        sess._qa_init()
        stale_gen = sess._qa_session_gen
        sess.usage_session_id = "sess-old"
        sess._workspace = "interview"
        sess._on_final = mock.Mock()
        sess._set_engine = mock.Mock()
        sess._emit_phase = mock.Mock()
        sess._transcribe_manual_pcm = mock.Mock(return_value=("how should we price it?", "en"))
        started = threading.Event()
        release = threading.Event()
        seen: dict = {}

        def slow_polish(text, *, session_id=None):
            started.set()
            release.wait(3.0)
            seen["passed"] = session_id
            seen["current_at_return"] = sess.usage_session_id
            return text

        sess._polish_manual_text = slow_polish
        worker = threading.Thread(
            target=sess._finish_manual,
            args=(b"\x00" * 8000,),
            kwargs={"think": True, "submit_ref": "m1", "submit_session_gen": stale_gen},
            daemon=True,
        )
        worker.start()
        self.assertTrue(started.wait(3.0), "the polish must have started")

        # While the polish is in flight: New / mode switch, and a new usage session.
        sess._qa_reset("turn_reset")
        sess._workspace = "translate"
        sess.usage_session_id = "sess-new"
        release.set()
        worker.join(3.0)

        sess._on_final.assert_not_called()
        sess.pipeline.process_text.assert_not_called()
        sess._emit_phase.assert_not_called()
        self.assertEqual(
            [e.args[0] for e in sess.emit.call_args_list if e.args[0].get("type") == "status"], []
        )
        self.assertEqual(seen["passed"], "sess-old", "the polish is booked to its own session")
        self.assertEqual(seen["current_at_return"], "sess-new", "even though the current one moved on")

    def test_a_question_failure_names_the_question_it_belongs_to(self):
        # #182 review: an error frame carried no id, so the client wrote it into
        # whichever card happened to be waiting (an attachment submit still uploading,
        # for instance). Failures of a question now name it.
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = _client(results=[])
        pipe.client.chat.completions.create.side_effect = RuntimeError("boom")
        pipe.process_text("what is new?", "ask", think=True, submit_id="submit-1")
        errors = _events(events, "error")
        self.assertTrue(errors)
        self.assertTrue(all(e.get("id") for e in errors), "a question failure names its question")
        self.assertTrue(all(e["id"] == _events(events, "question")[-1]["id"] for e in errors))

    def test_a_question_that_never_produces_a_body_names_itself(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.client.chat.completions.create.return_value = [_Chunk(reasoning="internal musings")]
        pipe.think_client = _client(results=[])
        pipe.process_text("what is new?", "ask", think=True, submit_id="submit-1")
        errors = _events(events, "error")
        self.assertEqual(errors[-1]["id"], _events(events, "question")[-1]["id"])

    def test_the_manual_submit_id_folds_in_the_transcribed_question(self):
        # The recording counter restarts with the process; the question text keeps a
        # restarted counter from matching an older row (and its sources).
        sess = self._session()
        self.assertTrue(sess._manual_submit_id("manual-sess-1", "怎么定价？"))
        self.assertEqual(
            sess._manual_submit_id("manual-sess-1", "怎么定价？"),
            sess._manual_submit_id("manual-sess-1", "怎么定价？"),
        )
        self.assertNotEqual(
            sess._manual_submit_id("manual-sess-1", "怎么定价？"),
            sess._manual_submit_id("manual-sess-1", "怎么交付？"),
        )
        self.assertEqual(sess._manual_submit_id("", "怎么定价？"), "")

    def test_an_attachment_only_submit_never_searches_from_the_real_entry(self):
        # #182 review: the page used to send the placeholder as the question, which
        # walked straight past the empty-question guard. The guard is therefore
        # exercised through `ask()` — the entry the page actually calls — not only by
        # handing `process_text` an empty string.
        sess = self._session()
        sess.set_think(True)
        data = base64.b64encode(b"PRIVATE PAYROLL 123456").decode()
        files = [{"name": "payroll.txt", "mime": "text/plain", "data": data}]
        sess.ask("", files, "ask", submit_id="submit-attach")
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        call = sess.pipeline.process_text.call_args
        self.assertEqual(call.kwargs.get("search_text"), "", "nothing to search for")
        self.assertEqual(call.args[1], "file_ask")
        self.assertIn("PRIVATE PAYROLL", call.args[0], "the model still gets the attachment")
        self.assertEqual(call.kwargs.get("submit_id"), "submit-attach")

    def test_the_value_the_client_froze_with_the_message_wins(self):
        # #182 review: the backend read the session switch and ignored the `think`
        # field the client sent, so a toggle flipped while the question was in flight
        # changed a question that was already submitted.
        sess = self._session()
        sess.set_think(True)  # the server's current value — NOT what must run
        sess.dispatch(
            {"type": "ask", "text": "what is new?", "think": False, "submit_id": "submit-frozen"}
        )
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        call = sess.pipeline.process_text.call_args
        self.assertIs(call.kwargs.get("think"), False, "the message value must win")
        self.assertEqual(call.kwargs.get("submit_id"), "submit-frozen")
        # ...and a message without the field still uses the session value.
        sess.pipeline.process_text.reset_mock()
        sess.dispatch({"type": "ask", "text": "another?", "submit_id": "submit-2"})
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        self.assertIs(sess.pipeline.process_text.call_args.kwargs.get("think"), True)

    def test_a_new_listen_session_keeps_the_switch_and_a_new_session_resets_it(self):

        # #182 review: (re)starting to listen inside one conversation used to run the
        # same reset as New, dropping Think without telling anyone. It is a listen
        # session, not a new conversation: the switch survives, and when a real reset
        # does turn it off the server says so instead of letting the client lie.
        sess = self._session()
        sess.set_think(True)
        sess._open_listener = mock.Mock()
        sess._claim_listen_start = mock.Mock(return_value=True)
        sess._release_listen_start = mock.Mock()
        sess.pipeline.assemblyai_key = mock.Mock(return_value="key")
        sess._start_listening()
        self.assertTrue(sess._think_snapshot(), "a new listen session must not drop Think")
        self.assertEqual([e for e in sess.emit.call_args_list if e.args[0].get("type") == "think"], [])

        # A real session reset (New / clear / workspace switch) still returns to the
        # default — and announces it.
        sess._qa_reset("turn_reset")
        self.assertFalse(sess._think_snapshot())
        think_events = [e.args[0] for e in sess.emit.call_args_list if e.args[0].get("type") == "think"]
        self.assertEqual(think_events, [{"type": "think", "on": False}])

    def test_a_manual_recording_carries_think_at_the_confirm_instant(self):
        # #182 review: the manual (tap-to-confirm) recording was the entry that
        # forgot Think entirely, so the switch was on and the answer was not.
        sess = self._session()
        sess.set_think(True)
        sess._manual = True
        sess._manual_lock = threading.Lock()
        sess._manual_jobs = 0
        sess._manual_buf = bytearray(b"\x00\x01" * 20000)
        sess._manual_offset = 0
        sess._live_manual_captions = mock.Mock(return_value=False)
        sess._offer_save_history = mock.Mock()
        sess._emit_phase = mock.Mock()
        sess._set_engine = mock.Mock()
        sess._qa_on_manual_submit = mock.Mock()
        sess._speech_allowed = mock.Mock(return_value=True)
        sess._polish_manual_text = mock.Mock(side_effect=lambda text, **_: text)
        sess._transcribe_manual_pcm = mock.Mock(return_value=("how should we price it?", "en"))
        sess._set_engine = mock.Mock()
        sess.usage_session_id = "sess-manual"

        with mock.patch("server.app.threading.Thread") as thread:
            sess._stop_manual()
        # The recording is transcribed on a worker; run that worker's body inline so
        # the test sees the submit it makes.
        started = thread.call_args.kwargs
        self.assertEqual(started["target"], sess._finish_manual)
        sess._finish_manual(started["args"][0], **started["kwargs"])

        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        call = sess.pipeline.process_text.call_args
        self.assertIs(call.kwargs.get("think"), True, "the manual entry must carry Think")
        self.assertTrue(call.kwargs.get("submit_id"), "and its own submit identity")

    def test_the_auto_voice_commit_freezes_think_at_commit_time(self):
        # _qa_commit is the auto-voice submit point; the value it passes to the
        # start point is the session value at that instant, and nothing later.
        sess = self._session()
        sess.set_think(True)
        sess._start_interview_answer = mock.Mock(return_value=True)
        sess._qa_init()
        frag = {"id": "f1", "text": "怎么定价？", "lang": "zh"}
        verdict = {"verdict": "ready", "question": "怎么定价？", "fragments": ["f1"]}
        with sess._qa_lock():
            sess._qa_buffer = [dict(frag)]
            sess._qa_version = 3
        version = sess._qa_version
        gen = sess._qa_gen
        sess._qa_commit("怎么定价？", [frag], verdict=verdict, trigger="judge", version=version, gen=gen)
        self.assertIs(sess._start_interview_answer.call_args.kwargs.get("think"), True)
        sess.set_think(False)
        with sess._qa_lock():
            sess._qa_buffer = [dict(frag)]
            sess._qa_version += 1
        sess._qa_commit(
            "怎么定价？", [frag], verdict=verdict, trigger="judge",
            version=sess._qa_version, gen=sess._qa_gen,
        )
        self.assertIs(sess._start_interview_answer.call_args.kwargs.get("think"), False)

    def test_a_queued_auto_answer_keeps_its_commit_value(self):
        sess = self._session()
        sess._qa_init()
        self.assertIsNotNone(sess._claim_busy())  # holding the answer slot
        sess.set_think(True)
        self.assertTrue(
            sess._start_interview_answer("how should we price it?", "en", "", gen=sess._qa_gen, think=True)
        )
        self.assertEqual(len(sess._pending_q), 1)
        sess.set_think(False)  # flipped while the question waits
        sess._release_busy(sess._busy_token)
        # Hand the slot over exactly like the finishing answer does.
        item = sess._pending_q.popleft()
        sess._run_interview_answer(item[0], item[1], item[2], session_gen=item[3], think=item[4])
        self.assertTrue(self._wait(lambda: sess.pipeline.process_text.called))
        self.assertIs(sess.pipeline.process_text.call_args.kwargs.get("think"), True)

    def _wait(self, pred, timeout=3.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if pred():
                return True
            time.sleep(0.01)
        return pred()


class CaptionPolishBillingTests(unittest.TestCase):
    """The polish request books its usage to the session it was made for."""

    def _response(self, content: str):
        message = mock.Mock()
        message.content = content
        choice = mock.Mock()
        choice.message = message
        resp = mock.Mock()
        resp.choices = [choice]
        return resp

    def test_the_polish_usage_is_booked_to_the_given_session(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.user_id = "u1"
        pipe.usage_session_id = "sess-new"
        pipe.client.with_options.return_value.chat.completions.create.return_value = self._response(
            "how should we price it?"
        )
        with mock.patch("server.meter.check_can_generate", return_value=(True, {})), mock.patch(
            "server.meter.consume_llm"
        ) as consume:
            out = pipe.repair_caption(
                "how should we price it?", ["previous line"], session_id="sess-old"
            )
        self.assertEqual(out, "how should we price it?")
        consume.assert_called_once()
        self.assertEqual(consume.call_args.args[1], "sess-old")

    def test_a_caller_without_a_session_keeps_the_previous_behaviour(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.user_id = "u1"
        pipe.usage_session_id = "sess-current"
        pipe.client.with_options.return_value.chat.completions.create.return_value = self._response(
            "how should we price it?"
        )
        with mock.patch("server.meter.check_can_generate", return_value=(True, {})), mock.patch(
            "server.meter.consume_llm"
        ) as consume:
            pipe.repair_caption("how should we price it?", ["previous line"])
        self.assertEqual(consume.call_args.args[1], "sess-current")


class ThinkAnswerPathTests(unittest.TestCase):
    """process_text: a real lookup, real sources, honest failure, quiet CoT."""

    def test_think_off_never_searches_and_keeps_thinking_disabled(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = _client(results=[("A", "https://e.com/a", None)])
        pipe.process_text("what is new?", "ask")
        self.assertEqual(_events(events, "sources"), [])
        self.assertNotIn("think", _events(events, "question")[-1])
        kwargs = pipe.client.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["extra_body"], {"thinking": {"type": "disabled"}})

    def test_think_on_searches_once_and_runs_in_thinking_mode(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = mock.Mock()
        pipe.think_client.search.return_value = think.SearchOutcome(
            status=think.STATUS_OK,
            query="what is new?",
            results=(think.SearchResult("A", "https://e.com/a", "snippet", "2026-09-10"),),
            retrieved_at=1789012800.0,
        )
        pipe.process_text("what is new?", "ask", think=True)
        pipe.think_client.search.assert_called_once()
        # The lookup happened before the model call, with the question only.
        self.assertEqual(pipe.think_client.search.call_args.args[0], "what is new?")
        kwargs = pipe.client.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["extra_body"]["thinking"], {"type": "enabled"})
        self.assertIn("reasoning_effort", kwargs["extra_body"])
        # The evidence rides in the ONE existing system prompt (like the #191
        # background block) rather than adding a second system message.
        system = [m for m in kwargs["messages"] if m["role"] == "system"]
        self.assertEqual(len(system), 1)
        self.assertTrue(any("https://e.com/a" in m["content"] for m in system))
        self.assertTrue(any("2026-09-10 04:00 UTC" in m["content"] for m in system))
        # And the client gets the sources with the answer.
        sources = _events(events, "sources")
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]["status"], "ok")
        self.assertEqual(sources[0]["results"][0]["url"], "https://e.com/a")
        self.assertEqual(sources[0]["retrieved_at_text"], "2026-09-10 04:00 UTC")
        self.assertEqual(sources[0]["note"], "")
        # The question frame carries the value this answer runs with, so the answer
        # card can offer a Retry that re-runs the question the same way.
        self.assertIs(_events(events, "question")[-1].get("think"), True)

    def test_the_question_frame_echoes_the_submit_identity(self):
        # #182 review: the client binds an answer to its pending card by this id. By
        # arrival order, a voice question committed while an attachment submit was
        # still uploading inherited that submit's attachments.
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = _client(results=[])
        pipe.process_text("what is new?", "ask", think=True, submit_id="submit-abc")
        self.assertEqual(_events(events, "question")[-1].get("submit_id"), "submit-abc")
        # A caller with no submit identity (an internal/legacy one) simply has none.
        events2: list[dict] = []
        pipe2 = _pipe(events2)
        pipe2.think_client = _client(results=[])
        pipe2.process_text("what is new?", "ask")
        self.assertNotIn("submit_id", _events(events2, "question")[-1])
        self.assertTrue(_events(events, "done")[-1]["ok"])

    def test_an_unconfigured_lookup_is_reported_not_faked(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = None
        with mock.patch("server.app.build_think_client", return_value=None):
            pipe.process_text("what is new?", "ask", think=True)
        sources = _events(events, "sources")
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]["status"], "failed")
        self.assertEqual(sources[0]["results"], [])
        self.assertTrue(sources[0]["note"])  # explicit: the lookup did not run
        # The answer still goes out (recording/answering must not break), and it
        # is not presented as a fresh lookup.
        self.assertTrue(_events(events, "done")[-1]["ok"])

    def test_a_failed_lookup_is_reported(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = _client(status=think.STATUS_FAILED)
        pipe.process_text("what is new?", "ask", think=True)
        sources = _events(events, "sources")[0]
        self.assertEqual(sources["status"], "failed")
        self.assertIn("TimeoutError", sources["note"])
        self.assertEqual(sources["results"], [])

    def test_an_empty_lookup_is_reported(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = _client(results=[])
        pipe.process_text("what is new?", "ask", think=True)
        sources = _events(events, "sources")[0]
        self.assertEqual(sources["status"], "empty")
        self.assertTrue(sources["note"])

    def test_think_never_searches_a_non_answer_mode(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = mock.Mock()
        pipe.process_text("Write structured notes", "notes", think=True)
        pipe.think_client.search.assert_not_called()
        self.assertEqual(_events(events, "sources"), [])

    def test_the_chain_of_thought_is_not_dumped_into_a_think_answer(self):
        # With thinking on, an empty body must fail loudly instead of showing the
        # model's internal reasoning as the answer (#182).
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.client.chat.completions.create.return_value = [_Chunk(reasoning="internal musings")]
        pipe.think_client = _client(results=[])
        pipe.process_text("what is new?", "ask", think=True)
        self.assertEqual([e.get("text") for e in _events(events, "chunk")], [])
        self.assertTrue(any("empty response" in (e.get("text") or "") for e in _events(events, "error")))
        self.assertFalse(_events(events, "done")[-1]["ok"])

    def test_the_non_think_fallback_still_uses_reasoning_when_the_body_is_empty(self):
        # Guard against over-blocking: the pre-existing behaviour for a normal
        # (non-Think) answer is unchanged.
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.client.chat.completions.create.return_value = [_Chunk(reasoning="fallback body")]
        pipe.process_text("what is new?", "ask")
        self.assertEqual([e.get("text") for e in _events(events, "chunk")], ["fallback body"])

    def test_the_search_gets_the_users_question_not_the_attachment_body(self):
        # #182 review: the prompt for an attachment question STARTS with the
        # extracted file body, and the lookup was handed that prompt — the private
        # attachment was uploaded to the search provider and the real question was
        # buried past the query bound. The search term is the typed question only.
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = mock.Mock()
        pipe.think_client.search.return_value = think.SearchOutcome(
            status=think.STATUS_OK,
            query="what is new?",
            results=(think.SearchResult("A", "https://e.com/a", "snippet", None),),
            retrieved_at=1789012800.0,
        )
        private_body = "CONFIDENTIAL SALARY DATA 123456"
        prompt = f"--- Attached: payroll.csv ---\n{private_body}\n\nwhat is new?"
        pipe.process_text(prompt, "file_ask", think=True, search_text="what is new?")
        searched = pipe.think_client.search.call_args.args[0]
        self.assertEqual(searched, "what is new?")
        self.assertNotIn("CONFIDENTIAL", searched)
        # ...while the model still gets the whole attachment.
        messages = pipe.client.chat.completions.create.call_args.kwargs["messages"]
        self.assertTrue(any(private_body in (m.get("content") or "") for m in messages))

    def test_an_attachment_only_question_is_never_searched(self):
        # Nothing to look up: no request, no budget reserved — and the answer says
        # the lookup did not happen instead of pretending it did.
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = mock.Mock()
        reserved = mock.Mock(allowed=True, reason="", day_attempts=1, total_attempts=1)
        with mock.patch("server.think_budget.reserve", return_value=reserved) as reserve:
            pipe.process_text(
                "--- Attached: payroll.csv ---\nPRIVATE PAYROLL\n",
                "file_ask",
                think=True,
                search_text="",
            )
        pipe.think_client.search.assert_not_called()
        reserve.assert_not_called()
        sources = _events(events, "sources")[0]
        self.assertEqual(sources["status"], "failed")
        self.assertEqual(sources["results"], [])
        self.assertIn("附件", sources["note"])

    def test_a_think_answer_is_pinned_to_deepseek_direct(self):
        # #182 review: the enhanced path must not follow the session provider. With
        # OpenRouter selected, the Think answer still runs on the pinned DeepSeek
        # client + model, in thinking mode.
        events: list[dict] = []
        pipe = _pipe(events)
        session_client = mock.Mock()
        session_client.chat.completions.create.return_value = [_Chunk(content="wrong path")]
        pinned_client = mock.Mock()
        pinned_client.chat.completions.create.return_value = [_Chunk(content="right path")]
        pipe.client = session_client
        pipe._provider = "openrouter"
        pipe._model = "some/router-model"
        pipe._think_llm = (pinned_client, "deepseek-v4-flash")
        pipe.think_client = _client(results=[("A", "https://e.com/a", None)])

        pipe.process_text("what is new?", "ask", think=True)
        session_client.chat.completions.create.assert_not_called()
        kwargs = pinned_client.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["model"], "deepseek-v4-flash")
        self.assertEqual(kwargs["extra_body"]["thinking"], {"type": "enabled"})

        # Without Think the same pipe answers through the session client, untouched.
        pipe.process_text("what is new?", "ask")
        session_kwargs = session_client.chat.completions.create.call_args.kwargs
        self.assertEqual(session_kwargs["model"], "some/router-model")
        self.assertNotIn("extra_body", session_kwargs)

    def test_a_missing_deepseek_key_falls_back_instead_of_dying(self):
        # No DeepSeek credential at all is the only case where the pin cannot hold:
        # the answer still goes out on the session client, and it is logged — never
        # silent — but it does not claim to be the specified direct connection.
        events: list[dict] = []
        pipe = _pipe(events)
        pipe._keys = {}
        pipe._think_llm = None
        pipe._provider = "openrouter"
        pipe._model = "some/router-model"
        pipe.think_client = _client(results=[("A", "https://e.com/a", None)])
        with mock.patch("server.app.logging") as logging_mock:
            pipe.process_text("what is new?", "ask", think=True)
        kwargs = pipe.client.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["model"], "some/router-model")
        self.assertNotIn("extra_body", kwargs)
        self.assertTrue(logging_mock.getLogger.return_value.warning.called)

    def test_think_scopes_the_search_to_ask_modes_only(self):
        # file_ask is an ask: it carries the enhancement too — and the evidence has
        # to reach the prompt file_ask actually builds (it returns early, so a
        # lookup whose evidence only lands in the plain-ask prompt is a silent
        # no-op for attachment questions).
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = _client(results=[("A", "https://e.com/a", "2026-09-10")])
        pipe.process_text("review this", "file_ask", think=True)
        self.assertEqual(len(_events(events, "sources")), 1)
        kwargs = pipe.client.chat.completions.create.call_args.kwargs
        system = [m for m in kwargs["messages"] if m["role"] == "system"]
        self.assertTrue(
            any("https://e.com/a" in m["content"] for m in system),
            "the evidence must reach the file_ask prompt too",
        )


if __name__ == "__main__":
    unittest.main()
