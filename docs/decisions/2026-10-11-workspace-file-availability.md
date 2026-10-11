# Workspace file action availability

2026-10-11. Application-quality follow-up A13-4.

The file actions menu asks main whether its target satisfies the existing file-opening policy before offering Open actions. The renderer receives one boolean, never a canonical path, file bytes, directory listing, or operating-system handle.

`getWorkspaceFileAvailability(appSessionId, path)` uses the fixed `CH_HOST_WORKSPACE_FILE_AVAILABILITY` channel. The receiving `workspaceFileAvailability` accepts only the bounded `{appSessionId, path}` payload and delegates to `resolveWorkspaceFile`, the same resolver used by `openWorkspaceFile`. It rejects unknown sessions, directories, invalid inputs, escaping realpaths and symlinks, and ambiguous relative links in relocated conversations. The existing generated-image exception remains limited to allowed image files under main's configured root. A literal filename is checked before a source-location suffix is interpreted.

Main accepts requests only from its current window's sender and bounds concurrent reads to eight. The preload applies the existing byte/rate guard. No request reaches an engine or executes an opener. Opening revalidates the target independently, because availability can change between the read and the user's action. No session-wire protocol or saved format changes.

While a result is pending, false, malformed, or rejected, the menu keeps its Copy actions. Only a matching successful read exposes Open actions; replies from an earlier menu target cannot update the current target.

This extends the fixed host metadata surface within the containment and default-deny requirements of [SECURITY-MINIMUM](../migration/decisions/SECURITY-MINIMUM.md). It does not permit directory opening or broaden filesystem access.
