import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import * as startupSurfaces from './StartupSurfaces.js'
import {
  StartupOAuth,
  WorkspaceTrustGate,
  type StartupOAuthView,
} from './StartupSurfaces.js'

/** Render StartupOAuth for a given view with no-op handlers. */
function oauthHtml(
  view: StartupOAuthView,
  provider: 'anthropic' | 'openai' = 'openai',
): string {
  return renderToStaticMarkup(
    <StartupOAuth
      view={view}
      provider={provider}
      onBegin={() => {}}
      onCancel={() => {}}
      onPasteCode={() => {}}
      onSubmitAlias={() => {}}
      onRetry={() => {}}
    />,
  )
}

/* ── trust gate ────────────────────────────────────────────────────────────── */

/** Render the trust gate with no-op handlers. */
function trustHtml(
  props: Partial<Parameters<typeof WorkspaceTrustGate>[0]> = {},
): string {
  return renderToStaticMarkup(
    <WorkspaceTrustGate
      cwd="/Users/me/proj"
      trustRoot="/Users/me/proj"
      onTrust={() => {}}
      onDecline={() => {}}
      {...props}
    />,
  )
}

test('trust gate shows the title, the session cwd, and the two ruled actions', () => {
  const html = trustHtml()
  expect(html).toContain('role="dialog"')
  expect(html).toContain('aria-modal="true"')
  expect(html).toContain('tabindex="-1"')
  expect(html).toContain('Trust this workspace?')
  expect(html).toContain('/Users/me/proj')
  expect(html).toContain('Trust required')
  expect(html).toContain('Trust workspace')
  // Decline = don't open (Q1 TUI parity).
  expect(html).toContain('Don&#x27;t open')
})

test('trust gate surfaces an ok:false accept error inline (not a silent no-op)', () => {
  const html = trustHtml({
    cwd: '/x',
    trustRoot: '/x',
    errorMessage: 'Trust write did not persist; the workspace is still untrusted.',
  })
  expect(html).toContain('role="alert"')
  expect(html).toContain('Trust write did not persist')
})

test('trust gate shows no alert when there is no error', () => {
  expect(trustHtml({ cwd: '/x', trustRoot: '/x' })).not.toContain('role="alert"')
})

test('trust gate has NO read-only affordance (Q1 CUT)', () => {
  const html = trustHtml({ cwd: '/x', trustRoot: '/x' })
  expect(html).not.toContain('read-only')
  expect(html).not.toContain('Open read-only')
  expect(html.toLowerCase()).not.toContain('read only')
  // Not a workspace-switch prompt either (G4 CUT).
  expect(html).not.toContain('Workspace changed')
})

/* ── trust SCOPE honesty: name the path approving actually trusts ──────────── */

/** How many `<code>` path elements the gate rendered. */
function codeElementCount(html: string): number {
  return html.split('<code').length - 1
}

test('trust gate keeps ONE Workspace path box — scope is carried in the copy, not extra rows', () => {
  // The honesty fix is WORDING ONLY. An earlier revision grew a second labelled
  // path row + divider; that layout was reversed. This test is the tripwire: the
  // gate shows exactly one path element (the session cwd) under the original
  // "Workspace" label, in every scope case.
  for (const trustRoot of ['/Users/me/monorepo', '/Users/me/proj', null]) {
    const html = trustHtml({ cwd: '/Users/me/proj', trustRoot })
    expect(codeElementCount(html)).toBe(1)
    expect(html).toContain('>Workspace</div>')
    expect(html).toContain('>/Users/me/proj</code>')
    expect(html).not.toContain('Session folder')
    expect(html).not.toContain('Trust is saved for')
  }
})

test('trust gate names the resolved trust ROOT inline when it is wider than the session folder', () => {
  // Trust is stored per git repo (`getProjectPathForConfig()`), so approving for
  // one package trusts every sibling under the root. The prompt must say so and
  // name the root — otherwise approving is uninformed.
  const html = trustHtml({
    cwd: '/Users/me/monorepo/packages/foo',
    trustRoot: '/Users/me/monorepo',
  })
  expect(html).toContain('Trust is stored per git repository')
  expect(html).toContain(
    'Approving saves trust for /Users/me/monorepo and covers every folder under it',
  )
  expect(html).toContain('sibling projects')
  expect(html).toContain('terminal CLI')
  // Still a single path box showing the session folder (layout untouched).
  expect(codeElementCount(html)).toBe(1)
  expect(html).toContain('>/Users/me/monorepo/packages/foo</code>')
})

test('trust gate does NOT claim repo-wide scope when the root IS the session folder', () => {
  const html = trustHtml({ cwd: '/Users/me/proj', trustRoot: '/Users/me/proj' })
  expect(html).toContain('this folder and everything under it')
  expect(html).toContain('terminal CLI')
  // No overstated sibling/repository claim when there is nothing wider.
  expect(html).not.toContain('sibling projects')
  expect(html).not.toContain('Trust is stored per git repository')
})

test('trust gate says the scope is unresolved rather than implying folder-only trust', () => {
  const html = trustHtml({ cwd: '/Users/me/proj', trustRoot: null })
  expect(html).toContain('could not resolve where this trust would be saved')
  expect(html).toContain('may cover more than this folder')
  // It must not assert the narrow scope it cannot prove.
  expect(html).not.toContain('this folder and everything under it')
})

/* ── first-run OAuth sub-states (P4-15 — each is REACHABLE + prototype-faithful) ── */

test('OAuth ready phase offers both Anthropic and Codex subscription sign-in', () => {
  const html = oauthHtml({ phase: 'ready' })
  expect(html).toContain('Choose your provider')
  expect(html).toContain('Anthropic · Claude subscription')
  expect(html).toContain('Codex · ChatGPT subscription')
  expect(html.match(/Open browser to sign in/g)?.length).toBe(2)
})

test('OAuth waiting phase (no url yet) shows the wait + cancel, no paste-code block', () => {
  const html = oauthHtml({ phase: 'waiting', url: null })
  expect(html).toContain('Continue in your browser')
  expect(html).toContain('Waiting for browser authorization')
  expect(html).toContain('Cancel')
  // The paste-code fallback only appears once the engine mints the url.
  expect(html).not.toContain('Paste authorization code')
})

test('OAuth waiting phase WITH url shows the engine-minted paste-code fallback', () => {
  const html = oauthHtml({
    phase: 'waiting',
    url: 'https://auth.openai.com/authorize?code_challenge=abc&state=xyz',
  })
  expect(html).toContain('Browser didn')
  expect(html).toContain('https://auth.openai.com/authorize?code_challenge=abc&amp;state=xyz')
  expect(html).toContain('Paste authorization code')
  // The url is DISPLAY only — no token rides the renderer surface.
  expect(html).not.toContain('access_token')
})

test('OAuth waiting phase names the selected Anthropic provider', () => {
  const html = oauthHtml(
    { phase: 'waiting', url: 'https://claude.ai/oauth/authorize' },
    'anthropic',
  )
  expect(html).toContain('Your Anthropic account appears')
  expect(html).toContain('after you finish in the browser')
  expect(html).not.toContain('Your Codex account appears')
  expect(html).not.toContain('engine captures the callback')
})

test('OAuth alias phase shows the Authorized pill + naming step (Codex waiting_for_alias)', () => {
  const html = oauthHtml({ phase: 'alias' })
  expect(html).toContain('Authorized')
  expect(html).toContain('Name this account')
  expect(html).toContain('use the account email')
  expect(html).toContain('work · personal · team-a')
  expect(html).toContain('Continue')
})

test('OAuth success phase shows "Signed in" + the authorized check', () => {
  const html = oauthHtml({ phase: 'success' })
  expect(html).toContain('Signed in')
  expect(html).toContain('Setting up your workspace')
  expect(html).toContain('Authorized')
})

test('OAuth error phase binds the REAL engine message + offers retry/back', () => {
  const html = oauthHtml({ phase: 'error', message: 'authorization_request_timed_out' })
  expect(html).toContain('OAuth error')
  expect(html).toContain("Sign-in didn")
  expect(html).toContain('authorization_request_timed_out')
  expect(html).toContain('Retry')
  expect(html).toContain('Back')
})

test('OAuth surface has no "Simulate failure" demo control (prototype DEMO CUT)', () => {
  for (const view of [
    { phase: 'ready' } as const,
    { phase: 'waiting', url: null } as const,
    { phase: 'error', message: 'x' } as const,
  ]) {
    expect(oauthHtml(view)).not.toContain('Simulate failure')
  }
})

/* ── the reauth card is gone, and stays gone ───────────────────────────────── */

/**
 * P4-34. `ReauthOAuthProgress` outlived its launcher: the reauth banner was
 * deleted by ruling #12 (`docs/migration/decisions/STARTUP-GATES.md`), leaving a
 * card whose `'reauth'` context only its own Retry button could set, so it could
 * never open. Re-adding it without a launcher would rebuild that dead end, and
 * adding a launcher would reverse #12 — either belongs to a decision, not to a
 * drive-by import.
 */
test('the orphaned reauth OAuth card is not exported', () => {
  expect(Object.keys(startupSurfaces)).not.toContain('ReauthOAuthProgress')
})
