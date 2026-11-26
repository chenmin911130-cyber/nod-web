"""Google Gemini (native REST) as the primary text LLM, with a caller-supplied fallback.

Why native ``generateContent`` / ``streamGenerateContent`` instead of Gemini's
OpenAI-compatible endpoint: Google Search grounding is rejected there, and Q&A
answers (ask / file_ask / listen_ask) need it for current facts.

Rules this module enforces for every call:

* thinking is explicitly OFF (``thinkingBudget: 0``). Flash spends the output
  budget on thoughts otherwise and the visible answer comes back truncated.
* grounding (``google_search``) only when the caller asks for it; the model then
  decides itself whether a question actually needs a search.
* the fallback (DeepSeek official in this app) runs once, and for a stream only
  BEFORE the first content token: an answer the user already sees is never
  restarted on another model.

Return values mimic the subset of the OpenAI SDK objects the app reads
(``choices[0].delta.content`` / ``choices[0].message.content`` / ``usage``), so
call sites treat Gemini and the fallback stream the same.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from types import SimpleNamespace
from typing import Any, Callable, Iterator

import httpx

_log = logging.getLogger("nod.gemini")

GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
# Answers (ask / file_ask / listen_ask / notes / translate / auto).
DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"
# Small background jobs: caption repair, Live Q&A judgement, history titles.
DEFAULT_GEMINI_LITE_MODEL = "gemini-3.1-flash-lite"

GEMINI_CONNECT_TIMEOUT_S = 2.5
GEMINI_NON_STREAM_TIMEOUT_S = 6.0
GEMINI_STREAM_TRANSLATE_READ_S = 12.0
GEMINI_STREAM_DEFAULT_READ_S = 25.0

# Modes whose answer may use Google Search grounding. Never translation, notes,
# caption repair, judge or titles.
GROUNDED_MODES = frozenset({"ask", "file_ask", "listen_ask"})

_DATA_URL = re.compile(r"^data:([^;,]+);base64,(.*)$", re.S)


def gemini_api_key() -> str:
    return (os.environ.get("GEMINI_API_KEY") or "").strip()


def gemini_configured() -> bool:
    return bool(gemini_api_key())


def gemini_model() -> str:
    return (os.environ.get("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL).strip() or DEFAULT_GEMINI_MODEL


def gemini_lite_model() -> str:
    return (os.environ.get("GEMINI_LITE_MODEL") or DEFAULT_GEMINI_LITE_MODEL).strip() or DEFAULT_GEMINI_LITE_MODEL


def _httpx_timeout(read_s: float) -> httpx.Timeout:
    return httpx.Timeout(read_s, connect=GEMINI_CONNECT_TIMEOUT_S, read=read_s, write=read_s, pool=GEMINI_CONNECT_TIMEOUT_S)


def _url(model: str, stream: bool) -> str:
    if stream:
        return f"{GEMINI_API_BASE}/models/{model}:streamGenerateContent?alt=sse"
    return f"{GEMINI_API_BASE}/models/{model}:generateContent"


def _headers() -> dict[str, str]:
    return {"x-goog-api-key": gemini_api_key(), "Content-Type": "application/json"}


# ---------------------------------------------------------------- request body


def _content_parts(content: Any) -> list[dict[str, Any]]:
    """OpenAI message content (str or typed parts) -> Gemini parts."""
    if content is None:
        return []
    if isinstance(content, str):
        return [{"text": content}] if content else []
    parts: list[dict[str, Any]] = []
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            kind = item.get("type")
            if kind == "text":
                text = str(item.get("text") or "")
                if text:
                    parts.append({"text": text})
            elif kind == "image_url":
                raw = item.get("image_url")
                url = raw.get("url") if isinstance(raw, dict) else raw
                m = _DATA_URL.match(str(url or ""))
                if not m:
                    # Only inline images are produced by this app; a remote URL
                    # would need fileData + an upload, so let the fallback take it.
                    raise ValueError("gemini unsupported image url")
                parts.append({"inlineData": {"mimeType": m.group(1), "data": m.group(2)}})
    return parts


def build_request_body(kwargs: dict[str, Any], *, grounding: bool) -> dict[str, Any]:
    """OpenAI-style chat kwargs -> native Gemini request (thinking always off)."""
    system_texts: list[str] = []
    contents: list[dict[str, Any]] = []
    for msg in kwargs.get("messages") or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "user")
        if role in ("system", "developer"):
            for p in _content_parts(msg.get("content")):
                if p.get("text"):
                    system_texts.append(p["text"])
            continue
        g_role = "model" if role == "assistant" else "user"
        parts = _content_parts(msg.get("content"))
        if not parts:
            continue
        if contents and contents[-1]["role"] == g_role:
            contents[-1]["parts"].extend(parts)
        else:
            contents.append({"role": g_role, "parts": parts})
    if not contents:
        raise ValueError("gemini empty contents")
    gen: dict[str, Any] = {"thinkingConfig": {"thinkingBudget": 0}}
    max_tokens = kwargs.get("max_tokens") or kwargs.get("max_completion_tokens")
    if max_tokens:
        gen["maxOutputTokens"] = int(max_tokens)
    if kwargs.get("temperature") is not None:
        gen["temperature"] = float(kwargs["temperature"])
    body: dict[str, Any] = {"contents": contents, "generationConfig": gen}
    if system_texts:
        body["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_texts)}]}
    if grounding:
        body["tools"] = [{"google_search": {}}]
    return body


# --------------------------------------------------------------- response shape


def _usage_ns(meta: dict[str, Any] | None) -> Any | None:
    if not isinstance(meta, dict) or not meta:
        return None
    prompt = int(meta.get("promptTokenCount") or 0) + int(meta.get("toolUsePromptTokenCount") or 0)
    # Thought tokens are billed as output; with thinkingBudget 0 they should be 0.
    completion = int(meta.get("candidatesTokenCount") or 0) + int(meta.get("thoughtsTokenCount") or 0)
    return SimpleNamespace(prompt_tokens=prompt, completion_tokens=completion)


def _candidate(body: dict[str, Any]) -> dict[str, Any]:
    cands = body.get("candidates") or []
    return cands[0] if cands and isinstance(cands[0], dict) else {}


def _candidate_text(cand: dict[str, Any]) -> str:
    out = []
    for p in (cand.get("content") or {}).get("parts") or []:
        if isinstance(p, dict) and not p.get("thought") and isinstance(p.get("text"), str):
            out.append(p["text"])
    return "".join(out)


def grounding_summary(meta: dict[str, Any] | None) -> dict[str, Any]:
    """Search queries + cited web sources from ``groundingMetadata``."""
    meta = meta if isinstance(meta, dict) else {}
    queries = [q for q in (meta.get("webSearchQueries") or []) if isinstance(q, str) and q.strip()]
    sources = []
    for ch in meta.get("groundingChunks") or []:
        web = ch.get("web") if isinstance(ch, dict) else None
        if isinstance(web, dict) and web.get("uri"):
            sources.append({"title": str(web.get("title") or ""), "uri": str(web["uri"])})
    return {"queries": queries, "sources": sources}


def _chunk_ns(text: str, usage: Any | None, finish: str | None = None) -> Any:
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(content=text, reasoning_content=None),
                finish_reason=finish,
            )
        ],
        usage=usage,
    )


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


def _chunk_has_content_token(chunk: Any) -> bool:
    if chunk is None or not getattr(chunk, "choices", None):
        return False
    return bool(getattr(chunk.choices[0].delta, "content", None) or "")


# ------------------------------------------------------------------- non-stream


def gemini_generate(
    kwargs: dict[str, Any], *, model: str, timeout: float, grounding: bool = False
) -> Any:
    """One non-streamed completion. Raises on HTTP error / empty answer."""
    body = build_request_body(kwargs, grounding=grounding)
    with httpx.Client(timeout=_httpx_timeout(timeout)) as client:
        res = client.post(_url(model, False), headers=_headers(), json=body)
    if res.status_code >= 400:
        raise httpx.HTTPStatusError(f"gemini http {res.status_code}", request=res.request, response=res)
    try:
        data = res.json()
    except json.JSONDecodeError as exc:
        raise ValueError("gemini invalid json") from exc
    if not isinstance(data, dict):
        raise ValueError("gemini invalid response shape")
    cand = _candidate(data)
    text = _candidate_text(cand)
    if not text.strip():
        reason = cand.get("finishReason") or (data.get("promptFeedback") or {}).get("blockReason") or "empty"
        raise ValueError(f"gemini empty completion ({reason})")
    g = grounding_summary(cand.get("groundingMetadata"))
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content=text, reasoning_content=""),
                finish_reason=cand.get("finishReason"),
            )
        ],
        usage=_usage_ns(data.get("usageMetadata")),
        provider="gemini",
        model=model,
        grounding=g,
        search_queries=len(g["queries"]),
    )


# ----------------------------------------------------------------------- stream


def _iter_sse(res: httpx.Response, saw_content: Callable[[], bool]) -> Iterator[dict[str, Any]]:
    for line in res.iter_lines():
        if isinstance(line, bytes):
            line = line.decode("utf-8", errors="replace")
        line = (line or "").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            obj = json.loads(data)
        except json.JSONDecodeError as exc:
            if not saw_content():
                raise ValueError("gemini malformed sse") from exc
            continue
        if isinstance(obj, dict):
            if obj.get("error"):
                raise ValueError(f"gemini stream error {str(obj.get('error'))[:200]}")
            yield obj


class GeminiOrFallbackStream:
    """Gemini SSE first; until the first content token any failure falls back once.

    Exposes ``provider`` ("gemini" / "fallback"), ``grounding`` (queries + sources)
    and ``search_queries`` (billable search count) after iteration.
    """

    def __init__(
        self,
        kwargs: dict[str, Any],
        *,
        model: str,
        timeout: float,
        grounding: bool,
        fallback: Callable[[], Any],
    ):
        self._kwargs = kwargs
        self.model = model
        self._timeout = timeout
        self._grounding = grounding
        self._fallback = fallback
        self.provider = "gemini"
        self.grounding: dict[str, Any] = {"queries": [], "sources": []}
        self.search_queries = 0
        self.fallback_reason = ""
        self.finish_reason: str | None = None
        self._saw_content = False
        self._client: httpx.Client | None = None
        self._response: httpx.Response | None = None
        self._active: Iterator[Any] | None = None
        self._fallback_stream: Any = None
        self._t0 = time.monotonic()
        self._ttft_ms: int | None = None
        self._logged = False

    # -- gemini side
    def _close_gemini(self) -> None:
        if self._response is not None:
            try:
                self._response.close()
            except Exception:
                pass
            self._response = None
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None

    def _gemini_chunks(self) -> Iterator[Any]:
        assert self._response is not None
        for obj in _iter_sse(self._response, lambda: self._saw_content):
            cand = _candidate(obj)
            meta = cand.get("groundingMetadata")
            if meta:
                g = grounding_summary(meta)
                if g["queries"] or g["sources"]:
                    self.grounding = g
                    self.search_queries = len(g["queries"])
            usage = _usage_ns(obj.get("usageMetadata"))
            text = _candidate_text(cand)
            finish = cand.get("finishReason")
            if finish:
                self.finish_reason = str(finish)
            if text or usage is not None or finish:
                yield _chunk_ns(text, usage, finish)

    def _start_gemini(self) -> None:
        body = build_request_body(self._kwargs, grounding=self._grounding)
        client = httpx.Client(timeout=_httpx_timeout(self._timeout))
        try:
            res = client.send(
                client.build_request("POST", _url(self.model, True), headers=_headers(), json=body),
                stream=True,
            )
        except Exception:
            client.close()
            raise
        if res.status_code >= 400:
            res.close()
            client.close()
            raise httpx.HTTPStatusError(f"gemini http {res.status_code}", request=res.request, response=res)
        self._client = client
        self._response = res
        self._active = self._gemini_chunks()

    def _start_fallback(self, reason: str) -> None:
        _log.info("gemini stream fallback model=%s grounded=%s reason=%s", self.model, int(self._grounding), reason)
        self._close_gemini()
        self.provider = "fallback"
        self.fallback_reason = reason
        self.grounding = {"queries": [], "sources": []}
        self.search_queries = 0
        self._fallback_stream = self._fallback()
        self._active = iter(self._fallback_stream)

    def _log_done(self) -> None:
        if self._logged:
            return
        self._logged = True
        _log.info(
            "llm stream done provider=%s model=%s grounded=%s finish=%s ttft_ms=%s total_ms=%s queries=%s sources=%s",
            self.provider,
            self.model if self.provider == "gemini" else "-",
            int(self._grounding),
            self.finish_reason or "-",
            self._ttft_ms if self._ttft_ms is not None else "-",
            int((time.monotonic() - self._t0) * 1000),
            self.search_queries,
            len(self.grounding.get("sources") or []),
        )

    def __iter__(self) -> Iterator[Any]:
        return self

    def __next__(self) -> Any:
        if self._active is None:
            try:
                self._start_gemini()
            except Exception as exc:
                self._start_fallback(exc.__class__.__name__)
        while True:
            try:
                chunk = next(self._active)  # type: ignore[arg-type]
            except StopIteration:
                if self.provider == "gemini" and not self._saw_content:
                    self._start_fallback("empty_stream")
                    continue
                self._log_done()
                raise
            except Exception as exc:
                if self.provider == "gemini" and not self._saw_content:
                    self._start_fallback(exc.__class__.__name__)
                    continue
                raise
            if _chunk_has_content_token(chunk):
                if not self._saw_content:
                    self._ttft_ms = int((time.monotonic() - self._t0) * 1000)
                self._saw_content = True
            return chunk

    def close(self) -> None:
        self._close_gemini()
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


# -------------------------------------------------------------------- entry point


def chat_completions_with_gemini_fallback(
    *,
    kwargs: dict[str, Any],
    timeout: float,
    fallback: Callable[[], Any],
    model: str | None = None,
    grounding: bool = False,
) -> Any:
    """Gemini first when ``GEMINI_API_KEY`` is set; otherwise / on failure ``fallback()``.

    ``kwargs`` are OpenAI-style chat kwargs (provider-specific keys such as
    ``extra_body`` are ignored on the Gemini side and kept for the fallback).
    """
    if not gemini_configured():
        return fallback()
    target = model or gemini_model()
    if kwargs.get("stream"):
        return GeminiOrFallbackStream(
            kwargs, model=target, timeout=timeout, grounding=grounding, fallback=fallback
        )
    try:
        return gemini_generate(kwargs, model=target, timeout=timeout, grounding=grounding)
    except Exception as exc:
        _log.info("gemini fallback model=%s reason=%s", target, exc.__class__.__name__)
        return fallback()
