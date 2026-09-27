# Translate

Side-by-side captions. The user types a line or presses Start and speaks; each finished sentence shows its translation into the `To` language (`From` can auto-detect). Lines can be played aloud. Stop does not open the Save dialog.

## Sub-features

- `translate-typed` covers a typed Italian line getting a Chinese translation, with one `ask` frame sent.
- `translate-voice` covers spoken lines getting Chinese translations, no `Retry` on any line, and Stop without a Save dialog.
- `tts` covers `/api/tts/status`. Real playback is NOT VERIFIABLE without ElevenLabs.

## How to get to it (user POV)

- Desktop: `Translate` tab, `From` and `To` comboboxes, `Swap From and To`, `Tap` / `Auto` play, `Female voice` / `Male voice`, the `Type to translate...` textbox with `Translate`, and the rail `Start`.
- Phone: `Translate` tab, `Start voice translation`, `Show keyboard` for typing.
- Each row has `Play original` and `Play translation`.

## Driving it with control-nod

Preconditions:

- Instance is up. `To` defaults to Chinese for a new account.

- **Typed.** Run `control-nod drive translate-typed`. `typed.png` shows `我们必须在明天之前完成工作` under the Italian line.
- **Spoken.** Run `control-nod drive translate-voice`. `1-live.png` shows three English lines with their Chinese translations; `2-stopped.png` shows no dialog.
- **TTS.** Run `control-nod drive tts`. `/api/tts/status` returns `{"ok":false}` locally. Needs `ELEVENLABS_API_KEY` to prove audio.

## Gotchas

- The translate prompt the LLM sees is `Translate to <Language>. … Translate only this line:\n<source>`; the `[NOD_TRANSLATE:<id>]` marker is stripped server-side. The fake maps known sentences in `TRANSLATIONS` and falls back to a generic Chinese sentence.
- The client rejects a translation in the wrong script and shows `Retry`. A `Retry` on every row usually means the fake returned Latin text for a Chinese target, not an app bug.
- A new browser on an account with an unsaved Meeting may show that Meeting's lines here. `mode-isolation` in the Listen map owns that check.
