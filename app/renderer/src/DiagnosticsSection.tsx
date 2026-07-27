/**
 * Settings → Diagnostics section (P4-14), adapted from the prototype's
 * `DiagnosticsSection` (`Pages.jsx:831`) on the P0-2 tokens + P4-3's
 * `Field`/`PaneSection` primitives — mirroring `/doctor` + `/status`
 * (`src/utils/status.tsx`, `src/utils/doctorDiagnostic.ts`) via the
 * `diagnostics.snapshot` seam. NO demo/prototype-controls stub: every row
 * below is real engine data, degrading to a real "waiting"/"none" state
 * rather than a fixture.
 *
 * "Setting sources" is deliberately NOT re-read here — it is derived from the
 * ALREADY-CROSSING `settings.snapshot` (`snapshot.layers`, §10). The
 * prototype's Account/Login/IDE/MCP `/status` rows are not modeled: no read-
 * seam exists yet for IDE/MCP client state, and account status already has
 * its own real page (`AccountsPage.tsx`, P4-5) — duplicating it here would be
 * the §10 anti-pattern, not a parity gap.
 */

import type { DiagnosticsSnapshot, SettingsSnapshot } from '../../shared/protocol.js'
import { Field, PaneSection } from './SettingsField.js'
import { SOURCE_LABEL } from './settingsFieldModel.js'
import { SETTING_SOURCE_PRECEDENCE } from './settingsState.js'

function WarningList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-tone-success/15 bg-tone-success/6 px-2.5 py-1.5 text-[12px] text-tone-success">
        <CheckIcon />
        No issues found
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((item, index) => (
        <div
          className="rounded-lg border border-tone-warn/20 bg-tone-warn/5 px-2.5 py-1.5 text-[11.5px] text-tone-warn"
          // Warning strings are not guaranteed unique — pair with the index.
          key={`${index}:${item}`}
        >
          {item}
        </div>
      ))}
    </div>
  )
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-[11px] w-[11px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.8"
      viewBox="0 0 24 24"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

export function DiagnosticsSection({
  settingsSnapshot,
  snapshot,
}: {
  settingsSnapshot: SettingsSnapshot | null
  snapshot: DiagnosticsSnapshot | null
}) {
  if (!snapshot) {
    return (
      <p className="text-[12.5px] text-text-subtle">
        Waiting for the engine's diagnostics snapshot…
      </p>
    )
  }

  return (
    <>
      <PaneSection title="Installation">
        <WarningList items={snapshot.installationWarnings} />
      </PaneSection>

      <PaneSection title="Health">
        <WarningList items={snapshot.healthWarnings} />
      </PaneSection>

      <PaneSection title="Context usage">
        <WarningList items={snapshot.memoryWarnings} />
      </PaneSection>

      <PaneSection title="Sandbox">
        <Field desc="Bash tool sandboxing for this session" label="Bash sandbox">
          <span
            className={`font-mono text-[12.5px] ${
              snapshot.sandboxEnabled ? 'text-tone-success' : 'text-text-subtle'
            }`}
          >
            {snapshot.sandboxEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </Field>
      </PaneSection>

      <PaneSection title="Status">
        <Field label="Version">
          <span className="font-mono text-[12.5px] text-text-muted">{snapshot.version}</span>
        </Field>
        <Field label="Model">
          <span className="font-mono text-[12.5px] text-text-muted">
            {snapshot.mainLoopModel ?? 'Default'}
          </span>
        </Field>
        <Field desc="Enabled layers, highest-precedence first" label="Setting sources">
          <span className="font-mono text-[12.5px] text-text-muted">
            {settingsSnapshot && settingsSnapshot.layers.length > 0
              ? [...settingsSnapshot.layers]
                  .sort(
                    (a, b) =>
                      SETTING_SOURCE_PRECEDENCE.indexOf(a.source) -
                      SETTING_SOURCE_PRECEDENCE.indexOf(b.source),
                  )
                  .map(layer => SOURCE_LABEL[layer.source])
                  .join(', ')
              : 'none'}
          </span>
        </Field>
      </PaneSection>
    </>
  )
}
