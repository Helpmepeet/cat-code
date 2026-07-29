/**
 * Settings shell render tests, after the first-principles rebuild
 * (`docs/migration/specs/2026-07-27-settings-redesign.md`).
 *
 * SSR-only (`renderToStaticMarkup`): no click, no keypress, no effect. So the
 * decisions live in `settingsScope.ts` and are tested there; what is tested HERE
 * is what the operator would actually see — that the scope is on screen and
 * chosen, that the rail is functional, that no live session value appears, and
 * that a write's destination is stated before the control.
 *
 * The `initialScope` prop is how a non-landing scope is reachable at all without
 * events; every test that uses it says which scope it is standing in.
 */

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  ExtensionsSnapshot,
  PermissionContextSnapshot,
  SettingsSnapshot,
} from '../../shared/protocol.js'
import { SettingsShell } from './SettingsShell.js'
import {
  ACCENT_KEYS,
  ACCENT_LABELS,
  ACCENT_SWATCH_CLASS,
  AccentThemeContext,
  DEFAULT_ACCENT,
} from './accentTheme.js'
import {
  CODE_THEME_KEYS,
  CODE_THEME_LABELS,
  CodeThemeContext,
  DEFAULT_CODE_THEME,
} from './codeTheme.js'
import {
  ReasoningLayoutContext,
  REASONING_LAYOUT_LABELS,
} from './reasoningLayout.js'

function decode(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
}

/** The page head, which owns the scope selector. */
function headMarkup(html: string): string {
  const end = html.indexOf('</header>')
  expect(end).toBeGreaterThan(0)
  return html.slice(0, end)
}

/** Just the left rail. */
function navMarkup(html: string): string {
  const start = html.indexOf('<nav')
  const end = html.indexOf('</nav>')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

/** Just the right pane, so rail or head copy can never satisfy a pane assertion. */
function paneMarkup(html: string): string {
  const end = html.indexOf('</nav>')
  expect(end).toBeGreaterThan(0)
  return html.slice(end)
}

/** The rail's category labels in DOM order. */
function railLabels(html: string): string[] {
  return [...navMarkup(html).matchAll(/<button[\s\S]*?<\/button>/g)].map(match =>
    decode(match[0].replace(/<[^>]*>/g, '').trim()),
  )
}

/** The scope tabs and which one is pressed, read out of the markup. */
function scopeTabs(html: string): { label: string; on: boolean }[] {
  const head = headMarkup(html)
  const group = head.slice(head.indexOf('aria-label="Settings scope"'))
  return [...group.matchAll(/<button aria-pressed="(true|false)"[\s\S]*?<\/button>/g)].map(
    match => ({
      label: decode(match[0].replace(/<[^>]*>/g, '').trim()),
      on: match[1] === 'true',
    }),
  )
}

/** One `<select>`'s opening tag, by aria-label. Needed because the shared
 * control's className carries `disabled:` variants, so a bare /disabled/ match
 * is true of every select on the page. */
function selectTag(html: string, label: string): string {
  const match = new RegExp(`<select[^>]*aria-label="${label}"[^>]*>`).exec(html)
  expect(match).not.toBeNull()
  return match?.[0] ?? ''
}

function controlCount(html: string): number {
  return (
    (html.match(/role="switch"/g) ?? []).length +
    (html.match(/<select/g) ?? []).length +
    (html.match(/inputMode="numeric"/g) ?? []).length
  )
}

const USER_FILE = '/Users/pt/.cat-code/settings.json'
const PROJECT_FILE = '/Users/pt/cat-code/.cat-code/settings.json'

const SNAPSHOT: SettingsSnapshot = {
  layers: [
    {
      source: 'userSettings',
      origin: USER_FILE,
      keys: ['reasoningDisplay', 'theme'],
    },
    {
      source: 'policySettings',
      origin: '/Library/Managed/managed-settings.json',
      keys: ['telemetry', 'bypassPermissions'],
    },
  ],
  resolved: [
    { key: 'bypassPermissions', source: 'policySettings', editable: false, managed: true },
    { key: 'reasoningDisplay', source: 'userSettings', editable: true, managed: false },
    { key: 'telemetry', source: 'policySettings', editable: false, managed: true },
    { key: 'theme', source: 'userSettings', editable: true, managed: false },
  ],
  policyOrigin: 'file',
  editableValues: [{ key: 'reasoningDisplay', value: 'raw', source: 'userSettings' }],
}

/** The engine key the app-local code-theme picker defers to, turned off. */
const HIGHLIGHTING_OFF: SettingsSnapshot = {
  ...SNAPSHOT,
  editableValues: [
    ...(SNAPSHOT.editableValues ?? []),
    {
      key: 'syntaxHighlightingDisabled',
      value: true,
      source: 'userSettings',
    },
  ],
}

/* ── Law 2: the subject is chosen ─────────────────────────────────────────── */

describe('scope selector', () => {
  test('all four scopes are offered, and the page lands on My defaults', () => {
    const tabs = scopeTabs(
      renderToStaticMarkup(<SettingsShell snapshot={SNAPSHOT} />),
    )
    expect(tabs.map(tab => tab.label)).toEqual([
      'My defaults',
      'Project',
      'This app',
      'Enforced',
    ])
    expect(tabs.filter(tab => tab.on).map(tab => tab.label)).toEqual([
      'My defaults',
    ])
  })

  test('the focused session names the Project tab but never selects it', () => {
    const tabs = scopeTabs(
      renderToStaticMarkup(
        <SettingsShell cwd="/Users/pt/cat-code" snapshot={SNAPSHOT} />,
      ),
    )
    expect(tabs[1]?.label).toBe('Project: cat-code')
    // Named, offered — and still not the scope in view.
    expect(tabs[1]?.on).toBe(false)
    expect(tabs[0]?.on).toBe(true)
  })

  /**
   * The operator's first complaint: *"it doesn't make sense if we change
   * something in settings to change the session scope"*. My defaults is the
   * user layer, which is session-invariant — so the same snapshot rendered
   * against two different focused projects must produce the SAME page.
   */
  test('switching the focused session does not change what My defaults shows', () => {
    const inCatCode = renderToStaticMarkup(
      <SettingsShell cwd="/Users/pt/cat-code" snapshot={SNAPSHOT} />,
    )
    const inOther = renderToStaticMarkup(
      <SettingsShell cwd="/Users/pt/somewhere-else" snapshot={SNAPSHOT} />,
    )
    expect(paneMarkup(inOther)).toBe(paneMarkup(inCatCode))
    expect(navMarkup(inOther)).toBe(navMarkup(inCatCode))
    // The two renders DO differ — in the project tab's label alone — so this is
    // not two identical inputs trivially agreeing.
    expect(scopeTabs(inCatCode)[1]?.label).toBe('Project: cat-code')
    expect(scopeTabs(inOther)[1]?.label).toBe('Project: somewhere-else')
  })

  test('with no session open the project tab names nothing and invents nothing', () => {
    const html = renderToStaticMarkup(
      <SettingsShell initialScope="project" snapshot={null} />,
    )
    expect(scopeTabs(html)[1]?.label).toBe('Project')
    expect(headMarkup(html)).toContain('No project is open')
    // Not a "waiting…": with no session nothing is in flight.
    expect(headMarkup(html).toLowerCase()).not.toContain('waiting')
    expect(headMarkup(html).toLowerCase()).not.toContain('loading')
  })
})

/* ── the functional rail ──────────────────────────────────────────────────── */

describe('functional rail', () => {
  test('My defaults offers the functional categories, with Extensions grouped', () => {
    const html = renderToStaticMarkup(<SettingsShell snapshot={SNAPSHOT} />)
    expect(railLabels(html)).toEqual([
      'General',
      'Model & Reasoning',
      'Permissions',
      'Interface',
      'Privacy & Data',
      'Memory',
      'Agents',
      'Skills',
      'Plugins',
      'MCP',
      'Hooks',
      'Remote',
    ])
    expect(navMarkup(html)).toContain('Extensions')
  })

  test('the rejected scope-grouped headings are gone from the rail', () => {
    const nav = decode(
      navMarkup(renderToStaticMarkup(<SettingsShell snapshot={SNAPSHOT} />)),
    )
    for (const heading of [
      'Resolved for',
      'Resolved per project',
      'This project',
      'This machine',
    ]) {
      expect(nav).not.toContain(heading)
    }
  })

  /**
   * Law 1 — the categories that were live SESSION state are not in Settings at
   * all any more. They already render on the session inspector
   * (`MetadataInspector.tsx` has Workspace / Permissions / Effective settings /
   * Flags / Engine diagnostics), so this is a relocation; the rail says where
   * they went rather than leaving the operator to hunt.
   */
  test('live-session categories left the rail, and the rail says where they are', () => {
    const html = renderToStaticMarkup(<SettingsShell snapshot={SNAPSHOT} />)
    for (const gone of ['Workspace', 'IDE & LSP', 'Diagnostics', 'Transcript']) {
      expect(railLabels(html)).not.toContain(gone)
    }
    expect(decode(navMarkup(html))).toContain('session inspector')
    // …without claiming they are already rendering there: the inspector's own
    // wiring is still pending, so a "you'll find them there" would be false.
    expect(decode(navMarkup(html))).not.toContain('shown in the session')
  })

  test('App’s existing entry point still opens a real pane', () => {
    const html = renderToStaticMarkup(
      <SettingsShell initialCategory="agents" snapshot={SNAPSHOT} />,
    )
    expect(navMarkup(html)).toContain('aria-current="page"')
    expect(paneMarkup(html)).toContain('Agents')
  })
})

/* ── Law 3 on screen ──────────────────────────────────────────────────────── */

describe('write targeting', () => {
  test('My defaults names the user file as the destination, before the control', () => {
    const pane = decode(
      paneMarkup(
        renderToStaticMarkup(
          <SettingsShell initialCategory="general" snapshot={SNAPSHOT} />,
        ),
      ),
    )
    expect(pane).toContain(`Edits here write to your own settings file: ${USER_FILE}`)
    expect(pane).not.toContain('write to this project')
  })

  /**
   * The same key, the same snapshot, two scopes: in My defaults it writes the
   * user file even though a project override is what currently wins. The old
   * `targetSourceFor` sent that write into the project's file instead.
   */
  test('a project-overridden value still writes the user file from My defaults', () => {
    const overridden: SettingsSnapshot = {
      ...SNAPSHOT,
      layers: [
        { source: 'userSettings', origin: USER_FILE, keys: ['reasoningDisplay'] },
        {
          source: 'projectSettings',
          origin: PROJECT_FILE,
          keys: ['reasoningDisplay'],
        },
      ],
      resolved: [
        { key: 'reasoningDisplay', source: 'projectSettings', editable: true, managed: false },
      ],
      editableValues: [
        { key: 'reasoningDisplay', value: 'off', source: 'projectSettings' },
      ],
    }
    const pane = decode(
      paneMarkup(
        renderToStaticMarkup(
          <SettingsShell initialCategory="model" snapshot={overridden} />,
        ),
      ),
    )
    expect(pane).toContain(`Edits here write to your own settings file: ${USER_FILE}`)
    // Exactly one destination is stated, and the project's file is never it —
    // the project path appears only inside the override annotation below.
    expect(pane.match(/Edits here write to/g)).toHaveLength(1)
    const destination = /Edits here write to[^<]*/.exec(pane)?.[0] ?? ''
    expect(destination).toContain(USER_FILE)
    expect(destination).not.toContain(PROJECT_FILE)
    // The override is visible as an annotation…
    expect(pane).toContain("Overridden by this project's shared settings")
    // …and the project's value is NOT presented as the user's own. The row is
    // bounded by the NEXT row's label, so a later row's control can never
    // satisfy the count below.
    const rowStart = pane.indexOf('>Reasoning display<')
    const rowEnd = pane.indexOf('>Prompt suggestions<')
    expect(rowStart).toBeGreaterThan(0)
    expect(rowEnd).toBeGreaterThan(rowStart)
    const displayRow = pane.slice(rowStart, rowEnd)
    expect(displayRow).toContain('unknown')
    // No control at all for a value this scope cannot read — not a control
    // sitting at a guessed position.
    expect(controlCount(displayRow)).toBe(0)
  })

  test('the project scope states the Shared / Just-me choice up front', () => {
    const head = decode(
      headMarkup(
        renderToStaticMarkup(
          <SettingsShell
            cwd="/Users/pt/cat-code"
            initialScope="project"
            snapshot={SNAPSHOT}
          />,
        ),
      ),
    )
    expect(head).toContain('Shared')
    expect(head).toContain('Just me')
    expect(head).toContain('Checked in with the repo')
  })
})

/* ── the honest v1 project limit ──────────────────────────────────────────── */

test('a project with no engine of its own shows no values and no controls', () => {
  // A roster entry that is NOT the focused session's project: nothing in this
  // window has read its files, and a write would land in the wrong one.
  const html = renderToStaticMarkup(
    <SettingsShell
      cwd={null}
      initialCategory="general"
      initialScope="project"
      projects={[{ cwd: '/Users/pt/other-repo', name: 'other-repo' }]}
      snapshot={SNAPSHOT}
    />,
  )
  const pane = paneMarkup(html)
  expect(controlCount(pane)).toBe(0)
  expect(pane).toContain('No engine is running in other-repo')
  expect(pane).not.toContain('Edits here write to')
  // The user file that WAS read must not be presented as this project's.
  expect(pane).not.toContain(USER_FILE)

  // The focused session's own project is fully live, so the block is the
  // engine gate rather than an empty project scope.
  const live = paneMarkup(
    renderToStaticMarkup(
      <SettingsShell
        cwd="/Users/pt/cat-code"
        initialCategory="general"
        initialScope="project"
        snapshot={SNAPSHOT}
      />,
    ),
  )
  expect(controlCount(live)).toBeGreaterThan(0)
  expect(live).toContain('Edits here write to')
})

/**
 * The panes with no value-editor of their own (the Extensions library, Memory,
 * Agents) read snapshots captured for the FOCUSED session. In a project that has
 * no engine, showing them would attribute one project's installed inventory to
 * another — so the scope is gated once, above the pane, not per editor.
 */
test('a no-engine project shows no other project’s extensions either', () => {
  const pane = paneMarkup(
    renderToStaticMarkup(
      <SettingsShell
        cwd={null}
        extensionsSnapshot={EXTENSIONS}
        initialCategory="mcp"
        initialScope="project"
        projects={[{ cwd: '/Users/pt/other-repo', name: 'other-repo' }]}
        snapshot={SNAPSHOT}
      />,
    ),
  )
  expect(pane).toContain('No engine is running in other-repo')
  // The focused session's MCP server must not appear under another project.
  expect(pane).not.toContain('linear')

  // With the project's own engine live, the same pane renders the real library.
  const live = paneMarkup(
    renderToStaticMarkup(
      <SettingsShell
        cwd="/Users/pt/cat-code"
        extensionsSnapshot={EXTENSIONS}
        initialCategory="mcp"
        initialScope="project"
        snapshot={SNAPSHOT}
      />,
    ),
  )
  expect(live).toContain('linear')
})

/* ── Law 1: no live session value ─────────────────────────────────────────── */

const PERMISSION_CONTEXT: PermissionContextSnapshot = {
  mode: 'plan',
  alwaysAllowRules: { userSettings: ['Bash(ls)'] },
  alwaysDenyRules: { localSettings: ['Bash(rm -rf /tmp)'] },
  alwaysAskRules: {},
  ruleMetadata: [],
  managedRulesOnly: false,
  permissionClassifierEnabled: false,
  additionalWorkingDirectories: [{ path: '/tmp/work', source: 'cliArg' }],
  isBypassPermissionsModeAvailable: false,
}

describe('Permissions — durable half only', () => {
  test('the running session’s mode, rules and directories are not rendered', () => {
    const html = renderToStaticMarkup(
      <SettingsShell
        additionalWorkingDirectories={PERMISSION_CONTEXT.additionalWorkingDirectories}
        initialCategory="permissions"
        permissionContext={PERMISSION_CONTEXT}
        snapshot={SNAPSHOT}
      />,
    )
    // The exact strings the operator objected to seeing under Settings.
    expect(html).not.toContain('Current permission mode')
    expect(html).not.toContain('Bash(ls)')
    expect(html).not.toContain('Bash(rm -rf /tmp)')
    expect(html).not.toContain('/tmp/work')
    expect(html).not.toContain('Permission classifier')
    // The session's live mode ('plan') never leaks into the durable row.
    expect(html).not.toContain('Default permission mode: plan')
  })

  test('the durable default mode is shown, read-only, with its source', () => {
    const html = renderToStaticMarkup(
      <SettingsShell
        initialCategory="permissions"
        snapshot={{
          ...SNAPSHOT,
          permissionDefaultMode: { value: 'acceptEdits', source: 'userSettings' },
        }}
      />,
    )
    expect(html).toContain('Default permission mode: acceptEdits')
    expect(html).toContain('>User<') // the source badge
    expect(decode(html)).toContain('Change it from the CLI')
    // Read-only means no control of any kind, not a disabled one.
    expect(controlCount(paneMarkup(html))).toBe(0)
  })

  test('unset and never-read stay different answers', () => {
    const unset = renderToStaticMarkup(
      <SettingsShell initialCategory="permissions" snapshot={SNAPSHOT} />,
    )
    expect(unset).toContain('Default permission mode: not set')
    expect(unset).toContain('is not set')

    const unread = renderToStaticMarkup(
      <SettingsShell initialCategory="permissions" snapshot={null} />,
    )
    expect(unread).toContain('Default permission mode: unknown')
    expect(unread).not.toContain('is not set')
    expect(unread).toContain('No session is open')
    // Neither promises anything is on its way.
    expect(unread).not.toContain('Waiting for')
  })

  /**
   * Every other row on this page is scope-relative. This one read the resolved
   * `permissions.defaultMode` across ALL layers, so a project's setting rendered
   * under a head that reads "Your own settings files", and switching scope
   * changed nothing.
   */
  test('the default mode obeys the chosen scope', () => {
    const projectDefault: SettingsSnapshot = {
      ...SNAPSHOT,
      layers: [
        ...SNAPSHOT.layers,
        { source: 'projectSettings', origin: '/repo/.cat-code/settings.json', keys: [] },
      ],
      permissionDefaultMode: { value: 'acceptEdits', source: 'projectSettings' },
    }

    const mine = renderToStaticMarkup(
      <SettingsShell initialCategory="permissions" snapshot={projectDefault} />,
    )
    // My defaults does not hold this value, so it is not shown as if it did…
    expect(mine).not.toContain('Default permission mode: acceptEdits')
    expect(mine).toContain('Default permission mode: unknown')
    // …and the cross-scope read no longer licenses a claim about the files.
    expect(mine).not.toContain('is not set in any settings file')
    expect(decode(mine)).toContain('Overridden by')

    // The project scope, which DOES hold it, shows it.
    const theirs = renderToStaticMarkup(
      <SettingsShell
        cwd="/repo"
        initialCategory="permissions"
        initialScope="project"
        snapshot={projectDefault}
      />,
    )
    expect(theirs).toContain('Default permission mode: acceptEdits')
    // The whole bug was the two scopes rendering the same answer.
    expect(mine).not.toBe(theirs)
  })

  /**
   * A null snapshot is not proof that no session exists: the spawn-time read can
   * throw and send no frame at all, so a RUNNING session sat under "No session
   * is open" forever.
   */
  test('a session with unread settings is not told that no session is open', () => {
    const attached = renderToStaticMarkup(
      <SettingsShell cwd="/repo" initialCategory="permissions" snapshot={null} />,
    )
    expect(attached).not.toContain('No session is open')
    expect(attached).toContain('have not been read for this session')
    // The value is still honestly unknown; only the explanation changed.
    expect(attached).toContain('Default permission mode: unknown')
  })
})

/* ── This app ─────────────────────────────────────────────────────────────── */

describe('This app scope', () => {
  test('the reasoning-layout control lives here, at the live mode, with no settings badge', () => {
    const html = renderToStaticMarkup(
      <ReasoningLayoutContext.Provider value={{ mode: 'blocks', setMode: () => {} }}>
        <SettingsShell initialScope="app" snapshot={SNAPSHOT} />
      </ReasoningLayoutContext.Provider>,
    )
    const pane = paneMarkup(html)
    expect(pane).toContain('Reasoning layout')
    expect(pane).toContain(REASONING_LAYOUT_LABELS.trail)
    expect(pane).toContain(REASONING_LAYOUT_LABELS.blocks)
    expect(pane).toContain('value="blocks"')
    expect(decode(pane)).toContain('not in your settings files')
    // No engine destination is claimed for a preference with no settings layer.
    expect(pane).not.toContain('Edits here write to')
  })

  test('it no longer sits in an engine-settings pane', () => {
    const interfacePane = paneMarkup(
      renderToStaticMarkup(
        <ReasoningLayoutContext.Provider value={{ mode: 'blocks', setMode: () => {} }}>
          <SettingsShell initialCategory="interface" snapshot={SNAPSHOT} />
        </ReasoningLayoutContext.Provider>,
      ),
    )
    expect(interfacePane).not.toContain('Reasoning layout')
    expect(interfacePane).not.toContain('value="blocks"')
    // The Interface pane is otherwise real: its own editors render.
    expect(interfacePane).toContain('Output style')
  })

  test('the code-theme picker offers all five themes at the live one', () => {
    const pane = paneMarkup(
      renderToStaticMarkup(
        <CodeThemeContext.Provider value={{ theme: 'nord', setTheme: () => {} }}>
          <SettingsShell initialScope="app" snapshot={SNAPSHOT} />
        </CodeThemeContext.Provider>,
      ),
    )
    expect(pane).toContain('Code theme')
    for (const theme of CODE_THEME_KEYS) {
      expect(pane).toContain(`value="${theme}"`)
      expect(decode(pane)).toContain(CODE_THEME_LABELS[theme])
    }
    // Selected, not merely offered — and app-local, like its neighbour.
    expect(pane).toContain('value="nord"')
    expect(decode(pane)).toContain('not in your settings files')
    // Off the default, so the prototype's reset affordance is reachable.
    expect(pane).toContain('Reset to default')
  })

  test('the pane opens on the live code canvas, above the picker that changes it', () => {
    const pane = paneMarkup(
      renderToStaticMarkup(<SettingsShell initialScope="app" snapshot={SNAPSHOT} />),
    )
    // The real sample, really tokenized — not a static image of one.
    expect(pane).toContain('Obeys no one, especially not the scheduler')
    expect(pane).toContain('hljs-keyword')
    // Hero placement: the canvas comes before the control it previews.
    expect(pane.indexOf('hljs-keyword')).toBeLessThan(pane.indexOf('Code theme'))
  })

  test('the canvas belongs to Appearance only', () => {
    const notifications = paneMarkup(
      renderToStaticMarkup(
        <SettingsShell
          initialCategory="notifications"
          initialScope="app"
          snapshot={SNAPSHOT}
        />,
      ),
    )
    expect(notifications).not.toContain('hljs')
  })

  test('the code theme is not an engine setting, so Interface does not offer it', () => {
    const interfacePane = paneMarkup(
      renderToStaticMarkup(<SettingsShell initialCategory="interface" snapshot={SNAPSHOT} />),
    )
    expect(interfacePane).not.toContain('Code theme')
    expect(interfacePane).not.toContain('value="monokai"')
  })

  test('with syntax highlighting off the picker is disabled and says where to turn it on', () => {
    const pane = paneMarkup(
      renderToStaticMarkup(
        <SettingsShell initialScope="app" snapshot={HIGHLIGHTING_OFF} />,
      ),
    )
    expect(selectTag(pane, 'Code theme')).toContain('disabled=""')
    expect(decode(pane)).toContain('Turn it back on under Interface')
    // The other app-local control is unaffected by an engine key.
    expect(selectTag(pane, 'Reasoning layout')).not.toContain('disabled=""')
  })

  test('an unread snapshot leaves the picker usable rather than guessing it is off', () => {
    const pane = paneMarkup(
      renderToStaticMarkup(<SettingsShell initialScope="app" snapshot={null} />),
    )
    expect(pane).toContain('Code theme')
    expect(selectTag(pane, 'Code theme')).not.toContain('disabled=""')
    expect(decode(pane)).not.toContain('Turn it back on under Interface')
  })

  test('the accent picker offers all five swatches, marks the live one, and is app-local', () => {
    const pane = paneMarkup(
      renderToStaticMarkup(
        <AccentThemeContext.Provider value={{ accent: 'blue', setAccent: () => {} }}>
          <SettingsShell initialScope="app" snapshot={SNAPSHOT} />
        </AccentThemeContext.Provider>,
      ),
    )
    expect(decode(pane)).toContain('Accent color')
    for (const key of ACCENT_KEYS) {
      expect(pane).toContain(`aria-label="${ACCENT_LABELS[key]}"`)
      // A STATIC colour class, or Tailwind emits no rule and the swatch is
      // invisible with nothing in the markup to notice (the dynamic-class trap).
      expect(pane).toContain(ACCENT_SWATCH_CLASS[key])
    }
    // One choice, not five buttons, and the current one is checked.
    expect(pane).toContain('role="radiogroup"')
    expect(
      /aria-checked="true" aria-label="Blue"/.test(pane) ||
        /aria-label="Blue"[^>]*aria-checked="true"/.test(pane),
    ).toBe(true)
    expect((pane.match(/aria-checked="true"/g) ?? []).length).toBe(1)
    expect(decode(pane)).toContain('not in your settings files')
  })

  test('the accent is above the transcript preferences, as in the prototype', () => {
    const pane = paneMarkup(
      renderToStaticMarkup(<SettingsShell initialScope="app" snapshot={SNAPSHOT} />),
    )
    expect(decode(pane).indexOf('Accent color')).toBeLessThan(
      decode(pane).indexOf('Code theme'),
    )
    // Still under the hero the whole pane opens on.
    expect(pane.indexOf('hljs-keyword')).toBeLessThan(
      decode(pane).indexOf('Accent color'),
    )
  })

  test('the default accent offers no reset, an off-default one does', () => {
    // BOTH renders are the Appearance pane, so the only difference between them
    // is the accent itself. (Standing on Notifications would have asserted pane
    // isolation while claiming to test the reset affordance.)
    const onDefault = paneMarkup(
      renderToStaticMarkup(
        <AccentThemeContext.Provider value={{ accent: DEFAULT_ACCENT, setAccent: () => {} }}>
          <CodeThemeContext.Provider value={{ theme: DEFAULT_CODE_THEME, setTheme: () => {} }}>
            <SettingsShell initialScope="app" snapshot={SNAPSHOT} />
          </CodeThemeContext.Provider>
        </AccentThemeContext.Provider>,
      ),
    )
    // Its neighbour is also at its default, so the pane offers no reset at all.
    expect(onDefault).not.toContain('Reset to default')

    const changed = paneMarkup(
      renderToStaticMarkup(
        <AccentThemeContext.Provider value={{ accent: 'amber', setAccent: () => {} }}>
          <CodeThemeContext.Provider value={{ theme: DEFAULT_CODE_THEME, setTheme: () => {} }}>
            <SettingsShell initialScope="app" snapshot={SNAPSHOT} />
          </CodeThemeContext.Provider>
        </AccentThemeContext.Provider>,
      ),
    )
    // Same pane, same neighbour default: the reset can only be the accent's.
    expect(changed).toContain('Reset to default')
  })

  test('an unbuilt app preference is named, not faked', () => {
    const pane = paneMarkup(
      renderToStaticMarkup(
        <SettingsShell
          initialCategory="notifications"
          initialScope="app"
          snapshot={SNAPSHOT}
        />,
      ),
    )
    expect(controlCount(pane)).toBe(0)
    expect(pane).toContain('Not built yet')
  })
})

/* ── Enforced ─────────────────────────────────────────────────────────────── */

describe('Enforced scope', () => {
  test('renders the real policy-locked keys', () => {
    const html = renderToStaticMarkup(
      <SettingsShell initialScope="enforced" snapshot={SNAPSHOT} />,
    )
    expect(html).toContain('Managed by your organization')
    expect(html).toContain('policy source: file')
    expect(html).toContain('telemetry')
    expect(html).toContain('bypassPermissions')
    // A user-source key is not in the enforced list.
    expect(html).not.toContain('>theme<')
  })

  test('never reports zero enforced settings it has not read', () => {
    const unread = paneMarkup(
      renderToStaticMarkup(
        <SettingsShell initialScope="enforced" snapshot={null} />,
      ),
    )
    expect(unread).not.toContain('No managed settings on this machine')
    expect(unread).toContain('No session is open')
    expect(unread).toContain('unknown')
    // The banner still renders — the pane degrades, it does not disappear.
    expect(unread).toContain('Managed by your organization')

    const readEmpty = paneMarkup(
      renderToStaticMarkup(
        <SettingsShell
          initialScope="enforced"
          snapshot={{ layers: [], resolved: [], policyOrigin: null, editableValues: [] }}
        />,
      ),
    )
    expect(readEmpty).toContain('No managed settings on this machine')
    expect(readEmpty).not.toContain('No session is open')
  })
})

/* ── extensions still render over real data ───────────────────────────────── */

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
}

test('the Extensions group renders the real library, not stubs', () => {
  const mcp = renderToStaticMarkup(
    <SettingsShell extensionsSnapshot={EXTENSIONS} initialCategory="mcp" snapshot={SNAPSHOT} />,
  )
  expect(mcp).toContain('linear')

  const skills = renderToStaticMarkup(
    <SettingsShell extensionsSnapshot={EXTENSIONS} initialCategory="skills" snapshot={SNAPSHOT} />,
  )
  expect(skills).toContain('/deep-research')

  const hooks = renderToStaticMarkup(
    <SettingsShell extensionsSnapshot={EXTENSIONS} initialCategory="hooks" snapshot={SNAPSHOT} />,
  )
  expect(hooks).toContain('PreToolUse')
  expect(hooks).toContain('run-check')
})

test('the page states once, globally, that edits apply to later sessions', () => {
  const head = headMarkup(renderToStaticMarkup(<SettingsShell snapshot={SNAPSHOT} />))
  expect(head).toContain('apply to sessions started afterwards')
})

test('renders with no snapshot at all without claiming anything', () => {
  const html = renderToStaticMarkup(<SettingsShell snapshot={null} />)
  expect(html).toContain('Settings')
  expect(html).not.toContain('Waiting for the engine')
})
