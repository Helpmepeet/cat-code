import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { StartupOAuth, WorkspaceTrustGate } from './StartupSurfaces.js'

/* ── trust gate ────────────────────────────────────────────────────────────── */

test('trust gate shows the title, the session cwd, and the two ruled actions', () => {
  const html = renderToStaticMarkup(
    <WorkspaceTrustGate cwd="/Users/me/proj" onTrust={() => {}} onDecline={() => {}} />,
  )
  expect(html).toContain('Trust this workspace?')
  expect(html).toContain('/Users/me/proj')
  expect(html).toContain('Trust required')
  expect(html).toContain('Trust workspace')
  // Decline = don't open (Q1 TUI parity).
  expect(html).toContain('Don&#x27;t open')
})

test('trust gate surfaces an ok:false accept error inline (not a silent no-op)', () => {
  const html = renderToStaticMarkup(
    <WorkspaceTrustGate
      cwd="/x"
      onTrust={() => {}}
      onDecline={() => {}}
      errorMessage="Trust write did not persist; the workspace is still untrusted."
    />,
  )
  expect(html).toContain('role="alert"')
  expect(html).toContain('Trust write did not persist')
})

test('trust gate shows no alert when there is no error', () => {
  const html = renderToStaticMarkup(
    <WorkspaceTrustGate cwd="/x" onTrust={() => {}} onDecline={() => {}} />,
  )
  expect(html).not.toContain('role="alert"')
})

test('trust gate has NO read-only affordance (Q1 CUT)', () => {
  const html = renderToStaticMarkup(
    <WorkspaceTrustGate cwd="/x" onTrust={() => {}} onDecline={() => {}} />,
  )
  expect(html).not.toContain('read-only')
  expect(html).not.toContain('Open read-only')
  expect(html.toLowerCase()).not.toContain('read only')
  // Not a workspace-switch prompt either (G4 CUT).
  expect(html).not.toContain('Workspace changed')
})

/* ── first-run OAuth ───────────────────────────────────────────────────────── */

test('OAuth ready phase shows the Codex provider card + browser handoff button', () => {
  const html = renderToStaticMarkup(
    <StartupOAuth phase="ready" onBegin={() => {}} onCancel={() => {}} />,
  )
  expect(html).toContain('Sign in with Codex')
  expect(html).toContain('Codex · ChatGPT subscription')
  expect(html).toContain('Open browser to sign in')
})

test('OAuth waiting phase shows the browser-authorization wait + a cancel', () => {
  const html = renderToStaticMarkup(
    <StartupOAuth phase="waiting" onBegin={() => {}} onCancel={() => {}} />,
  )
  expect(html).toContain('Continue in your browser')
  expect(html).toContain('Waiting for browser authorization')
  expect(html).toContain('Cancel')
})

test('OAuth surface has no "Simulate failure" demo control (prototype DEMO CUT)', () => {
  const ready = renderToStaticMarkup(
    <StartupOAuth phase="ready" onBegin={() => {}} onCancel={() => {}} />,
  )
  const waiting = renderToStaticMarkup(
    <StartupOAuth phase="waiting" onBegin={() => {}} onCancel={() => {}} />,
  )
  expect(ready).not.toContain('Simulate failure')
  expect(waiting).not.toContain('Simulate failure')
})
