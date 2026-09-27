"""Local stand-ins for DeepSeek (OpenAI-compatible HTTP) and AssemblyAI v3 streaming.

Verification scaffolding only. Every request is appended to $NOD_FAKE_LOG as JSONL
so a run can prove what the app actually sent upstream.

Control endpoints (for the driver, never reached by the app):
  POST /_control/script   {"lines": [{"text": "...", "lang": "en"}, ...]}  STT script
  GET  /_control/log      the JSONL log as a JSON array
  GET  /_control/health
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse

LOG = Path(os.environ.get("NOD_FAKE_LOG", "/tmp/nod-verify/fake.jsonl"))
BYTES_PER_LINE = int(os.environ.get("NOD_FAKE_BYTES_PER_LINE", str(32000 * 2)))

DEFAULT_SCRIPT = [
    {"text": "Let's review the quarterly budget before Friday.", "lang": "en"},
    {"text": "Marketing needs two more designers next month.", "lang": "en"},
    {"text": "Can we ship the beta by the end of October?", "lang": "en"},
]

TRANSLATIONS = {
    "Let's review the quarterly budget before Friday.": "我们在周五之前审查一下季度预算。",
    "Marketing needs two more designers next month.": "市场部下个月还需要两名设计师。",
    "Can we ship the beta by the end of October?": "我们能在十月底之前发布测试版吗？",
    "Dobbiamo finire il lavoro entro domani": "我们必须在明天之前完成工作",
}

state: dict = {"script": list(DEFAULT_SCRIPT)}
app = FastAPI()


def log(kind: str, **fields) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"t": round(time.time(), 3), "kind": kind, **fields}, ensure_ascii=False) + "\n")


def reply_for(messages: list[dict]) -> str:
    user = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            c = m.get("content")
            user = c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)
            break
    tr = re.match(r"\s*(?:\[NOD_TRANSLATE:[^\]]+\]\s*)?Translate to ([^.]+)\.\s*(.*)", user, re.S)
    if tr:
        target, src = tr.group(1).strip(), tr.group(2).strip()
        src = src.rsplit("Translate only this line:", 1)[-1].strip()
        if target.lower().startswith(("chinese", "中文", "simplified")):
            return TRANSLATIONS.get(src, "这是一条模拟译文。")
        return f"Mock {target} translation of: {src}"
    if user.startswith("Fragments in order:"):
        frags = re.findall(r"^\[([^\]]+)\]\s*(.+)$", user, re.M)
        return json.dumps({"verdict": "ready", "question": " ".join(t for _, t in frags),
                           "fragments": [i for i, _ in frags], "reason": "complete question"})
    if user.startswith("Previous lines:"):
        return user.rsplit("Caption:\n", 1)[-1].strip()
    if "[NOD_NOTES" in user or "Write structured notes" in user:
        return "## Summary\n- Budget review before Friday.\n- Two more designers next month.\n\n## Action items\n- Ship beta by end of October."
    return "Mock answer from the fake DeepSeek provider."


@app.get("/_control/health")
def health():
    return {"ok": True, "fake": True, "script_lines": len(state["script"])}


@app.post("/_control/script")
async def set_script(request: Request):
    body = await request.json()
    state["script"] = list(body.get("lines") or DEFAULT_SCRIPT)
    log("control_script", lines=[x.get("text") for x in state["script"]])
    return {"ok": True, "lines": len(state["script"])}


@app.get("/_control/log")
def get_log():
    if not LOG.exists():
        return []
    return [json.loads(x) for x in LOG.read_text(encoding="utf-8").splitlines() if x.strip()]


@app.post("/chat/completions")
@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    messages = body.get("messages") or []
    text = reply_for(messages)
    last_user = next((m.get("content") for m in reversed(messages) if m.get("role") == "user"), "")
    log("llm", model=body.get("model"), stream=bool(body.get("stream")),
        user=str(last_user)[:400], reply=text)
    cid = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    created = int(time.time())
    if not body.get("stream"):
        return JSONResponse({
            "id": cid, "object": "chat.completion", "created": created, "model": body.get("model"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
        })

    async def gen():
        pieces = re.findall(r".{1,12}", text, re.S) or [""]
        for p in pieces:
            chunk = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": body.get("model"),
                     "choices": [{"index": 0, "delta": {"content": p}, "finish_reason": None}]}
            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
            await asyncio.sleep(0.02)
        end = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": body.get("model"),
               "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
        yield f"data: {json.dumps(end)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.websocket("/v3/ws")
async def stt(ws: WebSocket):
    await ws.accept()
    sid = uuid.uuid4().hex[:10]
    params = dict(ws.query_params)
    log("stt_open", session=sid, language_codes=params.get("language_codes"),
        language_detection=params.get("language_detection"), sample_rate=params.get("sample_rate"),
        has_auth=bool(ws.headers.get("authorization")))
    await ws.send_text(json.dumps({"type": "Begin", "id": sid, "expires_at": int(time.time()) + 3600}))
    script = list(state["script"])
    received = 0
    emitted = 0
    started = time.time()
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes"):
                received += len(msg["bytes"])
                while emitted < len(script) and received >= BYTES_PER_LINE * (emitted + 1):
                    line = script[emitted]
                    words = line["text"].split()
                    half = " ".join(words[: max(1, len(words) // 2)])
                    base = {"turn_order": emitted, "language_code": line.get("lang", "en"),
                            "language_confidence": 0.99, "end_of_turn_confidence": 0.9, "words": []}
                    await ws.send_text(json.dumps({"type": "Turn", **base, "transcript": half,
                                                   "end_of_turn": False, "turn_is_formatted": False}))
                    await ws.send_text(json.dumps({"type": "Turn", **base, "transcript": line["text"],
                                                   "utterance": line["text"], "end_of_turn": True,
                                                   "turn_is_formatted": True}))
                    log("stt_turn", session=sid, turn_order=emitted, text=line["text"], audio_bytes=received)
                    emitted += 1
            elif msg.get("text"):
                data = json.loads(msg["text"])
                log("stt_control", session=sid, message=data)
                if data.get("type") == "Terminate":
                    await ws.send_text(json.dumps({
                        "type": "Termination",
                        "audio_duration_seconds": round(received / 32000, 2),
                        "session_duration_seconds": round(time.time() - started, 2),
                    }))
                    await ws.close()
                    break
    except WebSocketDisconnect:
        pass
    log("stt_close", session=sid, audio_bytes=received, turns=emitted)
