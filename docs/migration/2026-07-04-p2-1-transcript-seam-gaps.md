# P2-1 transcript seam gaps

Decision class: **extend engine vs. change UI**. P2-1 does not change the
versioned protocol.

## Boundary rows absent from `SDKMessage`

`SnipBoundaryRow` and `TombstoneRow` are valid projector row types but cannot be
minted from the current app seam:

- Snip is an internal `system/subtype:'snip_boundary'` shape
  (`src/services/compact/snipProjection.ts:6`). It is not a member of
  `SDKSystemMessage.subtype`, and the current snip implementation is disabled.
- Tombstone is an internal query control signal. `QueryEngine` consumes
  `type:'tombstone'` without yielding it (`src/QueryEngine.ts:815-818`), and
  neither the SDK type union nor runtime schema contains that discriminant.

The degraded P2-1 behavior is therefore no row, rather than an invented frame.
If desktop UX needs these boundaries, extend the engine SDK seam and runtime
schema first; otherwise remove the dormant projector row types when the final
transcript UI contract is narrowed.

## Local-command identity is also lossy

The runtime schema defines `system/subtype:'local_command_output'`, which the
projector maps to `SystemNoticeRow` if received. The live engine instead strips
the local-command wrapper and emits a generic synthetic assistant text frame
(`src/utils/messages/mappers.ts:183-214`). P2-1 therefore renders live local
command output as ordinary assistant text. A dedicated visual treatment also
requires engine seam identity; content heuristics would be invented state.

Command echoes do not have this gap: real user text retains
`<command-message>` and `<command-args>` metadata, so `CommandEchoRow` derives
from the existing message shape.
