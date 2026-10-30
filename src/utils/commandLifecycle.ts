type CommandLifecycleState = 'started' | 'completed'

type CommandLifecycleListener = (
  uuid: string,
  state: CommandLifecycleState,
  timestamp?: string,
) => void

let listener: CommandLifecycleListener | null = null

export function setCommandLifecycleListener(
  cb: CommandLifecycleListener | null,
): void {
  listener = cb
}

export function notifyCommandLifecycle(
  uuid: string,
  state: CommandLifecycleState,
  timestamp?: string,
): void {
  listener?.(uuid, state, timestamp)
}
