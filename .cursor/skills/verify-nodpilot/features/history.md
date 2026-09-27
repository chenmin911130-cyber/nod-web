# History

Saved sessions (kept for 30 days) are listed in a History dialog. The user can search by title, transcript, or notes, reopen a session to see its transcript, and delete it.

## Sub-features

- `history` covers one saved session listed, search hit and miss, reopening restores the transcript, and delete through the API empties the list.

## How to get to it (user POV)

- Rail `History` (desktop) opens the `History` dialog with a `Search` searchbox, one list item per session, and a `More` menu per row.
- Phone: `More` then History.

## Driving it with control-nod

Preconditions:

- Instance is up. The scenario records a Meeting, saves it, and presses `New session` first.

- **List and search.** Run `control-nod drive history`. `1-list.png` shows one row; `2-search-miss.png` shows none for `zebra-no-match`.
- **Reopen.** `3-opened.png` shows the second scripted line back in the transcript.
- **Delete.** The scenario calls `DELETE /api/account/history/<id>` and re-reads the list as empty. The UI delete lives under the row's `More` menu and is not driven yet.

## Gotchas

- Unsaved sessions show in the list as `Unsaved` rows too; a Save decision changes the label, not the count.
- `GET /api/account/history` returns a JSON array of sessions, each with `items` (`kind`, `text`, `qid`). Use it to prove what was stored, for example duplicate transcript rows.
