---
name: verify-nodpilot
description: Drive a local, hermetic Nodpilot (nod-web) instance the way a user does and capture proof. Web workspace (Listen Meeting / Lecture / Live Q&A, Translate, History, Account), sign-in APIs, admin, and read-only production health. Real server and real browser mic path, with DeepSeek and AssemblyAI replaced by local fakes. Use after changing server/ or web/, before claiming a user-facing fix works, or when asked to verify nodpilot features.
---

# verify-nodpilot

One entry point: `.cursor/skills/verify-nodpilot/scripts/control-nod`. Run it from anywhere; it finds the repo root itself. The feature map in [`features/README.md`](features/README.md) is the list of what to prove.

## What is real and what is faked

- Real: `server.app` (FastAPI + SQLite in a throwaway `DATA_DIR`), the built `web/dist`, Chromium with a fake microphone (`--use-fake-device-for-media-stream`), the `/ws` protocol, PCM upload, History, PDF export, auth APIs.
- Faked: DeepSeek and AssemblyAI. `scripts/fake_providers.py` serves an OpenAI-compatible `/chat/completions` and an AssemblyAI v3 `/v3/ws` on `127.0.0.1:9421`. `scripts/launch_server.py` repoints `server.app.ASSEMBLYAI_WS` and wraps `openai.OpenAI` in-process before uvicorn starts. No application file is edited.
- The fake STT ignores audio content. It emits one scripted line per 2 s of PCM received (a partial, then a formatted final). Set the script with `POST http://127.0.0.1:9421/_control/script`. Every upstream request lands in `<run>/fake-providers.jsonl` and `GET /_control/log`.
- The launcher strips Clerk, Stripe, ElevenLabs, Resend, R2, and Sentry keys so a run never touches paid services. `NOD_VERIFY_KEEP_SECRETS=1` before `up` keeps them for a deliberate integration run.
- Not reachable locally: Clerk Google sign-in, Stripe, ElevenLabs TTS, email delivery, R2, iOS / Watch / Android. The map marks each as NOT VERIFIABLE and names what it needs.

## Setup (once per machine)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # Ubuntu may need: sudo apt-get install python3.12-venv
cd web && npm ci && npx playwright install --with-deps chromium && cd ..
```

## Launch

```bash
C=.cursor/skills/verify-nodpilot/scripts/control-nod
$C up            # builds web/dist if HEAD changed, starts fakes :9421 and server :9420, waits for /api/health
$C up --rebuild  # force a web rebuild
```

Ready when it prints `ready: http://127.0.0.1:9420  run=/tmp/nod-verify/runs/<id>`. In an agent shell tool that reaps a command's children when the call returns, run `up`, `drive`, and `down` in one call (`$C up && $C drive <ids>; $C down`); otherwise the next call gets `ECONNREFUSED`. Ports come from `NOD_VERIFY_PORT` / `NOD_VERIFY_FAKE_PORT`; state lives in `NOD_VERIFY_HOME` (default `/tmp/nod-verify`). One instance per `NOD_VERIFY_HOME`; `up` refuses to start over a live instance or a port it did not open.

## Doctor

```bash
$C doctor
```

Checks both PIDs are alive, port 9420 belongs to our server PID, `/api/health` is `ok:true`, the server log shows providers routed to the fakes, and the built SHA equals `HEAD`. Run it first whenever anything looks off. `WARN built X, HEAD is Y` means `down` then `up --rebuild`.

## Drive

```bash
$C drive list                     # scenario ids and titles
$C drive all                      # every local scenario (prod-readonly excluded)
$C drive meeting-live history     # specific scenarios
$C drive prod-readonly            # two GETs against nodpilot.com, nothing else
$C drive aria /app phone          # print the live ARIA tree (desktop|phone), optional 3rd arg clicks a button or tab:<name>
$C api /api/health                # curl the local instance
$C suites                         # repo pytest + web unit tests into <run>/suites/
```

Scenarios live in `scripts/drive.mjs` (`def('<id>', '<title>', async (c) => ...)`). Add one per new user-facing behavior and list it in the feature map.

- Isolation. Browser scenarios register a fresh account and browse `http://nod.localhost:9420`. Chromium treats `*.localhost` as loopback and a secure context (mic works, no https upgrade), while the app treats it as non-local, so it is a real signed-in user. `http://127.0.0.1:9420` always boots as one shared local guest (`POST /api/auth/local-guest`), so state leaks between runs there; use it only for guest-specific checks.
- Handles. Use ARIA names from `drive aria`, not CSS. Stable ones: tab `Listen` / `Translate`; buttons `Start`, `Stop`, `Pause`, `Summarize`, `Ask`, `Save`, `History`, `New session`, `Export PDF`, `Meeting` (scene picker, options `Meeting` / `Lecture` / `Live Q&A`), `Attach Office, PDF, or image`, `Settings`, `Account` (phone); textboxes `Ask anything…` and `Type to translate...`; dialogs `Save to History?` and `History`.
- API probes. `api()` in `drive.mjs` uses `node:http` because `fetch` drops a custom `Host` header. Loopback requests to `/api/me` fall back to the local guest, so pass `headers: REMOTE` when you need the signed-out answer.

## Evidence

Everything for a run goes to `/tmp/nod-verify/runs/<id>/`:

- `server.log` and `fake-providers.jsonl` for the whole run.
- `results.jsonl`, one line per scenario with status, steps, and notes.
- `scenarios/<id>/` holds `result.json`, PNG screenshots with a matching `.aria.txt`, `ws-frames.jsonl` (every `/ws` text frame plus PCM byte counts), `upstream.jsonl` (what reached the fake LLM/STT during the scenario), downloads, `error.txt`, and `on-failure.png` when a step throws.

Proof standards. Drive the user path (click, type, mic), not WebSocket injection or internal setters. Pair every UI assertion with a side effect: the `/ws` frame sent, the upstream request the fake received, or the row `GET /api/account/history` returns. A scenario that cannot reach its real dependency calls `c.blocked('<what is needed>')` and reports NOT VERIFIABLE; never mark it PASS through a substitute path. The web e2e suite (`web/e2e/*.spec.ts`) mocks `/ws` in places; this skill does not.

## Cleanup

```bash
$C down
```

Kills only the two PIDs recorded by `up`, deletes the throwaway `DATA_DIR` and the instance state file, and keeps `/tmp/nod-verify/runs/<id>/`. It never kills by name. `web/dist` is git-ignored and stays.

## Production

Read-only. `drive prod-readonly` does `GET /api/health` and `GET /`. Do not sign up, request OTP codes, submit forms, or load-test nodpilot.com.
