/**
 * Settings shell render tests, after the first-principles rebuild
 * (`docs/migration/specs/2026-07-27-settings-redesign.md`).
 *
 * SSR-only (`renderToStaticMarkup`): no click, no keypress, no effect. So the
 * decisions live in `settingsScope.ts` and are tested there; what is tested HERE
 * is the static navigation, app-local controls, and absence of live session
 * values. Inventory reads and writes are covered by the DOM suite.
 *
 * The `initialScope` prop is how a non-landing scope is reachable at all without
 * events; every test that uses it says which scope it is standing in.
 */

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsShell } from './SettingsShell.js'
import {
  ACCENT_KEYS,
  ACCENT_LABELS,
  ACCENT_SWATCH_CLASS,
  AccentThemeContext,
  DEFAULT_ACCENT,
} from './accentTheme.js'
import { GlassModeContext } from './glassMode.js'
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

/* ── Law 2: the subject is chosen ─────────────────────────────────────────── */

describe('scope selector', () => {
  test('engine settings offer My defaults and Project, and land on My defaults', () => {
    const tabs = scopeTabs(
      renderToStaticMarkup(<SettingsShell initialCategory="general" />),
    )
    expect(tabs.map(tab => tab.label)).toEqual([
      'My defaults',
      'Project',
    ])
    expect(tabs.filter(tab => tab.on).map(tab => tab.label)).toEqual([
      'My defaults',
    ])
  })

  test('the focused session names the Project tab but never selects it', () => {
    const tabs = scopeTabs(
      renderToStaticMarkup(
        <SettingsShell cwd="/Users/pt/cat-code" initialCategory="general" />,
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
      <SettingsShell cwd="/Users/pt/cat-code" initialCategory="general" />,
    )
    const inOther = renderToStaticMarkup(
      <SettingsShell cwd="/Users/pt/somewhere-else" initialCategory="general" />,
    )
    // The heading names the other available project, while the actual setting
    // rows remain the same user-layer values.
    const rowsAfterHeader = (html: string) => paneMarkup(html).split('</header>')[1]
    expect(rowsAfterHeader(inOther)).toBe(rowsAfterHeader(inCatCode))
    expect(navMarkup(inOther)).toBe(navMarkup(inCatCode))
    // The two renders DO differ — in the project tab's label alone — so this is
    // not two identical inputs trivially agreeing.
    expect(scopeTabs(inCatCode)[1]?.label).toBe('Project: cat-code')
    expect(scopeTabs(inOther)[1]?.label).toBe('Project: somewhere-else')
  })

  test('with no session open the project tab names nothing and invents nothing', () => {
    const html = renderToStaticMarkup(
      <SettingsShell initialCategory="general" initialScope="project" />,
    )
    expect(scopeTabs(html)[1]?.label).toBe('Project')
    expect(headMarkup(html)).toContain('Choose a project')
    // Not a "waiting…": with no session nothing is in flight.
    expect(headMarkup(html).toLowerCase()).not.toContain('waiting')
    expect(headMarkup(html).toLowerCase()).not.toContain('loading')
  })
})

/* ── the functional rail ──────────────────────────────────────────────────── */

describe('functional rail', () => {
  test('categories stay visible, with Extensions and Advanced grouped', () => {
    const html = renderToStaticMarkup(<SettingsShell />)
    expect(railLabels(html)).toEqual([
      'General',
      'Appearance',
      'Model & reasoning',
      'Permissions',
      'Privacy & data',
      'Memory',
      'Agents',
      'Skills',
      'Plugins',
      'MCP servers',
      'Hooks',
      'Remote',
      'Diagnostics',
      'Policies',
    ])
    expect(navMarkup(html)).toContain('Extensions')
    expect(navMarkup(html)).toContain('Advanced')
  })

  test('the rejected scope-grouped headings are gone from the rail', () => {
    const nav = decode(
      navMarkup(renderToStaticMarkup(<SettingsShell />)),
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

  test('category navigation is stable across settings scopes', () => {
    const user = renderToStaticMarkup(<SettingsShell />)
    const project = renderToStaticMarkup(
      <SettingsShell initialScope="project" />,
    )
    const appearance = renderToStaticMarkup(
      <SettingsShell initialScope="app" />,
    )
    expect(railLabels(project)).toEqual(railLabels(user))
    expect(railLabels(appearance)).toEqual(railLabels(user))
  })

  test('App’s existing entry point still opens a real pane', () => {
    const html = renderToStaticMarkup(
      <SettingsShell initialCategory="agents" />,
    )
    expect(navMarkup(html)).toContain('aria-current="page"')
    expect(paneMarkup(html)).toContain('Agents')
  })
})

/* ── Law 3 on screen ──────────────────────────────────────────────────────── */

describe('write targeting', () => {
  test('the project scope states the Shared / Just-me choice up front', () => {
    const head = decode(
      headMarkup(
        renderToStaticMarkup(
          <SettingsShell
            cwd="/Users/pt/cat-code"
            initialCategory="general"
            initialScope="project"
          />,
        ),
      ),
    )
    expect(head).toContain('Shared')
    expect(head).toContain('Just me')
    expect(head).toContain('Checked in with the repo')
  })
})

/* ── Law 1: no live session value ─────────────────────────────────────────── */

describe('Permissions — durable half only', () => {
  test('the running session’s mode, rules and directories are not rendered', () => {
    const html = renderToStaticMarkup(
      <SettingsShell
        initialCategory="permissions"
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


})

/* ── This app ─────────────────────────────────────────────────────────────── */

describe('This app scope', () => {
  test('the reasoning-layout control lives here, at the live mode, with no settings badge', () => {
    const html = renderToStaticMarkup(
      <ReasoningLayoutContext.Provider value={{ mode: 'blocks', setMode: () => {} }}>
        <SettingsShell initialScope="app" />
      </ReasoningLayoutContext.Provider>,
    )
    const pane = paneMarkup(html)
    expect(pane).toContain('Reasoning layout')
    expect(pane).toContain(REASONING_LAYOUT_LABELS.trail)
    expect(pane).toContain(REASONING_LAYOUT_LABELS.blocks)
    expect(pane).toContain('value="blocks"')
    // No engine destination is claimed for a preference with no settings layer.
    expect(pane).not.toContain('Edits here write to')
  })

  test('it no longer sits in an engine-settings pane', () => {
    const generalPane = paneMarkup(
      renderToStaticMarkup(
        <ReasoningLayoutContext.Provider value={{ mode: 'blocks', setMode: () => {} }}>
          <SettingsShell initialCategory="general" />
        </ReasoningLayoutContext.Provider>,
      ),
    )
    expect(generalPane).not.toContain('Reasoning layout')
    expect(generalPane).not.toContain('value="blocks"')
  })

  test('the code-theme picker offers all five themes at the live one', () => {
    const pane = paneMarkup(
      renderToStaticMarkup(
        <CodeThemeContext.Provider value={{ theme: 'nord', setTheme: () => {} }}>
          <SettingsShell initialScope="app" />
        </CodeThemeContext.Provider>,
      ),
    )
    expect(pane).toContain('Code theme')
    for (const theme of CODE_THEME_KEYS) {
      expect(pane).toContain(`value="${theme}"`)
      expect(decode(pane)).toContain(CODE_THEME_LABELS[theme])
    }
    // Selected, not merely offered.
    expect(pane).toContain('value="nord"')
    // Off the default, so the prototype's reset affordance is reachable.
    expect(pane).toContain('Reset to default')
  })

  test('the live code canvas is disclosed beside the picker that changes it', () => {
    const pane = paneMarkup(
      renderToStaticMarkup(<SettingsShell initialScope="app" />),
    )
    // The sample mounts when the disclosure opens, so closed previews do not
    // render or animate off screen.
    expect(pane).not.toContain('Obeys no one, especially not the scheduler')
    expect(pane).toContain('<details')
    expect(pane).toContain('Preview code theme')
    expect(pane.indexOf('Preview code theme')).toBeGreaterThan(pane.indexOf('Code theme'))
  })

  test('the canvas belongs to Appearance only', () => {
    const general = paneMarkup(
      renderToStaticMarkup(
        <SettingsShell initialCategory="general" />,
      ),
    )
    expect(general).not.toContain('hljs')
  })

  test('the code theme is not an engine setting, so General does not offer it', () => {
    const generalPane = paneMarkup(
      renderToStaticMarkup(<SettingsShell initialCategory="general" />),
    )
    expect(generalPane).not.toContain('Code theme')
    expect(generalPane).not.toContain('value="monokai"')
  })

  test('the code theme picker stays usable without a chat', () => {
    const pane = paneMarkup(
      renderToStaticMarkup(<SettingsShell initialScope="app" />),
    )
    expect(pane).toContain('Code theme')
    expect(selectTag(pane, 'Code theme')).not.toContain('disabled=""')
    expect(decode(pane)).not.toContain('Turn it back on under Interface')
  })

  test('the accent picker offers all five swatches, marks the live one, and is app-local', () => {
    const pane = paneMarkup(
      renderToStaticMarkup(
        <AccentThemeContext.Provider value={{ accent: 'blue', setAccent: () => {} }}>
          <SettingsShell initialScope="app" />
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
    // App-local, proven by what is NOT claimed rather than by boilerplate.
    expect(decode(pane)).toContain('Used for active states, the live indicator, and toggles.')
    expect(pane).not.toContain('Edits here write to')
  })

  /**
   * Every row in this scope is a renderer preference, and none of them says so
   * any more: "Stored in this app, not in your settings files." read as noise
   * inside Settings itself (operator, 2026-08-27). The app-local claim is
   * carried by the absence of a source badge and of an engine destination, which
   * the per-row tests assert. This is the sweep that keeps the sentence from
   * creeping back one row at a time.
   */
  test('no row claims where its preference is stored', () => {
    const pane = decode(
      paneMarkup(renderToStaticMarkup(<SettingsShell initialScope="app" />)),
    )
    expect(pane).not.toContain('Stored in this app')
    expect(pane).not.toContain('not in your settings files')
    // The rows are still there; the sweep must fail loudly, not vacuously.
    expect(pane).toContain('Frosted window')
    expect(pane).toContain('Code theme')
    expect(pane).toContain('Reasoning layout')
  })

  test('the frosted-window row reflects the live preference and can be reset', () => {
    const pane = paneMarkup(
      renderToStaticMarkup(
        <GlassModeContext.Provider value={{ glass: true, setGlass: () => {} }}>
          <SettingsShell initialScope="app" />
        </GlassModeContext.Provider>,
      ),
    )
    expect(decode(pane)).toContain('Frosted window')
    // App-local, and silent about it: no engine destination is claimed.
    expect(pane).not.toContain('Edits here write to')
    // The platform limit is disclosed rather than left for the user to discover.
    expect(decode(pane)).toContain('macOS only')
    // On differs from the shipped default, so the row offers the reset the
    // accent and tool-card rows offer in the same state.
    expect(decode(pane)).toContain('Reset')
  })

  test('the accent is above the transcript preferences, as in the prototype', () => {
    const pane = paneMarkup(
      renderToStaticMarkup(<SettingsShell initialScope="app" />),
    )
    expect(decode(pane).indexOf('Accent color')).toBeLessThan(
      decode(pane).indexOf('Code theme'),
    )
    // The compact preview follows its control instead of occupying the top.
    expect(pane.indexOf('Preview code theme')).toBeGreaterThan(
      decode(pane).indexOf('Code theme'),
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
            <SettingsShell initialScope="app" />
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
            <SettingsShell initialScope="app" />
          </CodeThemeContext.Provider>
        </AccentThemeContext.Provider>,
      ),
    )
    // Same pane, same neighbour default: the reset can only be the accent's.
    expect(changed).toContain('Reset to default')
  })

  test('unbuilt Notifications is absent from primary navigation', () => {
    const html = renderToStaticMarkup(<SettingsShell />)
    expect(railLabels(html)).not.toContain('Notifications')
  })
})

test('renders with no snapshot at all without claiming anything', () => {
  const html = renderToStaticMarkup(<SettingsShell />)
  expect(html).toContain('Settings')
  expect(html).not.toContain('Waiting for the engine')
})
