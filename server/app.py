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
from server.security import user_from_token

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
        "llm": {"model": "deepseek-v4-flash", "max_tokens": 400, "temperature": 0.5, "provider": "deepseek"},
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


def _normalize_translate_from(lang: Any) -> str | None:
    if lang in (None, "", "auto"):
        return None
    return _normalize_stt_lang(lang)


def _normalize_stt_lang(lang: Any) -> str | None:
    if isinstance(lang, str) and lang in _TRANSLATE_LANGS:
        return lang
    return None


def heard_lang_from_code(raw: Any) -> str | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    code = raw.strip().lower().replace("_", "-").split("-", 1)[0]
    code = _LANG_ALIASES.get(code, code)
    return _normalize_stt_lang(code)


def heard_lang_from_turn(data: dict[str, Any]) -> str | None:
    return heard_lang_from_code(data.get("language_code") or data.get("language"))


def public_config(cfg: dict[str, Any]) -> dict[str, Any]:
    return {
        "llm": {
            "provider": cfg.get("llm", {}).get("provider", "deepseek"),
            "model": cfg.get("llm", {}).get("model", ""),
        },
        "stt": {"language": _normalize_stt_lang(cfg.get("stt", {}).get("language"))},
        "audio": {"source": "mic"},
        "ui": {
            "opacity": cfg.get("ui", {}).get("opacity", 88),
            "translate_from": _normalize_translate_from(cfg.get("ui", {}).get("translate_from")) or "auto",
            "translate_to": _normalize_translate_to(cfg.get("ui", {}).get("translate_to")),
        },
        "models": cfg.get("models") or [],
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


def assemblyai_ws_url(cfg: dict[str, Any]) -> str:
    params = [
        ("sample_rate", str(SR)),
        ("speech_model", ASSEMBLYAI_MODEL),
        ("format_turns", "true"),
        ("max_turn_silence", "1200"),
    ]
    lang = _normalize_stt_lang((cfg.get("stt") or {}).get("language"))
    for code in ((lang,) if lang else _TRANSLATE_LANGS):
        params.append(("language_codes", code))
    boost = _stt_boost_words(cfg)
    if boost:
        params.append(("word_boost", ",".join(boost)))
        params.append(("boost_param", "medium"))
    params.append(("speech_threshold", "2"))
    return ASSEMBLYAI_WS + "?" + urlencode(params)


def clean_transcript(text: str, recent_finals=None, last_answer=None) -> tuple[str, str]:
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
    if low in _STT_SOCIAL_WORDS:
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
            body = f"[Image attached: {name}]"
        else:
            body = f"[Attached file: {name}]"
        blocks.append(f"--- Attached: {name} ---\n{body}")
    return "\n\n".join(blocks)


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
        self._model = cfg["llm"].get("model", "deepseek-v4-flash")
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

    def _strip_nod_tag(self, question: str) -> str:
        text = question or ""
        if text.startswith(("[NOD_TRANSLATE", "[NOD_SUMMARY", "[NOD_NOTES", "[NOD_ASK")):
            nl = text.find("\n")
            if nl >= 0:
                return text[nl + 1:].strip()
        return text

    def _notes_mode(self, question: str) -> str:
        t = (question or "").lstrip()
        if t.startswith("[NOD_NOTES:"):
            end = t.find("]")
            if end > 11:
                return t[11:end].strip() or "general"
        return "general"

    def _is_internal(self, question: str, mode: str) -> bool:
        if mode in ("translate", "notes", "ask_nod", "summary"):
            return True
        t = (question or "").lstrip()
        return t.startswith(("[NOD_TRANSLATE", "[NOD_NOTES", "[NOD_ASK", "[NOD_SUMMARY", "Translate to "))

    def _build_messages(self, question: str, mode: str = "auto") -> list[dict]:
        raw = question or ""
        question = self._strip_nod_tag(question)
        if mode == "ask_nod" or raw.lstrip().startswith("[NOD_ASK]"):
            from server.listening import ASK_NOD_SYSTEM

            return [
                {"role": "system", "content": ASK_NOD_SYSTEM},
                {"role": "user", "content": question},
            ]
        if mode == "notes" or raw.lstrip().startswith("[NOD_NOTES"):
            from server.listening import notes_system

            return [
                {"role": "system", "content": notes_system(self._notes_mode(raw))},
                {"role": "user", "content": question},
            ]
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
                        "Output ONLY the translation — no quotes, labels, notes, or preamble.\n"
                        "Preserve names, numbers, and meaning. If the text is already in the target language, return it unchanged."
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

    def process_text(self, question: str, mode: str = "ask", heard_lang: str | None = None) -> None:
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
        max_tokens = llm.get("max_tokens", 600)
        if mode in ("summary", "notes", "ask_nod"):
            max_tokens = max(max_tokens, 1200)
        elif mode == "translate":
            max_tokens = max(max_tokens, 800)
        answer = ""
        try:
            kwargs: dict[str, Any] = dict(
                model=self._model,
                messages=self._build_messages(t, mode),
                max_tokens=max_tokens,
                stream=True,
            )
            if not str(self._model).startswith(("o1", "o3")):
                kwargs["temperature"] = llm.get("temperature", 0.5)
            if self._provider == "deepseek":
                kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
            stream = self.client.chat.completions.create(**kwargs)
            for ch in stream:
                if seq != self._gen_seq or self._cancel.is_set():
                    return
                delta = ch.choices[0].delta
                if delta.content:
                    answer += delta.content
                    self.emit({"type": "chunk", "id": qid, "text": delta.content})
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
        if mode not in ("translate", "summary", "notes", "ask_nod"):
            self._qa_history.append({"qid": qid, "q": self._strip_nod_tag(t), "a": answer})
            self._qa_history = self._qa_history[-6:]
        if self.user_id:
            from server.meter import consume_llm, save_history

            inp = max(1, len(t) // 4)
            out = max(1, len(answer) // 4)
            ok, snap = consume_llm(self.user_id, self.usage_session_id, inp, out)
            self.emit({"type": "quota", **snap})
            kind_q = "transcript" if mode in ("translate", "summary", "notes", "ask_nod") else "question"
            if not internal:
                save_history(self.user_id, self.usage_session_id, kind_q, self._strip_nod_tag(t), qid)
            save_history(self.user_id, self.usage_session_id, "answer" if mode == "ask" else mode, answer, qid)
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
        self._q: queue.Queue[bytes] = queue.Queue(maxsize=80)
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
        self._recent_finals: list[tuple[str, float]] = []
        self._mic_muted = False
        self._workspace = "meeting"

    def start(self) -> None:
        st = self.pipeline.key_status()
        self.emit({"type": "keys_status", "has_llm": st["has_llm"], "has_stt": st["has_stt"]})
        self.emit({"type": "ready"})
        self.emit({"type": "state", "state": "idle"})
        self.emit({"type": "status", "text": STATUS_READY})

    def close(self) -> None:
        self._stop_listening()
        self.pipeline._cancel.set()
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
            if time.time() - self._manual_started > MANUAL_MAX_SEC:
                self._stop_manual()
            return
        if self._listener:
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
            self.set_workspace(msg.get("mode") or "meeting")
        elif mtype == "set_llm":
            self.set_llm(msg.get("provider", "deepseek"), msg.get("model", ""))
        elif mtype == "set_lang":
            lang = _normalize_stt_lang(msg.get("language"))
            prev = self._effective_stt_lang()
            self.cfg.setdefault("stt", {})["language"] = lang
            self.emit({"type": "status", "text": f"Language: {_LANG_NAMES.get(lang or '', 'Auto')}"})
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
        cfg["stt"] = stt
        return cfg

    def _restart_listener(self) -> None:
        if not self._listener:
            return
        self._stop_listening()
        self._start_listening()

    def set_workspace(self, mode: str) -> None:
        if mode not in ("interview", "meeting", "translate"):
            mode = "meeting"
        prev = self._workspace
        prev_lang = self._effective_stt_lang(prev)
        self._workspace = mode
        self._pending = None
        self._pending_asks = []
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
            if not self._ensure_usage():
                return
            self._start_listening()
        else:
            self._stop_listening()

    def _start_listening(self) -> None:
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
        self.emit({"type": "state", "state": "idle"})
        self.emit({"type": "status", "text": STATUS_READY})

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
        cleaned, _ = clean_transcript(text or "", None, self.pipeline._last_answer)
        if not cleaned:
            self.emit({"type": "status", "text": STATUS_EMPTY})
            self.emit({"type": "state", "state": "idle"})
            return
        heard = lang or detect_question_lang(cleaned)
        if self._workspace == "translate":
            locked = self._effective_stt_lang()
            if not matches_locked_speech(cleaned, locked, lang):
                self.emit({"type": "partial", "text": ""})
                self.emit({"type": "state", "state": "idle"})
                return
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
        text = (text or "").strip()
        if extra:
            text = f"{extra}\n\n{text}".strip() if text else extra
        if not text:
            return
        if not self._ensure_usage():
            return
        body = text
        if body.startswith(("[NOD_TRANSLATE", "[NOD_SUMMARY", "[NOD_NOTES", "[NOD_ASK")):
            nl = body.find("\n")
            body = body[nl + 1:].strip() if nl >= 0 else body
        if mode == "ask" and (text.lstrip().startswith("[NOD_NOTES") or text.lstrip().startswith("[NOD_SUMMARY")):
            mode = "notes" if text.lstrip().startswith("[NOD_NOTES") else "summary"
        if mode == "ask" and text.lstrip().startswith("[NOD_ASK]"):
            mode = "ask_nod"
        if mode == "ask" and body.startswith("Summarize the following meeting transcript"):
            mode = "summary"
        if mode == "ask" and body.startswith("Translate to "):
            mode = "translate"
        if self._busy:
            if mode in ("translate", "summary", "notes", "ask_nod"):
                self._pending_asks.append((text, mode))
                return
            self.emit({"type": "status", "text": "Still working, please wait"})
            return
        self._busy = True
        self.pipeline._cancel.clear()
        self.emit({"type": "state", "state": "think"})

        def work():
            try:
                self.pipeline.process_text(text, mode)
            finally:
                self._busy = False
                listening = self._listener is not None
                self.emit({"type": "state", "state": "listen" if listening else "idle"})
                if self._pending_asks:
                    nxt, md = self._pending_asks.pop(0)
                    self.ask(nxt, None, md)

        threading.Thread(target=work, daemon=True).start()

    def _on_partial(self, text: str, lang: str | None = None) -> None:
        if not text:
            return
        if self._workspace == "translate":
            locked = self._effective_stt_lang()
            if locked and not matches_locked_speech(text, locked, lang):
                self.emit({"type": "partial", "text": ""})
                return
        ev: dict[str, Any] = {"type": "partial", "text": text}
        if lang:
            ev["language"] = lang
        self.emit(ev)

    def _on_final(self, text: str, lang: str | None = None) -> None:
        recent = [t for t, _ in self._recent_finals[-3:]]
        cleaned, _reason = clean_transcript(text, recent, self.pipeline._last_answer)
        if not cleaned:
            return
        if self._workspace == "translate":
            locked = self._effective_stt_lang()
            if not matches_locked_speech(cleaned, locked, lang):
                self.emit({"type": "partial", "text": ""})
                return
        now = time.time()
        for t, ts in self._recent_finals:
            if now - ts < 5.0 and _ratio(cleaned.lower(), t.lower()) > 0.85:
                return
        self._recent_finals.append((cleaned, now))
        self._recent_finals = self._recent_finals[-8:]
        heard = lang or detect_question_lang(cleaned)
        qev: dict[str, Any] = {"type": "question", "id": "", "text": cleaned}
        if heard:
            qev["language"] = heard
        if self._workspace == "translate":
            self.cancel_generate()
            self._pending = None
            self._pending_wait = (None, 0.0, None)
            qev["id"] = self.pipeline._new_qid()
            self.emit(qev)
            return
        if self._workspace == "meeting":
            qev["id"] = self.pipeline._new_qid()
            self.emit(qev)
            if self.user_id and self.usage_session_id:
                from server.meter import save_history, save_segment

                save_history(self.user_id, self.usage_session_id, "transcript", cleaned, qev["id"])
                save_segment(self.user_id, self.usage_session_id, cleaned, qev["id"])
            return
        recent_qs = [h["q"] for h in self.pipeline._qa_history]
        verdict = guard_question(cleaned, recent_qs, self.pipeline._last_answer)
        if verdict == "wait":
            ptxt, pts, plang = self._pending_wait
            if ptxt and time.time() - pts < 2.0:
                self._pending_wait = (None, 0.0, None)
                self._on_final(f"{ptxt} {cleaned}", plang or lang)
            else:
                self._pending_wait = (cleaned, time.time(), lang)
                self.emit({"type": "status", "text": STATUS_WAIT_MORE})
            return
        self._pending_wait = (None, 0.0, None)
        if verdict == "reject":
            return
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


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    token = (ws.query_params.get("token") or "").strip() or (ws.cookies.get(COOKIE_NAME) or "").strip()
    user = user_from_token(token) if token else None
    if not AUTH_DISABLED and user is None:
        await ws.accept()
        await ws.send_text(json.dumps({"type": "auth_required"}))
        await ws.close(code=4401)
        return
    await ws.accept()
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
                session.push_pcm(data)
            elif text:
                try:
                    session.dispatch(json.loads(text))
                except json.JSONDecodeError:
                    continue
    except WebSocketDisconnect:
        pass
    finally:
        send_task.cancel()
        session.close()


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
            "Disallow: /sessions",
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
