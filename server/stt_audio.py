"""AssemblyAI streaming PCM constraints.

Chunks must be 50–1000 ms of 16 kHz PCM16, and must not arrive faster than
realtime. Close code 3007 is either a duration violation or a rate exceed.

https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures
"""

from __future__ import annotations

from typing import Any

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2
BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE
BYTES_PER_MS = BYTES_PER_SEC / 1000.0  # 32
MIN_CHUNK_MS = 50
MAX_CHUNK_MS = 1000
TARGET_CHUNK_MS = 100
MIN_CHUNK_BYTES = int(BYTES_PER_MS * MIN_CHUNK_MS)  # 1600
MAX_CHUNK_BYTES = int(BYTES_PER_MS * MAX_CHUNK_MS)  # 32000
TARGET_CHUNK_BYTES = int(BYTES_PER_MS * TARGET_CHUNK_MS)  # 3200


def duration_ms(n_bytes: int) -> float:
    return n_bytes / BYTES_PER_MS


def duration_s(n_bytes: int) -> float:
    return n_bytes / float(BYTES_PER_SEC)


def pace_wait_s(audio_s: float, elapsed_s: float) -> float:
    """Sleep so the previous audio's wall-clock time has elapsed before the next send."""
    if audio_s <= 0:
        return 0.0
    return max(0.0, audio_s - max(0.0, elapsed_s))


def take_frames(buf: bytearray) -> list[bytes]:
    """Pull 50–100 ms frames. Leftover < 50 ms stays in buf."""
    out: list[bytes] = []
    while len(buf) >= MIN_CHUNK_BYTES:
        n = min(len(buf), TARGET_CHUNK_BYTES)
        out.append(bytes(buf[:n]))
        del buf[:n]
    return out


def take_final_frames(buf: bytearray) -> list[bytes]:
    """End drain: send leftover audio padded to the 50 ms floor."""
    out = take_frames(buf)
    if buf:
        pad = MIN_CHUNK_BYTES - len(buf)
        out.append(bytes(buf) + b"\x00" * pad)
        buf.clear()
    return out


def error_summary(data: dict[str, Any]) -> tuple[int | None, str]:
    """Desensitized AssemblyAI Error fields: code + message, no tokens/audio."""
    code_raw = data.get("error_code")
    if code_raw is None:
        code_raw = data.get("code")
    try:
        code = int(code_raw) if code_raw is not None else None
    except (TypeError, ValueError):
        code = None
    err = str(data.get("error") or "")[:500]
    return code, err
