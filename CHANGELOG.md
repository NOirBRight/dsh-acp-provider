## v0.1.3

Resolve latest native session binding from sidecar history.

# Changelog

## Unreleased

- Move `latestNativeSessionBinding` onto the browser-safe contracts export and return branded `ExternalAgentSessionRef`.
- Cache per-session activity sequence allocation after one validation read, so appends cost O(batch) instead of O(history), and add bounded `readAfter(sessionId, afterSeq, limit)` cursor pages with fixed record and byte limits.

## [0.1.2] - 2026-09-09

- Keep Other/free-text answers in typed `custom` provenance even when the text matches an option label or native option id.
