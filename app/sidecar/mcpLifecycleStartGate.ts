export type SidecarMcpLifecycleStartGate = {
  onSocketReady(): void
  onWorkspaceTrusted(): void
}

export function createSidecarMcpLifecycleStartGate({
  isWorkspaceTrusted,
  start,
}: {
  isWorkspaceTrusted: boolean
  start: () => void
}): SidecarMcpLifecycleStartGate {
  let socketReady = false
  let workspaceTrusted = isWorkspaceTrusted
  let started = false

  const startIfReady = (): void => {
    if (started || !socketReady || !workspaceTrusted) return
    started = true
    start()
  }

  return {
    onSocketReady() {
      socketReady = true
      startIfReady()
    },
    onWorkspaceTrusted() {
      workspaceTrusted = true
      startIfReady()
    },
  }
}
