/**
 * Settings → Workspace section (P4-14), rebuilt from the prototype's
 * `WorkspaceTrustSection` (`Pages.jsx:789`) on the P0-2 tokens + P4-3's
 * `Field`/`PaneSection` primitives. Read-only VIEW: trust/repo come from the
 * `workspace-trust.snapshot` seam; "Additional trusted directories" is the
 * SAME `additionalWorkingDirectories` the C3 permission context already
 * carries (§10 — no second seam for the same data). The Untrust/Trust mutate
 * action is P4-15's session-create trust gate — this renders the badge only.
 */

import type { PermissionContextSnapshot, WorkspaceTrustSnapshot } from '../../shared/protocol.js'
import { Field, PaneSection } from './SettingsField.js'

export function WorkspaceTrustSection({
  additionalWorkingDirectories,
  cwd,
  snapshot,
}: {
  additionalWorkingDirectories: PermissionContextSnapshot['additionalWorkingDirectories']
  cwd: string | null
  snapshot: WorkspaceTrustSnapshot | null
}) {
  return (
    <>
      <PaneSection title="Trust">
        <Field
          desc={
            snapshot
              ? snapshot.trusted
                ? 'Tools, plugins, and file access are enabled for this workspace'
                : 'Read-only: tools and file access are blocked for this workspace'
              : "Waiting for the engine's workspace-trust snapshot…"
          }
          label="Trust state"
        >
          <div className="flex items-center gap-2">
            {snapshot ? (
              <span
                className={`inline-flex items-center rounded-[5px] border px-1.5 py-px font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em] ${
                  snapshot.trusted
                    ? 'border-tone-success/25 bg-tone-success/10 text-tone-success'
                    : 'border-tone-danger/25 bg-tone-danger/10 text-tone-danger'
                }`}
              >
                {snapshot.trusted ? 'Trusted' : 'Untrusted'}
              </span>
            ) : null}
            <button
              className="cursor-not-allowed rounded-md border border-shell-seam px-2.5 py-1 text-[11px] text-text-subtle"
              disabled
              title="Trust changes at session-create time (P4-15) — not wired here"
              type="button"
            >
              {snapshot?.trusted ? 'Untrust' : 'Trust'}
            </button>
          </div>
        </Field>
        <Field desc="Root of the active workspace" label="Working directory">
          <code className="rounded-[5px] bg-shell-hover px-2 py-0.5 font-mono text-[12px] text-text-muted">
            {cwd ?? '—'}
          </code>
        </Field>
        <Field desc="Git remote origin" label="Detected repo">
          <code className="rounded-[5px] bg-shell-hover px-2 py-0.5 font-mono text-[12px] text-text-muted">
            {snapshot?.detectedRepo ?? 'none'}
          </code>
        </Field>
      </PaneSection>

      <PaneSection title="Additional trusted directories">
        <p className="mb-2 text-[11.5px] text-text-subtle">
          Directories outside the workspace tools may access (`--add-dir` and
          `permissions.additionalDirectories`).
        </p>
        {additionalWorkingDirectories.length === 0 ? (
          <p className="text-[12px] italic text-text-subtle">None added</p>
        ) : (
          <div className="flex flex-col gap-1">
            {additionalWorkingDirectories.map(entry => (
              <div
                className="flex items-center justify-between rounded-md bg-shell-hover px-2 py-1"
                key={entry.path}
              >
                <code className="font-mono text-[12px] text-text-muted">{entry.path}</code>
                <span className="text-[10.5px] text-text-subtle">{entry.source}</span>
              </div>
            ))}
          </div>
        )}
      </PaneSection>
    </>
  )
}
