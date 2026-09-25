"""AssemblyAI streaming PCM constraints.

Chunks must be 50–1000 ms of 16 kHz PCM16. Toward AssemblyAI, cumulative audio
sent must not exceed wall time since the streaming session opened; ``PaceClock``
(default) enforces that budget and caps burst catch-up (see ``NOD_STT_CATCHUP_RATE``).
Legacy per-frame pacing is available with ``NOD_STT_PACE_MODE=frame``. Close code
3007 is either a duration violation or a rate exceed.

https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures
"""

from __future__ import annotations

import os
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


def pace_mode_from_env() -> str:
    v = (os.environ.get("NOD_STT_PACE_MODE") or "cumulative").strip().lower()
    return "frame" if v == "frame" else "cumulative"


def catchup_rate_from_env() -> float:
    raw = os.environ.get("NOD_STT_CATCHUP_RATE")
    if raw is None or str(raw).strip() == "":
        return 1.5
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return 1.5
    return max(1.0, min(2.0, v))


class PaceClock:
    """Pacing toward AssemblyAI: cumulative session clock with optional bounded catch-up."""

    def __init__(self, *, mode: str = "cumulative", catchup_rate: float = 1.5) -> None:
        self.mode = mode if mode == "frame" else "cumulative"
        self.catchup_rate = max(1.0, min(2.0, float(catchup_rate)))
        self._open_at: float | None = None
        self._sched: float = 0.0
        self._last_at: float = 0.0
        self._last_dur: float = 0.0
        self._audio_sent_s: float = 0.0

    def reset(self) -> None:
        self._open_at = None
        self._sched = 0.0
        self._last_at = 0.0
        self._last_dur = 0.0
        self._audio_sent_s = 0.0

    def open(self, now: float) -> None:
        self._open_at = now
        self._sched = now

    @property
    def audio_sent_s(self) -> float:
        return self._audio_sent_s

    @property
    def open_at(self) -> float | None:
        return self._open_at

    def wait_s(self, now: float, next_audio_s: float) -> float:
        if next_audio_s <= 0:
            return 0.0
        if self.mode == "frame":
            if self._last_at <= 0 or self._last_dur <= 0:
                return 0.0
            return pace_wait_s(self._last_dur, now - self._last_at)

        waits = [0.0]
        if self._open_at is not None:
            waits.append(max(0.0, self._sched - now))
        if self._last_at > 0 and self._last_dur > 0:
            rate_floor = self._last_at + self._last_dur / self.catchup_rate
            waits.append(max(0.0, rate_floor - now))
        return max(waits)

    def record(self, now: float, audio_s: float) -> None:
        if audio_s <= 0:
            return
        if self._open_at is None:
            self._open_at = now
            self._sched = now
        if self.mode == "cumulative":
            self._sched += audio_s
        self._last_at = now
        self._last_dur = audio_s
        self._audio_sent_s += audio_s


def take_frames(buf: bytearray) -> list[bytes]:
    """Pull 50–100 ms frames. Leftover < 50 ms stays in buf."""
    out: list[bytes] = []
    while len(buf) >= MIN_CHUNK_BYTES:
        n = min(len(buf), TARGET_CHUNK_BYTES)
        out.append(bytes(buf[:n]))
        del buf[:n]
    return out


def take_one_frame(buf: bytearray) -> bytes:
    """Pull exactly one 50–100 ms frame, leaving the rest in place.

    Unlike ``take_frames`` (which drains the whole buffer into a list, so the
    sender holds a large backlog in a local variable and stops re-reading the
    queue), this lets a sender send one frame per cycle and re-check newly
    arrived data between sends — the ordering guarantee for a large seed/hold
    followed by live frames (issue #165 P1).
    """
    if len(buf) < MIN_CHUNK_BYTES:
        return b""
    n = min(len(buf), TARGET_CHUNK_BYTES)
    out = bytes(buf[:n])
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
