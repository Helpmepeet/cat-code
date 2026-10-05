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

/* ── sign-in sub-states (P4-15 — each is REACHABLE) ─────────────────────────── */

test('OAuth ready phase offers Claude and ChatGPT as whole-row choices', () => {
  const html = oauthHtml({ phase: 'ready' })
  expect(html).toContain('Sign in to get started')
  expect(html).toContain('Claude subscription')
  expect(html).toContain('ChatGPT subscription for Codex models')
  // One action per provider, not a repeated primary button per row.
  expect(html).not.toContain('Open browser to sign in')
})

test('OAuth waiting phase (no url yet) shows a disabled copy action + cancel, no paste route', () => {
  const html = oauthHtml({ phase: 'waiting', url: null })
  expect(html).toContain('Sign in with ChatGPT')
  expect(html).toContain('Preparing link')
  expect(html).toContain('disabled=""')
  expect(html).toContain('Cancel')
  expect(html).not.toContain('Open in browser')
  expect(html).not.toContain('Paste the')
})

test('OAuth waiting phase WITH url leads with Copy sign-in link and never prints the url', () => {
  const url = 'https://auth.openai.com/authorize?code_challenge=abc&state=xyz'
  const html = oauthHtml({ phase: 'waiting', url })
  expect(html).toContain('Copy sign-in link')
  expect(html).toContain('Open in browser')
  expect(html).toContain('Waiting for approval')
  // Copy is the first control and the focused one.
  expect(html.indexOf('Copy sign-in link')).toBeLessThan(html.indexOf('Open in browser'))
  expect(html).toMatch(/<button[^>]*autofocus=""[^>]*>(?:(?!<\/button>).)*Copy sign-in link/)
  // The url is an href only: the wall of query string is not printed.
  expect(html).toContain('href="https://auth.openai.com/authorize?code_challenge=abc&amp;state=xyz"')
  expect(html.split('code_challenge=abc').length - 1).toBe(1)
  expect(html).not.toContain('access_token')
})

test('ChatGPT keeps the paste route folded: its redirect normally lands on its own', () => {
  const html = oauthHtml({ phase: 'waiting', url: 'https://auth.openai.com/authorize' })
  expect(html).toContain('<details')
  expect(html).toContain('the page didn')
  expect(html).toContain('Paste the page address')
})

test('Claude shows the paste field up front: a copied Claude link always ends on a code', () => {
  const html = oauthHtml(
    { phase: 'waiting', url: 'https://claude.ai/oauth/authorize' },
    'anthropic',
  )
  expect(html).toContain('Sign in with Claude')
  expect(html).toContain('Paste the code')
  expect(html).not.toContain('<details')
  expect(html).not.toContain('Sign in with ChatGPT')
})

test('OAuth waiting phase shows a refused code inline', () => {
  const html = renderToStaticMarkup(
    <StartupOAuth
      view={{ phase: 'waiting', url: 'https://claude.ai/oauth/authorize' }}
      provider="anthropic"
      codeStatus={{ state: 'rejected', message: 'Could not parse input.' }}
      onBegin={() => {}}
      onCancel={() => {}}
      onPasteCode={() => {}}
      onSubmitAlias={() => {}}
      onRetry={() => {}}
    />,
  )
  expect(html).toContain('role="alert"')
  expect(html).toContain('Could not parse input.')
  expect(html).toContain('aria-invalid="true"')
})

test('OAuth waiting phase drops the link and paste actions once a code is accepted', () => {
  const html = renderToStaticMarkup(
    <StartupOAuth
      view={{ phase: 'waiting', url: 'https://auth.openai.com/authorize' }}
      provider="openai"
      codeStatus={{ state: 'accepted' }}
      onBegin={() => {}}
      onCancel={() => {}}
      onPasteCode={() => {}}
      onSubmitAlias={() => {}}
      onRetry={() => {}}
    />,
  )
  expect(html).toContain('Finishing sign-in')
  expect(html).not.toContain('Copy sign-in link')
  expect(html).not.toContain('Paste the')
})

test('OAuth alias phase offers Save and Skip, and no cancel that would drop the login', () => {
  const html = oauthHtml({ phase: 'alias' })
  expect(html).toContain('Name this account')
  expect(html).toContain('aria-label="Account name"')
  expect(html).toContain('Save')
  expect(html).toContain('Skip')
  expect(html).not.toContain('Cancel')
  // The old copy promised an email fallback Codex rows never show.
  expect(html).not.toContain('account email')
})

test('OAuth alias phase shows a refused alias inline', () => {
  const html = renderToStaticMarkup(
    <StartupOAuth
      view={{ phase: 'alias' }}
      provider="openai"
      aliasStatus={{ state: 'rejected', message: 'Alias "work" is already in use.' }}
      onBegin={() => {}}
      onCancel={() => {}}
      onPasteCode={() => {}}
      onSubmitAlias={() => {}}
      onRetry={() => {}}
    />,
  )
  expect(html).toContain('role="alert"')
  expect(html).toContain('is already in use.')
})

test('OAuth success phase says Signed in without narrating setup', () => {
  const html = oauthHtml({ phase: 'success' })
  expect(html).toContain('Signed in')
  expect(html).not.toContain('Setting up your workspace')
})

test('OAuth error phase shows the REAL engine message once + try again/cancel', () => {
  const html = oauthHtml({ phase: 'error', message: 'authorization_request_timed_out' })
  expect(html).toContain('Sign-in didn')
  expect(html.split('authorization_request_timed_out').length - 1).toBe(1)
  expect(html).not.toContain('OAuth error')
  expect(html).toContain('Try again')
  expect(html).toContain('Cancel')
})

test('modal presentation drops the startup brand and steps; page keeps them', () => {
  const modal = renderToStaticMarkup(
    <StartupOAuth
      view={{ phase: 'waiting', url: null }}
      provider="openai"
      presentation="modal"
      onBegin={() => {}}
      onCancel={() => {}}
      onPasteCode={() => {}}
      onSubmitAlias={() => {}}
      onRetry={() => {}}
    />,
  )
  expect(modal).toContain('bg-scrim')
  expect(modal).not.toContain('cat code')
  expect(modal).not.toContain('>Trust<')
  const page = oauthHtml({ phase: 'waiting', url: null })
  expect(page).toContain('cat code')
  expect(page).toContain('>Trust<')
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
