"""Lock-screen Translate passthrough matches the JS caption gate."""

from __future__ import annotations

import unittest

from server.lang import looks_like_target, translate_should_passthrough


class TranslatePassthroughTests(unittest.TestCase):
    def test_chinese_to_zh_skips_llm(self):
        self.assertTrue(translate_should_passthrough("你好。", "zh", "zh"))

    def test_english_to_zh_needs_llm(self):
        self.assertFalse(translate_should_passthrough("Hello there", "zh", "en"))

    def test_latin_needs_matching_stt_tag(self):
        self.assertTrue(translate_should_passthrough("Hello there", "en", "en"))
        self.assertFalse(translate_should_passthrough("Hello there", "en", None))
        self.assertFalse(translate_should_passthrough("Quiero comer algo antes de la reunion", "en", "es"))

    def test_looks_like_chinese(self):
        self.assertTrue(looks_like_target("你好，你好吗？", "zh"))
        self.assertFalse(looks_like_target("Hello there", "zh"))
