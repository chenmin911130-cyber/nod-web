"""Score Railway logs against Translate latency targets.

Not imported by the running app. Duplicate identical lines are counted as
separate events. Input may be plain text (optional timestamp and level
prefix) or one JSON object per line with a ``message`` field.

Usage: ``python3 -m server.latency_report <log files…|->``
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from typing import Any, Iterator

TARGETS = {
    "span_p50_ms_max": 6000,
    "carry_wait_max_ms": 3000,
    "carry_timer_share_max": 0.25,
    "stt_3007_max": 0,
}
UPLINK_TARGETS = {
    "rx_rate_p50_min": 0.995,
    "uplink_lag_ms_max": 1500,
    "dev_pending_ms_max": 1000,
    "dropped_ms_max": 0,
}

_KV = re.compile(r"(\w+)=(\S+)")
_TS = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z")
_SPAN_SRCS = frozenset({"final", "carry_join"})


def iter_messages(lines) -> Iterator[str]:
    for raw in lines:
        if raw is None:
            continue
        line = str(raw).strip()
        if not line:
            continue
        if line.startswith("{"):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                yield line
                continue
            if isinstance(obj, dict) and "message" in obj:
                yield str(obj["message"])
                continue
        yield line


def parse_kv(msg: str, marker: str) -> dict | None:
    """Tokens ``(\\w+)=(\\S+)`` after ``marker``. Ints where ``int()`` succeeds."""
    idx = msg.find(marker)
    if idx < 0:
        return None
    out: dict[str, Any] = {}
    for key, val in _KV.findall(msg[idx + len(marker) :]):
        if re.fullmatch(r"-?\d+", val):
            try:
                out[key] = int(val)
            except ValueError:
                out[key] = val
        else:
            out[key] = val
    return out


def _percentile(values: list[float], p: float) -> float | None:
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


def _as_int_metric(value: float | None) -> int | None:
    if value is None:
        return None
    return int(round(value))


def _stream_id(parsed: dict | None) -> str | None:
    if not parsed or "stream" not in parsed or parsed["stream"] in ("", None):
        return None
    return str(parsed["stream"])


def _timestamp(msg: str) -> datetime | None:
    match = _TS.search(msg)
    if not match:
        return None
    try:
        return datetime.fromisoformat(match.group(1))
    except ValueError:
        return None


def _float_token(parsed: dict, key: str) -> float | None:
    if key not in parsed:
        return None
    try:
        return float(parsed[key])
    except (TypeError, ValueError):
        return None


def build_report(
    lines,
    *,
    streams: set[str] | None,
    client: str | None,
    min_pieces: int,
) -> dict:
    messages = list(iter_messages(lines))
    clients: dict[str, str] = {}
    for msg in messages:
        parsed = parse_kv(msg, "listen_summary")
        sid = _stream_id(parsed)
        if parsed is not None and sid and "client" in parsed:
            clients[sid] = str(parsed["client"])

    allowed: set[str] | None
    if streams is not None:
        allowed = {str(s) for s in streams}
    else:
        allowed = None
    if client is not None:
        matching = {sid for sid, kind in clients.items() if kind == client}
        allowed = matching if allowed is None else (allowed & matching)

    def keep(parsed: dict | None) -> bool:
        if parsed is None:
            return False
        if allowed is None:
            return True
        sid = _stream_id(parsed)
        return sid is not None and sid in allowed

    pieces = 0
    spans: dict[tuple[str | None, Any], int] = {}
    carry_waits: list[int] = []
    carry_timer = 0
    stt_3007 = 0
    stt_other: dict[str, int] = {}
    per: dict[str, dict[str, Any]] = {}

    def bucket(sid: str) -> dict[str, Any]:
        row = per.get(sid)
        if row is None:
            row = {
                "client": clients.get(sid),
                "ticks": [],
                "dev_pending": [],
                "dropped": [],
            }
            per[sid] = row
        return row

    for msg in messages:
        translated = parse_kv(msg, "translate_latency")
        if translated is not None:
            if keep(translated):
                pieces += 1
                src = str(translated.get("src") or "")
                if src == "carry_timer":
                    carry_timer += 1
                if "carry_wait_ms" in translated:
                    try:
                        carry_waits.append(int(translated["carry_wait_ms"]))
                    except (TypeError, ValueError):
                        pass
                if src in _SPAN_SRCS and "line_span_ms" in translated:
                    try:
                        span_ms = int(translated["line_span_ms"])
                    except (TypeError, ValueError):
                        span_ms = None
                    if span_ms is not None:
                        key = (_stream_id(translated), translated.get("turn"))
                        if key not in spans:
                            spans[key] = span_ms
            continue

        summary = parse_kv(msg, "listen_summary")
        if summary is not None:
            if keep(summary):
                sid = _stream_id(summary) or ""
                row = bucket(sid)
                if summary.get("client"):
                    row["client"] = str(summary["client"])
                reason = str(summary.get("reason") or "tick")
                if reason == "tick":
                    row["ticks"].append(
                        {
                            "wall_s": summary.get("wall_s") if isinstance(summary.get("wall_s"), int) else None,
                            "ts": _timestamp(msg),
                            "lag": summary.get("uplink_lag_ms") if isinstance(summary.get("uplink_lag_ms"), int) else None,
                            "rx": _float_token(summary, "rx_rate"),
                            "dev_pending": summary.get("dev_pending_ms") if isinstance(summary.get("dev_pending_ms"), int) else None,
                        }
                    )
                if isinstance(summary.get("dev_pending_ms"), int):
                    row["dev_pending"].append(int(summary["dev_pending_ms"]))
            continue

        ping = parse_kv(msg, "uplink_ping")
        if ping is not None:
            if keep(ping):
                sid = _stream_id(ping) or ""
                row = bucket(sid)
                if isinstance(ping.get("dropped_ms"), int):
                    row["dropped"].append(int(ping["dropped_ms"]))
                if isinstance(ping.get("pending_ms"), int):
                    row["dev_pending"].append(int(ping["pending_ms"]))
                if isinstance(ping.get("dev_pending_ms"), int):
                    row["dev_pending"].append(int(ping["dev_pending_ms"]))
            continue

        if allowed is not None:
            continue
        err = re.search(r"assemblyai error code=(\d+)", msg)
        closed = re.search(r"assemblyai close status=(\d+)", msg)
        code = err.group(1) if err else (closed.group(1) if closed else None)
        if code is None:
            continue
        try:
            code_n = int(code)
        except ValueError:
            continue
        if code_n < 3000:
            continue
        if code_n == 3007:
            stt_3007 += 1
        else:
            stt_other[code] = stt_other.get(code, 0) + 1

    per_stream: dict[str, dict[str, Any]] = {}
    for sid, row in per.items():
        ticks = row["ticks"]
        rates = [t["rx"] for t in ticks if t["rx"] is not None]
        lags = [t["lag"] for t in ticks if t["lag"] is not None]
        after = ticks[1:]
        rates_after = [t["rx"] for t in after if t["rx"] is not None]
        lags_after = [t["lag"] for t in after if t["lag"] is not None]
        slope = None
        if len(ticks) >= 2 and lags:
            first, last = ticks[0], ticks[-1]
            minutes = None
            if isinstance(first.get("wall_s"), int) and isinstance(last.get("wall_s"), int):
                minutes = (last["wall_s"] - first["wall_s"]) / 60.0
            elif first.get("ts") is not None and last.get("ts") is not None:
                minutes = (last["ts"] - first["ts"]).total_seconds() / 60.0
            if minutes and minutes > 0 and first.get("lag") is not None and last.get("lag") is not None:
                slope = (last["lag"] - first["lag"]) / minutes
        dev_after = [t["dev_pending"] for t in after if t["dev_pending"] is not None]
        # Pings are not ticks; they stay in the device-backlog max.
        ping_pending = [v for v in row["dev_pending"] if v not in {t["dev_pending"] for t in ticks[:1]}]
        dev_values = dev_after + [v for v in row["dev_pending"] if v not in {t.get("dev_pending") for t in ticks}]
        if not ticks:
            dev_values = list(row["dev_pending"])
        per_stream[sid] = {
            "client": row["client"],
            "ticks": len(ticks),
            "rx_rate_p50": _percentile(rates_after if len(ticks) > 1 else rates, 50),
            "uplink_lag_first_ms": lags[0] if lags else None,
            "uplink_lag_last_ms": lags[-1] if lags else None,
            "uplink_lag_after_first_max_ms": max(lags_after) if lags_after else None,
            "lag_slope_ms_per_min": slope,
            "dev_pending_ms_max": max(dev_values) if dev_values else (max(ping_pending) if ping_pending else None),
            "dropped_ms_max": max(row["dropped"]) if row["dropped"] else None,
        }

    share = (carry_timer / pieces) if pieces else None
    return {
        "pieces": pieces,
        "span_p50_ms": _as_int_metric(_percentile(list(spans.values()), 50)),
        "carry_wait_max_ms": max(carry_waits) if carry_waits else None,
        "carry_wait_p95_ms": _as_int_metric(_percentile([float(v) for v in carry_waits], 95)),
        "carry_timer_share": share,
        "stt_3007": stt_3007,
        "stt_other_errors": stt_other,
        "per_stream": per_stream,
        "insufficient": pieces < min_pieces,
    }


def _check(name: str, value: Any, limit: float, *, higher_is_worse: bool) -> dict:
    if value is None:
        return {"name": name, "value": None, "limit": limit, "pass": True, "skip": True}
    ok = value <= limit if higher_is_worse else value >= limit
    return {"name": name, "value": value, "limit": limit, "pass": ok, "skip": False}


def checks_for(report: dict, *, check_uplink: bool) -> list[dict]:
    checks = [
        _check("span_p50_ms", report["span_p50_ms"], TARGETS["span_p50_ms_max"], higher_is_worse=True),
        _check("carry_wait_max_ms", report["carry_wait_max_ms"], TARGETS["carry_wait_max_ms"], higher_is_worse=True),
        _check(
            "carry_timer_share",
            report["carry_timer_share"],
            TARGETS["carry_timer_share_max"],
            higher_is_worse=True,
        ),
        _check("stt_3007", report["stt_3007"], TARGETS["stt_3007_max"], higher_is_worse=True),
    ]
    if not check_uplink:
        return checks
    for sid, row in report["per_stream"].items():
        prefix = f"uplink {sid}"
        checks.append(
            _check(
                f"{prefix} rx_rate_p50",
                row.get("rx_rate_p50"),
                UPLINK_TARGETS["rx_rate_p50_min"],
                higher_is_worse=False,
            )
        )
        checks.append(
            _check(
                f"{prefix} uplink_lag_ms",
                row.get("uplink_lag_after_first_max_ms"),
                UPLINK_TARGETS["uplink_lag_ms_max"],
                higher_is_worse=True,
            )
        )
        checks.append(
            _check(
                f"{prefix} dev_pending_ms",
                row.get("dev_pending_ms_max"),
                UPLINK_TARGETS["dev_pending_ms_max"],
                higher_is_worse=True,
            )
        )
        checks.append(
            _check(
                f"{prefix} dropped_ms",
                row.get("dropped_ms_max"),
                UPLINK_TARGETS["dropped_ms_max"],
                higher_is_worse=True,
            )
        )
        slope = row.get("lag_slope_ms_per_min")
        checks.append(
            {
                "name": f"{prefix} lag_slope_ms_per_min",
                "value": slope,
                "limit": None,
                "pass": True,
                "skip": True,
            }
        )
    return checks


def _format_value(value: Any) -> str:
    if value is None:
        return "none"
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


def format_text(report: dict, checks: list[dict]) -> str:
    lines = []
    for check in checks:
        if check.get("limit") is None:
            lines.append(f"{check['name']}={_format_value(check['value'])}")
            continue
        flag = "SKIP" if check.get("skip") else ("PASS" if check["pass"] else "FAIL")
        op = ">=" if "rx_rate" in check["name"] else "<="
        lines.append(f"{check['name']}={_format_value(check['value'])} {flag} ({op} {check['limit']})")
    if report.get("insufficient"):
        lines.append("insufficient data")
    return "\n".join(lines)


def _load(paths: list[str]) -> Iterator[str]:
    if not paths:
        yield from sys.stdin
        return
    for path in paths:
        if path == "-":
            yield from sys.stdin
            continue
        with open(path, encoding="utf-8", errors="replace") as handle:
            yield from handle


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python3 -m server.latency_report",
        description="Score Railway logs against Translate latency targets.",
    )
    parser.add_argument("logs", nargs="*", help="Log files. Use - for stdin.")
    parser.add_argument("--stream", action="append", default=None, help="Keep this stream id (repeatable).")
    parser.add_argument("--client", choices=("ios", "android", "web", "other", "unknown"))
    parser.add_argument("--check-uplink", action="store_true", help="Also score phone uplink targets.")
    parser.add_argument("--json", action="store_true", help="Print the report dict.")
    parser.add_argument("--min-pieces", type=int, default=30, help="Fewer translate_latency lines exit 2.")
    args = parser.parse_args(argv)
    report = build_report(
        _load(args.logs),
        streams=set(args.stream) if args.stream else None,
        client=args.client,
        min_pieces=args.min_pieces,
    )
    checks = checks_for(report, check_uplink=args.check_uplink)
    if args.json:
        payload = dict(report)
        payload["checks"] = checks
        json.dump(payload, sys.stdout, indent=2, default=str)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(format_text(report, checks) + "\n")
    if report["insufficient"]:
        return 2
    if all(check["pass"] for check in checks):
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
