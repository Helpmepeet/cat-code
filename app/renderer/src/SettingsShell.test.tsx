import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  ExtensionsSnapshot,
  PermissionContextSnapshot,
  SettingsSnapshot,
} from '../../shared/protocol.js'
import { SettingsShell, selectSettingsNavGroups } from './SettingsShell.js'
import {
  SETTINGS_PROJECT_UNBOUND_NOTE,
  type SettingsProjectBinding,
  type SettingsProjectUnboundReason,
} from './settingsProjectBinding.js'
import {
  ReasoningLayoutContext,
  REASONING_LAYOUT_LABELS,
} from './reasoningLayout.js'

/** A project is bound, and it is one whose bare basename would be ambiguous. */
const BOUND: SettingsProjectBinding = {
  bound: true,
  appSessionId: 'app-1',
  cwd: '/Users/pt/cat-code/app',
  name: 'cat-code/app',
}

const UNBOUND_REASONS: SettingsProjectUnboundReason[] = [
  'no-session',
  'unknown-session',
  'unknown-workspace',
]

function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
}

/** Just the left rail, so a pane's copy can never satisfy a rail assertion. */
function navMarkup(html: string): string {
  const start = html.indexOf('<nav')
  const end = html.indexOf('</nav>')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

/** Just the right pane, so the rail's copy can never satisfy a pane assertion
 *  (the rail now states the no-session fact too, in its own words). */
function paneMarkup(html: string): string {
  const end = html.indexOf('</nav>')
  expect(end).toBeGreaterThan(0)
  return html.slice(end)
}

/**
 * The rail's RENDERED structure — one entry per scope group in DOM order, with
 * the heading the operator reads, the unbound note under it, and the category
 * labels inside it. Parsed out of the markup rather than read back off
 * `selectSettingsNavGroups`, so a grouping that is computed correctly and then
 * rendered under the wrong heading still fails.
 */
function railGroups(html: string): {
  heading: string
  note: string | null
  items: string[]
}[] {
  return navMarkup(html)
    .split(/<div [^>]*role="group"[^>]*>/)
    .slice(1)
    .map(chunk => {
      const note = /^<div[^>]*>[^<]*<\/div><p[^>]*>([^<]*)<\/p>/.exec(chunk)?.[1]
      return {
        heading: decodeEntities(
          /^<div[^>]*>([^<]*)<\/div>/.exec(chunk)?.[1] ?? '',
        ),
        note: note === undefined ? null : decodeEntities(note),
        items: [...chunk.matchAll(/<button[\s\S]*?<\/button>/g)].map(match =>
          decodeEntities(match[0].replace(/<[^>]*>/g, '').trim()),
        ),
      }
    })
}

const SNAPSHOT: SettingsSnapshot = {
  layers: [
    { source: 'userSettings', origin: '~/.cat-code/settings.json', keys: ['model', 'theme'] },
    { source: 'policySettings', origin: '/Library/Managed/managed-settings.json', keys: ['telemetry', 'bypassPermissions'] },
  ],
  resolved: [
    { key: 'bypassPermissions', source: 'policySettings', editable: false, managed: true },
    { key: 'model', source: 'userSettings', editable: true, managed: false },
    { key: 'telemetry', source: 'policySettings', editable: false, managed: true },
    { key: 'theme', source: 'userSettings', editable: true, managed: false },
  ],
  policyOrigin: 'file',
  editableValues: [],
}

test('shell renders the two-pane frame with the ported category rail', () => {
  const html = renderToStaticMarkup(<SettingsShell snapshot={SNAPSHOT} />)
  expect(html).toContain('Settings')
  expect(html).toContain('Search settings')
  // Ported nav categories.
  for (const label of ['General', 'Model &amp; Inference', 'Permissions', 'Theme &amp; Output', 'MCP', 'Managed']) {
    expect(html).toContain(label)
  }
  // CUT surfaces never appear.
  expect(html).not.toContain('Prototype controls')
})

/**
 * The rail groups by SCOPE — what the open project can do to a category's
 * values — because the screen mixes machine-wide configuration with
 * configuration that silently describes whichever session is focused, and had
 * nothing on it that told the operator which was which.
 *
 * One structural equality rather than a scatter of `toContain`s: it pins
 * membership, the order inside each group, the order of the groups, and that no
 * category fell out of the rail entirely — the failure a per-item assertion
 * cannot see.
 */
describe('scope grouping', () => {
  test('every category sits under the scope group its resolver puts it in', () => {
    const html = renderToStaticMarkup(
      <SettingsShell projectBinding={BOUND} snapshot={SNAPSHOT} />,
    )
    expect(railGroups(html)).toEqual([
      {
        heading: 'Resolved for cat-code/app',
        note: null,
        items: [
          'General',
          'Model & Inference',
          'Permissions',
          'Memory',
          'Privacy',
          'Theme & Output',
          'Agents',
          'MCP',
          'Plugins',
          'Skills',
          'Hooks',
          'IDE & LSP',
          'Diagnostics',
        ],
      },
      { heading: 'This project', note: null, items: ['Workspace', 'Remote'] },
      {
        heading: 'This machine',
        note: null,
        items: ['Keybindings', 'Transcript', 'Managed'],
      },
    ])
  })

  test('the bound project is named in the heading, and identified by its cwd', () => {
    const html = renderToStaticMarkup(
      <SettingsShell projectBinding={BOUND} snapshot={SNAPSHOT} />,
    )
    // The heading carries the disambiguated LABEL…
    expect(railGroups(html)[0]?.heading).toBe('Resolved for cat-code/app')
    // …and the full cwd, which is the identity the engine actually resolved
    // these settings against, stays reachable behind it.
    expect(navMarkup(html)).toContain('title="/Users/pt/cat-code/app"')
  })

  test('only the resolved group names a project — the other two make no project claim', () => {
    const html = renderToStaticMarkup(
      <SettingsShell projectBinding={BOUND} snapshot={SNAPSHOT} />,
    )
    const named = railGroups(html).filter(group =>
      group.heading.includes('cat-code/app'),
    )
    expect(named).toHaveLength(1)
    expect(named[0]?.items).toContain('General')
  })
})

/**
 * With nothing bound, no project may be named and no heading may imply one —
 * the `settingsReadState.ts` rule (nothing is in flight, so nothing may promise
 * a resolution) applied to the project question.
 */
describe('no project bound', () => {
  test.each(UNBOUND_REASONS)(
    'reason %s names no project and states why, without promising one',
    reason => {
      const html = renderToStaticMarkup(
        <SettingsShell
          projectBinding={{ bound: false, reason }}
          snapshot={SNAPSHOT}
        />,
      )
      const groups = railGroups(html)
      expect(groups.map(group => group.heading)).toEqual([
        'Resolved per project',
        'This project',
        'This machine',
      ])
      // The reason is stated once, under the heading that would have named a
      // project — not on the two groups that never name one.
      expect(groups.map(group => group.note)).toEqual([
        SETTINGS_PROJECT_UNBOUND_NOTE[reason],
        null,
        null,
      ])
      // Nothing in the rail promises the name is on its way.
      expect(navMarkup(html).toLowerCase()).not.toContain('waiting')
      expect(navMarkup(html).toLowerCase()).not.toContain('loading')
    },
  )

  test('no fragment of a project name survives into the unbound rail', () => {
    // The bug this guards: an unbound render that still leaks the last bound
    // label, or a placeholder standing in for one. Every distinctive fragment of
    // the bound render is checked, so `Resolved for ` + '' would fail too.
    const bound = navMarkup(
      renderToStaticMarkup(
        <SettingsShell projectBinding={BOUND} snapshot={SNAPSHOT} />,
      ),
    )
    const unbound = navMarkup(
      renderToStaticMarkup(
        <SettingsShell
          projectBinding={{ bound: false, reason: 'no-session' }}
          snapshot={SNAPSHOT}
        />,
      ),
    )
    for (const fragment of [
      'Resolved for',
      'cat-code/app',
      '/Users/pt/cat-code/app',
      'title=',
    ]) {
      expect(bound).toContain(fragment)
      expect(unbound).not.toContain(fragment)
    }
  })

  test('an absent binding names no project AND gives no reason', () => {
    // App.tsx has not been given `projectBinding` yet (a one-line change, held
    // back because that file is mid-edit in another session). "Not told" is a
    // THIRD state, distinct from both bound and explicitly-unbound: defaulting
    // it to `no-session` would print "No session is open" over a session that
    // IS open — the same false-claim class this whole surface is being fixed
    // for. So the heading stays generic and no reason is asserted.
    const html = renderToStaticMarkup(<SettingsShell snapshot={SNAPSHOT} />)
    expect(railGroups(html)[0]).toEqual({
      heading: 'Resolved per project',
      note: null,
      items: expect.arrayContaining(['General']) as unknown as string[],
    })
    // And specifically: no unbound reason leaks in from any of the three.
    for (const note of Object.values(SETTINGS_PROJECT_UNBOUND_NOTE)) {
      expect(navMarkup(html)).not.toContain(note)
    }
  })
})

/**
 * The search box is the one part of the rail the SSR-only suite cannot drive
 * (no events), so the filter is tested where it lives. A filter that quietly
 * stopped reaching the third group would look identical in the markup.
 */
describe('nav search', () => {
  const headings = (query: string) =>
    selectSettingsNavGroups(BOUND, query).map(group => group.heading)
  const labels = (query: string) =>
    selectSettingsNavGroups(BOUND, query).flatMap(group =>
      group.items.map(item => item.label),
    )

  test('matches inside every scope group, including the last one', () => {
    // One category per group, each reachable by its own query.
    expect(labels('permissions')).toEqual(['Permissions'])
    expect(headings('permissions')).toEqual(['Resolved for cat-code/app'])
    expect(labels('remote')).toEqual(['Remote'])
    expect(headings('remote')).toEqual(['This project'])
    expect(labels('managed')).toEqual(['Managed'])
    expect(headings('managed')).toEqual(['This machine'])
  })

  test('one query can span groups, and each match keeps its own heading', () => {
    // `e` hits categories in all three scopes at once.
    expect(headings('e')).toEqual([
      'Resolved for cat-code/app',
      'This project',
      'This machine',
    ])
    expect(labels('e')).toContain('General')
    expect(labels('e')).toContain('Remote')
    expect(labels('e')).toContain('Keybindings')
  })

  test('a group with no match drops out entirely, heading and all', () => {
    expect(headings('workspace')).toEqual(['This project'])
    const html = renderToStaticMarkup(
      <SettingsShell projectBinding={BOUND} snapshot={SNAPSHOT} />,
    )
    // …and with no query every group is present, so the drop is the filter's
    // doing and not a group that never rendered.
    expect(railGroups(html)).toHaveLength(3)
  })

  test('a query that matches nothing leaves no headings standing over nothing', () => {
    expect(selectSettingsNavGroups(BOUND, 'zzz')).toEqual([])
  })
})

test('the default (General) view surfaces the real layer summary + resolution legend', () => {
  const html = renderToStaticMarkup(<SettingsShell snapshot={SNAPSHOT} />)
  expect(html).toContain('Configuration sources')
  expect(html).toContain('Resolution order:')
  expect(html).toContain('~/.cat-code/settings.json') // real layer origin
  expect(html).toContain('2 keys') // userSettings key count
})

test('the Managed panel renders real policy-locked keys as managed Fields', () => {
  const html = renderToStaticMarkup(<SettingsShell initialCategory="managed" snapshot={SNAPSHOT} />)
  expect(html).toContain('Managed by your organization')
  expect(html).toContain('Enforced settings')
  expect(html).toContain('policy source: file')
  // Only the two policy-won keys, each managed (with a lock badge).
  expect(html).toContain('telemetry')
  expect(html).toContain('bypassPermissions')
  // A user-source key is NOT in the enforced list.
  expect(html).not.toContain('>theme<')
})

// "No managed settings on this machine" is a claim about org policy, and this
// is the pane an operator opens to check exactly that. With no session the app
// has read no settings file, so it must not answer the question at all.
test('the Managed panel never reports zero enforced settings it has not read', () => {
  // Pane-scoped: the RAIL states its own no-session fact (why no project is
  // named), which is a different claim from the pane's.
  const unread = paneMarkup(
    renderToStaticMarkup(
      <SettingsShell initialCategory="managed" snapshot={null} />,
    ),
  )
  expect(unread).not.toContain('No managed settings on this machine')
  expect(unread).toContain('No session is open')
  expect(unread).toContain('unknown')
  // The banner still renders — the pane degrades, it does not disappear.
  expect(unread).toContain('Managed by your organization')

  // A snapshot that WAS read and genuinely has no managed keys still gets the
  // real answer, so the guard cannot swallow the true empty case.
  const readEmpty = paneMarkup(
    renderToStaticMarkup(
      <SettingsShell
        initialCategory="managed"
        snapshot={{ layers: [], resolved: [], policyOrigin: null, editableValues: [] }}
      />,
    ),
  )
  expect(readEmpty).toContain('No managed settings on this machine')
  expect(readEmpty).not.toContain('No session is open')
})

test('editable controls are inert, and say why, when no settings have been read', () => {
  const unread = renderToStaticMarkup(
    <SettingsShell initialCategory="general" snapshot={null} />,
  )
  expect(unread).toContain('read-only until a session is open')

  // With a real snapshot the same pane is live again.
  const read = renderToStaticMarkup(
    <SettingsShell initialCategory="general" snapshot={SNAPSHOT} />,
  )
  expect(read).not.toContain('read-only until a session is open')

  // Count the rendered `disabled` attributes rather than merely looking for the
  // word: an earlier version of this test passed while the guard was mutated
  // away, because "disabled" occurs in the markup for unrelated reasons.
  const inert = (html: string) => (html.match(/disabled=""/g) ?? []).length
  expect(inert(unread)).toBeGreaterThan(0)
  expect(inert(read)).toBe(0)
})

test('core value-editor categories render real editors (P4-19), deferred ones stay stubs', () => {
  // Privacy now ships real value editors over the write-seam (P4-19), no stub.
  const privacy = renderToStaticMarkup(
    <SettingsShell initialCategory="privacy" snapshot={SNAPSHOT} />,
  )
  expect(privacy).not.toContain('coming soon')
  expect(privacy).toContain('Transcript retention (days)') // a real editor
  // Model + Theme likewise ship real editors.
  const model = renderToStaticMarkup(
    <SettingsShell initialCategory="model" snapshot={SNAPSHOT} />,
  )
  expect(model).toContain('Always-on thinking')
  expect(model).toContain('Reasoning effort')
  // Keybindings + IDE/LSP remain honest stubs (deferred — need their own seams).
  const keybindings = renderToStaticMarkup(
    <SettingsShell initialCategory="keybindings" snapshot={SNAPSHOT} />,
  )
  expect(keybindings).toContain('coming soon')
})

/**
 * The reasoning-layout control has no settings layer at all — it is renderer
 * state, identical whatever session is focused. It used to sit inside `Theme &
 * Output`, i.e. under a heading that now says these values resolve against the
 * open project, which for this one control was simply false. It is its own
 * `This machine` category instead.
 */
test('the Transcript pane carries the app-local reasoning-layout selector at the live mode', () => {
  const html = renderToStaticMarkup(
    <ReasoningLayoutContext.Provider value={{ mode: 'blocks', setMode: () => {} }}>
      <SettingsShell initialCategory="transcript" snapshot={SNAPSHOT} />
    </ReasoningLayoutContext.Provider>,
  )

  expect(html).toContain('Reasoning layout')
  // Both treatments are offered, and the control reflects the live mode.
  expect(html).toContain(REASONING_LAYOUT_LABELS.trail)
  expect(html).toContain(REASONING_LAYOUT_LABELS.blocks)
  expect(html).toContain('value="blocks"')
  // App-local, not an engine key: the row carries no settings SourceBadge.
  expect(html).toContain('not in your settings files')
  // It is not a stub that happens to mention reasoning.
  expect(html).not.toContain('coming soon')
})

test('the machine-wide reasoning control no longer renders inside the project-resolved Theme pane', () => {
  const theme = renderToStaticMarkup(
    <ReasoningLayoutContext.Provider value={{ mode: 'blocks', setMode: () => {} }}>
      <SettingsShell initialCategory="theme" snapshot={SNAPSHOT} />
    </ReasoningLayoutContext.Provider>,
  )
  // The control itself, not merely the word: the select's option values are
  // unique to it, so this cannot pass on unrelated markup.
  expect(theme).not.toContain('value="blocks"')
  expect(theme).not.toContain('Reasoning layout')
  // The Theme pane is otherwise untouched — its own editors still render.
  expect(theme).toContain('Theme &amp; output')
})

const EXTENSIONS: ExtensionsSnapshot = {
  mcp: [{ name: 'linear', transport: 'http', scope: 'user', url: 'https://mcp.linear/rpc' }],
  plugins: [
    {
      id: 'fmt@tools',
      name: 'formatter',
      source: 'fmt@tools',
      enabled: true,
      builtin: false,
      provides: { commands: 1, agents: 0, skills: 0, hooks: 0, mcpServers: 0, lsp: 0 },
    },
  ],
  skills: [
    {
      name: 'deep-research',
      source: 'userSettings',
      context: 'inline',
      disableModelInvocation: false,
      userInvocable: true,
      description: 'research a topic',
    },
  ],
  hooks: [
    {
      event: 'PreToolUse',
      type: 'command',
      source: 'userSettings',
      async: false,
      displayLine: 'run-check',
    },
  ],
  notes: [],
}

test('extension categories render the P4-12 panels over the real snapshot, not stubs', () => {
  const mcp = renderToStaticMarkup(
    <SettingsShell initialCategory="mcp" snapshot={SNAPSHOT} extensionsSnapshot={EXTENSIONS} />,
  )
  expect(mcp).not.toContain('coming soon')
  expect(mcp).toContain('linear')
  expect(mcp).toContain('Configured')

  const skills = renderToStaticMarkup(
    <SettingsShell initialCategory="skills" snapshot={SNAPSHOT} extensionsSnapshot={EXTENSIONS} />,
  )
  expect(skills).toContain('/deep-research')

  const hooks = renderToStaticMarkup(
    <SettingsShell initialCategory="hooks" snapshot={SNAPSHOT} extensionsSnapshot={EXTENSIONS} />,
  )
  expect(hooks).toContain('PreToolUse')
  expect(hooks).toContain('run-check')
})

const PERMISSION_CONTEXT: PermissionContextSnapshot = {
  mode: 'default',
  alwaysAllowRules: { userSettings: ['Bash(ls)', 'Read'] },
  alwaysDenyRules: { localSettings: ['Bash(rm -rf /tmp)'] },
  alwaysAskRules: {},
  ruleMetadata: [],
  managedRulesOnly: false,
  permissionClassifierEnabled: false,
  additionalWorkingDirectories: [{ path: '/tmp/work', source: 'cliArg' }],
  isBypassPermissionsModeAvailable: false,
}

test('the Permissions pane embeds the P2-4 read-only rules view over the real C3 context', () => {
  const html = renderToStaticMarkup(
    <SettingsShell
      initialCategory="permissions"
      permissionContext={PERMISSION_CONTEXT}
      snapshot={SNAPSHOT}
    />,
  )
  // Not the deferred stub any more.
  expect(html).not.toContain('coming soon')
  // Real engine rule strings + behavior group headings from the C3 snapshot.
  expect(html).toContain('Always allow')
  expect(html).toContain('Always deny')
  expect(html).toContain('Bash(ls)')
  expect(html).toContain('Bash(rm -rf /tmp)')
  expect(html).toContain('>userSettings<')
  // C3 additional working directories.
  expect(html).toContain('/tmp/work')
  expect(html).toContain('(cliArg)')
  // Read-only: no mode-switch buttons (showModes=false → no aria-pressed
  // control) and no rule-CRUD affordances (T6b — renderer never authors rules).
  expect(html).not.toContain('aria-pressed')
  expect(html).not.toContain('Add rule')
  expect(html).not.toContain('Save to')
  // D1: the read-only current-mode PILL still displays the engine mode even
  // though the interactive selector is hidden (pure display, not a control).
  expect(html).toContain('Current permission mode: default')
})

/**
 * CC-13 — the operator-observed failure, at the pane the operator actually
 * opens: Settings → Permissions with NO session attached rendered one
 * never-resolving "Waiting for the engine's permission context…" line as its
 * entire content, hiding the persisted `permissions.defaultMode` setting (which
 * the desktop app had no other way to show) and everything P4-34 Lane 2 added.
 */
test('CC-13: Settings → Permissions renders the default-mode setting with NO session attached', () => {
  const html = renderToStaticMarkup(
    <SettingsShell
      initialCategory="permissions"
      permissionContext={null}
      snapshot={{
        ...SNAPSHOT,
        permissionDefaultMode: { value: 'plan', source: 'userSettings' },
      }}
    />,
  )
  expect(html).not.toContain('coming soon')
  // The pane's content is the SETTING, sourced from the settings seam…
  expect(html).toContain('Default mode')
  expect(html).toContain('Default permission mode: plan')
  // …not a wait that can never resolve.
  expect(html).not.toContain('Waiting for the engine')
  expect(html).toContain('No session is attached')
})

test('CC-13: the Permissions pane reads defaultMode from the settings seam, not the session', () => {
  // Session mode `default` (PERMISSION_CONTEXT) vs configured default
  // `acceptEdits` — the heading/value mismatch this row fixes.
  const html = renderToStaticMarkup(
    <SettingsShell
      initialCategory="permissions"
      permissionContext={PERMISSION_CONTEXT}
      snapshot={{
        ...SNAPSHOT,
        permissionDefaultMode: { value: 'acceptEdits', source: 'localSettings' },
      }}
    />,
  )
  expect(PERMISSION_CONTEXT.mode).toBe('default')
  expect(html).toContain('Default permission mode: acceptEdits')
  expect(html).toContain('Local')
  expect(html).toContain('Current permission mode: default')
})

test('CC-13: a settings snapshot without the field renders the unset state, not a wait', () => {
  // SNAPSHOT carries no `permissionDefaultMode` (unset at every layer, or a
  // snapshot predating the field) — tolerant read, explicit unset state.
  const html = renderToStaticMarkup(
    <SettingsShell
      initialCategory="permissions"
      permissionContext={null}
      snapshot={SNAPSHOT}
    />,
  )
  expect(html).toContain('Default permission mode: not set')
  expect(html).not.toContain('Waiting for the engine')
})

// The shell is the only production caller, so it is the only place the
// settings-read distinction can actually be got wrong: the editor cannot tell
// "unset" from "never read" unless the shell passes `settingsLoaded`. Both
// panes must still render — the pane not blocking was the original CC-13 fix.
test('CC-13: with NO settings snapshot the Permissions pane renders, and says unknown rather than unset', () => {
  const html = renderToStaticMarkup(
    <SettingsShell
      initialCategory="permissions"
      permissionContext={null}
      snapshot={null}
    />,
  )
  expect(html).toContain('Default permission mode: unknown')
  // Must not assert anything about settings files it has not read.
  expect(html).not.toContain('is not set')
  expect(html).toContain('No session is attached')
  expect(html).not.toContain('Waiting for the engine')
})

test('CC-13: WITH a snapshot and no defaultMode, the same pane says unset', () => {
  const html = renderToStaticMarkup(
    <SettingsShell
      initialCategory="permissions"
      permissionContext={null}
      snapshot={SNAPSHOT}
    />,
  )
  expect(html).toContain('Default permission mode: not set')
  expect(html).toContain('is not set')
  expect(html).not.toContain('Default permission mode: unknown')
})

test('renders without a snapshot (waiting state)', () => {
  const html = renderToStaticMarkup(<SettingsShell snapshot={null} />)
  expect(html).toContain('Waiting for the engine')
})
