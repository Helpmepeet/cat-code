import type { DesktopProject } from '../../shared/projects.js'

export type ProjectsState = { projects: readonly DesktopProject[]; receivedLive: boolean }
export type ProjectsAction =
  | { type: 'baseline'; projects: readonly DesktopProject[] }
  | { type: 'snapshot'; projects: readonly DesktopProject[] }
  | { type: 'created'; project: DesktopProject }

export function createProjectsState(): ProjectsState { return { projects: [], receivedLive: false } }

export function reduceProjectsState(state: ProjectsState, action: ProjectsAction): ProjectsState {
  if (action.type === 'baseline') return state.receivedLive ? state : { projects: action.projects, receivedLive: false }
  if (action.type === 'snapshot') return { projects: action.projects, receivedLive: true }
  return { projects: [...state.projects.filter(project => project.id !== action.project.id && project.cwd !== action.project.cwd), action.project], receivedLive: true }
}
