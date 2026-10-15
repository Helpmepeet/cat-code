# Session protocol v4 retirement

Date: 2026-10-15. Implements F1–F4 of the workspace simplification audit.

Protocol v4 removes the unused per-session `memory.snapshot`,
`extensions.snapshot`, `stats.usage.snapshot`, and `oauth.login.progress` frames,
`stats.query`, and its fixed preload IPC sender. Main, preload, renderer, and
sidecar must use the same protocol version. Version checks reject mismatched
frames; no v3 adapter is retained. This source change does not update a running
or installed app.

Memory and extension presentation still use the host Settings inventory and its
existing shared metadata builders. The independent retained-history usage worker
and terminal statistics remain authoritative for their separate surfaces. No
transcripts, settings, account vaults, or usage caches are migrated or deleted.

A chat sidecar accepts only `account.switch` from the account command family,
with the existing receiving schema, identity, and busy-state checks. Host account
management retains its broader domain verbs and dedicated account-control worker:
login, manual-code submission, cancellation, rename, touch, and their progress
still work without a chat. Sign-out and deletion keep their generation-bound
transactions and live-sidecar invalidation. Progress remains redacted before host
publication. Removing an unused session feed adds no credential authority.

Project routing now exposes recovery only: unsent, uncertain, recovery, and
failed states, with explicit resend or cancel. Old checking/Ask/Moving records
remain accepted by the disk reader and become recovery records. Full payloads,
attachments, source cwd, submission receipts, uncertainty, and write/move fences
remain intact. Unknown delivery never becomes automatic resend. No stored routing
record migration or new classifier is introduced.

The renderer has one owner for Analytics selection and session history navigation.
Controlled props carry those values through remounts; the unused standalone stores
are removed. Permission validation, trust checks, normal session events, goals,
workers, and host Settings/account/usage surfaces retain their existing owners.
