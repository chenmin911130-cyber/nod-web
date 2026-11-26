"""Gemini primary text LLM (server/gemini_llm.py) and how the app routes to it.

Replaces the old Ollama web-tools test. No network: httpx is faked.

Pinned here:
* thinking is explicitly off on every Gemini request (thinkingBudget 0);
* google_search grounding only when asked, and the app asks only for
  ask / file_ask / listen_ask text questions;
* DeepSeek fallback runs before the first content token only (and for
  non-stream calls on any failure);
* Think answers never go through Gemini; caption repair / judge / titles use
  flash-lite without grounding.
"""

import json
import threading
import unittest
import uuid
from types import SimpleNamespace
from unittest import mock

import httpx

from server import gemini_llm
from server.app import PROVIDER_ENDPOINTS, PROVIDER_KEY, Pipeline


def _sse(*objs, raw_lines=()):
    lines = [f"data: {json.dumps(o)}" for o in objs]
    return [*lines, *raw_lines]


def _gchunk(text="", *, finish=None, usage=None, grounding=None):
    cand = {"content": {"role": "model", "parts": [{"text": text}] if text else []}}
    if finish:
        cand["finishReason"] = finish
    if grounding:
        cand["groundingMetadata"] = grounding
    out = {"candidates": [cand]}
    if usage:
        out["usageMetadata"] = usage
    return out


class _FakeStreamResponse:
    def __init__(self, status_code=200, lines=(), explode_after=None):
        self.status_code = status_code
        self._lines = list(lines)
        self._explode_after = explode_after
        self.request = mock.Mock()
        self.closed = False

    def iter_lines(self):
        for i, line in enumerate(self._lines):
            if self._explode_after is not None and i == self._explode_after:
                raise httpx.ReadTimeout("stalled")
            yield line
        if self._explode_after is not None and self._explode_after >= len(self._lines):
            raise httpx.ReadTimeout("stalled")

    def close(self):
        self.closed = True


class _FakePostResponse:
    def __init__(self, status_code=200, body=None):
        self.status_code = status_code
        self._body = body or {}
        self.request = mock.Mock()

    def json(self):
        return self._body


class _FakeClient:
    """Stands in for httpx.Client for both stream (send) and non-stream (post)."""

    instances: list["_FakeClient"] = []

    def __init__(self, *, stream_response=None, post_response=None, send_exc=None):
        self.stream_response = stream_response
        self.post_response = post_response
        self.send_exc = send_exc
        self.requests: list[dict] = []
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def build_request(self, method, url, headers=None, json=None):
        self.requests.append({"url": url, "headers": headers, "json": json})
        return SimpleNamespace(url=url)

    def send(self, request, stream=False):
        if self.send_exc:
            raise self.send_exc
        return self.stream_response

    def post(self, url, headers=None, json=None):
        self.requests.append({"url": url, "headers": headers, "json": json})
        return self.post_response

    def close(self):
        self.closed = True


def _fallback_stream(text="fallback answer"):
    calls = []

    def fb():
        calls.append(1)
        return [SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=text, reasoning_content=None))], usage=None)]

    return fb, calls


def _texts(stream):
    return "".join((c.choices[0].delta.content or "") for c in stream if getattr(c, "choices", None))


BASE_KW = {
    "model": "deepseek-v4-flash",
    "messages": [
        {"role": "system", "content": "Be brief."},
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
        {"role": "user", "content": "what is new?"},
    ],
    "max_tokens": 1600,
    "temperature": 0.5,
    "stream": True,
    "stream_options": {"include_usage": True},
    "extra_body": {"thinking": {"type": "disabled"}},
}


class _KeyEnv(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict("os.environ", {"GEMINI_API_KEY": "unit-test-gemini"}, clear=False)
        self.env.start()

    def tearDown(self):
        self.env.stop()


class RequestBodyTests(unittest.TestCase):
    def test_thinking_is_always_explicitly_off_and_roles_map(self):
        body = gemini_llm.build_request_body(BASE_KW, grounding=False)
        self.assertEqual(body["generationConfig"]["thinkingConfig"], {"thinkingBudget": 0})
        self.assertEqual(body["generationConfig"]["maxOutputTokens"], 1600)
        self.assertEqual(body["generationConfig"]["temperature"], 0.5)
        self.assertEqual(body["systemInstruction"], {"parts": [{"text": "Be brief."}]})
        self.assertEqual([c["role"] for c in body["contents"]], ["user", "model", "user"])
        self.assertNotIn("tools", body)
        # provider-specific OpenAI kwargs never leak into the Gemini request
        self.assertNotIn("extra_body", json.dumps(body))

    def test_grounding_adds_google_search_tool_only(self):
        body = gemini_llm.build_request_body(BASE_KW, grounding=True)
        self.assertEqual(body["tools"], [{"google_search": {}}])

    def test_inline_images_become_inline_data_and_same_roles_merge(self):
        kw = {
            "messages": [
                {"role": "user", "content": "context"},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "what is this?"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}},
                    ],
                },
            ]
        }
        body = gemini_llm.build_request_body(kw, grounding=False)
        self.assertEqual(len(body["contents"]), 1)
        self.assertEqual(
            body["contents"][0]["parts"],
            [{"text": "context"}, {"text": "what is this?"}, {"inlineData": {"mimeType": "image/png", "data": "QUJD"}}],
        )

    def test_remote_image_url_is_refused_so_the_fallback_takes_it(self):
        kw = {"messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://x/y.png"}}]}]}
        with self.assertRaises(ValueError):
            gemini_llm.build_request_body(kw, grounding=False)


class NonStreamTests(_KeyEnv):
    def _call(self, post_response, **kw):
        fb_calls = []

        def fb():
            fb_calls.append(1)
            return "FALLBACK"

        client = _FakeClient(post_response=post_response)
        with mock.patch("server.gemini_llm.httpx.Client", return_value=client):
            out = gemini_llm.chat_completions_with_gemini_fallback(
                kwargs={**BASE_KW, "stream": False}, timeout=6.0, fallback=fb, model="gemini-3.1-flash-lite", **kw
            )
        return out, fb_calls, client

    def test_success_parses_text_usage_and_uses_given_model(self):
        body = _gchunk(
            "Kubernetes.",
            finish="STOP",
            usage={"promptTokenCount": 10, "candidatesTokenCount": 3, "thoughtsTokenCount": 0},
        )
        out, fb, client = self._call(_FakePostResponse(200, body))
        self.assertEqual(fb, [])
        self.assertEqual(out.choices[0].message.content, "Kubernetes.")
        self.assertEqual((out.usage.prompt_tokens, out.usage.completion_tokens), (10, 3))
        self.assertIn("models/gemini-3.1-flash-lite:generateContent", client.requests[0]["url"])
        self.assertNotIn("tools", client.requests[0]["json"])
        self.assertEqual(client.requests[0]["headers"]["x-goog-api-key"], "unit-test-gemini")

    def test_http_error_falls_back(self):
        out, fb, _ = self._call(_FakePostResponse(503, {"error": {"code": 503}}))
        self.assertEqual((out, fb), ("FALLBACK", [1]))

    def test_empty_or_blocked_answer_falls_back(self):
        out, fb, _ = self._call(_FakePostResponse(200, {"promptFeedback": {"blockReason": "SAFETY"}}))
        self.assertEqual((out, fb), ("FALLBACK", [1]))

    def test_no_key_never_calls_gemini(self):
        with mock.patch.dict("os.environ", {"GEMINI_API_KEY": ""}), mock.patch(
            "server.gemini_llm.httpx.Client"
        ) as Client:
            out = gemini_llm.chat_completions_with_gemini_fallback(
                kwargs={**BASE_KW, "stream": False}, timeout=6.0, fallback=lambda: "FALLBACK"
            )
        self.assertEqual(out, "FALLBACK")
        Client.assert_not_called()


class StreamTests(_KeyEnv):
    def _stream(self, response=None, *, grounding=False, send_exc=None):
        fb, calls = _fallback_stream()
        client = _FakeClient(stream_response=response, send_exc=send_exc)
        patcher = mock.patch("server.gemini_llm.httpx.Client", return_value=client)
        patcher.start()
        self.addCleanup(patcher.stop)
        stream = gemini_llm.chat_completions_with_gemini_fallback(
            kwargs=BASE_KW, timeout=25.0, fallback=fb, grounding=grounding
        )
        return stream, calls, client

    def test_streams_text_usage_and_grounding_sources(self):
        grounding = {
            "webSearchQueries": ["nvda close nov 26 2026"],
            "groundingChunks": [{"web": {"uri": "https://example.com/a", "title": "example.com"}}],
        }
        resp = _FakeStreamResponse(
            200,
            _sse(
                _gchunk("NVDA closed ", usage={"promptTokenCount": 9, "candidatesTokenCount": 2}),
                _gchunk(
                    "at $1.",
                    finish="STOP",
                    usage={"promptTokenCount": 9, "candidatesTokenCount": 5, "toolUsePromptTokenCount": 40},
                    grounding=grounding,
                ),
            ),
        )
        stream, fb, client = self._stream(resp, grounding=True)
        chunks = list(stream)
        self.assertEqual(_texts(chunks), "NVDA closed at $1.")
        self.assertEqual(fb, [])
        self.assertEqual(stream.provider, "gemini")
        self.assertEqual(stream.search_queries, 1)
        self.assertEqual(stream.grounding["sources"], [{"title": "example.com", "uri": "https://example.com/a"}])
        last_usage = [c.usage for c in chunks if c.usage][-1]
        self.assertEqual((last_usage.prompt_tokens, last_usage.completion_tokens), (49, 5))
        req = client.requests[0]
        self.assertIn("models/gemini-3.8-flash:streamGenerateContent?alt=sse", req["url"])
        self.assertEqual(req["json"]["tools"], [{"google_search": {}}])
        self.assertEqual(req["json"]["generationConfig"]["thinkingConfig"], {"thinkingBudget": 0})

    def test_http_429_before_first_token_falls_back(self):
        stream, fb, _ = self._stream(_FakeStreamResponse(429))
        self.assertEqual(_texts(stream), "fallback answer")
        self.assertEqual((fb, stream.provider), ([1], "fallback"))

    def test_connect_error_falls_back(self):
        stream, fb, _ = self._stream(send_exc=httpx.ConnectError("down"))
        self.assertEqual(_texts(stream), "fallback answer")
        self.assertEqual(fb, [1])

    def test_read_timeout_before_first_token_falls_back(self):
        resp = _FakeStreamResponse(200, _sse(_gchunk("", usage={"promptTokenCount": 3})), explode_after=1)
        stream, fb, _ = self._stream(resp)
        self.assertEqual(_texts(stream), "fallback answer")
        self.assertEqual(fb, [1])
        self.assertTrue(resp.closed)

    def test_empty_stream_falls_back(self):
        resp = _FakeStreamResponse(200, _sse(_gchunk("", finish="SAFETY")))
        stream, fb, _ = self._stream(resp)
        self.assertEqual(_texts(stream), "fallback answer")
        self.assertEqual(fb, [1])

    def test_malformed_sse_before_content_falls_back(self):
        resp = _FakeStreamResponse(200, ["data: {not json"])
        stream, fb, _ = self._stream(resp)
        self.assertEqual(_texts(stream), "fallback answer")
        self.assertEqual(fb, [1])

    def test_error_after_first_token_is_raised_never_restarted(self):
        resp = _FakeStreamResponse(200, _sse(_gchunk("partial ")), explode_after=1)
        stream, fb, _ = self._stream(resp)
        got = next(stream)
        self.assertEqual(got.choices[0].delta.content, "partial ")
        with self.assertRaises(httpx.ReadTimeout):
            next(stream)
        self.assertEqual(fb, [])

    def test_close_closes_the_gemini_response(self):
        resp = _FakeStreamResponse(200, _sse(_gchunk("a"), _gchunk("b")))
        stream, _, client = self._stream(resp)
        next(stream)
        stream.close()
        self.assertTrue(resp.closed)
        self.assertTrue(client.closed)


# ------------------------------------------------------------------ app routing


def _pipe(events):
    pipe = Pipeline.__new__(Pipeline)
    pipe.cfg = {"llm": {"provider": "deepseek", "model": "deepseek-v4-flash", "max_tokens": 80}}
    pipe.emit = events.append
    pipe._provider = "deepseek"
    pipe._model = "deepseek-v4-flash"
    pipe.client = mock.Mock()
    pipe.client.chat.completions.create.return_value = [
        SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="deepseek", reasoning_content=None))], usage=None)
    ]
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


def _gemini_stream_returning(text="gemini answer"):
    return [SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=text, reasoning_content=None))], usage=None)]


class AppRoutingTests(_KeyEnv):
    def _run(self, mode, *, images=None, think=False):
        events: list[dict] = []
        pipe = _pipe(events)
        with mock.patch(
            "server.app.chat_completions_with_gemini_fallback", return_value=_gemini_stream_returning()
        ) as g:
            pipe.process_text("what is new?", mode, images=images, think=think)
        return g, pipe, events

    def test_qa_modes_are_grounded(self):
        for mode in ("ask", "file_ask", "listen_ask"):
            g, pipe, events = self._run(mode)
            self.assertTrue(g.call_args.kwargs["grounding"], mode)
            self.assertIn("gemini answer", "".join(e.get("text", "") for e in events if e.get("type") == "chunk"))
            pipe.client.chat.completions.create.assert_not_called()

    def test_translate_notes_and_image_questions_are_not_grounded(self):
        for mode in ("translate", "notes"):
            g, _, _ = self._run(mode)
            self.assertFalse(g.call_args.kwargs["grounding"], mode)
        g, _, _ = self._run("ask", images=[{"mime": "image/png", "data": "QUJD"}])
        self.assertFalse(g.call_args.kwargs["grounding"])

    def test_fallback_keeps_deepseek_thinking_disabled(self):
        g, pipe, _ = self._run("ask")
        g.call_args.kwargs["fallback"]()
        kw = pipe.client.chat.completions.create.call_args.kwargs
        self.assertEqual(kw["extra_body"], {"thinking": {"type": "disabled"}})
        self.assertEqual(kw["model"], "deepseek-v4-flash")

    def test_think_never_goes_through_gemini(self):
        events: list[dict] = []
        pipe = _pipe(events)
        pipe.think_client = mock.Mock()
        from server import think as think_search

        pipe.think_client.search.return_value = think_search.SearchOutcome(
            status=think_search.STATUS_OK, query="q", results=(), retrieved_at=0.0
        )
        with mock.patch("server.app.chat_completions_with_gemini_fallback") as g:
            pipe.process_text("what is new?", "ask", think=True)
        g.assert_not_called()
        kw = pipe.client.chat.completions.create.call_args.kwargs
        self.assertEqual(kw["extra_body"]["thinking"], {"type": "enabled"})

    def test_judge_and_caption_repair_use_lite_without_grounding(self):
        events: list[dict] = []
        pipe = _pipe(events)
        resp = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="ok", reasoning_content=""))], usage=None)
        with mock.patch("server.app.chat_completions_with_gemini_fallback", return_value=resp) as g:
            pipe.judge_qa([{"role": "user", "content": "x"}])
            self.assertEqual(g.call_args.kwargs["model"], gemini_llm.gemini_lite_model())
            self.assertFalse(g.call_args.kwargs.get("grounding", False))
            pipe.repair_caption("we use kubernetis for deploy", ["previous line"])
            self.assertEqual(g.call_args.kwargs["model"], gemini_llm.gemini_lite_model())
            self.assertFalse(g.call_args.kwargs.get("grounding", False))

    def test_key_status_counts_gemini_and_provider_tables(self):
        pipe = _pipe([])
        pipe._keys = {}
        pipe.assemblyai_key = lambda: ""
        self.assertTrue(pipe.key_status()["has_llm"])  # GEMINI_API_KEY in env
        with mock.patch.dict("os.environ", {"GEMINI_API_KEY": ""}):
            self.assertFalse(pipe.key_status()["has_llm"])
        self.assertIn("gemini", PROVIDER_ENDPOINTS)
        self.assertEqual(PROVIDER_KEY["gemini"], "GEMINI_API_KEY")
        self.assertNotIn("ollama", json.dumps(PROVIDER_ENDPOINTS))


class HistoryTitleTests(_KeyEnv):
    def test_titles_use_lite_without_grounding_and_deepseek_fallback(self):
        from server import history_title

        with mock.patch("server.gemini_llm.chat_completions_with_gemini_fallback", return_value="R") as g:
            out = history_title._default_complete([{"role": "user", "content": "t"}])
        self.assertEqual(out, "R")
        self.assertEqual(g.call_args.kwargs["model"], gemini_llm.gemini_lite_model())
        self.assertFalse(g.call_args.kwargs.get("grounding", False))


class MeterRateTests(unittest.TestCase):
    def test_grounded_search_queries_are_metered(self):
        from server.meter import _cost_llm
        from server.settings import GEMINI_SEARCH_USD_PER_QUERY

        self.assertAlmostEqual(_cost_llm(0, 0, 2), 2 * GEMINI_SEARCH_USD_PER_QUERY)
        self.assertAlmostEqual(_cost_llm(1000, 1000), _cost_llm(1000, 1000, 0))

    def test_default_rates_match_gemini_flash_list_price(self):
        import os

        from server import settings

        if any(os.environ.get(k) for k in ("LLM_USD_PER_1K_IN", "LLM_USD_PER_1K_OUT", "GEMINI_SEARCH_USD_PER_QUERY")):
            self.skipTest("rate overridden in the environment")
        self.assertAlmostEqual(settings.LLM_USD_PER_1K_IN, 0.00075)
        self.assertAlmostEqual(settings.LLM_USD_PER_1K_OUT, 0.00375)
        self.assertAlmostEqual(settings.GEMINI_SEARCH_USD_PER_QUERY, 0.014)

if __name__ == "__main__":
    unittest.main()
