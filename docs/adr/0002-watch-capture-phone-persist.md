# 0002. Watch captures; iPhone persists

## Status

Accepted. Implemented with issue #181.

## Context

#165 stored every Watch capture frame on Watch disk and waited for cloud `pcm_drained` before End could finish. Bundle 73 froze on “Catching up”, and iPhone live ingest still only queued RAM. The product rule is: **the Watch does not keep recording files; the phone generates and manages the durable copy.**

## Decision

- Watch: microphone, bounded 128 KiB (~4s) in-memory retry, remote controls, status. No new PCM/WAV capture files. Disconnect or a full buffer pauses; the user Resumes the same phone session.
- iPhone native: the only new durable client. Live frames are identity-checked, written on a serial ingest queue, and acked only for the contiguous on-disk prefix. AudioUplink reads that file. HTTP 4xx handshake failure stops reconnect and keeps the file; websocket 4404 remains listen-session expiry. Those are not the same.
- Watch End waits until the phone holds the final persist prefix (bounded 20s), then is operable. Cloud drain and History keep stay on the phone.
- Persist file ≠ History. Save/Don't save remain. Matching `history_kept` is “Saved to History”. Phone-held audio without that ack is “Saved on iPhone · transcribing”.
- Leftover Watch shards from older builds are not auto-deleted. History lists phone-held captures that are not already a server row.

## Consequences

- Offline Watch recording without a reachable iPhone is not a product promise.
- `pcm_drained` no longer gates Watch UI.
- Phone disk cap is 256 MiB (~2.2h of 16 kHz PCM16). Watch send cap is 4 seconds, never drop-oldest.
