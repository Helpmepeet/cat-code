/** The same bounded choices are used by plan cards and native notifications. */
export type PlanApprovalMode = 'default' | 'acceptEdits'

export type PlanApprovalOption = {
  mode: PlanApprovalMode
  label: string
  description: string
}

export const PLAN_APPROVE_OPTIONS: PlanApprovalOption[] = [
  {
    mode: 'acceptEdits',
    label: 'Approve & auto-accept edits',
    description: 'Run the plan, applying edits automatically.',
  },
  {
    mode: 'default',
    label: 'Approve & ask per edit',
    description: 'Run, but confirm each edit/command.',
  },
]
