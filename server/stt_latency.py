from __future__ import annotations

import logging
import os
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


def listen_summary_interval_s() -> int:
    """Seconds between ``listen_summary`` ticks. ``<= 0`` disables every line."""
    raw = os.environ.get("NOD_LISTEN_SUMMARY_S")
    if raw is None or str(raw).strip() == "":
        return 60
    try:
        return int(str(raw).strip())
    except ValueError:
        return 60


def uplink_client_kind(user_agent: str | None) -> str:
    if not user_agent:
        return "unknown"
    ua = user_agent.lower()
    if "okhttp" in ua:
        return "android"
    if "cfnetwork" in ua or "darwin" in ua:
        return "ios"
    return "other"


_SUMMARY_KEYS = (
    "stream",
    "ws",
    "reason",
    "path",
    "client",
    "wall_s",
    "rx_audio_s",
    "rx_rate",
    "uplink_lag_ms",
    "uplink_lag_max_ms",
    "dev_pending_ms",
    "backlog_ms",
    "pieces",
    "span_p50_ms",
    "span_p90_ms",
    "carry_wait_max_ms",
    "carry_timer_pct",
    "cut_eot",
    "cut_pause",
    "cut_max",
    "cut_stall",
)

_SPAN_SRCS = frozenset({"final", "carry_join"})
_CUTS = ("eot", "pause", "max", "stall")
_SPAN_CAP = 512


class ListenSummary:
    """Per-listen counters for the listen_summary line. Not thread-safe; caller locks."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._pieces = 0
        self._spans: dict[tuple[Any, Any], int] = {}
        self._cuts: dict[tuple[Any, Any], str] = {}
        self._carry_wait_max: int | None = None
        self._carry_timer = 0
        self._lag_max: int | None = None

    def note_piece(self, fields: dict) -> None:
        self._pieces += 1
        src = str(fields.get("src") or "")
        if src == "carry_timer":
            self._carry_timer += 1
        carry_wait = fields.get("carry_wait_ms")
        if carry_wait is not None:
            try:
                waited = int(carry_wait)
            except (TypeError, ValueError):
                waited = None
            if waited is not None and (self._carry_wait_max is None or waited > self._carry_wait_max):
                self._carry_wait_max = waited
        span = fields.get("line_span_ms")
        if src in _SPAN_SRCS and span is not None:
            try:
                span_ms = int(span)
            except (TypeError, ValueError):
                return
            key = (fields.get("stream"), fields.get("turn"))
            if key in self._spans:
                return
            self._spans[key] = span_ms
            cut = fields.get("cut")
            if cut in _CUTS:
                self._cuts[key] = str(cut)
            while len(self._spans) > _SPAN_CAP:
                oldest = next(iter(self._spans))
                self._spans.pop(oldest, None)
                self._cuts.pop(oldest, None)

    def note_lag(self, lag_ms: int | None) -> None:
        if lag_ms is None:
            return
        try:
            lag = int(lag_ms)
        except (TypeError, ValueError):
            return
        if self._lag_max is None or lag > self._lag_max:
            self._lag_max = lag

    def fields(self) -> dict:
        spans = list(self._spans.values())
        if self._pieces == 0 and self._lag_max is None and self._carry_wait_max is None and not spans:
            return {key: None for key in (
                "pieces",
                "span_p50_ms",
                "span_p90_ms",
                "carry_wait_max_ms",
                "carry_timer_pct",
                "cut_eot",
                "cut_pause",
                "cut_max",
                "cut_stall",
                "uplink_lag_max_ms",
            )}
        p50 = percentile(spans, 50)
        p90 = percentile(spans, 90)
        counts = {name: 0 for name in _CUTS}
        for cut in self._cuts.values():
            if cut in counts:
                counts[cut] += 1
        pct = round(100 * self._carry_timer / self._pieces) if self._pieces else None
        return {
            "pieces": self._pieces or None,
            "span_p50_ms": None if p50 is None else int(round(p50)),
            "span_p90_ms": None if p90 is None else int(round(p90)),
            "carry_wait_max_ms": self._carry_wait_max,
            "carry_timer_pct": pct,
            "cut_eot": counts["eot"] or None,
            "cut_pause": counts["pause"] or None,
            "cut_max": counts["max"] or None,
            "cut_stall": counts["stall"] or None,
            "uplink_lag_max_ms": self._lag_max,
        }


def format_listen_summary(fields: dict) -> str:
    parts = ["listen_summary"]
    for key in _SUMMARY_KEYS:
        val = fields.get(key)
        if val is None:
            continue
        parts.append(f"{key}={val}")
    return " ".join(parts)


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
