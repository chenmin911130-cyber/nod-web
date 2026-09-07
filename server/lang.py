"""Language detection and locked-language filtering.

Pure functions only: no Session state, no I/O. Moved out of ``server/app.py``
verbatim so they can be unit-tested without the server.
"""
from __future__ import annotations

import re
from typing import Any

_TRANSLATE_LANGS = ("zh", "ja", "en", "it", "es", "fr", "de", "pt")
# Latin-script Translate targets whose glyphs cannot be told apart from English;
# for these we must trust AssemblyAI's detected language, not _speech_script's "en".
_LATIN_TRANSLATE_LANGS = ("es", "fr", "de", "it", "pt")
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


def listen_ask_lang(body: str) -> str | None:
    """Pick the answer language for an Auto-notes listen_ask from the prompt body
    (tag already stripped). Question language if confidently detectable, else the
    transcript's majority language, else None.
    """
    text = body or ""
    q_mark = "Listener question:"
    t_mark = "Transcript ("
    q_at = text.find(q_mark)
    t_at = text.find(t_mark)
    question = ""
    transcript = ""
    if q_at >= 0:
        q_end = t_at if t_at > q_at else len(text)
        question = text[q_at + len(q_mark) : q_end].strip()
    if t_at >= 0:
        nl = text.find("\n", t_at)
        rest = text[nl + 1 :].strip() if nl >= 0 else ""
        if rest != "(empty)":
            transcript = rest
    confident = _confident_stt_lang(question, None)
    if confident:
        return confident
    if transcript:
        return detect_question_lang(transcript)
    return None


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


def heard_lang_from_text(text: str, heard: str | None = None) -> str | None:
    """Prefer CJK script on the page, but trust AssemblyAI for Latin languages.

    ``_speech_script`` maps any >=3-latin-glyph line to ``en``, which erases
    AssemblyAI's es/fr/de/it/pt detection. Latin scripts cannot be told apart by
    glyphs, so for those let the STT ``heard`` tag win over the script's "en".
    """
    script = _speech_script(text)
    if script == "en" and heard in _LATIN_TRANSLATE_LANGS:
        return heard
    if script:
        return script
    return heard or detect_question_lang(text) or None


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
            joiner = "" if buf.endswith(("。", "！", "？")) else " "
            buf = f"{buf}{joiner}{part}"
        else:
            out.append(buf)
            buf = part
    if buf:
        out.append(buf)
    return out or [raw]


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
        # A Latin lock is already constrained to that Latin language, so a
        # guessed or STT Latin tag (es/fr/de/it/pt) — including a short/ambiguous
        # turn mis-tagged 'en', or a nearby-language mis-tag like it vs es — must
        # NOT veto it. Only a genuinely different script (CJK / Hangul) or a
        # non-Latin tag vetoes — handled below.
        if not (locked in _LATIN_TRANSLATE_LANGS and (heard in _LATIN_TRANSLATE_LANGS or heard == "en")):
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
    # Latin locks (it/es/fr/de/pt): STT itself is already locked to this
    # language, and word-marker guessing cannot tell Latin languages apart —
    # requiring guessed == locked dropped nearly every real Italian sentence.
    # Reject only when the guess confidently names a DIFFERENT Latin language.
    if heard == locked:
        return True
    return guessed in (locked, "en")
