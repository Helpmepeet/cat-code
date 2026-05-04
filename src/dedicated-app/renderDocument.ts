import type { DedicatedAppRuntimeState } from '../app-runtime/dedicatedAppState.js'

export function renderDedicatedAppDocument(
  state: DedicatedAppRuntimeState,
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(state.workspace.name)}</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #09090b;
        color: #f4f4f5;
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: #09090b; }
      .shell {
        display: grid;
        grid-template-columns: 280px minmax(0, 1fr) 320px;
        gap: 14px;
        min-height: 100vh;
        padding: 14px;
      }
      .stack { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
      .main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
      .header { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 320px); gap: 12px; }
      .split { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 12px; }
      .panels { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .card {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-width: 0;
        padding: 12px;
        border-radius: 10px;
        background: #111113;
        border: 1px solid rgba(255, 255, 255, 0.08);
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
      }
      .card-title { display: flex; flex-direction: column; gap: 3px; }
      .subtitle, .muted { color: #a1a1aa; font-size: 12px; line-height: 1.35; }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .list { display: flex; flex-direction: column; gap: 8px; }
      .tile {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px;
        border-radius: 10px;
        background: #18181b;
        border: 1px solid rgba(255, 255, 255, 0.07);
      }
      .selected { background: rgba(244, 114, 182, 0.14); border-color: rgba(244, 114, 182, 0.35); }
      .attention { background: rgba(251, 191, 36, 0.12); border-color: rgba(251, 191, 36, 0.24); }
      .pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 3px 8px;
        border-radius: 999px;
        background: rgba(244, 114, 182, 0.16);
        color: #f9a8d4;
        font-size: 11px;
        text-transform: capitalize;
        white-space: nowrap;
      }
      .pill.muted { background: rgba(255, 255, 255, 0.08); color: #d4d4d8; }
      .pill.attention { background: rgba(251, 191, 36, 0.16); color: #fbbf24; }
      .message {
        padding: 10px;
        border-radius: 10px;
        background: rgba(244, 114, 182, 0.08);
        border: 1px solid rgba(244, 114, 182, 0.16);
      }
      .speaker { color: #f9a8d4; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
      .text { color: #e4e4e7; font-size: 13px; line-height: 1.55; }
      .meta-label { color: #a1a1aa; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
      .meta-value { color: #e4e4e7; font-size: 12px; text-align: right; }
      @media (max-width: 1100px) {
        .shell { grid-template-columns: 1fr; }
        .header, .split { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="stack">
        ${section(
          state.workspace.name,
          state.workspace.localPathLabel,
          `<div class="list">
            ${metaRow('Focus', state.workspace.focusModeLabel)}
            ${metaRow('Boundary', state.boundaryPhase === 'ready' ? 'Connected to app-runtime' : 'Placeholder runtime state')}
          </div>`,
        )}
        ${section(
          'Sessions',
          `${state.sessions.length} local lanes`,
          `<div class="list">${state.sessions
            .map(session => {
              const selected = session.id === state.selectedSessionId
              return `<div class="tile ${selected ? 'selected' : ''}">
                <div class="row"><strong>${escapeHtml(session.title)}</strong>${pill(session.status, session.status === 'blocked' ? 'attention' : session.status === 'idle' ? 'muted' : 'neutral')}</div>
                <div class="text">${escapeHtml(session.summary)}</div>
                <div class="row"><span class="muted">${escapeHtml(session.lastEventLabel)}</span>${session.unreadCount ? pill(String(session.unreadCount), 'neutral') : ''}</div>
              </div>`
            })
            .join('')}</div>`,
        )}
      </aside>
      <main class="main">
        <header class="header">
          ${section(
            state.goal.title,
            state.goal.summary,
            `<div class="row">${pill(state.goal.progressLabel, 'neutral')}<span class="muted">placeholder</span></div>`,
          )}
          ${section(
            'Runtime status',
            state.runtime.summary,
            `<div class="list">${metaRow('State', state.runtime.status)}${metaRow('Detail', state.runtime.detail)}</div>`,
          )}
        </header>
        <div class="panels">
          ${state.panels
            .map(
              panel =>
                `<div class="tile ${panel.id === state.selectedPanelId ? 'selected' : panel.status === 'attention' ? 'attention' : ''}">
                  <strong>${escapeHtml(panel.label)}</strong>
                  <span class="muted">${escapeHtml(panel.detail)}</span>
                </div>`,
            )
            .join('')}
        </div>
        <div class="split">
          ${section(
            state.chatSurface.title,
            'Placeholder runtime transcript',
            `<div class="list">${state.chatSurface.messages
              .map(
                message =>
                  `<div class="message">
                    <div class="row"><strong class="speaker">${escapeHtml(message.speaker)}</strong><span class="muted">placeholder</span></div>
                    <div class="text">${escapeHtml(message.text)}</div>
                  </div>`,
              )
              .join('')}</div>`,
          )}
          ${section(
            state.workspaceSurface.title,
            state.workspaceSurface.summary,
            `<div class="list">${state.workspaceSurface.items
              .map(
                item =>
                  `<div class="tile ${item.kind === 'diff' ? 'attention' : ''}">
                    <div class="row"><strong>${escapeHtml(item.label)}</strong>${pill(item.kind, item.kind === 'diff' ? 'attention' : 'muted')}</div>
                    <div class="text">${escapeHtml(item.detail)}</div>
                  </div>`,
              )
              .join('')}</div>`,
          )}
        </div>
      </main>
      <aside class="stack">
        ${section(
          'Permissions',
          'Explicit queue, no backend assumptions',
          `<div class="list">${state.permissions
            .map(
              permission =>
                `<div class="tile ${permission.urgency === 'attention' ? 'attention' : ''}">
                  <div class="row"><strong>${escapeHtml(permission.title)}</strong>${pill(permission.scopeLabel, permission.urgency === 'attention' ? 'attention' : 'muted')}</div>
                  <div class="text">${escapeHtml(permission.summary)}</div>
                </div>`,
            )
            .join('')}</div>`,
        )}
        ${surfaceList('Agents', 'Worker visibility placeholder', state.agents)}
        ${surfaceList('Accounts', 'Usage/account placeholder', state.accounts)}
        ${surfaceList('Settings', 'Runtime settings placeholder', state.settings)}
      </aside>
    </div>
  </body>
</html>`
}

function section(title: string, subtitle: string, body: string): string {
  return `<section class="card"><div class="card-title"><strong>${escapeHtml(title)}</strong><span class="subtitle">${escapeHtml(subtitle)}</span></div>${body}</section>`
}

function metaRow(label: string, value: string): string {
  return `<div class="row"><span class="meta-label">${escapeHtml(label)}</span><span class="meta-value">${escapeHtml(value)}</span></div>`
}

function surfaceList(
  title: string,
  subtitle: string,
  items: DedicatedAppRuntimeState['agents'],
): string {
  return section(
    title,
    subtitle,
    `<div class="list">${items
      .map(
        item =>
          `<div class="tile ${item.tone === 'attention' ? 'attention' : ''}">
            <div class="row"><strong>${escapeHtml(item.label)}</strong>${pill(item.tone, item.tone)}</div>
            <div class="text">${escapeHtml(item.detail)}</div>
          </div>`,
      )
      .join('')}</div>`,
  )
}

function pill(
  label: string,
  tone: 'neutral' | 'muted' | 'attention',
): string {
  const toneClass = tone === 'neutral' ? '' : ` ${tone}`
  return `<span class="pill${toneClass}">${escapeHtml(label)}</span>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case "'":
        return '&#39;'
      default:
        return char
    }
  })
}
