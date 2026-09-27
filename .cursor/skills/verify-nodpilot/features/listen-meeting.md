# Listen: Meeting and Lecture

The default workspace. The user presses Start, speaks, and sees a live transcript, one line per finished sentence. Summarize writes scene-specific notes, Ask answers a typed question in Notes, Pause and Resume keep one session, and Stop offers Save to History. Meeting and Lecture differ only in the notes template.

## Sub-features

- `meeting-live` covers Start, PCM over `/ws`, lines from STT in the transcript, Stop, the `Save to History?` dialog, Save, and the kept row in `GET /api/account/history`.
- `meeting-notes-ask` covers Summarize rendering notes and Ask rendering an answer, both proven by the prompt that reached the LLM.
- `meeting-pause-resume` covers Pause (status `Paused`, no PCM sent), resuming with the rail button (it reads `Start` while paused), and no duplicate lines live or in saved History.
- `scene-lecture` covers switching the scene to Lecture and the notes prompt naming the lecture template.
- `export-pdf` covers Export PDF downloading a file that starts with `%PDF-`.
- `mode-isolation` covers an unsaved Meeting not appearing in Translate after a reload or in a new browser on the same account, and no translate requests for it.
- `history-open-isolation` covers a saved Meeting opened from History not appearing in Translate, and no translate requests for it.

## How to get to it (user POV)

- Desktop: `Listen` tab, left rail `Start` / `Pause` / `Stop` / `Export PDF` / `Save` / `History` / `New session`; scene chip `Meeting` at the top opens a listbox with `Meeting`, `Lecture`, `Live Q&A`.
- Phone (390x844): `Start listening`, `Scene Meeting`, `Spoken language …`, `Notes language …`.
- Notes pane: `Summarize` button and the `Ask anything — the answer shows in Notes` textbox with `Ask`.

## Driving it with control-nod

Preconditions:

- Instance is up, a fresh account per scenario (automatic), fake STT script set by the scenario.

- **Live transcript.** Run `control-nod drive meeting-live`. The three scripted lines appear, `ws-frames.jsonl` has `start_listen` and about 190 KB of PCM, `upstream.jsonl` has `stt_open` and a `Terminate`, and `history.json` has one session with three transcript items.
- **Notes and Ask.** Run `control-nod drive meeting-notes-ask`. `1-notes.png` shows `Budget review before Friday.`; `2-ask.png` shows the fake answer; `upstream.jsonl` holds the notes prompt and the typed question.
- **Pause.** Run `control-nod drive meeting-pause-resume`. Every step must be ok, including the saved-History duplicate check.
- **Lecture.** Run `control-nod drive scene-lecture`. The notes prompt in `upstream.jsonl` contains `lecture`.
- **Export.** Run `control-nod drive export-pdf`. The saved file in the scenario dir starts with `%PDF-`.
- **Isolation.** Run `control-nod drive mode-isolation`. `translate-after-reload.png` and `translate-in-new-browser.png` must show no Meeting lines.

## Gotchas

- Stop always opens `Save to History?` in Meeting and Lecture. Close it (Save or `Don't save`) before asserting on the page behind it.
- Stopping also triggers automatic notes, so an extra notes prompt in `upstream.jsonl` after Stop is expected.
- The fake emits a line per 2 s of PCM. A scenario that speaks three lines needs about 6 s of listening before Stop.
- A notes reply that is not recognized comes back as `Mock answer from the fake DeepSeek provider.`; extend `reply_for()` in `fake_providers.py` rather than loosening the assertion.
- History titles come from a separate title prompt; the fake answers it with the generic reply, so titles read `Mock answer…`.
- Not driven yet: `Record` (F2 manual recording), `Stop + Report`, `Don't save`, the `Bilingual` switch with a concrete Notes language, `Number of speakers`, and the phone layout (`Start listening`). Add a scenario before claiming any of them works.
