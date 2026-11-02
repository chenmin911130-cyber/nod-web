"""Ollama Cloud OpenAI-compatible chat/completions (optional primary for text LLM)."""

from __future__ import annotations

import json
import logging
import os
from types import SimpleNamespace
from typing import Any, Callable, Iterator

import httpx

_log = logging.getLogger("nod.ollama")

DEFAULT_OLLAMA_BASE = "https://ollama.com/v1"
DEFAULT_OLLAMA_MODEL = "deepseek-v4.1-flash"

OLLAMA_CONNECT_TIMEOUT_S = 2.5
OLLAMA_NON_STREAM_TIMEOUT_S = 6.0
OLLAMA_STREAM_TRANSLATE_READ_S = 12.0
OLLAMA_STREAM_DEFAULT_READ_S = 25.0

OLLAMA_WEB_SEARCH_URL = "https://ollama.com/api/web_search"
OLLAMA_WEB_FETCH_URL = "https://ollama.com/api/web_fetch"
OLLAMA_WEB_TOOL_TIMEOUT_S = 20.0
OLLAMA_WEB_TOOL_MAX_ITERATIONS = 4
OLLAMA_WEB_TOOL_RESULT_MAX_CHARS = 8000

OLLAMA_WEB_TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for up-to-date information.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query string"},
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of results (default 5, max 10)",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": "Fetch the main content of a web page by URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to fetch"},
                },
                "required": ["url"],
            },
        },
    },
]


def ollama_api_key() -> str:
    return (os.environ.get("OLLAMA_API_KEY") or "").strip()


def ollama_base_url() -> str:
    raw = (os.environ.get("OLLAMA_BASE_URL") or DEFAULT_OLLAMA_BASE).strip().rstrip("/")
    return raw or DEFAULT_OLLAMA_BASE


def ollama_chat_url() -> str:
    return f"{ollama_base_url()}/chat/completions"


def ollama_model() -> str:
    return (os.environ.get("OLLAMA_MODEL") or DEFAULT_OLLAMA_MODEL).strip() or DEFAULT_OLLAMA_MODEL


def ollama_configured() -> bool:
    return bool(ollama_api_key())


def _strip_for_ollama(kwargs: dict[str, Any]) -> dict[str, Any]:
    out = {
        k: v
        for k, v in kwargs.items()
        if k not in ("extra_body", "reasoning_effort", "ollama_web_tools")
    }
    out["model"] = ollama_model()
    return out


def _httpx_timeout(read_s: float, *, connect_s: float = OLLAMA_CONNECT_TIMEOUT_S) -> httpx.Timeout:
    return httpx.Timeout(read_s, connect=connect_s, read=read_s, write=read_s, pool=connect_s)


def _ns_usage(data: dict[str, Any] | None) -> Any | None:
    if not data:
        return None
    return SimpleNamespace(
        prompt_tokens=data.get("prompt_tokens"),
        completion_tokens=data.get("completion_tokens"),
    )


def _ns_tool_call(data: dict[str, Any]) -> Any:
    fn = data.get("function") if isinstance(data.get("function"), dict) else {}
    return SimpleNamespace(
        id=data.get("id") or "",
        type=data.get("type") or "function",
        function=SimpleNamespace(
            name=fn.get("name") or "",
            arguments=fn.get("arguments") or "{}",
        ),
    )


def _ns_message(data: dict[str, Any] | None) -> Any:
    data = data or {}
    tool_calls_raw = data.get("tool_calls") if isinstance(data.get("tool_calls"), list) else []
    tool_calls = [_ns_tool_call(tc) for tc in tool_calls_raw if isinstance(tc, dict)]
    msg = SimpleNamespace(content=data.get("content") or "")
    if tool_calls:
        msg.tool_calls = tool_calls
    return msg


def _ns_choice(data: dict[str, Any]) -> Any:
    delta = data.get("delta") or {}
    return SimpleNamespace(
        delta=SimpleNamespace(
            content=delta.get("content"),
            reasoning_content=delta.get("reasoning_content"),
        ),
        message=_ns_message(data.get("message")),
    )


def _parse_completion_body(body: dict[str, Any]) -> Any:
    choices_raw = body.get("choices") or []
    choices = [_ns_choice(c) for c in choices_raw]
    return SimpleNamespace(choices=choices, usage=_ns_usage(body.get("usage")))


def _chunk_has_content_token(chunk: Any) -> bool:
    if chunk is None or not getattr(chunk, "choices", None):
        return False
    delta = chunk.choices[0].delta
    piece = getattr(delta, "content", None) or ""
    return bool(piece)


def _completion_text(resp: Any) -> str:
    if resp is None or not getattr(resp, "choices", None):
        return ""
    msg = resp.choices[0].message
    return (getattr(msg, "content", None) or "").strip()


def _truncate_tool_result(text: str) -> str:
    if len(text) <= OLLAMA_WEB_TOOL_RESULT_MAX_CHARS:
        return text
    return text[:OLLAMA_WEB_TOOL_RESULT_MAX_CHARS] + "…[truncated]"


def _ollama_web_api_post(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {ollama_api_key()}",
        "Content-Type": "application/json",
    }
    try:
        with httpx.Client(timeout=_httpx_timeout(OLLAMA_WEB_TOOL_TIMEOUT_S)) as client:
            res = client.post(url, headers=headers, json=payload)
        if res.status_code >= 400:
            return {"error": f"http_{res.status_code}", "detail": (res.text or "")[:500]}
        data = res.json()
        return data if isinstance(data, dict) else {"error": "invalid_response"}
    except httpx.TimeoutException:
        return {"error": "timeout"}
    except Exception as exc:
        return {"error": exc.__class__.__name__, "detail": str(exc)[:500]}


def _execute_web_tool(name: str, arguments_raw: str) -> str:
    try:
        args = json.loads(arguments_raw or "{}")
        if not isinstance(args, dict):
            args = {}
    except json.JSONDecodeError:
        args = {}
    if name == "web_search":
        query = str(args.get("query") or "").strip()
        if not query:
            return _truncate_tool_result(json.dumps({"error": "missing_query"}))
        body: dict[str, Any] = {"query": query}
        max_results = args.get("max_results")
        if isinstance(max_results, int) and max_results > 0:
            body["max_results"] = min(max_results, 10)
        return _truncate_tool_result(json.dumps(_ollama_web_api_post(OLLAMA_WEB_SEARCH_URL, body)))
    if name == "web_fetch":
        url = str(args.get("url") or "").strip()
        if not url:
            return _truncate_tool_result(json.dumps({"error": "missing_url"}))
        return _truncate_tool_result(json.dumps(_ollama_web_api_post(OLLAMA_WEB_FETCH_URL, {"url": url})))
    return _truncate_tool_result(json.dumps({"error": "unknown_tool", "name": name}))


def _message_has_tool_calls(message: dict[str, Any]) -> bool:
    tool_calls = message.get("tool_calls")
    return isinstance(tool_calls, list) and len(tool_calls) > 0


def _ollama_post(payload: dict[str, Any], ollama_timeout: float) -> httpx.Response:
    headers = {
        "Authorization": f"Bearer {ollama_api_key()}",
        "Content-Type": "application/json",
    }
    with httpx.Client(timeout=_httpx_timeout(ollama_timeout)) as client:
        res = client.post(ollama_chat_url(), headers=headers, json=payload)
    if res.status_code == 429:
        raise httpx.HTTPStatusError("ollama rate limited", request=res.request, response=res)
    if res.status_code >= 400:
        raise httpx.HTTPStatusError(
            f"ollama http {res.status_code}", request=res.request, response=res
        )
    return res


def _ollama_chat_once(payload: dict[str, Any], ollama_timeout: float) -> dict[str, Any]:
    res = _ollama_post(payload, ollama_timeout)
    try:
        body = res.json()
    except json.JSONDecodeError as exc:
        raise ValueError("ollama invalid json") from exc
    if not isinstance(body, dict):
        raise ValueError("ollama invalid response shape")
    choices = body.get("choices") or []
    if not choices:
        raise ValueError("ollama empty choices")
    return body


def _ollama_chat_with_web_tools(payload: dict[str, Any], ollama_timeout: float) -> Any:
    """Non-stream chat with Ollama web_search / web_fetch tool loop."""
    messages: list[Any] = list(payload.get("messages") or [])
    base_payload = {k: v for k, v in payload.items() if k not in ("messages", "stream")}
    base_payload["stream"] = False
    base_payload["tools"] = OLLAMA_WEB_TOOL_DEFINITIONS

    last_body: dict[str, Any] | None = None
    for _ in range(OLLAMA_WEB_TOOL_MAX_ITERATIONS):
        body = _ollama_chat_once({**base_payload, "messages": messages}, ollama_timeout)
        last_body = body
        choice0 = (body.get("choices") or [{}])[0]
        message = choice0.get("message") if isinstance(choice0.get("message"), dict) else {}
        if _message_has_tool_calls(message):
            messages.append(message)
            for tc in message.get("tool_calls") or []:
                if not isinstance(tc, dict):
                    continue
                fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
                name = str(fn.get("name") or "")
                arguments = fn.get("arguments")
                if not isinstance(arguments, str):
                    arguments = json.dumps(arguments or {})
                result = _execute_web_tool(name, arguments)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": str(tc.get("id") or ""),
                        "content": result,
                    }
                )
            continue
        parsed = _parse_completion_body(body)
        if _completion_text(parsed):
            return parsed
        raise ValueError("ollama empty completion")

    # Cap reached: one final answer without tools so the chat still completes.
    if last_body is not None and _message_has_tool_calls(
        ((last_body.get("choices") or [{}])[0].get("message") or {})
    ):
        _log.info("ollama web tools iteration cap reached")
    no_tools = {k: v for k, v in base_payload.items() if k != "tools"}
    body = _ollama_chat_once({**no_tools, "messages": messages}, ollama_timeout)
    parsed = _parse_completion_body(body)
    if not _completion_text(parsed):
        raise ValueError("ollama empty completion")
    return parsed


def _ollama_chat_complete(payload: dict[str, Any], ollama_timeout: float) -> Any:
    body = _ollama_chat_once(payload, ollama_timeout)
    parsed = _parse_completion_body(body)
    if not _completion_text(parsed):
        raise ValueError("ollama empty completion")
    return parsed


def _iter_ollama_sse(
    res: httpx.Response,
    *,
    saw_content: Callable[[], bool],
) -> Iterator[Any]:
    try:
        for line in res.iter_lines():
            if not line:
                continue
            if isinstance(line, bytes):
                line = line.decode("utf-8", errors="replace")
            line = line.strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError as exc:
                if not saw_content():
                    raise ValueError("ollama malformed sse") from exc
                continue
            if isinstance(chunk, dict):
                yield _parse_completion_body(chunk)
    finally:
        res.close()


class _OllamaWebToolsStream:
    """Run the web-tool loop (non-stream), then emit the final answer as SSE-shaped chunks."""

    def __init__(
        self,
        payload: dict[str, Any],
        ollama_timeout: float,
        fallback: Callable[[], Any],
    ):
        self._payload = payload
        self._ollama_timeout = ollama_timeout
        self._fallback = fallback
        self._started = False
        self._using_fallback = False
        self._inner: Iterator[Any] | None = None
        self._fallback_stream: Any = None

    def _start(self) -> None:
        if self._started:
            return
        self._started = True
        try:
            parsed = _ollama_chat_with_web_tools(self._payload, self._ollama_timeout)
            text = _completion_text(parsed)
            usage = getattr(parsed, "usage", None)
            self._inner = iter(_synthetic_stream_chunks(text, usage))
        except Exception as exc:
            _log.info("ollama web tools stream fallback reason=%s", exc.__class__.__name__)
            self._using_fallback = True
            self._fallback_stream = self._fallback()
            self._inner = iter(self._fallback_stream)

    def __iter__(self) -> Iterator[Any]:
        return self

    def __next__(self) -> Any:
        self._start()
        assert self._inner is not None
        return next(self._inner)

    def close(self) -> None:
        if self._fallback_stream is not None:
            try:
                close = getattr(self._fallback_stream, "close", None)
                if callable(close):
                    close()
                    return
                resp = getattr(self._fallback_stream, "response", None)
                if resp is not None:
                    resp.close()
            except Exception:
                pass


def _synthetic_stream_chunks(text: str, usage: Any | None) -> list[Any]:
    """Split final text into a few chunks so downstream streaming logic behaves normally."""
    if not text:
        return []
    step = 240
    chunks: list[Any] = []
    for i in range(0, len(text), step):
        piece = text[i : i + step]
        chunks.append(
            SimpleNamespace(
                choices=[SimpleNamespace(delta=SimpleNamespace(content=piece, reasoning_content=None))],
                usage=None,
            )
        )
    if usage is not None:
        chunks.append(SimpleNamespace(choices=[], usage=usage))
    return chunks


class _OllamaOrFallbackStream:
    """Ollama SSE first; until the first content token, errors or emptiness fall back once."""

    def __init__(
        self,
        payload: dict[str, Any],
        ollama_timeout: float,
        fallback: Callable[[], Any],
    ):
        self._payload = payload
        self._ollama_timeout = ollama_timeout
        self._fallback = fallback
        self._saw_content = False
        self._using_fallback = False
        self._ollama_client: httpx.Client | None = None
        self._ollama_response: httpx.Response | None = None
        self._ollama_iter: Iterator[Any] | None = None
        self._fallback_stream: Any = None
        self._active_iter: Iterator[Any] | None = None

    def _saw_content_fn(self) -> bool:
        return self._saw_content

    def _close_ollama(self) -> None:
        if self._ollama_response is not None:
            try:
                self._ollama_response.close()
            except Exception:
                pass
            self._ollama_response = None
        if self._ollama_client is not None:
            try:
                self._ollama_client.close()
            except Exception:
                pass
            self._ollama_client = None
        self._ollama_iter = None

    def _start_ollama(self) -> None:
        headers = {
            "Authorization": f"Bearer {ollama_api_key()}",
            "Content-Type": "application/json",
        }
        body = dict(self._payload)
        body["stream"] = True
        client = httpx.Client(timeout=_httpx_timeout(self._ollama_timeout))
        res = client.send(
            client.build_request("POST", ollama_chat_url(), headers=headers, json=body),
            stream=True,
        )
        if res.status_code == 429 or res.status_code >= 400:
            res.close()
            client.close()
            raise httpx.HTTPStatusError(f"ollama http {res.status_code}", request=res.request, response=res)
        self._ollama_client = client
        self._ollama_response = res
        self._ollama_iter = _iter_ollama_sse(res, saw_content=self._saw_content_fn)
        self._active_iter = self._ollama_iter

    def _start_fallback(self, reason: str) -> None:
        _log.info("ollama stream fallback reason=%s", reason)
        self._close_ollama()
        self._using_fallback = True
        self._fallback_stream = self._fallback()
        self._active_iter = iter(self._fallback_stream)

    def __iter__(self) -> Iterator[Any]:
        return self

    def __next__(self) -> Any:
        if self._active_iter is None:
            try:
                self._start_ollama()
            except Exception as exc:
                self._start_fallback(exc.__class__.__name__)
        while True:
            try:
                chunk = next(self._active_iter)  # type: ignore[arg-type]
            except StopIteration:
                if not self._using_fallback and not self._saw_content:
                    self._start_fallback("empty_stream")
                    continue
                raise
            except Exception as exc:
                if not self._using_fallback and not self._saw_content:
                    self._start_fallback(exc.__class__.__name__)
                    continue
                raise
            if _chunk_has_content_token(chunk):
                self._saw_content = True
            return chunk

    def close(self) -> None:
        self._close_ollama()
        if self._fallback_stream is not None:
            try:
                close = getattr(self._fallback_stream, "close", None)
                if callable(close):
                    close()
                    return
                resp = getattr(self._fallback_stream, "response", None)
                if resp is not None:
                    resp.close()
            except Exception:
                pass


def chat_completions_with_ollama_fallback(
    *,
    kwargs: dict[str, Any],
    ollama_timeout: float,
    fallback: Callable[[], Any],
) -> Any:
    """Try Ollama when configured; on failure run ``fallback`` (stream: before first content token only)."""
    if not ollama_configured():
        return fallback()
    stream = bool(kwargs.get("stream"))
    enable_web_tools = bool(kwargs.get("ollama_web_tools"))
    payload = _strip_for_ollama(kwargs)
    if stream:
        if enable_web_tools:
            return _OllamaWebToolsStream(payload, ollama_timeout, fallback)
        return _OllamaOrFallbackStream(payload, ollama_timeout, fallback)
    try:
        if enable_web_tools:
            return _ollama_chat_with_web_tools(payload, ollama_timeout)
        return _ollama_chat_complete(payload, ollama_timeout)
    except Exception as exc:
        _log.info("ollama fallback reason=%s", exc.__class__.__name__)
        return fallback()
