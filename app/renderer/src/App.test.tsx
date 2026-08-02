import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import {
  App,
  ConnectionRecovery,
  SessionPane,
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
  RunControlsSnapshot,
} from '../../shared/protocol.js'

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
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )

  expect(html).toContain('aria-label="Prompt"')
  // P4-24: the composer is a multi-line auto-resizing <textarea>, not the old
  // single-line <input>.
  expect(html).toContain('<textarea')
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
  // Idle (inputEnabled) session shows no activity indicator / Stop control.
  expect(html).not.toContain('■ Stop')
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
  // icon button, not a bordered box with a labelled "Send" button.
  expect(html).toContain('bg-transparent')
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
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )

  const textarea = html.match(/<textarea[^>]*aria-label="Prompt"[^>]*>/)?.[0] ?? ''
  // CC-16 — the composer no longer refuses keystrokes or instructs the user to
  // act. Focus/pointer-down still fires the spawn (`engagePreviewPane`); it
  // just stops blocking the typing that triggers it.
  expect(textarea).not.toContain('readOnly=""')
  expect(textarea).not.toContain('disabled=""')
  expect(textarea).toContain(
    'placeholder="Ask Cat Code anything or describe a task…"',
  )
  expect(textarea).not.toContain('Focus to reconnect')
  expect(textarea).not.toContain('Connecting')
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
    restorePermission: () => {},
    setPermissionMode: () => {},
    setPrompt: () => {},
    submit: () => {},
    transcript: createTranscriptState(),
    transportError: null,
  } satisfies ComponentProps<typeof SessionPane>
  const html = renderToStaticMarkup(<SessionPane {...props} />)
  const textarea = html.match(/<textarea[^>]*aria-label="Prompt"[^>]*>/)?.[0] ?? ''

  // The ~0.6 s spawn is hidden behind the typing, not announced.
  expect(textarea).not.toContain('readOnly=""')
  expect(textarea).not.toContain('disabled=""')
  expect(textarea).toContain(
    'placeholder="Ask Cat Code anything or describe a task…"',
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

test('CC-16 REGRESSION GUARD: a mid-turn composer is still blocked — the engine owns that', () => {
  // `ready` + `inputEnabled: false` is the engine's own "input is closed" (a
  // turn is running). CC-16 unblocked "not connected yet"; widening it into
  // this state is the regression this test exists to catch.
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
    restorePermission: () => {},
    setPermissionMode: () => {},
    setPrompt: () => {},
    submit: () => {},
    transcript: createTranscriptState(),
    transportError: null,
  } satisfies ComponentProps<typeof SessionPane>
  const html = renderToStaticMarkup(<SessionPane {...props} />)
  const textarea = html.match(/<textarea[^>]*aria-label="Prompt"[^>]*>/)?.[0] ?? ''
  const sendButton =
    html.match(/<button[^>]*aria-label="Send prompt"[^>]*>/)?.[0] ?? ''

  expect(textarea).toContain('readOnly=""')
  expect(textarea).toContain(
    'placeholder="Input is unavailable until the current response finishes."',
  )
  // Non-empty draft, yet the arrow stays disabled: the engine, not the draft,
  // is what refuses this submit.
  expect(sendButton).toContain('disabled=""')
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
    restorePermission: () => {},
    setPermissionMode: () => {},
    setPrompt: () => {},
    submit: () => {},
    transcript: createTranscriptState(),
    transportError: null,
  } satisfies ComponentProps<typeof SessionPane>
  const html = renderToStaticMarkup(<SessionPane {...props} />)
  const textarea = html.match(/<textarea[^>]*aria-label="Prompt"[^>]*>/)?.[0] ?? ''
  const sendButton =
    html.match(/<button[^>]*aria-label="Send prompt"[^>]*>/)?.[0] ?? ''

  expect(textarea).toContain('readOnly=""')
  expect(sendButton).toContain('disabled=""')
})

test('P4-58: composer read-only and placeholder decisions cover every session state', () => {
  const base = idleSessionPaneProps()
  const ordinaryPlaceholder = 'Ask Cat Code anything or describe a task…'
  const unavailablePlaceholder =
    'Input is unavailable until the current response finishes.'
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
      readOnly: true,
      disabled: false,
      placeholder: unavailablePlaceholder,
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
    const textarea =
      html.match(/<textarea[^>]*aria-label="Prompt"[^>]*>/)?.[0] ?? ''

    expect({
      name: state.name,
      readOnly: textarea.includes('readOnly=""'),
      disabled: textarea.includes('disabled=""'),
      placeholder: textarea.match(/placeholder="([^"]*)"/)?.[1] ?? '',
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
    "if (action.type === 'hold') {\n      setPendingSubmits(prev => reducePendingSubmitHeld(prev, sessionId, text))\n      retireDraft()",
  )
  // The drain rides the EXISTING app.submit — no new frame kind or channel.
  expect(submitBody).toContain(
    'const outcome = resolvePendingSubmit(selectConnection(connection, sessionId))',
  )
  expect(submitBody).toContain("if (outcome === 'wait') continue")
  expect(submitBody).toContain("if (outcome === 'release') {\n        releasePendingSubmit(sessionId)")
  expect(submitBody).toContain('getBridge().submit(sessionId, parked)')

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
  expect(source).toContain(
    'disabled={\n              !composerGate.editable ||\n              prompt.trim().length === 0 ||\n              pendingSubmit !== null\n            }',
  )
  expect(source).toContain('attachDisabled={!composerGate.editable}')
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

test('P4-18c: a generating session (ready + input disabled) shows the activity indicator + Stop', () => {
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
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )

  expect(html).toContain('■ Stop') // interrupt control wired to app.abort
  expect(html).toContain('Working') // derived verb (empty transcript tail)
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

test('P4-18 selectLiveTokenEstimate: current-turn output ÷ 4; prior turns excluded; no boundary → 0', () => {
  // No user boundary present → 0, so a retained transcript never leaks as a
  // huge count (fail to "no estimate", never to a wrong large number).
  expect(
    selectLiveTokenEstimate([
      blockRow({ kind: 'assistant-text', role: 'assistant', content: 'x'.repeat(80) }),
    ]),
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
  expect(selectLiveTokenEstimate(rows)).toBe(10)
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

test('P4-24: collapsed-paste pills render with token label, remove control, and preview body', () => {
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
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )

  // The re-skinned pill strip (replaces the old <details>-beside adaptation).
  expect(html).toContain('aria-label="Collapsed pastes"')
  // Pill label = the exact [Pasted text #N +M lines] token.
  expect(html).toContain('[Pasted text #1 +2 lines]')
  // Per-pill × remove control, and a hover/keyboard-focus full-text preview.
  expect(html).toContain('aria-label="Remove paste"')
  expect(html).toContain('role="tooltip"')
  expect(html).toContain('line A') // preview body is in the DOM (revealed on hover/focus)
  expect(html).toContain('line C')
  // Honest attach affordance: a labelled control, not a silent dead button and
  // not an invented file picker (no engine attachment capability on the wire).
  expect(html).toContain('aria-label="Add attachment"')
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
    restorePermission: () => {},
    setPermissionMode: () => {},
    setPrompt: () => {},
    submit: () => {},
    transcript: createTranscriptState(),
    transportError: null,
  } satisfies ComponentProps<typeof SessionPane>
}

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

test('a parked prompt is visible, and the send arrow says so', () => {
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
      pendingSubmit="run the migration"
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
  // LAYER HONESTY: these two defects live in a `document` keydown listener
  // registered by an App effect. The renderer suite is SSR-only (no DOM — see
  // AccountsPage.test.tsx) and App cannot be mounted, so the handler cannot be
  // executed here and no test in this package can press a key. This asserts only
  // what source text can decide — which guard the handler applies, and that the
  // listener is not attached while another surface owns the keyboard. The guard
  // itself is now an executable predicate (`permissionKeysAreLive`, unit-tested
  // in PermissionPrompt.test.tsx); a DOM harness is still flagged in the report.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const effectStart = source.indexOf(
    'const dedicatedFlowOwnsKeyboard =',
  )
  const effectEnd = source.indexOf(
    "document.addEventListener('keydown', handleKeyDown)",
    effectStart,
  )
  expect(effectStart).toBeGreaterThan(-1)
  expect(effectEnd).toBeGreaterThan(effectStart)
  const effectBody = source.slice(effectStart, effectEnd)

  // A tag-name test let Enter on the card's own Deny button bubble to document
  // and be answered as an ALLOW, because preventDefault() suppressed the
  // browser's Enter → click. The guard must cover any control that acts on the
  // key itself, buttons above all.
  expect(effectBody).not.toContain("target.tagName === 'INPUT'")
  expect(effectBody).toContain('if (!permissionKeysAreLive(event.target)) return')

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
    // without the host exemption, focusing the card kills all four keys.
    '[role="alertdialog"]',
  ]) {
    expect(selector).toContain(owner)
  }

  // P4-43 — the card that takes focus and advertises the keys must be exactly
  // the request the handler answers. A card advertising keys the listener does
  // not deliver is the dead affordance this session removed.
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
  // take focus — the handler acts solely on the activeSessionId's request.
  expect(source).toContain(
    'permissionKeyTargetRequestId={\n' +
      '\t              sessionId === activeSessionId\n' +
      '\t                ? permissionKeyTargetRequestId\n' +
      '\t                : null\n' +
      '\t            }',
  )

  // Propagation is target → document → window, so this document listener fires
  // BEFORE AskQuestionFlow's and PlanPanel's own window listeners: one Enter
  // would allow a parallel Bash call and answer the question.
  expect(effectBody).toContain(
    'selectAskQuestion(permissions, activeSessionId) !== null',
  )
  expect(effectBody).toContain(
    'selectPlanReview(permissions, activeSessionId) !== null',
  )
  expect(effectBody).toContain('if (dedicatedFlowOwnsKeyboard) return')
  expect(source).toContain('    dedicatedFlowOwnsKeyboard,\n  ])')

  // One answer per request: a second response is rejected by the sidecar as
  // unknown, and that rejection un-marks the card, re-enabling Allow/Deny on an
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

  // Reassigning a controlled textarea's value drops the selection to the end,
  // so an at-caret paste and the atomic pill-delete both threw the caret away.
  expect(source).toContain('el.setSelectionRange(caret, caret)')
  expect(source).toContain('pendingCaretRef.current = {')
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
