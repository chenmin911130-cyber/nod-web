"""Start the real server.app with DeepSeek and AssemblyAI pointed at fake_providers.py.

Verification scaffolding only: patches module attributes in-process, never edits
application files. Run from the repo root.

  python launch_server.py --port 9420 --fake-port 9421
"""

from __future__ import annotations

import argparse
import os
import sys
from urllib.parse import urlparse

REAL_LLM_HOSTS = {"api.deepseek.com", "openrouter.ai"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9420)
    ap.add_argument("--fake-port", type=int, default=9421)
    args = ap.parse_args()

    fake = f"http://127.0.0.1:{args.fake_port}"
    paid = ("CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY", "RESEND_API_KEY", "SMTP_HOST",
            "CF_API_TOKEN", "ELEVENLABS_API_KEY", "R2_ACCESS_KEY_ID", "SENTRY_DSN")
    keep = os.environ.get("NOD_VERIFY_KEEP_SECRETS") == "1"
    for name in ("PUBLIC_URL", "ALLOWED_HOSTS", "OPENROUTER_API_KEY", *(() if keep else paid)):
        os.environ.pop(name, None)
    os.environ["NOD_SKIP_DOTENV"] = "1"
    os.environ["DEEPSEEK_API_KEY"] = "fake-deepseek"
    os.environ["ASSEMBLYAI_API_KEY"] = "fake-assemblyai"

    import openai

    real = openai.OpenAI

    class FakeRoutedOpenAI(real):  # type: ignore[misc, valid-type]
        def __init__(self, *a, base_url=None, **kw):
            host = urlparse(str(base_url or "")).hostname or ""
            if not base_url or host in REAL_LLM_HOSTS:
                base_url = fake
            super().__init__(*a, base_url=base_url, **kw)

    openai.OpenAI = FakeRoutedOpenAI

    sys.path.insert(0, os.getcwd())
    import server.app as nod

    nod.ASSEMBLYAI_WS = f"ws://127.0.0.1:{args.fake_port}/v3/ws"
    print(f"verify-nodpilot: llm->{fake} stt->{nod.ASSEMBLYAI_WS}", flush=True)

    import uvicorn

    uvicorn.run(nod.app, host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
