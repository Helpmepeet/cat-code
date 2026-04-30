export function isProactiveActive(): boolean {
  return false
}

export function subscribeToProactiveChanges(_cb: () => void): () => void {
  return () => {}
}

export function pauseProactive(): void {}

export function resumeProactive(): void {}

export function isProactivePaused(): boolean {
  return false
}

export function setContextBlocked(_blocked: boolean): void {}

export function getNextTickAt(): number | null {
  return null
}

export function activateProactive(_source?: string): void {}

export function deactivateProactive(): void {}
