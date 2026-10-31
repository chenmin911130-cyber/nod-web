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
    out = {k: v for k, v in kwargs.items() if k not in ("extra_body", "reasoning_effort")}
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


def _ns_message(data: dict[str, Any] | None) -> Any:
    data = data or {}
    return SimpleNamespace(content=data.get("content") or "")


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


def _ollama_chat_complete(payload: dict[str, Any], ollama_timeout: float) -> Any:
    res = _ollama_post(payload, ollama_timeout)
    try:
        body = res.json()
    except json.JSONDecodeError as exc:
        raise ValueError("ollama invalid json") from exc
    if not isinstance(body, dict):
        raise ValueError("ollama invalid response shape")
    parsed = _parse_completion_body(body)
    if not parsed.choices:
        raise ValueError("ollama empty choices")
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
    payload = _strip_for_ollama(kwargs)
    if stream:
        return _OllamaOrFallbackStream(payload, ollama_timeout, fallback)
    try:
        return _ollama_chat_complete(payload, ollama_timeout)
    except Exception as exc:
        _log.info("ollama fallback reason=%s", exc.__class__.__name__)
        return fallback()
