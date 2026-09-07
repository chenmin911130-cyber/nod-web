"""Auto-notes listen_ask must pin a concrete answer language in the system prompt."""

from server.app import Pipeline
from server.lang import listen_ask_lang

EN_TRANSCRIPT = (
    "We should ship the beta on Friday.\n"
    "Alice will own the release notes.\n"
    "Bob is checking the billing numbers."
)
ZH_TRANSCRIPT = "我们周五发测试版。小王负责发布说明。小李核对账单。"
CHIP = "List the action items so far, with who owns each."
ZH_ASK = "这段会议的行动项有哪些？"
IT_TRANSCRIPT = "Non è pronto. Lanciamo la beta venerdì."
ES_TRANSCRIPT = "Vamos a lanzar la beta el viernes. Alice escribe las notas."


def _auto_body(question: str, transcript: str) -> str:
    return (
        "OUTPUT LANGUAGE (hard rule): Write in the language of the listener question "
        "if it is clear; otherwise follow the transcript. Do not force one language.\n"
        f"Listener question: {question}\n"
        "Transcript (use when relevant; if empty, say you have not heard enough yet "
        "and still answer what you can):\n"
        f"{transcript}"
    )


def _system(tag_and_body: str, stt_language: str | None = None) -> str:
    pipe = Pipeline.__new__(Pipeline)
    pipe.cfg = {"llm": {}, "stt": {"language": stt_language}}
    return pipe._build_messages(tag_and_body, "listen_ask")[0]["content"]


def test_auto_english_chip_follows_question_not_chinese():
    sys_msg = _system("[NOD_ASK:auto]\n" + _auto_body(CHIP, EN_TRANSCRIPT))
    assert "English only" in sys_msg
    assert "Chinese" not in sys_msg


def test_auto_chinese_typed_question_answers_chinese():
    sys_msg = _system("[NOD_ASK:auto]\n" + _auto_body(ZH_ASK, EN_TRANSCRIPT))
    assert "Chinese only" in sys_msg


def test_auto_short_question_follows_transcript():
    sys_msg = _system("[NOD_ASK:auto]\n" + _auto_body("Why?", ZH_TRANSCRIPT))
    assert "Chinese only" in sys_msg


def test_auto_english_question_empty_transcript():
    sys_msg = _system("[NOD_ASK:auto]\n" + _auto_body(CHIP, "(empty)"))
    assert "English only" in sys_msg


def test_auto_short_question_empty_transcript_pins_english():
    sys_msg = _system("[NOD_ASK:auto]\n" + _auto_body("Why?", "(empty)"))
    assert "English only" in sys_msg


def test_locked_italian_english_chip_pins_italian_not_french():
    sys_msg = _system(
        "[NOD_ASK:auto]\n" + _auto_body(CHIP, IT_TRANSCRIPT),
        stt_language="it",
    )
    assert "Italian only" in sys_msg
    assert "French" not in sys_msg
    assert "English only" not in sys_msg


def test_locked_spanish_why_pins_spanish():
    sys_msg = _system(
        "[NOD_ASK:auto]\n" + _auto_body("Why?", ES_TRANSCRIPT),
        stt_language="es",
    )
    assert "Spanish only" in sys_msg
    assert "English only" not in sys_msg


def test_locked_italian_empty_transcript_pins_italian():
    sys_msg = _system(
        "[NOD_ASK:auto]\n" + _auto_body(CHIP, "(empty)"),
        stt_language="it",
    )
    assert "Italian only" in sys_msg
    assert "English only" not in sys_msg


def test_locked_italian_chinese_question_still_chinese():
    sys_msg = _system(
        "[NOD_ASK:auto]\n" + _auto_body(ZH_ASK, IT_TRANSCRIPT),
        stt_language="it",
    )
    assert "Chinese only" in sys_msg
    assert "Italian" not in sys_msg


def test_explicit_zh_keeps_old_output_rule():
    sys_msg = _system(
        "[NOD_ASK:zh]\n"
        "OUTPUT LANGUAGE (hard rule): Write the entire answer in Chinese only. "
        "Do not follow the transcript language.\n"
        f"Listener question: {ZH_ASK}\n"
        "Transcript (use when relevant; if empty, say you have not heard enough yet "
        "and still answer what you can):\n"
        f"{EN_TRANSCRIPT}"
    )
    assert "Chinese only" in sys_msg
    assert "Do not follow the transcript language" in sys_msg
    assert "Do not switch language except for proper nouns and technical terms." not in sys_msg


def test_listen_ask_lang_parse_edges():
    assert listen_ask_lang(f"Listener question: {CHIP}") == "en"
    assert listen_ask_lang(
        f"Listener question: Why?\nTranscript (tail):\n{ZH_TRANSCRIPT}\nMore lines here 还有一句。"
    ) == "zh"
    assert listen_ask_lang(f"Listener question: {CHIP}\nTranscript (tail):\n(empty)") == "en"
    assert listen_ask_lang("Listener question: Why?\nTranscript (tail):\n(empty)") == "en"
    assert listen_ask_lang(
        "Listener question: Why?\nTranscript (tail):\n(empty)",
        locked="it",
    ) == "it"
    assert listen_ask_lang(
        f"Listener question: {CHIP}\nTranscript (tail):\n(empty)",
        locked="it",
    ) == "it"
    assert listen_ask_lang(
        f"Listener question: {ZH_ASK}\nTranscript (tail):\n(empty)",
        locked="it",
    ) == "zh"
    assert listen_ask_lang(
        f"Listener question: {CHIP}\nTranscript (tail):\n{IT_TRANSCRIPT}",
        locked="it",
    ) == "it"
    assert listen_ask_lang(
        f"Listener question: Why?\nTranscript (tail):\n{ES_TRANSCRIPT}",
        locked="es",
    ) == "es"
    assert listen_ask_lang(
        f"Listener question: {ZH_ASK}\nTranscript (tail):\n{IT_TRANSCRIPT}",
        locked="it",
    ) == "zh"


def _pipe() -> Pipeline:
    pipe = Pipeline.__new__(Pipeline)
    pipe.cfg = {"llm": {}, "stt": {"language": None}}
    return pipe


def test_bi_ja_tag_keeps_auto_out_lang_and_names_japanese():
    pipe = _pipe()
    q = "[NOD_ASK:auto:bi-ja]\n" + _auto_body(CHIP, EN_TRANSCRIPT)
    assert pipe._out_lang_from_tag(q) is None
    assert pipe._bilingual_from_tag(q) == "ja"
    sys_msg = pipe._build_messages(q, "listen_ask")[0]["content"]
    assert "Japanese translation" in sys_msg
    assert "Chinese if unclear" not in sys_msg


def test_zh_out_lang_with_bi_ja_target():
    pipe = _pipe()
    q = (
        "[NOD_ASK:zh:bi-ja]\n"
        "OUTPUT LANGUAGE (hard rule): Write the entire answer in Chinese only.\n"
        f"Listener question: {ZH_ASK}\n"
        "Transcript (use when relevant; if empty, say you have not heard enough yet "
        "and still answer what you can):\n"
        f"{EN_TRANSCRIPT}"
    )
    assert pipe._out_lang_from_tag(q) == "zh"
    assert pipe._bilingual_from_tag(q) == "ja"
    sys_msg = pipe._build_messages(q, "listen_ask")[0]["content"]
    assert "Japanese translation" in sys_msg


def test_bare_bi_old_client_keeps_chinese_if_unclear():
    pipe = _pipe()
    q = "[NOD_ASK:auto:bi]\n" + _auto_body(CHIP, EN_TRANSCRIPT)
    assert pipe._out_lang_from_tag(q) is None
    assert pipe._bilingual_from_tag(q) == "auto"
    sys_msg = pipe._build_messages(q, "listen_ask")[0]["content"]
    assert "Chinese if unclear" in sys_msg
    assert "Japanese translation" not in sys_msg
