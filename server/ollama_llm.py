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
OLLAMA_WEB_TOOL_MAX_ITERATIONS = 1
OLLAMA_WEB_TOOL_RESULT_MAX_CHARS = 8000
OLLAMA_WEB_SEARCH_DEFAULT_MAX_RESULTS = 3

OLLAMA_WEB_TOOLS_SYSTEM_HINT = (
    "Web search policy: call web_search ONLY when the question needs current or latest "
    "information (news, live prices, events after your knowledge cutoff). Answer ordinary "
    "factual questions from your knowledge without searching."
)

OLLAMA_WEB_TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": (
                "Search the web for up-to-date information when the question requires "
                "current or latest facts. Do not use for general knowledge."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query string"},
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of results (default 3, max 10)",
                    },
                },
                "required": ["query"],
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
    msg = SimpleNamespace(
        content=data.get("content") or "",
        reasoning_content=data.get("reasoning_content") or data.get("reasoning") or "",
    )
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


def completion_message_text(message: Any) -> str:
    """Text from a chat completion message (content, then reasoning fields)."""
    if message is None:
        return ""
    content = (getattr(message, "content", None) or "").strip()
    if content:
        return content
    for attr in ("reasoning_content", "reasoning"):
        piece = getattr(message, attr, None)
        if isinstance(piece, str) and piece.strip():
            return piece.strip()
    return ""


def _completion_text(resp: Any) -> str:
    if resp is None or not getattr(resp, "choices", None):
        return ""
    return completion_message_text(resp.choices[0].message)


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
        else:
            body["max_results"] = OLLAMA_WEB_SEARCH_DEFAULT_MAX_RESULTS
        return _truncate_tool_result(json.dumps(_ollama_web_api_post(OLLAMA_WEB_SEARCH_URL, body)))
    return _truncate_tool_result(json.dumps({"error": "tool_not_available", "name": name}))


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


def _inject_web_tools_system_hint(messages: list[Any]) -> None:
    if not messages:
        messages.insert(0, {"role": "system", "content": OLLAMA_WEB_TOOLS_SYSTEM_HINT})
        return
    first = messages[0]
    if isinstance(first, dict) and str(first.get("role") or "") == "system":
        content = str(first.get("content") or "").strip()
        if OLLAMA_WEB_TOOLS_SYSTEM_HINT not in content:
            first["content"] = (content + "\n\n" + OLLAMA_WEB_TOOLS_SYSTEM_HINT).strip()
    else:
        messages.insert(0, {"role": "system", "content": OLLAMA_WEB_TOOLS_SYSTEM_HINT})


def _ollama_web_tool_phase(
    payload: dict[str, Any], ollama_timeout: float
) -> tuple[list[Any], dict[str, Any] | None]:
    """At most one web_search round. Returns (messages, body) when the model answered without tools."""
    messages: list[Any] = list(payload.get("messages") or [])
    _inject_web_tools_system_hint(messages)
    base_payload = {k: v for k, v in payload.items() if k not in ("messages", "stream")}
    base_payload["stream"] = False
    base_payload["tools"] = OLLAMA_WEB_TOOL_DEFINITIONS

    body = _ollama_chat_once({**base_payload, "messages": messages}, ollama_timeout)
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
        return messages, None
    if _completion_text(_parse_completion_body(body)):
        return messages, body
    return messages, None


def _ollama_open_sse_stream(
    payload: dict[str, Any], ollama_timeout: float
) -> tuple[httpx.Client, httpx.Response, Iterator[Any]]:
    headers = {
        "Authorization": f"Bearer {ollama_api_key()}",
        "Content-Type": "application/json",
    }
    body = dict(payload)
    body["stream"] = True
    body.pop("tools", None)
    saw: dict[str, bool] = {"v": False}

    def _saw() -> bool:
        return saw["v"]

    client = httpx.Client(timeout=_httpx_timeout(ollama_timeout))
    res = client.send(
        client.build_request("POST", ollama_chat_url(), headers=headers, json=body),
        stream=True,
    )
    if res.status_code == 429 or res.status_code >= 400:
        res.close()
        client.close()
        raise httpx.HTTPStatusError(f"ollama http {res.status_code}", request=res.request, response=res)

    def _iter() -> Iterator[Any]:
        try:
            for chunk in _iter_ollama_sse(res, saw_content=_saw):
                if _chunk_has_content_token(chunk):
                    saw["v"] = True
                yield chunk
        finally:
            res.close()
            client.close()

    return client, res, _iter()


def _ollama_chat_with_web_tools(payload: dict[str, Any], ollama_timeout: float) -> Any:
    """Non-stream chat: one optional web_search round, then a final completion."""
    messages, early = _ollama_web_tool_phase(payload, ollama_timeout)
    if early is not None:
        parsed = _parse_completion_body(early)
        if _completion_text(parsed):
            return parsed
    base_payload = {k: v for k, v in payload.items() if k not in ("messages", "stream")}
    base_payload["stream"] = False
    no_tools = {k: v for k, v in base_payload.items() if k != "tools"}
    body = _ollama_chat_once({**no_tools, "messages": messages}, ollama_timeout)
    parsed = _parse_completion_body(body)
    if not _completion_text(parsed):
        raise ValueError("ollama empty completion")
    return parsed


def _immediate_answer_stream_chunks(body: dict[str, Any]) -> list[Any]:
    """When the model skips tools, emit its non-stream reply as one stream chunk."""
    parsed = _parse_completion_body(body)
    text = _completion_text(parsed)
    usage = _ns_usage(body.get("usage") if isinstance(body.get("usage"), dict) else None)
    if not text:
        return []
    return [
        SimpleNamespace(
            choices=[
                SimpleNamespace(delta=SimpleNamespace(content=text, reasoning_content=None))
            ],
            usage=usage,
        )
    ]


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
    """One web_search round (non-stream), then a real streamed final answer."""

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
        self._hold_client: httpx.Client | None = None
        self._hold_response: httpx.Response | None = None

    def _start(self) -> None:
        if self._started:
            return
        self._started = True
        try:
            messages, early = _ollama_web_tool_phase(self._payload, self._ollama_timeout)
            if early is not None:
                self._inner = iter(_immediate_answer_stream_chunks(early))
                return
            stream_payload = {
                k: v
                for k, v in self._payload.items()
                if k not in ("messages", "stream", "ollama_web_tools")
            }
            stream_payload["messages"] = messages
            client, res, self._inner = _ollama_open_sse_stream(stream_payload, self._ollama_timeout)
            self._hold_client = client
            self._hold_response = res
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
        if self._hold_response is not None:
            try:
                self._hold_response.close()
            except Exception:
                pass
            self._hold_response = None
        if self._hold_client is not None:
            try:
                self._hold_client.close()
            except Exception:
                pass
            self._hold_client = None
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
