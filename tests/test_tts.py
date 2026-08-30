import unittest

from server.tts import VOICES, voice_id


class TtsVoiceTests(unittest.TestCase):
    def test_male_and_female_use_different_preset_voices(self):
        self.assertEqual(voice_id("female"), VOICES["female"])
        self.assertEqual(voice_id("male"), VOICES["male"])
        self.assertNotEqual(voice_id("female"), voice_id("male"))

    def test_unknown_voice_defaults_to_female(self):
        self.assertEqual(voice_id("unknown"), VOICES["female"])


if __name__ == "__main__":
    unittest.main()
