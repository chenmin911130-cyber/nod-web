"""Ollama cloud web_search / web_fetch tool loop (server-side)."""

import json
import unittest
from types import SimpleNamespace
from unittest import mock

from server import ollama_llm


class _FakeResponse:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self.text = json.dumps(body)
        self.request = mock.Mock()

    def json(self):
        return json.loads(self.text)


class _FakeClient:
    def __init__(self, posts: list[tuple[str, dict, _FakeResponse]]):
        self._posts = list(posts)
        self.calls: list[tuple[str, dict]] = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def post(self, url: str, *, headers=None, json=None):
        self.calls.append((url, json or {}))
        if not self._posts:
            raise AssertionError(f"unexpected post {url}")
        expected_url, expected_json, response = self._posts.pop(0)
        if expected_url:
            assert url == expected_url, (url, expected_url)
        if expected_json:
            for key, val in expected_json.items():
                assert (json or {}).get(key) == val
        return response


class OllamaWebToolsTests(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(
            "os.environ",
            {"OLLAMA_API_KEY": "unit-test-key", "OLLAMA_MODEL": "deepseek-v4.1-flash"},
            clear=False,
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_execute_web_search_failure_returns_error_json_not_raise(self):
        with mock.patch("server.ollama_llm.httpx.Client") as Client:
            client = _FakeClient(
                [
                    (
                        ollama_llm.OLLAMA_WEB_SEARCH_URL,
                        {"query": "news"},
                        _FakeResponse(503, {"error": "busy"}),
                    )
                ]
            )
            Client.return_value = client
            out = ollama_llm._execute_web_tool("web_search", json.dumps({"query": "news"}))
        data = json.loads(out)
        self.assertEqual(data.get("error"), "http_503")

    def test_tool_loop_runs_search_then_returns_answer(self):
        chat_tool = {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "web_search",
                                    "arguments": json.dumps({"query": "recent news"}),
                                },
                            }
                        ],
                    }
                }
            ]
        }
        chat_final = {
            "choices": [{"message": {"role": "assistant", "content": "Here is the news."}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2},
        }

        def fake_post(payload, _timeout):
            if payload.get("tools"):
                if len(payload["messages"]) == 1:
                    return chat_tool
                return chat_final
            raise AssertionError("unexpected no-tools call")

        with mock.patch("server.ollama_llm._ollama_post") as post, mock.patch(
            "server.ollama_llm._execute_web_tool", return_value='{"results":[]}'
        ) as run_tool:
            post.side_effect = lambda payload, timeout: _FakeResponse(200, fake_post(payload, timeout))
            parsed = ollama_llm._ollama_chat_with_web_tools(
                {"messages": [{"role": "user", "content": "What happened today?"}]},
                ollama_timeout=5.0,
            )
        self.assertEqual(ollama_llm._completion_text(parsed), "Here is the news.")
        run_tool.assert_called_once()

    def test_tool_result_truncation(self):
        long_text = "x" * (ollama_llm.OLLAMA_WEB_TOOL_RESULT_MAX_CHARS + 50)
        with mock.patch(
            "server.ollama_llm._ollama_web_api_post", return_value={"content": long_text}
        ):
            out = ollama_llm._execute_web_tool("web_fetch", json.dumps({"url": "https://example.com"}))
        self.assertLessEqual(len(out), ollama_llm.OLLAMA_WEB_TOOL_RESULT_MAX_CHARS + 20)
        self.assertTrue(out.endswith("…[truncated]"))

    def test_chat_fallback_kwargs_omit_ollama_web_tools(self):
        """Think-off chat enables tools on the Ollama path only; DeepSeek fallback stays unchanged."""
        events: list[dict] = []
        from server.app import Pipeline

        pipe = Pipeline.__new__(Pipeline)
        pipe.cfg = {"llm": {"provider": "deepseek", "model": "deepseek-flash", "max_tokens": 80}}
        pipe.emit = events.append
        pipe._provider = "deepseek"
        pipe._model = "deepseek-flash"
        pipe.client = mock.Mock()
        pipe.client.chat.completions.create.return_value = iter(
            [
                SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(content="Answer.", reasoning_content=None)
                        )
                    ],
                    usage=None,
                )
            ]
        )
        pipe._keys = {"DEEPSEEK_API_KEY": "unit-test-key"}
        pipe._think_llm = (pipe.client, "deepseek-v4-flash")
        pipe._qa_history = []
        pipe._last_answer = ""
        pipe._cancel = __import__("threading").Event()
        pipe._gen_seq = 0
        pipe.user_id = None
        pipe.usage_session_id = "sess-test"
        pipe._heard_lang = None
        pipe.think_client = None

        captured: dict = {}

        def fake_ollama(**kw):
            captured.update(kw)
            kw["fallback"]()
            return pipe.client.chat.completions.create.return_value

        with mock.patch("server.app.chat_completions_with_ollama_fallback", side_effect=fake_ollama):
            pipe.process_text("What major news broke this week?", "ask", think=False)

        self.assertTrue(captured.get("kwargs", {}).get("ollama_web_tools"))
        # Fallback path uses the original kwargs without the Ollama-only flag.
        self.assertIsNotNone(pipe.client.chat.completions.create.call_args)
        self.assertNotIn("ollama_web_tools", pipe.client.chat.completions.create.call_args.kwargs)


if __name__ == "__main__":
    unittest.main()
