"""Pure unit tests for server/qa_semantic.py (issue #191).

No Session, no model, no network: the semantic buffer, the judgement parsing
and the answer-context bounding are all pure functions.
"""

import unittest

from server import qa_semantic as qs


def _frag(fid, text, at=0.0, lang="en"):
    return qs.new_fragment(text, lang, frag_id=fid, at=at)


class FragmentIdentityTests(unittest.TestCase):
    def test_same_stt_turn_shares_identity(self):
        meta = {"stt_turn": 7, "listener_id": 123, "revision": True}
        self.assertEqual(qs.fragment_identity(meta, 1), qs.fragment_identity(meta, 2))

    def test_different_turns_differ(self):
        a = qs.fragment_identity({"stt_turn": 7, "listener_id": 1}, 1)
        b = qs.fragment_identity({"stt_turn": 8, "listener_id": 1}, 2)
        self.assertNotEqual(a, b)

    def test_identityless_finals_are_distinct(self):
        self.assertNotEqual(qs.fragment_identity({}, 1), qs.fragment_identity({}, 2))

    def test_stop_commit_is_its_own_fragment(self):
        a = qs.fragment_identity({"stop_commit": True}, 5)
        self.assertEqual(a, "s5")


class MergeBufferTests(unittest.TestCase):
    def test_append_keeps_order(self):
        buf, action = qs.merge_fragment([], _frag("f1", "one"), now=0.0)
        self.assertEqual(action, "append")
        buf, action = qs.merge_fragment(buf, _frag("f2", "two", at=1.0), now=1.0)
        self.assertEqual(action, "append")
        self.assertEqual([f["text"] for f in buf], ["one", "two"])

    def test_revision_replaces_in_place(self):
        # A re-sent final / revision of the SAME STT turn must not stack a
        # duplicate fragment — it replaces the fragment in its original slot.
        buf, _ = qs.merge_fragment([], _frag("t1:3", "we price it at ten"), now=0.0)
        buf, _ = qs.merge_fragment(buf, _frag("t1:4", "unrelated", at=1.0), now=1.0)
        buf, action = qs.merge_fragment(
            buf, _frag("t1:3", "we price it at ten dollars", at=2.0), now=2.0
        )
        self.assertEqual(action, "revision")
        self.assertEqual([f["id"] for f in buf], ["t1:3", "t1:4"])
        self.assertEqual(buf[0]["text"], "we price it at ten dollars")

    def test_trim_by_count_keeps_newest(self):
        buf = []
        for i in range(10):
            buf, _ = qs.merge_fragment(
                buf, _frag(f"f{i}", f"line {i}", at=float(i)), now=float(i), max_frags=4
            )
        self.assertEqual([f["text"] for f in buf], ["line 6", "line 7", "line 8", "line 9"])

    def test_trim_by_age_never_drops_the_only_fragment(self):
        # A stale residue must not become an answer, but the fragment being
        # judged right now is always kept.
        buf, _ = qs.merge_fragment([], _frag("f1", "old", at=0.0), now=0.0)
        buf = qs.trim_fragments(buf, now=1000.0, max_seconds=10.0)
        self.assertEqual(len(buf), 1)

    def test_trim_by_age_drops_middle_expired(self):
        buf = [_frag("f1", "old", at=0.0), _frag("f2", "recent", at=95.0)]
        buf = qs.trim_fragments(buf, now=100.0, max_seconds=10.0)
        self.assertEqual([f["id"] for f in buf], ["f2"])

    def test_trim_by_chars_drops_oldest_whole_fragments(self):
        buf = [_frag("f1", "a" * 10), _frag("f2", "b" * 10), _frag("f3", "c" * 10)]
        buf = qs.trim_fragments(buf, now=0.0, max_chars=25)
        self.assertEqual([f["id"] for f in buf], ["f2", "f3"])


class CandidateTextTests(unittest.TestCase):
    def test_chinese_fragments_join_without_space(self):
        buf = [_frag("f1", "当下"), _frag("f2", "经济情况")]
        self.assertEqual(qs.candidate_text(buf), "当下经济情况")

    def test_english_fragments_join_with_space(self):
        buf = [_frag("f1", "if we raise the price"), _frag("f2", "will students churn?")]
        self.assertEqual(
            qs.candidate_text(buf), "if we raise the price will students churn?"
        )

    def test_prefix_overlap_is_not_duplicated(self):
        buf = [_frag("f1", "what is"), _frag("f2", "what is CAP theorem?")]
        self.assertEqual(qs.candidate_text(buf), "what is CAP theorem?")

    def test_bounded(self):
        buf = [_frag("f1", "x" * 50)]
        self.assertEqual(len(qs.candidate_text(buf, max_chars=10)), 10)

    def test_referenced_texts_excludes_cited(self):
        buf = [_frag("f1", "we plan a subscription"), _frag("f2", "how should we price it?")]
        self.assertEqual(
            qs.referenced_texts(buf, ["f2"]), ["we plan a subscription"]
        )


class JudgePromptTests(unittest.TestCase):
    def test_prompt_lists_ids_and_is_bounded(self):
        buf = [_frag("f1", "one"), _frag("f2", "two")]
        msgs = qs.build_judge_messages(buf, ["bg line"], [{"q": "q1", "a": "a1"}])
        self.assertEqual(msgs[0]["role"], "system")
        user = msgs[1]["content"]
        self.assertIn("[f1] one", user)
        self.assertIn("[f2] two", user)
        self.assertIn("bg line", user)
        self.assertIn("Q: q1", user)

    def test_prompt_carries_no_more_than_the_bounded_fragments(self):
        buf = [_frag("f1", "a" * 40), _frag("f2", "b" * 40)]
        msgs = qs.build_judge_messages(buf, [], [], max_chars=45)
        self.assertIn("[f1]", msgs[1]["content"])
        self.assertNotIn("[f2]", msgs[1]["content"])

    def test_system_prompt_forbids_guessing_intent(self):
        self.assertIn("Never guess intent", qs.JUDGE_SYSTEM_PROMPT)
        self.assertIn("background", qs.JUDGE_SYSTEM_PROMPT)


class ParseJudgeReplyTests(unittest.TestCase):
    def _raw(self, **kw):
        import json

        base = {"verdict": "ready", "question": "How should we price it?", "fragments": ["f1"], "reason": "complete"}
        base.update(kw)
        return json.dumps(base)

    def test_valid_ready(self):
        out = qs.parse_judge_reply(self._raw(), ["f1", "f2"])
        self.assertEqual(out["verdict"], "ready")
        self.assertEqual(out["fragments"], ["f1"])

    def test_fenced_json_is_accepted(self):
        out = qs.parse_judge_reply(f"```json\n{self._raw()}\n```", ["f1"])
        self.assertIsNotNone(out)

    def test_prose_wrapped_json_is_accepted(self):
        out = qs.parse_judge_reply(f"Here you go: {self._raw()} — done", ["f1"])
        self.assertIsNotNone(out)

    def test_unknown_ids_are_dropped(self):
        out = qs.parse_judge_reply(self._raw(fragments=["f1", "zz"]), ["f1"])
        self.assertEqual(out["fragments"], ["f1"])

    def test_ready_without_any_valid_citation_is_invalid(self):
        # The model must ground the integrated question in the buffer's fragments.
        self.assertIsNone(qs.parse_judge_reply(self._raw(fragments=["zz"]), ["f1"]))
        self.assertIsNone(qs.parse_judge_reply(self._raw(fragments=[]), ["f1"]))
        self.assertIsNone(qs.parse_judge_reply(self._raw(fragments="f1"), ["f1"]))

    def test_ready_without_question_is_invalid(self):
        self.assertIsNone(qs.parse_judge_reply(self._raw(question=""), ["f1"]))

    def test_ready_question_is_length_bounded(self):
        self.assertIsNone(qs.parse_judge_reply(self._raw(question="x" * 5000), ["f1"], max_question_chars=600))

    def test_wait_and_background_need_no_question(self):
        for v in ("wait", "background"):
            out = qs.parse_judge_reply(self._raw(verdict=v, question=""), ["f1"])
            self.assertEqual(out["verdict"], v)

    def test_bad_verdict_is_invalid(self):
        self.assertIsNone(qs.parse_judge_reply(self._raw(verdict="maybe"), ["f1"]))

    def test_broken_json_is_invalid(self):
        self.assertIsNone(qs.parse_judge_reply("{verdict: ready", ["f1"]))
        self.assertIsNone(qs.parse_judge_reply("", ["f1"]))
        self.assertIsNone(qs.parse_judge_reply(None, ["f1"]))
        self.assertIsNone(qs.parse_judge_reply("[1,2,3]", ["f1"]))

    def test_reason_is_bounded(self):
        out = qs.parse_judge_reply(self._raw(reason="y" * 500), ["f1"])
        self.assertLessEqual(len(out["reason"]), 121)


class ContextBlockTests(unittest.TestCase):
    def test_empty_when_no_lines(self):
        self.assertEqual(qs.context_block([]), "")
        self.assertEqual(qs.context_block(["  "]), "")

    def test_bounded(self):
        block = qs.context_block(["a" * 30, "b" * 30, "c" * 30], max_chars=60)
        self.assertIn(("a" * 30), block)
        self.assertIn(("b" * 30), block)
        self.assertNotIn(("c" * 30), block)

    def test_labels_background_as_not_a_question(self):
        block = qs.context_block(["we plan a subscription"])
        self.assertIn("not a question", block)
        self.assertIn("we plan a subscription", block)


class BackgroundAfterTests(unittest.TestCase):
    def test_keeps_newest_bounded(self):
        out = qs.background_after(["a", "b"], ["c", "d"], max_frags=3)
        self.assertEqual(out, ["b", "c", "d"])

    def test_drops_blanks(self):
        self.assertEqual(qs.background_after([], [" ", "x"]), ["x"])


class JoinPairTests(unittest.TestCase):
    def test_cjk_no_space(self):
        self.assertEqual(qs.join_pair("当下", "经济"), "当下经济")

    def test_latin_space(self):
        self.assertEqual(qs.join_pair("hello", "world"), "hello world")

    def test_prefix_overlap(self):
        self.assertEqual(qs.join_pair("what is", "what is this?"), "what is this?")

    def test_different_script_is_not_glued(self):
        self.assertEqual(qs.join_pair("hello", "你好"), "hello")

    def test_comma_before_latin_gets_a_space(self):
        self.assertEqual(qs.join_pair("for postgresql,", "how do I back up"), "for postgresql, how do I back up")


if __name__ == "__main__":
    unittest.main()
