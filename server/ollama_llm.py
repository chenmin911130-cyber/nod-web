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


def _ollama_post(payload: dict[str, Any], timeout: float) -> httpx.Response:
    headers = {
        "Authorization": f"Bearer {ollama_api_key()}",
        "Content-Type": "application/json",
    }
    with httpx.Client(timeout=httpx.Timeout(timeout, connect=10.0, read=timeout)) as client:
        res = client.post(ollama_chat_url(), headers=headers, json=payload)
    if res.status_code == 429:
        raise httpx.HTTPStatusError("ollama rate limited", request=res.request, response=res)
    if res.status_code >= 400:
        raise httpx.HTTPStatusError(
            f"ollama http {res.status_code}", request=res.request, response=res
        )
    return res


def _ollama_chat_complete(payload: dict[str, Any], timeout: float) -> Any:
    res = _ollama_post(payload, timeout)
    try:
        body = res.json()
    except json.JSONDecodeError as exc:
        raise ValueError("ollama invalid json") from exc
    if not isinstance(body, dict):
        raise ValueError("ollama invalid response shape")
    parsed = _parse_completion_body(body)
    if not parsed.choices:
        raise ValueError("ollama empty choices")
    return parsed


def _iter_ollama_sse(res: httpx.Response) -> Iterator[Any]:
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
            except json.JSONDecodeError:
                continue
            if isinstance(chunk, dict):
                yield _parse_completion_body(chunk)
    finally:
        res.close()


def _ollama_chat_stream(payload: dict[str, Any], timeout: float) -> Iterator[Any]:
    headers = {
        "Authorization": f"Bearer {ollama_api_key()}",
        "Content-Type": "application/json",
    }
    payload = dict(payload)
    payload["stream"] = True
    client = httpx.Client(timeout=httpx.Timeout(timeout, connect=10.0, read=timeout))
    res = client.send(
        client.build_request("POST", ollama_chat_url(), headers=headers, json=payload),
        stream=True,
    )
    if res.status_code == 429 or res.status_code >= 400:
        res.close()
        client.close()
        raise httpx.HTTPStatusError(f"ollama http {res.status_code}", request=res.request, response=res)
    stream = _OllamaStream(res, client)
    return iter(stream)


class _OllamaStream:
    """SSE stream wrapper with ``close()`` for abort_stream."""

    def __init__(self, response: httpx.Response, client: httpx.Client):
        self._response = response
        self._client = client
        self._iter = _iter_ollama_sse(response)

    def __iter__(self) -> Iterator[Any]:
        return self

    def __next__(self) -> Any:
        return next(self._iter)

    def close(self) -> None:
        try:
            self._response.close()
        finally:
            self._client.close()


def chat_completions_with_ollama_fallback(
    *,
    kwargs: dict[str, Any],
    timeout: float,
    fallback: Callable[[], Any],
) -> Any:
    """Try Ollama when configured; on any failure run ``fallback`` unchanged."""
    if not ollama_configured():
        return fallback()
    stream = bool(kwargs.get("stream"))
    payload = _strip_for_ollama(kwargs)
    try:
        if stream:
            return _ollama_chat_stream(payload, timeout)
        return _ollama_chat_complete(payload, timeout)
    except Exception as exc:
        _log.info("ollama fallback reason=%s", exc.__class__.__name__)
        return fallback()
