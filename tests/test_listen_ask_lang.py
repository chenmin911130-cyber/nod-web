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


def _auto_body(question: str, transcript: str) -> str:
    return (
        "OUTPUT LANGUAGE (hard rule): Write in the language of the listener question "
        "if it is clear; otherwise follow the transcript. Do not force one language.\n"
        f"Listener question: {question}\n"
        "Transcript (use when relevant; if empty, say you have not heard enough yet "
        "and still answer what you can):\n"
        f"{transcript}"
    )


def _system(tag_and_body: str) -> str:
    pipe = Pipeline.__new__(Pipeline)
    pipe.cfg = {"llm": {}}
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


def test_auto_undetectable_adds_no_output_language():
    sys_msg = _system("[NOD_ASK:auto]\n" + _auto_body("Why?", "(empty)"))
    assert "OUTPUT LANGUAGE" not in sys_msg


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
    assert listen_ask_lang("Listener question: Why?\nTranscript (tail):\n(empty)") is None
