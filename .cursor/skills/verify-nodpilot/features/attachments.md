# Attachments

The `+` button next to the prompt attaches up to five PDF, Office, image, txt, or md files (8 MB each). Text is extracted server-side and sent to the model with the next typed request.

## Sub-features

- `attachments` covers the file chooser opening, the chip showing the file name, and the file text appearing in the LLM request.

## How to get to it (user POV)

- Button `Attach Office, PDF, or image` (label `+`) beside `Type to translate...` in Translate, and beside the Live Q&A question box.

## Driving it with control-nod

Preconditions:

- Instance is up. The scenario writes `agenda.txt` containing `VERIFY-ATTACH-TOKEN`.

- **Attach and send.** Run `control-nod drive attachments`. `1-attached.png` shows the `agenda.txt` chip, and `upstream.jsonl` has an `llm` entry whose prompt contains `VERIFY-ATTACH-TOKEN`.

## Gotchas

- Upload goes through `POST /api/attach/extract` (20 per minute per IP), not over `/ws`.
- Images are not run through vision; only text and PDF bodies reach the model.
