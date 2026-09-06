"""DeepSeek bills tokens, not socket-open time. These guards stop waste, not AAI-style idle hours."""
import threading
import unittest
from unittest import mock

from server.app import Pipeline, Session, _close_llm_stream


def _pipe() -> Pipeline:
    pipe = Pipeline.__new__(Pipeline)
    pipe.cfg = {"llm": {"provider": "deepseek", "model": "deepseek-v4-flash", "max_tokens": 80}}
    pipe.emit = mock.Mock()
    pipe._provider = "deepseek"
    pipe._model = "deepseek-v4-flash"
    pipe._qa_history = []
    pipe._last_answer = ""
    pipe._cancel = threading.Event()
    pipe._gen_seq = 0
    pipe._stream = None
    pipe._stream_mu = threading.Lock()
    pipe.user_id = None
    pipe.usage_session_id = None
    pipe._heard_lang = None
    pipe._strip_nod_tag = lambda t: t
    pipe._is_internal = lambda t, mode: False
    pipe._with_images = lambda msgs, images: msgs
    pipe._build_messages = lambda t, mode: [{"role": "user", "content": t}]
    pipe._new_qid = lambda: "q1"
    return pipe


class _Delta:
    def __init__(self, text: str):
        self.content = text
        self.reasoning_content = None


class _Choice:
    def __init__(self, text: str):
        self.delta = _Delta(text)


class _Chunk:
    def __init__(self, text: str):
        self.choices = [_Choice(text)]


class CloseLlmStreamTests(unittest.TestCase):
    def test_close_calls_stream_close(self):
        stream = mock.Mock()
        _close_llm_stream(stream)
        stream.close.assert_called_once()

    def test_close_none_is_safe(self):
        _close_llm_stream(None)


class AbortAndRetryTests(unittest.TestCase):
    def test_abort_closes_the_open_stream(self):
        pipe = _pipe()
        stream = mock.Mock()
        pipe._stream = stream
        pipe.abort_stream()
        stream.close.assert_called_once()
        self.assertTrue(pipe._cancel.is_set())
        self.assertIsNone(pipe._stream)

    def test_timeout_after_stream_opens_does_not_retry(self):
        pipe = _pipe()
        stream = mock.MagicMock()
        stream.__iter__.side_effect = TimeoutError("read timed out")
        create = mock.Mock(return_value=stream)
        pipe.client = mock.Mock()
        pipe.client.chat.completions.create = create
        pipe.process_text("Where is the capital of China?", "ask")
        self.assertEqual(create.call_count, 1)
        stream.close.assert_called()

    def test_connect_failure_still_retries_once(self):
        pipe = _pipe()
        create = mock.Mock(side_effect=[
            ConnectionError("connection reset"),
            [_Chunk("Beijing")],
        ])
        pipe.client = mock.Mock()
        pipe.client.chat.completions.create = create
        pipe.process_text("Where is the capital of China?", "ask")
        self.assertEqual(create.call_count, 2)

    def test_cancel_mid_stream_closes_and_emits_done(self):
        pipe = _pipe()
        events: list[dict] = []
        pipe.emit = events.append
        stream = mock.MagicMock()

        def chunks():
            yield _Chunk("Bei")
            pipe._cancel.set()
            yield _Chunk("jing")

        stream.__iter__.side_effect = chunks
        pipe.client = mock.Mock()
        pipe.client.chat.completions.create.return_value = stream
        pipe.process_text("Where is the capital of China?", "ask")
        stream.close.assert_called()
        self.assertTrue(any(e.get("type") == "done" and e.get("ok") is False for e in events))


class StopListenDoesNotAbortLlmTests(unittest.TestCase):
    def test_stop_listen_leaves_generation_running(self):
        sess = Session.__new__(Session)
        sess._listener = None
        sess._listen_wanted = True
        sess._manual = False
        sess.user_id = "user-1"
        sess.usage_session_id = "sess-1"
        sess._workspace = "interview"
        sess.pipeline = mock.Mock()
        sess.pipeline._cancel = threading.Event()
        sess.pipeline.abort_stream = mock.Mock()
        sess.emit = mock.Mock()
        sess._offer_save_history = mock.Mock()
        sess.stop_listen()
        sess.pipeline.abort_stream.assert_not_called()
        self.assertFalse(sess.pipeline._cancel.is_set())


class ModelRoutingTests(unittest.TestCase):
    """Text generation uses deepseek-v4-flash; only an image-bearing deepseek
    request switches to the vision model (VISION_MODEL)."""

    def _pipe_with_create(self):
        pipe = _pipe()
        create = mock.Mock(return_value=[_Chunk("ok")])
        pipe.client = mock.Mock()
        pipe.client.chat.completions.create = create
        return pipe, create

    def test_text_uses_flash(self):
        pipe, create = self._pipe_with_create()
        pipe.process_text("Hello", "ask")
        self.assertEqual(create.call_args.kwargs["model"], "deepseek-v4-flash")

    def test_image_uses_vision(self):
        pipe, create = self._pipe_with_create()
        pipe.process_text("What is in this image?", "file_ask", images=[
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,xxx"}}
        ])
        self.assertEqual(create.call_args.kwargs["model"], "deepseek-v4-flash-vision-exp")

    def test_other_provider_keeps_own_model(self):
        pipe, create = self._pipe_with_create()
        pipe._provider = "openrouter"
        pipe._model = "openai/gpt-4o"
        pipe.process_text("Hello", "ask", images=[
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,xxx"}}
        ])
        self.assertEqual(create.call_args.kwargs["model"], "openai/gpt-4o")
