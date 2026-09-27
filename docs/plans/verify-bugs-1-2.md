# Fix plan: verify-nodpilot bugs 1 and 2

Execution tickets A and B, one per bug, plus a small Ticket C for a related bug found while root-causing A, in the shape of `docs/agents/ticket-template.md` (§0–§6). Both bugs were found and reproduced with the `verify-nodpilot` skill (`.cursor/skills/verify-nodpilot/`). This file is the plan only; no application code changes here.

- Baseline: `origin/main` `5fa1bfe53292ef6dc068f7d818df4e6595d902ad` (`5fa1bfe`). Every `file:line` below is at this SHA.
- Reproduced on 2026-09-27 at app code equal to that baseline: `control-nod drive meeting-pause-resume mode-isolation` gave `FAIL` for both. Evidence: `/tmp/nod-verify/runs/20260927T004706Z/scenarios/`.
- Baseline harness tally (`control-nod drive all`, local scenarios): PASS 17, FAIL 4 (`auth-otp`, `meeting-pause-resume`, `mode-isolation`, `history-open-isolation`), NOT VERIFIABLE 4 (`auth-clerk`, `tts`, `billing`, `native-apps`). `history-open-isolation` was added on PR #339 and confirmed failing on `5fa1bfe` (run `/tmp/nod-verify/runs/20260927T005705Z`: 1 Meeting line shown in Translate, 3 translate asks).
- Harness delivery. The harness lives on the PR #339 branch (`cursor/verify-nodpilot-skill-0536`), not on `origin/main`. Implementers branch from `origin/main` and bring the harness in uncommitted, for proof only: `git -C <worktree> checkout origin/cursor/verify-nodpilot-skill-0536 -- .cursor/skills/verify-nodpilot && git -C <worktree> reset -q .cursor/skills/verify-nodpilot`. Remove it before committing (`rm -rf .cursor/skills/verify-nodpilot` if `origin/main` does not have it). No ticket's PR may contain harness files; every PR holds only app code and tests.

| Ticket | Bug | Implementer | Why |
|---|---|---|---|
| A | Pause (and STT rotation) re-emits and re-saves the open Meeting line | `grok-4.7` | The edit is small, but it sits in the STT handoff ordering (hold flush, worker drain, seal) shared by Pause and rotation, an area with a long record of state and timing misses in `errors.md`. |
| B | A restored Meeting fills the Translate view and triggers translation requests | `composer-2.5` | One pure function and its unit tests; no concurrency or timing involved. |
| C | Extended Meeting lines are upserted under the wrong History `kind` | `composer-2.5` | Two call sites switch a positional argument to a keyword; one DB-level test. |

Each ticket gets its own PR.

---

## Ticket A · Pause re-emits the open Meeting line and saves it to History twice

### 0. Delivery and boundary

> 交 `grok-4.7`（规则同 Grok / Composer，见 `AGENTS.md` 分工）。从执行时最新 `origin/main` 开隔离 worktree `.worktrees/<issue-id>/`，不要用当前脏工作区。独立 PR，不合并、不部署、不装机、不 `cap:sync`、不 bump bundle。不与 Ticket B 混进同一个 PR。按最小范围改动：只动 §3「改什么」列出的文件和函数，单外一律不碰，拿不准先在本 issue 评论问（见 `AGENTS.md`「实现者最小改动」）。

### 1. Trigger and expected behavior

- **Trigger.** Listen, scene Meeting, Start. One sentence is transcribed and shown. Press Pause while that line is still the open (extendable) line.
- **Now.** The same line appears twice in the transcript with the same timestamp. After Stop and Save, `GET /api/account/history` returns two `transcript` items with the same `qid` and text. Harness: `meeting-pause-resume` fails three steps: `shown 2 time(s) after Pause`, `pre-pause line shown 2 time(s) after resume`, `saved History has the pre-pause line 2 time(s) … qids X,X`. The `/ws` capture shows the server sending `{"type":"question","id":X,…}` once when the line opened and again right after the client's `pause_listen`.
- **Expected.** Pause emits no second `question` for a line the client already has. History holds exactly one `transcript` row per line id, carrying the line's latest text. The first final after Resume still opens a new line.

### 2. Root cause evidence

- `server/app.py:5490-5530` `Session._emit_meeting_line`. A new line is emitted to the client (`self.emit(qev)`, `:5508`), saved with `save_history(…, qev["id"], …)` (`:5514`), and then stored as `self._open_line` (`:5524`).
- `server/app.py:5895-5905`. When a later final extends the open line, the client gets `line_update` for the same id, so the client always already has the open line's current text. The History upsert on that path is broken (see Ticket C): it passes the speaker as the positional `kind` argument, so the `transcript` row keeps only the first fragment.
- `server/app.py:4259-4283` `Session._collect_handoff`. For `_workspace == "meeting"` and `_listen_wanted`, it flushes the hold, drains the worker, then calls `self._seal_open_line()` (`:4272`).
- `server/app.py:5627-5655` `Session._seal_open_line`. It clears `_open_line` and then builds a `question` event with the open line's id and emits it again (`:5649`), then calls `save_history` again (`:5654`). `save_history` is an insert, unlike the upsert `update_history_text` (`server/meter.py:488-521`, signature `(user_id, session_id, qid, text, kind="transcript", speaker="")`), so History gets a second `transcript` row with the same `qid`. Because of the Ticket C bug, that duplicate is currently the only `transcript` row carrying an extended line's merged text, so the fix must upsert rather than simply drop the write.
- `server/app.py:6715-6754` `Session.pause_listen`. It moves the listener into `_handoff_listener` and calls `_collect_handoff(lst)` (`:6744`) while `_listen_wanted` stays true, so the seal runs on every Pause of a Meeting with an open line.
- Why tests stay green: `tests/test_meeting_merge.py:659` `test_pause_drains_buffered_final_before_closing` asserts one `question` after Pause, but its factory (`tests/test_meeting_merge.py:69` `_session`) never sets `_listen_wanted`, so `_collect_handoff` skips the seal in that test.
- History of the seal: added in `6672181` ("STT rotate: seal open line on handoff … reconnect continuity"). The needed effect is clearing `_open_line` so a new STT stream does not extend a line across the rotation. The re-emit and re-insert are side effects.
- `[未确认]` STT rotation and reconnect (`Session._restart_listener`, `server/app.py:4294`, into `_collect_handoff` with `_paused` false) take the same seal path, so they should duplicate the open line too. Code inference only; the harness cannot trigger a rotation.
- `[未确认]` Reproduced with the local fake AssemblyAI (protocol-conforming `Turn` frames). Not reproduced against real AssemblyAI or production.

### 3. Scope

- **Change.**
  - `server/app.py` `Session._seal_open_line` only. Keep clearing `_open_line` under `_meeting_lock` and keep the early returns for an empty or `closed` line. Stop emitting the `question` event. Replace the `save_history(…)` call with `update_history_text(self.user_id, self.usage_session_id, qid, text, speaker=speaker or "")`, passing `speaker` by keyword so `kind` stays `"transcript"`. The row for that id is then upserted with the latest text, never duplicated. Remove locals that become unused; change nothing else in the function.
  - `tests/test_meeting_seal_no_duplicate.py` (new).
- **Do not change.**
  - `Session._collect_handoff`, `pause_listen`, `resume_listen`, `_restart_listener`, `_emit_meeting_line`, `_flush_meeting_hold`, `_stop_meeting_worker`, or the extend path, including the `update_history_text` calls at `server/app.py:5734` and `:5905` (Ticket C owns those).
  - `server/meter.py` (`save_history`, `update_history_text`).
  - Any client code, including the `question` reducer in `web/src/App.tsx`. No client-side dedupe in this ticket.
  - Existing tests, including `tests/test_meeting_merge.py` and `tests/test_listen_attach_279.py`.
  - `.cursor/skills/verify-nodpilot/**`.

### 4. Regression tests and edge cases

New file `tests/test_meeting_seal_no_duplicate.py`. Build a real `Session` the way `tests/test_meeting_merge.py:69` does, then set `_listen_wanted = True` (the production state during Pause), a mock `_listener`, `_stop_listener` as a no-op, and a real `user_id` plus `usage_session_id` from `server.meter.open_usage_session` (see `tests/test_history_keep.py`). Drive finals through `_enqueue_meeting_final` (the real worker) and the handoff through `pause_listen()` or `_restart_listener()`. Read History with a fresh `db_session()` query on `HistoryItem` filtered to `kind == "transcript"`, not from emitted events. Rows with other kinds written by the Ticket C bug are out of scope here.

- `test_pause_does_not_reemit_open_line`. One final, then `pause_listen()`. Exactly one `question` event carries the line id; `_open_line is None`.
- `test_pause_keeps_one_history_row_per_line`. Same setup. A fresh DB read returns exactly one `transcript` row for that `qid`, with the line text.
- `test_pause_after_extend_keeps_merged_text_once`. First final, a continuation final without a sentence end (produces `line_update`), then `pause_listen()`. No second `question`; one DB row whose text equals the merged text from the last `line_update`.
- `test_stt_rotation_does_not_reemit_open_line`. One final, then `_restart_listener()` with `_paused` false and `_start_listening` patched to a no-op. One `question` for the id, one DB row, `_open_line is None`.
- `test_first_final_after_resume_opens_new_line`. After Pause, `resume_listen()` (listener start patched), then a new final. Two `question` events with different ids.

Edge cases to cover inside those tests: no open line at Pause (no events, no rows added); a `closed` open line (split path) at Pause; `user_id` None (no DB access, still no re-emit); a second Pause in the same session.

Before the fix, the first four tests must fail (two `question` events, two rows). Paste that output in the PR.

### 5. Acceptance commands and pass criteria

- `pytest tests/test_meeting_seal_no_duplicate.py tests/test_meeting_merge.py tests/test_listen_attach_279.py tests/test_stt_terminate.py tests/test_pcm_drain.py tests/test_turn_pacing.py tests/test_phase.py` → before the fix, the new tests fail on their duplicate assertions; after the fix, all pass, with the five new test names listed.
- `pytest -q` → no new failures compared with the baseline run on `5fa1bfe` (list any baseline failures by name next to the result).
- Harness, from the worktree with the harness checked out uncommitted (see "Harness delivery"; the skill resolves the repo root from its own path):
  - `C=.cursor/skills/verify-nodpilot/scripts/control-nod; $C up && $C doctor`
  - `$C drive meeting-pause-resume` → before the fix FAIL with the three duplicate steps; after the fix PASS with all seven steps ok.
  - `$C drive all` → the only status change from the baseline tally is `meeting-pause-resume` FAIL → PASS. Expected after the fix: PASS 18, FAIL 3 (`auth-otp`, `mode-isolation`, `history-open-isolation`), NOT VERIFIABLE 4. `meeting-live`, `meeting-notes-ask`, `scene-lecture`, `history`, `export-pdf` must stay PASS.
  - `$C down`. Paste the `drive` summaries and the path of the evidence run.
- `git diff --stat origin/main` → only `server/app.py` and `tests/test_meeting_seal_no_duplicate.py`.
- **Pass criterion.** After a Pause, a fresh DB read shows one `transcript` row per line id, holding the line's latest (merged) text, and the `/ws` capture of `meeting-pause-resume` shows one `question` frame per line id.

### 6. Implementer challenge clause

> 执行前先按 §2 的 `文件:行` 核一遍根因。证据对不上（行号不对、代码已变、复现不出来、修法会破坏 §3 的禁改项），**先在本 issue 评论反馈，不要硬按单改**。有更简单或更安全的修法也先评论，等回复再动手。发现单外的同类问题，评论里记一笔，不并进本 PR。

---

## Ticket B · A restored Meeting fills the Translate view and triggers translation requests

### 0. Delivery and boundary

> 交 `composer-2.5`（规则同 Grok / Composer，见 `AGENTS.md` 分工）。从执行时最新 `origin/main` 开隔离 worktree `.worktrees/<issue-id>/`，不要用当前脏工作区。独立 PR，不合并、不部署、不装机、不 `cap:sync`、不 bump bundle。不与 Ticket A 混进同一个 PR。按最小范围改动：只动 §3「改什么」列出的文件和函数，单外一律不碰，拿不准先在本 issue 评论问（见 `AGENTS.md`「实现者最小改动」）。

### 1. Trigger and expected behavior

- **Trigger, path 1 (launch restore).** Record a Meeting, press Stop, leave the `Save to History?` choice undecided. Open the app in a different browser on the same account (its `localStorage` has no dismissed id), then switch to the Translate tab.
- **Trigger, path 2 (open from History).** Record and Save a Meeting, press New session, open that Meeting from History, then switch to the Translate tab.
- **Now.** Translate shows the Meeting's lines as caption rows and sends one translate `ask` per line (3 for a 3-line Meeting), spending the user's LLM quota. Harness: `mode-isolation` fails `new browser, same account: Translate shows 1 Meeting line(s)` and `Translate sent 3 translate request(s)` (path 1); `history-open-isolation` fails `after opening: Translate shows 1 Meeting line(s)` and `after opening: 3 new translate ask(s)` (path 2).
- **Expected.** Restoring a Meeting, Lecture, or Live Q&A session never adds rows to the Translate view and never triggers translate requests there. The Meeting still restores in Listen as today (lines, notes, Save banner). Restoring a Translate session still restores its caption pairs.

### 2. Root cause evidence

- `web/src/historyRestore.ts:457-541` `restoreFromSession`. It builds `pairs` from every `transcript` item regardless of the session's mode (`:524`, `originals.map(…)`). For a Meeting session this returns one untranslated pair per line.
- `web/src/App.tsx:867-895` reducer `restore_session`. It writes `action.pairs` into `state.translatePairs` (`:874-876`, used at `:891`).
- `web/src/App.tsx:3321-3350` `pumpTranslate`. In Translate mode it walks `state.translatePairs` and asks for every row without a translation (`:3350`). `TranslatePane` renders the same rows.
- Both restore paths go through `restoreFromSession`: `restoreHistory` (`web/src/App.tsx:1437`, `:1446`), used by History and by the launch restore `checkPendingRestore` (`:1520-1540`); and the live attach path (`:1913`).
- The launch restore itself is intended crash recovery (`restoreLaunchSurface`, `web/src/historyRestore.ts:176`). It only fires in another browser because Stop records the id in that browser's dismissed list. This ticket does not change it.
- Existing tests pin the current behavior: `web/src/historyRestore.test.ts:256-257` expects a Meeting restore to return one pair, and `:274-275` expects a legacy Meeting session's unmatched `translate` row to surface as a pair.
- `[未确认]` Whether production holds Meeting sessions with unmatched legacy `translate` rows. After this change those translations are no longer reachable through the Translate tab. They are not shown in Listen today either.

### 3. Scope

- **Change.**
  - `web/src/historyRestore.ts` `restoreFromSession` only: return caption `pairs` only when `mode === 'translate'`, and `pairs: []` for every other mode. Leave `lines`, `turns`, `notes`, `summary`, `elapsedMs`, and the qid-matched translation logic unchanged.
  - `web/src/historyRestore.test.ts`: change the assertions at `:256-257` and `:274-275` to the new expectation (Meeting restore returns zero pairs), keeping the line-translation assertions around them; add the tests in §4. List each changed assertion and why in the PR.
- **Do not change.**
  - `web/src/App.tsx` (the `restore_session` reducer, `pumpTranslate`, `restoreHistory`, `checkPendingRestore`).
  - `restoreLaunchSurface`, the dismissed-id storage, or when the launch restore fires.
  - `TranslatePane`, `HistoryPane`, PDF export, any server file, native code.
  - Other assertions in `historyRestore.test.ts`, including the Translate-session pair tests at `:14-35`.
  - `.cursor/skills/verify-nodpilot/**`. The implementer runs the harness (see "Harness delivery" at the top) but never edits or commits it.

### 4. Regression tests and edge cases

In `web/src/historyRestore.test.ts`, call `restoreFromSession` with a literal session and assert literal results (style: the file's existing `eq(…)` checks).

- A `mode: 'meeting'` session with two transcript items returns `pairs.length === 0` and `lines.length === 2`.
- A `mode: 'meeting'` session with a qid-matched `translate` row still hangs the translation on its line and returns zero pairs.
- A `mode: 'meeting'` legacy session with an unmatched `translate` row returns zero pairs and an untranslated line.
- A `mode: 'interview'` session and a `scene: 'lecture'` session return zero pairs.
- A session with no `mode` (legacy) returns zero pairs, because `modeOf` maps it to `meeting`.
- A `mode: 'translate'` session still returns one pair per transcript with its translation and timestamps (existing `:14-35` stays green unchanged).

UI-path proof uses two existing harness scenarios on PR #339: `mode-isolation` (path 1) and `history-open-isolation` (path 2). `history-open-isolation` records a three-line Meeting, saves it, presses `New session`, checks Translate is empty, opens the session from `History`, switches to Translate, and asserts zero Meeting lines and zero new translate asks. Both FAIL on the baseline; rerun them before the fix to capture the "before" evidence.

### 5. Acceptance commands and pass criteria

- `(cd web && npx tsx src/historyRestore.test.ts)` → before the fix, the new zero-pairs assertions fail; after the fix, the file passes.
- `npm --prefix web test` → passes (it passed on the baseline).
- `npm --prefix web run build` → succeeds (type check plus bundle).
- Harness, from the worktree with the harness checked out uncommitted (see "Harness delivery"):
  - `C=.cursor/skills/verify-nodpilot/scripts/control-nod; $C up --rebuild && $C doctor` (the client must be rebuilt).
  - Before the fix: `$C drive mode-isolation history-open-isolation` → both FAIL.
  - After the fix: the same command → both PASS.
  - `$C drive all` → the only status changes from the baseline tally are `mode-isolation` and `history-open-isolation` FAIL → PASS. Expected: PASS 19, FAIL 2 (`auth-otp`, `meeting-pause-resume`), NOT VERIFIABLE 4. `translate-typed`, `translate-voice`, `history`, `meeting-live`, `export-pdf` must stay PASS.
  - `$C down`. Paste the summaries and the evidence run path.
- `git diff --stat origin/main` → only `web/src/historyRestore.ts` and `web/src/historyRestore.test.ts`.
- **Pass criterion.** In both restore paths, the `/ws` capture after switching to Translate contains no translate `ask`, the screenshot shows the empty Translate state, and restoring a Translate session still shows its pairs (`translate-typed` and the `:14-35` unit test).

### 6. Implementer challenge clause

> 执行前先按 §2 的 `文件:行` 核一遍根因。证据对不上（行号不对、代码已变、复现不出来、修法会破坏 §3 的禁改项），**先在本 issue 评论反馈，不要硬按单改**。有更简单或更安全的修法也先评论，等回复再动手。发现单外的同类问题，评论里记一笔，不并进本 PR。

---

## Ticket C · Extended Meeting lines are upserted under the wrong History `kind`

### 0. Delivery and boundary

> 交 `composer-2.5`（规则同 Grok / Composer，见 `AGENTS.md` 分工）。从执行时最新 `origin/main` 开隔离 worktree `.worktrees/<issue-id>/`，不要用当前脏工作区。独立 PR，不合并、不部署、不装机、不 `cap:sync`、不 bump bundle。不与 Ticket A / B 混进同一个 PR。按最小范围改动：只动 §3「改什么」列出的文件和函数，单外一律不碰，拿不准先在本 issue 评论问（见 `AGENTS.md`「实现者最小改动」）。

### 1. Trigger and expected behavior

- **Trigger.** In a Meeting, a final without a sentence end is followed by a continuation final, so the server extends the open line (`line_update`), or a line is revised in place.
- **Now.** The `transcript` row for that line keeps only the first fragment. The upsert inserts a second row with the same `qid` and `kind` equal to the speaker label, or `""` when there is no speaker. Measured on the baseline with the real functions: `save_history(u, s, "transcript", "So one of the", "q1", "")` then `update_history_text(u, s, "q1", "So one of the significant features", "")` leaves rows `('transcript', 'q1', 'So one of the')` and `('', 'q1', 'So one of the significant features')`. History restore reads only `transcript` rows, so a reopened session shows the truncated line.
- **Expected.** The existing `transcript` row is updated in place with the merged text and the speaker; no row with another `kind` is created.

### 2. Root cause evidence

- `server/meter.py:488` `update_history_text(user_id, session_id, qid, text, kind="transcript", speaker="")`.
- `server/app.py:5734` `update_history_text(self.user_id, self.usage_session_id, qid, cleaned, speaker or "")` and `server/app.py:5905` `update_history_text(self.user_id, self.usage_session_id, line_id, merged, pspeaker or "")` pass the speaker as the fifth positional argument, which is `kind`.
- `[未确认]` How many production sessions already hold stray non-`transcript` rows. Cleaning existing data is out of scope.

### 3. Scope

- **Change.** `server/app.py`: the two calls at `:5734` and `:5905` pass the speaker as `speaker=…` by keyword. `tests/test_meeting_extend_history.py` (new).
- **Do not change.** `server/meter.py`, `_seal_open_line` (Ticket A), any other `save_history` / `update_history_text` caller, the meeting decision logic, client code, existing tests, `.cursor/skills/verify-nodpilot/**`, and existing database rows.

### 4. Regression tests and edge cases

New file `tests/test_meeting_extend_history.py`, same Session setup as Ticket A §4 (real `user_id`, `usage_session_id`, `_enqueue_meeting_final`). Assert on a fresh `db_session()` read of `HistoryItem` for the session.

- `test_extend_updates_transcript_row_in_place`. A final without a sentence end, then a continuation final. Exactly one row for the `qid`, `kind == "transcript"`, text equal to the merged text of the last `line_update`.
- `test_extend_with_speaker_keeps_kind_and_sets_speaker`. Same with speaker `"A"`. One `transcript` row, `speaker == "A"`, no row with `kind == "A"`.
- `test_revision_updates_transcript_row_in_place`. Drive the revision path at `:5734` (a revised final for an already-committed turn). One `transcript` row with the revised text.

Edge cases: no speaker (`""`), a speaker label, two consecutive extends, `user_id` None (no DB access). Before the fix the first two tests fail with two rows and the wrong `kind`.

### 5. Acceptance commands and pass criteria

- `pytest tests/test_meeting_extend_history.py tests/test_meeting_merge.py tests/test_history_keep.py` → before the fix the new tests fail on the row count and `kind`; after the fix all pass, with the three new test names listed.
- `pytest -q` → no new failures compared with the baseline.
- Harness: `control-nod up && control-nod drive all && control-nod down` → no status changes from the tally at merge time (the fake STT closes every line, so no scenario extends a line; the pytest file is the regression proof).
- `git diff --stat origin/main` → only `server/app.py` and `tests/test_meeting_extend_history.py`.
- **Pass criterion.** After an extend, a fresh DB read shows one `transcript` row per `qid` holding the merged text, and no row with any other `kind` for that `qid`.

### 6. Implementer challenge clause

> 执行前先按 §2 的 `文件:行` 核一遍根因。证据对不上（行号不对、代码已变、复现不出来、修法会破坏 §3 的禁改项），**先在本 issue 评论反馈，不要硬按单改**。有更简单或更安全的修法也先评论，等回复再动手。发现单外的同类问题，评论里记一笔，不并进本 PR。

---

## Merge order and integration

A and C both edit `server/app.py` in different functions; land them one after the other and rebase the second. B is independent. After all three merge, run on a clean worktree of merged `origin/main`: `pytest -q`, `npm --prefix web test`, and `control-nod up --rebuild && control-nod drive all && control-nod down`. Expected tally: PASS 20, FAIL 1 (`auth-otp`, tracked separately), NOT VERIFIABLE 4.
