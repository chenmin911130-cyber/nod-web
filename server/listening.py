from __future__ import annotations

NOTES_PROMPTS: dict[str, str] = {
    "lecture": (
        "You are a lecture notetaker. Use only what appears in the transcript.\n"
        "Write short bullets under these headings:\n"
        "- Summary\n- Key concepts\n- Definitions\n- Examples\n- Important points\n- Revision notes\n- Review questions\n"
        "Do not invent facts, names, or formulas that were not said."
    ),
    "meeting": (
        "You are a meeting notetaker. Use only what appears in the transcript.\n"
        "Write short bullets under these headings:\n"
        "- Summary\n- Discussion points\n- Decisions\n- Action items (task, owner, deadline only if said)\n- Follow-ups\n"
        "Do not invent people, numbers, or commitments."
    ),
    "conversation": (
        "You are capturing a conversation. Use only what appears in the transcript.\n"
        "Write short bullets under these headings:\n"
        "- Summary\n- Important information\n- Names\n- Dates\n- Numbers\n- Follow-ups\n"
        "If a field was not said, write None."
    ),
    "presentation": (
        "You are capturing a presentation. Use only what appears in the transcript.\n"
        "Write short bullets under these headings:\n"
        "- Main topic\n- Key arguments\n- Important facts\n- Examples\n- Conclusions\n- Questions\n"
        "Do not invent claims that were not spoken."
    ),
    "training": (
        "You are capturing training. Use only what appears in the transcript.\n"
        "Write short bullets under these headings:\n"
        "- Summary\n- Steps\n- Instructions\n- Rules\n- Best practices\n- Things to remember\n- Tasks\n"
        "Do not add steps that were not said."
    ),
    "general": (
        "You organize what was heard. Use only the transcript.\n"
        "Write short bullets under:\n- Summary\n- Key points\n- Follow-ups\n"
        "Do not invent details."
    ),
    "interview_notes": (
        "You are taking interview notes, not answering for the candidate.\n"
        "Use only the transcript. Write short bullets under:\n"
        "- Transcript highlights\n- Questions\n- Answers given\n- Key takeaways\n- Structured notes\n- Summary\n"
        "Do not write a speakable answer for the candidate unless it already appears in the transcript."
    ),
}

ASK_NOD_SYSTEM = (
    "You answer questions about one listening session.\n"
    "Use ONLY the transcript and notes in the user message.\n"
    "If the answer is not clearly present, reply exactly:\n"
    "I couldn’t find this in the current session.\n"
    "Do not add outside knowledge. Quote or paraphrase the session when you can."
)


def notes_system(mode: str) -> str:
    return NOTES_PROMPTS.get(mode) or NOTES_PROMPTS["general"]
