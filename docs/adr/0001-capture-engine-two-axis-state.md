# 0001. Capture and engine are two axes

## Status

Accepted. Implementation lives on `capture-engine-state` after the money/security fixes are stable.

## Context

Phone, Watch, and web all inferred "are we listening?" from one `state` / `run` field. That field also means "the model is thinking." Translate then pulsed `run=think` while a line was still being captured, the Watch treated `listening=false` as Phone Stop, and extra latches (`sawPhoneListening`, `localModeHeld`) piled on.

## Decision

Split live status into two axes and emit both:

- `capture ∈ {off, listening, recording, paused}` — microphone / session
- `engine ∈ {idle, transcribing, generating}` — STT / LLM

The server keeps today's `state` events and also sends `{"type":"phase","capture":...,"engine":...}`. Clients switch to `capture` for Ready / Listening / Paused. Old `state` is removed only after phone JS and Watch Swift both read `phase`.

## Consequences

- Meeting / Translate generating no longer looks like Stop.
- Interview can stay `capture=paused` while `engine=generating`.
- Watch latches that papered over `think` can be deleted after the cutover.
- Each layer (server, phone JS, Watch) can deploy alone because the old event stays until the last reader moves.
