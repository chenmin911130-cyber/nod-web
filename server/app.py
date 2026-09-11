#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Nod web engine: browser mic PCM → AssemblyAI cloud STT → LLM stream."""
from __future__ import annotations

import asyncio
import collections
import json
import logging
import os
import hashlib
import queue
import re
import secrets
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable, Literal
from urllib.parse import urlencode

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
from starlette.concurrency import run_in_threadpool

from server.admin import router as admin_router
from server.commerce import router as commerce_router
from server.cors import cors_origins
from server.db import User, init_db
from server.headers import CloudflareOriginMiddleware, HostLockMiddleware, SecurityHeadersMiddleware
from server.lang import (
    _LANG_NAMES,
    _STT_AUTO_LANGS,
    _TRANSLATE_LANGS,
    _confident_stt_lang,
    _normalize_any_lang,
    _normalize_stt_lang,
    _normalize_translate_from,
    _normalize_translate_to,
    _same_speech_script,
    _speech_script,
    detect_question_lang,
    heard_lang_from_code,
    heard_lang_from_text,
    heard_lang_from_turn,
    listen_ask_lang,
    matches_locked_speech,
    split_code_switched,
)
from server.meeting_lines import (
    decide as meeting_decide,
    decide_full as meeting_decide_full,
    gap_ms as meeting_gap_ms,
    join_meeting_text,
    last_sentence_index as meeting_last_sentence_index,
    tail_meta as meeting_tail_meta,
)
from server.turn_pacing import cut_decision, split_carry, turn_pacing_from_env, word_span_ms
from server.stt_audio import (
    MIN_CHUNK_BYTES,
    duration_ms,
    duration_s,
    error_summary,
    pace_wait_s,
    take_one_frame,
)
from server.logging_setup import backup_now, setup_logging
from server.settings import (
    AUTH_DISABLED,
    CLERK_PUBLISHABLE_KEY,
    COOKIE_NAME,
    LISTEN_IDLE_SECONDS,
    LISTEN_MAX_SECONDS,
    LISTEN_ZERO_PCM_SECONDS,
    LISTEN_ZERO_PCM_WATCH_SECONDS,
    PUBLIC_URL,
    QUOTA_DISABLED,
)
from server.ratelimit import MAX_WS_FRAME, WS_FRAMES_PER_SEC, allow, ws_client_ip, ws_connect, ws_disconnect
from server.security import current_user, is_local_scope, user_from_token
from server import uplink

SR = 16000
STT_CLOUD = "assemblyai"
VISION_MODEL = "deepseek-v4-flash-vision-exp"
ASSEMBLYAI_WS = "wss://streaming.assemblyai.com/v3/ws"
ASSEMBLYAI_API = "https://api.assemblyai.com"
ASSEMBLYAI_MODEL = "universal-3-5-pro"
ASSEMBLYAI_FILE_MODELS = ["universal-3-5-pro", "universal-2"]
# Official close: {"type": "Terminate"}. Dropping the socket does not stop
# billing; unterminated sessions stay open and bill for up to 3 hours.
ASSEMBLYAI_TERMINATE = {"type": "Terminate"}
ASSEMBLYAI_TERMINATE_WAIT_SEC = 1.5
MEETING_STOP_DRAIN_SEC = 4.0
STT_HANDOFF_JOIN_SEC = 2.0
STT_HANDOFF_INTERRUPT_JOIN_SEC = 0.5
STT_PCM_HOLD_MAX = 2 * 1024 * 1024
# Total bytes one CloudListener holds (dispatch buffer + queue) before it
# backpressures instead of silently dropping the oldest — issue #165 P1. Sized so
# the design's allowed handoff backlog (a 2 MiB hold flush + a 1 MiB seed + live
# frames) is accommodated, and byte-counted rather than the old 240-item cap
# (a single item can be 2 MiB). Reaching it latches incomplete + keeps the
# original; it is not an unbounded buffer.
STT_PCM_BUF_MAX = 4 * 1024 * 1024
# push_pcm() accept result. "backpressure" means the byte budget is exhausted —
# the caller must not treat the call as a success; it latches incomplete and the
# frame is preserved by the Session archive, not silently dropped.
PCM_ACCEPTED = "accepted"
PCM_BACKPRESSURE = "backpressure"
PCM_TERMINATED = "terminated"
HandoffKind = Literal["ready", "empty", "blocked"]


@dataclass(frozen=True)
class UnsentHandoff:
    """Result of taking PCM from a CloudListener that is shutting down.

    ``ready`` has audio, ``empty`` finished with none, ``blocked`` means the
    sender has not exited — callers must not treat that as silence.
    """

    kind: HandoffKind
    pcm: bytes = b""

    @property
    def blocked(self) -> bool:
        return self.kind == "blocked"
STATUS_READY = "Ready · F2 record / F3 listen / F4 clear · browser mic + cloud STT"
STATUS_RECORD = "Recording · accurate captions follow shortly"
STATUS_LISTEN = "Listening for the next question…"
STATUS_TRANSCRIBE = "Transcribing carefully — this can take a moment…"
STATUS_CHECK = "Checking question…"
STATUS_GENERATE = "Generating answer…"
STATUS_ANSWER_READY = "Answer ready"
STATUS_WAIT_MORE = "I caught part of a question. Keep listening…"
STATUS_EMPTY = "No speech detected, please try again"
LISTEN_TAKEN_MSG = "Another device started listening. Tap Start Listening to take it back."
MANUAL_MAX_SEC = float(LISTEN_MAX_SECONDS)
MANUAL_MIN_SEC = 0.4
MANUAL_CHUNK_SEC = 10.0
MANUAL_CHUNK_MIN_SEC = 2.0
MANUAL_CHUNK_SILENCE_SEC = 0.65
MANUAL_CHUNK_OVERLAP_SEC = 0.25
MANUAL_MAX_JOBS = 2


def manual_chunk_ready(pending_sec: float, silent_sec: float, *, force: bool = False) -> bool:
    """Cut a record clip when the speaker pauses, or when the clip gets long."""
    if pending_sec < MANUAL_MIN_SEC:
        return False
    if force:
        return True
    if pending_sec < MANUAL_CHUNK_MIN_SEC:
        return False
    return silent_sec >= MANUAL_CHUNK_SILENCE_SEC or pending_sec >= MANUAL_CHUNK_SEC

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = ROOT / "config.json"
WEB_DIST = ROOT / "web" / "dist"

PROVIDER_ENDPOINTS = {
    "deepseek": "https://api.deepseek.com",
    "openrouter": "https://openrouter.ai/api/v1",
}
PROVIDER_KEY = {"deepseek": "DEEPSEEK_API_KEY", "openrouter": "OPENROUTER_API_KEY"}

_STT_HALLUCINATIONS = (
    "thank you for watching", "thanks for watching", "thanks for listening",
    "please subscribe", "please like", "like and subscribe",
    "谢谢收看", "謝謝收看", "字幕志愿者", "字幕志願者", "subtitles by", "字幕 by",
)
_STT_STATUS_WORDS = (
    "checking question", "answer ready", "calibrating microphone",
    "microphone muted", "microphone unmuted",
)
_STT_SOCIAL_WORDS = {
    "okay", "ok", "yes", "yeah", "yep", "sure", "right", "fine", "good",
    "next", "thank you", "thanks", "got it", "alright", "well", "um", "uh",
    "hmm", "great", "perfect", "cool", "nice", "嗯", "啊", "哦", "呃", "好的", "好",
}
GUARD_Q_WORDS = (
    "what", "why", "how", "when", "where", "which", "who",
    "can you", "could you", "tell me", "explain", "difference",
    "define", "describe", "?", "？",
    "吗", "嗎", "么", "麼", "呢", "嘛",
    "什么", "什麼", "为什么", "為什麼", "怎么", "怎麼", "如何", "为何", "為何",
    "谁", "誰", "哪", "哪儿", "哪兒", "哪里", "哪裡", "哪个", "哪個",
    "多少", "几点", "幾點", "多大", "啥",
    "介绍一下", "介紹一下", "说说", "說說", "谈谈", "談談", "讲一下", "講一下",
    "告诉", "告訴", "告诉我", "告訴我", "请问", "請問", "能否",
    "是不是", "好不好", "对不对", "對不對", "行不行",
    "能不能", "会不会", "會不會", "有没有", "有沒有", "可不可以",
    "なぜ", "どうして", "ですか", "ますか", "でしょうか", "教えて",
)
_STT_BOOST_FIXED = [
    "Python", "C#", "ASP.NET", "SQL", "database", "API", "frontend", "backend",
    "full-stack", "algorithm", "interview", "experience", "project",
    "引流", "站外引流", "站外", "承接", "成交", "联盟营销", "红人", "影响", "熟悉",
    "亚马逊", "Amazon", "affiliate", "PPC", "listing", "influencer",
]


def _ratio(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def load_all_keys() -> dict[str, str]:
    names = ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "ASSEMBLYAI_API_KEY"]
    keys: dict[str, str] = {}
    # Test/e2e harnesses set NOD_SKIP_DOTENV so the repo's real .env (which
    # load_all_keys reads FIRST — env vars are only a fallback) can never leak
    # real keys into a mocked run. Without this, a local run that can read
    # .env silently uses the real LLM and e2e passes, while CI (no .env) fails.
    skip_dotenv = os.environ.get("NOD_SKIP_DOTENV", "").strip().lower() in ("1", "true", "yes")
    if not skip_dotenv:
        hermes = os.environ.get("HERMES_ENV")
        cands = [hermes] if hermes else []
        local = os.environ.get("LOCALAPPDATA")
        if local:
            cands.append(os.path.join(local, "hermes", ".env"))
        cands.append(str(ROOT / ".env"))
        for env_path in cands:
            if not env_path or not os.path.exists(env_path):
                continue
            try:
                with open(env_path, encoding="utf-8") as f:
                    for line in f:
                        m = re.match(r"\s*([A-Z_]+_API_KEY)\s*=\s*(.+)", line)
                        if m and m.group(1) in names:
                            keys[m.group(1)] = m.group(2).strip().strip('"').strip("'")
            except OSError:
                pass
    for n in names:
        if not keys.get(n) and os.environ.get(n):
            keys[n] = os.environ[n].strip()
    appdata = os.environ.get("APPDATA")
    secrets_path = os.path.join(appdata, "Nod", "secrets.json") if appdata else ""
    if secrets_path and os.path.exists(secrets_path):
        try:
            with open(secrets_path, encoding="utf-8") as f:
                data = json.load(f)
            for n in names:
                if not keys.get(n) and isinstance(data.get(n), str) and data[n].strip():
                    keys[n] = data[n].strip()
        except (OSError, json.JSONDecodeError):
            pass
    return keys


def load_config() -> dict[str, Any]:
    cfg: dict[str, Any] = {
        "profile": {
            "name": "",
            "target_role": "",
            "company": "",
            "resume_summary": "",
            "jd": "",
            "style": "中性简洁：先给结论，再两三句说明。直接回答问题。",
        },
        "llm": {"model": "deepseek-v4-flash", "max_tokens": 1600, "temperature": 0.5, "provider": "deepseek"},
        "stt": {"model": STT_CLOUD, "language": None, "vocabulary": []},
        "audio": {"source": "mic"},
        "ui": {"opacity": 88, "translate_from": "auto", "translate_to": "zh"},
        "models": [],
    }
    if DEFAULT_CONFIG_PATH.exists():
        try:
            with open(DEFAULT_CONFIG_PATH, encoding="utf-8") as f:
                src = json.load(f)
            for k, v in src.items():
                if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                    cfg[k].update(v)
                else:
                    cfg[k] = v
        except (OSError, json.JSONDecodeError):
            pass
    cfg.setdefault("stt", {})["model"] = STT_CLOUD
    cfg.setdefault("audio", {})["source"] = "mic"
    return cfg


def model_allowed(cfg: dict[str, Any], provider: str, model: str) -> bool:
    """Only models this deployment advertises may be billed to our API keys.

    Without this a client could name any model on the provider and we would
    still meter it at the configured flat rate.
    """
    wanted = (str(provider or "").strip(), str(model or "").strip())
    if not wanted[0] or not wanted[1]:
        return False
    if wanted[0] not in PROVIDER_ENDPOINTS:
        return False
    allowed: set[tuple[str, str]] = set()
    for entry in cfg.get("models") or []:
        if isinstance(entry, dict):
            pair = (str(entry.get("provider") or "").strip(), str(entry.get("model") or "").strip())
            if all(pair):
                allowed.add(pair)
    llm = cfg.get("llm") or {}
    default = (str(llm.get("provider") or "").strip(), str(llm.get("model") or "").strip())
    if all(default):
        allowed.add(default)
    return wanted in allowed


def public_config(cfg: dict[str, Any]) -> dict[str, Any]:
    from server.tts import elevenlabs_key

    return {
        "llm": {
            "provider": "",
            "model": "",
        },
        "stt": {"language": _normalize_stt_lang(cfg.get("stt", {}).get("language"))},
        "audio": {"source": "mic"},
        "ui": {
            "opacity": cfg.get("ui", {}).get("opacity", 88),
            "translate_from": _normalize_translate_from(cfg.get("ui", {}).get("translate_from")) or "auto",
            "translate_to": _normalize_translate_to(cfg.get("ui", {}).get("translate_to")),
        },
        "models": [],
        "auth_required": not AUTH_DISABLED,
        "clerk_publishable_key": CLERK_PUBLISHABLE_KEY,
        "has_tts": bool(elevenlabs_key()),
    }


def _stt_add_keyterm(terms: list[str], seen: set[str], raw: Any) -> None:
    tok = str(raw or "").strip()
    if not tok or len(tok) > 50 or len(tok.split()) > 6:
        return
    key = tok.lower()
    if key in seen:
        return
    seen.add(key)
    terms.append(tok)


def _stt_keyterms(cfg: dict[str, Any]) -> list[str]:
    """Universal-3.5 Pro uses keyterms_prompt. word_boost silently falls back to Universal-2."""
    terms: list[str] = []
    seen: set[str] = set()
    for tok in _STT_BOOST_FIXED:
        _stt_add_keyterm(terms, seen, tok)
    p = cfg.get("profile") or {}
    for extra in (p.get("name"), p.get("company"), p.get("target_role")):
        _stt_add_keyterm(terms, seen, extra)
    for text in (p.get("resume_summary") or "", p.get("jd") or ""):
        for tok in re.split(r"[，。、,.;；:：\s()（）/+\\-]+", text):
            tok = tok.strip()
            han = len(re.findall(r"[\u4e00-\u9fff]", tok))
            if len(tok) >= 2 and (re.search(r"[A-Za-z]", tok) or 2 <= han <= 6):
                _stt_add_keyterm(terms, seen, tok)
    for tok in (cfg.get("stt") or {}).get("context_terms") or []:
        _stt_add_keyterm(terms, seen, tok)
    for tok in (cfg.get("stt") or {}).get("vocabulary") or []:
        _stt_add_keyterm(terms, seen, tok)
    return terms[:100]


_STT_CONTEXT_STOP = frozenset({
    "the", "and", "for", "that", "this", "with", "from", "have", "been", "will",
    "your", "their", "what", "when", "where", "which", "about", "just", "then",
    "我们", "你们", "他们", "这个", "那个", "然后", "所以", "但是", "因为", "如果",
    "可以", "不是", "没有", "一个", "什么", "怎么", "现在", "今天", "一下",
})


def _stt_context_terms(texts: list[str]) -> list[str]:
    """Pull names and repeated topic words from captions already confirmed."""
    terms: list[str] = []
    seen: set[str] = set()
    counts: dict[str, int] = {}
    for text in texts:
        for tok in re.findall(r"[A-Z][A-Za-z0-9+#\-]{1,24}|[A-Z]{2,10}", text or ""):
            if tok.lower() not in _STT_CONTEXT_STOP:
                _stt_add_keyterm(terms, seen, tok)
        for tok in re.findall(r"[\u4e00-\u9fff]{2,6}", text or ""):
            if tok in _STT_CONTEXT_STOP:
                continue
            counts[tok] = counts.get(tok, 0) + 1
    for tok, n in counts.items():
        if n >= 2 or len(tok) >= 4:
            _stt_add_keyterm(terms, seen, tok)
    return terms[:40]


def _stt_context_prompt(texts: list[str], limit: int = 220) -> str:
    parts = [re.sub(r"\s+", " ", (t or "").strip()) for t in texts if (t or "").strip()]
    blob = " ".join(parts)
    if len(blob) > limit:
        blob = blob[-limit:].lstrip()
    return blob


def apply_caption_repair(original: str, repaired: str) -> str:
    """Keep an AI fix only when it still looks like the same spoken line."""
    src = (original or "").strip()
    out = (repaired or "").strip().strip('"').strip("“”")
    if not src or not out or out == src:
        return src
    if abs(len(out) - len(src)) > max(12, int(len(src) * 0.35)):
        return src
    if _ratio(src.lower(), out.lower()) < 0.55:
        return src
    if not _same_speech_script(src, out):
        return src
    return out


def _stt_prompt(cfg: dict[str, Any]) -> str:
    stt = cfg.get("stt") or {}
    scene = str(stt.get("listen_scene") or "").strip().lower()
    lang = _normalize_any_lang(stt.get("language"))
    if lang:
        name = _LANG_NAMES.get(lang, lang)
        if scene == "lecture":
            base = f"{name} lecture. One lecturer speaks most of the time; the audience asks short questions."
        elif scene == "interview":
            base = f"{name} job interview. Interviewer and candidate take turns."
        elif scene == "meeting":
            base = (
                f"{name} two-speaker conversation. The host asks short questions. "
                "The guest gives longer answers."
            )
        else:
            base = f"{name} conversation."
    elif scene == "lecture":
        base = "Mandarin, English, and Japanese lecture. One lecturer speaks most of the time; the audience asks short questions. People switch languages mid-sentence."
    elif scene == "interview":
        base = "Mandarin, English, and Japanese job interview. Interviewer and candidate take turns."
    else:
        base = (
            "Mandarin, English, and Japanese two-speaker conversation. "
            "The host asks short questions. The guest gives longer answers. People switch languages mid-sentence."
        )
    extra = _stt_context_prompt([str(stt.get("context_prompt") or "")])
    if extra:
        return f"{base} Recent names and topic: {extra}"
    return base


def _stt_max_speakers(cfg: dict[str, Any]) -> int | None:
    stt = cfg.get("stt") or {}
    scene = str(stt.get("listen_scene") or "").strip().lower()
    raw = stt.get("speakers_expected")
    try:
        n = int(raw) if raw is not None and raw != "" else 0
    except (TypeError, ValueError):
        n = 0
    # Two-party rooms (meeting/interview) need an exact cap of 2. Headroom
    # here merges host and guest into one label. Lectures keep a little slack.
    if scene in ("meeting", "interview"):
        return min(10, max(2, n or 2))
    if n < 1:
        return 4 if scene == "lecture" else None
    return min(10, max(2, n + 1))


_SPEAKER_PENDING = {"", "pending", "none", "null", "unknown"}


def speaker_from_turn(data: dict[str, Any]) -> str | None:
    """Prefer a confident word-level vote over a PENDING turn label.

    Short host backchannels often arrive as speaker_label=PENDING. Treating
    that string as a real id made every uncertain line collapse onto Host.
    """
    raw = data.get("speaker_label") or data.get("speaker")
    label = str(raw).strip() if raw is not None else ""
    if label.lower() in _SPEAKER_PENDING:
        label = ""
    votes: dict[str, int] = {}
    for word in data.get("words") or []:
        if not isinstance(word, dict) or word.get("word_is_final") is False:
            continue
        sp = str(word.get("speaker") or "").strip()
        if not sp or sp.lower() in _SPEAKER_PENDING:
            continue
        votes[sp] = votes.get(sp, 0) + 1
    if votes:
        return max(votes, key=votes.get)
    return label or None


def _is_answer_echo(text: str, last_answer: str | None) -> bool:
    """True when STT is hearing the model answer, not a new question.

    The substring check is Latin-only. Chinese answers routinely restate
    the question, and 15 Han characters is a complete prompt — the same
    raw length that used to mean a short English phrase.
    """
    if not last_answer or len(last_answer) <= 12:
        return False
    low = (text or "").strip().lower()
    a = last_answer.lower()
    if _ratio(low, a) > 0.7:
        return True
    if _speech_script(text) in ("zh", "ja"):
        return False
    return len(low) > 15 and low in a


def _join_speech_frags(left: str, right: str) -> str:
    a = (left or "").strip()
    b = (right or "").strip()
    if not a:
        return b
    if not b:
        return a
    if not _same_speech_script(a, b):
        return a
    if b.startswith(a):
        return b
    if a.startswith(b):
        return a
    if re.search(r"[\u4e00-\u9fff\u3040-\u30FF\uac00-\ud7af]$", a) and re.search(
        r"^[\u4e00-\u9fff\u3040-\u30FF\uac00-\ud7af]", b
    ):
        return a + b
    if a.endswith(("，", "、", ",", "—", "-")):
        return a + b if re.search(r"^[\u4e00-\u9fff\u3040-\u30FF]", b) else f"{a} {b}".strip()
    return f"{a} {b}".strip()


def _meeting_line_complete(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    if t.endswith(("。", "！", "？", ".", "!", "?", "…")):
        return True
    return len(t) >= 32


def _meeting_should_hold(text: str) -> bool:
    t = (text or "").strip()
    if not t or _meeting_line_complete(t):
        return False
    # Only glue tiny cut-offs. Longer fragments go to the transcript immediately.
    return len(t) < 8


def _merge_meeting_meta(a: dict[str, Any] | None, b: dict[str, Any] | None) -> dict[str, Any]:
    """Merge two turn metas from a held fragment + its continuation: the merged
    line starts at the earlier first_word_ms, ends at the later last_word_ms, and
    its n_words is the sum. Missing ms fields stay None."""
    a = a or {}
    b = b or {}
    fw = [v for v in (a.get("first_word_ms"), b.get("first_word_ms")) if v is not None]
    lw = [v for v in (a.get("last_word_ms"), b.get("last_word_ms")) if v is not None]
    return {
        "first_word_ms": min(fw) if fw else None,
        "last_word_ms": max(lw) if lw else None,
        "n_words": (a.get("n_words") or 0) + (b.get("n_words") or 0),
    }


def _pcm_has_voice(pcm: bytes) -> bool:
    if len(pcm) < 2:
        return False
    peak = 0
    for i in range(0, min(len(pcm) - 1, 3200), 2):
        sample = int.from_bytes(pcm[i : i + 2], "little", signed=True)
        amp = sample if sample >= 0 else -sample
        if amp > peak:
            peak = amp
        if peak > 800:
            return True
    return False


def _translate_line_id(question: str) -> str | None:
    """Extract the line/target id from a translate prompt ``[NOD_TRANSLATE:<id>]``."""
    m = re.match(r"\[NOD_TRANSLATE:([^\]]+)\]", (question or "").strip())
    return m.group(1) if m else None


def assemblyai_ws_url(cfg: dict[str, Any]) -> str:
    stt = cfg.get("stt") or {}
    silence = str(stt.get("max_turn_silence") or "1600")
    params = [
        ("sample_rate", str(SR)),
        ("speech_model", ASSEMBLYAI_MODEL),
        ("speech_models", ASSEMBLYAI_MODEL),
        ("format_turns", "true"),
        ("punctuate", "true"),
        ("format_text", "true"),
        ("max_turn_silence", silence),
    ]
    lang = _normalize_any_lang(stt.get("language"))
    if lang:
        params.append(("language_codes", lang))
    else:
        # No locked language: make AssemblyAI detect and report the language on
        # every turn, so heard_lang_from_turn has a real tag instead of a
        # glyph-guessed "en" for Spanish/Italian/French/German/Portuguese.
        params.append(("language_detection", "true"))
    params.append(("prompt", _stt_prompt(cfg)))
    keyterms = _stt_keyterms(cfg)
    if keyterms:
        params.append(("keyterms_prompt", json.dumps(keyterms, ensure_ascii=False)))
    if stt.get("speaker_labels"):
        params.append(("speaker_labels", "true"))
        cap = _stt_max_speakers(cfg)
        if cap:
            params.append(("max_speakers", str(cap)))
    return ASSEMBLYAI_WS + "?" + urlencode(params)


# At most one live AssemblyAI stream per user+workspace. Start Listening and
# Nod-WS reconnect run on the thread pool, so three start_listen frames in the
# same second used to open three sockets and keep only the last reference.
_LIVE_STT: dict[str, tuple[CloudListener, Session]] = {}
_LIVE_STT_MU = threading.Lock()
_IDLE_WATCH_INTERVAL_SEC = 5.0
_idle_watch_thread: threading.Thread | None = None
_idle_watch_stop = threading.Event()


def _stt_owner_slot(user_id: str | None, workspace: str | None, session_key: int) -> str:
    ws = (workspace or "interview").strip() or "interview"
    if user_id:
        return f"{user_id}:{ws}"
    return f"session:{session_key}"


def _adopt_live_stt(
    slot: str, listener: CloudListener, owner: Session
) -> tuple[CloudListener, Session] | None:
    with _LIVE_STT_MU:
        prev = _LIVE_STT.get(slot)
        _LIVE_STT[slot] = (listener, owner)
        if prev and prev[0] is not listener:
            return prev
        return None


def _drop_live_stt(slot: str, listener: CloudListener) -> None:
    with _LIVE_STT_MU:
        cur = _LIVE_STT.get(slot)
        if cur and cur[0] is listener:
            _LIVE_STT.pop(slot, None)


def _reset_live_stt() -> None:
    with _LIVE_STT_MU:
        _LIVE_STT.clear()


def _tick_live_idle_watches() -> None:
    """Stop forgotten streams even when the client sends no PCM.

    Idle/max checks used to run only inside push_pcm. A Start that never
    forwards audio left the AssemblyAI WebSocket open and billing.
    """
    with _LIVE_STT_MU:
        owners = [sess for _, sess in list(_LIVE_STT.values())]
    for sess in owners:
        try:
            sess._maybe_stop_forgotten_listen()
        except Exception:
            logging.getLogger("nod").exception("idle watch failed")
    uplink.reap(time.time())


def _idle_watch_loop() -> None:
    while not _idle_watch_stop.wait(_IDLE_WATCH_INTERVAL_SEC):
        _tick_live_idle_watches()


def _ensure_idle_watch_thread() -> None:
    global _idle_watch_thread
    t = _idle_watch_thread
    if t is not None and t.is_alive():
        return
    t = threading.Thread(target=_idle_watch_loop, name="nod-stt-idle", daemon=True)
    _idle_watch_thread = t
    t.start()


def _terminate_assemblyai_session(ws, done: threading.Event | None = None) -> None:
    """Send the official Terminate message, then close the socket.

    AssemblyAI bills streaming on WebSocket-open time. The Terminate JSON
    frame is what stops billing. A TCP / WebSocket close alone leaves the
    session open until the 3-hour auto-close, and you are billed for all of it.
    """
    try:
        sock = getattr(ws, "sock", None)
        if sock is not None and getattr(sock, "connected", False):
            ws.send(json.dumps(ASSEMBLYAI_TERMINATE))
            if done is not None and not done.is_set():
                done.wait(timeout=ASSEMBLYAI_TERMINATE_WAIT_SEC)
    except Exception:
        pass
    try:
        ws.close()
    except Exception:
        pass


def assemblyai_prerecorded_body(cfg: dict[str, Any], audio_url: str) -> dict[str, Any]:
    """File STT: same Pro model as live, but the async API sees the whole clip."""
    stt = cfg.get("stt") or {}
    body: dict[str, Any] = {
        "audio_url": audio_url,
        "speech_models": list(ASSEMBLYAI_FILE_MODELS),
        "punctuate": True,
        "format_text": True,
        "prompt": _stt_prompt(cfg),
    }
    lang = _normalize_any_lang(stt.get("language"))
    if lang:
        body["language_code"] = lang
    else:
        body["language_detection"] = True
    keyterms = _stt_keyterms(cfg)
    if keyterms:
        body["keyterms_prompt"] = keyterms
    return body


def clean_transcript(text: str, recent_finals=None, last_answer=None, keep_fillers=False) -> tuple[str, str]:
    t = (text or "").strip()
    t = re.sub(r"[.?!。！？]{2,}", lambda m: m.group(0)[0], t)
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"\b(\w+)(?: \1\b)+", r"\1", t, flags=re.IGNORECASE)
    if not t or not re.search(r"[A-Za-z0-9\u00C0-\u024F\u4e00-\u9fff\u3040-\u30FF\uac00-\ud7af]", t):
        return "", "no content"
    low = t.lower()
    if any(h in low for h in _STT_HALLUCINATIONS):
        return "", "hallucination"
    if len(t) < 60 and any(s in low for s in _STT_STATUS_WORDS):
        return "", "status text"
    if not keep_fillers and low in _STT_SOCIAL_WORDS:
        return "", "social phrase"
    if recent_finals:
        for prev in recent_finals[-2:]:
            if prev and _ratio(low, prev.lower()) > 0.85:
                return "", "duplicate"
    if _is_answer_echo(t, last_answer):
        return "", "echo"
    return t, ""


def _guard_units(text: str) -> int:
    """English letters count as 1; CJK syllables count as 2.

    Interview questions in Chinese are often 4–8 characters. A raw
    `len()` threshold of 18 (tuned for English) dropped them before
    the model ever ran.
    """
    units = 0
    for ch in text:
        if "\u4e00" <= ch <= "\u9fff" or "\u3040" <= ch <= "\u30ff":
            units += 2
        elif ch.isalnum() or ch in "?？":
            units += 1
    return units


def guard_question(text: str, recent_questions, last_answer=None) -> str:
    t = (text or "").strip()
    if not t:
        return "reject"
    low = t.lower()
    has_q = any(w in low for w in GUARD_Q_WORDS)
    units = _guard_units(t)
    if low in _STT_SOCIAL_WORDS:
        return "reject"
    if not has_q and units < 4:
        return "reject"
    if _is_answer_echo(t, last_answer):
        return "reject"
    if recent_questions:
        for q in recent_questions[-2:]:
            if q and _ratio(low, q.lower()) > 0.9:
                return "reject"
    if has_q or units >= 16:
        if t.endswith((",", "，", "、")) or low.endswith((" and", " or", " the", " a")):
            return "wait"
        return "accept"
    if units >= 8:
        return "wait"
    return "reject"


def _looks_like_lead_in(text: str) -> bool:
    """True for a short fragment that reads as the start of a longer question.

    ``"For PostgreSQL,"`` or ``"When we deploy the new service,"`` are lead-ins:
    they should be held (``wait``) so the rest of the question can join them,
    not dropped as a non-question. Only applies to short fragments (< 16 units);
    a long sentence ending in a comma is a statement, not a lead-in.
    """
    t = (text or "").rstrip()
    if not t:
        return False
    low = t.lower()
    trailing = t.endswith((",", "，", "、")) or low.endswith(
        (" and", " or", " the", " a", " for", " in", " with", " about")
    )
    return trailing and _guard_units(t) < 16


def _has_question_word(text: str) -> bool:
    """True when the text carries a recognized question cue (what/how/when/…).

    Used by the interview-wait flush to split a dropped sentence start (no
    question word, e.g. ``"For PostgreSQL,"``) from a truncated question that
    is worth answering (e.g. ``"how do I roll back a"``).
    """
    low = (text or "").lower()
    return any(w in low for w in GUARD_Q_WORDS)


_TRANSIENT_LLM = (
    "timeout", "timed out", "connection", "network", "temporarily",
    "503", "502", "429", "overloaded", "reset", "unavailable",
    "网络", "开小差",
)


def _is_transient_llm_error(err: BaseException) -> bool:
    text = str(err).lower()
    return any(tok in text for tok in _TRANSIENT_LLM)


def _close_llm_stream(stream) -> None:
    """Stop reading so the provider can halt token generation."""
    if stream is None:
        return
    try:
        close = getattr(stream, "close", None)
        if callable(close):
            close()
            return
        resp = getattr(stream, "response", None)
        if resp is not None:
            resp.close()
    except Exception:
        pass


def _friendly_gen_error(err: BaseException) -> str:
    if _is_transient_llm_error(err):
        return "Generation failed: network error. Please try again."
    return f"Generation failed:{err}"


_IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif", "bmp"}
_TEXT_EXTS = {"txt", "md"}
_OFFICE_DOC = {"doc", "docx"}
_OFFICE_SHEET = {"xls", "xlsx"}
_OFFICE_SLIDE = {"ppt", "pptx"}


def _file_ext(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in (name or "") else ""


def _is_image_attach(name: str, mime: str) -> bool:
    return mime.startswith("image/") or _file_ext(name) in _IMAGE_EXTS


def _image_mime(name: str, mime: str) -> str:
    if mime.startswith("image/"):
        return mime
    ext = _file_ext(name)
    return {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
        "gif": "image/gif",
        "bmp": "image/bmp",
    }.get(ext, "image/png")


def _extract_pdf(raw: bytes) -> str:
    from io import BytesIO

    from pypdf import PdfReader

    reader = PdfReader(BytesIO(raw))
    body = "\n".join((p.extract_text() or "") for p in reader.pages)[:12000]
    return body or "[PDF attached, no extractable text.]"


def _extract_docx(raw: bytes) -> str:
    from io import BytesIO

    from docx import Document

    doc = Document(BytesIO(raw))
    parts = [p.text for p in doc.paragraphs if p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    return "\n".join(parts)[:12000] or "[Word document attached, no extractable text.]"


def _extract_xlsx(raw: bytes) -> str:
    from io import BytesIO

    from openpyxl import load_workbook

    wb = load_workbook(BytesIO(raw), read_only=True, data_only=True)
    lines: list[str] = []
    for sheet in wb.worksheets:
        lines.append(f"# {sheet.title}")
        for row in sheet.iter_rows(values_only=True):
            cells = [str(c) for c in row if c is not None and str(c).strip()]
            if cells:
                lines.append(" | ".join(cells))
            if len("\n".join(lines)) > 12000:
                break
    wb.close()
    return "\n".join(lines)[:12000] or "[Spreadsheet attached, no extractable text.]"


def _extract_pptx(raw: bytes) -> str:
    from io import BytesIO

    from pptx import Presentation

    prs = Presentation(BytesIO(raw))
    parts: list[str] = []
    for i, slide in enumerate(prs.slides, 1):
        bits = []
        for shape in slide.shapes:
            text = getattr(shape, "text", "") or ""
            if text.strip():
                bits.append(text.strip())
        if bits:
            parts.append(f"# Slide {i}\n" + "\n".join(bits))
    return "\n".join(parts)[:12000] or "[Slides attached, no extractable text.]"


def _extract_attachment_text(name: str, mime: str, raw: bytes) -> str:
    ext = _file_ext(name)
    if ext in _TEXT_EXTS or mime.startswith("text/"):
        return raw.decode("utf-8", errors="replace")[:12000]
    if ext == "pdf" or mime == "application/pdf":
        return _extract_pdf(raw)
    if ext in _OFFICE_DOC or "wordprocessingml" in mime:
        if ext == "doc":
            return "[Old .doc files are not supported. Save as .docx and attach again.]"
        return _extract_docx(raw)
    if ext in _OFFICE_SHEET or "spreadsheetml" in mime:
        if ext == "xls":
            return "[Old .xls files are not supported. Save as .xlsx and attach again.]"
        return _extract_xlsx(raw)
    if ext in _OFFICE_SLIDE or "presentationml" in mime:
        if ext == "ppt":
            return "[Old .ppt files are not supported. Save as .pptx and attach again.]"
        return _extract_pptx(raw)
    if _is_image_attach(name, mime):
        return f"[Image attached: {name}. The model can see this image.]"
    return f"[Attached file: {name}]"


def attachments_to_prompt(files) -> str:
    if not files:
        return ""
    blocks = []
    for item in files:
        name = (item or {}).get("name") or "file"
        mime = (item or {}).get("mime") or ""
        data = (item or {}).get("data") or ""
        try:
            raw = __import__("base64").b64decode(data)
        except Exception:
            blocks.append(f"[Could not read {name}]")
            continue
        try:
            body = _extract_attachment_text(name, mime, raw)
        except Exception as e:
            body = f"[Could not read {name}: {e}]"
        blocks.append(f"--- Attached: {name} ---\n{body}")
    return "\n\n".join(blocks)


def attachment_images(files) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in files or []:
        data = (item or {}).get("data") or ""
        name = (item or {}).get("name") or "image"
        mime = (item or {}).get("mime") or ""
        if not data or not _is_image_attach(name, mime):
            continue
        out.append({"name": name, "mime": _image_mime(name, mime), "data": data})
    return out[:4]


_ATTACH_TTL = 600.0
_ATTACH_CACHE: dict[str, dict[str, Any]] = {}
_ATTACH_LOCK = threading.Lock()
ATTACH_MAX_FILE_BYTES = 8 * 1024 * 1024
ATTACH_MAX_FILES = 5
ATTACH_MAX_BODY_BYTES = ATTACH_MAX_FILE_BYTES * ATTACH_MAX_FILES
ATTACH_MAX_B64_CHARS = (ATTACH_MAX_FILE_BYTES * 4 + 2) // 3


def attach_body_too_large(content_length: str | None) -> bool:
    if content_length is None or str(content_length).strip() == "":
        return False
    try:
        return int(content_length) > ATTACH_MAX_BODY_BYTES
    except (TypeError, ValueError):
        return True


def attach_b64_too_large(data: object) -> bool:
    if not isinstance(data, str):
        return True
    return len(data) > ATTACH_MAX_B64_CHARS


LLM_QUOTA_CHECK_EVERY = 16


def estimate_llm_tokens(prompt: str, answer: str) -> tuple[int, int]:
    return max(1, len(prompt) // 4), max(1, len(answer) // 4)


def llm_usage_from_chunk(ch: Any) -> tuple[int, int] | None:
    usage = getattr(ch, "usage", None)
    if usage is None and isinstance(ch, dict):
        usage = ch.get("usage")
    if usage is None:
        return None
    if isinstance(usage, dict):
        inp, out = usage.get("prompt_tokens"), usage.get("completion_tokens")
    else:
        inp = getattr(usage, "prompt_tokens", None)
        out = getattr(usage, "completion_tokens", None)
    if inp is None or out is None:
        return None
    return max(0, int(inp)), max(0, int(out))


def resolve_llm_usage(stream_usage: tuple[int, int] | None, prompt: str, answer: str) -> tuple[int, int]:
    if stream_usage is not None:
        return stream_usage
    return estimate_llm_tokens(prompt, answer)


def stream_should_recheck_quota(chunk_index: int, every: int = LLM_QUOTA_CHECK_EVERY) -> bool:
    return chunk_index > 0 and chunk_index % every == 0


def _prune_attach_cache(now: float | None = None) -> None:
    now = time.time() if now is None else now
    with _ATTACH_LOCK:
        dead = [k for k, row in _ATTACH_CACHE.items() if now - float(row.get("at") or 0) > _ATTACH_TTL]
        for key in dead:
            _ATTACH_CACHE.pop(key, None)
        while len(_ATTACH_CACHE) > 32:
            oldest = min(_ATTACH_CACHE, key=lambda k: float(_ATTACH_CACHE[k].get("at") or 0))
            _ATTACH_CACHE.pop(oldest, None)


def store_attach_files(files) -> str:
    _prune_attach_cache()
    aid = uuid.uuid4().hex
    with _ATTACH_LOCK:
        _ATTACH_CACHE[aid] = {"at": time.time(), "files": list(files or [])}
    return aid


def take_attach_files(aid: str):
    if not aid:
        return None
    with _ATTACH_LOCK:
        row = _ATTACH_CACHE.pop(str(aid), None)
    if not row:
        return None
    if time.time() - float(row.get("at") or 0) > _ATTACH_TTL:
        return None
    return row.get("files")


def assemblyai_transcribe_accurate(
    api_key: str,
    pcm: bytes,
    cfg: dict[str, Any],
    timeout: float | None = None,
) -> tuple[str, str | None]:
    from server.r2 import pcm_to_wav

    wav = pcm_to_wav(pcm)
    dur = len(pcm) / float(SR * 2)
    if timeout is None:
        timeout = min(30 * 60.0, max(90.0, dur * 0.4 + 60.0))
    write_s = min(180.0, max(60.0, len(wav) / 250_000))
    headers = {"authorization": api_key}
    with httpx.Client(timeout=httpx.Timeout(timeout, connect=20.0, write=write_s, read=timeout)) as client:
        up = client.post(
            f"{ASSEMBLYAI_API}/v2/upload",
            headers={**headers, "content-type": "application/octet-stream"},
            content=wav,
        )
        up.raise_for_status()
        audio_url = (up.json() or {}).get("upload_url")
        if not audio_url:
            raise RuntimeError("AssemblyAI upload missing url")
        created = client.post(
            f"{ASSEMBLYAI_API}/v2/transcript",
            headers=headers,
            json=assemblyai_prerecorded_body(cfg, audio_url),
        )
        created.raise_for_status()
        tid = (created.json() or {}).get("id")
        if not tid:
            raise RuntimeError("AssemblyAI transcript missing id")
        deadline = time.time() + timeout
        while time.time() < deadline:
            poll = client.get(f"{ASSEMBLYAI_API}/v2/transcript/{tid}", headers=headers)
            poll.raise_for_status()
            data = poll.json() or {}
            status = data.get("status")
            if status == "completed":
                text = (data.get("text") or "").strip()
                return text, heard_lang_from_code(data.get("language_code"))
            if status == "error":
                raise RuntimeError(data.get("error") or "AssemblyAI file transcription failed")
            time.sleep(1.5)
    raise RuntimeError("AssemblyAI file transcription timeout")


def assemblyai_transcribe_pcm(api_key: str, pcm: bytes, cfg: dict[str, Any], timeout: float = 18.0) -> tuple[str, str | None]:
    import websocket
    result = {"text": "", "lang": None, "err": None}
    parts: list[str] = []
    done = threading.Event()
    url = assemblyai_ws_url(cfg)

    def on_open(ws):
        def send():
            step = SR // 10 * 2
            try:
                for i in range(0, len(pcm), step):
                    if not ws.sock or not ws.sock.connected:
                        return
                    ws.send(pcm[i:i + step], websocket.ABNF.OPCODE_BINARY)
                if ws.sock and ws.sock.connected:
                    ws.send(json.dumps(ASSEMBLYAI_TERMINATE))
            except Exception as e:
                result["err"] = str(e)
                done.set()
        threading.Thread(target=send, daemon=True).start()

    def on_message(_ws, message):
        try:
            data = json.loads(message)
        except (TypeError, json.JSONDecodeError):
            return
        kind = data.get("type")
        if kind == "Turn":
            t = (data.get("utterance") or data.get("transcript") or "").strip()
            if t:
                result["lang"] = heard_lang_from_turn(data) or result.get("lang")
                if data.get("end_of_turn"):
                    parts.append(t)
                    result["text"] = " ".join(parts)
                else:
                    result["text"] = " ".join(parts + [t]) if parts else t
        elif kind in ("Termination", "Error"):
            if kind == "Error":
                result["err"] = data.get("error") or message
            done.set()

    def on_error(_ws, error):
        result["err"] = str(error)
        done.set()

    def on_close(_ws, status_code, msg):
        if status_code and status_code >= 400 and not result["text"]:
            result["err"] = result["err"] or f"WebSocket {status_code} {msg or ''}".strip()
        done.set()

    ws = websocket.WebSocketApp(
        url,
        header=[f"Authorization: {api_key}"],
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )
    threading.Thread(target=lambda: ws.run_forever(ping_interval=20, ping_timeout=10), daemon=True).start()
    if not done.wait(timeout):
        result["err"] = result["err"] or "AssemblyAI timeout"
    _terminate_assemblyai_session(ws, done)
    if result["err"] and not result["text"]:
        raise RuntimeError(result["err"])
    return result["text"], result.get("lang")


def _fmt_hours(seconds) -> str:
    if not seconds:
        return "0h"
    return f"{round(seconds / 3600 * 10) / 10:g}h"


def _quota_copy(snap: dict) -> str:
    """Reason-specific 'limit reached' line, mirroring web/src/quotaCopy.ts so the
    server error/status text can't bury the reason under a generic message."""
    reason = snap.get("reason") or ""
    if reason == "sessions":
        return f"Monthly session limit reached ({snap.get('session_limit') or 60}). Resets on the 1st."
    if reason == "daily_stt":
        return f"Daily listening limit reached ({_fmt_hours(snap.get('daily_stt_limit'))}). Resets at midnight UTC."
    if reason == "llm":
        return f"Monthly token limit reached ({snap.get('llm_limit') or 100000:,}). Resets on the 1st."
    if reason == "daily":
        return "Daily spending limit reached. Resets at midnight UTC."
    if reason == "global":
        return "Daily platform budget reached. Try again later."
    if reason == "stt":
        return f"Monthly listening limit reached ({_fmt_hours(snap.get('stt_limit'))}). Resets on the 1st."
    return "Usage limit reached — open Account"


class Pipeline:
    def __init__(self, cfg: dict[str, Any], keys: dict[str, str], emit: Callable[[dict], None]):
        self.cfg = cfg
        self._keys = dict(keys)
        self.emit = emit
        self._provider = cfg["llm"].get("provider", "deepseek")
        self._model = cfg["llm"].get("model", "deepseek-v4-flash")
        self.client = self._make_client()
        self._qa_history: list[dict] = []
        self._last_answer = ""
        self._cancel = threading.Event()
        self._gen_seq = 0
        self._stream = None
        self._stream_mu = threading.Lock()
        self.user_id: str | None = None
        self.usage_session_id: str | None = None
        self._heard_lang: str | None = None

    def _stream_lock(self) -> threading.Lock:
        mu = getattr(self, "_stream_mu", None)
        if mu is None:
            mu = threading.Lock()
            self._stream_mu = mu
        return mu

    def abort_stream(self) -> None:
        """Stop an in-flight completion so leftover tokens are not billed."""
        self._cancel.set()
        self._gen_seq += 1
        with self._stream_lock():
            stream = getattr(self, "_stream", None)
            self._stream = None
        _close_llm_stream(stream)

    def _new_qid(self) -> str:
        return f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"

    def assemblyai_key(self) -> str:
        return (self._keys.get("ASSEMBLYAI_API_KEY") or "").strip()

    def _make_client(self) -> OpenAI:
        endpoint = PROVIDER_ENDPOINTS.get(self._provider, PROVIDER_ENDPOINTS["deepseek"])
        key = (self._keys.get(PROVIDER_KEY.get(self._provider, "DEEPSEEK_API_KEY"), "") or "").strip() or "missing"
        # Without an explicit timeout the SDK waits up to 600s with 2 built-in
        # retries; a hung upstream held `busy` for many minutes and every ask /
        # translate queued behind it. process_text already retries transients.
        timeout = httpx.Timeout(90.0, connect=10.0, read=90.0)
        return OpenAI(api_key=key, base_url=endpoint, timeout=timeout, max_retries=0)

    def set_keys(self, keys: dict[str, str]) -> None:
        self._keys.update({k: v for k, v in keys.items() if v})
        self.client = self._make_client()

    def set_model(self, provider: str, model: str) -> None:
        self._provider = provider
        self._model = model
        self.client = self._make_client()
        self.emit({"type": "status", "text": f"Switched to model: {model} ({provider})"})

    def key_status(self) -> dict[str, bool]:
        return {
            "has_llm": bool((self._keys.get("OPENROUTER_API_KEY") or self._keys.get("DEEPSEEK_API_KEY") or "").strip()),
            "has_stt": bool(self.assemblyai_key()),
        }

    def repair_caption(self, text: str, recent: list[str]) -> str:
        """Light STT polish. Skip when there is no context, and keep the original if the model rewrites too much."""
        src = (text or "").strip()
        ctx_lines = [t.strip() for t in recent if (t or "").strip()]
        if not src or len(src) < 8 or not ctx_lines:
            return src
        if not self.key_status().get("has_llm"):
            return src
        if self.user_id:
            try:
                from server.meter import check_can_generate

                ok, _snap = check_can_generate(self.user_id)
                if not ok:
                    return src
            except Exception:
                return src
        ctx = "\n".join(f"- {t}" for t in ctx_lines[-4:])
        try:
            kwargs: dict[str, Any] = dict(
                model=self._model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Correct speech-to-text errors only. Use previous lines for names and topic. "
                            "Do not translate, summarize, or add meaning. "
                            "If the line is already fine, return it unchanged. Output the line only."
                        ),
                    },
                    {"role": "user", "content": f"Previous lines:\n{ctx}\n\nCaption:\n{src}"},
                ],
                max_tokens=min(220, max(64, len(src) + 24)),
                stream=False,
                temperature=0.1,
            )
            if self._provider == "deepseek":
                kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
            resp = self.client.with_options(timeout=8.0).chat.completions.create(**kwargs)
            out = ""
            if resp and getattr(resp, "choices", None):
                out = (resp.choices[0].message.content or "").strip()
            fixed = apply_caption_repair(src, out)
            if self.user_id:
                from server.meter import consume_llm

                consume_llm(
                    self.user_id,
                    self.usage_session_id,
                    max(1, len(src) // 4),
                    max(1, len(out or src) // 4),
                )
            return fixed
        except Exception:
            return src

    def _answer_lang(self, question: str) -> str:
        locked = _normalize_stt_lang((self.cfg.get("stt") or {}).get("language"))
        if locked:
            return locked
        if self._heard_lang:
            return self._heard_lang
        return detect_question_lang(question)

    def _lang_rule(self, question: str) -> str:
        lang = self._answer_lang(question)
        name = _LANG_NAMES.get(lang, "English")
        if lang == "zh":
            return (
                "LANGUAGE (hard rule): The question is in Chinese. "
                "Answer in Chinese only. Do not switch to English except for proper nouns and tech terms."
            )
        return (
            f"LANGUAGE (hard rule): The question is in {name}. "
            f"Answer in {name} only. Do not switch language except for proper nouns and tech terms."
        )

    def _tag_inner(self, question: str) -> str:
        first = (question or "").lstrip().split("\n", 1)[0]
        if not first.startswith("[NOD_") or "]" not in first:
            return ""
        return first[1:first.index("]")]

    def _bilingual_from_tag(self, question: str) -> str | None:
        inner = self._tag_inner(question)
        for p in inner.split(":")[1:]:
            if p == "bi":
                return "auto"
            if p.startswith("bi-"):
                return _normalize_stt_lang(p[3:]) or "auto"
        return None

    def _out_lang_from_tag(self, question: str) -> str | None:
        inner = self._tag_inner(question)
        if not inner.startswith(("NOD_CATCH:", "NOD_ASK:", "NOD_NOTES:")):
            return None
        parts = [p for p in inner.split(":")[1:] if p and not p.startswith("bi")]
        if not parts:
            return None
        last = parts[-1]
        if last == "auto":
            return None
        return _normalize_stt_lang(last)

    def _output_lang_rule(self, lang: str | None, bilingual: str | None = None) -> str:
        if bilingual:
            if bilingual != "auto":
                name = _LANG_NAMES.get(bilingual, bilingual)
            else:
                name = _LANG_NAMES.get(lang or "", "the notes language, or Chinese if unclear")
            return (
                f"\nBILINGUAL (hard rule): Every sentence or bullet has TWO lines. "
                f"Line 1 is the transcript / source language. Line 2 starts with '>> ' then the {name} translation. "
                "Never output only one language."
            )
        name = _LANG_NAMES.get(lang or "", "the notes language, or Chinese if unclear")
        if not lang:
            return ""
        return (
            f"\nOUTPUT LANGUAGE (hard rule): Write every sentence in {name} only. "
            "Do not follow the transcript language or any listener question language."
        )

    def _strip_nod_tag(self, question: str) -> str:
        text = question or ""
        if text.startswith(("[NOD_TRANSLATE", "[NOD_CATCH", "[NOD_ASK", "[NOD_NOTES")):
            nl = text.find("\n")
            if nl >= 0:
                return text[nl + 1:].strip()
        return text

    def _is_internal(self, question: str, mode: str) -> bool:
        if mode in ("translate", "notes", "listen_ask"):
            return True
        t = (question or "").lstrip()
        return t.startswith(("[NOD_TRANSLATE", "[NOD_CATCH", "[NOD_ASK", "[NOD_NOTES", "Translate to "))

    def _with_images(self, messages: list[dict], images: list[dict[str, str]] | None) -> list[dict]:
        if not images:
            return messages
        last = dict(messages[-1])
        text = last.get("content") if isinstance(last.get("content"), str) else ""
        parts: list[dict[str, Any]] = [{"type": "text", "text": text}]
        for img in images:
            mime = img.get("mime") or "image/png"
            if not mime.startswith("image/"):
                mime = "image/png"
            parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{img.get('data') or ''}"},
            })
        last["content"] = parts
        return [*messages[:-1], last]

    def _build_messages(self, question: str, mode: str = "auto") -> list[dict]:
        bilingual = self._bilingual_from_tag(question)
        out_lang = self._out_lang_from_tag(question)
        out_rule = self._output_lang_rule(out_lang, bilingual)
        question = self._strip_nod_tag(question)
        if mode == "translate" or question.startswith("Translate to "):
            # The target lives inside the user message; models sometimes drift
            # to the context language (e.g. answered Chinese for an EN target),
            # so restate it as a hard rule in the system prompt.
            tm = re.match(r"Translate to ([A-Za-z]+)\.", question)
            target = tm.group(1) if tm else ""
            target_rule = (
                f"TARGET LANGUAGE (hard rule): {target}. Every word of the output must be {target} — "
                "never the language of the context lines or of the source.\n"
                if target
                else ""
            )
            return [
                {
                    "role": "system",
                    "content": (
                        "You are a translator for live captions.\n"
                        + target_rule
                        + "Translate ONLY the line after 'Translate only this line:'. "
                        "Lines under 'Previous lines' are context for names, topic, and source language — do not translate them.\n"
                        "Output ONLY the translation in the requested target language — no quotes, labels, notes, or preamble.\n"
                        "Preserve proper nouns, product names, and numbers. "
                        "Keep product names, brand names, and capitalized proper nouns exactly as written in the source (do not translate or transliterate them); keep their original casing. "
                        "If the line ends mid-sentence (no terminal punctuation, or ends with a preposition / article / conjunction / auxiliary), translate only what is there and end the translation without terminal punctuation. Never complete, guess, or round off the sentence. "
                        "If the line is already in the target language, return it unchanged. "
                        "Allowed targets: Chinese, English, Japanese, Italian, Spanish, French, German, Portuguese."
                    ),
                },
                {"role": "user", "content": question},
            ]
        if mode == "listen_ask" or question.startswith("Listener question:"):
            if out_lang is None and not bilingual:
                # Tag already stripped; Auto notes has no system-level language
                # pin (same drift the translate branch already closed).
                lang = listen_ask_lang(
                    question,
                    locked=_normalize_stt_lang((self.cfg.get("stt") or {}).get("language")),
                )
                if lang:
                    name = _LANG_NAMES.get(lang, lang)
                    out_rule = (
                        f"\nOUTPUT LANGUAGE (hard rule): Write the entire answer in {name} only. "
                        "Do not switch language except for proper nouns and technical terms."
                    )
            return [
                {
                    "role": "system",
                    "content": (
                        "You are a live listening assistant. The user may ask at any moment.\n"
                        "Answer their question clearly and briefly.\n"
                        "Use the transcript when it helps. If it is empty or silent on the topic, say so, then answer from general knowledge if the question allows it.\n"
                        "Do not invent quotes, names, numbers, or decisions that were not said.\n"
                        "If the question needs current information beyond the transcript, say you cannot check live sources, then answer what you can.\n"
                        "4-10 short sentences or bullets. No preamble."
                        + out_rule
                    ),
                },
                {"role": "user", "content": question},
            ]
        if mode == "file_ask":
            return [
                {
                    "role": "system",
                    "content": (
                        "You are a helpful assistant. Read every attached file and image carefully.\n"
                        "Answer the user's request using that content the same way a chat model would.\n"
                        "If they only attached files, summarize the useful information, then answer any implied question.\n"
                        "Be specific. Quote names, numbers, and claims from the files when they matter.\n"
                        "If an image is attached, describe and analyze what you actually see.\n"
                        "Do not invent contents that are not in the files."
                        + out_rule
                    ),
                },
                {"role": "user", "content": question},
            ]
        if mode == "notes" or question.startswith("Write structured notes"):
            return [
                {
                    "role": "system",
                    "content": (
                        "You write structured listening notes for a live session. The transcript may be mid-session; summarize what has been said so far and do not say the session has ended unless the transcript shows it.\n"
                        "Return JSON only. No markdown fence.\n"
                        "Keys: summary (string), takeaways, keyPoints, decisions, actionItems, "
                        "importantDetails, followUps, revisionNotes, speakers.\n"
                        "Lists are arrays of short strings. actionItems is an array of objects "
                        "{\"text\":\"...\",\"owner\":\"...\"} — omit owner if nobody was named.\n"
                        "speakers is an array of {\"label\":\"...\",\"name\":\"...\",\"evidence\":\"...\"}: "
                        "label = the speaker label exactly as it appears in the transcript (e.g. \"Host\"); "
                        "name = the person's real name ONLY if it is explicitly spoken for that speaker "
                        "(self-introduction, or another speaker addressing them by name); "
                        "evidence = the short quote that proves it. Never infer a name from topic, role, or context. "
                        "Empty array when nobody is named.\n"
                        "Use empty arrays when the transcript has nothing for that key. Do not invent."
                        + out_rule
                    ),
                },
                {"role": "user", "content": question},
            ]
        p = self.cfg.get("profile") or {}
        hist = self._qa_history[-2:]
        ctx = ""
        if hist:
            ctx = "\n\nRecent confirmed Q&A (follow-up context only):\n" + "\n".join(
                f"Q: {h['q']}\nA: {h['a'][:300]}" for h in hist
            )
        extra = ""
        if p.get("resume_summary"):
            extra += f"\nUser background (use only if relevant): {p.get('resume_summary')}"
        if p.get("target_role"):
            extra += f"\nOptional job context: {p.get('target_role')}"
            if p.get("company"):
                extra += f" / {p.get('company')}"
        if p.get("jd"):
            extra += f"\nJob description (use only if the question is about that job): {p.get('jd')}"
        style = (p.get("style") or "").strip() or "Clear and concise. Lead with the point, then a short explanation."
        sys_msg = (
            "You are a helpful Q&A assistant. Answer the user's question directly and neutrally.\n"
            "Do not role-play as a job candidate and do not dismiss a question as off-topic.\n"
            "If they later ask for interview practice, then help with that. Otherwise just answer."
            + extra
            + "\n\nYou answer ONLY the user's confirmed question.\n"
            + self._lang_rule(question)
            + "\n\nAnswer rules:\n1. Answer the question itself.\n"
            f"2. Style: {style}\n"
            "3. Keep it short: 60-100 words, 3-5 sentences, lead with the conclusion.\n"
            "4. Follow the LANGUAGE hard rule above even if notes are in another language.\n"
            + ctx
        )
        lang = self._answer_lang(question)
        name = _LANG_NAMES.get(lang, "English")
        lang_line = f"Answer language: {name} only."
        return [
            {"role": "system", "content": sys_msg},
            {"role": "user", "content": f"Question: {question}\n\n{lang_line}\n\nAnswer:"},
        ]

    def process_text(
        self,
        question: str,
        mode: str = "ask",
        heard_lang: str | None = None,
        images: list | None = None,
        display_text: str | None = None,
    ) -> None:
        t = (question or "").strip()
        self._heard_lang = _normalize_stt_lang(heard_lang)
        if not t:
            self.emit({"type": "status", "text": "Please type a question first"})
            self.emit({"type": "done", "id": "", "stt": 0, "llm": 0, "ok": False})
            return
        if self.user_id:
            from server.meter import check_can_generate

            ok, snap = check_can_generate(self.user_id)
            self.emit({"type": "quota", **snap})
            if not ok:
                logging.getLogger("nod").warning(
                    "quota_exceeded user=%s reason=%s sessions=%s/%s daily_cost=%s global_cost=%s",
                    self.user_id, snap.get("reason"), snap.get("sessions"), snap.get("session_limit"),
                    snap.get("daily_cost_usd"), snap.get("global_cost_usd"),
                )
                self.emit({"type": "quota_exceeded", "reason": snap.get("reason") or "llm"})
                self.emit({"type": "error", "text": _quota_copy(snap)})
                self.emit({"type": "done", "id": "", "stt": 0, "llm": 0, "ok": False})
                return
        self._cancel.clear()
        self._gen_seq += 1
        seq = self._gen_seq
        qid = self._new_qid()
        internal = self._is_internal(t, mode)
        self.emit({"type": "status", "text": STATUS_GENERATE})
        # Always emit question so the client can bind a pending Ask/Notes card
        # to this generation id. Tagged internal prompts are filtered in the UI
        # and must not be omitted — otherwise the next transcript line steals the card.
        shown = (display_text or t).strip() if not internal else t
        ev: dict[str, Any] = {"type": "question", "id": qid, "text": shown}
        if not internal:
            heard = self._heard_lang or (detect_question_lang(display_text or t) if mode in ("ask", "file_ask") else None)
            if heard:
                ev["language"] = heard
        self.emit(ev)
        t0 = time.time()
        llm = self.cfg.get("llm") or {}
        max_tokens = int(llm.get("max_tokens") or 800)
        if mode in ("ask", "file_ask"):
            max_tokens = max(max_tokens, 1600)
        elif mode in ("notes", "listen_ask"):
            max_tokens = max(max_tokens, 1600)
        elif mode == "translate":
            max_tokens = max(max_tokens, 800)
        answer = ""
        stream_usage: tuple[int, int] | None = None
        messages = self._with_images(self._build_messages(t, mode), images)
        model = VISION_MODEL if (images and self._provider == "deepseek") else self._model
        last_err: Exception | None = None
        for attempt in range(2):
            if seq != self._gen_seq or self._cancel.is_set():
                self.emit({"type": "done", "id": qid, "stt": 0, "llm": round(time.time() - t0, 2), "ok": False})
                return
            stream = None
            try:
                kwargs: dict[str, Any] = dict(
                    model=model,
                    messages=messages,
                    max_tokens=max_tokens,
                    stream=True,
                    stream_options={"include_usage": True},
                )
                if not str(model).startswith(("o1", "o3")):
                    kwargs["temperature"] = llm.get("temperature", 0.5)
                if self._provider == "deepseek":
                    kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
                stream = self.client.chat.completions.create(**kwargs)
                with self._stream_lock():
                    self._stream = stream
                reasoning = ""
                n_chunks = 0
                for ch in stream:
                    if seq != self._gen_seq or self._cancel.is_set():
                        self.emit({"type": "done", "id": qid, "stt": 0, "llm": round(time.time() - t0, 2), "ok": False})
                        return
                    got = llm_usage_from_chunk(ch)
                    if got is not None:
                        stream_usage = got
                    if not ch.choices:
                        continue
                    delta = ch.choices[0].delta
                    piece = getattr(delta, "content", None) or ""
                    if piece:
                        answer += piece
                        self.emit({"type": "chunk", "id": qid, "text": piece})
                        n_chunks += 1
                        if self.user_id and stream_should_recheck_quota(n_chunks):
                            from server.meter import check_can_generate

                            ok, snap = check_can_generate(self.user_id)
                            if not ok:
                                logging.getLogger("nod").warning(
                                    "quota_exceeded user=%s reason=%s sessions=%s/%s daily_cost=%s global_cost=%s",
                                    self.user_id, snap.get("reason"), snap.get("sessions"), snap.get("session_limit"),
                                    snap.get("daily_cost_usd"), snap.get("global_cost_usd"),
                                )
                                self.emit({"type": "quota", **snap})
                                self.emit({"type": "quota_exceeded", "reason": snap.get("reason") or "llm"})
                                self.emit({"type": "error", "text": _quota_copy(snap)})
                                self.emit({"type": "done", "id": qid, "stt": 0, "llm": round(time.time() - t0, 2), "ok": False})
                                return
                    think = getattr(delta, "reasoning_content", None) or ""
                    if think:
                        reasoning += think
                if not answer and reasoning:
                    answer = reasoning
                    self.emit({"type": "chunk", "id": qid, "text": reasoning})
                last_err = None
                break
            except Exception as e:
                last_err = e
                if seq != self._gen_seq or self._cancel.is_set():
                    self.emit({"type": "done", "id": qid, "stt": 0, "llm": round(time.time() - t0, 2), "ok": False})
                    return
                # Retry only when create() never returned a stream. A timeout
                # after the request left the client can still be running upstream;
                # a second create() would double-bill tokens.
                if attempt == 0 and stream is None and not answer and _is_transient_llm_error(e):
                    continue
                self.emit({"type": "error", "text": _friendly_gen_error(e)})
                self.emit({"type": "done", "id": qid, "stt": 0, "llm": round(time.time() - t0, 2), "ok": False})
                return
            finally:
                with self._stream_lock():
                    if getattr(self, "_stream", None) is stream:
                        self._stream = None
                _close_llm_stream(stream)
        if last_err and not answer:
            self.emit({"type": "error", "text": _friendly_gen_error(last_err)})
            self.emit({"type": "done", "id": qid, "stt": 0, "llm": round(time.time() - t0, 2), "ok": False})
            return
        if seq != self._gen_seq or self._cancel.is_set():
            self.emit({"type": "done", "id": qid, "stt": 0, "llm": round(time.time() - t0, 2), "ok": False})
            return
        if not answer:
            self.emit({"type": "error", "text": "Generation failed: empty response"})
            self.emit({"type": "done", "id": qid, "stt": 0, "llm": round(time.time() - t0, 2), "ok": False})
            return
        self._last_answer = answer[-400:]
        if mode not in ("translate", "notes", "listen_ask"):
            self._qa_history.append({"qid": qid, "q": self._strip_nod_tag(t), "a": answer})
            self._qa_history = self._qa_history[-6:]
        if self.user_id:
            # The answer already streamed. Accounting must never swallow `done` —
            # the client only releases the translate gate and closes the answer
            # card on it, so a DB hiccup here would stick the UI on Translating.
            try:
                self._record_usage(t, answer, mode, qid, internal, stream_usage)
            except Exception:
                logging.getLogger("nod").exception("usage accounting failed")
        self.emit({"type": "done", "id": qid, "stt": 0, "llm": round(time.time() - t0, 2), "ok": True})

    def _record_usage(
        self,
        t: str,
        answer: str,
        mode: str,
        qid: str,
        internal: bool,
        stream_usage: tuple[int, int] | None = None,
    ) -> None:
        from server.meter import consume_llm, save_history, update_history_text

        inp, out = resolve_llm_usage(stream_usage, t, answer)
        ok, snap = consume_llm(self.user_id, self.usage_session_id, inp, out)
        self.emit({"type": "quota", **snap})
        kind_q = "transcript" if mode == "translate" else "question"
        if not internal:
            save_history(self.user_id, self.usage_session_id, kind_q, self._strip_nod_tag(t), qid)
        if mode == "translate":
            # A meeting-line translation keyed to its line id: the source was
            # already saved at emit, and a re-translation overwrites the stale
            # row instead of stacking half-sentence translations (issue #29).
            line_id = _translate_line_id(t)
            if line_id:
                update_history_text(self.user_id, self.usage_session_id, line_id, answer, kind="translate")
            else:
                save_history(self.user_id, self.usage_session_id, "answer" if mode == "ask" else mode, answer, qid)
        else:
            save_history(self.user_id, self.usage_session_id, "answer" if mode == "ask" else mode, answer, qid)
        if mode in ("ask", "notes"):
            try:
                from server.meter import write_session_notes

                write_session_notes(self.user_id, self.usage_session_id)
            except Exception:
                logging.getLogger("nod").exception("r2 notes upload failed")
        if not ok:
            logging.getLogger("nod").warning(
                "quota_exceeded user=%s reason=%s sessions=%s/%s daily_cost=%s global_cost=%s",
                self.user_id, snap.get("reason"), snap.get("sessions"), snap.get("session_limit"),
                snap.get("daily_cost_usd"), snap.get("global_cost_usd"),
            )
            self.emit({"type": "quota_exceeded", "reason": snap.get("reason") or "llm"})


class CloudListener:
    def __init__(self, api_key: str, cfg: dict[str, Any], on_final, on_partial, on_error, on_drop=None, on_sent=None):
        self.api_key = api_key
        self.cfg = cfg
        self.on_final = on_final
        self.on_partial = on_partial
        self.on_error = on_error
        self.on_drop = on_drop
        self.on_sent = on_sent
        self._q: queue.Queue[bytes] = queue.Queue()
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._fail: list[str] = []
        self._ws = None
        self._last_final = ""
        self._committed_turns: dict[int, str] = {}
        self._last_partial: dict[str, Any] | None = None
        self._muted = False
        self._was_ready = False
        self._drop_sent = False
        self._terminated = threading.Event()
        self._turn_order = 0
        pacing = (cfg.get("stt") or {}).get("turn_pacing")
        self._turn_pacing = pacing if isinstance(pacing, dict) else None
        self._force_inflight = 0.0
        self._force_pending = False
        self._pcm_buf = bytearray()
        self._q_bytes = 0  # bytes sitting in _q, under _pcm_mu
        self._pcm_inflight_bytes = 0
        self._last_send_at = 0.0
        self._last_send_bytes = 0
        self._last_send_ms = 0.0
        self._last_send_interval_ms = 0.0
        self._send_count = 0
        self._drain = threading.Event()
        self._drained = threading.Event()
        self._drain_failed = threading.Event()
        self._sender_exited = threading.Event()
        self._drain_send_failed = False
        self._stt_tx_bytes = 0
        self._sender_thread: threading.Thread | None = None
        self._pcm_mu = threading.Lock()

    def set_muted(self, muted: bool) -> None:
        self._muted = bool(muted)

    def push_pcm(self, pcm: bytes) -> str:
        """Accept one PCM frame, returning an explicit ownership result.

        ``PCM_ACCEPTED`` — the bytes are safely queued (counted against the byte
        budget). ``PCM_BACKPRESSURE`` — the budget is exhausted; the caller must
        not treat this as success, but keep the original (the Session archive
        does) and surface the failure. ``PCM_TERMINATED`` — this listener is
        stopped; no byte may be accounted as delivered. The old drop-oldest /
        swallow-full behaviour is gone (issue #165 P1).
        """
        if self._muted or not pcm:
            return PCM_ACCEPTED
        if self._stop.is_set():
            return PCM_TERMINATED
        with self._pcm_mu:
            if len(self._pcm_buf) + self._q_bytes + self._pcm_inflight_bytes + len(pcm) > STT_PCM_BUF_MAX:
                return PCM_BACKPRESSURE
            try:
                self._q.put_nowait(pcm)
            except queue.Full:
                return PCM_BACKPRESSURE
            self._q_bytes += len(pcm)
        return PCM_ACCEPTED

    def drain(self, timeout: float = 120.0) -> bool:
        """Flush queued PCM into AssemblyAI, including a padded short tail. Does not stop.

        Returns True only when the tail is genuinely sent. Returns False quickly
        (well before ``timeout``) when the listener has stopped, the sender has
        exited, or the tail send failed — a failed/stopped drain must not hold the
        calling thread until the full 120 s timeout (issue #165 review P2-5). The
        120 s ceiling remains as the last-resort cap for a healthy slow drain.
        """
        if self._stop.is_set():
            return False
        self._drained.clear()
        self._drain_failed.clear()
        self._drain_send_failed = False
        self._drain.set()
        deadline = time.monotonic() + timeout
        while True:
            if self._drained.is_set():
                return True
            if self._drain_failed.is_set() or self._drain_send_failed:
                return False
            if self._stop.is_set():
                return False
            if self._sender_exited.is_set() and not self._drained.is_set():
                # The sender thread has returned without draining (send error,
                # handoff stop, or a swap that exited it). Do not wait out the cap.
                return False
            left = deadline - time.monotonic()
            if left <= 0:
                return False
            time.sleep(min(0.05, left))

    def take_unsent(self, timeout: float = STT_HANDOFF_JOIN_SEC) -> UnsentHandoff:
        """Stop taking new frames, then harvest `_pcm_buf` (A) then `_q` (B).

        Does not Terminate or close a healthy socket — Pause still needs that
        path. Returns ``blocked`` if the sender has not exited; callers must
        keep this listener and retry rather than treat timeout as silence.
        """
        self._stop.set()
        if not self._join_sender(timeout):
            self._interrupt_socket()
            if not self._join_sender(min(STT_HANDOFF_INTERRUPT_JOIN_SEC, timeout)):
                return UnsentHandoff("blocked")
        pcm = self._harvest_unsent()
        return UnsentHandoff("ready" if pcm else "empty", pcm)

    def seed_unsent(self, pcm: bytes) -> None:
        if not pcm:
            return
        with self._pcm_mu:
            self._pcm_buf.extend(pcm)

    def _join_sender(self, timeout: float) -> bool:
        t = getattr(self, "_sender_thread", None)
        if t is None or t is threading.current_thread():
            return True
        t.join(timeout)
        return not t.is_alive()
    def _interrupt_socket(self) -> None:
        """Bounded force-close to unblock a stuck send. Not a Termination."""
        ws = self._ws
        self._ws = None
        if ws is None:
            return
        sock = getattr(ws, "sock", None)
        if sock is not None:
            try:
                sock.settimeout(0.2)
            except Exception:
                pass
            try:
                sock.close()
            except Exception:
                pass
        try:
            ws.close()
        except Exception:
            pass

    def _harvest_unsent(self) -> bytes:
        with self._pcm_mu:
            out = bytearray(self._pcm_buf)
            self._pcm_buf.clear()
            self._q_bytes = 0
        while True:
            try:
                out.extend(self._q.get_nowait())
            except queue.Empty:
                break
        return bytes(out)

    def start(self) -> None:
        import websocket
        url = assemblyai_ws_url(self.cfg)
        with self._pcm_mu:
            seeded = bytes(self._pcm_buf)
        self._stop.clear()
        self._ready.clear()
        self._terminated.clear()
        self._fail = []
        self._was_ready = False
        self._drop_sent = False
        self._force_pending = False
        self._force_inflight = 0.0
        with self._pcm_mu:
            self._pcm_buf = bytearray(seeded)
            self._q_bytes = 0
        self._last_send_at = 0.0
        self._last_send_bytes = 0
        self._last_send_ms = 0.0
        self._last_send_interval_ms = 0.0
        self._send_count = 0
        self._drain.clear()
        self._drained.clear()
        self._drain_failed.clear()
        self._sender_exited.clear()
        self._drain_send_failed = False
        self._ws = websocket.WebSocketApp(
            url,
            header=[f"Authorization: {self.api_key}"],
            on_open=self._on_open,
            on_message=self._on_message,
            on_error=self._on_ws_error,
            on_close=self._on_close,
        )
        threading.Thread(target=lambda: self._ws.run_forever(ping_interval=20, ping_timeout=10), daemon=True).start()
        if not self._ready.wait(10):
            self.stop()
            raise RuntimeError("AssemblyAI connection timeout — check network and API key")
        if self._fail:
            self.stop()
            raise RuntimeError(self._fail[0])
        self._sender_thread = threading.Thread(target=self._sender, daemon=True)
        self._sender_thread.start()

    def _on_open(self, _ws) -> None:
        self._was_ready = True
        self._ready.set()

    def _notify_drop(self, reason: str) -> None:
        if self._stop.is_set() or not self._was_ready or self._drop_sent:
            return
        self._drop_sent = True
        cb = self.on_drop or self.on_error
        if cb:
            cb(reason)

    def _absorb_queue(self) -> None:
        """Move every queued frame into the dispatch buffer (issue #165 P1).

        The sender calls this at the TOP of every cycle so a large old batch being
        sent never starves acceptance of newer frames. New frames append behind
        the already-buffered ones (old audio always precedes new), and ``_q_bytes``
        is decremented so the byte budget stays accurate.
        """
        with self._pcm_mu:
            while True:
                try:
                    chunk = self._q.get_nowait()
                except queue.Empty:
                    break
                self._q_bytes -= len(chunk)
                self._pcm_buf.extend(chunk)

    def _sender(self) -> None:
        try:
            while not self._stop.is_set():
                self._flush_force_endpoint()
                self._absorb_queue()
                if self._drain.is_set():
                    if not self._drain_send_failed:
                        self._send_drain_tail()
                    else:
                        self._stop.wait(0.05)
                    continue
                ws = self._ws
                if not (ws and getattr(ws, "sock", None) and ws.sock.connected):
                    self._stop.wait(0.05)
                    continue
                if not self._send_buffered_frame(final=False):
                    return
        finally:
            if self._drain.is_set() and not self._drained.is_set():
                self._drain_failed.set()
            self._sender_exited.set()

    def _restore_unsent(self, frames: list[bytes]) -> None:
        if frames:
            with self._pcm_mu:
                self._pcm_buf[0:0] = b"".join(frames)

    def _send_buffered_frame(self, *, final: bool) -> bool:
        # Keep only ONE raw frame in flight. On failure only that frame is
        # returned, ahead of the unsent suffix and any new arrivals. Padding is
        # never placed in the retained recording or its byte budget.
        with self._pcm_mu:
            raw = take_one_frame(self._pcm_buf)
            if not raw and final and self._pcm_buf:
                raw = bytes(self._pcm_buf)
                self._pcm_buf.clear()
            self._pcm_inflight_bytes = len(raw)
        if not raw:
            if not final:
                self._stop.wait(0.08)
            return True
        sent = False
        try:
            self._pace_before_send()
            if self._stop.is_set():
                return False
            frame = raw + b"\x00" * max(0, MIN_CHUNK_BYTES - len(raw))
            sent = self._send_stt_frame(frame, real_bytes=len(raw))
            return sent
        finally:
            with self._pcm_mu:
                if not sent:
                    self._pcm_buf[0:0] = raw
                self._pcm_inflight_bytes = 0

    def _send_drain_tail(self) -> None:
        while not self._stop.is_set():
            self._absorb_queue()
            ws = self._ws
            if not (ws and getattr(ws, "sock", None) and ws.sock.connected):
                break
            with self._pcm_mu:
                if not self._pcm_buf and self._q.empty():
                    self._drained.set()
                    self._drain.clear()
                    self._drain_send_failed = False
                    return
            if not self._send_buffered_frame(final=True):
                break
        self._drain_send_failed = True
        self._drain_failed.set()

    def _send_stt_frame(self, frame: bytes, real_bytes: int | None = None) -> bool:
        import websocket
        ws = self._ws
        if not (ws and ws.sock and ws.sock.connected):
            return False
        try:
            ws.send(frame, websocket.ABNF.OPCODE_BINARY)
            self._record_send(frame)
            real = len(frame) if real_bytes is None else real_bytes
            self._stt_tx_bytes = getattr(self, "_stt_tx_bytes", 0) + real
            cb = self.on_sent
            if cb:
                cb(real)
            return True
        except Exception as e:
            if not self._stop.is_set():
                self._notify_drop(str(e))
            return False

    def _pace_before_send(self) -> None:
        if self._last_send_at <= 0 or self._last_send_bytes <= 0:
            return
        wait = pace_wait_s(duration_s(self._last_send_bytes), time.monotonic() - self._last_send_at)
        deadline = time.monotonic() + wait
        while not self._stop.is_set():
            left = deadline - time.monotonic()
            if left <= 0:
                return
            time.sleep(min(0.05, left))

    def _record_send(self, frame: bytes) -> None:
        now = time.monotonic()
        interval_ms = 0.0 if self._last_send_at <= 0 else (now - self._last_send_at) * 1000.0
        self._last_send_bytes = len(frame)
        self._last_send_ms = duration_ms(self._last_send_bytes)
        self._last_send_interval_ms = interval_ms
        self._last_send_at = now
        self._send_count += 1
        if self._send_count <= 3 or os.environ.get("NOD_STT_TRACE") == "1":
            logging.getLogger("nod").info(
                "stt send n=%s bytes=%s ms=%s interval_ms=%s",
                self._send_count,
                self._last_send_bytes,
                round(self._last_send_ms, 1),
                round(self._last_send_interval_ms, 1),
            )

    def _stt_send_fields(self) -> str:
        return (
            f"chunk_bytes={self._last_send_bytes} chunk_ms={round(self._last_send_ms, 1)} "
            f"interval_ms={round(self._last_send_interval_ms, 1)} sends={self._send_count}"
        )

    def _flush_force_endpoint(self) -> None:
        if not self._force_pending:
            return
        ws = self._ws
        if not (ws and getattr(ws, "sock", None) and ws.sock.connected):
            return
        try:
            ws.send(json.dumps({"type": "ForceEndpoint"}))
        except Exception as e:
            if not self._stop.is_set():
                self._notify_drop(str(e))
            return
        self._force_pending = False
        self._force_inflight = time.time()

    def _force_inflight_armed(self) -> bool:
        if self._force_inflight <= 0:
            return False
        if time.time() - self._force_inflight >= 2.0:
            self._force_inflight = 0.0
            return False
        return True

    def _maybe_queue_translate_cut(self, data: dict[str, Any]) -> None:
        if not self._turn_pacing:
            return
        words = data.get("words") or []
        reason = cut_decision(words, self._turn_pacing, self._force_inflight_armed())
        if reason == "none":
            return
        self._force_pending = True
        open_ms, gap_ms = word_span_ms(words)
        logging.getLogger("nod").info(
            "translate_cut reason=%s open_ms=%s gap_ms=%s words=%s",
            reason,
            open_ms,
            gap_ms,
            len(words),
        )

    def _stt_turn_key(self, data: dict[str, Any]) -> int:
        raw = data.get("turn_order")
        try:
            n = int(raw)
            if n >= 0:
                return n
        except (TypeError, ValueError):
            pass
        self._turn_order += 1
        return self._turn_order

    def _turn_word_meta(self, data: dict[str, Any]) -> dict[str, Any]:
        words = data.get("words") or []
        first_w = words[0] if words else {}
        last_w = words[-1] if words else {}
        return {
            "first_word_ms": (first_w or {}).get("start"),
            "last_word_ms": (last_w or {}).get("end"),
            "n_words": len(words),
        }

    def _note_partial(self, text: str, lang: str | None, speaker: str | None, data: dict[str, Any]) -> None:
        stt_turn = None
        raw = data.get("turn_order")
        try:
            stt_turn = int(raw)
        except (TypeError, ValueError):
            pass
        self._last_partial = {
            "text": text.strip(),
            "lang": lang,
            "speaker": speaker,
            "stt_turn": stt_turn,
            **self._turn_word_meta(data),
        }

    def uncovered_tail(self) -> dict[str, Any] | None:
        p = getattr(self, "_last_partial", None)
        if not p or not (p.get("text") or "").strip():
            return None
        text = str(p["text"]).strip()
        stt = p.get("stt_turn")
        committed = self._committed_turns.get(stt) if stt is not None else None
        if committed:
            if text == committed or committed.startswith(text):
                return None
            if text.startswith(committed) and len(text) <= len(committed):
                return None
            if len(text) <= len(committed):
                return None
        elif text == (self._last_final or ""):
            return None
        return dict(p)

    def _commit_turn_final(
        self,
        text: str,
        lang: str | None,
        speaker: str | None,
        data: dict[str, Any],
        *,
        formatted: bool,
    ) -> None:
        cleaned = text.strip()
        if not cleaned:
            return
        stt_turn = self._stt_turn_key(data)
        prev = self._committed_turns.get(stt_turn)
        if prev == cleaned:
            return
        revision = prev is not None
        self._committed_turns[stt_turn] = cleaned
        self._last_final = cleaned
        self._turn_order = max(self._turn_order, stt_turn)
        meta: dict[str, Any] = {
            **self._turn_word_meta(data),
            "turn_order": stt_turn,
            "stt_turn": stt_turn,
            "listener_id": id(self),
            "revision": revision,
            "formatted": formatted,
            "stop_commit": self._stop.is_set(),
        }
        if self.on_final:
            self.on_final(cleaned, lang, speaker, meta)

    def _on_message(self, _ws, message) -> None:
        try:
            data = json.loads(message)
        except (TypeError, json.JSONDecodeError):
            return
        kind = data.get("type")
        if kind == "Turn":
            if data.get("end_of_turn"):
                self._force_inflight = 0.0
            else:
                self._maybe_queue_translate_cut(data)
            text = (data.get("utterance") or data.get("transcript") or "").strip()
            if not text:
                return
            speechy = bool(re.search(r"[A-Za-z0-9\u00C0-\u024F\u4e00-\u9fff\u3040-\u30FF\uac00-\ud7af]", text))
            lang = heard_lang_from_turn(data)
            speaker = speaker_from_turn(data)
            if speechy:
                self._note_partial(text, lang, speaker, data)
            if data.get("end_of_turn"):
                if data.get("turn_is_formatted") is False:
                    if self._stop.is_set():
                        self._commit_turn_final(text, lang, speaker, data, formatted=False)
                    elif speechy and self.on_partial:
                        self.on_partial(text, lang, speaker)
                    return
                cleaned = text.strip()
                self._commit_turn_final(text, lang, speaker, data, formatted=True)
                if os.environ.get("NOD_STT_TRACE") == "1":
                    # Instrument turn boundaries for the "English line every 10s /
                    # half-sentence cut" investigation (issue #22). Logging only.
                    words = data.get("words") or []
                    word_speakers: dict[str, int] = {}
                    for w in words:
                        sp = str((w or {}).get("speaker") or "").strip()
                        if sp:
                            word_speakers[sp] = word_speakers.get(sp, 0) + 1
                    first_w = words[0] if words else {}
                    last_w = words[-1] if words else {}
                    logging.getLogger("nod").info(
                        "stt turn_order=%s end_of_turn_confidence=%s words=%s first_word_ms=%s last_word_ms=%s "
                        "language_code=%s speakers=%s text_len=%s text_sha=%s",
                        self._turn_order,
                        data.get("end_of_turn_confidence"),
                        len(words),
                        (first_w or {}).get("start"),
                        (last_w or {}).get("end"),
                        data.get("language_code") or lang,
                        word_speakers,
                        len(cleaned or text),
                        hashlib.sha1((cleaned or text).encode("utf-8", "ignore")).hexdigest()[:8],
                    )
            elif speechy and self.on_partial:
                self.on_partial(text, lang, speaker)
        elif kind == "Termination":
            self._terminated.set()
            log = logging.getLogger("nod")
            log.info(
                "assemblyai session ended session_s=%s audio_s=%s",
                data.get("session_duration_seconds"),
                data.get("audio_duration_seconds"),
            )
        elif kind == "Error":
            code, err_text = error_summary(data if isinstance(data, dict) else {})
            err = f"{code} {err_text}".strip() if code is not None else (err_text or str(message))
            logging.getLogger("nod").warning(
                "assemblyai error code=%s error=%s %s",
                code if code is not None else "",
                (err_text or "")[:500],
                self._stt_send_fields(),
            )
            self._terminated.set()
            if self._stop.is_set():
                logging.getLogger("nod").info("assemblyai error ignored during stop")
                return
            if self.on_error:
                self.on_error(err)
            self._notify_drop(err)
        elif kind == "SpeakerRevision":
            # Speaker reassignment is a #13 concern (turn-level merge); record the
            # revision only for trace (issue #31 §2.5). Never logs text.
            if os.environ.get("NOD_STT_TRACE") == "1":
                turns = data.get("turns") or []
                logging.getLogger("nod").info(
                    "stt speaker_revision turns=%s labels=%s",
                    len(turns),
                    len(data.get("labels") or {}),
                )

    def _on_ws_error(self, _ws, error) -> None:
        self._fail.append(str(error))
        self._ready.set()
        self._terminated.set()
        if self._stop.is_set():
            return
        if not self._was_ready and self.on_error:
            self.on_error(str(error))
            return
        self._notify_drop(str(error))

    def _on_close(self, _ws, status, msg) -> None:
        self._terminated.set()
        extra = f"{status or ''} {msg or ''}".strip()
        try:
            status_n = int(status) if status is not None else 0
        except (TypeError, ValueError):
            status_n = 0
        if status_n >= 3000 or (not self._stop.is_set() and extra):
            logging.getLogger("nod").warning(
                "assemblyai close status=%s reason=%s %s",
                status if status is not None else "",
                (str(msg or ""))[:200],
                self._stt_send_fields(),
            )
        if self._stop.is_set():
            return
        if not self._ready.is_set():
            self._fail.append(f"AssemblyAI connection closed {extra}".strip())
            self._ready.set()
            return
        self._notify_drop(extra or "session closed")

    def stop(self, *, force_endpoint: bool = False) -> None:
        self._stop.set()
        self._force_pending = False
        self._force_inflight = 0.0
        ws = self._ws
        if force_endpoint and ws is not None:
            try:
                sock = getattr(ws, "sock", None)
                if sock is not None and getattr(sock, "connected", False):
                    ws.send(json.dumps({"type": "ForceEndpoint"}))
            except Exception:
                pass
        self._ws = None
        if ws:
            _terminate_assemblyai_session(ws, self._terminated)


class Session:
    def __init__(self, emit: Callable[[dict], None], cfg: dict[str, Any], keys: dict[str, str], user_id: str | None = None):
        self.emit = emit
        self.cfg = cfg
        self.pipeline = Pipeline(cfg, keys, emit)
        self.user_id = user_id
        self.pipeline.user_id = user_id
        self.usage_session_id: str | None = None
        self._pcm_unmetered = 0
        self._listener: CloudListener | None = None
        self._handoff_listener: CloudListener | None = None
        self._handoff_blocked = False
        self._handoff_collected = False
        self._handoff_waiter: threading.Thread | None = None
        self._stt_pending_pcm = b""
        self._pcm_hold = bytearray()

        self._pcm_in_lock = threading.Lock()
        self._listen_gen = 0
        self._stt_stream_gen = 0
        self._pcm_rx_bytes = 0
        self._stt_tx_bytes = 0
        self._listen_mu = threading.RLock()
        self._listen_starting = False
        self._stt_restart_timer: threading.Timer | None = None
        self._manual_buf = bytearray()
        self._manual = False
        self._manual_started = 0.0
        self._manual_last_voice = 0.0
        self._manual_offset = 0
        self._manual_jobs = 0
        self._manual_lock = threading.Lock()
        self._busy = False
        # Finals arrive on the STT thread while dispatch runs on a worker, so
        # the busy flag has to be claimed atomically or two generations start
        # for one question and both get billed.
        self._busy_lock = threading.Lock()
        self._busy_token: object | None = None
        self._pending_q: collections.deque[tuple[str, str | None]] = collections.deque(maxlen=8)
        self._pending_asks: list[tuple[str, str, Any]] = []
        self._pending_wait: tuple[str | None, float, str | None] = (None, 0.0, None)
        self._meeting_flush_timer: threading.Timer | None = None
        self._interview_wait_timer: threading.Timer | None = None
        self._meeting_lock = threading.Lock()
        self._interview_lock = threading.Lock()
        # Meeting "incomplete-sentence continuation" (issue #29): the currently-open
        # transcript line that a later final may extend.
        self._open_line: dict[str, Any] | None = None
        self._meeting_gen = 0
        self._meeting_finals: queue.Queue[tuple[int, int, str, str | None, str | None, dict[str, Any] | None]] = queue.Queue()
        self._meeting_worker_started = False
        self._meeting_worker_thread: threading.Thread | None = None
        self._pending_meta: dict[str, Any] | None = None
        self._final_seq = 0
        self._follow_lang: str | None = None
        self._follow_switch_lang: str | None = None
        self._follow_switch_hits = 0
        self._recent_finals: list[tuple[str, float]] = []
        self._translate_carry = ""
        self._mic_muted = False
        self._workspace = "interview"
        self._pending_speaker: str | None = None
        self._stt_drops = 0
        self._stt_drop_at = 0.0
        self._listen_wanted = False
        self._listen_started_at = 0.0
        self._listen_accum_sec = 0.0
        self._listen_ended = False
        self._stt_line_by_turn: dict[tuple[Any, Any], str] = {}
        self._stop_flushing = False
        self._listen_flush_done = False
        self._listen_flush_seq = 0
        self._listen_flush_history_ok = True
        self._listen_flush_client_id: str | None = None
        self._last_pcm_at = 0.0
        self._last_voice_at = 0.0
        self._idle_check_at = 0.0
        self._listen_mic = "phone"
        self._archive_fp = None
        self._archive_path: str | None = None
        self._archive_bytes = 0
        self._archive_total = 0
        self._archive_part = 1
        self._consent_ok: bool | None = None
        # Two-axis state (ADR 0001): capture is the single source of truth for
        # the mic/session (off/listening/recording/paused); engine reflects the
        # STT/LLM axis (idle/transcribing/generating). Old `state` events still
        # ship for backward compatibility, then a `phase` event pairs them.
        self._paused = False
        self._engine = "idle"
        self.audio_token = secrets.token_urlsafe(24)
        self._uplink_connected = False
        self._control_lost_at = 0.0
        self._uplink_lost_at = 0.0
        self._audio_ws = None
        self._closed = False
        self._loop: asyncio.AbstractEventLoop | None = None

    def _archive_prefix(self) -> str:
        return f"users/{self.user_id}/sessions/{self.usage_session_id}/audio/"

    def _archive_open_part(self) -> None:
        if self._archive_fp is not None:
            return
        fd, path = tempfile.mkstemp(prefix="nod-pcm-", suffix=".pcm")
        self._archive_path = path
        self._archive_fp = os.fdopen(fd, "wb")
        self._archive_bytes = 0

    def _has_consent(self) -> bool:
        if not self.user_id:
            return True
        if self._consent_ok is True:
            return True
        from server.meter import has_recording_consent

        self._consent_ok = has_recording_consent(self.user_id)
        return self._consent_ok

    def _ensure_consent(self) -> bool:
        if self._has_consent():
            return True
        self.emit({"type": "error", "text": "Recording consent is required before listening."})
        self.emit({"type": "status", "text": "Consent required"})
        return False

    def _archive_append(self, pcm: bytes) -> None:
        from server.r2 import MAX_AUDIO_BYTES, PART_BYTES, enabled

        if not enabled() or not self.user_id or not pcm:
            return
        if not self._has_consent():
            return
        offset = 0
        while offset < len(pcm) and self._archive_total < MAX_AUDIO_BYTES:
            self._archive_open_part()
            if not self._archive_fp:
                return
            room = min(PART_BYTES - self._archive_bytes, MAX_AUDIO_BYTES - self._archive_total, len(pcm) - offset)
            if room <= 0:
                self._archive_rotate()
                continue
            take = pcm[offset : offset + room]
            self._archive_fp.write(take)
            self._archive_bytes += len(take)
            self._archive_total += len(take)
            offset += len(take)
            if self._archive_bytes >= PART_BYTES:
                self._archive_rotate()

    def _upload_current_part(self) -> bool:
        from server.r2 import pcm_to_wav, put_bytes
        from server.meter import set_session_file

        path = self._archive_path
        if not path or not self.user_id or not self.usage_session_id or self._archive_bytes <= SR * 2:
            return True
        if self._archive_fp:
            try:
                self._archive_fp.flush()
            except Exception:
                pass
        wav = pcm_to_wav(Path(path).read_bytes())
        prefix = self._archive_prefix()
        key = f"{prefix}part-{self._archive_part:03d}.wav"
        if put_bytes(key, wav, "audio/wav"):
            set_session_file(self.usage_session_id, audio_key=prefix)
            return True
        return False

    def _archive_rotate(self) -> None:
        uploaded = False
        try:
            uploaded = self._upload_current_part()
        except Exception:
            logging.getLogger("nod").exception("r2 audio part upload failed")
        self._archive_close(unlink=uploaded)
        self._archive_part += 1

    def _flush_cloud_archive(self, final: bool = False) -> None:
        from server.r2 import enabled

        if not enabled() or not self.user_id or not self.usage_session_id:
            if final:
                self._archive_close(unlink=True)
            return
        uploaded = False
        try:
            uploaded = self._upload_current_part()
        except Exception:
            logging.getLogger("nod").exception("r2 audio upload failed")
        try:
            from server.meter import write_session_notes

            write_session_notes(self.user_id, self.usage_session_id)
        except Exception:
            logging.getLogger("nod").exception("r2 notes upload failed")
        if final:
            self._archive_close(unlink=uploaded)

    def _archive_close(self, unlink: bool = False) -> None:
        if self._archive_fp:
            try:
                self._archive_fp.close()
            except Exception:
                pass
            self._archive_fp = None
        path = self._archive_path
        self._archive_path = None
        self._archive_bytes = 0
        if unlink and path:
            try:
                os.unlink(path)
            except OSError:
                pass

    def start(self) -> None:
        st = self.pipeline.key_status()
        self.emit({"type": "keys_status", "has_llm": st["has_llm"], "has_stt": st["has_stt"]})
        self.emit({"type": "ready"})
        # Reconnecting clients get their first two-axis frame right after ready
        # so they can render from `capture`.
        self._emit_phase()
        self.emit({"type": "status", "text": STATUS_READY})
        token = getattr(self, "audio_token", None)
        if token:
            self.emit({"type": "audio_uplink", "token": token})

    def reattach(self) -> None:
        st = self.pipeline.key_status()
        self.emit({"type": "keys_status", "has_llm": st["has_llm"], "has_stt": st["has_stt"]})
        self.emit({"type": "ready"})
        self.emit({"type": "attached", "usage_session_id": self.usage_session_id})
        self._emit_phase()
        token = getattr(self, "audio_token", None)
        if token:
            self.emit({"type": "audio_uplink", "token": token})
        drained = getattr(self, "_pcm_drain_result", None)
        if isinstance(drained, dict) and drained.get("type") == "pcm_drained":
            self.emit(drained)
        # A session that dropped audio (overflow) must re-announce the failure to a
        # reconnecting client — reattach only re-sends the drain-success otherwise.
        if getattr(self, "_pcm_stall_reported", False):
            self.emit({"type": "error", "text": "Recording buffer full — audio may be incomplete."})

        self._replay_pcm_rejection()

    def _replay_pcm_rejection(self) -> None:
        event = getattr(self, "_pcm_reject_result", None)
        if isinstance(event, dict):
            self.emit({"type": "error", "text": event.get("text", "Upload incomplete")})
            self.emit(event)
            self._send_audio_text(event)

    def _sink_emit(self, _obj: dict) -> None:
        return

    def _detach_control_emit(self) -> None:
        self.emit = self._sink_emit
        pipeline = getattr(self, "pipeline", None)
        if pipeline is not None:
            pipeline.emit = self._sink_emit

    def _close_audio_uplink(self) -> None:
        ws = getattr(self, "_audio_ws", None)
        self._audio_ws = None
        self._uplink_connected = False
        if ws is None:
            return

        async def _close() -> None:
            try:
                await ws.close()
            except Exception:
                pass

        loop = getattr(self, "_loop", None)
        if loop is not None:
            try:
                if loop.is_running():
                    asyncio.run_coroutine_threadsafe(_close(), loop)
            except Exception:
                pass

    def close(self) -> None:
        self._closed = True
        self._detach_control_emit()
        self._close_audio_uplink()
        uplink.unregister(getattr(self, "audio_token", None))
        self._listen_wanted = False
        self._stop_listening()
        self.pipeline.abort_stream()
        self._flush_cloud_archive(final=True)
        if self.usage_session_id:
            from server.meter import close_usage_session, discard_usage_session, is_session_kept, session_has_history

            if self.user_id and not is_session_kept(self.usage_session_id):
                # A meeting session that already produced content is recoverable:
                # keep the row around with kept=False so the next connect can
                # re-offer "Save this session to History?" instead of silently
                # throwing it away on a disconnect. Only meetings with HistoryItems
                # qualify; anything else is discarded as before.
                if getattr(self, "_workspace", "") == "meeting" and session_has_history(self.usage_session_id):
                    close_usage_session(self.usage_session_id)
                else:
                    discard_usage_session(self.user_id, self.usage_session_id)
            else:
                close_usage_session(self.usage_session_id)
            self.usage_session_id = None
            self.pipeline.usage_session_id = None

    def _quota_block(self, snap: dict) -> None:
        logging.getLogger("nod").warning(
            "quota_exceeded user=%s reason=%s sessions=%s/%s daily_cost=%s global_cost=%s",
            self.user_id, snap.get("reason"), snap.get("sessions"), snap.get("session_limit"),
            snap.get("daily_cost_usd"), snap.get("global_cost_usd"),
        )
        self.emit({"type": "quota", **snap})
        self.emit({"type": "quota_exceeded", "reason": snap.get("reason") or "limit"})
        self.emit({"type": "error", "text": _quota_copy(snap)})
        self.emit({"type": "status", "text": _quota_copy(snap)})

    def _ensure_usage(self) -> bool:
        if getattr(self, "_closed", False):
            return False
        if not self.user_id:
            return True
        if not self._ensure_consent():
            return False
        from server.meter import open_usage_session, usage_snapshot

        if self.usage_session_id:
            snap = usage_snapshot(self.user_id)
            self.emit({"type": "quota", **snap})
            if not snap.get("ok"):
                self._quota_block(snap)
                return False
            return True
        scene = str((self.cfg.get("stt") or {}).get("listen_scene") or "")
        sid, snap = open_usage_session(self.user_id, self._workspace, scene)
        self.emit({"type": "quota", **snap})
        if not sid:
            self._quota_block(snap)
            return False
        self.usage_session_id = sid
        self.pipeline.usage_session_id = sid
        return True

    def push_pcm(self, pcm: bytes) -> None:
        if not pcm:
            return
        if getattr(self, "_closed", False):
            return
        if self._listener:
            # ANY byte (even silence, even while muted or consent-blocked) proves the
            # client is alive and streaming — refresh the zero-PCM clock BEFORE the
            # mute/consent gates. Mute is server-side (the client keeps streaming and
            # set_mic_muted keeps the socket up), so a muted session must never read as
            # 'no microphone'. Refreshing under the consent gate too is harmless: no
            # consent means no real listening, so the socket holds only briefly.
            self._last_pcm_at = time.time()
        if self._mic_muted:
            return
        if self.user_id and not self._has_consent():
            return
        if self.user_id:
            self._pcm_unmetered += len(pcm)
            if self._pcm_unmetered >= 16000:
                seconds = self._pcm_unmetered / float(SR * 2)
                self._pcm_unmetered = 0
                if not self._ensure_usage():
                    return
                from server.meter import consume_stt

                ok, snap = consume_stt(self.user_id, seconds, self.usage_session_id)
                self.emit({"type": "quota", **snap})
                if not ok:
                    self._quota_block(snap)
                    if self._listener:
                        self._listen_wanted = False
                        self._stop_listening()
                        self._offer_save_history()
                    if self._manual:
                        self._stop_manual()
                    return
        if self._manual:
            self._manual_buf.extend(pcm)
            self._archive_append(pcm)
            now = time.time()
            if _pcm_has_voice(pcm):
                self._manual_last_voice = now
            started = self._manual_started or now
            last = self._manual_last_voice or started
            if now - started >= MANUAL_MAX_SEC or now - last >= LISTEN_IDLE_SECONDS:
                self._stop_manual()
            else:
                self._maybe_flush_manual_chunk()
            return
        if not self._deliver_pcm(pcm):
            return
        # A terminated session (closed / listen stolen / stopped) still streaming
        # audio is rejected ONCE with its identity, so the Watch's trailing frames
        # end the drain wait instead of silently disappearing into a dead session
        # (issue #165 P2-8). Single-shot; the latch resets on a fresh listen.
        if self._session_terminated():
            if not getattr(self, "_pcm_reject_sent", False):
                self._pcm_reject_sent = True
                self._reject_pcm_ended(
                    str(getattr(self, "usage_session_id", "") or ""),
                    str(getattr(self, "_pcm_end_capture", "") or ""),
                    "session_ended",
                )
            return
        # NOTE: _pcm_stall_reported is deliberately NOT reset here. Once a session
        # drops audio under hold overflow, it is "incomplete" for its whole lifetime;
        # a later successful frame must not re-arm the End drain or hide the failure.
        # It is cleared only when a fresh listen session opens (resume=False).
        self._finish_pcm_end_if_ready()
        self._maybe_stop_forgotten_listen()

    def _deliver_pcm(self, pcm: bytes) -> bool:
        """Deliver one PCM frame to the live listener or hold it, atomically with
        the listener-handoff switch.

        Routing and enqueue are coordinated (issue #165 fable #1): the destination
        is read and written under _pcm_input_lock (which _open_listener also uses
        for the hold flush) AND _listen_lock (under which _restart_listener and
        _open_listener swap _listener). A listener installed mid-hold is picked up
        and the frame is pushed to it instead of being dropped; a listener that was
        swapped out is never written to. Returns True when the frame is accounted
        for (delivered or held) and False only when it cannot be kept — which is
        surfaced, not silently dropped (fable #3).
        """
        with self._pcm_input_lock():
            with self._listen_lock():
                lst = getattr(self, "_listener", None)
                if lst is not None:
                    if not self._flush_pcm_hold_into(lst):
                        # Retain behind the older hold where budget permits;
                        # never let this smaller new frame overtake it.
                        hold = getattr(self, "_pcm_hold", bytearray())
                        if len(hold) + len(pcm) <= STT_PCM_HOLD_MAX:
                            hold.extend(pcm)
                            self._pcm_hold = hold
                            self._pcm_rx_bytes = getattr(self, "_pcm_rx_bytes", 0) + len(pcm)
                        self._archive_append(pcm)
                        return False
                    res = lst.push_pcm(pcm)
                    if res != PCM_ACCEPTED:
                        # The listener cannot reliably keep this byte. Keep the
                        # original (archive already preserves it) and surface the
                        # failure; never count the frame as success (issue #165 P1).
                        self._archive_append(pcm)
                        self._report_pcm_stalled()
                        return False
                    self._last_pcm_at = time.time()
                    self._archive_append(pcm)
                    self._pcm_rx_bytes = getattr(self, "_pcm_rx_bytes", 0) + len(pcm)
                    return True
                if self._hold_incoming_pcm(pcm):
                    return True
                # The hold refused. Either a listener appeared in the instant
                # between the destination read and the hold attempt (re-route, do
                # not drop), or there genuinely is no live listener to receive it.
                lst = getattr(self, "_listener", None)
                if lst is not None:
                    if not self._flush_pcm_hold_into(lst):
                        # Retain behind the older hold where budget permits;
                        # never let this smaller new frame overtake it.
                        hold = getattr(self, "_pcm_hold", bytearray())
                        if len(hold) + len(pcm) <= STT_PCM_HOLD_MAX:
                            hold.extend(pcm)
                            self._pcm_hold = hold
                            self._pcm_rx_bytes = getattr(self, "_pcm_rx_bytes", 0) + len(pcm)
                        self._archive_append(pcm)
                        return False
                    res = lst.push_pcm(pcm)
                    if res != PCM_ACCEPTED:
                        self._archive_append(pcm)
                        self._report_pcm_stalled()
                        return False
                    self._last_pcm_at = time.time()
                    self._archive_append(pcm)
                    self._pcm_rx_bytes = getattr(self, "_pcm_rx_bytes", 0) + len(pcm)
                    return True
            # No listener and the hold is full. A paused/closed session, or one no
            # longer wanting to listen, legitimately discards stray frames; only a
            # session that IS still listening but has run out of hold capacity gets
            # the explicit stall (fable #3).
            if (
                getattr(self, "_paused", False)
                or getattr(self, "_closed", False)
                or not getattr(self, "_listen_wanted", False)
            ):
                return True
            # Keep the overflow frame in the recording archive so the audio is not
            # lost even though the live STT rail can no longer hold it (原片保留).
            self._archive_append(pcm)
            self._report_pcm_stalled()
            return False

    def dispatch(self, msg: dict) -> None:
        mtype = msg.get("type")
        if mtype == "manual":
            self.manual()
        elif mtype == "toggle_listen":
            self.toggle_listen()
        elif mtype == "start_listen":
            self.start_listen(mic=msg.get("mic"))
        elif mtype == "pcm_end":
            self.pcm_end(msg.get("id"), msg.get("byte_offset"), msg.get("capture_id") or msg.get("captureId"))
        elif mtype == "stop_listen":
            self.stop_listen(flush_id=msg.get("flush_id"))
        elif mtype == "pause_listen":
            self.pause_listen()
        elif mtype == "resume_listen":
            self.resume_listen()
        elif mtype == "keep_history":
            self.keep_history(
                content=msg.get("content", True), audio=msg.get("audio", True),
                session_id=msg.get("id"),
            )
        elif mtype == "discard_history":
            self.discard_history(session_id=msg.get("id"))
        elif mtype == "ask":
            files = msg.get("files")
            if not files:
                files = take_attach_files(str(msg.get("attach_id") or ""))
            self.ask(msg.get("text", ""), files, msg.get("mode") or "ask")
        elif mtype == "set_workspace":
            self.set_workspace(msg.get("mode") or "interview", msg.get("scene"), msg.get("speakers_expected"))
        elif mtype == "set_llm":
            self.set_llm(msg.get("provider", "deepseek"), msg.get("model", ""))
        elif mtype == "set_lang":
            lang = _normalize_stt_lang(msg.get("language"))
            prev = self._effective_stt_lang()
            self.cfg.setdefault("stt", {})["language"] = lang
            self._follow_lang = None
            self._follow_switch_lang = None
            self._follow_switch_hits = 0
            if lang:
                self.emit({"type": "status", "text": f"Speech recognition · {_LANG_NAMES.get(lang, lang)} only"})
            else:
                self.emit({"type": "status", "text": "Speech recognition · Auto · follows the language you speak"})
            if self._workspace != "translate" and self._listener and prev != lang:
                self._restart_listener()
        elif mtype == "set_translate_from":
            self.set_translate_from(msg.get("language"))
        elif mtype == "set_mic_muted":
            self.set_mic_muted(bool(msg.get("muted", False)))
        elif mtype == "set_source":
            self.emit({"type": "status", "text": "Web uses browser microphone (cloud STT)"})
        elif mtype == "save_keys":
            self.save_keys(msg.get("deepseek_key", ""), msg.get("assemblyai_key", ""))
        elif mtype == "clear":
            self.cancel_generate()
            self._reset_turn_state()
            self.pipeline._qa_history = []
            self.pipeline._last_answer = ""
            self._recent_finals = []
            self.emit({"type": "status", "text": "Cleared"})
        elif mtype == "cancel_generate":
            self.cancel_generate()
        elif mtype == "set_translate_to":
            self.set_translate_to(msg.get("lang") or "zh")
        elif mtype == "ping":
            self.emit({"type": "pong"})
        elif mtype == "auth":
            return
        else:
            self.emit({"type": "error", "text": f"Unknown command: {mtype}"})

    def save_keys(self, deepseek_key="", assemblyai_key="") -> None:
        updates = {}
        if isinstance(deepseek_key, str) and deepseek_key.strip():
            updates["DEEPSEEK_API_KEY"] = deepseek_key.strip()
        if isinstance(assemblyai_key, str) and assemblyai_key.strip():
            updates["ASSEMBLYAI_API_KEY"] = assemblyai_key.strip()
        if not updates:
            self.emit({"type": "error", "text": "Please paste at least one key"})
            return
        self.pipeline.set_keys(updates)
        st = self.pipeline.key_status()
        self.emit({"type": "keys_status", "has_llm": st["has_llm"], "has_stt": st["has_stt"]})
        self.emit({"type": "status", "text": "API keys saved — ready to go"})

    def _claim_busy(self) -> object | None:
        with self._busy_lock:
            if self._busy:
                return None
            self._busy = True
            self._busy_token = object()
            return self._busy_token

    def _release_busy(self, token: object | None) -> None:
        with self._busy_lock:
            if self._busy_token is token:
                self._busy = False
                self._busy_token = None

    def cancel_generate(self) -> None:
        """Cancel the in-flight LLM stream without stopping STT."""
        self.pipeline.abort_stream()
        self._pending_asks = []
        self._pending_q.clear()
        with self._busy_lock:
            self._busy = False
            self._busy_token = None
        self._set_engine("idle")
        self._emit_phase()

    def set_translate_to(self, lang: str) -> None:
        self.cfg.setdefault("ui", {})["translate_to"] = _normalize_translate_to(lang)

    def set_translate_from(self, lang: Any) -> None:
        prev = self._effective_stt_lang()
        locked = _normalize_translate_from(lang)
        self.cfg.setdefault("ui", {})["translate_from"] = locked or "auto"
        if self._workspace == "translate" and self._listener and prev != locked:
            self._restart_listener()

    def _effective_stt_lang(self, workspace: str | None = None) -> str | None:
        ws = self._workspace if workspace is None else workspace
        if ws == "translate":
            return _normalize_translate_from((self.cfg.get("ui") or {}).get("translate_from"))
        return _normalize_stt_lang((self.cfg.get("stt") or {}).get("language"))

    def _stt_cfg(self) -> dict[str, Any]:
        cfg = dict(self.cfg)
        stt = dict(cfg.get("stt") or {})
        stt["language"] = self._effective_stt_lang()
        stt["auto_langs"] = list(_TRANSLATE_LANGS if self._workspace == "translate" else _STT_AUTO_LANGS)
        scene = str(stt.get("listen_scene") or "").strip().lower()
        if scene not in ("meeting", "lecture", "interview"):
            scene = "interview" if self._workspace == "interview" else "meeting"
        # Translate inherits the last listen scene from the UI. Interview
        # Q&A prompt would bias captions toward English interview turns.
        if self._workspace == "translate" and scene == "interview":
            scene = "meeting"
        stt["listen_scene"] = scene
        if self._workspace == "meeting":
            stt["max_turn_silence"] = "1200"
            stt["speaker_labels"] = True
            if not stt.get("speakers_expected"):
                stt["speakers_expected"] = 4 if scene == "lecture" else 2
        else:
            stt["speaker_labels"] = False
        if self._workspace == "translate":
            stt["turn_pacing"] = turn_pacing_from_env()
        recent = [t for t, _ in self._recent_finals[-6:]]
        stt["context_terms"] = _stt_context_terms(recent)
        stt["context_prompt"] = _stt_context_prompt(recent[-3:])
        cfg["stt"] = stt
        return cfg

    def _listen_lock(self) -> threading.RLock:
        mu = getattr(self, "_listen_mu", None)
        if mu is None:
            mu = threading.RLock()
            self._listen_mu = mu
        return mu

    def _stt_slot(self) -> str:
        return _stt_owner_slot(getattr(self, "user_id", None), getattr(self, "_workspace", None), id(self))

    def _claim_listen_start(self, resume: bool = False) -> bool:
        with self._listen_lock():
            if getattr(self, "_listen_starting", False):
                return False
            if getattr(self, "_handoff_blocked", False):
                return False
            if self._listener is not None and not resume:
                return False
            self._listen_starting = True
            return True

    def _release_listen_start(self) -> None:
        with self._listen_lock():
            self._listen_starting = False

    def _cancel_stt_restart_timer(self) -> None:
        timer = getattr(self, "_stt_restart_timer", None)
        self._stt_restart_timer = None
        if timer:
            try:
                timer.cancel()
            except Exception:
                pass

    def _stop_listener(self, lst: CloudListener | None, *, force_endpoint: bool = False) -> None:
        if not lst:
            return
        _drop_live_stt(self._stt_slot(), lst)
        try:
            lst.stop(force_endpoint=force_endpoint)
        except TypeError:
            lst.stop()
        except Exception:
            pass

    def _pcm_input_lock(self) -> threading.Lock:
        mu = getattr(self, "_pcm_in_lock", None)
        if mu is None:
            mu = threading.Lock()
            self._pcm_in_lock = mu
        return mu

    def _hold_incoming_pcm(self, pcm: bytes) -> bool:
        if getattr(self, "_closed", False) or self._paused or not self._listen_wanted:
            return False
        if self._listener is not None:
            return False
        with self._listen_lock():
            if self._listener is not None:
                return False
            hold = getattr(self, "_pcm_hold", None)
            if not isinstance(hold, bytearray):
                hold = bytearray()
            if len(hold) + len(pcm) > STT_PCM_HOLD_MAX:
                logging.getLogger("nod").warning("stt pcm hold full bytes=%s", len(hold))
                return False
            hold.extend(pcm)
            self._pcm_hold = hold
            self._last_pcm_at = time.time()
            self._pcm_rx_bytes = getattr(self, "_pcm_rx_bytes", 0) + len(pcm)
        self._archive_append(pcm)
        return True

    def _report_pcm_stalled(self) -> None:
        """Surface a hold overflow instead of silently dropping audio.

        When the 2 MiB hold is full and there is no live listener, the incoming
        frame cannot be kept (the phone cursor has advanced, so Retry will not
        resend it). Report it once so the user sees the gap rather than a silent
        transcript hole; the recorded archive still holds the bytes already
        consumed (fable #3).
        """
        if getattr(self, "_pcm_stall_reported", False):
            return
        self._pcm_stall_reported = True
        logging.getLogger("nod").warning("stt pcm hold overflow: audio rail stalled")
        text = "Recording buffer full — audio may be incomplete."
        # Control channel: a generic error the web/phone control renderer already
        # understands (may be a no-op sink while the control emit is parked).
        self.emit({"type": "error", "text": text})
        # Native-reachable path: carry session identity so the iOS AudioUplink can
        # route it to the Watch. The iOS side only parses pcm_drained today, so this
        # frame is a distinct pcm_stall type the native receiver adopts.
        self._send_audio_text({
            "type": "pcm_stall",
            "id": getattr(self, "usage_session_id", "") or "",
            "text": text,
        })

    def _flush_pcm_hold_into(self, lst: CloudListener) -> bool:
        with self._listen_lock():
            hold = bytes(getattr(self, "_pcm_hold", b"") or b"")
            self._pcm_hold = bytearray()
        if hold:
            res = lst.push_pcm(hold)
            if res != PCM_ACCEPTED:
                # The listener's byte budget is exhausted; move the held bytes
                # back into the hold so they are not silently lost (issue #165 P1).
                with self._listen_lock():
                    self._pcm_hold = bytearray(hold) + bytearray(getattr(self, "_pcm_hold", b"") or b"")
                self._report_pcm_stalled()
                return False
        return True

    def _normalize_handoff(self, extra: Any) -> UnsentHandoff:
        if isinstance(extra, UnsentHandoff):
            return extra
        if extra is None:
            return UnsentHandoff("blocked")
        if isinstance(extra, (bytes, bytearray)):
            pcm = bytes(extra)
            return UnsentHandoff("ready" if pcm else "empty", pcm)
        return UnsentHandoff("empty")

    def _apply_handoff(self, result: UnsentHandoff) -> None:
        if result.kind == "blocked" or not result.pcm:
            return
        prev = getattr(self, "_stt_pending_pcm", b"") or b""
        if not isinstance(prev, (bytes, bytearray)):
            prev = b""
        self._stt_pending_pcm = bytes(prev) + result.pcm

    def _stash_unsent(self, lst: CloudListener | None) -> UnsentHandoff:
        if not lst:
            return UnsentHandoff("empty")
        take = getattr(lst, "take_unsent", None)
        if not callable(take):
            return UnsentHandoff("empty")
        result = self._normalize_handoff(take())
        if result.kind == "blocked":
            return result
        self._apply_handoff(result)
        return result

    def _clear_handoff(self) -> None:
        self._handoff_listener = None
        self._handoff_blocked = False
        self._handoff_collected = False
        self._handoff_waiter = None

    def _abandon_handoff(self, *, bump_gen: bool = True) -> None:
        if bump_gen:
            self._listen_gen = getattr(self, "_listen_gen", 0) + 1
        lst = getattr(self, "_handoff_listener", None)
        self._clear_handoff()
        self._stt_pending_pcm = b""
        self._pcm_hold = bytearray()
        if lst is not None and lst is not self._listener:
            self._stop_listener(lst)

    def _mark_handoff_blocked(self, lst: CloudListener) -> None:
        self._handoff_blocked = True
        self._handoff_listener = lst
        logging.getLogger("nod").warning("stt handoff blocked")
        existing = getattr(self, "_handoff_waiter", None)
        if existing is not None and existing.is_alive():
            return
        gen = getattr(self, "_listen_gen", 0)

        def wait() -> None:
            t = getattr(lst, "_sender_thread", None)
            if t is not None and t is not threading.current_thread():
                t.join()
            if getattr(self, "_closed", False):
                return
            if getattr(self, "_listen_gen", 0) != gen:
                return
            self._complete_blocked_handoff(lst)

        th = threading.Thread(target=wait, name="nod-stt-handoff", daemon=True)
        self._handoff_waiter = th
        th.start()

    def _claim_handoff_collect(self, lst: CloudListener) -> bool:
        """Atomically claim the right to finish one handoff.

        A handoff may be completed by more than one path (the auto-recovery waiter
        after a blocked sender, and a Retry/pcm_end). Exactly ONE may collect the
        unsent PCM and start the replacement listener; any other path must only read
        the result (fable #2). The claim is a short critical section on _listen_lock.
        """
        with self._listen_lock():
            if getattr(self, "_handoff_listener", None) is not lst:
                return False
            if getattr(self, "_handoff_collected", False):
                return False
            self._handoff_collected = True
            return True

    def _release_handoff_collect(self, lst: CloudListener) -> None:
        """Undo a claim that turned out to be a blocked probe (nothing collected)."""
        with self._listen_lock():
            if getattr(self, "_handoff_listener", None) is not lst:
                return
            self._handoff_collected = False

    def _collect_handoff(self, lst: CloudListener) -> None:
        """Sole-executor completion of one handoff.

        Only the thread that wins the claim does the work: stash the unsent tail,
        stop the old listener, clear the handoff, and reopen STT. A second path that
        races this one sees the claim already held and returns without doing
        anything — so auto-recovery and Retry cannot double-complete.
        """
        if not self._claim_handoff_collect(lst):
            return
        result = self._stash_unsent(lst)
        if result.kind == "blocked":
            self._release_handoff_collect(lst)
            self._mark_handoff_blocked(lst)
            return
        self._stop_listener(lst)
        self._clear_handoff()
        self._flush_translate_carry("restart")
        if getattr(self, "_listen_wanted", False) and not getattr(self, "_paused", False):
            self._start_listening(resume=True)
        # else: leave the session idle; no waiter exists to release.

    def _complete_blocked_handoff(self, lst: CloudListener) -> None:
        self._collect_handoff(lst)

    def _try_complete_handoff(self) -> None:
        lst = getattr(self, "_handoff_listener", None)
        if lst is None:
            return
        self._collect_handoff(lst)

    def _restart_listener(self) -> None:
        with self._listen_lock():
            if not self._listen_wanted and not getattr(self, "_handoff_listener", None):
                return
            lst = self._listener or getattr(self, "_handoff_listener", None)
            self._listener = None
            if lst is not None:
                self._handoff_listener = lst
        if lst is None:
            if self._listen_wanted and not self._paused:
                self._start_listening(resume=True)
            return
        self._collect_handoff(lst)

    def _on_stt_sent(self, n: int, stream_gen: int | None = None) -> None:
        if stream_gen is not None and stream_gen != getattr(self, "_stt_stream_gen", 0):
            return
        if n > 0:
            self._stt_tx_bytes = getattr(self, "_stt_tx_bytes", 0) + int(n)

    def _on_listen_taken(self) -> None:
        """Another Session stole this user+workspace stream. Leave Listening.

        stop() already set _stop, so _notify_drop will not fire. Clear the
        latch and tell the UI. Do not cancel an in-flight answer.
        """
        self._paused = False
        self._listen_wanted = False
        self._listen_ended = True  # stolen -> decisively over (issue #165 P2-8)
        self._pending_q.clear()
        self._cancel_stt_restart_timer()
        self._abandon_handoff()
        with self._listen_lock():
            lst = self._listener
            self._listener = None
        if lst:
            _drop_live_stt(self._stt_slot(), lst)
            try:
                lst.stop()
            except Exception:
                pass
        if getattr(self, "_workspace", "") == "interview":
            self._cancel_interview_wait_timer()
            self._flush_interview_wait()
        else:
            self._flush_meeting_hold()
            # Drain queued finals (they may re-open _open_line), then close it so
            # the next listener starts a fresh line (issue #31 P1-c).
            self._stop_meeting_worker(wait=True)
            self._close_open_line()
        self.emit({"type": "listen_taken", "text": LISTEN_TAKEN_MSG})
        self._emit_phase()
        self.emit({"type": "status", "text": LISTEN_TAKEN_MSG})
        self._flush_cloud_archive(final=False)
        self._offer_save_history()

    def _on_stt_drop(self, reason: str) -> None:
        if not self._listen_wanted:
            return
        now = time.time()
        if now - self._stt_drop_at > 45:
            self._stt_drops = 0
        self._stt_drops += 1
        self._stt_drop_at = now
        logging.getLogger("nod").warning(
            "stt drop n=%s reason=%s",
            self._stt_drops,
            str(reason or "")[:500],
        )
        if self._stt_drops > 6:
            self.emit({"type": "error", "text": "Transcription connection lost. Tap Start Listening."})
            self._listen_wanted = False
            self._stop_listening()
            self._offer_save_history()
            return
        self.emit({"type": "status", "text": "Transcription dropped — reconnecting"})
        self._cancel_stt_restart_timer()
        delay = min(3.0, 0.4 * self._stt_drops)
        timer = threading.Timer(delay, self._restart_if_listening)
        timer.daemon = True
        self._stt_restart_timer = timer
        timer.start()

    def _restart_if_listening(self) -> None:
        if not self._listen_wanted:
            return
        self._restart_listener()

    def _speech_filter_lang(self) -> str | None:
        # Auto follow is a status hint only. Filtering on it drops the other
        # language in a bilingual room — the core product is "record what was said".
        return self._effective_stt_lang()

    def _remember_final(self, text: str) -> None:
        self._recent_finals.append((text, time.time()))
        self._recent_finals = self._recent_finals[-8:]

    def _emit_translate_pieces(self, text: str, heard: str | None, speaker: str | None) -> None:
        piece_src = (text or "").strip()
        if not piece_src:
            return
        # 不取消在途翻译：取消会让被中断的句子等 25s 超时重试（双倍 token + 字幕卡死）。
        # 新 final 照常入队，前端 pump 一次只发一条，翻译自然串行。
        self._pending_q.clear()
        self._pending_wait = (None, 0.0, None)
        for piece in split_code_switched(piece_src):
            piece_heard = heard_lang_from_text(piece, heard)
            self._maybe_follow_speech(piece, piece_heard)
            self._remember_final(piece)
            ev: dict[str, Any] = {"type": "question", "id": self.pipeline._new_qid(), "text": piece}
            if piece_heard:
                ev["language"] = piece_heard
            if speaker:
                ev["speaker"] = speaker
            self.emit(ev)

    def _flush_translate_carry(self, reason: str) -> None:
        carry = (getattr(self, "_translate_carry", "") or "").strip()
        if not carry:
            return
        logging.getLogger("nod").info(
            "translate_carry_flush reason=%s len=%s",
            reason,
            len(carry),
        )
        if getattr(self, "_workspace", "") == "translate":
            locked = self._effective_stt_lang()
            heard = heard_lang_from_text(carry, locked) if locked else heard_lang_from_text(carry, None)
            self._emit_translate_pieces(carry, heard, None)
        self._translate_carry = ""

    def _maybe_follow_speech(self, text: str, heard: str | None) -> None:
        if self._effective_stt_lang():
            return
        lang = _confident_stt_lang(text, heard)
        if not lang:
            return
        if not self._follow_lang:
            self._follow_lang = lang
            self._follow_switch_lang = None
            self._follow_switch_hits = 0
            self.emit({"type": "status", "text": f"Speech recognition · following {_LANG_NAMES.get(lang, lang)}"})
            return
        if lang == self._follow_lang:
            self._follow_switch_lang = None
            self._follow_switch_hits = 0
            return
        if self._follow_switch_lang == lang:
            self._follow_switch_hits += 1
        else:
            self._follow_switch_lang = lang
            self._follow_switch_hits = 1
        if self._follow_switch_hits < 2:
            return
        self._follow_lang = lang
        self._follow_switch_lang = None
        self._follow_switch_hits = 0
        self.emit({"type": "status", "text": f"Speech recognition · following {_LANG_NAMES.get(lang, lang)}"})

    def _cancel_meeting_timer(self) -> None:
        timer = getattr(self, "_meeting_flush_timer", None)
        self._meeting_flush_timer = None
        if timer:
            try:
                timer.cancel()
            except Exception:
                pass

    def _cancel_interview_wait_timer(self) -> None:
        timer = getattr(self, "_interview_wait_timer", None)
        self._interview_wait_timer = None
        if timer:
            try:
                timer.cancel()
            except Exception:
                pass

    def _schedule_interview_wait_flush(self) -> None:
        self._cancel_interview_wait_timer()
        timer = threading.Timer(1.2, self._flush_interview_wait)
        timer.daemon = True
        self._interview_wait_timer = timer
        timer.start()

    def _flush_interview_wait(self) -> None:
        self._interview_wait_timer = None
        with self._interview_lock:
            ptxt, _pts, plang = self._pending_wait
            self._pending_wait = (None, 0.0, None)
        if not (ptxt and self._workspace == "interview"):
            return
        recent_qs = [h["q"] for h in self.pipeline._qa_history]
        verdict = guard_question(ptxt, recent_qs, self.pipeline._last_answer)
        # A held lead-in that never got its continuation must not be sent as an
        # answer. guard says "wait" (it might join the next piece), but if it
        # carries no question word it was never a question — only a dropped
        # sentence start ("For PostgreSQL,"), not something to bill a token on.
        if verdict == "reject" or (
            verdict == "wait" and _looks_like_lead_in(ptxt) and not _has_question_word(ptxt)
        ):
            self.emit({"type": "partial", "text": ""})
            return
        self._start_interview_answer(ptxt, plang)

    def _flush_meeting_hold(self) -> None:
        with getattr(self, "_meeting_lock", threading.Lock()):
            self._cancel_meeting_timer()
            ptxt, _pts, plang = getattr(self, "_pending_wait", (None, 0.0, None))
            speaker = getattr(self, "_pending_speaker", None)
            pmeta = getattr(self, "_pending_meta", None) or {}
            self._pending_wait = (None, 0.0, None)
            self._pending_speaker = None
            self._pending_meta = None
            workspace = getattr(self, "_workspace", "")
        if ptxt and workspace == "meeting":
            # Re-queue the held fragment through the worker so it takes the
            # `decide` path like any other final (issue #31 P1-a). It must not be
            # re-held, so mark it; and it gets a FRESH turn id (the original was
            # already dequeued) by dropping its old turn_order.
            m = dict(pmeta)
            m.pop("turn_order", None)
            m["__flushed__"] = True
            self._enqueue_meeting_final(ptxt, plang, speaker, m)

    def _emit_meeting_line(self, cleaned: str, lang: str | None, speaker: str | None = None, meta: dict[str, Any] | None = None) -> None:
        meta = meta or {}
        heard = heard_lang_from_text(cleaned, lang)
        last_piece: dict[str, Any] | None = None
        for piece in split_code_switched(cleaned):
            piece_heard = heard_lang_from_text(piece, heard)
            self._maybe_follow_speech(piece, piece_heard)
            self._remember_final(piece)
            qev: dict[str, Any] = {"type": "question", "id": self.pipeline._new_qid(), "text": piece}
            if piece_heard:
                qev["language"] = piece_heard
            if speaker:
                qev["speaker"] = speaker
            self.emit(qev)
            self._remember_stt_turn(meta, qev["id"])
            if self.user_id and self.usage_session_id:
                from server.meter import save_history

                try:
                    save_history(self.user_id, self.usage_session_id, "transcript", piece, qev["id"], qev.get("speaker") or "")
                except Exception:
                    logging.getLogger("nod").exception("listen_flush history save failed")
                    if getattr(self, "_stop_flushing", False):
                        self._listen_flush_history_ok = False
            last_piece = {"id": qev["id"], "text": piece, "speaker": speaker, "lang": piece_heard or lang}
        # Only the LAST piece of a code-switched turn may be extended by the next final.
        # Word-level timestamps come from the turn meta so the continuation decision
        # has a real first/last word (issue #31 root cause 1).
        with self._meeting_lock:
            self._open_line = dict(last_piece) if last_piece else None
            if self._open_line is not None:
                self._open_line["opened_at"] = time.time()
                self._open_line["last_final_at"] = time.time()
                self._open_line["last_word_ms"] = meta.get("last_word_ms")
                self._open_line["n_words"] = meta.get("n_words") or 0
                self._open_line["rev"] = 0

    def _enqueue_meeting_final(self, cleaned: str, lang: str | None, speaker: str | None, meta: dict[str, Any] | None) -> None:
        gen = self._meeting_gen
        if meta and meta.get("turn_order"):
            turn = meta["turn_order"]
        else:
            self._final_seq += 1
            turn = self._final_seq
        self._meeting_finals.put((gen, turn, cleaned, lang, speaker, dict(meta or {})))
        self._ensure_meeting_worker()

    def _ensure_meeting_worker(self) -> None:
        with self._meeting_lock:
            if self._meeting_worker_started:
                return
            self._meeting_worker_started = True
        t = threading.Thread(target=self._meeting_worker_loop, daemon=True)
        self._meeting_worker_thread = t
        t.start()

    def _stop_meeting_worker(self, wait: bool = False, timeout: float = 1.0) -> None:
        # Tell the worker to flush + exit ONLY if one is actually running. If no
        # worker has been started yet (e.g. the very first set_workspace on a fresh
        # connection), putting a drain sentinel would be consumed by the NEXT
        # worker's first get() and make it exit immediately — leaving the "started"
        # flag true and every later final queued but never processed (transcript
        # shows only the live partial, never the settled line).
        q = getattr(self, "_meeting_finals", None)
        if q is None:
            return
        with getattr(self, "_meeting_lock", threading.Lock()):
            was_started = self._meeting_worker_started
            self._meeting_worker_started = False
        if was_started:
            q.put(self._drain_item())
        # pause / stop / listen_taken MUST wait for the worker to drain the
        # queued finals (they may call _hold_or_emit_meeting and re-open
        # _open_line) BEFORE closing the open line (issue #31 P1-c). Join even
        # after the started flag is cleared so a still-running drain is not
        # treated as finished.
        if wait:
            t = getattr(self, "_meeting_worker_thread", None)
            if t is not None:
                t.join(timeout=max(0.05, timeout))

    def _drain_item(self) -> tuple[int, int, str, str | None, str | None, dict[str, Any]]:
        return (getattr(self, "_meeting_gen", 0), 10 ** 9, "", None, None, {"__drain__": True})

    def _meeting_worker_loop(self) -> None:
        buffer: dict[int, tuple[int, str, str | None, str | None, dict[str, Any]]] = {}
        try:
            while True:
                item = self._meeting_finals.get()
                if item is None:
                    self._flush_meeting_buffer(buffer)
                    return
                gen, turn, cleaned, lang, speaker, meta = item
                if meta and meta.get("__drain__"):
                    self._flush_meeting_buffer(buffer)
                    return
                if gen != self._meeting_gen:
                    buffer.clear()
                    continue
                buffer[turn] = (gen, cleaned, lang, speaker, meta)
                # Recompute the contiguous run from the LOWEST buffered turn on every
                # dequeue, so a late arrival (its thread was slow) never overtakes an
                # earlier one; a gap (turn N held for N-1) keeps later turns waiting.
                expected = min(buffer)
                while expected in buffer:
                    _g, c, l, s, m = buffer.pop(expected)
                    try:
                        self._hold_or_emit_meeting(c, l, s, m)
                    except Exception:
                        logging.getLogger("nod").exception("meeting final handler failed")
                    expected += 1
        finally:
            # An exiting worker must clear the started flag so the next final can
            # spin a fresh one; otherwise after a drain/first-reset every later
            # final is queued but never processed.
            with getattr(self, "_meeting_lock", threading.Lock()):
                self._meeting_worker_started = False

    def _flush_meeting_buffer(self, buffer: dict[int, tuple[int, str, str | None, str | None, dict[str, Any]]]) -> None:
        for turn in sorted(buffer):
            _g, c, l, s, m = buffer[turn]
            if _g != self._meeting_gen:
                continue
            try:
                self._hold_or_emit_meeting(c, l, s, m)
            except Exception:
                logging.getLogger("nod").exception("meeting final handler failed")

    def _close_open_line(self) -> None:
        with getattr(self, "_meeting_lock", threading.Lock()):
            self._open_line = None

    def _remember_stt_turn(self, meta: dict[str, Any] | None, line_id: str) -> None:
        if not meta or meta.get("stt_turn") is None or not line_id:
            return
        by = getattr(self, "_stt_line_by_turn", None)
        if by is None:
            self._stt_line_by_turn = {}
            by = self._stt_line_by_turn
        by[(meta.get("listener_id"), meta.get("stt_turn"))] = line_id

    def _apply_meeting_revision(
        self,
        cleaned: str,
        lang: str | None,
        speaker: str | None,
        meta: dict[str, Any],
    ) -> bool:
        key = (meta.get("listener_id"), meta.get("stt_turn"))
        qid = getattr(self, "_stt_line_by_turn", {}).get(key)
        if qid:
            self._revise_meeting_line(qid, cleaned, lang, speaker, meta)
            return True
        replaced_hold = False
        with self._meeting_lock:
            ptxt, pts, plang = self._pending_wait
            pmeta = getattr(self, "_pending_meta", None) or {}
            if ptxt and pmeta.get("stt_turn") is not None and pmeta.get("stt_turn") == meta.get("stt_turn"):
                self._pending_wait = (cleaned, pts, lang or plang)
                merged = dict(pmeta)
                merged.update(meta)
                self._pending_meta = merged
                if speaker:
                    self._pending_speaker = speaker
                replaced_hold = True
        if replaced_hold:
            self.emit({"type": "partial", "text": cleaned})
            return True
        open_line = getattr(self, "_open_line", None)
        if open_line and open_line.get("id"):
            self._revise_meeting_line(str(open_line["id"]), cleaned, lang, speaker, meta)
            return True
        return False

    def _revise_meeting_line(
        self,
        qid: str,
        cleaned: str,
        lang: str | None,
        speaker: str | None,
        meta: dict[str, Any],
    ) -> None:
        rev = 1
        with self._meeting_lock:
            open_line = self._open_line
            if open_line and open_line.get("id") == qid:
                rev = int(open_line.get("rev") or 0) + 1
                open_line["text"] = cleaned
                open_line["rev"] = rev
                open_line["last_final_at"] = time.time()
                if meta.get("last_word_ms") is not None:
                    open_line["last_word_ms"] = meta.get("last_word_ms")
                if meta.get("n_words"):
                    open_line["n_words"] = meta.get("n_words")
            elif open_line:
                rev = int(open_line.get("rev") or 0) + 1
        heard = heard_lang_from_text(cleaned, lang)
        self._remember_final(cleaned)
        ev: dict[str, Any] = {"type": "line_update", "id": qid, "text": cleaned, "rev": rev}
        if heard:
            ev["language"] = heard
        if speaker:
            ev["speaker"] = speaker
        self.emit(ev)
        if self.user_id and self.usage_session_id:
            from server.meter import update_history_text

            try:
                update_history_text(self.user_id, self.usage_session_id, qid, cleaned, speaker or "")
            except Exception:
                logging.getLogger("nod").exception("listen_flush history revise failed")
                if getattr(self, "_stop_flushing", False):
                    self._listen_flush_history_ok = False

    def _hold_or_emit_meeting(self, cleaned: str, lang: str | None, speaker: str | None = None, meta: dict[str, Any] | None = None) -> None:
        meta = meta or {}
        leftover: tuple[str, str | None, str | None, dict[str, Any]] | None = None
        hold_now = False
        emit_update: tuple[str, str, str | None, str | None, int] | None = None
        tail_ctx: tuple[str, str | None, str | None, dict[str, Any]] | None = None
        with self._meeting_lock:
            ptxt, pts, plang = self._pending_wait
            pmeta = getattr(self, "_pending_meta", None) or {}
            now = time.time()
            # A __flushed__ fragment was already held and is now being re-decided;
            # it must NOT re-merge with a new pending wait or be held again.
            is_flush = bool(meta.get("__flushed__"))
            if ptxt and not is_flush and now - pts < 2.8 and _same_speech_script(ptxt, cleaned):
                cleaned = _join_speech_frags(ptxt, cleaned)
                lang = plang or lang
                speaker = self._pending_speaker or speaker
                meta = _merge_meeting_meta(pmeta, meta)
                self._pending_wait = (None, 0.0, None)
                self._pending_speaker = None
                self._pending_meta = None
            elif ptxt:
                # A held fragment that didn't merge (different script, or a final
                # arrived before the timer fired). With round-2 (P1-a) held
                # fragments are re-queued by the timer via __flushed__, so this
                # branch is rarer than before, but it is STILL reachable for a
                # cross-script continuation inside the 1.0s hold window — emit the
                # held fragment as its own line rather than dropping it.
                leftover = (ptxt, plang, self._pending_speaker, pmeta)
                self._pending_wait = (None, 0.0, None)
                self._pending_speaker = None
                self._pending_meta = None
            if _meeting_should_hold(cleaned) and not is_flush:
                self._pending_wait = (cleaned, now, lang)
                self._pending_speaker = speaker
                self._pending_meta = meta
                self._cancel_meeting_timer()
                timer = threading.Timer(1.0, self._flush_meeting_hold)
                timer.daemon = True
                self._meeting_flush_timer = timer
                timer.start()
                hold_now = True
            else:
                self._cancel_meeting_timer()
                nxt_open: dict[str, Any] = {
                    "text": cleaned,
                    "speaker": speaker,
                    "lang": lang,
                    "first_word_ms": meta.get("first_word_ms"),
                    "last_word_ms": meta.get("last_word_ms"),
                    "n_words": meta.get("n_words") or 0,
                }
                # Round 3 (#33): decide returns (decision, reason); the reason is
                # logged with the split info when §1.1 closes the line at a
                # sentence end.
                decision, reason = meeting_decide_full(self._open_line, nxt_open, now)
                decide_prev = self._open_line
                # §1.1: does the incoming turn carry a sentence end to close on?
                split_at = (
                    meeting_last_sentence_index(cleaned, skip_false_period=True)
                    if (decision == "extend" and decide_prev)
                    else None
                )
                tail = cleaned[split_at:].strip() if split_at else ""
                self._trace_meeting_decision(
                    decide_prev, nxt_open, decision, reason, now, cleaned,
                    meta.get("turn_order"), split_at=split_at, tail_len=len(tail) if split_at is not None else None,
                )
                if decision == "extend" and decide_prev:
                    prev = decide_prev
                    gap = meeting_gap_ms(prev, nxt_open, now)
                    gap_ms_val = gap[0] if gap else None
                    if split_at is not None and split_at > 0:
                        # §1.1: absorb only up to the LAST sentence end; the rest
                        # opens a NEW line. The absorbed line now ends with a
                        # sentence end, so it is closed (decide naturally news).
                        head = cleaned[:split_at]
                        rev = prev.get("rev", 0) + 1
                        head_n_words = round((meta.get("n_words") or 0) * split_at / len(cleaned)) if len(cleaned) else 0
                        merged = join_meeting_text(prev["text"], head, gap_ms=gap_ms_val)
                        fw = meta.get("first_word_ms")
                        lw = meta.get("last_word_ms")
                        if not tail and lw is not None:
                            head_last_ms = lw
                        elif tail and fw is not None and lw is not None and lw >= fw and len(cleaned) > 0:
                            head_last_ms = fw + (lw - fw) * (split_at / len(cleaned))
                        else:
                            head_last_ms = prev.get("last_word_ms")
                        self._open_line = {
                            "id": prev["id"],
                            "text": merged,
                            "speaker": prev.get("speaker"),
                            "lang": prev.get("lang"),
                            "opened_at": prev.get("opened_at"),
                            "last_final_at": now,
                            "last_word_ms": head_last_ms,
                            "n_words": (prev.get("n_words") or 0) + head_n_words,
                            "rev": rev,
                            "closed": True,
                        }
                        emit_update = (prev["id"], merged, prev.get("lang"), prev.get("speaker"), rev)
                        if tail:
                            tail_ctx = (tail, lang, speaker, meeting_tail_meta(meta, cleaned, split_at))
                    else:
                        # No sentence end in the incoming turn: merge it wholesale
                        # and keep the line OPEN for the next final.
                        merged = join_meeting_text(prev["text"], cleaned, gap_ms=gap_ms_val)
                        rev = prev.get("rev", 0) + 1
                        n_words = (prev.get("n_words") or 0) + (meta.get("n_words") or 0)
                        self._open_line = {
                            "id": prev["id"],
                            "text": merged,
                            "speaker": prev.get("speaker"),
                            "lang": prev.get("lang"),
                            "opened_at": prev.get("opened_at"),
                            "last_final_at": now,
                            "last_word_ms": meta.get("last_word_ms"),
                            "n_words": n_words,
                            "rev": rev,
                        }
                        emit_update = (prev["id"], merged, prev.get("lang"), prev.get("speaker"), rev)
        if leftover:
            self._emit_meeting_line(leftover[0], leftover[1], leftover[2], leftover[3])
        if hold_now:
            ev: dict[str, Any] = {"type": "partial", "text": cleaned}
            if lang:
                ev["language"] = lang
            if speaker:
                ev["speaker"] = speaker
            self.emit(ev)
            return
        if emit_update:
            line_id, merged, plang, pspeaker, rev = emit_update
            heard = heard_lang_from_text(merged, plang)
            self._remember_final(merged)
            self._maybe_follow_speech(merged, heard)
            ev: dict[str, Any] = {"type": "line_update", "id": line_id, "text": merged, "rev": rev}
            if heard:
                ev["language"] = heard
            if pspeaker:
                ev["speaker"] = pspeaker
            self.emit(ev)
            if self.user_id and self.usage_session_id:
                from server.meter import update_history_text

                try:
                    update_history_text(self.user_id, self.usage_session_id, line_id, merged, pspeaker or "")
                except Exception:
                    logging.getLogger("nod").exception("listen_flush history update failed")
                    if getattr(self, "_stop_flushing", False):
                        self._listen_flush_history_ok = False
            if tail_ctx:
                # §1.1 split: the absorbed line was closed above; the remainder
                # opens a NEW line (and becomes the new open line), emitted AFTER
                # the line_update so the client never sees them out of order.
                self._emit_meeting_line(tail_ctx[0], tail_ctx[1], tail_ctx[2], tail_ctx[3])
            return
        self._emit_meeting_line(cleaned, lang, speaker, meta)

    def _trace_meeting_decision(self, prev: dict[str, Any] | None, nxt: dict[str, Any], decision: str, reason: str, now: float, text: str, turn_order: int | None = None, split_at: int | None = None, tail_len: int | None = None) -> None:
        """Shas the meeting continuation decision for the ``NOD_STT_TRACE`` line.

        Logs only the decision diagnostics + text length/hash — never the text
        itself (issue #31 §2.6, #33 §1.5 adds ``reason`` and the split info).
        Runs inside the worker where the decision is made.
        """
        if os.environ.get("NOD_STT_TRACE") != "1":
            return
        gap = meeting_gap_ms(prev, nxt, now)
        gap_ms_val = f"{gap[0]:.0f}" if gap else "none"
        gap_src = gap[1] if gap else "none"
        opened_at = prev.get("opened_at") if prev else None
        last_final_at = prev.get("last_final_at") if prev else None
        open_age_ms = "-" if (opened_at is None or last_final_at is None) else f"{(last_final_at - opened_at) * 1000:.0f}"
        split_suffix = f" split_at={split_at} tail_len={tail_len}" if split_at is not None else ""
        logging.getLogger("nod").info(
            "meeting_decision turn_order=%s decision=%s reason=%s gap_ms=%s gap_src=%s open_age_ms=%s "
            "speaker_prev=%s speaker_next=%s text_len=%s text_sha=%s%s",
            turn_order,
            decision,
            reason,
            gap_ms_val,
            gap_src,
            open_age_ms,
            prev.get("speaker") if prev else None,
            nxt.get("speaker"),
            len(text),
            hashlib.sha1(text.encode("utf-8", "ignore")).hexdigest()[:8],
            split_suffix,
        )

    def _reset_turn_state(self) -> None:
        """Drop turn-scoped state: queued questions, pending asks, and holds.

        Used by set_workspace (a mode switch must not carry a held half-sentence
        across workspaces) and by clear (a full session reset additionally wipes
        QA history — that part lives in the clear handler).
        """
        self._pending_q.clear()
        self._pending_asks = []
        # 丢弃 hold 住的半句会议内容（不 flush）：模式切换后 emit 的 question 事件
        # 会被前端路由到新 workspace（如 translate 下变成垃圾翻译对）
        with getattr(self, "_meeting_lock", threading.Lock()):
            self._cancel_meeting_timer()
            self._cancel_interview_wait_timer()
            self._pending_wait = (None, 0.0, None)
            self._pending_speaker = None
            self._open_line = None
            self._meeting_gen = getattr(self, "_meeting_gen", 0) + 1
        self._stop_meeting_worker()

    def set_workspace(self, mode: str, scene: Any = None, speakers_expected: Any = None) -> None:
        if mode not in ("interview", "meeting", "translate"):
            mode = "interview"
        prev = self._workspace
        prev_lang = self._effective_stt_lang(prev)
        prev_url = assemblyai_ws_url(self._stt_cfg()) if self._listener else ""
        if prev == "translate" and mode != "translate":
            self._flush_translate_carry("workspace")
        self._workspace = mode
        if str(scene or "").strip().lower() in ("meeting", "lecture", "interview"):
            self.cfg.setdefault("stt", {})["listen_scene"] = str(scene).strip().lower()
        if speakers_expected is not None:
            try:
                n = int(speakers_expected)
                if 1 <= n <= 10:
                    self.cfg.setdefault("stt", {})["speakers_expected"] = n
            except (TypeError, ValueError):
                pass
        self._reset_turn_state()
        if mode == "translate" and prev != "translate":
            self.cancel_generate()
        if self._listener and (prev_lang != self._effective_stt_lang() or prev_url != assemblyai_ws_url(self._stt_cfg())):
            self._restart_listener()

    def set_llm(self, provider: str, model: str) -> None:
        if not model_allowed(self.cfg, provider, model):
            self.emit({"type": "error", "text": f"Model not available: {model}"})
            return
        try:
            self.pipeline.set_model(provider, model)
        except Exception as e:
            self.emit({"type": "error", "text": f"Failed to switch model: {e}"})
            return
        self.cfg.setdefault("llm", {})["provider"] = provider
        self.cfg["llm"]["model"] = model

    def set_mic_muted(self, muted: bool) -> None:
        self._mic_muted = muted
        if self._listener:
            self._listener.set_muted(muted)
        if muted:
            if self._manual:
                self._stop_manual()
            self.emit({"type": "status", "text": "Microphone muted"})
        else:
            self.emit({"type": "status", "text": "Microphone unmuted"})

    def start_listen(self, mic: Any = None) -> None:
        raw = str(mic or "").strip().lower()
        self._listen_mic = "watch" if raw == "watch" else "phone"
        if self._manual:
            self.emit({"type": "status", "text": "Stop recording before enabling Auto"})
            return
        self._paused = False
        self._listen_wanted = True
        with self._listen_lock():
            if self._listener or getattr(self, "_listen_starting", False):
                return
        if not self._ensure_consent() or not self._ensure_usage():
            self._listen_wanted = False
            return
        self._start_listening()

    def stop_listen(self, flush_id: Any = None) -> None:
        raw = str(flush_id or "").strip()
        self._listen_flush_client_id = raw or None
        if getattr(self, "_stop_flushing", False):
            return
        self._paused = False
        self._listen_wanted = False
        if self._manual:
            self._stop_manual()
            return
        if self._listener:
            self._stop_listening()
        else:
            self._flush_translate_carry("stop")
            if not getattr(self, "_listen_flush_done", False):
                self._emit_listen_flush(ok=True, timeout=False)
                self._listen_flush_done = True
            self._emit_phase()
            self.emit({"type": "status", "text": STATUS_READY})
        self._offer_save_history()

    def _session_terminated(self) -> bool:
        """True when this Session object is decisively over and no longer receives audio.

        Uses the explicit ``_listen_ended`` latch set only on the definitive stop
        paths (close, stop_listening, listen-taken, quota/idle stop). A session
        with no current listener but still LIVE — a transient rebuild, a Pause,
        or a momentary handoff — is NOT terminated and must not be reported as an
        expired error (issue #165 P2-8).
        """
        return bool(getattr(self, "_listen_ended", False)) or bool(getattr(self, "_closed", False))

    def _reject_pcm_ended(self, sid: str, cap: str, reason: str) -> None:
        """Surface an explicit expired/terminated rejection to the native device.

        Carries the ORIGINAL session + capture identity so the Watch can match it
        against the session it was draining, end the drain wait, and show
        "补传未完成" without starting a new session (issue #165 P2-8).
        """
        text = "会话已结束，补传未完成。"
        logging.getLogger("nod").warning(
            "stt pcm_rejected session=%s capture=%s reason=%s", sid, cap, reason
        )
        self.emit({"type": "error", "text": text})
        event = {
            "type": "pcm_rejected",
            "id": sid,
            "capture_id": cap,
            "reason": reason,
            "text": text,
        }
        self._pcm_reject_result = event
        self._send_audio_text(event)

    def pcm_end(self, session_id: Any = None, byte_offset: Any = None, capture_id: Any = None) -> None:
        """Watch End: wait until this capture's audio is in STT, then emit pcm_drained.

        Old clients never send this. A wrong/empty id or capture is ignored so a
        leftover End cannot drain or stop another session. A terminated session
        (closed, or listen stolen/stopped with no listener) that still receives a
        trailing End is REJECTED explicitly with its original identity, so the
        Watch ends its drain wait and shows "补传未完成" instead of waiting out the
        timeout for a drain that can never happen (issue #165 P2-8).
        """
        sid = str(session_id or "").strip()
        cap = str(capture_id or "").strip()
        if not sid or not cap:
            return
        try:
            offset = int(byte_offset)
        except (TypeError, ValueError):
            return
        if offset < 0:
            return
        # A repeated End of ALREADY-confirmed success re-publishes the saved result
        # (reconnect path); it is not a fresh drain.
        prev = getattr(self, "_pcm_drain_result", None)
        if (
            isinstance(prev, dict)
            and prev.get("type") == "pcm_drained"
            and prev.get("id") == sid
            and prev.get("capture_id") == cap
            and int(prev.get("byte_offset") or 0) == offset
        ):
            self._publish_pcm_drained(prev)
            return
        # Terminated session: reject an expired/backfilled End with identity.
        if self._session_terminated():
            self._reject_pcm_ended(sid, cap, "session_ended")
            return
        if sid != (self.usage_session_id or ""):
            # Transient (a new/mismatched session, still live): ignore, do not
            # drain or reject — a leftover End must not affect a live session.
            return
        self._pcm_end_id = sid
        self._pcm_end_capture = cap
        self._pcm_end_offset = offset
        if getattr(self, "_handoff_blocked", False) or getattr(self, "_handoff_listener", None):
            self._try_complete_handoff()
        self._finish_pcm_end_if_ready()

    def _finish_pcm_end_if_ready(self) -> None:
        sid = getattr(self, "_pcm_end_id", None)
        cap = str(getattr(self, "_pcm_end_capture", "") or "")
        if not sid or not cap:
            return
        if getattr(self, "_handoff_blocked", False) or getattr(self, "_handoff_listener", None):
            return
        # A dropped window must never be reported as a completed/drained success:
        # an overflow stall marks the session incomplete, so do not acknowledge it.
        if getattr(self, "_pcm_stall_reported", False):
            return
        if getattr(self, "_stt_pending_pcm", b""):
            return
        if getattr(self, "_pcm_hold", b""):
            return
        offset = int(getattr(self, "_pcm_end_offset", 0) or 0)
        if getattr(self, "_pcm_rx_bytes", 0) < offset:
            return
        lst = self._listener
        if lst is None:
            return
        if not lst.drain():
            return
        # Re-check the post-drain state: a drain that took time may have raced a
        # handoff, a stop, or a fresh End. Only publish if THIS listener still
        # owns the stream, the request is unchanged, and nothing stale completed.
        # (issue #165 P2-5 — concurrent recovery must not publish an old result.)
        if getattr(self, "_handoff_blocked", False) or getattr(self, "_handoff_listener", None):
            return
        if self._listener is not lst:
            return
        if (
            getattr(self, "_pcm_end_id", None) != sid
            or str(getattr(self, "_pcm_end_capture", "") or "") != cap
            or getattr(self, "_pcm_end_offset", None) != offset
            or getattr(self, "_pcm_stall_reported", False)
            or self._session_terminated()
            or getattr(self, "_pcm_hold", b"")
            or getattr(self, "_stt_pending_pcm", b"")
        ):
            return
        if getattr(self, "_stt_tx_bytes", 0) < offset:
            return
        self._pcm_end_id = None
        self._pcm_end_capture = ""
        self._pcm_end_offset = 0
        self._publish_pcm_drained({"type": "pcm_drained", "id": sid, "capture_id": cap, "byte_offset": offset})

    def _publish_pcm_drained(self, event: dict) -> None:
        self._pcm_drain_result = event
        self.emit(event)
        self._send_audio_text(event)

    def _send_audio_text(self, obj: dict) -> None:
        ws = getattr(self, "_audio_ws", None)
        loop = getattr(self, "_loop", None)
        if ws is None or loop is None:
            return
        try:
            text = json.dumps(obj, ensure_ascii=False)
        except (TypeError, ValueError):
            return

        async def _send() -> None:
            try:
                await ws.send_text(text)
            except Exception:
                pass

        try:
            if loop.is_running():
                asyncio.run_coroutine_threadsafe(_send(), loop)
        except Exception:
            pass

    def pause_listen(self) -> None:
        """Pause live capture and stop AssemblyAI billing.

        ``capture`` stays ``paused`` so the Watch does not treat this as Stop.
        The cloud socket is Terminated; Resume opens a new stream.
        """
        if (
            self._listener is None
            and not getattr(self, "_handoff_listener", None)
            and not self._manual
        ):
            self.emit({"type": "status", "text": "Not listening"})
            return
        if self._manual:
            # Manual recording (F2) has no listen snapshot to pause. Don't stash
            # a dormant paused state that would surface after the recording ends.
            self.emit({"type": "status", "text": "Not listening"})
            return
        self._paused = True
        if self._listener or getattr(self, "_handoff_listener", None):
            # Bank the just-listened segment into the accumulated 2h quota so
            # the wall-clock pause doesn't keep consuming the cap.
            self._listen_accum_sec = getattr(self, "_listen_accum_sec", 0.0) + (time.time() - self._listen_started_at)
            with self._listen_lock():
                lst = self._listener or getattr(self, "_handoff_listener", None)
                self._listener = None
                if lst is not None:
                    self._handoff_listener = lst
            if lst is not None:
                self._collect_handoff(lst)
        self._flush_translate_carry("pause")
        # Flush any held half-sentence, drain the worker (its queued finals may
        # re-open _open_line via _hold_or_emit_meeting), THEN close the open line
        # so the first final after Resume starts a fresh line (issue #29/#31 P1-c).
        self._flush_meeting_hold()
        self._stop_meeting_worker(wait=True)
        self._close_open_line()
        self._emit_phase()
        self.emit({"type": "status", "text": "Listening paused"})

    def resume_listen(self) -> None:
        """Leave a pause and reopen AssemblyAI if listen is still wanted."""
        if not self._paused:
            self.emit({"type": "status", "text": "Not paused"})
            return
        if self._listen_wanted and self._listener is None and not getattr(self, "_manual", False):
            # Clear the pause BEFORE opening the listener so its own _emit_phase
            # reads capture=listening, not a stale "paused" frame (order bug:
            # resume used to pulse paused -> listening).
            # Pause stops AssemblyAI but the idle/watch clock keeps running, so
            # rewind the VOICE clock (a long pause must not read as "15 minutes
            # of silence") and start a NEW segment clock for the 2h cap. The
            # pause already banked its listened time into _listen_accum_sec, so
            # a long pause neither consumes the quota nor bypasses it.
            self._paused = False
            self._last_voice_at = time.time()
            self._listen_started_at = time.time()
            self._start_listening(resume=True)
        else:
            # Not wanted (or manual recording): just clear the paused latch.
            self._paused = False
            self._emit_phase()
        self.emit({"type": "status", "text": "Listening resumed"})

    def _offer_save_history(self) -> None:
        if not getattr(self, "user_id", None) or not getattr(self, "usage_session_id", None):
            return
        if getattr(self, "_workspace", "") != "meeting":
            return
        from server.meter import is_session_kept

        if is_session_kept(self.usage_session_id):
            return
        self.emit({
            "type": "save_prompt",
            "id": self.usage_session_id,
            "text": "Save this session to History?",
        })

    def keep_history(self, content: Any = True, audio: Any = True, session_id: str | None = None) -> None:
        sid = session_id if session_id is not None else self.usage_session_id
        if not self.user_id or not sid:
            reason = "no_user" if not self.user_id else "no_session"
            self.emit({"type": "history_keep_failed", "id": sid, "reason": reason})
            return
        keep_content = content is not False
        keep_audio = audio is not False
        if not keep_content and not keep_audio:
            self.discard_history(session_id=sid)
            return
        self._flush_cloud_archive(final=False)
        from server.meter import keep_usage_session

        try:
            keep_usage_session(self.user_id, sid, keep_content=keep_content, keep_audio=keep_audio)
        except Exception as exc:
            self.emit({
                "type": "history_keep_failed",
                "id": sid,
                "reason": str(exc) or "error",
            })
            return
        parts = [name for on, name in ((keep_content, "session"), (keep_audio, "recording")) if on]
        self.emit({"type": "status", "text": "Saved to History · " + " and ".join(parts)})
        # Acknowledge so the client flips its kept flag only after the server
        # confirmed the write (it may be a restored, non-live session by id).
        self.emit({"type": "history_kept", "id": sid})

    def discard_history(self, session_id: str | None = None) -> None:
        sid = session_id if session_id is not None else self.usage_session_id
        if not self.user_id or not sid:
            return
        from server.meter import discard_usage_session

        discard_usage_session(self.user_id, sid)
        # Only clear the LIVE session pointer when we discarded the current one;
        # a restored-pending session is unrelated and must not clobber a live id.
        if sid == self.usage_session_id:
            self.usage_session_id = None
            self.pipeline.usage_session_id = None
        self.emit({"type": "status", "text": "Session discarded"})

    def toggle_listen(self) -> None:
        if self._listener or self._listen_wanted:
            self.stop_listen()
        else:
            self.start_listen()

    def _start_listening(self, resume: bool = False) -> None:
        if not self._claim_listen_start(resume):
            return
        try:
            self._open_listener(resume)
        finally:
            self._release_listen_start()

    def _open_listener(self, resume: bool = False) -> None:
        key = self.pipeline.assemblyai_key()
        if not key:
            self.emit({"type": "error", "text": "Missing AssemblyAI key — add it to start cloud listening"})
            return
        if not resume:
            self._listen_gen = getattr(self, "_listen_gen", 0) + 1
            self._pcm_rx_bytes = 0
            self._stt_tx_bytes = 0
            self._stt_pending_pcm = b""
            self._pcm_hold = bytearray()
            self._pcm_end_id = None
            self._pcm_end_capture = ""
            self._pcm_end_offset = 0
            self._pcm_drain_result = None
            self._pcm_stall_reported = False
            self._listen_ended = False
            self._listen_flush_done = False
            self._pcm_reject_result = None
        self._pcm_reject_sent = False
        self._stt_stream_gen = getattr(self, "_stt_stream_gen", 0) + 1
        listen_gen = getattr(self, "_listen_gen", 0)
        stream_gen = self._stt_stream_gen
        listener = CloudListener(
            api_key=key,
            cfg=self._stt_cfg(),
            on_final=lambda *a, g=listen_gen, sg=stream_gen: (
                self._on_final(*a)
                if g == getattr(self, "_listen_gen", 0) and sg == getattr(self, "_stt_stream_gen", 0)
                else None
            ),
            on_partial=self._on_partial,
            on_error=lambda e: self.emit({"type": "error", "text": f"Transcription failed:{e}"}),
            on_drop=lambda r, sg=stream_gen: (
                self._on_stt_drop(r) if sg == getattr(self, "_stt_stream_gen", 0) else None
            ),
            on_sent=lambda n, sg=stream_gen: self._on_stt_sent(n, sg),
        )
        pending = bytes(getattr(self, "_stt_pending_pcm", b"") or b"")
        if pending:
            seed = getattr(listener, "seed_unsent", None)
            if callable(seed):
                seed(pending)
        slot = self._stt_slot()
        prev = _adopt_live_stt(slot, listener, self)
        if prev:
            prev_lst, prev_sess = prev
            try:
                prev_lst.stop()
            except Exception:
                pass
            if prev_sess is not self:
                try:
                    prev_sess._on_listen_taken()
                except Exception:
                    logging.getLogger("nod").exception("listen_taken notify failed")
        try:
            listener.start()
        except Exception as e:
            _drop_live_stt(slot, listener)
            self.emit({"type": "error", "text": f"Transcription failed:could not start listening ({e})"})
            if resume and self._listen_wanted:
                self._on_stt_drop(str(e))
            else:
                self._listen_wanted = False
            return
        if not self._listen_wanted:
            self._stop_listener(listener)
            return
        self._stt_pending_pcm = b""
        if self._mic_muted:
            listener.set_muted(True)
        with self._listen_lock():
            if not self._listen_wanted:
                self._stop_listener(listener)
                return
            old = self._listener
            self._listener = listener
        if old and old is not listener:
            self._stop_listener(old)
        with self._pcm_input_lock():
            self._flush_pcm_hold_into(listener)
        now = time.time()
        if not resume:
            self._listen_accum_sec = 0.0  # a new session zeroes the accumulated quota
        if not resume or not self._listen_started_at:
            self._listen_started_at = now
            self._last_voice_at = now
        self._idle_check_at = 0.0
        self._last_pcm_at = now  # grace window for the freshly-opened socket
        _ensure_idle_watch_thread()
        self._emit_phase()
        if not resume:
            self.emit({"type": "status", "text": STATUS_LISTEN})
        self._finish_pcm_end_if_ready()

    def _mark_voice(self) -> None:
        self._last_voice_at = time.time()

    def _maybe_stop_forgotten_listen(self) -> None:
        if not self._listener:
            return
        now = time.time()
        if now - self._idle_check_at < 5:
            return
        self._idle_check_at = now
        started = self._listen_started_at or now
        last = self._last_voice_at or started
        if getattr(self, "_listen_accum_sec", 0.0) + (now - started) >= LISTEN_MAX_SECONDS:
            self._paused = False
            self._listen_wanted = False
            self._stop_listening()
            self.emit({"type": "status", "text": "Listening stopped after 2 hours. Start again if you still need it."})
            self._offer_save_history()
            return
        last_pcm = getattr(self, "_last_pcm_at", 0.0) or now
        zero_limit = (
            LISTEN_ZERO_PCM_WATCH_SECONDS
            if getattr(self, "_listen_mic", "phone") == "watch"
            else LISTEN_ZERO_PCM_SECONDS
        )
        if now - last_pcm >= zero_limit:
            self._paused = False
            self._listen_wanted = False
            self._stop_listening()
            self.emit({"type": "status", "text": f"No microphone audio received for {int(zero_limit)} seconds — stopped listening. Tap Start to retry."})
            self._offer_save_history()
            return
        if now - last >= LISTEN_IDLE_SECONDS:
            self._paused = False
            self._listen_wanted = False
            self._stop_listening()
            self.emit({"type": "status", "text": "Listening stopped after 15 minutes of silence."})
            self._offer_save_history()

    def _stop_listening(self) -> None:
        if getattr(self, "_stop_flushing", False):
            return
        if self._listener is None and getattr(self, "_listen_flush_done", False):
            return
        self._stop_flushing = True
        self._listen_flush_history_ok = True
        timeout = False
        self._listen_accum_sec = 0.0  # session over; reset the accumulated quota
        self._listen_ended = True  # definitive stop (issue #165 P2-8)
        self._last_pcm_at = 0.0  # zero-PCM guard must not carry into the next session
        self._pending_q.clear()
        self._cancel_stt_restart_timer()
        self._abandon_handoff(bump_gen=False)
        with self._listen_lock():
            lst = self._listener
            self._listener = None
        meeting = getattr(self, "_workspace", "") == "meeting"
        self._stop_listener(lst, force_endpoint=meeting)
        self._flush_translate_carry("stop")
        try:
            if self._workspace == "interview":
                self._cancel_interview_wait_timer()
                self._flush_interview_wait()
            else:
                self._commit_listener_tail(lst)
                self._flush_meeting_hold()
            # Close the open meeting line and drain queued finals so no half-sentence
            # survives into the next session (issue #29). Drain FIRST (queued finals
            # may re-open _open_line), then close (issue #31 P1-c).
            if not self._drain_meeting_after_stop():
                timeout = True
                logging.getLogger("nod").info("listen_flush worker drain timeout")
            self._close_open_line()
        finally:
            self._listen_gen = getattr(self, "_listen_gen", 0) + 1
            ok = (not timeout) and bool(getattr(self, "_listen_flush_history_ok", True))
            self._emit_listen_flush(ok=ok, timeout=timeout)
            self._listen_flush_done = True
            self._stop_flushing = False
            self._emit_phase()
            self.emit({"type": "status", "text": STATUS_READY})
            self._flush_cloud_archive(final=False)

    def _commit_listener_tail(self, lst: CloudListener | None) -> None:
        if getattr(self, "_workspace", "") != "meeting" or lst is None:
            return
        tail_fn = getattr(lst, "uncovered_tail", None)
        if not callable(tail_fn):
            return
        try:
            tail = tail_fn()
        except Exception:
            return
        if not isinstance(tail, dict) or not (tail.get("text") or "").strip():
            return
        meta: dict[str, Any] = {
            "first_word_ms": tail.get("first_word_ms"),
            "last_word_ms": tail.get("last_word_ms"),
            "n_words": tail.get("n_words") or 0,
            "stt_turn": tail.get("stt_turn"),
            "listener_id": id(lst),
            "fallback": True,
            "stop_commit": True,
        }
        logging.getLogger("nod").info(
            "listen_flush fallback stt_turn=%s text_len=%s",
            tail.get("stt_turn"),
            len(str(tail.get("text") or "")),
        )
        self._on_final(str(tail["text"]), tail.get("lang"), tail.get("speaker"), meta)

    def _emit_listen_flush(self, *, ok: bool, timeout: bool) -> None:
        self._listen_flush_seq = getattr(self, "_listen_flush_seq", 0) + 1
        client_id = getattr(self, "_listen_flush_client_id", None)
        self._listen_flush_client_id = None
        session_id = getattr(self, "usage_session_id", None) or ""
        logging.getLogger("nod").info(
            "listen_flush ok=%s timeout=%s seq=%s history_ok=%s flush_id=%s session=%s",
            ok,
            timeout,
            self._listen_flush_seq,
            getattr(self, "_listen_flush_history_ok", True),
            client_id or "",
            session_id,
        )
        ev: dict[str, Any] = {
            "type": "listen_flush",
            "id": str(self._listen_flush_seq),
            "ok": ok,
            "timeout": timeout,
        }
        if client_id:
            ev["flush_id"] = client_id
        if session_id:
            ev["session_id"] = session_id
        self.emit(ev)

    def _drain_meeting_after_stop(self) -> bool:
        deadline = time.monotonic() + MEETING_STOP_DRAIN_SEC
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            if getattr(self, "_workspace", "") == "meeting":
                self._flush_meeting_hold()
            self._stop_meeting_worker(wait=True, timeout=max(0.05, remaining))
            ptxt = (getattr(self, "_pending_wait", (None, 0.0, None)) or (None, 0.0, None))[0]
            q = getattr(self, "_meeting_finals", None)
            worker = getattr(self, "_meeting_worker_thread", None)
            alive = bool(worker is not None and worker.is_alive())
            busy = bool(getattr(self, "_meeting_worker_started", False) or alive)
            queued = bool(q is not None and not q.empty())
            if not ptxt and not busy and not queued:
                return True
            if deadline - time.monotonic() <= 0:
                return False

    def manual(self) -> None:
        if self._mic_muted:
            self.emit({"type": "status", "text": "Microphone is muted — unmute first"})
            return
        if self._manual:
            self._stop_manual()
            return
        if self._busy:
            return
        if self._listener:
            self.emit({"type": "status", "text": "Turn off Auto before recording"})
            return
        if not self._ensure_consent():
            return
        if not self._ensure_usage():
            return
        self._manual = True
        self._manual_buf = bytearray()
        self._manual_offset = 0
        self._manual_started = time.time()
        self._emit_phase()
        self.emit({"type": "status", "text": STATUS_RECORD})

    def _live_manual_captions(self) -> bool:
        return self._workspace in ("meeting", "translate")

    def _capture(self) -> str:
        """Single source of truth for the microphone/session axis.

        Precedence: recording (manual) > paused > listening > off. The engine
        axis is deliberately separate (see ``_engine``), so a model generating
        an answer no longer reads as "not listening" on the Watch.
        """
        if getattr(self, "_manual", False):
            return "recording"
        if getattr(self, "_paused", False):
            return "paused"
        if getattr(self, "_listener", None) is not None:
            return "listening"
        return "off"

    def _set_engine(self, engine: str) -> None:
        """Set the STT/LLM engine axis (idle/transcribing/generating).

        Pure setter: callers emit the phase right after, so the engine value
        rides along on the next ``_emit_phase``.
        """
        self._engine = engine

    def _emit_phase(self) -> None:
        """Emit the two-axis phase event (ADR 0001). ``capture`` is the single
        source of truth for the mic/session; ``engine`` is the STT/LLM axis.

        ``getattr`` keeps a ``Session.__new__``-built instance (tests, and any
        path that touches these before ``__init__`` runs) from failing.
        """
        self.emit({
            "type": "phase",
            "capture": self._capture(),
            "engine": getattr(self, "_engine", "idle"),
        })

    def _maybe_flush_manual_chunk(self, force: bool = False) -> None:
        if not self._live_manual_captions():
            return
        pending = len(self._manual_buf) - self._manual_offset
        pending_sec = pending / float(SR * 2)
        now = time.time()
        last = self._manual_last_voice or self._manual_started or now
        silent_sec = max(0.0, now - last)
        if not manual_chunk_ready(pending_sec, silent_sec, force=force):
            return
        with self._manual_lock:
            if not force and self._manual_jobs >= MANUAL_MAX_JOBS:
                return
        overlap = int(MANUAL_CHUNK_OVERLAP_SEC * SR * 2)
        start = 0 if self._manual_offset <= 0 else max(0, self._manual_offset - overlap)
        chunk = bytes(self._manual_buf[start:])
        self._manual_offset = len(self._manual_buf)
        if len(chunk) < int(MANUAL_MIN_SEC * SR * 2):
            return
        self._kick_manual_chunk(chunk)

    def _kick_manual_chunk(self, pcm: bytes) -> None:
        with self._manual_lock:
            self._manual_jobs += 1
        threading.Thread(target=self._finish_manual_chunk, args=(pcm,), daemon=True).start()

    def _transcribe_manual_pcm(self, pcm: bytes) -> tuple[str, str | None]:
        key = self.pipeline.assemblyai_key()
        if not key:
            raise RuntimeError("Missing AssemblyAI key")
        cfg = self._stt_cfg()
        try:
            return assemblyai_transcribe_accurate(key, pcm, cfg)
        except Exception as e:
            log.warning("accurate STT failed, falling back to realtime: %s", e)
            dur = len(pcm) / float(SR * 2)
            return assemblyai_transcribe_pcm(key, pcm, cfg, timeout=min(90.0, max(24.0, dur * 2 + 12)))

    def _polish_manual_text(self, text: str) -> str:
        src = (text or "").strip()
        if self._manual:
            return src
        recent = [t for t, _ in self._recent_finals[-4:]]
        return self.pipeline.repair_caption(src, recent)

    def _finish_manual_chunk(self, pcm: bytes) -> None:
        try:
            text, lang = self._transcribe_manual_pcm(pcm)
            if (text or "").strip():
                self._on_final(self._polish_manual_text(text), lang)
        except Exception as e:
            log.warning("record chunk failed: %s", e)
            if not self._manual:
                self.emit({"type": "error", "text": f"Transcription failed:{e}"})
        finally:
            with self._manual_lock:
                self._manual_jobs = max(0, self._manual_jobs - 1)
                if not self._manual and self._manual_jobs == 0:
                    self._emit_phase()
                    self.emit({"type": "status", "text": STATUS_READY})

    def _stop_manual(self) -> None:
        if self._live_manual_captions():
            self._manual = False
            self._maybe_flush_manual_chunk(force=True)
            self._manual_buf = bytearray()
            self._manual_offset = 0
            with self._manual_lock:
                if self._manual_jobs <= 0:
                    self._emit_phase()
                    self.emit({"type": "status", "text": STATUS_READY})
                else:
                    self._emit_phase()
                    self.emit({"type": "status", "text": STATUS_TRANSCRIBE})
            self._offer_save_history()
            return
        pcm = bytes(self._manual_buf)
        self._manual = False
        self._manual_buf = bytearray()
        self._manual_offset = 0
        dur = len(pcm) / (SR * 2)
        if dur < MANUAL_MIN_SEC:
            self._emit_phase()
            self.emit({"type": "status", "text": "Recording too short, try again"})
            return
        self._emit_phase()
        self.emit({"type": "status", "text": STATUS_TRANSCRIBE})
        threading.Thread(target=self._finish_manual, args=(pcm,), daemon=True).start()
        self._offer_save_history()

    def _finish_manual(self, pcm: bytes) -> None:
        self._set_engine("transcribing")
        try:
            text, lang = self._transcribe_manual_pcm(pcm)
        except Exception as e:
            self.emit({"type": "error", "text": f"Transcription failed:{e}"})
            self._set_engine("idle")
            self._emit_phase()
            return
        text = self._polish_manual_text(text)
        if not (text or "").strip():
            self.emit({"type": "status", "text": STATUS_EMPTY})
            self._set_engine("idle")
            self._emit_phase()
            return
        if self._workspace in ("translate", "meeting"):
            self._on_final(text, lang)
            self._set_engine("idle")
            self._emit_phase()
            return
        cleaned, _ = clean_transcript(text or "", None, self.pipeline._last_answer)
        if not cleaned:
            self.emit({"type": "status", "text": STATUS_EMPTY})
            self._set_engine("idle")
            self._emit_phase()
            return
        heard = lang or detect_question_lang(cleaned)
        if not self._speech_allowed(cleaned, lang or heard):
            self.emit({"type": "partial", "text": ""})
            self._set_engine("idle")
            self._emit_phase()
            return
        tok = self._claim_busy()
        if not tok:
            return
        self.pipeline._cancel.clear()
        self._set_engine("generating")
        try:
            self.pipeline.process_text(cleaned, "ask", heard)
        finally:
            if self._busy_token is tok:
                self._release_busy(tok)
                self._set_engine("idle")
                self._emit_phase()
                self._drain_pending_ask()

    def _drain_pending_ask(self) -> None:
        # Summarize/translate queued while busy must run after the current
        # generation, no matter which path (ask, manual, interview voice)
        # held the busy flag — otherwise they sit until the next question.
        if self._pending_asks:
            nxt, md, fl = self._pending_asks.pop(0)
            self.ask(nxt, fl, md)

    def ask(self, text, files=None, mode="ask") -> None:
        extra = attachments_to_prompt(files)
        images = attachment_images(files)
        user_text = (text or "").strip()
        names = [str((item or {}).get("name") or "file") for item in (files or []) if item]
        display = user_text
        if names and (not display or display in {"Please review the attached files.", "Please review the attached images."}):
            display = f"Please review: {', '.join(names)}"
        elif names and display and "--- Attached:" not in display:
            display = f"{display} ({', '.join(names)})"
        llm_text = f"{extra}\n\n{user_text}".strip() if extra and user_text else (extra or user_text)
        if not llm_text and not images:
            return
        if not llm_text:
            llm_text = "Please review the attached images."
            display = display or llm_text
        if files and mode == "ask":
            mode = "file_ask"
        if not self._ensure_usage():
            return
        body = llm_text
        if body.startswith(("[NOD_TRANSLATE", "[NOD_CATCH", "[NOD_ASK", "[NOD_NOTES")):
            nl = body.find("\n")
            body = body[nl + 1:].strip() if nl >= 0 else body
        if mode == "ask" and body.startswith("Translate to "):
            mode = "translate"
        if mode == "ask" and (body.startswith("Listener question:") or llm_text.lstrip().startswith("[NOD_ASK")):
            mode = "listen_ask"
        if mode == "ask" and (body.startswith("Write structured notes") or llm_text.lstrip().startswith("[NOD_NOTES")):
            mode = "notes"
        tok = self._claim_busy()
        if not tok:
            if mode == "ask" and self._workspace == "interview":
                self._pending_asks.append((user_text, mode, files))
                self.emit({"type": "status", "text": "Question queued · answering the previous one"})
                return
            if mode in ("translate", "notes", "listen_ask", "file_ask"):
                self._pending_asks.append((user_text, mode, files))
                return
            self.emit({"type": "status", "text": "Still working, please wait"})
            self.emit({"type": "done", "id": "", "stt": 0, "llm": 0, "ok": False})
            return
        self.pipeline._cancel.clear()
        self._set_engine("generating")
        self._emit_phase()

        def work():
            try:
                self.pipeline.process_text(llm_text, mode, images=images, display_text=display)
            finally:
                if self._busy_token is tok:
                    self._release_busy(tok)
                    self._set_engine("idle")
                    self._emit_phase()
                    self._drain_pending_ask()

        threading.Thread(target=work, daemon=True).start()

    def _speech_allowed(self, text: str, lang: str | None = None) -> bool:
        locked = self._speech_filter_lang()
        return matches_locked_speech(text, locked, lang)

    def _on_partial(self, text: str, lang: str | None = None, speaker: str | None = None) -> None:
        if not text:
            return
        self._mark_voice()
        if not self._speech_allowed(text, lang):
            self.emit({"type": "partial", "text": ""})
            return
        ev: dict[str, Any] = {"type": "partial", "text": text}
        if self._workspace == "translate":
            # Locked Translate From: the STT tag may be absent, so emit the
            # locked language rather than letting the client guess 'en' and
            # veto a Latin turn (the flash).
            tag = heard_lang_from_text(text, lang or self._effective_stt_lang())
            if tag:
                ev["language"] = tag
        elif lang:
            ev["language"] = lang
        if speaker:
            ev["speaker"] = speaker
        self.emit(ev)

    def _on_final(self, text: str, lang: str | None = None, speaker: str | None = None, meta: dict[str, Any] | None = None) -> None:
        meta = dict(meta or {})
        meta_gen = meta.get("listen_gen")
        if meta_gen is not None and meta_gen != getattr(self, "_listen_gen", 0):
            return
        if text:
            self._mark_voice()
        identity_turn = (
            meta.get("stt_turn") is not None
            or meta.get("fallback")
            or meta.get("revision")
            or meta.get("stop_commit")
        )
        recent = [t for t, _ in self._recent_finals[-3:]]
        cleaned, _reason = clean_transcript(
            text,
            None if identity_turn else recent,
            self.pipeline._last_answer,
            keep_fillers=self._workspace in ("meeting", "translate"),
        )
        if not cleaned:
            self.emit({"type": "partial", "text": ""})
            return
        if not self._speech_allowed(cleaned, lang):
            self.emit({"type": "partial", "text": ""})
            return
        now = time.time()
        if not identity_turn:
            for t, ts in self._recent_finals:
                if now - ts < 5.0 and _ratio(cleaned.lower(), t.lower()) > 0.85:
                    self.emit({"type": "partial", "text": ""})
                    return
        if self._workspace == "meeting" and meta.get("revision"):
            if self._apply_meeting_revision(cleaned, lang, speaker, meta):
                return
        if self._workspace == "translate":
            locked = self._effective_stt_lang()
            raw = cleaned
            carry = (getattr(self, "_translate_carry", "") or "").strip()
            joined = join_meeting_text(carry, raw) if carry else raw
            heard = heard_lang_from_text(joined, locked) if locked else heard_lang_from_text(joined, lang)
            if carry:
                head, tail = split_carry(joined)
                if not head:
                    self._emit_translate_pieces(joined, heard, speaker)
                    self._translate_carry = ""
                    return
                self._emit_translate_pieces(head, heard, speaker)
                self._translate_carry = tail
                return
            head, tail = split_carry(joined)
            if not head:
                self._translate_carry = tail
                return
            self._emit_translate_pieces(head, heard, speaker)
            self._translate_carry = tail
            return
        else:
            heard = heard_lang_from_text(cleaned, lang)
        if self._workspace == "meeting":
            self._enqueue_meeting_final(cleaned, lang, speaker, meta)
            return
        recent_qs = [h["q"] for h in self.pipeline._qa_history]
        with self._interview_lock:
            ptxt, pts, plang = self._pending_wait
            joined: str | None = None
            if ptxt and time.time() - pts < 2.0 and _same_speech_script(ptxt, cleaned):
                joined = _join_speech_frags(ptxt, cleaned)
            candidate = joined or cleaned
            verdict = guard_question(candidate, recent_qs, self.pipeline._last_answer)
            leftover: tuple[str, str | None] | None = None
            if verdict == "reject" and joined:
                # 拼起来不像问题，就按原来的方式各自处理
                candidate, verdict = cleaned, guard_question(cleaned, recent_qs, self.pipeline._last_answer)
                leftover = (ptxt, plang)
            if verdict == "reject" and _looks_like_lead_in(cleaned):
                verdict = "wait"          # 短前置片段先 hold，不直接丢
            if verdict == "wait":
                self._cancel_interview_wait_timer()
                self._pending_wait = (candidate, time.time(), plang or lang)
                self._schedule_interview_wait_flush()
                self.emit({"type": "partial", "text": candidate})
                self.emit({"type": "status", "text": STATUS_WAIT_MORE})
                return
            self._cancel_interview_wait_timer()
            self._pending_wait = (None, 0.0, None)
        # 锁外：原「各自处理」语义
        if leftover:
            self._on_final(*leftover)
        if verdict == "reject":
            self.emit({"type": "partial", "text": ""})
            return
        self._start_interview_answer(candidate, plang or lang)

    def _start_interview_answer(self, cleaned: str, lang: str | None) -> None:
        heard = heard_lang_from_text(cleaned, lang)
        self._remember_final(cleaned)
        self._maybe_follow_speech(cleaned, heard)
        tok = self._claim_busy()
        if not tok:
            self._pending_q.append((cleaned, lang))
            self.emit({"type": "status", "text": "Question queued · answering the previous one"})
            return
        self._run_interview_answer(cleaned, lang)

    def _run_interview_answer(self, cleaned: str, lang: str | None) -> None:
        heard = heard_lang_from_text(cleaned, lang)
        tok = self._busy_token
        self.pipeline._cancel.clear()
        self._set_engine("generating")
        self._emit_phase()
        self.emit({"type": "status", "text": STATUS_CHECK})

        def work():
            try:
                self.pipeline.process_text(cleaned, "ask", heard)
            finally:
                if self._busy_token is tok:
                    self._release_busy(tok)
                    self._set_engine("idle")
                    self._emit_phase()
                    nxt = None
                    tok2 = self._claim_busy() if self._pending_q else None
                    if tok2:
                        try:
                            nxt = self._pending_q.popleft()
                        except IndexError:
                            self._release_busy(tok2)
                    if nxt:
                        self._run_interview_answer(*nxt)
                    else:
                        self._drain_pending_ask()

        threading.Thread(target=work, daemon=True).start()


CFG = load_config()
KEYS = load_all_keys()
log = logging.getLogger("nod")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    setup_logging()
    init_db()
    try:
        backup_now()
    except Exception:
        log.exception("startup backup failed")

    def loop():
        while True:
            time.sleep(6 * 3600)
            try:
                backup_now()
            except Exception:
                log.exception("scheduled backup failed")

    def live_loop():
        from server.live import log_snapshot

        while True:
            time.sleep(60)
            try:
                log_snapshot()
            except Exception:
                log.exception("live snapshot failed")

    threading.Thread(target=loop, daemon=True, name="nod-backup").start()
    threading.Thread(target=live_loop, daemon=True, name="nod-live").start()
    yield


app = FastAPI(title="Nodpilot", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(PUBLIC_URL),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(CloudflareOriginMiddleware)
app.add_middleware(HostLockMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.include_router(commerce_router)
app.include_router(admin_router)


@app.get("/api/health")
def health():
    from server.db import engine

    db_ok = True
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("SELECT 1")
    except Exception:
        db_ok = False
    return {"ok": db_ok, "stt": "assemblyai", "audio": "browser-mic", "auth": not AUTH_DISABLED}


@app.post("/api/attach/extract")
async def attach_extract(request: Request, _user: User = Depends(current_user)):
    """Park uploaded files off the WebSocket. Ask messages over 200KB are dropped."""
    from server.ratelimit import allow, client_ip

    if attach_body_too_large(request.headers.get("content-length")):
        raise HTTPException(413, "Upload too large")
    if not allow(f"attach:{client_ip(request)}", 20, 60.0):
        raise HTTPException(429, "Too many uploads. Wait a moment.")
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(400, "Invalid upload") from exc
    files = body.get("files") if isinstance(body, dict) else None
    if not isinstance(files, list) or not files:
        raise HTTPException(400, "Attach a file first")
    if len(files) > ATTACH_MAX_FILES:
        raise HTTPException(400, "Up to 5 files")
    for item in files:
        data = (item or {}).get("data") if isinstance(item, dict) else None
        if attach_b64_too_large(data):
            raise HTTPException(413, "File too large")
    aid = store_attach_files(files)
    names = [str((item or {}).get("name") or "file") for item in files]
    return {"id": aid, "names": names}


@app.get("/api/config")
def api_config():
    # Public on purpose: the landing page bootstraps Clerk from this payload.
    # clerk_publishable_key is designed to be public (pk_*). No secrets here.
    return JSONResponse(public_config(CFG))


async def _user_from_ws_auth(ws: WebSocket):
    try:
        message = await asyncio.wait_for(ws.receive(), timeout=4)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        return None
    text = message.get("text") if message else None
    if not text:
        return None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None
    if payload.get("type") != "auth":
        return None
    return user_from_token((payload.get("token") or "").strip())


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    raw_headers = {k.decode("latin1"): v.decode("latin1") for k, v in (ws.scope.get("headers") or [])}
    ip = ws_client_ip(ws.client.host if ws.client else "", raw_headers)
    if not ws_connect(ip):
        from server.live import mark

        mark("ws_rejected")
        await ws.close(code=4408)
        return
    cookie_token = (ws.cookies.get(COOKIE_NAME) or "").strip()
    user = user_from_token(cookie_token) if cookie_token else None
    local = is_local_scope(ws.client.host if ws.client else "", ws.headers.get("host") or "")
    if user is None and local:
        from server.commerce import _ensure_local_user

        user = _ensure_local_user()
    await ws.accept()
    if not AUTH_DISABLED and user is None:
        user = await _user_from_ws_auth(ws)
        if user is None:
            try:
                await ws.send_text(json.dumps({"type": "auth_required"}))
                await ws.close(code=4401)
            except Exception:
                # Client disconnected inside the 4s auth window (tab closed,
                # network drop). uvicorn already tore the socket down; sending
                # now raises "unexpected websocket.send after websocket.close".
                pass
            ws_disconnect(ip)
            return
    loop = asyncio.get_running_loop()
    out: asyncio.Queue[str] = asyncio.Queue()

    def emit(obj: dict) -> None:
        from server.live import note_event

        note_event(obj)
        asyncio.run_coroutine_threadsafe(out.put(json.dumps(obj, ensure_ascii=False)), loop)

    from server.live import attach, detach

    attach_tok = (ws.query_params.get("attach") or "").strip()
    old = uplink.adopt(attach_tok, user.id) if attach_tok and user is not None else None
    if old is not None:
        old.emit = emit
        old.pipeline.emit = emit
        old._control_lost_at = 0.0
        attach(old)
        old.reattach()
        session = old
    else:
        session = Session(emit, json.loads(json.dumps(CFG)), dict(KEYS), user.id if user else None)
        uplink.register(session)
        attach(session)
        session.start()
    session._loop = loop
    if user:
        from server.meter import usage_snapshot

        emit({"type": "quota", **usage_snapshot(user.id)})

    async def sender():
        while True:
            msg = await out.get()
            await ws.send_text(msg)

    send_task = asyncio.create_task(sender())
    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break
            data = message.get("bytes")
            text = message.get("text")
            # Both paths run off the event loop: they reach blocking work
            # (STT handshake waits, metering queries, R2 uploads) and one slow
            # client used to stall audio for everyone else on the process.
            if data:
                if len(data) > MAX_WS_FRAME:
                    continue
                if not allow(f"wsframe:{ip}", WS_FRAMES_PER_SEC, 1.0):
                    continue
                await run_in_threadpool(session.push_pcm, data)
            elif text:
                if len(text) > 200_000:
                    emit({"type": "error", "text": "That file is too large to send this way. Try a smaller file."})
                    continue
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if not isinstance(payload, dict):
                    continue
                await run_in_threadpool(session.dispatch, payload)
    except WebSocketDisconnect:
        pass
    finally:
        send_task.cancel()
        ws_disconnect(ip)
        detach(session)
        if uplink.should_park(session):
            session._control_lost_at = time.time()
            session._detach_control_emit()
            uplink.park(session)
            return
        uplink.unregister(getattr(session, "audio_token", None))
        try:
            await run_in_threadpool(session.close)
        except asyncio.CancelledError:
            # Shutting down mid-session: finish the archive flush inline
            # rather than dropping the recording.
            session.close()
            raise
        except Exception:
            log.exception("session close failed")


@app.websocket("/ws/audio")
async def ws_audio(ws: WebSocket):
    raw_headers = {k.decode("latin1"): v.decode("latin1") for k, v in (ws.scope.get("headers") or [])}
    ip = ws_client_ip(ws.client.host if ws.client else "", raw_headers)
    if not ws_connect(ip):
        from server.live import mark

        mark("ws_rejected")
        await ws.close(code=4408)
        return
    token = (ws.query_params.get("token") or "").strip()
    session = uplink.get(token)
    if session is None:
        ws_disconnect(ip)
        await ws.close(code=4404)
        return
    if getattr(session, "_closed", False):
        ws_disconnect(ip)
        await ws.close(code=4404)
        return
    prev = getattr(session, "_audio_ws", None)
    await ws.accept()
    if prev is not None and prev is not ws:
        try:
            await prev.close()
        except Exception:
            pass
    session._audio_ws = ws
    session._replay_pcm_rejection()
    session._uplink_connected = True
    session._uplink_lost_at = 0.0
    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break
            data = message.get("bytes")
            text = message.get("text")
            if getattr(session, "_closed", False):
                break
            if data:
                if len(data) > MAX_WS_FRAME:
                    continue
                if not allow(f"wsframe:{ip}", WS_FRAMES_PER_SEC, 1.0):
                    continue
                await run_in_threadpool(session.push_pcm, data)
            elif text:
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if not isinstance(payload, dict):
                    continue
                mtype = payload.get("type")
                if mtype == "ping":
                    continue
                if mtype == "pcm_end":
                    await run_in_threadpool(
                        session.pcm_end,
                        payload.get("id"),
                        payload.get("byte_offset"),
                        payload.get("capture_id") or payload.get("captureId"),
                    )
    except WebSocketDisconnect:
        pass
    finally:
        ws_disconnect(ip)
        if getattr(session, "_audio_ws", None) is ws:
            session._audio_ws = None
            session._uplink_connected = False
            if uplink.is_parked(getattr(session, "audio_token", None)):
                session._uplink_lost_at = time.time()


HTML_NO_CACHE = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}

SITE_SPA_PAGES = frozenset(
    {
        "zh",
        "login",
        "signup",
        "sso-callback",
        "forgot",
        "reset",
        "account",
        "privacy",
        "terms",
        "consent",
        "admin",
    }
)

NOT_FOUND_HTML = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Not found — Nodpilot</title>
    <style>
      html, body { margin: 0; min-height: 100%; background: #07101f; color: #f2f6fb;
        font-family: 'IBM Plex Sans', system-ui, sans-serif; }
      main { box-sizing: border-box; width: min(calc(100% - 48px), 640px); margin: 0 auto; padding: 128px 0 72px; }
      a { color: #5bdaf4; }
    </style>
  </head>
  <body>
    <main>
      <p>Not found</p>
      <h1>This page is not on Nodpilot.</h1>
      <p><a href="/">Back to the homepage</a></p>
    </main>
  </body>
</html>
"""


def spa_kind(full_path: str) -> str:
    """Classify a catch-all path: site HTML, app shell, unknown API, or missing."""
    path = (full_path or "").lstrip("/")
    if path == "api" or path.startswith("api/"):
        return "api"
    if path == "app" or path.startswith("app/"):
        return "app"
    if path in SITE_SPA_PAGES or path.startswith("zh/"):
        return "site"
    return "unknown"


def _not_found_html() -> Response:
    headers = {**HTML_NO_CACHE, "X-Robots-Tag": "noindex, nofollow"}
    return Response(content=NOT_FOUND_HTML, status_code=404, media_type="text/html; charset=utf-8", headers=headers)


def _not_found_json() -> JSONResponse:
    return JSONResponse({"detail": "Not found"}, status_code=404)


@app.get("/robots.txt")
def robots():
    base = PUBLIC_URL.rstrip("/")
    body = "\n".join(
        [
            "User-agent: *",
            "Allow: /",
            "Disallow: /app",
            "Disallow: /account",
            "Disallow: /admin",
            "Disallow: /api/",
            "",
            "User-agent: GPTBot",
            "User-agent: OAI-SearchBot",
            "User-agent: ChatGPT-User",
            "User-agent: PerplexityBot",
            "User-agent: ClaudeBot",
            "User-agent: Google-Extended",
            "Allow: /",
            "Disallow: /app",
            "Disallow: /account",
            "Disallow: /admin",
            "Disallow: /api/",
            "",
            f"Sitemap: {base}/sitemap.xml",
            "",
        ]
    )
    return Response(content=body, media_type="text/plain; charset=utf-8")


@app.get("/sitemap.xml")
def sitemap():
    base = PUBLIC_URL.rstrip("/")
    paths = ["/", "/zh", "/privacy", "/terms", "/consent", "/signup", "/login"]
    urls = []
    for path in paths:
        loc = base + ("" if path == "/" else path)
        urls.append(f"  <url><loc>{loc}</loc><changefreq>weekly</changefreq></url>")
    body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "\n".join(urls) + "\n</urlset>\n"
    return Response(content=body, media_type="application/xml; charset=utf-8")


def _html_page(name: str) -> FileResponse:
    return FileResponse(
        WEB_DIST / name,
        media_type="text/html; charset=utf-8",
        headers=HTML_NO_CACHE,
    )


if WEB_DIST.exists():
    # A half-written dist (mid-rebuild, or a build that failed after emptying
    # the folder) must not take the whole app down at import time.
    if (WEB_DIST / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=str(WEB_DIST / "assets")), name="assets")

    def _icon_file(name: str, media_type: str) -> FileResponse:
        for path in (WEB_DIST / name, ROOT / "web" / "public" / name):
            if path.is_file():
                return FileResponse(path, media_type=media_type)
        raise HTTPException(404, "Icon not found")

    @app.get("/favicon.ico")
    def favicon_ico():
        return _icon_file("favicon.ico", "image/x-icon")

    @app.get("/favicon.svg")
    def favicon_svg():
        return _icon_file("favicon.svg", "image/svg+xml")

    @app.get("/favicon-48.png")
    def favicon_48():
        return _icon_file("favicon-48.png", "image/png")

    @app.get("/apple-touch-icon.png")
    def apple_touch_icon():
        return _icon_file("apple-touch-icon.png", "image/png")

    @app.get("/")
    def marketing_home():
        return _html_page("index.html")

    @app.get("/app")
    def workspace_home():
        page = WEB_DIST / "app.html"
        return _html_page("app.html") if page.exists() else _html_page("index.html")

    WEB_DIST_REAL = WEB_DIST.resolve()

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        kind = spa_kind(full_path)
        if kind == "app":
            page = WEB_DIST / "app.html"
            return _html_page("app.html") if page.exists() else _html_page("index.html")
        if kind == "api":
            return _not_found_json()
        # ASGI servers pass the unquoted path through without collapsing dot
        # segments, so "/..%2fdata%2fnod.db" arrives here as "../data/nod.db".
        # Resolve first, then refuse anything that escapes the build output.
        if full_path:
            try:
                dest = (WEB_DIST / full_path).resolve()
            except (OSError, ValueError):
                return _not_found_html()
            if dest.is_relative_to(WEB_DIST_REAL) and dest.is_file():
                return FileResponse(dest)
        if kind == "site":
            return _html_page("index.html")
        return _not_found_html()
