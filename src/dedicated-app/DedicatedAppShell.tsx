import type { CSSProperties, ReactNode } from 'react'

import type {
  DedicatedAppRuntimeController,
  DedicatedAppRuntimeState,
  PermissionDecision,
  PermissionRequestPlaceholder,
  SessionSummary,
  SurfacePlaceholderItem,
  WorkspaceItemPlaceholder,
} from '../app-runtime/dedicatedAppState.js'
import {
  dedicatedAppPlaceholderController,
  dedicatedAppPlaceholderState,
} from './placeholderState.js'

export type DedicatedAppShellProps = {
  state: DedicatedAppRuntimeState
  controller: DedicatedAppRuntimeController
}

export function DedicatedAppShell({
  state,
  controller,
}: DedicatedAppShellProps): ReactNode {
  const selectedSession =
    state.sessions.find(session => session.id === state.selectedSessionId) ??
    state.sessions[0]
  const selectedPanel =
    state.panels.find(panel => panel.id === state.selectedPanelId) ??
    state.panels[0]
  const actionsReady = state.runtime.actionsReady

  return (
    <div style={shellStyle}>
      <aside style={sidebarStyle}>
        <SectionCard
          title={state.workspace.name}
          subtitle={state.workspace.localPathLabel}
        >
          <div style={metaStackStyle}>
            <MetaRow label="Focus" value={state.workspace.focusModeLabel} />
            <MetaRow
              label="Boundary"
              value={
                state.boundaryPhase === 'ready'
                  ? 'Connected to app-runtime'
                  : 'Placeholder runtime state'
              }
            />
          </div>
        </SectionCard>

        <SectionCard
          title="Sessions"
          subtitle={`${state.sessions.length} local lanes`}
        >
          <div style={listStyle}>
            {state.sessions.map(session => {
              const selected = session.id === selectedSession?.id

              return (
                <button
                  key={session.id}
                  type="button"
                  disabled={!actionsReady}
                  onClick={() => controller.openSession(session.id)}
                  style={sessionButtonStyle(selected, !actionsReady)}
                >
                  <div style={rowSpaceStyle}>
                    <strong style={sessionTitleStyle}>{session.title}</strong>
                    <StatusPill label={session.status} tone={toneForSession(session)} />
                  </div>
                  <div style={sessionSummaryStyle}>{session.summary}</div>
                  <div style={rowSpaceStyle}>
                    <span style={mutedTextStyle}>{session.lastEventLabel}</span>
                    {typeof session.unreadCount === 'number' ? (
                      <span style={countBadgeStyle}>{session.unreadCount}</span>
                    ) : null}
                  </div>
                </button>
              )
            })}
          </div>
        </SectionCard>

        <SectionCard title="Navigation" subtitle="Runtime-owned destinations">
          <div style={actionGridStyle}>
            <ActionButton
              label="Agents"
              detail="Workers"
              disabled={!actionsReady}
              onClick={() => controller.openAgents()}
            />
            <ActionButton
              label="Accounts"
              detail="Usage"
              disabled={!actionsReady}
              onClick={() => controller.openAccounts()}
            />
            <ActionButton
              label="Settings"
              detail="Runtime"
              disabled={!actionsReady}
              onClick={() => controller.openSettings()}
            />
          </div>
        </SectionCard>
      </aside>

      <main style={mainStyle}>
        <header style={headerStyle}>
          <SectionCard title={state.goal.title} subtitle={state.goal.summary}>
            <div style={rowSpaceStyle}>
              <StatusPill label={state.goal.progressLabel} tone="neutral" />
              <button
                type="button"
                disabled={!actionsReady}
                onClick={() => controller.focusGoal()}
                style={inlineActionStyle(!actionsReady)}
              >
                Focus goal
              </button>
            </div>
          </SectionCard>
          <SectionCard title="Runtime status" subtitle={state.runtime.summary}>
            <div style={metaStackStyle}>
              <MetaRow label="State" value={state.runtime.status} />
              <MetaRow label="Detail" value={state.runtime.detail} />
            </div>
          </SectionCard>
        </header>

        <div style={panelRailStyle}>
          {state.panels.map(panel => {
            const selected = panel.id === selectedPanel?.id

            return (
              <button
                key={panel.id}
                type="button"
                disabled={!actionsReady}
                onClick={() => controller.selectPanel(panel.id)}
                style={panelButtonStyle(selected, panel.status, !actionsReady)}
              >
                <strong>{panel.label}</strong>
                <span style={mutedTextStyle}>{panel.detail}</span>
              </button>
            )
          })}
        </div>

        <div style={workspaceSplitStyle}>
          <SectionCard
            title={state.chatSurface.title}
            subtitle={selectedSession?.title ?? 'No session selected'}
          >
            <div style={listStyle}>
              {state.chatSurface.messages.map(message => (
                <div key={message.id} style={messageCardStyle}>
                  <div style={rowSpaceStyle}>
                    <strong style={speakerStyle}>{message.speaker}</strong>
                    <span style={mutedTextStyle}>placeholder</span>
                  </div>
                  <div style={messageTextStyle}>{message.text}</div>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard
            title={state.workspaceSurface.title}
            subtitle={state.workspaceSurface.summary}
          >
            <div style={listStyle}>
              {state.workspaceSurface.items.map(item => (
                <WorkspaceItemCard key={item.id} item={item} />
              ))}
            </div>
          </SectionCard>
        </div>
      </main>

      <aside style={railStyle}>
        <SectionCard
          title="Permissions"
          subtitle="Explicit queue, no backend assumptions"
        >
          <div style={listStyle}>
            {state.permissions.map(permission => (
              <PermissionCard
                key={permission.id}
                permission={permission}
                disabled={!actionsReady}
                onReview={decision =>
                  controller.reviewPermission(permission.id, decision)
                }
              />
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Agents" subtitle="Worker visibility placeholder">
          <SurfaceItemList items={state.agents} />
        </SectionCard>

        <SectionCard title="Accounts" subtitle="Usage/account placeholder">
          <SurfaceItemList items={state.accounts} />
        </SectionCard>

        <SectionCard title="Settings" subtitle="Runtime settings placeholder">
          <SurfaceItemList items={state.settings} />
        </SectionCard>
      </aside>
    </div>
  )
}

export function DedicatedAppShellScaffold(): ReactNode {
  return (
    <DedicatedAppShell
      state={dedicatedAppPlaceholderState}
      controller={dedicatedAppPlaceholderController}
    />
  )
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: ReactNode
}): ReactNode {
  return (
    <section style={cardStyle}>
      <div style={sectionHeaderStyle}>
        <strong>{title}</strong>
        <span style={sectionSubtitleStyle}>{subtitle}</span>
      </div>
      {children}
    </section>
  )
}

function MetaRow({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div style={rowSpaceStyle}>
      <span style={metaLabelStyle}>{label}</span>
      <span style={metaValueStyle}>{value}</span>
    </div>
  )
}

function StatusPill({
  label,
  tone,
}: {
  label: string
  tone: 'neutral' | 'muted' | 'attention'
}): ReactNode {
  return <span style={statusPillStyle(tone)}>{label}</span>
}

function ActionButton({
  label,
  detail,
  disabled,
  onClick,
}: {
  label: string
  detail: string
  disabled: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={actionButtonStyle(disabled)}
    >
      <strong>{label}</strong>
      <span style={mutedTextStyle}>{detail}</span>
    </button>
  )
}

function WorkspaceItemCard({
  item,
}: {
  item: WorkspaceItemPlaceholder
}): ReactNode {
  return (
    <div style={surfaceItemCardStyle(item.kind === 'diff' ? 'attention' : 'neutral')}>
      <div style={rowSpaceStyle}>
        <strong>{item.label}</strong>
        <StatusPill
          label={item.kind}
          tone={item.kind === 'diff' ? 'attention' : 'muted'}
        />
      </div>
      <div style={surfaceDetailStyle}>{item.detail}</div>
    </div>
  )
}

function PermissionCard({
  permission,
  disabled,
  onReview,
}: {
  permission: PermissionRequestPlaceholder
  disabled: boolean
  onReview: (decision: PermissionDecision) => void
}): ReactNode {
  return (
    <div
      style={surfaceItemCardStyle(
        permission.urgency === 'attention' ? 'attention' : 'neutral',
      )}
    >
      <div style={rowSpaceStyle}>
        <strong>{permission.title}</strong>
        <StatusPill
          label={permission.scopeLabel}
          tone={permission.urgency === 'attention' ? 'attention' : 'muted'}
        />
      </div>
      <div style={surfaceDetailStyle}>{permission.summary}</div>
      <div style={permissionButtonRowStyle}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onReview('approve')}
          style={inlineActionStyle(disabled)}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onReview('later')}
          style={inlineActionStyle(disabled)}
        >
          Later
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onReview('deny')}
          style={inlineActionStyle(disabled)}
        >
          Deny
        </button>
      </div>
    </div>
  )
}

function SurfaceItemList({
  items,
}: {
  items: SurfacePlaceholderItem[]
}): ReactNode {
  return (
    <div style={listStyle}>
      {items.map(item => (
        <div key={item.id} style={surfaceItemCardStyle(item.tone)}>
          <div style={rowSpaceStyle}>
            <strong>{item.label}</strong>
            <StatusPill label={item.tone} tone={item.tone} />
          </div>
          <div style={surfaceDetailStyle}>{item.detail}</div>
        </div>
      ))}
    </div>
  )
}

function toneForSession(
  session: SessionSummary,
): 'neutral' | 'muted' | 'attention' {
  if (session.status === 'blocked') return 'attention'
  if (session.status === 'idle') return 'muted'
  return 'neutral'
}

const shellStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '280px minmax(0, 1fr) 320px',
  gap: 14,
  minHeight: '100vh',
  padding: 14,
  background: '#09090b',
  color: '#f4f4f5',
  boxSizing: 'border-box',
  fontFamily:
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
}

const sidebarStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minWidth: 0,
}

const mainStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minWidth: 0,
}

const railStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minWidth: 0,
}

const headerStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 320px)',
  gap: 12,
}

const workspaceSplitStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)',
  gap: 12,
  flex: 1,
  minHeight: 0,
}

const panelRailStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 10,
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  minWidth: 0,
  padding: 12,
  borderRadius: 10,
  background: '#111113',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  boxShadow: '0 18px 40px rgba(0, 0, 0, 0.28)',
}

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
}

const sectionSubtitleStyle: CSSProperties = {
  color: '#a1a1aa',
  fontSize: 12,
  lineHeight: 1.35,
}

const rowSpaceStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const metaStackStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
}

const metaLabelStyle: CSSProperties = {
  color: '#a1a1aa',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
}

const metaValueStyle: CSSProperties = {
  color: '#e4e4e7',
  fontSize: 12,
  textAlign: 'right',
}

const mutedTextStyle: CSSProperties = {
  color: '#a1a1aa',
  fontSize: 12,
}

const sessionTitleStyle: CSSProperties = {
  fontSize: 13,
}

const sessionSummaryStyle: CSSProperties = {
  color: '#d4d4d8',
  fontSize: 12,
  lineHeight: 1.45,
}

const countBadgeStyle: CSSProperties = {
  minWidth: 22,
  padding: '2px 7px',
  borderRadius: 999,
  background: 'rgba(244, 114, 182, 0.16)',
  color: '#f9a8d4',
  fontSize: 11,
  textAlign: 'center',
}

const messageCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
  padding: 10,
  borderRadius: 10,
  background: 'rgba(244, 114, 182, 0.08)',
  border: '1px solid rgba(244, 114, 182, 0.16)',
}

const speakerStyle: CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#f9a8d4',
}

const messageTextStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.55,
  color: '#e4e4e7',
}

const surfaceDetailStyle: CSSProperties = {
  color: '#d4d4d8',
  fontSize: 12,
  lineHeight: 1.45,
}

const permissionButtonRowStyle: CSSProperties = {
  display: 'flex',
  gap: 7,
  flexWrap: 'wrap',
}

const actionGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 8,
}

function sessionButtonStyle(selected: boolean, disabled: boolean): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    width: '100%',
    padding: 10,
    borderRadius: 10,
    textAlign: 'left',
    color: 'inherit',
    background: selected ? 'rgba(244, 114, 182, 0.14)' : '#18181b',
    border: selected
      ? '1px solid rgba(244, 114, 182, 0.35)'
      : '1px solid rgba(255, 255, 255, 0.07)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1,
  }
}

function panelButtonStyle(
  selected: boolean,
  status: DedicatedAppRuntimeState['panels'][number]['status'],
  disabled: boolean,
): CSSProperties {
  const borderColor =
    status === 'attention'
      ? 'rgba(251, 191, 36, 0.35)'
      : selected
        ? 'rgba(244, 114, 182, 0.35)'
        : 'rgba(255, 255, 255, 0.08)'

  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    width: '100%',
    padding: 10,
    borderRadius: 10,
    border: `1px solid ${borderColor}`,
    background: selected ? 'rgba(244, 114, 182, 0.12)' : '#18181b',
    color: 'inherit',
    textAlign: 'left',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1,
  }
}

function actionButtonStyle(disabled: boolean): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    width: '100%',
    padding: 10,
    borderRadius: 10,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: '#18181b',
    color: 'inherit',
    textAlign: 'left',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1,
  }
}

function inlineActionStyle(disabled: boolean): CSSProperties {
  return {
    padding: '7px 9px',
    borderRadius: 9,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: '#18181b',
    color: '#e4e4e7',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1,
  }
}

function surfaceItemCardStyle(
  tone: 'neutral' | 'muted' | 'attention',
): CSSProperties {
  const palette =
    tone === 'attention'
      ? {
          background: 'rgba(251, 191, 36, 0.12)',
          border: 'rgba(251, 191, 36, 0.24)',
        }
      : tone === 'muted'
        ? {
            background: '#18181b',
            border: 'rgba(255, 255, 255, 0.07)',
          }
        : {
            background: 'rgba(244, 114, 182, 0.08)',
            border: 'rgba(244, 114, 182, 0.16)',
          }

  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    padding: 10,
    borderRadius: 10,
    background: palette.background,
    border: `1px solid ${palette.border}`,
  }
}

function statusPillStyle(
  tone: 'neutral' | 'muted' | 'attention',
): CSSProperties {
  const palette =
    tone === 'attention'
      ? {
          background: 'rgba(251, 191, 36, 0.16)',
          color: '#fbbf24',
        }
      : tone === 'muted'
        ? {
            background: 'rgba(255, 255, 255, 0.08)',
            color: '#d4d4d8',
          }
        : {
            background: 'rgba(244, 114, 182, 0.16)',
            color: '#f9a8d4',
          }

  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '3px 8px',
    borderRadius: 999,
    background: palette.background,
    color: palette.color,
    fontSize: 11,
    textTransform: 'capitalize',
    whiteSpace: 'nowrap',
  }
}
