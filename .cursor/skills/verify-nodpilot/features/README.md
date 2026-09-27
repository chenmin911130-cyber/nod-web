# Nodpilot verification map

The maintained list of user-facing behavior and how to prove each one. Read this index, then drive the matching feature file with `control-nod`.

## Baseline preconditions

- `control-nod up` has printed `ready`, and `control-nod doctor` prints `DOCTOR OK` with the build SHA equal to `HEAD`.
- Browser scenarios run as a freshly registered account on `http://nod.localhost:9420`. Only guest checks use `http://127.0.0.1:9420`.
- Fake STT script defaults to three English meeting lines. Scenarios set their own with `fakeScript([...])`.
- Never drive an instance this run did not start. Never write to nodpilot.com.

## Driving conventions

- Run everything through `control-nod drive <scenario>`. A new check becomes a `def(...)` in `scripts/drive.mjs`, not an ad-hoc script.
- Prefer ARIA roles and names. Print the live tree with `control-nod drive aria <path> [desktop|phone] [button|tab:<name>]`.
- Wait for visible text or a dialog, not a fixed sleep, except where a negative ("nothing sent while paused") needs a window.

## Proof and skip reporting

- A PASS needs the user action, the resulting UI state (screenshot + ARIA), and a side effect (`ws-frames.jsonl`, `upstream.jsonl`, or an API read).
- NOT VERIFIABLE names the missing secret, account, or device. Do not report a blocked entry point as verified through another path.
- Record the scenario id with every artifact. Evidence stays in `/tmp/nod-verify/runs/<id>/scenarios/<scenario>/` after `down`.

## Feature entry contract

Each feature file has an H1, one paragraph of user-visible behavior, then exactly these H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with control-nod`, `Gotchas`.

## Features

- [Site, health and SEO](./site-and-api.md) covers the marketing pages, `/api/health`, `/api/config`, robots, sitemap, 404s, and read-only production health.
- [Sign-in](./sign-in.md) covers the localhost guest, email + password, email code (OTP), and Clerk Google sign-in.
- [Listen: Meeting and Lecture](./listen-meeting.md) covers Start, live transcript, Pause/Resume, Stop, the Save dialog, Summarize, Ask, scenes, Export PDF, and workspace isolation.
- [Listen: Live Q&A](./live-qa.md) covers hearing a question and drafting an answer.
- [Translate](./translate.md) covers typed and spoken translation, and text-to-speech.
- [History](./history.md) covers the saved-session list, search, reopen, and delete.
- [Attachments](./attachments.md) covers the `+` file picker and file text reaching the model.
- [Account, settings and billing](./account.md) covers the phone Account sheet, delete account, desktop Settings, sign out, plans and Stripe checkout, and feedback.
- [Admin console](./admin.md) covers `/admin` and the token-gated admin API.
- [Native apps](./native-apps.md) covers the iOS app, Apple Watch app, and Android APK.
