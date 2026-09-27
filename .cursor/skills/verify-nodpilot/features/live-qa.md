# Listen: Live Q&A

A Listen scene for interviews and Q&A. While listening, the app waits until a spoken question is complete, then drafts an answer card with `Ask follow-up` and `Retry`. It does not offer Save on Stop.

## Sub-features

- `live-qa` covers selecting the scene, the question being transcribed, the completeness judge running, and an answer card rendering the LLM reply.

## How to get to it (user POV)

- `Listen` tab, scene chip `Meeting`, then option `Live Q&A`, then `Start`.
- The rail collapses behind a left-edge `Controls` tab (`Show controls`) in this scene. Stop lives there.
- A typed question goes in `Type a question.` with `Answer`. `Think` toggles the slower reasoning path.

## Driving it with control-nod

Preconditions:

- Instance is up. The scenario scripts one English question.

- **Answer.** Run `control-nod drive live-qa`. `qa.png` shows `Question detected`, the question as a heading, and the fake answer under `AI Answer`. `llm-prompts.txt` shows a non-streaming judge call starting `Fragments in order:` and then the streamed answer call.

## Gotchas

- The judge must reply with JSON `{"verdict":"ready|wait|background",...}` (see `JUDGE_SYSTEM_PROMPT` in `server/qa_semantic.py`). `fake_providers.py` answers `ready` with the fragments joined. Without that, no answer is ever drafted.
- The hidden rail's Stop button counts as visible to Playwright but a panel intercepts the click. Use `stopListening(page)`, which opens `Show controls` when needed.
- `Think` answers call the pinned DeepSeek client with `thinking` enabled. The fake ignores that flag, so Think output is not distinguished locally.
