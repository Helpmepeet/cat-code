# Bug: a local slash command renders twice after an in-run sidecar restart

Filed 2026-08-08. Root cause is in the **engine**
(`src/utils/processUserInput/processSlashCommand.tsx`); it surfaces in
`app/renderer` transcript projection after a resumed-history replay. Severity:
low (display-only, no data loss), but it misreports the user's own actions back
to them, which is why it was reported.

Revised after review: the first draft named the right mechanism but proposed two
unworkable consumer-side fixes and overstated the blast radius. Both are
corrected below, with the rejected proposals kept and the reason recorded.

**Status: fixed 2026-08-09 (`4cc3084`).** Three call sites now carry the uuid;
tests added at the producer and at the `rawMessageLog` consumer. The projector
tests are written but sit uncommitted in `transcriptProjector.test.ts`, which
holds another session's in-flight work.

## Summary

After the sidecar restarted mid-session and the renderer reattached, the
transcript showed `/compact` twice. The operator ran it once.

Nothing compacted twice. The engine's message array and the on-disk transcript
are both correct. The second row is a replayed copy of the same command that the
renderer's replay de-dup failed to recognize, because a slash command is the one
message kind that reaches the renderer under **two different uuids**.

## Repro

1. Open a desktop session and run any slash command (`/compact`, `/model`, …).
2. Let the sidecar restart in-run (crash, or host-driven restart) so the renderer
   reattaches to the same `appSessionId` without a window reload.
3. The resumed sidecar replays its history. The slash-command row appears a
   second time.

Observed on app session `26658074-97d7-4f67-9ba1-c20ba4e2a66f` /
engine session `b79860e5-fb16-40f5-86b6-0bf2fcd59256`,
`registry.json` `"restartCount": 2`.

## Root cause

The renderer skips a replayed frame only when its `uuid` is already in
`seenFrameIds` (`app/renderer/src/transcriptProjector.ts:1044` on the user-frame
path, and the same rule in `app/renderer/src/rawMessageLog.ts:146`). The
assumption is stated outright in that second comment:

> the resumed sidecar's replayed history (`replay:true`, same uuids — F1/F2
> same-source)

That assumption holds for every message kind except a slash command.

For an ordinary prompt the engine mints one uuid, emits it live, and persists the
same uuid. For a slash command the live stream carries a synthetic echo of the
typed text, while the transcript stores the **expanded** local-command records
under their own uuids. Nothing links the two.

Measured on this session, live frames
(`~/.cat-code/desktop/transcript-cache/26658074-….json`) vs the transcript
(`~/.cat-code/projects/-Users-pt-cat-code/b79860e5-….jsonl`):

| uuid | content | live frame | transcript |
|---|---|---|---|
| `db3acf06` | `what next` (plain prompt) | yes | yes |
| `91815b63` | `what next again ?` | yes | yes |
| `be571427` | `<local-command-stdout>Compacted…` | yes | yes |
| `9bf72620` | `"/compact"` (raw prompt echo) | yes | **no** |
| `1769477c` | `<command-name>/compact</command-name>` | **no** | yes |
| `06ce214c` | `<local-command-caveat>…` | **no** | yes |

On restore, `1769477c` had never been seen, so it appended a new row, and
`transcriptProjector.ts:2053-2062` renders `<command-message>compact</command-message>`
as the literal string `/compact`. The result is two rows that both read
`/compact`: the live echo (`9bf72620`) and the replayed command row
(`1769477c`).

The divergence is **producer-side, and it is a dropped argument**. The sidecar
mints exactly one uuid per submission and uses it for both the live echo and the
engine call (`app/sidecar/sidecarServer.ts:1257`, `:1285`, `:1292`). That uuid
travels all the way into slash-command processing as a parameter
(`src/utils/processUserInput/processSlashCommand.tsx:310`, `:416`, `:546`), and
the prompt-command branch honors it:

```ts
// processSlashCommand.tsx:933-936 — prompt commands preserve the submit uuid
const messages = [createUserMessage({ content: metadata, uuid }), …]
```

The local branch, on the same in-scope `uuid`, does not:

```ts
// processSlashCommand.tsx:688-696 — `case 'local'`, uuid omitted
const userMessage = createUserMessage({
  content: prepareUserContent({ … }),
})   // ← createUserMessage mints a fresh uuid
```

`createUserMessage` then mints a new one, and `/compact` carries that
newly-identified message into the compacted transcript. Nothing downstream can
recover the link.

Two conditions make it visible, and both held here:

- **The renderer stores survive the restart.** An in-run restore reuses the
  `appSessionId` and the stores are never torn down, so the pre-restart rows are
  still present when the replay arrives.
- **The replay came from the sidecar, not main's buffer.** Main evicts its
  replay buffer on restart (`evictReplay` in `app/main/main.ts`), so the
  duplicate cannot come from there. The truncation notice the operator saw,
  `Only the 951 most recent messages are shown.`, is the sidecar's
  history-replay cap (`app/sidecar/sidecarServer.ts:758`, 4,000 frames /
  4 MiB). Main's notice would have read `8000`, and that is what sits in the
  at-rest cache.

## Blast radius

**Not** every slash command. Only the branches that persist a renderer-visible
`/command` breadcrumb while dropping the supplied uuid:

- `case 'local'` — `processSlashCommand.tsx:688-696`. This is `/compact`.
- the `local-jsx` non-`system` branch — `processSlashCommand.tsx:619-628`, the
  same `createUserMessage({ content: prepareUserContent(…) })` omission.

Unaffected, verified:

- **Prompt/skill commands** already pass `uuid` (`:933-936`).
- **`display:'skip'`** persists no command record at all (`:590-598`).
- **`display:'system'`** routes through `createCommandInputMessage`, and replay
  deliberately drops that input metadata (`src/utils/messages/mappers.ts:241-257`).
- **Invalid/unavailable commands** persist different content, not the
  `/command` breadcrumb.

`/model` is affected only on whichever of its routes hits the two branches above,
not by virtue of being a slash command.

Display-only either way. No engine state, transcript content, or context is
affected. The 951-message replay cap is separate and expected for a 3.3 MB
transcript.

## Fix

**Pass the supplied `uuid` into the `createUserMessage` calls that build the
command-input breadcrumb**, in both affected branches. It is already a parameter
in scope; the prompt-command branch is the existing precedent for the shape.

This keeps the row rendering immediately, keeps de-dup keyed on uuid alone, and
removes the divergence at the point where it is introduced.

### Two earlier proposals, both rejected

- **Correlate on `promptId` in the renderer.** Rejected. The live echo carries no
  `promptId` at all — frame `3819` in the cache has only
  `role/content/session_id/parent_tool_use_id/uuid/timestamp`
  (`app/sidecar/sidecarServer.ts:1330-1347`) — and restored messages lose
  persistence-only metadata in `toSDKMessages`
  (`src/utils/messages/mappers.ts:191-228`). Worse, a *recognized* slash command
  never mints a fresh prompt id (`setPromptId` is reached only when
  slash-looking input is **not** a recognized command,
  `processSlashCommand.tsx:333-382`), so the `bafe1cd4-…` cited in the first
  draft of this report was inherited from the preceding `what next` turn.
  Correlating on it would have merged the command with an unrelated prior turn.
- **Suppress the live echo for local commands.** Rejected. For
  `shouldQuery:false` commands the engine emits outputs, compact boundaries, and
  a result, but never the persisted command breadcrumb
  (`src/QueryEngine.ts:673-755`) — which is why no `<command-name>` frame appears
  anywhere in the live cache. The sidecar echo is the *only* command row
  delivered during the run. Suppressing it would not cause "a brief gap"; the
  row would stay missing until some future sidecar process loaded and replayed
  the transcript, since the running sidecar's history array is fixed at startup.

## Test plan

A projector-only test is not sufficient: manufacture both frames with the same
uuid and it passes today, before any fix; manufacture them with different uuids
and it locks in a consumer-side content-correlation design that this report
rejects. Coverage must start at the producer.

1. **Producer regression** (`src/`) — call local slash processing with an
   explicit uuid; assert the persisted command breadcrumb retains it. Fails
   before the fix.
2. **Projector integration** — live raw `/compact` frame with uuid `U`, then
   replayed expanded command metadata with uuid `U`; assert one visible command
   row, and that the separately-identified stdout row survives.
3. **Raw-message-log integration** — same sequence against
   `app/renderer/src/rawMessageLog.ts`, which has its own independent de-dup
   (`:139-149`); assert one message for uuid `U`.

## Evidence commands

```bash
bun ~/.agents/skills/session-analysis/scripts/session-inspect.ts overview b79860e5
```

```bash
cd /Users/pt/cat-code && jq -c 'select(.type=="user") | select((.message.content|tostring)|test("/compact")) | {uuid, ts:.timestamp}' ~/.cat-code/projects/-Users-pt-cat-code/b79860e5-fb16-40f5-86b6-0bf2fcd59256.jsonl
```

```bash
cd /Users/pt/cat-code && jq -c '.frames[3819], .frames[3827]' ~/.cat-code/desktop/transcript-cache/26658074-97d7-4f67-9ba1-c20ba4e2a66f.json
```
