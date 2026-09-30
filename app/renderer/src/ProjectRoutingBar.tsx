import type { ProjectRouteChoice, ProjectRouteSnapshot } from '../../shared/projectRouting.js'
import './ProjectRoutingBar.css'

export function ProjectRoutingBar({
  route,
  onChoice,
}: {
  route: ProjectRouteSnapshot
  onChoice?: (choice: ProjectRouteChoice) => void
}) {
  const projectName = route.projectName ?? 'project'
  const warning = route.phase === 'uncertain' || route.phase === 'failed' || route.phase === 'unsent'
  const choices: { label: string; choice: ProjectRouteChoice; primary?: boolean }[] = []
  let text
  switch (route.phase) {
    case 'checking':
      text = <>Finding project…</>
      choices.push({ label: 'Cancel', choice: 'cancel' })
      break
    case 'ask':
      text = <>Work in <b>{projectName}</b>?</>
      choices.push({ label: 'Stay in chat', choice: 'stay' }, { label: 'Move', choice: 'move', primary: true })
      break
    case 'moving':
      text = <>Moving to <b>{projectName}</b></>
      break
    case 'recovery':
      text = <>Sending message…</>
      break
    case 'unsent':
      text = <>This message has not been sent.</>
      choices.push({ label: 'Send', choice: 'resend', primary: true }, { label: 'Cancel', choice: 'cancel' })
      break
    case 'uncertain':
      text = <>Check the conversation before sending again. This message may already have been sent.</>
      choices.push({ label: 'Send again', choice: 'resend', primary: true }, { label: 'Dismiss', choice: 'cancel' })
      break
    case 'failed':
      text = <>Could not move to <b>{projectName}</b>.</>
      choices.push({ label: 'Stay in chat', choice: 'stay' }, { label: 'Cancel', choice: 'cancel' })
      break
  }

  return (
    <div className={`project-routing-bar${warning ? ' project-routing-bar-warning' : ''}`}>
      {route.phase === 'moving' ? <span className="project-routing-progress" aria-hidden="true" /> : null}
      <svg
        aria-hidden="true"
        className="project-routing-folder"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2V9" />
        <path d="M2 12h18.5a1.5 1.5 0 0 1 1.45 1.9l-1.3 4.8A2 2 0 0 1 18.7 20H4" />
      </svg>
      <div className="project-routing-text" role="status" aria-atomic="true">
        <span>{text}</span>
        {route.message && (route.phase === 'recovery' || warning) ? (
          <span className="project-routing-detail">{route.message.slice(0, 500)}</span>
        ) : null}
      </div>
      {choices.length > 0 ? (
        <div className="project-routing-actions">
          {choices.map(({ label, choice, primary }) => (
            <button
              key={choice}
              type="button"
              className={`project-routing-button${primary ? ' project-routing-button-primary' : ''}`}
              disabled={!onChoice}
              onClick={() => onChoice?.(choice)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
