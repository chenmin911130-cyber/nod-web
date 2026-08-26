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
from urllib.parse import urlencode, urlparse

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from openai import OpenAI

from server.admin import router as admin_router
from server.commerce import router as commerce_router
from server.db import init_db
from server.headers import CloudflareOriginMiddleware, SecurityHeadersMiddleware
from server.logging_setup import backup_now, setup_logging
from server.settings import AUTH_DISABLED, CLERK_PUBLISHABLE_KEY, COOKIE_NAME, PUBLIC_URL, QUOTA_DISABLED
from server.ratelimit import MAX_WS_FRAME, ws_client_ip, ws_connect, ws_disconnect
from server.security import is_local_scope, user_from_token

SR = 16000
STT_CLOUD = "assemblyai"
ASSEMBLYAI_WS = "wss://streaming.assemblyai.com/v3/ws"
ASSEMBLYAI_MODEL = "universal-3-5-pro"
STATUS_READY = "Ready · F2 record / F3 listen / F4 clear · browser mic + cloud STT"
STATUS_RECORD = "Recording · tap Listening / F2 to stop"
STATUS_LISTEN = "Listening for the next question…"
STATUS_TRANSCRIBE = "Transcribing…"
STATUS_CHECK = "Checking question…"
STATUS_GENERATE = "Generating answer…"
STATUS_ANSWER_READY = "Answer ready"
STATUS_WAIT_MORE = "I caught part of a question. Keep listening…"
STATUS_EMPTY = "No speech detected, please try again"
MANUAL_MAX_SEC = 30 * 60.0 if QUOTA_DISABLED else 120.0
MANUAL_MIN_SEC = 0.4

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
    "please subscribe", "please like", "like and subscribe", "字幕", "謝謝收看",
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
    "define", "describe", "?", "吗", "么", "什么", "为什么", "怎么", "如何",
    "介绍一下", "说说", "谈谈", "讲一下",
)
_STT_BOOST_FIXED = [
    "Python", "C#", "ASP.NET", "SQL", "database", "API", "frontend", "backend",
    "full-stack", "algorithm", "interview", "experience", "project",
]


def _ratio(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def load_all_keys() -> dict[str, str]:
    names = ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "ASSEMBLYAI_API_KEY"]
    keys: dict[str, str] = {}
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
            "target_role": "Software Engineer",
            "company": "",
            "resume_summary": "",
            "jd": "",
            "style": "简洁结构化：先给结论，再 2-3 点展开；行为题用 STAR；语言口语化、可直接照着念。",
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


_TRANSLATE_LANGS = ("zh", "ja", "en", "it", "es", "fr", "de", "pt")
# English first so mixed rooms do not collapse English into Chinese.
_STT_AUTO_LANGS = ("en", "zh", "ja")
_LANG_NAMES = {
    "zh": "Chinese",
    "ja": "Japanese",
    "en": "English",
    "it": "Italian",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "pt": "Portuguese",
}
_LANG_ALIASES = {"cmn": "zh", "yue": "zh", "jp": "ja", "chi": "zh"}


def _normalize_translate_to(lang: Any) -> str:
    if isinstance(lang, str) and lang in _TRANSLATE_LANGS:
        return lang
    return "zh"


def _normalize_any_lang(lang: Any) -> str | None:
    if isinstance(lang, str) and lang in _TRANSLATE_LANGS:
        return lang
    return None


def _normalize_translate_from(lang: Any) -> str | None:
    if lang in (None, "", "auto"):
        return None
    return _normalize_any_lang(lang)


def _normalize_stt_lang(lang: Any) -> str | None:
    return _normalize_any_lang(lang)


def _confident_stt_lang(text: str, heard: str | None) -> str | None:
    raw = heard if heard in _STT_AUTO_LANGS else detect_question_lang(text)
    if raw not in _STT_AUTO_LANGS:
        return None
    t = (text or "").strip()
    han = len(re.findall(r"[\u4e00-\u9fff]", t))
    kana = len(re.findall(r"[\u3040-\u30FF]", t))
    latin = len(re.findall(r"[A-Za-z]", t))
    if raw == "zh" and han >= 2:
        return "zh"
    if raw == "ja" and kana >= 2:
        return "ja"
    if raw == "en" and latin >= 16 and han < 2 and kana < 2:
        return "en"
    return None


def heard_lang_from_code(raw: Any) -> str | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    code = raw.strip().lower().replace("_", "-").split("-", 1)[0]
    code = _LANG_ALIASES.get(code, code)
    return _normalize_any_lang(code)


def heard_lang_from_turn(data: dict[str, Any]) -> str | None:
    return heard_lang_from_code(data.get("language_code") or data.get("language"))


def public_config(cfg: dict[str, Any]) -> dict[str, Any]:
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
    }


def _stt_boost_words(cfg: dict[str, Any]) -> list[str]:
    words = list(_STT_BOOST_FIXED)
    seen = {w.lower() for w in words}
    p = cfg.get("profile") or {}
    for text in (p.get("resume_summary") or "", p.get("jd") or ""):
        for tok in re.split(r"[，。、,.;；:：\s()（）/+\\-]+", text):
            tok = tok.strip()
            if len(tok) >= 2 and re.search(r"[A-Za-z]", tok) and tok.lower() not in seen:
                words.append(tok)
                seen.add(tok.lower())
    for tok in (cfg.get("stt") or {}).get("vocabulary") or []:
        tok = str(tok).strip()
        if len(tok) >= 2 and tok.lower() not in seen:
            words.append(tok)
            seen.add(tok.lower())
    return words[:50]


def _speech_script(text: str) -> str:
    t = text or ""
    han = len(re.findall(r"[\u4e00-\u9fff]", t))
    kana = len(re.findall(r"[\u3040-\u30FF]", t))
    latin = len(re.findall(r"[A-Za-z]", t))
    if kana >= 2 and kana >= han:
        return "ja"
    if han >= 2 and han >= latin:
        return "zh"
    if latin >= 3:
        return "en"
    return ""


def _same_speech_script(left: str, right: str) -> bool:
    a = _speech_script(left)
    b = _speech_script(right)
    return not a or not b or a == b


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


def split_code_switched(text: str) -> list[str]:
    """Keep spoken languages on separate lines. Never rewrite one language into another."""
    raw = (text or "").strip()
    if not raw:
        return []
    parts = [p.strip() for p in re.split(r"(?<=[。！？.!?])\s+", raw) if p.strip()]
    if len(parts) <= 1:
        return [raw]
    out: list[str] = []
    buf = parts[0]
    for part in parts[1:]:
        if _same_speech_script(buf, part):
            joiner = "" if buf.endswith(("。", "！", "？", ".", "!", "?", "…")) else " "
            buf = f"{buf}{joiner}{part}"
        else:
            out.append(buf)
            buf = part
    if buf:
        out.append(buf)
    return out or [raw]


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


def assemblyai_ws_url(cfg: dict[str, Any]) -> str:
    stt = cfg.get("stt") or {}
    silence = str(stt.get("max_turn_silence") or "1600")
    params = [
        ("sample_rate", str(SR)),
        ("speech_model", ASSEMBLYAI_MODEL),
        ("format_turns", "true"),
        ("max_turn_silence", silence),
    ]
    lang = _normalize_any_lang(stt.get("language"))
    auto_langs = stt.get("auto_langs") or _STT_AUTO_LANGS
    for code in ((lang,) if lang else auto_langs):
        params.append(("language_codes", code))
    if not lang:
        params.append((
            "prompt",
            "Multilingual conversation in English and Mandarin. Speakers switch languages mid-sentence.",
        ))
    boost = _stt_boost_words(cfg)
    if boost:
        params.append(("word_boost", ",".join(boost)))
        params.append(("boost_param", "medium"))
    return ASSEMBLYAI_WS + "?" + urlencode(params)


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
    if last_answer and len(last_answer) > 12:
        a = last_answer.lower()
        if _ratio(low, a) > 0.7 or (len(low) > 15 and low in a):
            return "", "echo"
    return t, ""


_NON_EN_MARKS = re.compile(r"[¿¡ñßœæçàâèéêëîïôùûÿáíóúüäöãõìò]")
_NON_EN_WORDS = re.compile(
    r"\b(?:hola|gracias|buenos|bonjour|bonsoir|merci|salut|pourquoi|êtes|\bça\b|wie geht|"
    r"nicht|danke|bitte|guten|você|não|olá|obrigado|perché|ciao|grazie|più|"
    r"cómo|estás|usted|quién|dónde|también|comment ça|comment ca|como estas|"
    r"qué tal|que tal)\b",
    re.I,
)
_CJK_OR_HANGUL = re.compile(r"[\u4e00-\u9fff\u3040-\u30FF\uac00-\ud7af]")


def detect_question_lang(text: str) -> str:
    """Guess speech language among the eight product languages."""
    t = text or ""
    kana = len(re.findall(r"[\u3040-\u30FF]", t))
    han = len(re.findall(r"[\u4e00-\u9fff]", t))
    latin = len(re.findall(r"[A-Za-zÀ-ÿ]", t))
    if kana >= 2 or (kana and (han + kana) >= latin):
        return "ja"
    if han >= 2 and han >= max(3, latin * 0.4):
        return "zh"
    if han > latin:
        return "zh"
    low = t.lower()
    if re.search(r"[¿¡ñ]|cómo|está[s]?|qué |hola\b", low):
        return "es"
    if re.search(r"[çœæ]|à |è |ê|pourquoi|bonjour|ça\b|vous ", low):
        return "fr"
    if re.search(r"[äöüß]|nicht\b|\bund\b|\bich\b|wie geht", low):
        return "de"
    if re.search(r"perché|ciao\b|grazie|più", low):
        return "it"
    if re.search(r"[ãõ]|você|não|olá", low):
        return "pt"
    return "en"


def matches_locked_speech(text: str, locked: str | None, heard: str | None = None) -> bool:
    """True if this transcript should be shown while Translate From is locked."""
    if not locked:
        return True
    t = (text or "").strip()
    if not t:
        return False
    if heard and heard != locked:
        return False
    guessed = detect_question_lang(t)
    if locked == "en":
        if _CJK_OR_HANGUL.search(t) or _NON_EN_MARKS.search(t) or _NON_EN_WORDS.search(t):
            return False
        return guessed == "en"
    if locked == "zh":
        if re.search(r"[\u3040-\u30FF\uac00-\ud7af]", t):
            return False
        return bool(re.search(r"[\u4e00-\u9fff]", t)) or guessed == "zh"
    if locked == "ja":
        return bool(re.search(r"[\u3040-\u30FF]", t)) or guessed == "ja"
    if _CJK_OR_HANGUL.search(t):
        return False
    return guessed == locked


def guard_question(text: str, recent_questions, last_answer=None) -> str:
    t = (text or "").strip()
    if not t:
        return "reject"
    low = t.lower()
    if low in _STT_SOCIAL_WORDS or len(t) < 4:
        return "reject"
    if last_answer and len(last_answer) > 12:
        a = last_answer.lower()
        if _ratio(low, a) > 0.7 or (len(low) > 15 and low in a):
            return "reject"
    if recent_questions:
        for q in recent_questions[-2:]:
            if q and _ratio(low, q.lower()) > 0.9:
                return "reject"
    if any(w in low for w in GUARD_Q_WORDS) or len(t) >= 18:
        if t.endswith((",", "，", "、")) or low.endswith((" and", " or", " the", " a")):
            return "wait"
        return "accept"
    if len(t) >= 10:
        return "wait"
    return "reject"


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
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext in ("txt", "md") or mime.startswith("text/"):
            body = raw.decode("utf-8", errors="replace")[:12000]
        elif ext == "pdf" or mime == "application/pdf":
            try:
                from pypdf import PdfReader
                from io import BytesIO
                reader = PdfReader(BytesIO(raw))
                body = "\n".join((p.extract_text() or "") for p in reader.pages)[:12000]
                body = body or f"[PDF attached: {name}, no extractable text.]"
            except Exception as e:
                body = f"[Could not read {name}: {e}]"
        elif mime.startswith("image/"):
            body = f"[Image attached: {name}. The model can see this image.]"
        else:
            body = f"[Attached file: {name}]"
        blocks.append(f"--- Attached: {name} ---\n{body}")
    return "\n\n".join(blocks)


def attachment_images(files) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in files or []:
        mime = (item or {}).get("mime") or ""
        data = (item or {}).get("data") or ""
        name = (item or {}).get("name") or "image"
        if mime.startswith("image/") and data:
            out.append({"name": name, "mime": mime, "data": data})
    return out[:4]


def assemblyai_transcribe_pcm(api_key: str, pcm: bytes, cfg: dict[str, Any], timeout: float = 18.0) -> tuple[str, str | None]:
    import websocket
    result = {"text": "", "lang": None, "err": None}
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
                    ws.send(json.dumps({"type": "Terminate"}))
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
                result["text"] = t
                result["lang"] = heard_lang_from_turn(data) or result.get("lang")
            if data.get("end_of_turn"):
                done.set()
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
    try:
        ws.close()
    except Exception:
        pass
    if result["err"] and not result["text"]:
        raise RuntimeError(result["err"])
    return result["text"], result.get("lang")


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
        self.user_id: str | None = None
        self.usage_session_id: str | None = None
        self._heard_lang: str | None = None

    def _new_qid(self) -> str:
        return f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"

    def assemblyai_key(self) -> str:
        return (self._keys.get("ASSEMBLYAI_API_KEY") or "").strip()

    def _make_client(self) -> OpenAI:
        endpoint = PROVIDER_ENDPOINTS.get(self._provider, PROVIDER_ENDPOINTS["deepseek"])
        key = (self._keys.get(PROVIDER_KEY.get(self._provider, "DEEPSEEK_API_KEY"), "") or "").strip() or "missing"
        return OpenAI(api_key=key, base_url=endpoint)

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
                "LANGUAGE (hard rule): The interviewer asked in Chinese. "
                "Answer in Chinese only. Do not switch to English except for proper nouns and tech terms."
            )
        return (
            f"LANGUAGE (hard rule): The interviewer asked in {name}. "
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
        if not inner.startswith(("NOD_CATCH:", "NOD_ASK:", "NOD_NOTES:")):
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
                        "No preamble. Do not invent people, numbers, or commitments."
                    ),
                },
                {"role": "user", "content": question},
            ]
        if mode == "translate" or question.startswith("Translate to "):
            return [
                {
                    "role": "system",
                    "content": (
                        "You are a translator for live captions.\n"
                        "Translate ONLY the line after 'Translate only this line:'. "
                        "Lines under 'Previous lines' are context for names, topic, and source language — do not translate them.\n"
                        "Output ONLY the translation — no quotes, labels, notes, or preamble.\n"
                        "Preserve proper nouns, product names, and numbers. "
                        "If the line is already in the target language, return it unchanged. "
                        "Do not invent a language that is not Chinese, English, or Japanese."
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
        sys_msg = (
            "You are a senior interview coach helping a candidate answer questions in real time.\n"
            f"Candidate background: {p.get('resume_summary') or ''}\n"
            f"Target role: {p.get('target_role') or 'Software Engineer'}"
            + (f" / Company: {p.get('company')}" if p.get("company") else "")
            + (f"\nJob description (JD): {p.get('jd')}" if p.get("jd") else "")
            + "\n\nYou answer ONLY the user's confirmed question.\n"
            + self._lang_rule(question)
            + "\n\nAnswer rules:\n1. Output a complete answer the candidate can read aloud verbatim.\n"
            f"2. Style: {p.get('style') or ''}\n"
            "3. Speed mode: 60-100 words, 3-5 sentences, lead with the conclusion.\n"
            "4. Technical questions: accurate answer + brief reason; behavioral: STAR.\n"
            "5. Follow the LANGUAGE hard rule above even if the resume or style notes are in another language.\n"
            + ctx
        )
        lang = self._answer_lang(question)
        name = _LANG_NAMES.get(lang, "English")
        lang_line = f"Answer language: {name} only."
        return [
            {"role": "system", "content": sys_msg},
            {"role": "user", "content": f"Interviewer question: {question}\n\n{lang_line}\n\nAnswer:"},
        ]

    def process_text(self, question: str, mode: str = "ask", heard_lang: str | None = None, images: list | None = None) -> None:
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
                self.emit({"type": "quota_exceeded", "reason": snap.get("reason") or "llm"})
                self.emit({"type": "error", "text": "Usage limit reached. Open Account to see remaining quota."})
                self.emit({"type": "done", "id": "", "stt": 0, "llm": 0, "ok": False})
                return
        self._cancel.clear()
        self._gen_seq += 1
        seq = self._gen_seq
        qid = self._new_qid()
        internal = self._is_internal(t, mode)
        self.emit({"type": "status", "text": STATUS_GENERATE})
        if not internal:
            heard = self._heard_lang or (detect_question_lang(t) if mode == "ask" else None)
            ev: dict[str, Any] = {"type": "question", "id": qid, "text": t}
            if heard:
                ev["language"] = heard
            self.emit(ev)
        t0 = time.time()
        llm = self.cfg.get("llm") or {}
        max_tokens = int(llm.get("max_tokens") or 800)
        if mode == "ask":
            max_tokens = max(max_tokens, 1600)
        elif mode in ("summary", "notes", "catchup", "listen_ask"):
            max_tokens = max(max_tokens, 1600)
        elif mode == "translate":
            max_tokens = max(max_tokens, 800)
        answer = ""
        try:
            kwargs: dict[str, Any] = dict(
                model=self._model,
                messages=self._with_images(self._build_messages(t, mode), images),
                max_tokens=max_tokens,
                stream=True,
            )
            if not str(self._model).startswith(("o1", "o3")):
                kwargs["temperature"] = llm.get("temperature", 0.5)
            if self._provider == "deepseek":
                kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
            stream = self.client.chat.completions.create(**kwargs)
            reasoning = ""
            for ch in stream:
                if seq != self._gen_seq or self._cancel.is_set():
                    return
                if not ch.choices:
                    continue
                delta = ch.choices[0].delta
                piece = getattr(delta, "content", None) or ""
                if piece:
                    answer += piece
                    self.emit({"type": "chunk", "id": qid, "text": piece})
                think = getattr(delta, "reasoning_content", None) or ""
                if think:
                    reasoning += think
            if not answer and reasoning:
                answer = reasoning
                self.emit({"type": "chunk", "id": qid, "text": reasoning})
        except Exception as e:
            if seq != self._gen_seq:
                return
            self.emit({"type": "error", "text": f"Generation failed:{e}"})
            self.emit({"type": "done", "id": qid, "stt": 0, "llm": round(time.time() - t0, 2), "ok": False})
            return
        if seq != self._gen_seq or self._cancel.is_set():
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
            from server.meter import consume_llm, save_history

            inp = max(1, len(t) // 4)
            out = max(1, len(answer) // 4)
            ok, snap = consume_llm(self.user_id, self.usage_session_id, inp, out)
            self.emit({"type": "quota", **snap})
            kind_q = "transcript" if mode in ("translate", "summary") else "question"
            if not internal:
                save_history(self.user_id, self.usage_session_id, kind_q, self._strip_nod_tag(t), qid)
            save_history(self.user_id, self.usage_session_id, "answer" if mode == "ask" else mode, answer, qid)
            if mode in ("ask", "summary", "translate", "notes"):
                try:
                    from server.meter import write_session_notes

                    write_session_notes(self.user_id, self.usage_session_id)
                except Exception:
                    logging.getLogger("nod").exception("r2 notes upload failed")
            if not ok:
                self.emit({"type": "quota_exceeded", "reason": snap.get("reason") or "llm"})
        self.emit({"type": "done", "id": qid, "stt": 0, "llm": round(time.time() - t0, 2), "ok": True})


class CloudListener:
    def __init__(self, api_key: str, cfg: dict[str, Any], on_final, on_partial, on_error):
        self.api_key = api_key
        self.cfg = cfg
        self.on_final = on_final
        self.on_partial = on_partial
        self.on_error = on_error
        self._q: queue.Queue[bytes] = queue.Queue(maxsize=240)
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._fail: list[str] = []
        self._ws = None
        self._last_final = ""
        self._muted = False

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
        self._fail = []
        self._ws = websocket.WebSocketApp(
            url,
            header=[f"Authorization: {self.api_key}"],
            on_open=lambda _ws: self._ready.set(),
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
                if not self._stop.is_set() and self.on_error:
                    self.on_error(str(e))
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
            if data.get("end_of_turn"):
                if data.get("turn_is_formatted") is False:
                    if speechy and self.on_partial:
                        self.on_partial(text, lang)
                    return
                cleaned = text.strip()
                if cleaned and cleaned != self._last_final:
                    self._last_final = cleaned
                    threading.Thread(target=self.on_final, args=(cleaned, lang), daemon=True).start()
            elif speechy and self.on_partial:
                self.on_partial(text, lang)
        elif kind == "Error" and self.on_error:
            self.on_error(str(data.get("error") or message))

    def _on_ws_error(self, _ws, error) -> None:
        self._fail.append(str(error))
        self._ready.set()
        if not self._stop.is_set() and self.on_error:
            self.on_error(str(error))

    def _on_close(self, _ws, status, msg) -> None:
        if self._stop.is_set():
            return
        extra = f"{status or ''} {msg or ''}".strip()
        if not self._ready.is_set():
            self._fail.append(f"AssemblyAI connection closed {extra}".strip())
            self._ready.set()

    def stop(self) -> None:
        self._stop.set()
        ws = self._ws
        if ws:
            try:
                ws.close()
            except Exception:
                pass
            self._ws = None


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
        self._manual_buf = bytearray()
        self._manual = False
        self._manual_started = 0.0
        self._busy = False
        self._pending: tuple[str, str | None] | None = None
        self._pending_asks: list[tuple[str, str]] = []
        self._pending_wait: tuple[str | None, float, str | None] = (None, 0.0, None)
        self._meeting_flush_timer: threading.Timer | None = None
        self._meeting_lock = threading.Lock()
        self._follow_lang: str | None = None
        self._follow_switch_lang: str | None = None
        self._follow_switch_hits = 0
        self._recent_finals: list[tuple[str, float]] = []
        self._mic_muted = False
        self._workspace = "interview"
        self._archive_fp = None
        self._archive_path: str | None = None
        self._archive_bytes = 0
        self._archive_total = 0
        self._archive_part = 1
        self._consent_ok: bool | None = None

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

    def _upload_current_part(self) -> None:
        from server.r2 import pcm_to_wav, put_bytes
        from server.meter import set_session_file

        path = self._archive_path
        if not path or not self.user_id or not self.usage_session_id or self._archive_bytes <= SR * 2:
            return
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

    def _archive_rotate(self) -> None:
        try:
            self._upload_current_part()
        except Exception:
            logging.getLogger("nod").exception("r2 audio part upload failed")
        self._archive_close(unlink=True)
        self._archive_part += 1

    def _flush_cloud_archive(self, final: bool = False) -> None:
        from server.r2 import enabled

        if not enabled() or not self.user_id or not self.usage_session_id:
            if final:
                self._archive_close(unlink=True)
            return
        try:
            self._upload_current_part()
        except Exception:
            logging.getLogger("nod").exception("r2 audio upload failed")
        try:
            from server.meter import write_session_notes

            write_session_notes(self.user_id, self.usage_session_id)
        except Exception:
            logging.getLogger("nod").exception("r2 notes upload failed")
        if final:
            self._archive_close(unlink=True)

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
        self.emit({"type": "state", "state": "idle"})
        self.emit({"type": "status", "text": STATUS_READY})

    def close(self) -> None:
        self._stop_listening()
        self.pipeline._cancel.set()
        self._flush_cloud_archive(final=True)
        if self.usage_session_id:
            from server.meter import close_usage_session

            close_usage_session(self.usage_session_id)
            self.usage_session_id = None
            self.pipeline.usage_session_id = None

    def _quota_block(self, snap: dict) -> None:
        self.emit({"type": "quota", **snap})
        self.emit({"type": "quota_exceeded", "reason": snap.get("reason") or "limit"})
        self.emit({"type": "error", "text": "Usage limit reached. Open Account to upgrade or wait for reset."})
        self.emit({"type": "status", "text": "Usage limit reached"})

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
        sid, snap = open_usage_session(self.user_id, self._workspace)
        self.emit({"type": "quota", **snap})
        if not sid:
            self._quota_block(snap)
            return False
        self.usage_session_id = sid
        self.pipeline.usage_session_id = sid
        return True

    def push_pcm(self, pcm: bytes) -> None:
        if self._mic_muted or not pcm:
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
                        self._stop_listening()
                    if self._manual:
                        self._manual = False
                        self._manual_buf = bytearray()
                    return
        if self._manual:
            self._manual_buf.extend(pcm)
            self._archive_append(pcm)
            if time.time() - self._manual_started > MANUAL_MAX_SEC:
                self._stop_manual()
            return
        if self._listener:
            self._archive_append(pcm)
            self._listener.push_pcm(pcm)

    def dispatch(self, msg: dict) -> None:
        mtype = msg.get("type")
        if mtype == "manual":
            self.manual()
        elif mtype == "toggle_listen":
            self.toggle_listen()
        elif mtype == "ask":
            self.ask(msg.get("text", ""), msg.get("files"), msg.get("mode") or "ask")
        elif mtype == "set_workspace":
            self.set_workspace(msg.get("mode") or "interview")
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

    def cancel_generate(self) -> None:
        """Cancel the in-flight LLM stream without stopping STT."""
        self.pipeline._gen_seq += 1
        self.pipeline._cancel.set()
        self._pending_asks = []
        self._busy = False

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
        if self._workspace == "meeting":
            stt["max_turn_silence"] = "1200"
        cfg["stt"] = stt
        return cfg

    def _restart_listener(self) -> None:
        if not self._listener:
            return
        lst = self._listener
        self._listener = None
        try:
            lst.stop()
        except Exception:
            pass
        self._start_listening(resume=True)

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

    def _flush_meeting_hold(self) -> None:
        with self._meeting_lock:
            self._cancel_meeting_timer()
            ptxt, _pts, plang = self._pending_wait
            self._pending_wait = (None, 0.0, None)
        if ptxt:
            self._emit_meeting_line(ptxt, plang)

    def _emit_meeting_line(self, cleaned: str, lang: str | None) -> None:
        heard = lang or detect_question_lang(cleaned)
        for piece in split_code_switched(cleaned):
            piece_heard = detect_question_lang(piece) or heard
            self._maybe_follow_speech(piece, piece_heard)
            self._remember_final(piece)
            qev: dict[str, Any] = {"type": "question", "id": self.pipeline._new_qid(), "text": piece}
            if piece_heard:
                qev["language"] = piece_heard
            self.emit(qev)
            if self.user_id and self.usage_session_id:
                from server.meter import save_history

                save_history(self.user_id, self.usage_session_id, "transcript", piece, qev["id"])

    def _hold_or_emit_meeting(self, cleaned: str, lang: str | None) -> None:
        leftover: tuple[str, str | None] | None = None
        hold_now = False
        with self._meeting_lock:
            ptxt, pts, plang = self._pending_wait
            now = time.time()
            if ptxt and now - pts < 2.8 and _same_speech_script(ptxt, cleaned):
                cleaned = _join_speech_frags(ptxt, cleaned)
                lang = plang or lang
                self._pending_wait = (None, 0.0, None)
            elif ptxt:
                leftover = (ptxt, plang)
                self._pending_wait = (None, 0.0, None)
            if _meeting_should_hold(cleaned):
                self._pending_wait = (cleaned, now, lang)
                self._cancel_meeting_timer()
                timer = threading.Timer(1.0, self._flush_meeting_hold)
                timer.daemon = True
                self._meeting_flush_timer = timer
                timer.start()
                hold_now = True
            else:
                self._cancel_meeting_timer()
        if leftover:
            self._emit_meeting_line(leftover[0], leftover[1])
        if hold_now:
            ev: dict[str, Any] = {"type": "partial", "text": cleaned}
            if lang:
                ev["language"] = lang
            self.emit(ev)
            return
        self._emit_meeting_line(cleaned, lang)

    def set_workspace(self, mode: str) -> None:
        if mode not in ("interview", "meeting", "translate"):
            mode = "interview"
        prev = self._workspace
        prev_lang = self._effective_stt_lang(prev)
        self._workspace = mode
        self._pending = None
        self._pending_asks = []
        # 丢弃 hold 住的半句会议内容（不 flush）：模式切换后 emit 的 question 事件
        # 会被前端路由到新 workspace（如 translate 下变成垃圾翻译对）
        self._cancel_meeting_timer()
        self._pending_wait = (None, 0.0, None)
        if mode == "translate" and prev != "translate":
            self.cancel_generate()
        if self._listener and prev_lang != self._effective_stt_lang():
            self._restart_listener()

    def set_llm(self, provider: str, model: str) -> None:
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
                self._manual = False
                self._manual_buf = bytearray()
                self.emit({"type": "state", "state": "idle"})
            self.emit({"type": "status", "text": "Microphone muted"})
        else:
            self.emit({"type": "status", "text": "Microphone unmuted"})

    def toggle_listen(self) -> None:
        if self._manual:
            self.emit({"type": "status", "text": "Stop recording before enabling Auto"})
            return
        if not self._listener:
            if not self._ensure_consent():
                return
            if not self._ensure_usage():
                return
            self._start_listening()
        else:
            self._stop_listening()

    def _start_listening(self, resume: bool = False) -> None:
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
        )
        try:
            listener.start()
        except Exception as e:
            self.emit({"type": "error", "text": f"Transcription failed:could not start listening ({e})"})
            return
        if self._mic_muted:
            listener.set_muted(True)
        self._listener = listener
        self.emit({"type": "state", "state": "listen"})
        if not resume:
            self.emit({"type": "status", "text": STATUS_LISTEN})

    def _stop_listening(self) -> None:
        self.pipeline._cancel.set()
        self._pending = None
        lst = self._listener
        self._listener = None
        if lst:
            try:
                lst.stop()
            except Exception:
                pass
        self._flush_meeting_hold()
        self.emit({"type": "state", "state": "idle"})
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
        self._manual_started = time.time()
        self.emit({"type": "state", "state": "record"})
        self.emit({"type": "status", "text": STATUS_RECORD})

    def _stop_manual(self) -> None:
        pcm = bytes(self._manual_buf)
        self._manual = False
        self._manual_buf = bytearray()
        dur = len(pcm) / (SR * 2)
        if dur < MANUAL_MIN_SEC:
            self.emit({"type": "state", "state": "idle"})
            self.emit({"type": "status", "text": "Recording too short, try again"})
            return
        self.emit({"type": "state", "state": "think"})
        self.emit({"type": "status", "text": STATUS_TRANSCRIBE})
        threading.Thread(target=self._finish_manual, args=(pcm,), daemon=True).start()

    def _finish_manual(self, pcm: bytes) -> None:
        key = self.pipeline.assemblyai_key()
        if not key:
            self.emit({"type": "error", "text": "Missing AssemblyAI key"})
            self.emit({"type": "state", "state": "idle"})
            return
        try:
            text, lang = assemblyai_transcribe_pcm(key, pcm, self._stt_cfg())
        except Exception as e:
            self.emit({"type": "error", "text": f"Transcription failed:{e}"})
            self.emit({"type": "state", "state": "idle"})
            return
        cleaned, _ = clean_transcript(
            text or "",
            None,
            self.pipeline._last_answer,
            keep_fillers=self._workspace in ("meeting", "translate"),
        )
        if not cleaned:
            self.emit({"type": "status", "text": STATUS_EMPTY})
            self.emit({"type": "state", "state": "idle"})
            return
        heard = lang or detect_question_lang(cleaned)
        if not self._speech_allowed(cleaned, lang or heard):
            self.emit({"type": "partial", "text": ""})
            self.emit({"type": "state", "state": "idle"})
            return
        if self._workspace == "translate":
            qid = self.pipeline._new_qid()
            ev: dict[str, Any] = {"type": "question", "id": qid, "text": cleaned}
            if heard:
                ev["language"] = heard
            self.emit(ev)
            self.emit({"type": "state", "state": "idle"})
            return
        if self._workspace == "meeting":
            qid = self.pipeline._new_qid()
            ev: dict[str, Any] = {"type": "question", "id": qid, "text": cleaned}
            if heard:
                ev["language"] = heard
            self.emit(ev)
            self.emit({"type": "state", "state": "idle"})
            return
        self._busy = True
        self.pipeline._cancel.clear()
        try:
            self.pipeline.process_text(cleaned, "ask", heard)
        finally:
            self._busy = False
            self.emit({"type": "state", "state": "idle"})

    def ask(self, text, files=None, mode="ask") -> None:
        extra = attachments_to_prompt(files)
        images = attachment_images(files)
        text = (text or "").strip()
        if extra:
            text = f"{extra}\n\n{text}".strip() if text else extra
        if not text and not images:
            return
        if not text:
            text = "Please review the attached images."
        if not self._ensure_usage():
            return
        body = text
        if body.startswith(("[NOD_TRANSLATE", "[NOD_SUMMARY", "[NOD_CATCH", "[NOD_ASK", "[NOD_NOTES")):
            nl = body.find("\n")
            body = body[nl + 1:].strip() if nl >= 0 else body
        if mode == "ask" and body.startswith("Summarize the following meeting transcript"):
            mode = "summary"
        if mode == "ask" and body.startswith("Translate to "):
            mode = "translate"
        if mode == "ask" and (body.startswith("Catch the listener up") or text.lstrip().startswith("[NOD_CATCH")):
            mode = "catchup"
        if mode == "ask" and (body.startswith("Listener question:") or text.lstrip().startswith("[NOD_ASK")):
            mode = "listen_ask"
        if mode == "ask" and (body.startswith("Write structured notes") or text.lstrip().startswith("[NOD_NOTES")):
            mode = "notes"
        if self._busy:
            if mode in ("translate", "summary", "catchup", "notes", "listen_ask"):
                self._pending_asks.append((text, mode))
                return
            self.emit({"type": "status", "text": "Still working, please wait"})
            return
        self._busy = True
        self.pipeline._cancel.clear()
        self.emit({"type": "state", "state": "think"})

        def work():
            try:
                self.pipeline.process_text(text, mode, images=images)
            finally:
                self._busy = False
                listening = self._listener is not None
                self.emit({"type": "state", "state": "listen" if listening else "idle"})
                if self._pending_asks:
                    nxt, md = self._pending_asks.pop(0)
                    self.ask(nxt, None, md)

        threading.Thread(target=work, daemon=True).start()

    def _speech_allowed(self, text: str, lang: str | None = None) -> bool:
        locked = self._speech_filter_lang()
        return matches_locked_speech(text, locked, lang)

    def _on_partial(self, text: str, lang: str | None = None) -> None:
        if not text:
            return
        if not self._speech_allowed(text, lang):
            self.emit({"type": "partial", "text": ""})
            return
        ev: dict[str, Any] = {"type": "partial", "text": text}
        if lang:
            ev["language"] = lang
        self.emit(ev)

    def _on_final(self, text: str, lang: str | None = None) -> None:
        recent = [t for t, _ in self._recent_finals[-3:]]
        cleaned, _reason = clean_transcript(
            text,
            recent,
            self.pipeline._last_answer,
            keep_fillers=self._workspace in ("meeting", "translate"),
        )
        if not cleaned:
            return
        if not self._speech_allowed(cleaned, lang):
            self.emit({"type": "partial", "text": ""})
            return
        now = time.time()
        for t, ts in self._recent_finals:
            if now - ts < 5.0 and _ratio(cleaned.lower(), t.lower()) > 0.85:
                return
        heard = lang or detect_question_lang(cleaned)
        if self._workspace == "translate":
            # 不取消在途翻译：取消会让被中断的句子等 25s 超时重试（双倍 token + 字幕卡死）。
            # 新 final 照常入队，前端 pump 一次只发一条，翻译自然串行。
            self._pending = None
            self._pending_wait = (None, 0.0, None)
            for piece in split_code_switched(cleaned):
                piece_heard = detect_question_lang(piece) or heard
                self._maybe_follow_speech(piece, piece_heard)
                self._remember_final(piece)
                ev: dict[str, Any] = {"type": "question", "id": self.pipeline._new_qid(), "text": piece}
                if piece_heard:
                    ev["language"] = piece_heard
                self.emit(ev)
            return
        if self._workspace == "meeting":
            self._hold_or_emit_meeting(cleaned, lang)
            return
        recent_qs = [h["q"] for h in self.pipeline._qa_history]
        verdict = guard_question(cleaned, recent_qs, self.pipeline._last_answer)
        if verdict == "wait":
            ptxt, pts, plang = self._pending_wait
            if ptxt and time.time() - pts < 2.0 and _same_speech_script(ptxt, cleaned):
                self._pending_wait = (None, 0.0, None)
                self._on_final(f"{ptxt} {cleaned}", plang or lang)
            elif ptxt:
                leftover, leftover_lang = ptxt, plang
                self._pending_wait = (None, 0.0, None)
                self._on_final(leftover, leftover_lang)
                self._on_final(cleaned, lang)
            else:
                self._pending_wait = (cleaned, time.time(), lang)
                self.emit({"type": "status", "text": STATUS_WAIT_MORE})
            return
        self._pending_wait = (None, 0.0, None)
        if verdict == "reject":
            return
        self._remember_final(cleaned)
        self._maybe_follow_speech(cleaned, heard)
        if self._busy:
            self._pending = (cleaned, lang)
            return
        self._busy = True
        self.pipeline._cancel.clear()
        self.emit({"type": "state", "state": "think"})
        self.emit({"type": "status", "text": STATUS_CHECK})

        def work():
            try:
                self.pipeline.process_text(cleaned, "ask", heard)
            finally:
                self._busy = False
                listening = self._listener is not None
                self.emit({"type": "state", "state": "listen" if listening else "idle"})
                pending = self._pending
                self._pending = None
                if pending:
                    ptxt, plang = pending
                    self._on_final(ptxt, plang)

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

    threading.Thread(target=loop, daemon=True, name="nod-backup").start()
    yield


app = FastAPI(title="Nod Web", lifespan=lifespan)
_origins = [
    "http://127.0.0.1:5174",
    "http://localhost:5174",
    "http://127.0.0.1:9320",
    "http://localhost:9320",
]
if PUBLIC_URL:
    _origin = PUBLIC_URL.rstrip("/")
    _origins.append(_origin)
    _host = urlparse(_origin).hostname or ""
    if _host.count(".") == 1:
        _origins.append(f"{urlparse(_origin).scheme}://www.{_host}")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(CloudflareOriginMiddleware)
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
            await ws.send_text(json.dumps({"type": "auth_required"}))
            await ws.close(code=4401)
            ws_disconnect(ip)
            return
    loop = asyncio.get_running_loop()
    out: asyncio.Queue[str] = asyncio.Queue()

    def emit(obj: dict) -> None:
        asyncio.run_coroutine_threadsafe(out.put(json.dumps(obj, ensure_ascii=False)), loop)

    session = Session(emit, json.loads(json.dumps(CFG)), dict(KEYS), user.id if user else None)
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
            if data:
                if len(data) > MAX_WS_FRAME:
                    continue
                session.push_pcm(data)
            elif text:
                if len(text) > 200_000:
                    continue
                try:
                    session.dispatch(json.loads(text))
                except json.JSONDecodeError:
                    continue
    except WebSocketDisconnect:
        pass
    finally:
        send_task.cancel()
        session.close()
        ws_disconnect(ip)


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
    app.mount("/assets", StaticFiles(directory=str(WEB_DIST / "assets")), name="assets")

    def _favicon() -> FileResponse:
        path = WEB_DIST / "favicon.svg"
        if not path.exists():
            path = ROOT / "web" / "public" / "favicon.svg"
        return FileResponse(path, media_type="image/svg+xml")

    @app.get("/favicon.svg")
    @app.get("/favicon.ico")
    def favicon():
        return _favicon()

    @app.get("/")
    def marketing_home():
        return _html_page("index.html")

    @app.get("/app")
    def workspace_home():
        page = WEB_DIST / "app.html"
        return _html_page("app.html") if page.exists() else _html_page("index.html")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        if full_path == "app" or full_path.startswith("app/"):
            page = WEB_DIST / "app.html"
            return _html_page("app.html") if page.exists() else _html_page("index.html")
        dest = WEB_DIST / full_path
        if full_path and dest.exists() and dest.is_file():
            return FileResponse(dest)
        return _html_page("index.html")
