"""Locked-language speech filter.

Regression for the Italian bug: STT locked to a Latin language must not
drop ordinary sentences just because word-marker guessing said "en".
"""

from server.app import matches_locked_speech


def test_latin_lock_accepts_plain_sentences():
    assert matches_locked_speech("Buongiorno, come stai oggi?", "it", "it")
    assert matches_locked_speech("Vorrei un caffe per favore", "it", None)
    assert matches_locked_speech("Hola buenos dias amigos", "es", "es")
    assert matches_locked_speech("Ich gehe heute zur Arbeit", "de", None)
    assert matches_locked_speech("Bonjour tout le monde", "fr", "fr")
    assert matches_locked_speech("Eu gosto muito de musica", "pt", None)


def test_latin_lock_still_rejects_cjk_and_other_tags():
    assert not matches_locked_speech("你好世界这是中文", "it", None)
    assert not matches_locked_speech("こんにちは、ありがとう。", "it", "ja")
    # STT confidently tagged a different language.
    assert not matches_locked_speech("Buongiorno a tutti", "it", "en")


def test_cjk_locks_unchanged():
    assert matches_locked_speech("今天天气很好", "zh", None)
    assert not matches_locked_speech("こんにちは", "zh", None)
    assert matches_locked_speech("おはようございます", "ja", None)
