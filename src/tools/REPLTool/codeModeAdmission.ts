import { isDeepStrictEqual } from 'node:util'
import type { ToolUseContext } from '../../Tool.js'
import { getEffectiveAutoMode } from '../../utils/permissions/permissions.js'

type PolicyCheck = () => boolean

const wrapperApprovals = new WeakMap<ToolUseContext, { input: object; policyIsCurrent: PolicyCheck }>()

export function captureCodeModePermissionPolicy(context: ToolUseContext): PolicyCheck {
  const policy = structuredClone(context.getAppState().toolPermissionContext)
  const mode = getEffectiveAutoMode(policy)
  return () => {
    const current = context.getAppState().toolPermissionContext
    return getEffectiveAutoMode(current) === mode && isDeepStrictEqual(current, policy)
  }
}

/** Called by tool execution only after the wrapper's final input has been authorized. */
export function bindCodeModeWrapperApproval(context: ToolUseContext, input: object, policyIsCurrent: PolicyCheck): void {
  wrapperApprovals.set(context, { input, policyIsCurrent })
}

/** This receipt covers the wrapper only. Every child has its own permission decision. */
export function consumeCodeModeWrapperApproval(context: ToolUseContext, input: object): PolicyCheck {
  const approved = wrapperApprovals.get(context)
  wrapperApprovals.delete(context)
  if (approved?.input !== input || !approved.policyIsCurrent()) {
    throw new Error('Script permission changed before execution. Submit the script again for a new decision.')
  }
  return approved.policyIsCurrent
}
