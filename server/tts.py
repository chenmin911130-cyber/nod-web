from __future__ import annotations

import os
import re
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
ELEVEN_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
ELEVEN_MODEL = "eleven_flash_v2_5"
VOICES = {
    "female": "EXAVITQu4vr4xnSDxMaL",  # Sarah
    "male": "nPczCjzI2devNBz1zQrb",  # Brian
}
MAX_TTS_CHARS = 800


def _read_dotenv_key() -> str:
    cands = [str(ROOT / ".env")]
    local = os.environ.get("LOCALAPPDATA")
    if local:
        cands.append(os.path.join(local, "hermes", ".env"))
    for env_path in cands:
        if not env_path or not os.path.exists(env_path):
            continue
        try:
            with open(env_path, encoding="utf-8") as f:
                for line in f:
                    m = re.match(r"\s*ELEVENLABS_API_KEY\s*=\s*(.+)", line)
                    if m:
                        return m.group(1).strip().strip('"').strip("'")
        except OSError:
            pass
    return ""


def elevenlabs_key() -> str:
    return (os.environ.get("ELEVENLABS_API_KEY") or _read_dotenv_key()).strip()


def voice_id(voice: str) -> str:
    return VOICES["male" if str(voice).strip().lower() == "male" else "female"]


def synthesize(text: str, voice: str = "female") -> bytes:
    key = elevenlabs_key()
    if not key:
        raise RuntimeError("Missing ElevenLabs key")
    clean = " ".join((text or "").split())
    if not clean:
        raise ValueError("Nothing to speak")
    if len(clean) > MAX_TTS_CHARS:
        clean = clean[:MAX_TTS_CHARS].rsplit(" ", 1)[0] or clean[:MAX_TTS_CHARS]
    url = ELEVEN_TTS_URL.format(voice_id=voice_id(voice))
    with httpx.Client(timeout=20.0) as client:
        res = client.post(
            url,
            headers={
                "xi-api-key": key,
                "Accept": "audio/mpeg",
                "Content-Type": "application/json",
            },
            json={
                "text": clean,
                "model_id": ELEVEN_MODEL,
                "voice_settings": {"stability": 0.4, "similarity_boost": 0.75},
            },
        )
    if res.status_code >= 400:
        raise RuntimeError(f"ElevenLabs {res.status_code}")
    audio = res.content
    if not audio:
        raise RuntimeError("ElevenLabs returned empty audio")
    return audio
