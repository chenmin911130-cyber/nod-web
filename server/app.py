#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Nod web engine: browser mic PCM → AssemblyAI cloud STT → LLM stream."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import queue
import re
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable
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
    matches_locked_speech,
    split_code_switched,
)
from server.logging_setup import backup_now, setup_logging
from server.settings import (
    AUTH_DISABLED,
    CLERK_PUBLISHABLE_KEY,
    COOKIE_NAME,
    LISTEN_IDLE_SECONDS,
    LISTEN_MAX_SECONDS,
    LISTEN_ZERO_PCM_SECONDS,
    PUBLIC_URL,
    QUOTA_DISABLED,
)
from server.ratelimit import MAX_WS_FRAME, WS_FRAMES_PER_SEC, allow, ws_client_ip, ws_connect, ws_disconnect
from server.security import current_user, is_local_scope, user_from_token

SR = 16000
STT_CLOUD = "assemblyai"
ASSEMBLYAI_WS = "wss://streaming.assemblyai.com/v3/ws"
ASSEMBLYAI_API = "https://api.assemblyai.com"
ASSEMBLYAI_MODEL = "universal-3-5-pro"
ASSEMBLYAI_FILE_MODELS = ["universal-3-5-pro", "universal-2"]
# Official close: {"type": "Terminate"}. Dropping the socket does not stop
# billing; unterminated sessions stay open and bill for up to 3 hours.
ASSEMBLYAI_TERMINATE = {"type": "Terminate"}
ASSEMBLYAI_TERMINATE_WAIT_SEC = 1.5
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
        "llm": {"model": "deepseek-v4-flash-vision-exp", "max_tokens": 1600, "temperature": 0.5, "provider": "deepseek"},
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
            base = f"{name} lecture."
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
        base = "Mandarin, English, and Japanese lecture. People switch languages mid-sentence."
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
        self._model = cfg["llm"].get("model", "deepseek-v4-flash-vision-exp")
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

    def _bilingual_from_tag(self, question: str) -> bool:
        return ":bi" in self._tag_inner(question).split("]")[0]

    def _out_lang_from_tag(self, question: str) -> str | None:
        inner = self._tag_inner(question)
        if not inner.startswith(("NOD_CATCH:", "NOD_ASK:", "NOD_NOTES:", "NOD_SUMMARY:")):
            return None
        parts = [p for p in inner.split(":")[1:] if p and p != "bi"]
        if not parts:
            return None
        last = parts[-1]
        if last == "auto":
            return None
        return _normalize_stt_lang(last)

    def _output_lang_rule(self, lang: str | None, bilingual: bool = False) -> str:
        name = _LANG_NAMES.get(lang or "", "the notes language, or Chinese if unclear")
        if bilingual:
            return (
                f"\nBILINGUAL (hard rule): Every sentence or bullet has TWO lines. "
                f"Line 1 is the transcript / source language. Line 2 starts with '>> ' then the {name} translation. "
                "Never output only one language."
            )
        if not lang:
            return ""
        return (
            f"\nOUTPUT LANGUAGE (hard rule): Write every sentence in {name} only. "
            "Do not follow the transcript language or any listener question language."
        )

    def _strip_nod_tag(self, question: str) -> str:
        text = question or ""
        if text.startswith(("[NOD_TRANSLATE", "[NOD_SUMMARY", "[NOD_CATCH", "[NOD_ASK", "[NOD_NOTES")):
            nl = text.find("\n")
            if nl >= 0:
                return text[nl + 1:].strip()
        return text

    def _is_internal(self, question: str, mode: str) -> bool:
        if mode in ("translate", "summary", "catchup", "notes", "listen_ask"):
            return True
        t = (question or "").lstrip()
        return t.startswith(("[NOD_TRANSLATE", "[NOD_SUMMARY", "[NOD_CATCH", "[NOD_ASK", "[NOD_NOTES", "Translate to "))

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
        out_lang = self._out_lang_from_tag(question)
        out_rule = self._output_lang_rule(out_lang, self._bilingual_from_tag(question))
        question = self._strip_nod_tag(question)
        if mode == "summary" or question.startswith("Summarize the following meeting transcript"):
            return [
                {
                    "role": "system",
                    "content": (
                        "You are a meeting notetaker. Write a recap the user can scan after the call.\n"
                        "Output exactly these sections, using short bullets:\n"
                        "- Key points\n- Decisions\n- Action items (include owner only if it was said)\n"
                        "No preamble. Do not invent people, numbers, or commitments." + out_rule
                    ),
                },
                {"role": "user", "content": question},
            ]
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
                        "If the line is already in the target language, return it unchanged. "
                        "Allowed targets: Chinese, English, Japanese, Italian, Spanish, French, German, Portuguese."
                    ),
                },
                {"role": "user", "content": question},
            ]
        if mode == "listen_ask" or question.startswith("Listener question:"):
            return [
                {
                    "role": "system",
                    "content": (
                        "You are a live listening assistant. The user may ask at any moment.\n"
                        "Answer their question clearly and briefly.\n"
                        "Use the transcript when it helps. If it is empty or silent on the topic, say so, then answer from general knowledge if the question allows it.\n"
                        "Do not invent quotes, names, numbers, or decisions that were not said.\n"
                        "4-10 short sentences or bullets. No preamble."
                        + out_rule
                    ),
                },
                {"role": "user", "content": question},
            ]
        if mode == "catchup" or question.startswith("Catch the listener up"):
            return [
                {
                    "role": "system",
                    "content": (
                        "You help someone who missed the last minute or two of a live conversation.\n"
                        "Cover ONLY the recent stretch they pasted. Listening is still going — do not write a full-session recap.\n"
                        "6-10 short sentences or bullets. Name decisions, numbers, and owners only if they were said.\n"
                        "If they asked a question, answer it from this stretch first."
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
                        "You write structured listening notes after a session ends.\n"
                        "Return JSON only. No markdown fence.\n"
                        "Keys: summary (string), takeaways, keyPoints, decisions, actionItems, "
                        "importantDetails, followUps, revisionNotes.\n"
                        "Lists are arrays of short strings. actionItems is an array of objects "
                        "{\"text\":\"...\",\"owner\":\"...\"} — omit owner if nobody was named.\n"
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
        elif mode in ("summary", "notes", "catchup", "listen_ask"):
            max_tokens = max(max_tokens, 1600)
        elif mode == "translate":
            max_tokens = max(max_tokens, 800)
        answer = ""
        stream_usage: tuple[int, int] | None = None
        messages = self._with_images(self._build_messages(t, mode), images)
        last_err: Exception | None = None
        for attempt in range(2):
            if seq != self._gen_seq or self._cancel.is_set():
                self.emit({"type": "done", "id": qid, "stt": 0, "llm": round(time.time() - t0, 2), "ok": False})
                return
            stream = None
            try:
                kwargs: dict[str, Any] = dict(
                    model=self._model,
                    messages=messages,
                    max_tokens=max_tokens,
                    stream=True,
                    stream_options={"include_usage": True},
                )
                if not str(self._model).startswith(("o1", "o3")):
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
        if mode not in ("translate", "summary", "catchup", "notes", "listen_ask"):
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
        from server.meter import consume_llm, save_history

        inp, out = resolve_llm_usage(stream_usage, t, answer)
        ok, snap = consume_llm(self.user_id, self.usage_session_id, inp, out)
        self.emit({"type": "quota", **snap})
        kind_q = "transcript" if mode in ("translate", "summary") else "question"
        if not internal:
            save_history(self.user_id, self.usage_session_id, kind_q, self._strip_nod_tag(t), qid)
        save_history(self.user_id, self.usage_session_id, "answer" if mode == "ask" else mode, answer, qid)
        if mode in ("ask", "summary", "notes"):
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
    def __init__(self, api_key: str, cfg: dict[str, Any], on_final, on_partial, on_error, on_drop=None):
        self.api_key = api_key
        self.cfg = cfg
        self.on_final = on_final
        self.on_partial = on_partial
        self.on_error = on_error
        self.on_drop = on_drop
        self._q: queue.Queue[bytes] = queue.Queue(maxsize=240)
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._fail: list[str] = []
        self._ws = None
        self._last_final = ""
        self._muted = False
        self._was_ready = False
        self._drop_sent = False
        self._terminated = threading.Event()
        self._turn_order = 0

    def set_muted(self, muted: bool) -> None:
        self._muted = bool(muted)

    def push_pcm(self, pcm: bytes) -> None:
        if self._muted or not pcm:
            return
        try:
            self._q.put_nowait(pcm)
        except queue.Full:
            try:
                self._q.get_nowait()
            except queue.Empty:
                return
            try:
                self._q.put_nowait(pcm)
            except queue.Full:
                pass

    def start(self) -> None:
        import websocket
        url = assemblyai_ws_url(self.cfg)
        self._stop.clear()
        self._ready.clear()
        self._terminated.clear()
        self._fail = []
        self._was_ready = False
        self._drop_sent = False
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
        threading.Thread(target=self._sender, daemon=True).start()

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

    def _sender(self) -> None:
        import websocket
        while not self._stop.is_set():
            try:
                chunk = self._q.get(timeout=0.08)
            except queue.Empty:
                continue
            ws = self._ws
            try:
                if ws and ws.sock and ws.sock.connected:
                    ws.send(chunk, websocket.ABNF.OPCODE_BINARY)
            except Exception as e:
                if not self._stop.is_set():
                    self._notify_drop(str(e))
                return

    def _on_message(self, _ws, message) -> None:
        try:
            data = json.loads(message)
        except (TypeError, json.JSONDecodeError):
            return
        kind = data.get("type")
        if kind == "Turn":
            text = (data.get("utterance") or data.get("transcript") or "").strip()
            if not text:
                return
            speechy = bool(re.search(r"[A-Za-z0-9\u00C0-\u024F\u4e00-\u9fff\u3040-\u30FF\uac00-\ud7af]", text))
            lang = heard_lang_from_turn(data)
            speaker = speaker_from_turn(data)
            if data.get("end_of_turn"):
                if data.get("turn_is_formatted") is False:
                    if speechy and self.on_partial:
                        self.on_partial(text, lang, speaker)
                    return
                cleaned = text.strip()
                if cleaned and cleaned != self._last_final:
                    self._last_final = cleaned
                    threading.Thread(target=self.on_final, args=(cleaned, lang, speaker), daemon=True).start()
                if os.environ.get("NOD_STT_TRACE") == "1":
                    # Instrument turn boundaries for the "English line every 10s /
                    # half-sentence cut" investigation (issue #22). Logging only.
                    self._turn_order += 1
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
                        "language_code=%s speakers=%s text=%s",
                        self._turn_order,
                        data.get("end_of_turn_confidence"),
                        len(words),
                        (first_w or {}).get("start"),
                        (last_w or {}).get("end"),
                        data.get("language_code") or lang,
                        word_speakers,
                        (cleaned or text)[:40],
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
            err = str(data.get("error") or message)
            self._terminated.set()
            if self.on_error:
                self.on_error(err)
            self._notify_drop(err)

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
        if self._stop.is_set():
            return
        extra = f"{status or ''} {msg or ''}".strip()
        if not self._ready.is_set():
            self._fail.append(f"AssemblyAI connection closed {extra}".strip())
            self._ready.set()
            return
        self._notify_drop(extra or "session closed")

    def stop(self) -> None:
        self._stop.set()
        ws = self._ws
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
        self._pending: tuple[str, str | None] | None = None
        self._pending_asks: list[tuple[str, str, Any]] = []
        self._pending_wait: tuple[str | None, float, str | None] = (None, 0.0, None)
        self._meeting_flush_timer: threading.Timer | None = None
        self._interview_wait_timer: threading.Timer | None = None
        self._meeting_lock = threading.Lock()
        self._follow_lang: str | None = None
        self._follow_switch_lang: str | None = None
        self._follow_switch_hits = 0
        self._recent_finals: list[tuple[str, float]] = []
        self._mic_muted = False
        self._workspace = "interview"
        self._pending_speaker: str | None = None
        self._stt_drops = 0
        self._stt_drop_at = 0.0
        self._listen_wanted = False
        self._listen_started_at = 0.0
        self._listen_accum_sec = 0.0
        self._last_pcm_at = 0.0
        self._last_voice_at = 0.0
        self._idle_check_at = 0.0
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

    def close(self) -> None:
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
        if self._listener:
            self._archive_append(pcm)
            self._listener.push_pcm(pcm)
            self._maybe_stop_forgotten_listen()

    def dispatch(self, msg: dict) -> None:
        mtype = msg.get("type")
        if mtype == "manual":
            self.manual()
        elif mtype == "toggle_listen":
            self.toggle_listen()
        elif mtype == "start_listen":
            self.start_listen()
        elif mtype == "stop_listen":
            self.stop_listen()
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
            self._pending = None
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

    def _claim_busy(self) -> bool:
        with self._busy_lock:
            if self._busy:
                return False
            self._busy = True
            return True

    def _release_busy(self) -> None:
        with self._busy_lock:
            self._busy = False

    def cancel_generate(self) -> None:
        """Cancel the in-flight LLM stream without stopping STT."""
        self.pipeline.abort_stream()
        self._pending_asks = []
        self._release_busy()

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

    def _stop_listener(self, lst: CloudListener | None) -> None:
        if not lst:
            return
        _drop_live_stt(self._stt_slot(), lst)
        try:
            lst.stop()
        except Exception:
            pass

    def _restart_listener(self) -> None:
        with self._listen_lock():
            if not self._listen_wanted:
                return
            lst = self._listener
            self._listener = None
            self._stop_listener(lst)
            self._start_listening(resume=True)

    def _on_listen_taken(self) -> None:
        """Another Session stole this user+workspace stream. Leave Listening.

        stop() already set _stop, so _notify_drop will not fire. Clear the
        latch and tell the UI. Do not cancel an in-flight answer.
        """
        self._paused = False
        self._listen_wanted = False
        self._pending = None
        self._cancel_stt_restart_timer()
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
        timer = self._meeting_flush_timer
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
        ptxt, _pts, plang = self._pending_wait
        self._pending_wait = (None, 0.0, None)
        if ptxt and self._workspace == "interview":
            self._start_interview_answer(ptxt, plang)

    def _flush_meeting_hold(self) -> None:
        with self._meeting_lock:
            self._cancel_meeting_timer()
            ptxt, _pts, plang = self._pending_wait
            speaker = self._pending_speaker
            self._pending_wait = (None, 0.0, None)
            self._pending_speaker = None
            workspace = self._workspace
        if ptxt and workspace == "meeting":
            self._emit_meeting_line(ptxt, plang, speaker)

    def _emit_meeting_line(self, cleaned: str, lang: str | None, speaker: str | None = None) -> None:
        heard = heard_lang_from_text(cleaned, lang)
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
            if self.user_id and self.usage_session_id:
                from server.meter import save_history

                save_history(self.user_id, self.usage_session_id, "transcript", piece, qev["id"], qev.get("speaker") or "")

    def _hold_or_emit_meeting(self, cleaned: str, lang: str | None, speaker: str | None = None) -> None:
        leftover: tuple[str, str | None, str | None] | None = None
        hold_now = False
        with self._meeting_lock:
            ptxt, pts, plang = self._pending_wait
            now = time.time()
            if ptxt and now - pts < 2.8 and _same_speech_script(ptxt, cleaned):
                cleaned = _join_speech_frags(ptxt, cleaned)
                lang = plang or lang
                speaker = self._pending_speaker or speaker
                self._pending_wait = (None, 0.0, None)
                self._pending_speaker = None
            elif ptxt:
                leftover = (ptxt, plang, self._pending_speaker)
                self._pending_wait = (None, 0.0, None)
                self._pending_speaker = None
            if _meeting_should_hold(cleaned):
                self._pending_wait = (cleaned, now, lang)
                self._pending_speaker = speaker
                self._cancel_meeting_timer()
                timer = threading.Timer(1.0, self._flush_meeting_hold)
                timer.daemon = True
                self._meeting_flush_timer = timer
                timer.start()
                hold_now = True
            else:
                self._cancel_meeting_timer()
        if leftover:
            self._emit_meeting_line(leftover[0], leftover[1], leftover[2])
        if hold_now:
            ev: dict[str, Any] = {"type": "partial", "text": cleaned}
            if lang:
                ev["language"] = lang
            if speaker:
                ev["speaker"] = speaker
            self.emit(ev)
            return
        self._emit_meeting_line(cleaned, lang, speaker)

    def set_workspace(self, mode: str, scene: Any = None, speakers_expected: Any = None) -> None:
        if mode not in ("interview", "meeting", "translate"):
            mode = "interview"
        prev = self._workspace
        prev_lang = self._effective_stt_lang(prev)
        prev_url = assemblyai_ws_url(self._stt_cfg()) if self._listener else ""
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
        self._pending = None
        self._pending_asks = []
        # 丢弃 hold 住的半句会议内容（不 flush）：模式切换后 emit 的 question 事件
        # 会被前端路由到新 workspace（如 translate 下变成垃圾翻译对）
        with self._meeting_lock:
            self._cancel_meeting_timer()
            self._cancel_interview_wait_timer()
            self._pending_wait = (None, 0.0, None)
            self._pending_speaker = None
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

    def start_listen(self) -> None:
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

    def stop_listen(self) -> None:
        self._paused = False
        self._listen_wanted = False
        if self._manual:
            self._stop_manual()
            return
        if self._listener:
            self._stop_listening()
        else:
            self._emit_phase()
            self.emit({"type": "status", "text": STATUS_READY})
        self._offer_save_history()

    def pause_listen(self) -> None:
        """Pause live capture and stop AssemblyAI billing.

        ``capture`` stays ``paused`` so the Watch does not treat this as Stop.
        The cloud socket is Terminated; Resume opens a new stream.
        """
        if self._listener is None and not self._manual:
            self.emit({"type": "status", "text": "Not listening"})
            return
        if self._manual:
            # Manual recording (F2) has no listen snapshot to pause. Don't stash
            # a dormant paused state that would surface after the recording ends.
            self.emit({"type": "status", "text": "Not listening"})
            return
        self._paused = True
        if self._listener:
            # Bank the just-listened segment into the accumulated 2h quota so
            # the wall-clock pause doesn't keep consuming the cap.
            self._listen_accum_sec = getattr(self, "_listen_accum_sec", 0.0) + (time.time() - self._listen_started_at)
            with self._listen_lock():
                lst = self._listener
                self._listener = None
            self._stop_listener(lst)
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
            return
        keep_content = content is not False
        keep_audio = audio is not False
        if not keep_content and not keep_audio:
            self.discard_history(session_id=sid)
            return
        self._flush_cloud_archive(final=False)
        from server.meter import keep_usage_session

        keep_usage_session(self.user_id, sid, keep_content=keep_content, keep_audio=keep_audio)
        parts = [name for on, name in ((keep_content, "session"), (keep_audio, "recording")) if on]
        self.emit({"type": "status", "text": "Saved to History · " + " and ".join(parts)})

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
        listener = CloudListener(
            api_key=key,
            cfg=self._stt_cfg(),
            on_final=self._on_final,
            on_partial=self._on_partial,
            on_error=lambda e: self.emit({"type": "error", "text": f"Transcription failed:{e}"}),
            on_drop=self._on_stt_drop,
        )
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
        if now - last_pcm >= LISTEN_ZERO_PCM_SECONDS:
            self._paused = False
            self._listen_wanted = False
            self._stop_listening()
            self.emit({"type": "status", "text": f"No microphone audio received for {int(LISTEN_ZERO_PCM_SECONDS)} seconds — stopped listening. Tap Start to retry."})
            self._offer_save_history()
            return
        if now - last >= LISTEN_IDLE_SECONDS:
            self._paused = False
            self._listen_wanted = False
            self._stop_listening()
            self.emit({"type": "status", "text": "Listening stopped after 15 minutes of silence."})
            self._offer_save_history()

    def _stop_listening(self) -> None:
        self._listen_accum_sec = 0.0  # session over; reset the accumulated quota
        self._last_pcm_at = 0.0  # zero-PCM guard must not carry into the next session
        self._pending = None
        self._cancel_stt_restart_timer()
        with self._listen_lock():
            lst = self._listener
            self._listener = None
        self._stop_listener(lst)
        if self._workspace == "interview":
            self._cancel_interview_wait_timer()
            self._flush_interview_wait()
        else:
            self._flush_meeting_hold()
        self._emit_phase()
        self.emit({"type": "status", "text": STATUS_READY})
        self._flush_cloud_archive(final=False)

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
        if not self._claim_busy():
            return
        self.pipeline._cancel.clear()
        self._set_engine("generating")
        try:
            self.pipeline.process_text(cleaned, "ask", heard)
        finally:
            self._release_busy()
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
        if body.startswith(("[NOD_TRANSLATE", "[NOD_SUMMARY", "[NOD_CATCH", "[NOD_ASK", "[NOD_NOTES")):
            nl = body.find("\n")
            body = body[nl + 1:].strip() if nl >= 0 else body
        if mode == "ask" and body.startswith("Summarize the following meeting transcript"):
            mode = "summary"
        if mode == "ask" and body.startswith("Translate to "):
            mode = "translate"
        if mode == "ask" and (body.startswith("Catch the listener up") or llm_text.lstrip().startswith("[NOD_CATCH")):
            mode = "catchup"
        if mode == "ask" and (body.startswith("Listener question:") or llm_text.lstrip().startswith("[NOD_ASK")):
            mode = "listen_ask"
        if mode == "ask" and (body.startswith("Write structured notes") or llm_text.lstrip().startswith("[NOD_NOTES")):
            mode = "notes"
        if not self._claim_busy():
            if mode in ("translate", "summary", "catchup", "notes", "listen_ask", "file_ask"):
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
                self._release_busy()
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

    def _on_final(self, text: str, lang: str | None = None, speaker: str | None = None) -> None:
        if text:
            self._mark_voice()
        recent = [t for t, _ in self._recent_finals[-3:]]
        cleaned, _reason = clean_transcript(
            text,
            recent,
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
        for t, ts in self._recent_finals:
            if now - ts < 5.0 and _ratio(cleaned.lower(), t.lower()) > 0.85:
                self.emit({"type": "partial", "text": ""})
                return
        if self._workspace == "translate":
            locked = self._effective_stt_lang()
            # A locked Translate From: emit the locked language so the turn
            # stays semantically clean, instead of a mis-tagged/guessed 'en'.
            heard = heard_lang_from_text(cleaned, locked) if locked else heard_lang_from_text(cleaned, lang)
        else:
            heard = heard_lang_from_text(cleaned, lang)
        if self._workspace == "translate":
            # 不取消在途翻译：取消会让被中断的句子等 25s 超时重试（双倍 token + 字幕卡死）。
            # 新 final 照常入队，前端 pump 一次只发一条，翻译自然串行。
            self._pending = None
            self._pending_wait = (None, 0.0, None)
            for piece in split_code_switched(cleaned):
                piece_heard = heard_lang_from_text(piece, heard)
                self._maybe_follow_speech(piece, piece_heard)
                self._remember_final(piece)
                ev: dict[str, Any] = {"type": "question", "id": self.pipeline._new_qid(), "text": piece}
                if piece_heard:
                    ev["language"] = piece_heard
                if speaker:
                    ev["speaker"] = speaker
                self.emit(ev)
            return
        if self._workspace == "meeting":
            self._hold_or_emit_meeting(cleaned, lang, speaker)
            return
        recent_qs = [h["q"] for h in self.pipeline._qa_history]
        verdict = guard_question(cleaned, recent_qs, self.pipeline._last_answer)
        if verdict == "wait":
            ptxt, pts, plang = self._pending_wait
            if ptxt and time.time() - pts < 2.0 and _same_speech_script(ptxt, cleaned):
                self._cancel_interview_wait_timer()
                self._pending_wait = (None, 0.0, None)
                self._on_final(_join_speech_frags(ptxt, cleaned), plang or lang)
            elif ptxt:
                leftover, leftover_lang = ptxt, plang
                self._cancel_interview_wait_timer()
                self._pending_wait = (None, 0.0, None)
                self._on_final(leftover, leftover_lang)
                self._on_final(cleaned, lang)
            else:
                self._pending_wait = (cleaned, time.time(), lang)
                self._schedule_interview_wait_flush()
                self.emit({"type": "partial", "text": cleaned})
                self.emit({"type": "status", "text": STATUS_WAIT_MORE})
            return
        self._cancel_interview_wait_timer()
        self._pending_wait = (None, 0.0, None)
        if verdict == "reject":
            self.emit({"type": "partial", "text": ""})
            return
        self._start_interview_answer(cleaned, lang)

    def _start_interview_answer(self, cleaned: str, lang: str | None) -> None:
        heard = heard_lang_from_text(cleaned, lang)
        self._remember_final(cleaned)
        self._maybe_follow_speech(cleaned, heard)
        if not self._claim_busy():
            self._pending = (cleaned, lang)
            return
        self.pipeline._cancel.clear()
        self._set_engine("generating")
        self._emit_phase()
        self.emit({"type": "status", "text": STATUS_CHECK})

        def work():
            try:
                self.pipeline.process_text(cleaned, "ask", heard)
            finally:
                self._release_busy()
                self._set_engine("idle")
                self._emit_phase()
                pending = self._pending
                self._pending = None
                if pending:
                    ptxt, plang = pending
                    self._on_final(ptxt, plang)
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

    session = Session(emit, json.loads(json.dumps(CFG)), dict(KEYS), user.id if user else None)
    from server.live import attach, detach

    attach(session)
    session.start()
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
        try:
            await run_in_threadpool(session.close)
        except asyncio.CancelledError:
            # Shutting down mid-session: finish the archive flush inline
            # rather than dropping the recording.
            session.close()
            raise
        except Exception:
            log.exception("session close failed")


HTML_NO_CACHE = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}


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
        if full_path == "app" or full_path.startswith("app/"):
            page = WEB_DIST / "app.html"
            return _html_page("app.html") if page.exists() else _html_page("index.html")
        # ASGI servers pass the unquoted path through without collapsing dot
        # segments, so "/..%2fdata%2fnod.db" arrives here as "../data/nod.db".
        # Resolve first, then refuse anything that escapes the build output.
        if full_path:
            try:
                dest = (WEB_DIST / full_path).resolve()
            except (OSError, ValueError):
                return _html_page("index.html")
            if dest.is_relative_to(WEB_DIST_REAL) and dest.is_file():
                return FileResponse(dest)
        return _html_page("index.html")
