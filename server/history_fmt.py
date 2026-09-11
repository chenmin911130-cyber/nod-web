from __future__ import annotations

import re
from datetime import datetime


def normalize_scene(mode: str | None, scene: str | None) -> str:
    mode = (mode or "").strip().lower()
    scene = (scene or "").strip().lower()
    if mode == "interview" or scene == "interview":
        return "interview"
    if mode == "translate" or scene == "translate":
        return "translate"
    if scene == "lecture":
        return "lecture"
    return "meeting"


def scene_label(scene: str) -> str:
    return {
        "interview": "Live Q&A",
        "lecture": "Lecture",
        "translate": "Translate",
        "meeting": "Meeting",
    }.get(scene, "Meeting")


def session_stamp(started_at: datetime | str | None) -> str:
    if isinstance(started_at, datetime):
        return started_at.strftime("%Y-%m-%d")
    raw = (started_at or "")[:10]
    return raw if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw) else "session"


def part_index(part_name: str | None) -> str:
    if not part_name:
        return ""
    found = re.search(r"(\d+)", part_name)
    return found.group(1).lstrip("0") or "1" if found else ""


def session_download_name(
    mode: str | None,
    scene: str | None,
    started_at: datetime | str | None,
    *,
    kind: str = "audio",
    part_name: str | None = None,
) -> str:
    label = re.sub(
        r"[^A-Za-z0-9]+",
        "-",
        scene_label(normalize_scene(mode, scene)).replace("&", ""),
    ).strip("-")
    stamp = session_stamp(started_at)
    if kind in ("notes", "pdf"):
        return f"Nodpilot-{label}-{stamp}.pdf"
    idx = part_index(part_name)
    if idx:
        return f"Nodpilot-{label}-{stamp}-part{idx}.wav"
    return f"Nodpilot-{label}-{stamp}.wav"


def sources_lines(sources: dict | None) -> list[str]:
    """#182: the sources block for copy / export.

    Mirrors the client's plain-text block so a saved answer keeps the出处 it was
    based on. Records written before Think existed carry no sources and produce
    nothing, and only safe http(s) links are ever written out.
    """
    if not isinstance(sources, dict):
        return []
    results = sources.get("results")
    lines: list[str] = []
    if isinstance(results, list):
        for i, item in enumerate(results, 1):
            if not isinstance(item, dict):
                continue
            url = str(item.get("url") or "").strip()
            if not url.lower().startswith(("http://", "https://")):
                continue
            title = str(item.get("title") or "").strip() or url
            published = str(item.get("published_at") or "").strip()
            lines.append(f"[{i}] {title}" + (f"（发布时间 {published}）" if published else ""))
            lines.append(f"    {url}")
    stamp = str(sources.get("retrieved_at_text") or "").strip()
    if stamp:
        lines.append(f"检索时间：{stamp}")
    note = str(sources.get("note") or "").strip()
    if note:
        lines.append(note)
    return lines


def session_copy_text(title: str, mode: str | None, scene: str | None, items: list[dict]) -> str:
    label = scene_label(normalize_scene(mode, scene))
    lines = [title.strip() or f"{label} session", f"{label}", ""]
    for item in items:
        kind = (item.get("kind") or "note").strip()
        text = (item.get("text") or "").strip()
        if not text:
            continue
        lines.append(kind.upper())
        lines.append(text)
        lines.extend(sources_lines(item.get("sources")))
        lines.append("")
    return "\n".join(lines).strip() + "\n"
