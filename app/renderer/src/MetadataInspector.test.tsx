import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKMessage } from '@cat-code/engine/sdk'
import type {
  DiagnosticsSnapshot,
  PermissionContextSnapshot,
  SettingsSnapshot,
  ThreadGoalSnapshot,
  WorkspaceTrustSnapshot,
} from '../../shared/protocol.js'
import type { RawMessageSessionLog } from './rawMessageLog.js'
import type { SessionMetadataView } from './messageMetadata.js'
import { SDK_MESSAGE_FIXTURE } from './sdkMessageFixtures.js'
import { MetadataInspector } from './MetadataInspector.js'
import { buildSessionInspectorState } from './sessionInspectorState.js'

const assistant: SDKMessage = {
  ...SDK_MESSAGE_FIXTURE.assistant[0]!.message,
  uuid: 'a1',
  requestId: 'req_9',
}
const result: SDKMessage = { ...SDK_MESSAGE_FIXTURE.result[0]!.message, uuid: 'r1' }

function log(messages: SDKMessage[]): RawMessageSessionLog {
  return {
    inputEnabled: true,
    messages,
    retainedBytes: 0,
    truncated: false,
    error: null,
    messageBytes: [],
  }
}

const goal: ThreadGoalSnapshot = {
  threadId: 't',
  goalId: 'goal-42',
  objective: 'Ship the inspector',
  status: 'active',
  tokensUsed: 12000,
  tokenBudget: 50000,
  timeUsedSeconds: 125,
  createdAtMs: 0,
  updatedAtMs: 1,
  summary: '',
}

const session: SessionMetadataView = {
  sessionId: 'engine-xyz',
  mode: 'agent',
  permissionMode: 'acceptEdits',
  tag: 'p4-6b',
  threadGoal: goal,
}

const noop = () => {}

test('renders the read-only drawer with the session + goal sections', () => {
  const html = renderToStaticMarkup(
    <MetadataInspector session={session} log={log([assistant, result])} onClose={noop} />,
  )
  expect(html).toContain('read-only')
  expect(html).toContain('role="dialog"')
  expect(html).toContain('engine-xyz')
  expect(html).toContain('acceptEdits')
  expect(html).toContain('#p4-6b')
  expect(html).toContain('Ship the inspector')
  expect(html).toContain('goal-42')
})

test('defaults the selected message to the last one (the result frame + its usage)', () => {
  const html = renderToStaticMarkup(
    <MetadataInspector session={session} log={log([assistant, result])} onClose={noop} />,
  )
  // Result frame is last → Usage & cost section shows its real numbers.
  expect(html).toContain('Usage &amp; cost')
  expect(html).toContain('$0.0421')
  expect(html).toContain('5321 ms')
})

test('shows the honest "Not available" deferral note, never mocked worktree/file data', () => {
  const html = renderToStaticMarkup(
    <MetadataInspector session={session} log={log([assistant])} onClose={noop} />,
  )
  expect(html).toContain('Not available')
  expect(html).toContain('No per-message account is recorded upstream')
  expect(html).toContain('no transcript-by-id read seam')
})

test('degrades cleanly with an empty log and no session', () => {
  const html = renderToStaticMarkup(
    <MetadataInspector session={null} log={log([])} onClose={noop} />,
  )
  expect(html).toContain('No messages retained')
  expect(html).toContain('No goal on this thread.')
})

/* ------------------------------------------------------------------------- *
 * CC-19 §4 — the live session state relocated from Settings
 * ------------------------------------------------------------------------- */

const settingsSnapshot: SettingsSnapshot = {
  layers: [
    {
      source: 'userSettings',
      origin: '/home/me/.cat-code/settings.json',
      keys: ['model', 'theme'],
    },
    {
      source: 'policySettings',
      origin: '/Library/managed.json',
      keys: ['autoUpdates'],
    },
  ],
  resolved: [
    { key: 'model', source: 'userSettings', editable: true, managed: false },
    { key: 'autoUpdates', source: 'policySettings', editable: false, managed: true },
  ],
  policyOrigin: 'plist',
  editableValues: [
    { key: 'model', value: 'gpt-5.6-luna', source: 'userSettings' },
  ],
  permissionDefaultMode: { value: 'plan', source: 'userSettings' },
}

const permissionContext: PermissionContextSnapshot = {
  mode: 'acceptEdits',
  alwaysAllowRules: { userSettings: ['Bash(ls:*)'] },
  alwaysDenyRules: {},
  alwaysAskRules: {},
  ruleMetadata: [
    {
      behavior: 'allow',
      source: 'userSettings',
      rule: 'Bash(ls:*)',
      matchType: 'prefix',
    },
  ],
  managedRulesOnly: false,
  permissionClassifierEnabled: true,
  additionalWorkingDirectories: [
    { path: '/repo/docs', source: 'cliArg' },
    { path: '/scratch', source: 'session' },
  ],
  isBypassPermissionsModeAvailable: false,
}

const workspaceTrust: WorkspaceTrustSnapshot = {
  trusted: true,
  detectedRepo: 'helpmepeet/cat-code',
  trustRoot: '/repo',
}

const diagnostics: DiagnosticsSnapshot = {
  version: '9.9.9-inspector',
  mainLoopModel: 'gpt-5.6-luna',
  mainLoopModelForSession: 'gpt-5.6-luna',
  reasoningEffort: 'low',
  fastMode: false,
  sandboxEnabled: true,
  installationWarnings: [],
  healthWarnings: ['auto-update is disabled'],
  memoryWarnings: [],
}

const fullState = buildSessionInspectorState({
  cwd: '/repo',
  settings: settingsSnapshot,
  permissionContext,
  workspaceTrust,
  diagnostics,
})

function renderInspector(sessionState?: Parameters<typeof MetadataInspector>[0]['sessionState']) {
  return renderToStaticMarkup(
    <MetadataInspector
      session={session}
      log={log([assistant])}
      onClose={noop}
      sessionState={sessionState}
    />,
  )
}

test('an unwired drawer says so ONCE and shows no live section at all', () => {
  const html = renderInspector(undefined)
  expect(html).toContain('Live session state')
  expect(html).toContain('App passes no sessionState')
  // The five live sections must not render at all — an unwired drawer that
  // printed empty Workspace/Permissions headings would read as "this session
  // has none of these".
  expect(html).not.toContain('Effective settings')
  expect(html).not.toContain('Engine diagnostics')
  expect(html).not.toContain('Trust root')
  expect(html).not.toContain('Flags')
})

test('a wired drawer with no snapshots names each missing seam, not the app gap', () => {
  const html = renderInspector(
    buildSessionInspectorState({
      cwd: '/repo',
      settings: null,
      permissionContext: null,
      workspaceTrust: null,
      diagnostics: null,
    }),
  )
  expect(html).not.toContain('App passes no sessionState')
  expect(html).toContain('No settings snapshot has arrived for this session')
  expect(html).toContain('No permission context has arrived for this session')
  expect(html).toContain('No workspace-trust snapshot has arrived for this session')
  expect(html).toContain('No diagnostics snapshot has arrived for this session')
  // The cwd IS known even with every snapshot missing — it comes off the roster.
  expect(html).toContain('Working directory')
  expect(html).toContain('/repo')
})

test('workspace facts render trust, its real write root, and the detected repo', () => {
  const html = renderInspector(fullState)
  expect(html).toContain('Trust root')
  expect(html).toContain('/repo')
  expect(html).toContain('helpmepeet/cat-code')
  // The trust WORD is what the operator reads — assert the rendered state, not
  // merely that a trust row exists.
  expect(html).toContain('>trusted<')
  expect(html).not.toContain('>untrusted<')
})

test('an untrusted workspace renders as untrusted', () => {
  const html = renderInspector(
    buildSessionInspectorState({
      ...fullState,
      workspaceTrust: { ...workspaceTrust, trusted: false, detectedRepo: null },
    }),
  )
  expect(html).toContain('>untrusted<')
  // detectedRepo null is a real answer, not a blank.
  expect(html).toContain('>none<')
})

test('extra directories are counted per source and the cliArg ambiguity is stated', () => {
  const html = renderInspector(fullState)
  expect(html).toContain('Extra directories')
  expect(html).toContain('2 · 1 cliArg, 1 session')
  expect(html).toContain(
    'src/utils/permissions/permissionSetup.ts:1015-1035',
  )
})

test('no cliArg directory means the ambiguity caveat is NOT printed', () => {
  const html = renderInspector(
    buildSessionInspectorState({
      ...fullState,
      permissionContext: {
        ...permissionContext,
        additionalWorkingDirectories: [{ path: '/scratch', source: 'session' }],
      },
    }),
  )
  expect(html).toContain('1 · 1 session')
  expect(html).not.toContain('permissionSetup.ts')
})

test('the live permission context renders read-only: mode, rules, classifier, no mode buttons', () => {
  const html = renderInspector(fullState)
  expect(html).toContain('Current permission mode: acceptEdits')
  expect(html).toContain('Bash(ls:*)')
  expect(html).toContain('prefix')
  expect(html).toContain('Permission classifier: on')
  // T6b — this drawer never offers a mode control. `aria-pressed` is only ever
  // emitted by PermissionRulesEditor's mode buttons, so its absence proves
  // `showModes={false}` reached the component.
  expect(html).not.toContain('aria-pressed')
  // The durable default still shows, badged with the layer it came from.
  expect(html).toContain('Default permission mode: plan')
})

test('effective settings list every resolved key, high-precedence layer first', () => {
  const html = renderInspector(fullState)
  // Layer summary ordered policy → user (the snapshot lists them the other way).
  expect(html.indexOf('/Library/managed.json')).toBeLessThan(
    html.indexOf('/home/me/.cat-code/settings.json'),
  )
  expect(html).toContain('2 keys')
  // Keys sorted; only the allowlisted one carries a value.
  expect(html.indexOf('autoUpdates')).toBeLessThan(html.indexOf('>model<'))
  expect(html).toContain('gpt-5.6-luna')
  expect(html).toContain('1 of 2 resolved keys carry a value on this seam')
})

test('flags and run controls are honest that no launch argv reaches the renderer', () => {
  const html = renderInspector(fullState)
  expect(html).toContain('none — no --settings file or SDK inline settings')
  expect(html).toContain('Model override')
  expect(html).toContain('app/main/main.ts:477')
  expect(html).toContain('Fast mode')
  expect(html).toContain('>off<')
})

test('an unset reasoning effort reads as the provider default, never as a value', () => {
  const html = renderInspector(
    buildSessionInspectorState({
      ...fullState,
      diagnostics: { ...diagnostics, reasoningEffort: null, mainLoopModel: null },
    }),
  )
  expect(html).toContain('provider default')
  // A missing override is "none", not a silent fallback to the resolved model.
  expect(html).toContain('>none<')
})

test('a real flag layer is reported with the keys it wins', () => {
  const html = renderInspector(
    buildSessionInspectorState({
      ...fullState,
      settings: {
        ...settingsSnapshot,
        layers: [
          ...settingsSnapshot.layers,
          {
            source: 'flagSettings',
            origin: '/tmp/flag-settings.json',
            keys: ['verbose'],
          },
        ],
        resolved: [
          ...settingsSnapshot.resolved,
          { key: 'verbose', source: 'flagSettings', editable: false, managed: false },
        ],
      },
    }),
  )
  expect(html).toContain('/tmp/flag-settings.json')
  expect(html).toContain('Keys it wins')
  expect(html).not.toContain('none — no --settings file')
})

test('engine diagnostics render the real warnings and a clean list as "no issues"', () => {
  const html = renderInspector(fullState)
  expect(html).toContain('9.9.9-inspector')
  expect(html).toContain('auto-update is disabled')
  expect(html).toContain('no issues')
  expect(html).toContain('>enabled<')
})

test('IDE / LSP status is declared unavailable rather than shown as absent', () => {
  const html = renderInspector(fullState)
  expect(html).toContain('IDE connection and language-server status reach the renderer on no frame')
})
