from __future__ import annotations

import logging
import threading
import time
from typing import Any

_log = logging.getLogger("nod")


def percentile(values: list[float | int], p: float) -> float | None:
    if not values:
        return None
    if len(values) == 1:
        return float(values[0])
    ordered = sorted(float(v) for v in values)
    if p <= 0:
        return ordered[0]
    if p >= 100:
        return ordered[-1]
    k = (len(ordered) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(ordered) - 1)
    if f == c:
        return ordered[f]
    return ordered[f] + (ordered[c] - ordered[f]) * (k - f)


class LatencyWindow:
    def __init__(self, seconds: float = 3600.0) -> None:
        self._seconds = float(seconds)
        self._lock = threading.Lock()
        self._samples: dict[str, list[tuple[float, float]]] = {}

    def add(self, name: str, ms: float | int | None, now: float | None = None) -> None:
        if ms is None:
            return
        ts = time.time() if now is None else float(now)
        with self._lock:
            self._samples.setdefault(name, []).append((ts, float(ms)))

    def snapshot(self, now: float | None = None) -> dict[str, dict[str, float | int | None]]:
        ts = time.time() if now is None else float(now)
        cutoff = ts - self._seconds
        out: dict[str, dict[str, float | int | None]] = {}
        with self._lock:
            for name, rows in list(self._samples.items()):
                kept = [ms for t, ms in rows if t >= cutoff]
                self._samples[name] = [(t, ms) for t, ms in rows if t >= cutoff]
                if not kept:
                    continue
                p50 = percentile(kept, 50)
                p95 = percentile(kept, 95)
                out[name] = {
                    "n": len(kept),
                    "p50": None if p50 is None else int(round(p50)),
                    "p95": None if p95 is None else int(round(p95)),
                }
        return out


STT_LATENCY_WINDOW = LatencyWindow(3600.0)


def record_stt_latency(
    *,
    workspace: str,
    meta: dict[str, Any],
    hold_ms: int | None,
    speaker_labels: int,
    max_turn_silence: int | str,
    stream: str,
) -> None:
    commit_mono = meta.get("__commit_mono__")
    pipeline_ms: int | None = None
    if commit_mono is not None:
        pipeline_ms = int(round((time.monotonic() - float(commit_mono)) * 1000))

    fields: dict[str, Any] = {
        "ws": workspace,
        "turn": meta.get("stt_turn") if meta.get("stt_turn") is not None else meta.get("turn_order"),
        "format_wait_ms": meta.get("format_wait_ms"),
        "asr_lag_ms": meta.get("asr_lag_ms"),
        "backlog_ms": meta.get("backlog_ms"),
        "hold_ms": hold_ms,
        "pipeline_ms": pipeline_ms,
        "n_words": meta.get("n_words"),
        "speaker_labels": speaker_labels,
        "max_turn_silence": max_turn_silence,
        "stream": stream,
    }
    parts = ["stt_latency"] + [f"{k}={v}" for k, v in fields.items() if v is not None]
    _log.info(" ".join(parts))

    now = time.time()
    for key in ("format_wait_ms", "asr_lag_ms", "backlog_ms", "hold_ms", "pipeline_ms"):
        STT_LATENCY_WINDOW.add(key, fields.get(key), now)


def record_translate_latency(fields: dict[str, Any]) -> None:
    """One structured line per translated piece (Translate latency A1)."""
    out: dict[str, Any] = {}
    for key in (
        "stream",
        "turn",
        "piece",
        "src",
        "cut",
        "passthrough",
        "first_word_ms",
        "last_word_ms",
        "commit_audio_ms",
        "asr_lag_ms",
        "backlog_ms",
        "dev_backlog_ms",
        "uplink_lag_ms",
        "carry_wait_ms",
        "queue_wait_ms",
        "llm_ttft_ms",
        "llm_total_ms",
        "speech_to_chunk_ms",
        "line_span_ms",
        "chars",
        "lang",
        "failed",
    ):
        val = fields.get(key)
        if val is not None:
            out[key] = val
    parts = ["translate_latency"] + [f"{k}={v}" for k, v in out.items()]
    _log.info(" ".join(parts))
    now = time.time()
    for key in (
        "tr_line_span_ms",
        "tr_carry_wait_ms",
        "tr_queue_wait_ms",
        "tr_llm_ttft_ms",
        "tr_speech_to_chunk_ms",
    ):
        mapped = {
            "tr_line_span_ms": fields.get("line_span_ms"),
            "tr_carry_wait_ms": fields.get("carry_wait_ms"),
            "tr_queue_wait_ms": fields.get("queue_wait_ms"),
            "tr_llm_ttft_ms": fields.get("llm_ttft_ms"),
            "tr_speech_to_chunk_ms": fields.get("speech_to_chunk_ms"),
        }
        STT_LATENCY_WINDOW.add(key, mapped.get(key), now)
