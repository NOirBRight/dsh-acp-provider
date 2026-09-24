# Changelog

## [Unreleased]

- Align the optional UI-primitives peer and development dependency with alpha2, satisfy its Cordis peer in development, and use alpha2 icon exports in the shared native tool card.

## [0.1.6] - 2026-09-20

- Add browser-only `native-ui` and pure `native-preview` exports so ACP adapters share one accessible read-only tool presentation without importing React from the Node entrypoint. Structured payload previews stay valid JSON when bounded.
- Add the Node-only `activity-coalescer` export: one provider-neutral bounded coalescer behind a vendor codec, keeping the reviewed 400 ms window, 64-record, 8192-character, 256 KiB, and 32-repaint ceilings, barrier ordering, deferred failures, and `flushAll`/`release`/`reset` teardown. It carries no metrics parameter and reports buffers through `pendingCount(sessionId)` and `pendingBytes(sessionId)` instead.
- Add the browser-safe `native-history` export: the WeakMap-retained fold, cursor, and snapshot per scope and session, with bounded incremental paging, immediate per-page publication, stable snapshot identity, `StaleNativeHistoryCursorError` resynchronization, and a fresh empty snapshot per entry. It exposes no metrics seam.

## [0.1.5] - 2026-09-18

- Harden the activity cursor contract additively: `readAfter` marks a page with `historyMissing: true` when the cursor is past 0 and the history file no longer exists (a deleted history is never reported as caught up), and throws the exported `ExternalAgentActivityCursorAheadError` (`kind: 'cursor-ahead'`, `afterSeq`, `historyLength`) instead of a prose-only error when the cursor is past the end of an existing history. The JSONL schema, page limits, and existing failure behavior are unchanged.

## [0.1.4] - 2026-09-18

- Cache per-session activity sequence allocation after one validation read, so appends cost O(batch) instead of O(history), and add bounded `readAfter(sessionId, afterSeq, limit)` cursor pages with fixed record and byte limits.

## [0.1.3]

- Move `latestNativeSessionBinding` onto the browser-safe contracts export and return branded `ExternalAgentSessionRef`.

## [0.1.2] - 2026-09-09

- Keep Other/free-text answers in typed `custom` provenance even when the text matches an option label or native option id.
