"""latency_report: Railway logs to pass/fail against Translate latency targets (T2)."""

from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout

from server.latency_report import build_report, main, parse_kv

PREFIX = "2026-09-25T20:00:00.123Z [inf] "


def _line(body: str, *, minute: int = 0) -> str:
    ts = f"2026-09-25T20:{minute:02d}:00.123Z [inf] "
    return ts + body


def _run(text: str, *args: str) -> tuple[int, str]:
    path = None
    try:
        with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8") as fh:
            fh.write(text)
            path = fh.name
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = main([*args, path])
        return code, buf.getvalue()
    finally:
        if path:
            os.unlink(path)


class ParseTests(unittest.TestCase):
    def test_parse_kv_ignores_text_after_tokens(self):
        msg = PREFIX + "translate_latency src=final cut=eot trailing words are not tokens"
        parsed = parse_kv(msg, "translate_latency")
        self.assertEqual(parsed, {"src": "final", "cut": "eot"})

    def test_non_int_values_kept_as_str(self):
        parsed = parse_kv("translate_latency src=flush:stop line_span_ms=4000", "translate_latency")
        self.assertEqual(parsed["src"], "flush:stop")
        self.assertEqual(parsed["line_span_ms"], 4000)
        self.assertIsInstance(parsed["src"], str)

    def test_json_message_and_plain_prefix(self):
        lines = [
            _line("translate_latency stream=s turn=1 src=final line_span_ms=1000"),
            json.dumps({"message": "translate_latency stream=s turn=2 src=final line_span_ms=2000", "level": "info"}),
        ]
        report = build_report(lines, streams=None, client=None, min_pieces=1)
        self.assertEqual(report["pieces"], 2)
        self.assertEqual(report["span_p50_ms"], 1500)


class ReportTests(unittest.TestCase):
    def test_span_median_dedupes_turns(self):
        lines = [
            _line("translate_latency stream=s turn=1 src=final line_span_ms=4000"),
            _line("translate_latency stream=s turn=2 src=carry_join line_span_ms=6000"),
            _line("translate_latency stream=s turn=2 src=final line_span_ms=9000"),
            _line("translate_latency stream=s src=carry_timer carry_wait_ms=100"),
        ]
        report = build_report(lines, streams=None, client=None, min_pieces=1)
        self.assertEqual(report["pieces"], 4)
        self.assertEqual(report["span_p50_ms"], 5000)

    def test_duplicate_lines_are_counted(self):
        body = _line("translate_latency stream=s turn=1 src=final line_span_ms=4000")
        report = build_report([body, body], streams=None, client=None, min_pieces=1)
        self.assertEqual(report["pieces"], 2)
        self.assertEqual(report["span_p50_ms"], 4000)

    def test_carry_stats(self):
        lines = [
            _line("translate_latency stream=s turn=1 src=final line_span_ms=4000 carry_wait_ms=1200"),
            _line("translate_latency stream=s turn=2 src=final line_span_ms=4000 carry_wait_ms=2500"),
            _line("translate_latency stream=s turn=3 src=carry_join line_span_ms=4000 carry_wait_ms=2600"),
            _line("translate_latency stream=s src=carry_timer carry_wait_ms=10"),
        ]
        report = build_report(lines, streams=None, client=None, min_pieces=1)
        self.assertEqual(report["carry_wait_max_ms"], 2600)
        self.assertEqual(report["carry_timer_share"], 0.25)
        code, text = _run("\n".join(lines) + "\n", "--min-pieces", "1")
        self.assertEqual(code, 0)
        self.assertIn("PASS", text)

    def test_3007_both_forms(self):
        lines = [
            _line(f"translate_latency stream=s turn={i} src=final line_span_ms=1000")
            for i in range(4)
        ]
        lines.append(_line("assemblyai error code=3007 error=rate exceeded"))
        lines.append(
            json.dumps({"message": "assemblyai close status=3007 reason=rate exceeded"})
        )
        lines.append(_line("assemblyai error code=3005 error=other"))
        report = build_report(lines, streams=None, client=None, min_pieces=1)
        self.assertEqual(report["stt_3007"], 2)
        self.assertEqual(report["stt_other_errors"], {"3005": 1})
        self.assertNotIn("3007", report["stt_other_errors"])
        code, text = _run("\n".join(lines) + "\n", "--min-pieces", "1")
        self.assertEqual(code, 1)
        self.assertIn("FAIL", text)

    def test_insufficient_data_exit_2(self):
        lines = [
            _line(f"translate_latency stream=s turn={i} src=final line_span_ms=1000")
            for i in range(5)
        ]
        code, text = _run("\n".join(lines) + "\n", "--min-pieces", "30")
        self.assertEqual(code, 2)
        self.assertIn("insufficient data", text)

    def test_empty_input_exit_2(self):
        code, text = _run("", "--min-pieces", "30")
        self.assertEqual(code, 2)
        self.assertIn("insufficient data", text)

    def test_stream_filter_no_match_exit_2(self):
        text = _line("translate_latency stream=s turn=1 src=final line_span_ms=1000\n")
        code, out = _run(text, "--stream", "missing", "--min-pieces", "1")
        self.assertEqual(code, 2)
        self.assertIn("insufficient data", out)

    def test_all_pass_exit_0(self):
        lines = [
            _line(f"translate_latency stream=s turn={i} src=final line_span_ms=4000 carry_wait_ms=1000")
            for i in range(30)
        ]
        code, text = _run("\n".join(lines) + "\n")
        self.assertEqual(code, 0)
        self.assertIn("PASS", text)
        self.assertNotIn("FAIL", text)

    def test_uplink_check(self):
        lines = [
            _line(
                "listen_summary stream=ios1 reason=tick client=ios wall_s=60 rx_rate=0.940 uplink_lag_ms=3600 dev_pending_ms=200",
                minute=0,
            ),
            _line(
                "listen_summary stream=ios1 reason=tick client=ios wall_s=120 rx_rate=0.940 uplink_lag_ms=7200 dev_pending_ms=400",
                minute=1,
            ),
            _line(
                "listen_summary stream=web1 reason=tick client=web wall_s=60 rx_rate=1.000 uplink_lag_ms=200 dev_pending_ms=100",
                minute=0,
            ),
            _line(
                "listen_summary stream=web1 reason=tick client=web wall_s=120 rx_rate=1.000 uplink_lag_ms=300 dev_pending_ms=80",
                minute=1,
            ),
            _line("uplink_ping stream=ios1 dropped_ms=0 pending_ms=400"),
            _line("uplink_ping stream=web1 dropped_ms=0 pending_ms=80"),
            _line("translate_latency stream=ios1 turn=1 src=final line_span_ms=4000"),
            _line("translate_latency stream=web1 turn=1 src=final line_span_ms=4000"),
        ]
        blob = "\n".join(lines) + "\n"
        ios = build_report(blob.splitlines(), streams=None, client="ios", min_pieces=1)
        self.assertIn("ios1", ios["per_stream"])
        self.assertNotIn("web1", ios["per_stream"])
        self.assertAlmostEqual(ios["per_stream"]["ios1"]["lag_slope_ms_per_min"], 3600, delta=1)
        code, text = _run(blob, "--client", "ios", "--check-uplink", "--min-pieces", "1")
        self.assertEqual(code, 1)
        self.assertIn("FAIL", text)
        web = build_report(blob.splitlines(), streams=None, client="web", min_pieces=1)
        self.assertIn("web1", web["per_stream"])
        self.assertNotIn("ios1", web["per_stream"])
        code_ok, text_ok = _run(blob, "--client", "web", "--check-uplink", "--min-pieces", "1")
        self.assertEqual(code_ok, 0, text_ok)
        self.assertNotIn("FAIL", text_ok)

    def test_3007_counts_unfiltered_with_client_and_uplink(self):
        lines = [
            _line(
                "listen_summary stream=ios1 reason=tick client=ios wall_s=60 rx_rate=1.000 uplink_lag_ms=100 dev_pending_ms=10",
                minute=0,
            ),
            _line(
                "listen_summary stream=ios1 reason=tick client=ios wall_s=120 rx_rate=1.000 uplink_lag_ms=100 dev_pending_ms=10",
                minute=1,
            ),
            _line("uplink_ping stream=ios1 dropped_ms=0 pending_ms=10"),
            _line("translate_latency stream=ios1 turn=1 src=final line_span_ms=4000"),
            _line("assemblyai error code=3007 error=rate exceeded"),
            json.dumps({"message": "assemblyai close status=3005 reason=other"}),
        ]
        blob = "\n".join(lines) + "\n"
        report = build_report(blob.splitlines(), streams={"other"}, client="ios", min_pieces=1)
        self.assertEqual(report["stt_3007"], 1)
        self.assertEqual(report["stt_3007_scope"], "unfiltered")
        self.assertEqual(report["stt_other_errors"], {"3005": 1})
        code, text = _run(blob, "--client", "ios", "--check-uplink", "--min-pieces", "1")
        self.assertEqual(code, 1, text)
        self.assertIn("stt_3007=1 unfiltered FAIL", text)
        self.assertNotIn("stt_3007=0", text)

    def test_uplink_fewer_than_two_ticks_is_insufficient(self):
        lines = [
            _line(
                "listen_summary stream=ios1 reason=tick client=ios wall_s=60 rx_rate=1.000 uplink_lag_ms=100 dev_pending_ms=10"
            ),
            _line("translate_latency stream=ios1 turn=1 src=final line_span_ms=4000"),
            _line("uplink_ping stream=ios1 dropped_ms=0 pending_ms=10"),
        ]
        code, text = _run("\n".join(lines) + "\n", "--client", "ios", "--check-uplink", "--min-pieces", "1")
        self.assertEqual(code, 1, text)
        self.assertIn("uplink ios1 ticks=1 insufficient", text)
        self.assertNotIn("uplink ios1 rx_rate_p50", text)
        self.assertNotRegex(text, r"uplink ios1 .*PASS")
        ping_only = "\n".join(
            [
                _line("uplink_ping stream=ios1 dropped_ms=0 pending_ms=10"),
                _line("translate_latency stream=ios1 turn=1 src=final line_span_ms=4000"),
            ]
        ) + "\n"
        code0, text0 = _run(ping_only, "--check-uplink", "--min-pieces", "1")
        self.assertEqual(code0, 1, text0)
        self.assertIn("uplink ios1 ticks=0 insufficient", text0)


if __name__ == "__main__":
    unittest.main()
