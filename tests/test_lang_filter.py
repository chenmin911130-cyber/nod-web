"""Locked-language speech filter.

Regression for the Italian bug: STT locked to a Latin language must not
drop ordinary sentences just because word-marker guessing said "en".
"""

from server.lang import heard_lang_from_text, matches_locked_speech, split_code_switched


def test_latin_lock_accepts_plain_sentences():
    assert matches_locked_speech("Buongiorno, come stai oggi?", "it", "it")
    assert matches_locked_speech("Vorrei un caffe per favore", "it", None)
    assert matches_locked_speech("Hola buenos dias amigos", "es", "es")
    assert matches_locked_speech("Ich gehe heute zur Arbeit", "de", None)
    assert matches_locked_speech("Bonjour tout le monde", "fr", "fr")
    assert matches_locked_speech("Eu gosto muito de musica", "pt", None)


def test_latin_lock_rejects_cjk_but_not_a_mis_tagged_latin():
    assert not matches_locked_speech("你好世界这是中文", "it", None)
    assert not matches_locked_speech("こんにちは、ありがとう。", "it", "ja")
    # A Latin lock is already constrained to that Latin language, so a guessed
    # / STT Latin tag (en, or a nearby-language mis-tag like it vs es) must NOT
    # veto it; only a genuinely different script (CJK) or non-Latin tag does.
    assert matches_locked_speech("Buongiorno a tutti", "it", "en")
    assert matches_locked_speech("Il treno parte alle otto.", "it", "en")
    assert matches_locked_speech("Buongiorno a tutti", "it", "es")
    assert matches_locked_speech("Hola buenos dias amigos", "es", "it")


def test_cjk_locks_unchanged():
    assert matches_locked_speech("今天天气很好", "zh", None)
    assert not matches_locked_speech("こんにちは", "zh", None)
    assert matches_locked_speech("おはようございます", "ja", None)


def test_heard_lang_prefers_cjk_script():
    """CJK glyphs are reliable, so the script wins over the STT tag."""
    assert heard_lang_from_text("今天天气很好", "en") == "zh"
    assert heard_lang_from_text("こんにちは", "zh") == "ja"


def test_heard_lang_trusts_assemblyai_for_latin():
    """Latin scripts have no glyph signal; AssemblyAI's tag decides the language."""
    assert heard_lang_from_text("Quiero comer algo", "es") == "es"
    assert heard_lang_from_text("Dobbiamo finire il lavoro entro domani", "it") == "it"
    assert heard_lang_from_text("Nous devons finir le projet avant vendredi", "fr") == "fr"
    assert heard_lang_from_text("Wir sollten das Meeting auf morgen verschieben", "de") == "de"
    assert heard_lang_from_text("Precisamos terminar o relatorio hoje", "pt") == "pt"


def test_heard_lang_no_tag_falls_back_to_en():
    """No STT tag; a plain English sentence's script still reads en."""
    assert heard_lang_from_text("That's a last-minute notification", None) == "en"
    assert heard_lang_from_text("That's a last-minute notification", "en") == "en"


def test_split_code_switched_keeps_space_after_latin_stop():
    """A Latin sentence-stop must keep a space before the next sentence.

    Regression: the joiner suppressed the space for any sentence-stop,
    including Latin ``. ! ?``. CJK stops (。！？) correctly need no space.
    """
    assert split_code_switched("GPT-6 Astra is here. It's our latest\u2026") == [
        "GPT-6 Astra is here. It's our latest\u2026"
    ]
    assert split_code_switched("Lower 8? Checking now.") == ["Lower 8? Checking now."]
    assert split_code_switched("Non so che dire. Ci sono molte opzioni.") == [
        "Non so che dire. Ci sono molte opzioni."
    ]


def test_split_code_switched_cjk_keeps_no_space():
    """CJK sentence-stops still join with no space (correct CJK convention)."""
    assert split_code_switched("你好。世界。") == ["你好。世界。"]
    assert split_code_switched("你好！再见？") == ["你好！再见？"]


def test_split_code_switched_switches_script_on_script_change():
    """A script change still splits into separate lines (never rewrite)."""
    out = split_code_switched("Hello world. \u4f60\u597d\u3002")
    assert out == ["Hello world.", "你好。"]
