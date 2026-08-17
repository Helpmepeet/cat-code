import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import {
  App,
  ConnectionRecovery,
  SessionPane,
  TasksStrip,
} from './App.js'
import {
  buildDebugExport,
  claimOAuthContextForAccountLogin,
  deriveActivity,
  fmtElapsed,
  fmtTok,
  reducePromptDrafts,
  selectLiveTokenEstimate,
  selectPromptDraft,
  sendPermissionResponse,
  shouldShowAnthropicPoolAccount,
  shouldShowFirstRunOAuth,
} from './appModel.js'
import type { ConnectionSnapshot } from './connectionState.js'
import { createTranscriptState } from './transcriptProjector.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import type {
  AccountsSnapshot,
  AccountStatus,
  AgentModeWorkerItem,
  RunControlsSnapshot,
  TaskSnapshotItem,
  TasksSnapshot,
} from '../../shared/protocol.js'

/**
 * The composer field's opening tag. It is a contentEditable `<div>` (so a
 * collapsed paste can render as an inline pill), which is why its state reads
 * from ARIA rather than the `readOnly`/`disabled`/`placeholder` attributes a
 * `<textarea>` carried.
 */
function composerField(html: string): string {
  return html.match(/<div[^>]*aria-label="Prompt"[^>]*>/)?.[0] ?? ''
}

function emptyAccountsSnapshotForTest(): AccountsSnapshot {
  return {
    accounts: [],
    activeAccountId: null,
    readyCount: 0,
    poolCount: 0,
    initialized: true,
    anthropicAccounts: [],
    anthropicActiveAccountId: null,
    anthropicReadyCount: 0,
    anthropicPoolCount: 0,
    anthropicInitialized: true,
    anthropicRouteAvailable: false,
  }
}

test('first-run OAuth does not block an API-key or cloud Anthropic route', () => {
  const emptyPools = emptyAccountsSnapshotForTest()
  expect(shouldShowFirstRunOAuth(emptyPools, false)).toBe(true)
  expect(
    shouldShowFirstRunOAuth(
      { ...emptyPools, anthropicRouteAvailable: true },
      false,
    ),
  ).toBe(false)
  expect(shouldShowFirstRunOAuth(emptyPools, true)).toBe(false)
})

test('generic account login claims an add-account OAuth owner without stealing a specific owner', () => {
  expect(claimOAuthContextForAccountLogin(null)).toBe('add-account')
  expect(claimOAuthContextForAccountLogin('add-account')).toBe('add-account')
  expect(claimOAuthContextForAccountLogin('first-run')).toBe('first-run')
})

test('composer attributes a Claude subscription account only to the active subscription route', () => {
  const subscription = {
    ...emptyAccountsSnapshotForTest(),
    anthropicSubscriptionActive: true,
  }
  expect(shouldShowAnthropicPoolAccount('anthropic', subscription)).toBe(true)
  expect(shouldShowAnthropicPoolAccount('bedrock', subscription)).toBe(false)
  expect(shouldShowAnthropicPoolAccount('vertex', subscription)).toBe(false)
  expect(shouldShowAnthropicPoolAccount('foundry', subscription)).toBe(false)
  expect(
    shouldShowAnthropicPoolAccount('anthropic', {
      ...subscription,
      anthropicSubscriptionActive: false,
    }),
  ).toBe(false)
})

test('renders the shell frame (TabBar + empty state) before any session exists', () => {
  // SSR runs no effects, so the host list never resolves — the shell mounts
  // with an empty roster. The frame is still whole: the TabBar chrome and a
  // new-session affordance are present, and the empty state is the P4-17
  // WelcomeScreen launcher inviting the first session (HC1 — created only via
  // the picker, never a typed path).
  const html = renderToStaticMarkup(<App />)

  expect(html).toContain('role="tablist"')
  expect(html).toContain('aria-label="Sessions"')
  expect(html).toContain('aria-label="New session"')
  expect(html).toContain('Welcome back')
  expect(html).toContain('Open a project')
  // No active-session pane chrome without a session.
  expect(html).not.toContain('aria-label="Prompt"')
  expect(html).not.toContain('Transcript (projected)')
})

test('PL-A wiring tripwire: the startup preload and restore call the parts they claim to', () => {
  // LAYER HONESTY: this is a WIRING tripwire, not behaviour. App owns hooks and
  // effects, and the renderer suite is SSR-only (no DOM — see
  // AccountsPage.test.tsx), so App cannot be mounted and none of these effects
  // can be executed here. It therefore only asserts things source text can
  // actually decide: that a named call site exists, and the exact shape of a
  // nesting. It CANNOT tell whether the effect ever mounts, and the earlier
  // version of this test claimed it could — asserting the two schedulers appear
  // somewhere in the body says nothing about which wraps which. Slices are
  // anchored on CODE, never on a comment: rewording a comment must not break a
  // test, and must not silently widen the slice either.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const preloadStart = source.indexOf(
    'if (!hostSnapshotReady || startupPreloadStartedRef.current) return',
  )
  const preloadEnd = source.indexOf(
    '\n  }, [hostSnapshotReady, queueTranscriptPreload])',
    preloadStart,
  )
  expect(preloadStart).toBeGreaterThan(-1)
  expect(preloadEnd).toBeGreaterThan(preloadStart)
  const preloadBody = source.slice(preloadStart, preloadEnd)
  const admissionStart = source.indexOf('const queueTranscriptPreload = useCallback(')
  const admissionEnd = source.indexOf('\n\n  useEffect(() => {', admissionStart)
  const admissionBody = source.slice(admissionStart, admissionEnd)
  const restoreStart = source.indexOf('const performRestore = useCallback(')
  const restoreEnd = source.indexOf('\n  function submitSession(', restoreStart)
  const restoreBody = source.slice(restoreStart, restoreEnd)

  expect(source).toContain(
    'onRestore={sessionId => void performRestore(sessionId)}',
  )
  // The paint yield is a frame THEN a timer: the exact nesting, not two loose
  // mentions that a reversed pair would satisfy just as well.
  expect(preloadBody).toContain(
    'window.requestAnimationFrame(() => {\n      timer = window.setTimeout(() => {',
  )
  expect(preloadBody).toContain('queueTranscriptPreload(descriptors)')
  expect(preloadBody).not.toContain("dispatchShell({ type: 'preview-open'")
  expect(admissionBody).toContain('preloadQueueRef.current.then(')
  expect(admissionBody).toContain('runStartupTranscriptPreload')
  expect(admissionBody).toContain("type: 'preview-load'")
  // A new cache is a new preview generation, so the handover claim made against
  // the old one is released HERE — this path reaches a fresh preview without
  // `openPreviewPane`. Pinned in source because the reducer-level test can only
  // model the release, never prove this line performs it: drop it and a second
  // generation silently stops handing over, with the whole suite still green.
  expect(admissionBody).toContain('swappedPreviewsRef.current.delete(')
  expect(admissionBody).toContain('preloadReservedBytesRef.current.set(')
  expect(admissionBody).toContain('calculateStartupPreloadCapacity(')
  expect(admissionBody).toContain('maxSessions: remainingSessions')
  expect(admissionBody).toContain('maxProjectedBytes: remainingBytes')

  expect(restoreBody).toContain('openPreloadedPreview(')
  expect(restoreBody).toContain('openPreviewPane(sessionId)')
  expect(restoreBody).toContain('await bridge.previewSession(sessionId)')
  expect(restoreBody).toContain('removedIdsRef.current.has(sessionId)')
  expect(restoreBody).toContain('!descriptor?.restorable')
  expect(restoreBody.indexOf('openPreloadedPreview(')).toBeLessThan(
    restoreBody.indexOf('bridge.previewSession(sessionId)'),
  )
  expect(restoreBody.indexOf('bridge.previewSession(sessionId)')).toBeLessThan(
    restoreBody.indexOf('await restoreLiveSession(sessionId)'),
  )
  expect(source).toContain('event.session.restorable')
  expect(source).toContain(
    'lazyRestoreClaimsRef.current.delete(sessionId)',
  )
  expect(source).toContain(
    "type: 'preview-reset',\n          sessionId: event.appSessionId",
  )
})

test('parked tabs keep their live transcript when a cache is admitted', () => {
  // The renderer suite is SSR-only, so the state matrix is exercised in
  // previewTranscriptState.test.ts. This pins App to that behavioral selector.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('const workspacePanels:')
  const end = source.indexOf('\n  const paletteItems = paletteOpen', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const body = source.slice(start, end)

  expect(body).toContain('const panelTranscript = selectPaneTranscript({')
  expect(body).toContain('previewOpen: shell.previews[sessionId] === true')
  expect(body).toContain('transcript={panelTranscript.transcript}')
  expect(body).toContain(
    'previewTruncationMessage={panelTranscript.truncationMessage}',
  )
})

test('wiring tripwire: the usage popover asks no engine that is not there', () => {
  // The defect this pins (2026-08-05, operator-reported): the context donut is
  // the ONE composer face that renders with no engine behind it — it reads the
  // cached preview run facts, where every sibling face is blank because its live
  // seam is null. Opening its popover fired a `context-breakdown.request` at a
  // session the supervisor does not have, main answered `session_not_found`, and
  // `reduceConnectionState` maps that code to `dead` — so a previewed session's
  // pane raised "This session is no longer available" over a perfectly good
  // cached transcript, and any prompt parked in the composer was released.
  //
  // LAYER HONESTY: the renderer suite is SSR-only, so no popover can be opened
  // and no handler fired. This asserts the CALL SITE gate, which is the thing
  // that was missing. The slice is anchored on code, never on a comment.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

  const gateStart = source.indexOf('onRequestContextBreakdown={')
  // Anchored on the NEXT prop, not on `slashCatalog` further down: the donut's
  // Compact row was later wired in between the two, so the wider anchor silently
  // grew this slice over a second prop and armed the negative assertions below
  // against code they were never written to police.
  const gateEnd = source.indexOf('onCompact={', gateStart)
  expect(gateStart).toBeGreaterThan(-1)
  expect(gateEnd).toBeGreaterThan(gateStart)
  const gateBody = source.slice(gateStart, gateEnd)

  // Both halves: a cache-only pane, and a pane with no engine behind it.
  //
  // The second half must ask `connectionHasEngine`, NOT `isTerminalConnectionStatus`
  // (2026-08-05, CC-28). Those two agreed on every status until idle-park added
  // `'parked'`, which is deliberately non-terminal — its composer stays open and
  // its prompt is held — while having no process at all. A terminal test would
  // therefore have re-opened this exact defect on the one state that most looks
  // fine, so the gate is pinned to the question it actually means.
  expect(gateBody).toContain('panelTranscript.preview')
  expect(gateBody).toContain('!connectionHasEngine(sessionConnection.status)')
  expect(gateBody).not.toContain('isTerminalConnectionStatus')
  expect(gateBody).toContain('? undefined')
  expect(gateBody).toContain('contextBreakdownVerb(sessionId')
})

test('wiring tripwire: the usage range toggle asks no session anything', () => {
  // SECOND INSTANCE of the defect pinned by the context-breakdown tripwire
  // above (2026-08-16, operator-reported): a view control fired a session-scoped
  // request under an `if (activeSessionId)` guard, which tests that an id EXISTS
  // and not that its session is LIVE. The Accounts page is an unconditional
  // sidebar item reachable with no sidecar at all, so a remembered id sailed
  // through, main answered `session_not_found`, and because the preload mints a
  // requestId for `stats.query` the error came back CORRELATED — so the user got
  // a toast naming a raw session id (itself a §7 violation) and
  // `reduceConnectionState` moved that session to `dead`.
  //
  // There is nothing to fetch: the host `usage-stats` event fills BOTH ranges in
  // one worker run and the store holds both. A liveness check would not have
  // fixed this — the session can die between the check and the send — so the
  // gate is the absence of the call, which is what this pins.
  //
  // LAYER HONESTY: the renderer suite is SSR-only, so no toggle can be clicked.
  // This asserts the call site.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('  const handleStatsRangeChange = useCallback')
  expect(start).toBeGreaterThan(-1)

  // Comments are STRIPPED first, exactly as the park-policy tripwire below
  // learned to do: the explanatory comment on this very handler names both
  // `queryStats` and `activeSessionId`, so asserting on the raw slice would fail
  // on the prose while the code was fine, and any later rewrite of the prose
  // would silently disarm it.
  const body = source
    .slice(start, source.indexOf('\n  }, [', start))
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

  expect(body).toContain('set-stats-range')
  expect(body).not.toContain('queryStats')
  expect(body).not.toContain('activeSessionId')
})

test('wiring tripwire: the park policy is told which panes are on screen', () => {
  // IDLE-PARK §4(b) — main cannot derive this (workspace panels are renderer
  // state and switching panes bumps no registry stamp), so if this effect stops
  // reporting, sessions silently become parkable while the user is reading them
  // and nothing else in the suite notices. SSR cannot run the effect, so the
  // wiring is pinned as source.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('  const reportedVisibleRef = useRef')
  expect(start).toBeGreaterThan(-1)
  // Comments are STRIPPED before asserting. The first version of this test
  // checked for `activeView === 'chat'`, which the explanatory comment directly
  // above the code also contains — so replacing the real condition with `true`
  // left every assertion green. A tripwire that cannot fail is worse than none.
  const body = source
    .slice(start, source.indexOf('\n  }, [', start))
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

  // The visible set is the workspace panels, not the tab bar: every live session
  // has a tab, so reporting tabs would exempt every possible park victim.
  expect(body).toContain('for (const panel of workspaceLayout.panels)')
  expect(body).toContain('visible.add(panel.sessionId)')
  // Panes only exist under the chat view; a non-chat page protects nothing.
  expect(body).toContain("if (activeView === 'chat') {")
  expect(body).toContain('getBridge().reportVisibleSessions(sessionIds)')
  // The dedupe key is recorded only AFTER a delivered send, so a call throttled
  // by the preload's shared rate guard retries instead of pinning main to a
  // stale set.
  const sendIndex = body.indexOf('reportVisibleSessions(sessionIds)')
  const recordIndex = body.indexOf('reportedVisibleRef.current = key')
  expect(recordIndex).toBeGreaterThan(sendIndex)
})

test('P4-29 wiring tripwire: the ⋯ menu Open verb restores instead of focusing a dead pane', () => {
  // The defect this pins: `sessionActions.ts` labels a non-live registry row
  // "Restore", but the menu's handler ran `selectTab(targetId)` — pure UI focus
  // that never touches the frame stream — so clicking Restore re-focused a stale
  // pane. Every OTHER open path branched on `live`. The routing now lives in one
  // pure function (`resolveSessionOpenRoute`, covered behaviourally in
  // sessionsCatalogState.test.ts) and both call sites go through it.
  //
  // LAYER HONESTY: same limits as the PL-A tripwire above — the renderer suite is
  // SSR-only, so this asserts the CALL SITE, which is exactly what regressed. The
  // slice is anchored on code, never on a comment.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

  const menuStart = source.indexOf('<SessionActionsMenu')
  const menuEnd = source.indexOf('onClose={() => setSessionActionsTarget(null)}', menuStart)
  expect(menuStart).toBeGreaterThan(-1)
  expect(menuEnd).toBeGreaterThan(menuStart)
  const menuBody = source.slice(menuStart, menuEnd)

  expect(menuBody).toContain("else if (kind === 'open') openCatalogRow(targetRow)")
  // The regression itself: a bare focus must not be how Open is handled.
  expect(menuBody).not.toContain("kind === 'open') selectTab(")

  // The Sessions-page row click resolves through the same one decision, so the
  // two entry points cannot drift apart again.
  expect(source).toContain('onOpenRow={openCatalogRow}')
  const routeStart = source.indexOf('const openCatalogRow = useCallback(')
  const routeEnd = source.indexOf('\n  function submitSession(', routeStart)
  expect(routeStart).toBeGreaterThan(-1)
  const routeBody = source.slice(routeStart, routeEnd)
  expect(routeBody).toContain('resolveSessionOpenRoute(row)')
  // The dispatch itself moved into `applyOpenRoute` when the Welcome launcher
  // became a third caller (P4-40); the regression it pins is unchanged, so the
  // assertion follows the code rather than being dropped.
  const applyStart = source.indexOf('const applyOpenRoute = useCallback(')
  expect(applyStart).toBeGreaterThan(-1)
  const applyBody = source.slice(applyStart, routeStart)
  expect(applyBody).toContain("route.kind === 'restore'")
  expect(applyBody).toContain('void performRestore(route.appSessionId)')
})

test('P4-40 wiring tripwire: a Welcome recent with no app id reaches the history route', () => {
  // The defect this pins: the launcher opened a recent by `appSessionId` alone,
  // and a project whose sessions were ALL created in the terminal carries none —
  // so its click hit an early return in this file and vanished. Deleting the
  // disabled rendering without this wiring produces a row that looks live and
  // does nothing, which is why the guard and the route land together.
  //
  // LAYER HONESTY: SSR-only suite, so this asserts the CALL SITE (the P4-29
  // tripwire's precedent above). The route decision itself is covered
  // behaviourally in sessionsCatalogState.test.ts.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

  // The prop is the shared handler, not an inline id-only branch.
  expect(source).toContain('onOpenRecent={openRecentWorkspace}')
  expect(source).not.toContain('if (recent.appSessionId == null) return')

  const recentStart = source.indexOf('const openRecentWorkspace = useCallback(')
  expect(recentStart).toBeGreaterThan(-1)
  const recentEnd = source.indexOf('\n  function submitSession(', recentStart)
  const recentBody = source.slice(recentStart, recentEnd)
  expect(recentBody).toContain('applyOpenRoute(resolveRecentOpenRoute(recent))')

  // HC1: the history hop passes the engine id only. A recent that handed a cwd
  // across the boundary would be a baseline violation, not a shortcut.
  const applyStart = source.indexOf('const applyOpenRoute = useCallback(')
  const applyEnd = source.indexOf('const openCatalogRow = useCallback(', applyStart)
  const applyBody = source.slice(applyStart, applyEnd)
  expect(applyBody).toContain('void openHistorySession(route.engineSessionId)')
})

test('P4-29 wiring tripwire: the Sessions-page one-shots are disarmed when the page unmounts', () => {
  // The defect this pins: `sessionsRenameRequest` and `sessionsTagEcho` are
  // one-shot COMMANDS whose de-dupe guard is a ref inside SessionsPage — and
  // that ref dies when the page unmounts, which happens whenever the user
  // leaves the Sessions view. A command left set is re-delivered on the next
  // visit: Escape out of a rename, open a session, come back, and the editor
  // reopens by itself. The guard therefore has to live in App, above the mount.
  //
  // LAYER HONESTY: SSR-only suite, so this asserts the disarm EXISTS and is
  // keyed on leaving the view. The reopen itself is an operator GUI step.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

  const disarmStart = source.indexOf("if (activeView === 'sessions') return")
  expect(disarmStart).toBeGreaterThan(-1)
  const disarmEnd = source.indexOf('}, [activeView])', disarmStart)
  expect(disarmEnd).toBeGreaterThan(disarmStart)
  const disarmBody = source.slice(disarmStart, disarmEnd)
  expect(disarmBody).toContain('setSessionsRenameRequest(null)')
  expect(disarmBody).toContain('setSessionsTagEcho(null)')

  // A bulk tag settles several results in one effect pass; they must be batched
  // into ONE echo. A per-result setter keeps only the last while marking them
  // all consumed, so the other rows silently lose their tag.
  const echoStart = source.indexOf('const pendingTagWritesRef = useRef<')
  const echoEnd = source.indexOf('}, [sessionActionRuntime, toast])', echoStart)
  expect(echoStart).toBeGreaterThan(-1)
  const echoBody = source.slice(echoStart, echoEnd)
  expect(echoBody).toContain('entries.push(pending)')
  expect(echoBody).toContain('if (entries.length > 0) setSessionsTagEcho({ entries })')
  expect(echoBody).not.toContain('setSessionsTagEcho({ sessionIds:')
})

test('P4-24: the active session pane renders the multi-line composer + transcript spine', () => {
  const html = renderToStaticMarkup(
    <SessionPane
      accountsSnapshot={null}
      accountsLastResult={null}
      orchestratorActive={false}
      activeConnection={{ status: 'ready', inputEnabled: true }}
      activeDescriptor={{
        appSessionId: 'session-1',
        engineSessionId: 'engine-1',
        cwd: '/tmp/project',
        title: null,
        titleUpdatedAt: null,
        status: 'ready',
        restorable: false,
        parked: false,
        createdAt: 0,
        lastAttachedAt: 0,
        lastMessageSentAt: null,
      }}
      activeLog={{
        inputEnabled: true,
        messages: [],
        retainedBytes: 0,
        truncated: false,
        error: null,
        messageBytes: [],
      }}
      activeAccount={null}
      activeSessionId="session-1"
      isActivePane={true}
      branch={null}
      allowPermission={() => {}}
      model={null}
      reasoningEffort={null}
      fastMode={false}
      copyForLlm={() => {}}
      denyPermission={() => {}}
      history={[]}
      mentionItems={[]}
      onApprovePlan={() => {}}
      onPaste={() => {}}
      onRemovePaste={() => {}}
      onRevisePlan={() => {}}
      partialCount={0}
      pastes={[]}
      // A REAL context: the mode chip renders only once the pane has been told
      // the mode, so leaving this null would make the chip assertion below pass
      // vacuously by never rendering the row it checks.
      permissionContext={{
        mode: 'default',
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: true,
        additionalWorkingDirectories: [],
        ruleMetadata: [],
        managedRulesOnly: false,
        permissionClassifierEnabled: false,
      }}
      permissionQueue={[]}
      planReview={null}
      askQuestion={null}
      onAnswerQuestions={() => {}}
      onCancelQuestions={() => {}}
      prompt=""
      releasePendingSubmit={() => {}}
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )

  expect(html).toContain('aria-label="Prompt"')
  // P4-24: the composer is a multi-line auto-growing field, not the old
  // single-line <input>. It is a contentEditable rather than a <textarea> so a
  // collapsed paste renders as an inline pill at its token.
  expect(html).not.toContain('<textarea')
  expect(composerField(html)).toContain('contentEditable="true"')
  expect(composerField(html)).toContain('aria-multiline="true"')
  // P4-24 reflow: "Copy for LLM" is a developer affordance, now DEV-gated
  // (mirrors the raw-events panel) — absent from a default/production pane.
  expect(html).not.toContain('Copy for LLM')
  // P4-24: permission mode is now a compact chip in the composer actions row
  // (Chat.jsx:302 `PermChip`), not a "Permissions" <details> box.
  expect(html).toContain('Permission mode:')
  // P4-24 reflow: the transcript is the primary surface, ABOVE the docked
  // composer (Chat.jsx grammar: read above, type below) — the composer is no
  // longer pinned to the top of the pane.
  expect(html.indexOf('<section')).toBeLessThan(
    html.indexOf('aria-label="Composer"'),
  )
  // P4-24: the scaffold <h1>Transcript</h1> heading is dropped (full-bleed).
  expect(html).not.toContain('Transcript</h1>')
  // Idle (inputEnabled) session mounts no activity indicator at all, and the
  // send slot holds Send rather than Stop.
  expect(html).not.toContain('Working')
  expect(html).not.toContain('aria-label="Stop the turn"')
  // P4-24: the raw-SDKMessage inspector is hidden by default (opt-in dev flag),
  // absent under `bun test`. With the Permissions <details> box now a chip, a
  // clean idle pane has NO disclosure box at all.
  expect(html).not.toContain('Raw SDKMessage events')
  expect(html).not.toContain('<details')
  expect(html).not.toContain('<pre')
  // P4-24 kept NO debug cwd HEADER on the pane. With an empty transcript the pane
  // now renders the in-session WelcomeScreen (Chat.jsx:1272 renders the same
  // WelcomeScreen when `isEmpty`), whose read-only Project column surfaces the
  // session's fixed cwd as context (HC1 — not an interactive picker). That
  // Welcome is the sole cwd surface here, not a debug header.
  expect(html).toContain('Welcome back')
  expect(html).toContain('/tmp/project')
  // P4-24: the composer is borderless (Chat.jsx:1407) with a pink send-ARROW
  // icon button, not a bordered box with a labelled "Send" button. The field
  // carries no box of its own: no border, no background, no focus ring (the
  // focus rule under the row is the only focus signal).
  expect(composerField(html)).not.toMatch(/class="[^"]*\b(border|bg)-/)
  expect(composerField(html)).toContain('outline-none')
  expect(html).toContain('aria-label="Send prompt"')
})

test('CC-16: a preview pane paints cached rows and its composer accepts typing', () => {
  const html = renderToStaticMarkup(
    <SessionPane
      accountsSnapshot={null}
      accountsLastResult={null}
      orchestratorActive={false}
      activeConnection={{ status: 'ready', inputEnabled: true }}
      activeDescriptor={{
        appSessionId: 'session-1',
        engineSessionId: 'engine-1',
        cwd: '/tmp/project',
        title: null,
        titleUpdatedAt: null,
        status: 'exited',
        restorable: true,
        parked: false,
        createdAt: 0,
        lastAttachedAt: 0,
        lastMessageSentAt: null,
      }}
      activeLog={{
        inputEnabled: true,
        messages: [],
        retainedBytes: 0,
        truncated: false,
        error: null,
        messageBytes: [],
      }}
      activeAccount={null}
      activeSessionId="session-1"
      isActivePane={true}
      branch={null}
      allowPermission={() => {}}
      model={null}
      reasoningEffort={null}
      fastMode={false}
      copyForLlm={() => {}}
      denyPermission={() => {}}
      history={[]}
      mentionItems={[]}
      onApprovePlan={() => {}}
      onPaste={() => {}}
      onPreviewEngage={() => {}}
      onRemovePaste={() => {}}
      onRevisePlan={() => {}}
      partialCount={0}
      pastes={[]}
      permissionContext={null}
      permissionQueue={[]}
      planReview={null}
      askQuestion={null}
      onAnswerQuestions={() => {}}
      onCancelQuestions={() => {}}
      preview
      previewTruncationMessage="Earlier restored history was omitted."
      prompt=""
      releasePendingSubmit={() => {}}
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )

  const field = composerField(html)
  // CC-16 — the composer no longer refuses keystrokes or instructs the user to
  // act. Focus/pointer-down still fires the spawn (`engagePreviewPane`); it
  // just stops blocking the typing that triggers it.
  expect(field).not.toContain('aria-readonly="true"')
  expect(field).not.toContain('aria-disabled="true"')
  expect(field).toContain(
    'aria-placeholder="Ask Cat Code anything or describe a task…"',
  )
  expect(field).not.toContain('Focus to reconnect')
  expect(field).not.toContain('Connecting')
  expect(html).toContain('Earlier restored history was omitted.')
  // The send arrow is still quiet for an EMPTY draft (prototype parity,
  // `Chat.jsx:1419` — `disabled={!input.trim()}`).
  expect(html).toContain('aria-label="Send prompt"')
  expect(html).toContain('disabled=""')
})

test('CC-16: a connecting session accepts typing and can arm the send arrow', () => {
  const props = {
    accountsSnapshot: null,
    accountsLastResult: null,
    orchestratorActive: false,
    activeConnection: { status: 'connecting', inputEnabled: false },
    activeDescriptor: undefined,
    activeLog: {
      inputEnabled: false,
      messages: [],
      retainedBytes: 0,
      truncated: false,
      error: null,
      messageBytes: [],
    },
    activeAccount: null,
    activeSessionId: 'session-1',
    isActivePane: true,
    branch: null,
    allowPermission: () => {},
    model: null,
    reasoningEffort: null,
    fastMode: false,
    copyForLlm: () => {},
    denyPermission: () => {},
    history: [],
    mentionItems: [],
    onApprovePlan: () => {},
    onPaste: () => {},
    onRemovePaste: () => {},
    onRevisePlan: () => {},
    partialCount: 0,
    pastes: [],
    permissionContext: null,
    permissionQueue: [],
    planReview: null,
    askQuestion: null,
    onAnswerQuestions: () => {},
    onCancelQuestions: () => {},
    prompt: '',
    releasePendingSubmit: () => {},
    restorePermission: () => {},
    setPermissionMode: () => {},
    setPrompt: () => {},
    submit: () => {},
    transcript: createTranscriptState(),
    transportError: null,
  } satisfies ComponentProps<typeof SessionPane>
  const html = renderToStaticMarkup(<SessionPane {...props} />)
  const field = composerField(html)

  // The ~0.6 s spawn is hidden behind the typing, not announced.
  expect(field).not.toContain('aria-readonly="true"')
  expect(field).not.toContain('aria-disabled="true"')
  expect(field).toContain(
    'aria-placeholder="Ask Cat Code anything or describe a task…"',
  )

  // With a draft in hand the send arrow is live, so Enter/click can issue the
  // submit that App parks until the engine is ready.
  const typed = renderToStaticMarkup(
    <SessionPane {...props} prompt="ship it" />,
  )
  const sendButton =
    typed.match(/<button[^>]*aria-label="Send prompt"[^>]*>/)?.[0] ?? ''
  expect(sendButton).not.toContain('disabled=""')
  // …and the attach affordance (a purely local draft action) is live too.
  const attachButton =
    typed.match(/<button[^>]*aria-label="Add attachment"[^>]*>/)?.[0] ?? ''
  expect(attachButton).not.toContain('disabled=""')
})

test('a mid-turn composer stays typeable: the turn gates the SEND, not the input', () => {
  // `ready` + `inputEnabled: false` is a turn running. The engine takes one
  // turn at a time, but the terminal REPL has always accepted input mid-turn
  // and run it at the turn boundary; the desktop composer now matches, parking
  // the submit instead of refusing the keystroke.
  const props = {
    accountsSnapshot: null,
    accountsLastResult: null,
    orchestratorActive: false,
    activeConnection: { status: 'ready', inputEnabled: false },
    activeDescriptor: undefined,
    activeLog: {
      inputEnabled: true,
      messages: [],
      retainedBytes: 0,
      truncated: false,
      error: null,
      messageBytes: [],
    },
    activeAccount: null,
    activeSessionId: 'session-1',
    isActivePane: true,
    branch: null,
    allowPermission: () => {},
    model: null,
    reasoningEffort: null,
    fastMode: false,
    copyForLlm: () => {},
    denyPermission: () => {},
    history: [],
    mentionItems: [],
    onApprovePlan: () => {},
    onPaste: () => {},
    onRemovePaste: () => {},
    onRevisePlan: () => {},
    partialCount: 0,
    pastes: [],
    permissionContext: null,
    permissionQueue: [],
    planReview: null,
    askQuestion: null,
    onAnswerQuestions: () => {},
    onCancelQuestions: () => {},
    prompt: 'mid-turn text',
    releasePendingSubmit: () => {},
    restorePermission: () => {},
    setPermissionMode: () => {},
    setPrompt: () => {},
    submit: () => {},
    transcript: createTranscriptState(),
    transportError: null,
  } satisfies ComponentProps<typeof SessionPane>
  const html = renderToStaticMarkup(<SessionPane {...props} />)
  const field = composerField(html)
  const sendButton =
    html.match(/<button[^>]*aria-label="Send prompt"[^>]*>/)?.[0] ?? ''

  expect(field).not.toContain('aria-readonly="true"')
  expect(field).not.toContain('aria-disabled="true"')
  expect(field).toContain(
    'aria-placeholder="Ask Cat Code anything or describe a task…"',
  )
  // The send slot still holds Stop mid-turn (prototype `isGenerating ? Stop :
  // Send`), so Enter is the submit path here — App parks what it submits.
  expect(sendButton).toBe('')
  expect(html).toContain('aria-label="Stop the turn"')
})

test('a cold-spawn prompt announces its wait, while a park restore stays silent', () => {
  const base = idleSessionPaneProps()
  const coldSpawnPending = {
    text: 'run the tests',
    showQueuedRow: true,
  }

  // The spawn wait is what the row exists for.
  const spawning = renderToStaticMarkup(
    <SessionPane
      {...base}
      activeConnection={{ status: 'connecting', inputEnabled: false }}
      activeLog={{ ...base.activeLog, inputEnabled: false }}
      pendingSubmit={coldSpawnPending}
    />,
  )
  expect(spawning).toContain('run the tests')
  expect(spawning).toContain('Sends when the session is ready.')

  // A previewed pane is waiting on its spawn even though a turn may be running
  // behind it, so it gets the same copy.
  const preview = renderToStaticMarkup(
    <SessionPane
      {...base}
      preview
      activeConnection={{ status: 'ready', inputEnabled: false }}
      pendingSubmit={coldSpawnPending}
    />,
  )
  expect(preview).toContain('Sends when the session is ready.')

  // The row must never promise a wait for the response again. A mid-turn submit
  // is not parked at all now: it is sent, and the engine drains it into the
  // running turn, so this copy would be a lie in every state that can show it.
  const midTurn = renderToStaticMarkup(
    <SessionPane
      {...base}
      activeConnection={{ status: 'ready', inputEnabled: false }}
      pendingSubmit={coldSpawnPending}
    />,
  )
  expect(midTurn).not.toContain('Sends when this response finishes.')

  const parkRestorePending = {
    text: 'resume without machinery',
    showQueuedRow: false,
  }
  for (const status of ['parked', 'connecting'] as const) {
    const restoring = renderToStaticMarkup(
      <SessionPane
        {...base}
        activeConnection={{ status, inputEnabled: false }}
        activeLog={{ ...base.activeLog, inputEnabled: false }}
        pendingSubmit={parkRestorePending}
      />,
    )
    expect(restoring).not.toContain('Queued')
    expect(restoring).not.toContain('resume without machinery')
    const sendButton =
      restoring.match(/<button[^>]*aria-label="Send prompt"[^>]*>/)?.[0] ?? ''
    expect(sendButton).toContain('disabled=""')
  }
})

test('D1a: a message waiting for the running response shows above the composer', () => {
  // Sending during a response used to drop the message straight into the
  // transcript, which reads as "the model has this" when it does not. It waits
  // above the composer instead, the way the terminal has always shown it.
  const base = idleSessionPaneProps()

  const idle = renderToStaticMarkup(<SessionPane {...base} />)
  expect(idle).not.toContain('Queued')

  const waiting = renderToStaticMarkup(
    <SessionPane
      {...base}
      activeConnection={{ status: 'ready', inputEnabled: false }}
      activeLog={{ ...base.activeLog, inputEnabled: false }}
      queuedPrompts={[
        { id: 'q-1', text: 'and check the logs too' },
        { id: 'q-2', text: '' },
      ]}
    />,
  )
  expect(waiting).toContain('and check the logs too')
  expect(waiting).toContain('Queued')
  // An image-only message has no text to show, and says so the same way the
  // cold-spawn row does rather than rendering an empty line.
  expect(waiting).toContain('Image attachment')
  // No second explanation: the cold-spawn row's promise is about a session that
  // is not ready yet, which is not what is happening here.
  expect(waiting).not.toContain('Sends when the session is ready.')
})

test('D1b: a waiting message offers a way to take it back', () => {
  // The terminal has `↑` for this. A multi-line composer has no such key free,
  // so the affordance is a real control next to what it acts on.
  const base = idleSessionPaneProps()

  expect(renderToStaticMarkup(<SessionPane {...base} />)).not.toContain(
    'Take back',
  )

  const one = renderToStaticMarkup(
    <SessionPane
      {...base}
      activeConnection={{ status: 'ready', inputEnabled: false }}
      activeLog={{ ...base.activeLog, inputEnabled: false }}
      queuedPrompts={[{ id: 'q-1', text: 'and check the logs too' }]}
      onRecallQueuedPrompts={() => {}}
    />,
  )
  expect(one).toContain('>Take back<')
  // A button, so it is reachable from the keyboard on the way to the composer.
  expect(one).toContain('type="button"')

  // Recall takes back everything waiting, the way `↑` does, so the label says so
  // rather than letting one row's control look like it speaks for itself.
  const several = renderToStaticMarkup(
    <SessionPane
      {...base}
      activeConnection={{ status: 'ready', inputEnabled: false }}
      activeLog={{ ...base.activeLog, inputEnabled: false }}
      queuedPrompts={[
        { id: 'q-1', text: 'and check the logs too' },
        { id: 'q-2', text: 'and the config' },
      ]}
      onRecallQueuedPrompts={() => {}}
    />,
  )
  expect(several).toContain('>Take back all<')
})

test('D1a: several waiting messages are announced once, not once each', () => {
  // `role="status"` sat on every row, so three messages waiting made a screen
  // reader read three separate announcements for one change.
  const base = idleSessionPaneProps()
  const midTurn = {
    activeConnection: { status: 'ready', inputEnabled: false } as const,
    activeLog: { ...base.activeLog, inputEnabled: false },
  }
  const quiet = renderToStaticMarkup(<SessionPane {...base} {...midTurn} />)
  const waiting = renderToStaticMarkup(
    <SessionPane
      {...base}
      {...midTurn}
      queuedPrompts={[
        { id: 'q-1', text: 'one' },
        { id: 'q-2', text: 'two' },
        { id: 'q-3', text: 'three' },
      ]}
      onRecallQueuedPrompts={() => {}}
    />,
  )
  const count = (html: string) => (html.match(/role="status"/g) ?? []).length

  expect(count(waiting) - count(quiet)).toBe(1)
})

test('the waiting-message row is written once and used at both call sites', () => {
  // The cold-spawn park row and the D1a staged row were the same markup typed
  // twice: same label, same classes, same image fallback, free to drift apart.
  // SSR proves each row still renders (the two tests above); only source can
  // say they come from one place.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

  expect(source.match(/'Image attachment'/g) ?? []).toHaveLength(1)
  expect(source.match(/<QueuedRow/g) ?? []).toHaveLength(2)
})

test('CC-16: a dead session stays read-only and does not pretend to be typeable', () => {
  const props = {
    accountsSnapshot: null,
    accountsLastResult: null,
    orchestratorActive: false,
    activeConnection: { status: 'failed', inputEnabled: false },
    activeDescriptor: undefined,
    activeLog: {
      inputEnabled: false,
      messages: [],
      retainedBytes: 0,
      truncated: false,
      error: null,
      messageBytes: [],
    },
    activeAccount: null,
    activeSessionId: 'session-1',
    isActivePane: true,
    branch: null,
    allowPermission: () => {},
    model: null,
    reasoningEffort: null,
    fastMode: false,
    copyForLlm: () => {},
    denyPermission: () => {},
    history: [],
    mentionItems: [],
    onApprovePlan: () => {},
    onPaste: () => {},
    onRemovePaste: () => {},
    onRevisePlan: () => {},
    partialCount: 0,
    pastes: [],
    permissionContext: null,
    permissionQueue: [],
    planReview: null,
    askQuestion: null,
    onAnswerQuestions: () => {},
    onCancelQuestions: () => {},
    prompt: 'text',
    releasePendingSubmit: () => {},
    restorePermission: () => {},
    setPermissionMode: () => {},
    setPrompt: () => {},
    submit: () => {},
    transcript: createTranscriptState(),
    transportError: null,
  } satisfies ComponentProps<typeof SessionPane>
  const html = renderToStaticMarkup(<SessionPane {...props} />)
  const field = composerField(html)
  const sendButton =
    html.match(/<button[^>]*aria-label="Send prompt"[^>]*>/)?.[0] ?? ''

  expect(field).toContain('aria-readonly="true"')
  expect(sendButton).toContain('disabled=""')
})

test('composer read-only and placeholder decisions cover every session state', () => {
  const base = idleSessionPaneProps()
  const ordinaryPlaceholder = 'Ask Cat Code anything or describe a task…'
  const cases: Array<{
    name: string
    props: ComponentProps<typeof SessionPane>
    readOnly: boolean
    disabled: boolean
    placeholder: string
  }> = [
    {
      name: 'ordinary ready',
      props: base,
      readOnly: false,
      disabled: false,
      placeholder: ordinaryPlaceholder,
    },
    {
      name: 'ready mid-turn',
      props: {
        ...base,
        activeConnection: { status: 'ready', inputEnabled: false },
      },
      readOnly: false,
      disabled: false,
      placeholder: ordinaryPlaceholder,
    },
    {
      name: 'connecting',
      props: {
        ...base,
        activeConnection: { status: 'connecting', inputEnabled: false },
        activeLog: { ...base.activeLog, inputEnabled: false },
      },
      readOnly: false,
      disabled: false,
      placeholder: ordinaryPlaceholder,
    },
    {
      name: 'terminal',
      props: {
        ...base,
        activeConnection: { status: 'failed', inputEnabled: false },
        activeLog: { ...base.activeLog, inputEnabled: false },
      },
      readOnly: true,
      disabled: false,
      placeholder: 'Connecting…',
    },
    {
      name: 'preview',
      props: {
        ...base,
        preview: true,
      },
      readOnly: false,
      disabled: false,
      placeholder: ordinaryPlaceholder,
    },
    {
      name: 'no session',
      props: {
        ...base,
        activeSessionId: null,
        activeConnection: { status: 'connecting', inputEnabled: false },
        activeLog: { ...base.activeLog, inputEnabled: false },
      },
      readOnly: true,
      disabled: true,
      placeholder: 'Connecting…',
    },
  ]

  for (const state of cases) {
    const html = renderToStaticMarkup(<SessionPane {...state.props} />)
    const field = composerField(html)

    expect({
      name: state.name,
      readOnly: field.includes('aria-readonly="true"'),
      disabled: field.includes('aria-disabled="true"'),
      placeholder: field.match(/aria-placeholder="([^"]*)"/)?.[1] ?? '',
    }).toEqual({
      name: state.name,
      readOnly: state.readOnly,
      disabled: state.disabled,
      placeholder: state.placeholder,
    })
  }
})

test('CC-16 wiring tripwire: submit parks and the drain flushes/releases through App', () => {
  // LAYER HONESTY: the app/ renderer suite is SSR-only (no DOM — see
  // AccountsPage.test.tsx), so React effects never run here and the drain
  // cannot be executed. The DECISIONS it is built from are executable and
  // covered in composerState.test.ts; this pins the App-side join those pure
  // functions are wired into, and fails if a refactor unhooks one of them.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const submitStart = source.indexOf('  function submitSession(')
  const submitBody = source.slice(
    submitStart,
    source.indexOf('\n  }', source.indexOf('// CC-16 drain', submitStart)),
  )

  // The submit decision is the pure one, not a re-derived local condition.
  expect(submitBody).toContain('const action = planSessionSubmit({')
  expect(submitBody).toContain(
    'alreadyParked: selectPendingSubmit(pendingSubmits, sessionId) !== null,',
  )
  // Park, and retire the draft exactly like a real send (so nothing is left
  // half-submitted), then return WITHOUT touching the bridge.
  expect(submitBody).toContain(
    "if (action.type === 'hold') {\n      setPendingSubmits(prev =>\n        reducePendingSubmitHeld(prev, sessionId, {\n          text,\n          images,\n          showQueuedRow: action.showQueuedRow,\n        }),\n      )\n      retireDraft()",
  )
  // The drain rides the EXISTING app.submit — no new frame kind or channel.
  expect(submitBody).toContain(
    'const outcome = resolvePendingSubmit(selectConnection(connection, sessionId))',
  )
  expect(submitBody).toContain("if (outcome === 'wait') continue")
  expect(submitBody).toContain("if (outcome === 'release') {\n        releasePendingSubmit(sessionId)")
  expect(submitBody).toContain(
    'buildSubmitPrompt(pending.text, pending.images ?? [])',
  )
  // IDLE-PARK (CC-28) — the arm that makes a reclaimed engine invisible. Nothing
  // is spawning and no turn will end for a parked session, so without this the
  // held prompt would wait forever. It is pinned here for the same reason as its
  // siblings: this effect cannot be executed by an SSR suite, so unhooking
  // `restoreParkedSession` would otherwise go green everywhere.
  expect(submitBody).toContain(
    "if (outcome === 'restore') {\n        restoreParkedSession(sessionId)",
  )

  // A failed spawn releases the parked text back into the composer on every
  // terminal restore path, not only on the connection status.
  const restoreBody = source.slice(
    source.indexOf('  const restoreLiveSession = useCallback('),
    source.indexOf('  const engagePreview = useCallback('),
  )
  expect(restoreBody.match(/releasePendingSubmit\(sessionId\)/g)).toHaveLength(3)

  // The composer's three consumers all read the SAME gate object, so
  // "typeable" can never drift apart from "sendable" again.
  expect(source).toContain('const composerReadOnly = !composerGate.editable')
  expect(source).toContain('readOnly={composerReadOnly}')
  // Whitespace-normalised: the assertion is about which gate the send button
  // reads, not how deeply it happens to be indented. It broke once when the
  // button moved inside the send/stop ternary without its logic changing.
  expect(source.replace(/\s+/g, ' ')).toContain(
    'disabled={ !composerGate.editable || preparingImage || (prompt.trim().length === 0 && images.length === 0) || pendingSubmit !== null }',
  )
  expect(source).toContain(
    'attachDisabled={!composerGate.editable || preparingImage}',
  )
  expect(source.replace(/\s+/g, ' ')).toContain(
    "if (preparingImage) { event.preventDefault() toast('Wait for the image to finish attaching.', { tone: 'info' }) return }",
  )
  expect(source.replace(/\s+/g, ' ')).toContain(
    "if (!onAttachImage || imagePreparationInFlightRef.current) { if (imagePreparationInFlightRef.current) { toast('Wait for the image to finish attaching.', { tone: 'info' }) } return } imagePreparationInFlightRef.current = true",
  )
  expect(source.replace(/\s+/g, ' ')).toContain(
    "const unsupportedImage = files.find(file => file.type.startsWith('image/')) if (unsupportedImage) { void attachImage(unsupportedImage) return }",
  )
  // …and nothing instructs the user to act on a not-yet-connected session.
  expect(source).not.toContain('Focus to reconnect')
})

test('P4-24: the composer bar forwards the REAL active account + model override', () => {
  // Live-path assertion through the SessionPane boundary: a real account alias
  // and a real per-session model override reach the ChipStrip bar (not shape-only).
  const account: AccountStatus = {
    id: 'acct-1',
    alias: 'hiby',
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Available',
    isDefault: true,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: 10,
    usageWeekly: 20,
    usageLimitReached: false,
    usageResetAt: null,
    lastRefreshIso: null,
    lastError: null,
    planType: null,
    switchable: false,
  }
  const html = renderToStaticMarkup(
    <SessionPane
      activeConnection={{ status: 'ready', inputEnabled: true }}
      activeDescriptor={undefined}
      activeLog={{
        inputEnabled: true,
        messages: [],
        retainedBytes: 0,
        truncated: false,
        error: null,
        messageBytes: [],
      }}
      accountsSnapshot={null}
      accountsLastResult={null}
      activeAccount={account}
      activeSessionId="session-1"
      isActivePane={true}
      branch={null}
      allowPermission={() => {}}
      model="gpt-5.6-terra"
      reasoningEffort="high"
      fastMode={false}
      orchestratorActive={false}
      copyForLlm={() => {}}
      denyPermission={() => {}}
      history={[]}
      mentionItems={[]}
      onApprovePlan={() => {}}
      onPaste={() => {}}
      onRemovePaste={() => {}}
      onRevisePlan={() => {}}
      partialCount={0}
      pastes={[]}
      permissionContext={null}
      permissionQueue={[]}
      planReview={null}
      askQuestion={null}
      onAnswerQuestions={() => {}}
      onCancelQuestions={() => {}}
      prompt=""
      releasePendingSubmit={() => {}}
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )
  expect(html).toContain('hiby')
  expect(html).toContain('Active account: hiby')
  expect(html).toContain('gpt-5.6-terra')
})

test('P4-18c: a generating session (ready + input disabled) shows the activity indicator', () => {
  const html = renderToStaticMarkup(
    <SessionPane
      accountsSnapshot={null}
      accountsLastResult={null}
      orchestratorActive={false}
      activeConnection={{ status: 'ready', inputEnabled: false }}
      activeDescriptor={{
        appSessionId: 'session-1',
        engineSessionId: 'engine-1',
        cwd: '/tmp/project',
        title: null,
        titleUpdatedAt: null,
        status: 'ready',
        restorable: false,
        parked: false,
        createdAt: 0,
        lastAttachedAt: 0,
        lastMessageSentAt: null,
      }}
      activeLog={{
        inputEnabled: false,
        messages: [],
        retainedBytes: 0,
        truncated: false,
        error: null,
        messageBytes: [],
      }}
      activeAccount={null}
      activeSessionId="session-1"
      isActivePane={true}
      branch={null}
      allowPermission={() => {}}
      model={null}
      reasoningEffort={null}
      fastMode={false}
      copyForLlm={() => {}}
      denyPermission={() => {}}
      history={[]}
      mentionItems={[]}
      onApprovePlan={() => {}}
      onPaste={() => {}}
      onRemovePaste={() => {}}
      onRevisePlan={() => {}}
      partialCount={0}
      pastes={[]}
      permissionContext={null}
      permissionQueue={[]}
      planReview={null}
      askQuestion={null}
      onAnswerQuestions={() => {}}
      onCancelQuestions={() => {}}
      prompt=""
      releasePendingSubmit={() => {}}
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )

  expect(html).toContain('Working') // derived verb (empty transcript tail)
  // The activity row carries no control; the send slot holds Stop instead
  // (Chat.jsx:1413-1423). Escape alone is NOT sufficient — it is bound on the
  // composer form, so it reaches nothing once focus leaves the textarea, and a
  // focused permission card consumes it as that card's dismiss.
  expect(html).not.toContain('■ Stop')
  expect(html).toContain('aria-label="Stop the turn"')
  expect(html).not.toContain('aria-label="Send prompt"')
  // No fill and no seam on the row: it reads as a byline over the pane, not a
  // band between the transcript and the composer.
  // Scoped to the activity row itself: a bare `not.toContain('border-shell-seam')`
  // passes or fails on unrelated chrome, and matching the exact class run passes
  // as soon as someone reorders it.
  const activityRow = html.match(/<div class="[^"]*gap-2\.5[^"]*text-xs"/)?.[0] ?? ''
  expect(activityRow).not.toBe('')
  expect(activityRow).not.toContain('border-b')
})

// ── P4-18c activity helpers ─────────────────────────────────────────────────

function blockRow(
  extra: Partial<NestedTranscriptRow> & { kind: NestedTranscriptRow['kind'] },
): NestedTranscriptRow {
  return {
    id: 's:m:0:x',
    sessionId: 's',
    messageId: 'm',
    frameId: 'f',
    blockIndex: 0,
    parentToolUseId: null,
    children: [],
    ...extra,
  } as NestedTranscriptRow
}

test('P4-18c deriveActivity: pending tool → Running <tool>, thinking → Thinking, streaming → Responding', () => {
  expect(deriveActivity([])).toEqual({ verb: 'Working', target: null })
  // A pending tool is now reported only INSIDE an operator turn. Unscoped, an
  // aborted turn's tool-use row stays `pending` forever and would pin the verb
  // to it for the rest of the session, so this case grew a `user-text` row —
  // which every real turn has, since the sidecar echoes the prompt back
  // (`sidecarServer.ts:1067`). Turn-scoping and the parallel-tool scan live in
  // `appModelActivity.test.ts`, projected from real messages.
  expect(
    deriveActivity([
      blockRow({
        kind: 'user-text',
        role: 'user',
        content: 'run it',
        isReplay: false,
      }),
      blockRow({
        kind: 'tool-use',
        toolUseId: 'u',
        toolName: 'Bash',
        toolFamily: 'bash',
        input: {},
        status: 'pending',
        result: null,
      }),
    ]),
  ).toEqual({ verb: 'Running', target: 'Bash' })
  expect(
    deriveActivity([blockRow({ kind: 'thinking', content: 'hmm' })]),
  ).toEqual({ verb: 'Thinking', target: null })
  expect(
    deriveActivity([
      blockRow({
        kind: 'assistant-text',
        role: 'assistant',
        content: 'partial',
        isStreaming: true,
      }),
    ]),
  ).toEqual({ verb: 'Responding', target: null })
})

test('P4-18c fmtElapsed formats seconds and minutes', () => {
  expect(fmtElapsed(0)).toBe('0s')
  expect(fmtElapsed(5200)).toBe('5s')
  expect(fmtElapsed(65_000)).toBe('1m 05s')
})

test('P4-18 fmtTok: raw below 1k, N.Nk to 100k, Nk above (matches Chat.jsx:134)', () => {
  expect(fmtTok(0)).toBe('0')
  expect(fmtTok(999)).toBe('999')
  expect(fmtTok(1000)).toBe('1k')
  expect(fmtTok(1200)).toBe('1.2k')
  expect(fmtTok(120_000)).toBe('120k')
})

test('P4-18 selectLiveTokenEstimate with no usage on the wire: output ÷ 4; prior turns excluded; no boundary → 0', () => {
  // The character half of the hybrid, in isolation: no raw messages means no
  // reported usage, so every message falls through to the estimate. The joined
  // behaviour is covered in `appModelTokens.test.ts`.
  //
  // No user boundary present → 0, so a retained transcript never leaks as a
  // huge count (fail to "no estimate", never to a wrong large number).
  expect(
    selectLiveTokenEstimate(
      [blockRow({ kind: 'assistant-text', role: 'assistant', content: 'x'.repeat(80) })],
      [],
    ),
  ).toBe(0)

  const rows: NestedTranscriptRow[] = [
    blockRow({ kind: 'user-text' }),
    // Prior turn's reply — MUST be excluded (it precedes the last boundary).
    blockRow({ kind: 'assistant-text', role: 'assistant', content: 'p'.repeat(400) }),
    blockRow({ kind: 'user-text' }), // ← current turn starts here
    blockRow({
      kind: 'assistant-text',
      role: 'assistant',
      content: 'a'.repeat(38),
      isStreaming: true,
    }),
    blockRow({
      kind: 'tool-use',
      toolUseId: 'u',
      toolName: 'Bash',
      toolFamily: 'bash',
      input: {}, // JSON.stringify({}) → "{}" = 2 chars
      status: 'pending',
      result: null,
    }),
  ]
  // (38 + 2) / 4 = 10; the 400-char prior reply does not count.
  expect(selectLiveTokenEstimate(rows, [])).toBe(10)
})

test('composer form owns the ↑/↓ history key scope', () => {
  const html = renderToStaticMarkup(
    <SessionPane
      accountsSnapshot={null}
      accountsLastResult={null}
      orchestratorActive={false}
      activeConnection={{ status: 'ready', inputEnabled: true }}
      activeDescriptor={{
        appSessionId: 'session-1',
        engineSessionId: 'engine-1',
        cwd: '/tmp/project',
        title: null,
        titleUpdatedAt: null,
        status: 'ready',
        restorable: false,
        parked: false,
        createdAt: 0,
        lastAttachedAt: 0,
        lastMessageSentAt: null,
      }}
      activeLog={{
        inputEnabled: true,
        messages: [],
        retainedBytes: 0,
        truncated: false,
        error: null,
        messageBytes: [],
      }}
      activeAccount={null}
      activeSessionId="session-1"
      isActivePane={true}
      branch={null}
      allowPermission={() => {}}
      model={null}
      reasoningEffort={null}
      fastMode={false}
      copyForLlm={() => {}}
      denyPermission={() => {}}
      history={['first prompt', 'second prompt']}
      mentionItems={[]}
      onApprovePlan={() => {}}
      onPaste={() => {}}
      onRemovePaste={() => {}}
      onRevisePlan={() => {}}
      partialCount={0}
      pastes={[]}
      permissionContext={null}
      permissionQueue={[]}
      planReview={null}
      askQuestion={null}
      onAnswerQuestions={() => {}}
      onCancelQuestions={() => {}}
      prompt=""
      releasePendingSubmit={() => {}}
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )

  expect(html).toContain('aria-label="Composer"')
  expect(html).toContain('aria-keyshortcuts="ArrowUp ArrowDown"')
})

test('collapsed pastes are rendered by the field, not parked in a strip above it', () => {
  const html = renderToStaticMarkup(
    <SessionPane
      accountsSnapshot={null}
      accountsLastResult={null}
      orchestratorActive={false}
      activeConnection={{ status: 'ready', inputEnabled: true }}
      activeDescriptor={{
        appSessionId: 'session-1',
        engineSessionId: 'engine-1',
        cwd: '/tmp/project',
        title: null,
        titleUpdatedAt: null,
        status: 'ready',
        restorable: false,
        parked: false,
        createdAt: 0,
        lastAttachedAt: 0,
        lastMessageSentAt: null,
      }}
      activeLog={{
        inputEnabled: true,
        messages: [],
        retainedBytes: 0,
        truncated: false,
        error: null,
        messageBytes: [],
      }}
      activeAccount={null}
      activeSessionId="session-1"
      isActivePane={true}
      branch={null}
      allowPermission={() => {}}
      model={null}
      reasoningEffort={null}
      fastMode={false}
      copyForLlm={() => {}}
      denyPermission={() => {}}
      history={[]}
      mentionItems={[]}
      onApprovePlan={() => {}}
      onPaste={() => {}}
      onRemovePaste={() => {}}
      onRevisePlan={() => {}}
      partialCount={0}
      pastes={[{ id: 1, content: 'line A\nline B\nline C', numLines: 2 }]}
      permissionContext={null}
      permissionQueue={[]}
      planReview={null}
      askQuestion={null}
      onAnswerQuestions={() => {}}
      onCancelQuestions={() => {}}
      prompt="see [Pasted text #1 +2 lines]"
      releasePendingSubmit={() => {}}
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )

  // The pill lives INLINE in the field, where its token sits (prototype
  // `Chat.jsx:1060-1097`) — there is no out-of-band strip above the composer
  // any more, and the raw token is never shown as literal text.
  expect(html).not.toContain('aria-label="Collapsed pastes"')
  expect(html).not.toContain('[Pasted text #1 +2 lines]')
  // The field's content is built imperatively from the draft (`composerDom`),
  // so a static render is empty: the pill's own shape is covered by
  // `composerDom.test.ts` and its behaviour needs the live app.
  expect(composerField(html)).toContain('contentEditable="true"')
  // The attachment control stays labelled beside the inline paste affordance.
  // Its file-picker and image-submit wiring are pinned in the App source test.
  expect(html).toContain('aria-label="Add attachment"')
})

test('image attachment wiring reaches both clipboard paste and the file picker', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

  expect(source).toContain('const files = Array.from(event.clipboardData.files)')
  expect(source).toContain('const image = files.find')
  expect(source).toContain("if (image) {\n      void attachImage(image)")
  expect(source).toContain('ref={imageInputRef}')
  expect(source).toContain('if (file) void attachImage(file)')
  expect(source).toContain(
    'onAttach={() => imageInputRef.current?.click()}',
  )
  expect(source).toContain(
    'reduceImageAttachmentAdded(prev, sessionId, attachment)',
  )
})

test('debug export explicitly marks lossy raw-message retention', () => {
  const text = buildDebugExport([], {
    inputEnabled: true,
    messages: [{ type: 'result', subtype: 'success' }],
    retainedBytes: 42,
    truncated: true,
    error: null,
    messageBytes: [42],
  })

  expect(text).toContain('Raw retention: TRUNCATED')
  expect(text).toContain('"type": "result"')
})

test('renders a restart control only for a terminal session state', () => {
  const render = (status: ConnectionSnapshot['status']) =>
    renderToStaticMarkup(
      <ConnectionRecovery
        connection={{ status, inputEnabled: status === 'ready' }}
        sessionId="session-1"
      />,
    )

  // Transient — the spawn is still in flight. `starting` comes from the one
  // retryable send-failure code, so a red bar inviting a restart would be a
  // lie about a session that is merely slow to come up.
  for (const status of ['connecting', 'starting', 'ready'] as const) {
    expect(render(status)).not.toContain('Restart')
  }

  // Terminal — the session will not come back on its own, and the bar states
  // what happened in a sentence instead of printing the engine's discriminant
  // at the user ("Session dead.", the copy this replaced).
  for (const status of ['dead', 'disconnected', 'failed', 'exited'] as const) {
    const markup = render(status)
    expect(markup).toContain('Restart')
    expect(markup).not.toContain(`Session ${status}.`)
    expect(markup).toContain('This session')
  }

  // No session at all: nothing to restart.
  const noSession = renderToStaticMarkup(
    <ConnectionRecovery
      connection={{ status: 'dead', inputEnabled: false }}
      sessionId={null}
    />,
  )
  expect(noSession).not.toContain('Restart')
})

test('permission bridge failures are returned to the caller for reducer recovery', () => {
  const error = sendPermissionResponse(
    {
      respondPermission() {
        throw new Error('renderer IPC rate limit exceeded')
      },
    },
    'session-1',
    'perm-1',
    { behavior: 'allow', updatedInput: {} },
  )

  expect(error).toBe('renderer IPC rate limit exceeded')
})

test('prompt drafts are isolated by active session id', () => {
  let drafts = reducePromptDrafts({}, 'session-a', 'draft for A')
  drafts = reducePromptDrafts(drafts, 'session-b', 'draft for B')

  expect(selectPromptDraft(drafts, 'session-a')).toBe('draft for A')
  expect(selectPromptDraft(drafts, 'session-b')).toBe('draft for B')
  expect(selectPromptDraft(drafts, null)).toBe('')
})

/**
 * The preview rail, end to end through the real pane.
 *
 * The derivation is tested in `previewTranscriptState.test.ts` and the mode
 * face in `PermissionModeChip.test.tsx`; what neither covers is the WIRING —
 * that a preview pane actually routes those facts to the composer rail instead
 * of the empty live seams. Without this, the whole fix could be inert and both
 * unit suites would still be green.
 */
test('a previewed pane shows what the cached session really ran on', () => {
  const props = {
    accountsSnapshot: null,
    accountsLastResult: null,
    orchestratorActive: false,
    activeConnection: { status: 'dead', inputEnabled: false },
    activeDescriptor: undefined,
    activeLog: {
      inputEnabled: false,
      messages: [],
      retainedBytes: 0,
      truncated: false,
      error: null,
      messageBytes: [],
    },
    activeAccount: null,
    activeSessionId: 'session-preview',
    isActivePane: true,
    branch: null,
    allowPermission: () => {},
    // The LIVE seams are all empty, exactly as they are with no sidecar.
    model: null,
    reasoningEffort: null,
    fastMode: false,
    permissionContext: null,
    preview: true,
    previewRunFacts: {
      model: 'gpt-5.6-terra',
      effort: 'xhigh',
      permissionMode: 'acceptEdits',
      contextUsage: {
        usedTokens: 42_000,
        contextWindow: 200_000,
        percentUsed: 21,
      },
    },
    copyForLlm: () => {},
    denyPermission: () => {},
    history: [],
    mentionItems: [],
    onApprovePlan: () => {},
    onPaste: () => {},
    onRemovePaste: () => {},
    onRevisePlan: () => {},
    partialCount: 0,
    pastes: [],
    permissionQueue: [],
    planReview: null,
    askQuestion: null,
    onAnswerQuestions: () => {},
    onCancelQuestions: () => {},
    prompt: '',
    releasePendingSubmit: () => {},
    restorePermission: () => {},
    setPermissionMode: () => {},
    setPrompt: () => {},
    submit: () => {},
    transcript: createTranscriptState(),
    transportError: null,
  } satisfies ComponentProps<typeof SessionPane>

  const html = renderToStaticMarkup(<SessionPane {...props} />)
  expect(html).toContain('gpt-5.6-terra')
  expect(html).toContain('Extra high') // xhigh's display label
  expect(html).toContain('Accept edits')
  expect(html).toContain('21%')
})

/**
 * The other half of honest: with nothing cached, the rail says nothing rather
 * than falling back to placeholders or a 0% donut.
 */
test('a previewed pane with an empty cache claims nothing', () => {
  const props = {
    accountsSnapshot: null,
    accountsLastResult: null,
    orchestratorActive: false,
    activeConnection: { status: 'dead', inputEnabled: false },
    activeDescriptor: undefined,
    activeLog: {
      inputEnabled: false,
      messages: [],
      retainedBytes: 0,
      truncated: false,
      error: null,
      messageBytes: [],
    },
    activeAccount: null,
    activeSessionId: 'session-preview',
    isActivePane: true,
    branch: null,
    allowPermission: () => {},
    model: null,
    reasoningEffort: null,
    fastMode: false,
    permissionContext: null,
    preview: true,
    previewRunFacts: {
      model: null,
      effort: null,
      permissionMode: null,
      contextUsage: null,
    },
    copyForLlm: () => {},
    denyPermission: () => {},
    history: [],
    mentionItems: [],
    onApprovePlan: () => {},
    onPaste: () => {},
    onRemovePaste: () => {},
    onRevisePlan: () => {},
    partialCount: 0,
    pastes: [],
    permissionQueue: [],
    planReview: null,
    askQuestion: null,
    onAnswerQuestions: () => {},
    onCancelQuestions: () => {},
    prompt: '',
    releasePendingSubmit: () => {},
    restorePermission: () => {},
    setPermissionMode: () => {},
    setPrompt: () => {},
    submit: () => {},
    transcript: createTranscriptState(),
    transportError: null,
  } satisfies ComponentProps<typeof SessionPane>

  const html = renderToStaticMarkup(<SessionPane {...props} />)
  expect(html).not.toContain('Permission mode:')
  expect(html).not.toContain('0%')
})

/* ------------------------------------------------------------------------- *
 * 2026-07-28 repair wave — FIX-5
 * ------------------------------------------------------------------------- */

/** A minimal live, idle session pane. Spread and override the one field a test
 *  is about, so a prop added to SessionPane fails compilation once, here. */
function idleSessionPaneProps(): ComponentProps<typeof SessionPane> {
  return {
    accountsSnapshot: null,
    accountsLastResult: null,
    orchestratorActive: false,
    activeConnection: { status: 'ready', inputEnabled: true },
    activeDescriptor: undefined,
    activeLog: {
      inputEnabled: true,
      messages: [],
      retainedBytes: 0,
      truncated: false,
      error: null,
      messageBytes: [],
    },
    activeAccount: null,
    activeSessionId: 'session-1',
    isActivePane: true,
    branch: null,
    allowPermission: () => {},
    model: null,
    reasoningEffort: null,
    fastMode: false,
    copyForLlm: () => {},
    denyPermission: () => {},
    history: [],
    mentionItems: [],
    onApprovePlan: () => {},
    onPaste: () => {},
    onRemovePaste: () => {},
    onRevisePlan: () => {},
    partialCount: 0,
    pastes: [],
    permissionContext: null,
    permissionQueue: [],
    planReview: null,
    askQuestion: null,
    onAnswerQuestions: () => {},
    onCancelQuestions: () => {},
    prompt: '',
    releasePendingSubmit: () => {},
    restorePermission: () => {},
    setPermissionMode: () => {},
    setPrompt: () => {},
    submit: () => {},
    transcript: createTranscriptState(),
    transportError: null,
  } satisfies ComponentProps<typeof SessionPane>
}

/* ── P4-32a: the footer strip carries worker attention (ruling P1) ──────────── */

function tasksSnapshotForTest(
  items: Array<
    Partial<TaskSnapshotItem> & { id: string; type: TaskSnapshotItem['type'] }
  >,
): TasksSnapshot {
  return {
    items: items.map(item => ({
      status: 'running' as const,
      label: item.id,
      startTime: 0,
      ...item,
    })),
  }
}

function agentWorkerForTest(
  over: Partial<AgentModeWorkerItem> = {},
): AgentModeWorkerItem {
  return {
    agentId: 'w-1',
    handle: 'Turing',
    role: 'agent-mode-coding-worker',
    status: 'running',
    description: 'Port the roster',
    ...over,
  }
}

function renderStrip(
  props: Partial<ComponentProps<typeof TasksStrip>> = {},
): string {
  return renderToStaticMarkup(
    <TasksStrip snapshot={null} workers={[]} onOpen={() => {}} {...props} />,
  )
}

test('P4-32a — an idle session with no workers still renders no strip', () => {
  expect(renderStrip()).toBe('')
})

test('P4-32a — a busy swarm reads as a neutral accent count, never an alert', () => {
  // D2 C2: workers waiting on the assistant are the assistant's problem.
  const html = renderStrip({
    workers: [
      agentWorkerForTest(),
      agentWorkerForTest({
        agentId: 'w-2',
        status: 'completed',
        handoffStatus: 'blocked',
      }),
    ],
  })
  expect(html).toContain('2 subagents active')
  expect(html).not.toContain('tone-warn')
})

test('P4-32a — a blocked worker never turns the strip amber', () => {
  // It used to read "1 needs you" whenever this session was not in agent mode,
  // which is every ordinary session. The handoff goes to the assistant.
  const html = renderStrip({
    workers: [agentWorkerForTest({ status: 'completed', handoffStatus: 'blocked' })],
  })
  expect(html).toContain('1 subagent active')
  expect(html).not.toContain('needs you')
  expect(html).not.toContain('tone-warn')
})

test('P4-32a — the same delegated worker is never counted twice across the two feeds', () => {
  // A backgrounded `local_agent` appears in BOTH tasks.snapshot and the worker
  // list; the task half must therefore count only non-worker task types.
  const html = renderStrip({
    snapshot: tasksSnapshotForTest([
      { id: 'w-1', type: 'local_agent' },
      { id: 'sh-1', type: 'local_bash' },
    ]),
    workers: [agentWorkerForTest()],
  })
  expect(html).toContain('1 subagent active')
  expect(html).toContain('1 background task')
  expect(html).not.toContain('2 background')
})

test('P4-32a — a plain background task keeps the original strip wording', () => {
  const html = renderStrip({
    snapshot: tasksSnapshotForTest([
      { id: 'sh-1', type: 'local_bash' },
      { id: 'sh-2', type: 'local_bash' },
    ]),
  })
  expect(html).toContain('2 background tasks')
  expect(html).not.toContain('subagent')
})

test('P4-32a — real workers reach the composer dock, above the permission stack', () => {
  // The live path, not the component in isolation: SessionPane must actually mount
  // the roster inside the composer column, or the wiring is invisible.
  const html = renderToStaticMarkup(
    <SessionPane
      {...idleSessionPaneProps()}
      orchestratorActive
      orchestratorWorkers={[
        agentWorkerForTest({ handle: 'Turing', description: 'Wire the dock' }),
      ]}
    />,
  )
  expect(html).toContain('Turing')
  expect(html).toContain('Wire the dock')
  const dockIndex = html.indexOf('max-w-[var(--transcript-width)] shrink-0')
  expect(dockIndex).toBeGreaterThan(-1)
  expect(html.indexOf('Wire the dock')).toBeGreaterThan(dockIndex)
})

test('P4-32a — a session with no delegated workers leaves the dock untouched', () => {
  const html = renderToStaticMarkup(<SessionPane {...idleSessionPaneProps()} />)
  expect(html).not.toContain('subagents')
})

test('P4-32a — the dock retires settled workers but keeps unresolved ones', () => {
  const settled = renderToStaticMarkup(
    <SessionPane
      {...idleSessionPaneProps()}
      orchestratorWorkers={[
        agentWorkerForTest({
          description: 'Completed worker',
          status: 'completed',
          synthesisStatus: 'synthesized',
        }),
      ]}
    />,
  )
  expect(settled).not.toContain('Completed worker')

  const failed = renderToStaticMarkup(
    <SessionPane
      {...idleSessionPaneProps()}
      orchestratorWorkers={[
        agentWorkerForTest({ description: 'Failed worker', status: 'failed' }),
      ]}
    />,
  )
  expect(failed).toContain('Failed worker')
})

test('P4-32a — WIRING TRIPWIRE (source text, NOT reachability) for the mode joins', () => {
  // Read this for what it is: a source-TEXT assertion. It fires if someone deletes
  // or renames these joins, and it proves NOTHING about whether the handler can be
  // reached at runtime.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

  // The tab bar carries NO orchestrator chrome: a tab names a session, and the
  // mode belongs to the surfaces that own it. Pinned so the badge and its
  // per-tab snapshot read cannot drift back onto the tab.
  const tabsStart = source.indexOf('const tabs: TabModel[] = useMemo(')
  const tabsEnd = source.indexOf('const activeAgentModeSnapshot', tabsStart)
  const tabsBody = source.slice(tabsStart, tabsEnd)
  expect(tabsBody).not.toContain('orchestratorActive:')
  expect(tabsBody).not.toContain('selectAgentModeSnapshot(orchestrator, sessionId)')

  const barStart = source.indexOf('<TabBar')
  const barBody = source.slice(barStart, source.indexOf('/>', barStart))
  expect(barBody).not.toContain('Orchestrator')

  // Each pane docks ITS panel's workers, not the globally-active session's.
  expect(source).toContain('orchestratorWorkers={panelOrchestratorWorkers}')
  expect(source).toContain(
    'const panelOrchestratorWorkers = panelAgentMode?.workers ?? EMPTY_WORKERS',
  )
})

test('a truncated transcript is styled as a warning, with a tone the theme actually defines', () => {
  // `tone-warning` is not a token: theme.css declares --color-tone-warn (and
  // -danger/-good/-success/-info), so Tailwind emitted NOTHING for
  // text-tone-warning / border-tone-warning and the only signal that a
  // transcript is incomplete rendered as ordinary body text.
  const html = renderToStaticMarkup(
    <SessionPane
      {...idleSessionPaneProps()}
      preview
      previewTruncationMessage="Earlier restored history was omitted."
      activeLog={{
        inputEnabled: true,
        messages: [],
        retainedBytes: 0,
        truncated: true,
        error: null,
        messageBytes: [],
      }}
    />,
  )

  expect(html).toContain('Earlier restored history was omitted.')
  expect(html).not.toContain('tone-warning')
  // The trailing delimiters matter: `text-tone-warning` contains `text-tone-warn`,
  // so a bare substring check would pass on the broken class too.
  expect(html).toContain('text-tone-warn"')
  expect(html).toContain('border-tone-warn ')
  // A full raw-message log is internal bookkeeping the user cannot see: the
  // rendered transcript comes from `transcript`, not `activeLog`. The warning
  // that used to sit here announced a loss with no visible content behind it.
  expect(html).not.toContain('Raw message history')
})

test('the autoscroll signature tracks the RENDERED transcript, not the capped raw log', () => {
  // `activeLog` is bounded by DEFAULT_MAX_RAW_MESSAGES. Deriving the signature
  // from it meant that, past the cap, `messages.length` pinned and any message
  // that did not also move `partialCount` produced an identical signature, so
  // the follow-to-bottom effect never re-ran. SSR cannot observe an effect, so
  // this is pinned at the source (the P4-38 / userVisibleText.test.ts precedent).
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('const contentSignature =')
  expect(start).toBeGreaterThan(-1)
  const line = source.slice(start, source.indexOf('\n', start))

  expect(line).not.toContain('activeLog')
  expect(line).toContain('renderedRowCount')
})

test('a cold-spawn prompt is visible, and the send arrow says so', () => {
  // CC-16 parks a prompt submitted before the engine can take it, and clears the
  // composer as if it had been sent. Nothing rendered the parked text, so the
  // message simply vanished; and a second Enter was a silent no-op while the
  // send arrow stayed lit.
  const idle = renderToStaticMarkup(<SessionPane {...idleSessionPaneProps()} />)
  expect(idle).not.toContain('Queued')

  const parked = renderToStaticMarkup(
    <SessionPane
      {...idleSessionPaneProps()}
      prompt="ship it"
      pendingSubmit={{ text: 'run the migration', showQueuedRow: true }}
    />,
  )
  expect(parked).toContain('run the migration')
  expect(parked).toContain('Queued')
  const sendButton =
    parked.match(/<button[^>]*aria-label="Send prompt"[^>]*>/)?.[0] ?? ''
  expect(sendButton).toContain('disabled=""')

  // …and with nothing parked the very same draft still sends.
  const sendable = renderToStaticMarkup(
    <SessionPane {...idleSessionPaneProps()} prompt="ship it" />,
  )
  const liveButton =
    sendable.match(/<button[^>]*aria-label="Send prompt"[^>]*>/)?.[0] ?? ''
  expect(liveButton).not.toContain('disabled=""')
})

/**
 * The composer rail, end to end through the real pane, on a session with NO
 * turns yet.
 *
 * Both 2026-07-29 defects were invisible to the unit suites: the face printed
 * `model.current` (a resolved model id) and the donut divided by the renderer's
 * 200k constant because only a `result` frame ever carried a window, and there
 * is no result frame before the first turn. Each fix could be inert here and
 * `contextUsage.test.ts` + `ComposerActionsBar.test.tsx` would still be green,
 * so this asserts on what the pane actually renders.
 */
function liveRunControls(
  model: string,
  currentLabel: string,
  contextWindow: number,
): RunControlsSnapshot {
  return {
    model: {
      current: model,
      currentLabel,
      contextWindow,
      selected: model,
      provider: model.startsWith('gpt-') ? 'openai' : 'anthropic',
      providerSwitchLocked: false,
      options: [
        {
          value: model,
          label: currentLabel,
          provider: model.startsWith('gpt-') ? 'openai' : 'anthropic',
        },
      ],
    },
    effort: { current: null, selected: null, supported: false, options: [] },
    fast: {
      active: false,
      supportedByModel: false,
      available: false,
      unavailableReason: null,
    },
    autoCompact: { enabled: true, threshold: null, warningThreshold: null },
  }
}

test('a live pane with no turns yet names the selected model and sizes the donut to it', () => {
  const paneFor = (controls: RunControlsSnapshot) =>
    renderToStaticMarkup(
      <SessionPane
        {...idleSessionPaneProps()}
        model={controls.model.current}
        runControls={controls}
        onSetModel={() => {}}
      />,
    )

  const opus = paneFor(liveRunControls('claude-opus-5', 'Opus 5', 1_000_000))
  expect(opus).toContain('Model: Opus 5')
  expect(opus).not.toContain('claude-opus-5')
  expect(opus).toContain(
    `Context: 0 / ${(1_000_000).toLocaleString()} tokens (0% used)`,
  )

  // Switching model re-broadcasts the snapshot, and the donut has to follow it:
  // the reported symptom was 200k for every model, unchanged by any selection.
  const terra = paneFor(liveRunControls('gpt-5.6-terra', 'GPT-5.6 Terra', 372_000))
  expect(terra).toContain('Model: GPT-5.6 Terra')
  expect(terra).toContain(
    `Context: 0 / ${(372_000).toLocaleString()} tokens (0% used)`,
  )
  expect(terra).not.toContain((200_000).toLocaleString())
})

test('FIX-5 keyboard tripwire: the permission shortcuts yield to a focused control and to a dedicated flow', () => {
  // LAYER HONESTY: these defects live in a `document` keydown listener and in
  // focus behaviour. The renderer suite is SSR-only (no DOM — see
  // AccountsPage.test.tsx), so no test in this package can press a key or move
  // focus. This asserts only what source text can decide. The guard itself is an
  // executable predicate (`permissionKeysAreLive`, unit-tested in
  // PermissionPrompt.test.tsx); a DOM harness is still flagged in the report.
  //
  // The listener MOVED into the card (2026-08-07). It was App state plus an App
  // listener, which made a mouse hover over a row re-render the whole shell to
  // move one border. Every guard survived the move, and three became structural
  // rather than conditional — see the doc-comment on the effect.
  const card = readFileSync(
    new URL('./PermissionPrompt.tsx', import.meta.url),
    'utf8',
  )
  const effectStart = card.indexOf('    if (!keyboardTarget) return')
  const effectEnd = card.indexOf(
    "document.addEventListener('keydown', onKeyDown)",
    effectStart,
  )
  expect(effectStart).toBeGreaterThan(-1)
  expect(effectEnd).toBeGreaterThan(effectStart)
  const effectBody = card.slice(effectStart, effectEnd)

  // A tag-name test let Enter on the card's own Deny button bubble to document
  // and be answered as an ALLOW, because preventDefault() suppressed the
  // browser's Enter → click. The guard must cover any control that acts on the
  // key itself, buttons above all.
  expect(effectBody).not.toContain("target.tagName === 'INPUT'")
  expect(effectBody).toContain('if (!permissionKeysAreLive(event.target)) return')
  // One answer per request: the rows are disabled in flight, and the keyboard
  // must not fire a second decision before the resolve lands.
  expect(effectBody).toContain('if (submitted) return')
  // Only the card the shortcuts act on may register a listener at all. This is
  // what replaces App's explicit dedicated-flow and activeView guards: a card
  // that is not the target never attaches, and the card only mounts under chat.
  expect(effectBody).toContain('if (!keyboardTarget) return')

  const model = readFileSync(
    new URL('./permissionPromptModel.ts', import.meta.url),
    'utf8',
  )
  expect(model).toContain('const FOCUSED_KEY_OWNER_SELECTOR =')
  const selectorStart = model.indexOf('const FOCUSED_KEY_OWNER_SELECTOR =')
  const selector = model.slice(selectorStart, model.indexOf('\n\n', selectorStart))
  for (const owner of [
    'button',
    'input',
    'textarea',
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    // Load-bearing for the marker: the card's own section carries this role, so
    // without the host exemption, focusing the card kills every key.
    '[role="alertdialog"]',
  ]) {
    expect(selector).toContain(owner)
  }

  // The card that takes focus, shows a cursor, hosts the keys and now OWNS the
  // listener must be exactly the request App means to answer. One value decides
  // all four, so a card can never claim keys that act on something else.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  expect(source).toContain(
    'const permissionKeyTargetRequestId =\n' +
      '    pendingPermission && !dedicatedFlowOwnsKeyboard\n' +
      '      ? pendingPermission.requestId\n' +
      '      : null',
  )
  const queueStart = source.indexOf('<PermissionQueue')
  const queueBody = source.slice(queueStart, source.indexOf('/>', queueStart))
  expect(queueBody).toContain(
    'keyboardTargetRequestId={permissionKeyTargetRequestId}',
  )
  // Split workspace: one queue per pane, and only the active pane's card may
  // take the keyboard.
  expect(source).toContain(
    'permissionKeyTargetRequestId={\n' +
      '\t              sessionId === activeSessionId\n' +
      '\t                ? permissionKeyTargetRequestId\n' +
      '\t                : null\n' +
      '\t            }',
  )
  // A dedicated flow (AskQuestionFlow / PlanPanel) registers its own `window`
  // listener. Propagation is target → document → window, so a permission
  // listener alive at the same time would let ONE Enter resolve two unrelated
  // requests. It cannot be: the flows null out the target above.
  expect(source).toContain(
    'selectAskQuestion(permissions, activeSessionId) !== null',
  )
  expect(source).toContain(
    'selectPlanReview(permissions, activeSessionId) !== null',
  )
  // App no longer owns permission keys or the cursor; a re-introduced copy here
  // is the two-sources-of-truth bug this move removed. Asserted on the IMPORT
  // and the PROP, not on the bare names, which also appear in prose explaining
  // why the shell chord handler does not collide with the card's Ctrl pair.
  expect(source).not.toContain("from './permissionPromptModel.js'")
  expect(source).not.toContain('setPermissionCursor=')
  expect(source).not.toContain('permissionCursor=')

  // The card is a select list, and BOTH the keys and the rendered rows must come
  // from ONE list. There is now exactly one `buildPermissionOptions` call in the
  // app, in the card, so `1` and a click on row 1 cannot disagree.
  expect(card).toContain('buildPermissionOptions(request.request, denyOnly === true)')
  expect(source).not.toContain('buildPermissionOptions')
  expect(card.split('buildPermissionOptions(').length - 1).toBe(1)

  // One answer per request: a second response is rejected by the sidecar as
  // unknown, and that rejection un-marks the card, re-enabling the rows on an
  // already-decided request.
  const respondStart = source.indexOf('const respondToPermission = useCallback(')
  const respondBody = source.slice(
    respondStart,
    source.indexOf('\n  const allowPermission', respondStart),
  )
  expect(respondBody).toContain(
    'selectPermissionQueue(permissions, sessionId).some(',
  )
  expect(respondBody).toContain('if (answered) return')
  expect(
    respondBody.indexOf('if (answered) return'),
  ).toBeLessThan(respondBody.indexOf('sendPermissionResponse('))
})

test('FIX-5 wiring tripwire: the inspector, the meta strip, the accounts page and the caret read the right source', () => {
  // LAYER HONESTY: each of these lives inside App's render/effect body, which
  // this SSR-only suite cannot mount or feed. Source text can decide which
  // selector a call site reads and whether a prop is passed at all, which is
  // exactly what these four defects were; it cannot prove the resulting UI.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

  // `row.sessionId` holds the engineSessionId once one is assigned, so matching
  // a panel's appSessionId against it missed every ready session and the
  // in-session meta strip read "none" forever.
  expect(source).not.toContain('sessionCatalogRows.find(r => r.sessionId === sessionId)')
  expect(source).toContain('sessionCatalogRows.find(r => r.appSessionId === sessionId)')

  // Without `sessionState` the drawer renders none of the five live panes that
  // the Settings rebuild moved into it.
  const inspectorStart = source.indexOf('<MetadataInspector')
  const inspectorBody = source.slice(
    inspectorStart,
    source.indexOf('/>', inspectorStart),
  )
  expect(inspectorBody).toContain('sessionState={buildSessionInspectorState({')
  expect(inspectorBody).toContain('selectSettingsSnapshot(settings, activeSessionId)')
  expect(inspectorBody).toContain('selectWorkspaceTrustSnapshot(')
  expect(inspectorBody).toContain('selectDiagnosticsSnapshot(diagnostics, activeSessionId)')

  // An account verb with no session open used to return before sending
  // anything, so the page's confirmation dialog waited forever for a result
  // that could never arrive.
  const verbStart = source.indexOf('const sendAccountVerb = useCallback(')
  const verbBody = source.slice(
    verbStart,
    source.indexOf('\n  // The Accounts page reads', verbStart),
  )
  expect(verbBody).not.toContain('if (!activeSessionId) return')
  expect(verbBody).toContain("kind: 'account.result'")
  expect(verbBody).toContain('requestId: verb.requestId')
  expect(verbBody).toContain('ok: false')

  // The Accounts page reads the polled pool, which refreshes on a timer; the
  // post-verb snapshot landed in the per-session map the page no longer reads.
  expect(source).toContain(
    "dispatchAccounts({ type: 'pool', pool: snapshot })",
  )

  // Rebuilding the field's nodes drops the selection, so an at-caret paste and
  // the atomic pill-delete both threw the caret away.
  expect(source).toContain('el.setSelectionRange(caret, caret)')
  expect(source).toContain('pendingCaretRef.current = {')
})

/**
 * The two surfaces that print a session's model must read the LIVE run-controls
 * seam, not the spawn-frozen `diagnostics` snapshot. Reading diagnostics alone
 * made every session that used the model picker report the model it STARTED
 * with: the sidebar subtitle and the inspector's "Resolved model" both sat on
 * the frozen value while the composer face (already on run controls) moved. Both
 * call sites are in App's render body, unreachable from this SSR-only suite;
 * source text can still decide which selector each one reads.
 */
test('the model a session displays comes from the live run-controls seam', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

  // Fixed windows, not brace-matching: an added object literal inside either
  // call site must not truncate the slice into a spurious failure.
  const sidebarStart = source.indexOf('modelForSession={id =>')
  expect(sidebarStart).toBeGreaterThan(-1)
  const sidebarBody = source.slice(sidebarStart, sidebarStart + 400)
  expect(sidebarBody).toContain('selectRunControlsSnapshot(runControls, id)?.model')
  // The engine's display name first, the raw id only when it has none, and the
  // frozen snapshot last.
  expect(sidebarBody).toContain('live?.currentLabel ??')
  expect(sidebarBody.indexOf('live?.currentLabel')).toBeLessThan(
    sidebarBody.indexOf('mainLoopModelForSession'),
  )

  const inspectorStart = source.indexOf('<MetadataInspector')
  expect(inspectorStart).toBeGreaterThan(-1)
  const inspectorBody = source.slice(
    inspectorStart,
    source.indexOf('/>', inspectorStart),
  )
  expect(inspectorBody).toContain('runControls: selectRunControlsSnapshot(')
})

/**
 * Three composer behaviours a contentEditable does NOT inherit from the
 * textarea it replaced. None is reachable from an SSR render: they live in a
 * keydown branch, a DOM listener, and a drop handler. Pinned structurally so a
 * later edit cannot quietly hand any of them back to the browser's default,
 * which is exactly how each one broke the first time.
 */
test('the composer authors newlines, drops, and pill removal itself', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const field = readFileSync(
    new URL('./ComposerInput.tsx', import.meta.url),
    'utf8',
  )

  // (1) A modified Enter writes "\n" into the DRAFT. Left to the browser, a
  // contentEditable answers Alt/Meta+Enter with a block container rather than
  // the <br> the serializer reads, so the line break rendered once and then
  // vanished from the draft.
  const enterBranch = app.slice(app.indexOf("if (event.key === 'Enter') {"))
  expect(enterBranch).toContain('event.shiftKey || event.altKey || event.metaKey')
  expect(enterBranch.slice(0, enterBranch.indexOf('requestSubmit'))).toContain(
    '\\n${prompt.slice(end)}',
  )

  // (2) A pill's remove listener is attached once and survives every keystroke
  // after it, so it must read the CURRENT callback and pastes, never the render
  // that built it. A captured draft would undo everything typed since the paste.
  expect(field).toContain('onRemovePasteRef.current = onRemovePaste')
  expect(field).toContain('pastesRef.current = pastes')
  const removeStart = field.indexOf('onRemove: node =>')
  expect(removeStart).toBeGreaterThan(-1)
  const removeListener = field.slice(removeStart, removeStart + 1200)
  expect(removeListener).toContain('onRemovePasteRef.current(')
  expect(removeListener).toContain('pastesRef.current.find(')

  // (3) A drop is normalized like a paste. The native drop would put links,
  // images, and styled nodes into a field whose draft is a plain string.
  expect(field).toContain('const handleDrop =')
  const dropHandler = field.slice(field.indexOf('const handleDrop ='))
  expect(dropHandler.slice(0, 800)).toContain('event.preventDefault()')
  expect(dropHandler.slice(0, 800)).toContain("event.dataTransfer.getData('text')")
})

test('the composer connects its focused textbox to the active slash or mention option', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  expect(source).toContain('const composerTypeahead = slashOpen')
  expect(source).toContain('listboxId: SLASH_COMMAND_LISTBOX_ID')
  expect(source).toContain('activeOptionId: slashCommandOptionId(slashIndex)')
  expect(source).toContain('listboxId: MENTION_LISTBOX_ID')
  expect(source).toContain('activeOptionId: mentionOptionId(mentionIndex)')
  expect(source).toContain('typeahead={composerTypeahead}')
})

test('SettingsShell receives the active session binding from the merged roster', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  expect(source).toContain(
    'selectSettingsProjectBinding(sessionCatalogRows, activeSessionId)',
  )
  const shellStart = source.indexOf('<SettingsShell')
  expect(shellStart).toBeGreaterThan(-1)
  const shell = source.slice(shellStart, source.indexOf('/>', shellStart))
  expect(shell).toContain('projectBinding={settingsProjectBinding}')
})

test('P4-50: the account-health bar sits above the workspace and cannot gate a send', () => {
  // The ruling's two hard constraints are structural, so they are pinned
  // structurally. (1) ONE bar, mounted as a sibling ABOVE the workspace, not
  // inside a pane: a split view must not stack one copy per transcript. (2)
  // SessionPane owns the composer and every disabled state on it, and is never
  // handed the derivation, so no send can be gated on account health.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const paneStart = source.indexOf('export function SessionPane({')
  expect(paneStart).toBeGreaterThan(-1)
  expect(source.slice(paneStart)).not.toContain('accountHealth')

  const mount = source.indexOf('<BannerStack')
  expect(mount).toBeGreaterThan(-1)
  expect(mount).toBeLessThan(paneStart)
  expect(source.indexOf('<BannerStack', mount + 1)).toBe(-1)
  expect(source.indexOf('<WorkspaceLayout', mount)).toBeGreaterThan(mount)

  // The dismissal is in-memory for the run: #12 deleted the persisted keys.
  expect(source).toContain('setDismissedAccountHealthId(banner.id)')
  expect(source).not.toContain('dismissedReauth')
  expect(source).not.toContain('acknowledgedReauthWall')
})

test('P4-50: a cold start renders no account-health bar', () => {
  // The pool has not reported, so there is nothing surprising to say. This is
  // the healthy-pool half of the GUI check, closed headlessly.
  const html = renderToStaticMarkup(<App />)

  expect(html).not.toContain('aria-label="Notices"')
  expect(html).not.toContain('Codex usage limit reached')
  expect(html).not.toContain('No Codex account is ready to use')
})

test('P4-54: shell lifecycle failures persist until the dismiss control clears them', () => {
  // App cannot be mounted in this SSR-only suite, so this pins only the
  // lifecycle wiring source text can prove: all seven operation paths still
  // replace the current failure, no success path clears it, and the rendered
  // bar owns the sole explicit clear.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const operationsStart = source.indexOf('  const newSession = useCallback(')
  const operationsEnd = source.indexOf('\n  function submitSession(', operationsStart)
  expect(operationsStart).toBeGreaterThan(-1)
  expect(operationsEnd).toBeGreaterThan(operationsStart)
  const operations = source.slice(operationsStart, operationsEnd)

  for (const writer of [
    'const newSession = useCallback(',
    'const newSessionInWorkspace = useCallback(',
    'const closeTab = useCallback(',
    'const restartTab = useCallback(',
    'const restoreLiveSession = useCallback(',
    'const performRestore = useCallback(',
    'const openHistorySession = useCallback(',
  ]) {
    expect(operations).toContain(writer)
  }
  expect(operations).toContain('setShellError(hostErrorMessage(result.error))')
  expect(operations).toContain('setShellError(hostErrorMessage(closeResult.error))')
  expect(operations).toContain('setShellError(errorMessage(error))')
  expect(operations).not.toContain('setShellError(null)')

  expect(source.match(/setShellError\(null\)/g)).toHaveLength(1)
  const shellErrorBarStart = source.indexOf('{shellError ? (')
  const shellErrorBarEnd = source.indexOf('\n        ) : null}', shellErrorBarStart)
  expect(shellErrorBarStart).toBeGreaterThan(-1)
  expect(shellErrorBarEnd).toBeGreaterThan(shellErrorBarStart)
  const shellErrorBar = source.slice(shellErrorBarStart, shellErrorBarEnd)
  expect(shellErrorBar).toContain('aria-label="Dismiss shell error"')
  expect(shellErrorBar).toContain('onClick={() => setShellError(null)}')
})

test('P4-55: initial roster reads and launcher retries share one truthful hydrate path', () => {
  // The async state machine and snapshot/live-event merge are exercised in
  // rosterBootstrap.test.ts. This SSR-only suite pins the App wiring around it:
  // mount and Retry both call one callback, and only its successful snapshot
  // marks the bootstrap ready.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const hydrateStart = source.indexOf('  const hydrateHostRoster = useCallback(')
  const hydrateEnd = source.indexOf(
    '\n\n  // Host control plane:',
    hydrateStart,
  )
  expect(hydrateStart).toBeGreaterThan(-1)
  expect(hydrateEnd).toBeGreaterThan(hydrateStart)
  const hydrateBody = source.slice(hydrateStart, hydrateEnd)

  expect(hydrateBody).toContain(
    'listSessions: () => getBridge().listSessions()',
  )
  expect(hydrateBody).toContain("dispatchRosterBootstrap({ type: 'read-failed' })")
  expect(hydrateBody).toContain("dispatchShell({\n          type: 'hydrate'")
  expect(hydrateBody).toContain(
    "dispatchRosterBootstrap({ type: 'read-succeeded' })",
  )
  expect(source).toContain('void hydrateHostRoster()')
  expect(source).toContain('onRetry: () => void hydrateHostRoster()')
  expect(source).toContain(
    "const hostSnapshotReady = rosterBootstrap.status === 'ready'",
  )
})

test('clean parking releases live transcript projection and raw log from renderer memory', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const hostSubStart = source.indexOf('const unsubscribe = bridge.subscribeHost(event => {')
  expect(hostSubStart).toBeGreaterThan(-1)
  const hostSubEnd = source.indexOf('void hydrateHostRoster()', hostSubStart)
  expect(hostSubEnd).toBeGreaterThan(hostSubStart)
  const hostSubBody = source.slice(hostSubStart, hostSubEnd)

  expect(hostSubBody).toContain("descriptor.status !== 'disconnected'")
  expect(hostSubBody).toContain("dispatch({ type: 'session-removed', sessionId })")
  expect(hostSubBody).toContain("dispatchSessionEvent({ type: 'session-removed', sessionId })")
})

test('each App commit increments the health payload counter before delivery acknowledgements', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const effectStart = source.indexOf('  // Acknowledge UI commitment only after React has committed')
  const effectEnd = source.indexOf('\n  // When each session', effectStart)
  expect(effectStart).toBeGreaterThan(-1)
  expect(effectEnd).toBeGreaterThan(effectStart)
  const effect = source.slice(effectStart, effectEnd)

  expect(effect).toContain('getBridge().recordRenderCommit()')
  expect(effect.indexOf('getBridge().recordRenderCommit()')).toBeLessThan(
    effect.indexOf('pendingDeliveryStateAcksRef.current.splice(0)'),
  )
})


test('D5 wiring tripwire: a refused submit is retained at send and restored from the frame stream', () => {
  // LAYER HONESTY: the renderer suite is SSR-only, so App cannot be mounted, no
  // frame can be delivered and no composer can be refilled. The decision logic
  // lives in `classifySubmitOutcomeFrame` and is exercised in
  // composerState.test.ts; what only source can decide is that the three call
  // sites exist and sit in the order the behaviour depends on. Slices are
  // anchored on CODE, never on a comment.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

  const submitStart = source.indexOf('  function submitSession(')
  const submitEnd = source.indexOf('\n  // CC-16 drain', submitStart)
  expect(submitStart).toBeGreaterThan(-1)
  expect(submitEnd).toBeGreaterThan(submitStart)
  const submitBody = source.slice(submitStart, submitEnd)

  // The whole message is retained, images included — the half `↑` history
  // cannot carry. Retention must happen BEFORE the optimistic clear, or the
  // images it copies are already gone.
  expect(submitBody).toContain('retainedSubmitsRef.current = reduceRetainedSubmitHeld(')
  expect(submitBody).toContain('{ submitId, text, images: [...images] }')
  // The id has to reach the sidecar, or the answer below can never name which
  // submit it belongs to and the pairing silently degrades to positional again.
  expect(submitBody).toContain(
    'getBridge().submit(sessionId, submitPrompt, { submitId })',
  )
  expect(
    submitBody.indexOf('retainedSubmitsRef.current = reduceRetainedSubmitHeld('),
  ).toBeLessThan(submitBody.lastIndexOf('retireDraft()'))

  const subscribeStart = source.indexOf('const unsubscribe = bridge.subscribe(frames => {')
  const subscribeEnd = source.indexOf('bridge.rendererReady()', subscribeStart)
  expect(subscribeStart).toBeGreaterThan(-1)
  expect(subscribeEnd).toBeGreaterThan(subscribeStart)
  const subscribeBody = source.slice(subscribeStart, subscribeEnd)

  // Answers are resolved by id against the whole batch, not inferred frame by
  // frame. The old inference read `settled` off ordinary traffic a submit merely
  // waits through, which retired the wrong copy; pin the batch call so nobody
  // reintroduces a per-frame guess.
  expect(subscribeBody).toContain(
    'const answers = reduceSubmitAnswers(retainedSubmitsRef.current, frames)',
  )
  expect(subscribeBody).toContain('restoreRefusedSubmit(sessionId, retained)')
  // Settling now happens inside the batch reducer, so the property to pin is
  // that its result is written back. Dropping this line would leave every
  // answered submit retained forever, holding its base64 image with it.
  expect(subscribeBody).toContain('retainedSubmitsRef.current = answers.state')

  const restoreStart = source.indexOf('const restoreRefusedSubmit = useCallback(')
  const restoreEnd = source.indexOf('\n  const closeTab = useCallback(', restoreStart)
  expect(restoreStart).toBeGreaterThan(-1)
  expect(restoreEnd).toBeGreaterThan(restoreStart)
  const restoreBody = source.slice(restoreStart, restoreEnd)

  // Text merges under whatever was typed during the round trip; images replace,
  // because only one is ever held.
  expect(restoreBody).toContain('restoreDraftWithPending(')
  expect(restoreBody).toContain('reduceSessionImagesReplaced(state, sessionId, retained.images)')
  // The copy is handed IN rather than looked up, because the batch reducer has
  // already removed it by `submitId`. That is what stops a second frame in the
  // same batch restoring the same copy twice, and it is why this function takes
  // a `RetainedSubmit` instead of reaching into the ref.
  expect(restoreBody).not.toContain('selectRetainedSubmit(')
  expect(source).toContain('const restoreRefusedSubmit = useCallback((\n    sessionId: SessionId,\n    retained: RetainedSubmit,\n  ) => {')

  // And the removal is committed BEFORE anything is restored from it. Reversed,
  // a restore could run against state that still holds the answered copy.
  expect(subscribeBody.indexOf('retainedSubmitsRef.current = answers.state')).toBeLessThan(
    subscribeBody.indexOf('restoreRefusedSubmit(sessionId, retained)'),
  )
})

test('D1b wiring tripwire: only a recall this page asked for is acted on, and its id is always released', () => {
  // LAYER HONESTY: SSR cannot mount App, deliver a frame, or raise a toast. The
  // decisions live in `verbAckErrorToast` / `recallDeliveryFailureNotice` /
  // `forgetRecallRequests` and are exercised in verbAckResultState.test.ts;
  // what only source can decide is that the gate sits in front of BOTH answers
  // to a recall, and that nothing else can announce one.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

  const subscribeStart = source.indexOf(
    'const unsubscribe = bridge.subscribe(frames => {',
  )
  const subscribeEnd = source.indexOf('bridge.rendererReady()', subscribeStart)
  expect(subscribeStart).toBeGreaterThan(-1)
  expect(subscribeEnd).toBeGreaterThan(subscribeStart)
  const subscribeBody = source.slice(subscribeStart, subscribeEnd)

  // One gate in front of the restore AND the toast, because the replay ring
  // re-delivers a result to a page that never asked for it.
  //
  // It is a CLASSIFIER, not a consume-and-forget. The earlier version deleted
  // the id on the first answer, so the sidecar's correction — the frame that
  // tells the user a message it said came back actually reached the model —
  // was dropped on arrival and the whole correction path was dead code. Three
  // dispositions keep it alive: ignore what this page did not mint, restore on
  // the first answer only, and toast a correction without restoring anything.
  expect(subscribeBody).toContain(
    'const disposition = classifyRecallAnswer(',
  )
  expect(subscribeBody).toContain("if (disposition === 'ignore') continue")
  expect(subscribeBody).toContain("if (disposition === 'first') {")
  // The restore is INSIDE the first-answer branch: a correction that restored
  // would hand the user a second copy of a message the model already has.
  expect(
    subscribeBody.indexOf("if (disposition === 'first') {"),
  ).toBeLessThan(subscribeBody.indexOf('restoreRecalledPrompts(frame.sessionId'))
  expect(subscribeBody).toContain('verbAckErrorToast(frame)')
  expect(subscribeBody).toContain('recallDeliveryFailureNotice(frame)')

  // …and the ungated verb-ack toast must not announce a recall behind its back.
  const toastStart = source.indexOf('const toastedVerbAckRequestsRef =')
  const toastEnd = source.indexOf('const focusWorkspacePanelSession', toastStart)
  expect(toastStart).toBeGreaterThan(-1)
  expect(toastEnd).toBeGreaterThan(toastStart)
  expect(source.slice(toastStart, toastEnd)).toContain(
    "if (result.kind === 'prompt-recall.result') return",
  )

  // A session that goes away never answers, so its ids are released with it.
  expect(source.match(/forgetRecallRequests\(recallRequestsRef\.current,/g) ?? []).toHaveLength(2)
})
