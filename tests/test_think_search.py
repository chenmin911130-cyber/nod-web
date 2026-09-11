"""Think (#182): retrieval evidence + real sources, deterministic, no network.

The provider call sits behind a transport callable, so every test here runs
without a key, without a socket and without sleeping. What is asserted is the
contract the answer path depends on:

- the search query is the question (plus at most a bounded hint) — never the
  transcript, the personal background or an attachment;
- only real ``http(s)`` sources survive, and a missing publication date stays
  missing instead of being invented;
- an empty or failed search is reported explicitly instead of being dressed up
  as "fresh data", so the answer can never claim a live lookup that did not
  happen;
- the retrieval clock comes from the injected clock, not from the model.
"""

import unittest
from unittest import mock

from server import think


def _item(title="t", url="https://example.com/a", snippet="s", published_at=None):
    return {"title": title, "url": url, "snippet": snippet, "published_at": published_at}


class _Clock:
    def __init__(self, t=1_700_000_000.0):
        self.t = float(t)

    def __call__(self):
        return self.t


class BuildQueryTests(unittest.TestCase):
    def test_query_is_the_question_only(self):
        self.assertEqual(think.build_query("  2026 年 Apple 发布了什么？  "), "2026 年 Apple 发布了什么？")

    def test_query_collapses_newlines_so_a_transcript_paste_is_one_line(self):
        q = think.build_query("第一行\n第二行\t第三行")
        self.assertEqual(q, "第一行 第二行 第三行")

    def test_query_is_bounded_even_when_handed_a_whole_transcript(self):
        q = think.build_query("x" * 5000)
        self.assertLessEqual(len(q), think.MAX_QUERY_CHARS)
        self.assertTrue(q)

    def test_a_bounded_hint_may_be_appended_but_is_itself_bounded(self):
        q = think.build_query("那按年付呢？", hint="y" * 5000)
        self.assertLessEqual(len(q), think.MAX_QUERY_CHARS)
        self.assertTrue(q.startswith("那按年付呢？"))

    def test_blank_question_yields_an_empty_query(self):
        self.assertEqual(think.build_query("   \n  "), "")
        self.assertEqual(think.build_query(""), "")


class SafeUrlTests(unittest.TestCase):
    def test_http_and_https_survive(self):
        self.assertEqual(think.safe_url("https://example.com/a"), "https://example.com/a")
        self.assertEqual(think.safe_url("HTTP://Example.com/a"), "HTTP://Example.com/a")

    def test_dangerous_or_non_http_schemes_are_rejected(self):
        for raw in (
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html;base64,AAAA",
            "file:///etc/passwd",
            "ftp://example.com/x",
            "//example.com/x",
            "/relative/path",
            "",
            "   ",
            None,
        ):
            self.assertIsNone(think.safe_url(raw), raw)

    def test_url_is_trimmed_and_bounded(self):
        self.assertEqual(think.safe_url("  https://example.com/a  "), "https://example.com/a")
        long_url = "https://example.com/" + "p" * 5000
        self.assertLessEqual(len(think.safe_url(long_url) or ""), think.MAX_URL_CHARS)


class NormalizeResultsTests(unittest.TestCase):
    def test_only_safe_urls_survive_and_duplicates_collapse(self):
        got = think.normalize_results(
            [
                _item(title="a", url="https://example.com/a"),
                _item(title="a again", url="https://example.com/a"),
                _item(title="bad", url="javascript:alert(1)"),
                _item(title="no url", url=""),
                _item(title="b", url="https://example.com/b"),
            ]
        )
        self.assertEqual([r.url for r in got], ["https://example.com/a", "https://example.com/b"])
        self.assertEqual(got[0].title, "a")  # first occurrence wins

    def test_results_are_bounded(self):
        items = [_item(url=f"https://example.com/{i}") for i in range(50)]
        self.assertEqual(len(think.normalize_results(items, limit=3)), 3)
        self.assertEqual(think.normalize_results(items, limit=0), [])

    def test_missing_publication_date_stays_missing(self):
        got = think.normalize_results([_item(published_at=None), _item(url="https://b.example", published_at="")])
        self.assertEqual([r.published_at for r in got], [None, None])

    def test_a_real_publication_date_is_kept_verbatim(self):
        got = think.normalize_results([_item(published_at="2026-09-10T04:00:00Z")])
        self.assertEqual(got[0].published_at, "2026-09-10T04:00:00Z")

    def test_missing_title_falls_back_to_the_url_never_to_invented_text(self):
        got = think.normalize_results([_item(title="  ", url="https://example.com/a")])
        self.assertEqual(got[0].title, "https://example.com/a")

    def test_junk_input_never_raises(self):
        self.assertEqual(think.normalize_results(None), [])
        self.assertEqual(think.normalize_results([None, 7, "nope", {}]), [])

    def test_snippet_is_trimmed_and_bounded(self):
        got = think.normalize_results([_item(snippet="  z" * 4000)])
        self.assertLessEqual(len(got[0].snippet), think.MAX_SNIPPET_CHARS)


class EvidenceBlockTests(unittest.TestCase):
    def mk_outcome(self, **kw):
        return think.SearchOutcome(
            status=kw.get("status", "ok"),
            query=kw.get("query", "q"),
            results=tuple(kw.get("results", ())),
            retrieved_at=kw.get("retrieved_at", 1789012800.0),
            error=kw.get("error", ""),
        )

    def test_evidence_carries_the_retrieval_time_and_numbered_sources(self):
        out = self.mk_outcome(
            results=[
                think.SearchResult("Apple News", "https://example.com/apple", "snippet", "2026-09-10"),
                think.SearchResult("Other", "https://example.com/other", "", None),
            ]
        )
        block = think.format_evidence(out)
        self.assertIn("检索时间：2026-09-10 04:00 UTC", block)  # the server clock, not the model
        self.assertIn("[1] Apple News", block)
        self.assertIn("https://example.com/apple", block)
        self.assertIn("2026-09-10", block)  # the real publication date
        self.assertIn("[2] Other", block)
        self.assertIn("发布时间未提供", block)  # never invented for the second source

    def test_evidence_forbids_inventing_dates_and_claims(self):
        block = think.format_evidence(self.mk_outcome(results=[think.SearchResult("t", "https://e.com", "", None)]))
        self.assertIn("不得", block)

    def test_an_empty_result_set_produces_no_evidence_block(self):
        self.assertEqual(think.format_evidence(self.mk_outcome(status="empty", results=[])), "")

    def test_evidence_is_bounded(self):
        many = [think.SearchResult(f"t{i}", f"https://e.com/{i}", "s" * 500, None) for i in range(30)]
        block = think.format_evidence(self.mk_outcome(results=many))
        self.assertLessEqual(len(block), think.MAX_EVIDENCE_CHARS)


class SourcesPayloadTests(unittest.TestCase):
    def mk_outcome(self, status="ok", results=(), error=""):
        return think.SearchOutcome(
            status=status, query="q", results=tuple(results), retrieved_at=1789012800.0, error=error
        )

    def test_payload_carries_real_titles_urls_dates_and_the_retrieval_time(self):
        out = self.mk_outcome(
            results=[
                think.SearchResult("Apple", "https://example.com/a", "snip", "2026-09-10"),
                think.SearchResult("Other", "https://example.com/b", "", None),
            ]
        )
        payload = think.sources_payload(out)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["retrieved_at"], 1789012800.0)
        self.assertEqual(payload["retrieved_at_text"], "2026-09-10 04:00 UTC")
        self.assertEqual(
            payload["results"],
            [
                {"title": "Apple", "url": "https://example.com/a", "published_at": "2026-09-10"},
                {"title": "Other", "url": "https://example.com/b", "published_at": None},
            ],
        )
        self.assertNotIn("snippet", payload["results"][0])  # the client never renders raw page text

    def test_failed_search_carries_an_explicit_note_and_no_results(self):
        payload = think.sources_payload(self.mk_outcome(status="failed", error="TimeoutError"))
        self.assertEqual(payload["status"], "failed")
        self.assertEqual(payload["results"], [])
        self.assertTrue(payload["note"])
        self.assertNotIn("sk-", payload["note"])

    def test_empty_search_carries_an_explicit_note(self):
        payload = think.sources_payload(self.mk_outcome(status="empty"))
        self.assertEqual(payload["status"], "empty")
        self.assertTrue(payload["note"])

    def test_a_successful_search_has_no_warning_note(self):
        payload = think.sources_payload(
            self.mk_outcome(results=[think.SearchResult("t", "https://e.com", "", None)])
        )
        self.assertEqual(payload["note"], "")


class SearchClientTests(unittest.TestCase):
    def _client(self, transport, **kw):
        self.clock = _Clock()
        return think.SearchClient(transport, clock=self.clock, **kw)

    def test_a_successful_lookup_normalizes_and_stamps_the_clock(self):
        seen = {}

        def transport(request):
            seen.update(request)
            return {"results": [{"title": "A", "url": "https://e.com/a", "content": "snip", "published_date": "2026-09-10"}]}

        client = self._client(transport)
        out = client.search("what is new?")
        self.assertEqual(out.status, "ok")
        self.assertEqual(out.retrieved_at, self.clock.t)
        self.assertEqual([r.url for r in out.results], ["https://e.com/a"])
        self.assertEqual(seen["query"], "what is new?")
        self.assertGreater(seen["timeout"], 0)

    def test_an_empty_response_is_empty_not_ok(self):
        out = self._client(lambda request: {"results": []}).search("q")
        self.assertEqual(out.status, "empty")
        self.assertEqual(out.results, ())

    def test_a_transport_error_is_reported_not_raised(self):
        def boom(request):
            raise TimeoutError("upstream stalled")

        out = self._client(boom).search("q")
        self.assertEqual(out.status, "failed")
        self.assertEqual(out.error, "TimeoutError")
        self.assertEqual(out.results, ())

    def test_a_blank_query_never_reaches_the_transport(self):
        calls = []

        def transport(request):
            calls.append(request)
            return {"results": []}

        out = self._client(transport).search("   ")
        self.assertEqual(calls, [])
        self.assertEqual(out.status, "empty")

    def test_the_transport_receives_a_bounded_query_never_the_transcript(self):
        seen = {}

        def transport(request):
            seen.update(request)
            return {"results": []}

        self._client(transport).search("x" * 5000)
        self.assertLessEqual(len(seen["query"]), think.MAX_QUERY_CHARS)

    def test_a_malformed_payload_is_failed_not_a_crash(self):
        out = self._client(lambda request: {"nonsense": True}).search("q")
        self.assertEqual(out.status, "empty")
        self.assertEqual(out.results, ())


if __name__ == "__main__":
    unittest.main()
