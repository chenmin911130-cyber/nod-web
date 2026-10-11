"""Listen gap detection (device drop, capture pause, server drop). Pure logic — no I/O."""

from __future__ import annotations

from dataclasses import dataclass, replace

MIN_GAP_MS = 2000


def recording_rel_ms(wall: float, listen_started_at: float, listen_accum_sec: float) -> int:
    if listen_started_at <= 0:
        return int(listen_accum_sec * 1000)
    return int((wall - listen_started_at) * 1000 + listen_accum_sec * 1000)


@dataclass(frozen=True)
class Gap:
    id: str
    from_ms: int
    to_ms: int
    reason: str


class GapTracker:
    def __init__(self) -> None:
        self._seq = 0
        self._last_ping_wall: float | None = None
        self._last_enqueued_ms: int | None = None
        self._last_dropped_ms: int | None = None
        self._last_limited_bytes = 0
        self._pcm_pause: tuple[float, float] | None = None
        self._resume_wall: float | None = None
        self._skip_ping = False
        self._capture_paused = False
        self._open_capture: Gap | None = None

    def reset(self) -> None:
        self._last_ping_wall = None
        self._last_enqueued_ms = None
        self._last_dropped_ms = None
        self._last_limited_bytes = 0
        self._pcm_pause = None
        self._resume_wall = None
        self._open_capture = None
        self._capture_paused = False
        self._skip_ping = True

    def note_pcm(self, now_wall: float, last_pcm_at: float) -> None:
        if last_pcm_at > 0 and now_wall - last_pcm_at >= 2.0:
            self._pcm_pause = (last_pcm_at, now_wall)

    def note_resume(self, now_wall: float) -> None:
        self._resume_wall = now_wall

    def note_pause(self) -> None:
        self._capture_paused = True
        self._last_ping_wall = None
        self._last_enqueued_ms = None
        self._last_dropped_ms = None
        self._pcm_pause = None
        self._resume_wall = None
        self._open_capture = None

    def note_resume_listen(self, now_wall: float) -> None:
        self._capture_paused = False
        self._skip_ping = True
        self._last_ping_wall = now_wall
        self._last_enqueued_ms = None
        self._last_dropped_ms = None
        self._last_limited_bytes = 0
        self._pcm_pause = None
        self._resume_wall = None
        self._open_capture = None

    def _dropped_position(self, now_wall: float) -> float:
        if (
            self._pcm_pause is not None
            and self._last_ping_wall is not None
            and self._pcm_pause[1] > self._last_ping_wall
        ):
            return self._pcm_pause[0]
        if self._resume_wall is not None:
            return self._resume_wall
        if self._last_ping_wall is not None:
            return self._last_ping_wall
        return now_wall

    def _new_gap(
        self,
        wall_pos: float,
        length_ms: int,
        reason: str,
        listen_started_at: float,
        listen_accum_sec: float,
    ) -> Gap:
        self._seq += 1
        from_ms = recording_rel_ms(wall_pos, listen_started_at, listen_accum_sec)
        return Gap(
            id=f"gap-{self._seq}",
            from_ms=from_ms,
            to_ms=from_ms + length_ms,
            reason=reason,
        )

    def _store_baseline(
        self,
        now_wall: float,
        enqueued_ms: int | None,
        dropped_ms: int | None,
        limited_bytes: int,
    ) -> None:
        self._last_ping_wall = now_wall
        if enqueued_ms is not None:
            self._last_enqueued_ms = enqueued_ms
        if dropped_ms is not None:
            self._last_dropped_ms = dropped_ms
        self._last_limited_bytes = limited_bytes

    def note_ping(
        self,
        now_wall: float,
        enqueued_ms: int | None,
        dropped_ms: int | None,
        limited_bytes: int,
        paused: bool,
        listen_started_at: float,
        listen_accum_sec: float,
    ) -> list[Gap]:
        gaps: list[Gap] = []

        if self._skip_ping:
            self._skip_ping = False
            self._store_baseline(now_wall, enqueued_ms, dropped_ms, limited_bytes)
            return gaps

        if paused or self._capture_paused:
            self._store_baseline(now_wall, enqueued_ms, dropped_ms, limited_bytes)
            return gaps

        enqueued_rolled = (
            enqueued_ms is not None
            and self._last_enqueued_ms is not None
            and enqueued_ms < self._last_enqueued_ms
        )
        dropped_rolled = (
            dropped_ms is not None
            and self._last_dropped_ms is not None
            and dropped_ms < self._last_dropped_ms
        )

        if (
            self._last_ping_wall is not None
            and dropped_ms is not None
            and not dropped_rolled
            and self._last_dropped_ms is not None
        ):
            delta_dropped = dropped_ms - self._last_dropped_ms
            if delta_dropped >= MIN_GAP_MS:
                pos = self._dropped_position(now_wall)
                gaps.append(
                    self._new_gap(pos, delta_dropped, "dropped", listen_started_at, listen_accum_sec)
                )

        capture_len: int | None = None
        delta_enqueued = 0
        if (
            self._last_ping_wall is not None
            and enqueued_ms is not None
            and not enqueued_rolled
            and self._last_enqueued_ms is not None
        ):
            delta_wall_ms = int((now_wall - self._last_ping_wall) * 1000)
            delta_enqueued = enqueued_ms - self._last_enqueued_ms
            capture_len = delta_wall_ms - delta_enqueued

        if capture_len is not None and capture_len >= MIN_GAP_MS:
            if self._open_capture is not None:
                gap = replace(self._open_capture, to_ms=self._open_capture.to_ms + capture_len)
                still_open = delta_enqueued == 0
            else:
                if (
                    self._pcm_pause is not None
                    and self._last_ping_wall is not None
                    and self._pcm_pause[1] > self._last_ping_wall
                ):
                    from_wall = self._pcm_pause[0]
                else:
                    from_wall = self._last_ping_wall + delta_enqueued / 1000.0
                gap = self._new_gap(from_wall, capture_len, "capture", listen_started_at, listen_accum_sec)
                still_open = from_wall + capture_len / 1000.0 >= now_wall - 1.0
            self._open_capture = gap if still_open else None
            gaps.append(gap)
        else:
            self._open_capture = None

        if self._last_ping_wall is not None:
            delta_limited = limited_bytes - self._last_limited_bytes
            server_len = delta_limited // 32
            if server_len >= MIN_GAP_MS:
                gaps.append(
                    self._new_gap(now_wall, server_len, "server", listen_started_at, listen_accum_sec)
                )

        self._store_baseline(now_wall, enqueued_ms, dropped_ms, limited_bytes)
        self._resume_wall = None
        self._pcm_pause = None
        return gaps
