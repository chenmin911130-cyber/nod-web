"""#182: the Parallel Search adapter — contract pinned from the official OpenAPI spec.

    POST https://api.parallel.ai/v1/search
    header  x-api-key
    body    {objective, search_queries[], mode, max_chars_total}
    resp    {search_id, session_id, results[{url,title,publish_date,excerpts[]}], usage[]}

Everything here runs on a fake HTTP layer: no key, no socket, no spend.
"""

import unittest
from unittest import mock

from server import think


class SearchQueryTests(unittest.TestCase):
    def test_an_english_question_becomes_content_keywords(self):
        queries = think.build_search_queries(
            "What did Apple announce about the new iPhone at the September event?"
        )
        self.assertEqual(queries, ["Apple announce new iPhone September event"])
        self.assertLessEqual(len(queries), think.MAX_SEARCH_QUERIES)
        for one in queries:
            self.assertLessEqual(len(one.split()), think.MAX_QUERY_WORDS)

    def test_a_long_question_is_split_into_at_most_three_bounded_queries(self):
        queries = think.build_search_queries(
            "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron"
        )
        self.assertGreaterEqual(len(queries), 1)
        self.assertLessEqual(len(queries), 3)
        for one in queries:
            self.assertLessEqual(len(one.split()), think.MAX_QUERY_WORDS)
        self.assertEqual(len(set(queries)), len(queries), "no duplicate queries")

    def test_a_cjk_question_travels_whole_and_bounded(self):
        queries = think.build_search_queries("2026年9月苹果发布了什么新产品？" * 20)
        self.assertEqual(len(queries), 1, "a CJK question cannot be word-split without a model")
        self.assertLessEqual(len(queries[0]), 24)

    def test_no_keyword_call_is_needed_for_an_empty_or_filler_question(self):
        self.assertEqual(think.build_search_queries("   "), [])
        self.assertEqual(think.build_search_queries("why?"), ["why"])


class ParallelItemTests(unittest.TestCase):
    def test_the_spec_shape_maps_to_canonical_items(self):
        items = think.parallel_items(
            {
                "search_id": "s",
                "session_id": "x",
                "results": [
                    {
                        "url": "https://e.com/a",
                        "title": "Apple News",
                        "publish_date": "2026-09-10",
                        "excerpts": ["first excerpt", "second excerpt"],
                    }
                ],
            }
        )
        self.assertEqual(
            items,
            [
                {
                    "title": "Apple News",
                    "url": "https://e.com/a",
                    "snippet": "first excerpt second excerpt",
                    "published_at": "2026-09-10",
                }
            ],
        )

    def test_missing_fields_stay_missing(self):
        items = think.parallel_items({"results": [{"url": "https://e.com/b"}]})
        self.assertEqual(items[0]["title"], None)
        self.assertEqual(items[0]["published_at"], None)
        self.assertEqual(items[0]["snippet"], "")

    def test_junk_payloads_never_raise(self):
        self.assertEqual(think.parallel_items(None), [])
        self.assertEqual(think.parallel_items({"results": "nope"}), [])
        self.assertEqual(think.parallel_items({"results": [None, 7, "x"]}), [])


class ParallelTransportTests(unittest.TestCase):
    def _fake_client(self, payload):
        response = mock.Mock()
        response.json.return_value = payload
        client = mock.MagicMock()
        client.__enter__.return_value = client
        client.post.return_value = response
        return client

    def test_the_request_matches_the_pinned_contract(self):
        client = self._fake_client({"results": []})
        with (
            mock.patch("server.think.httpx.Client", return_value=client) as Client,
            mock.patch("server.think.httpx.HTTPTransport") as TransportLayer,
        ):
            out = think.parallel_transport("test-key", client_model="deepseek-flash")(
                {"query": "What did Apple announce?", "timeout": 5.0}
            )

        # Implicit HTTP retries are off: a sent-but-timed-out request must never
        # become a silent second call behind the budget gate.
        TransportLayer.assert_called_once_with(retries=0)
        self.assertIs(Client.call_args.kwargs["transport"], TransportLayer.return_value)

        (url,) = client.post.call_args.args
        self.assertEqual(url, think.PARALLEL_SEARCH_ENDPOINT)
        self.assertEqual(client.post.call_args.kwargs["headers"], {"x-api-key": "test-key"})
        body = client.post.call_args.kwargs["json"]
        self.assertEqual(body["mode"], "basic")
        self.assertEqual(body["objective"], "What did Apple announce?")
        self.assertEqual(body["search_queries"], ["Apple announce"])
        self.assertEqual(body["max_chars_total"], think.MAX_CHARS_TOTAL)
        self.assertEqual(body["client_model"], "deepseek-flash")
        self.assertEqual(out, {"results": []})

    def test_a_blank_question_never_spends_a_request(self):
        with mock.patch("server.think.httpx.Client") as Client:
            out = think.parallel_transport("test-key")({"query": "   "})
        Client.assert_not_called()
        self.assertEqual(out, {"results": []})

    def test_end_to_end_normalizes_a_real_shaped_payload(self):
        payload = {
            "search_id": "search-1",
            "session_id": "session-1",
            "usage": [{"name": "search", "count": 1}],
            "results": [
                {
                    "url": "https://e.com/a",
                    "title": "Apple News",
                    "publish_date": "2026-09-10",
                    "excerpts": ["# Head", "body text"],
                },
                {"url": "javascript:alert(1)", "title": "bad", "publish_date": None, "excerpts": []},
                {"url": "https://e.com/b", "title": None, "publish_date": None, "excerpts": ["b"]},
            ],
        }
        client = self._fake_client(payload)
        with mock.patch("server.think.httpx.Client", return_value=client):
            outcome = think.SearchClient(
                think.parallel_transport("test-key"), clock=lambda: 1789012800.0
            ).search("What did Apple announce?")

        self.assertEqual(outcome.status, think.STATUS_OK)
        self.assertEqual([r.url for r in outcome.results], ["https://e.com/a", "https://e.com/b"])
        self.assertEqual(outcome.results[0].title, "Apple News")
        self.assertEqual(outcome.results[0].published_at, "2026-09-10")
        self.assertEqual(outcome.results[1].title, "https://e.com/b", "a missing title falls back to the url")
        self.assertIsNone(outcome.results[1].published_at, "a missing date is never invented")
        self.assertEqual(outcome.retrieved_at, 1789012800.0, "the retrieval stamp is our clock")


if __name__ == "__main__":
    unittest.main()
