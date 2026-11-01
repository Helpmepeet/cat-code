// contextBridge may erase Error subclasses. These exact control-guard messages
// are emitted before ipcRenderer.send; all other exceptions remain uncertain.
const localRefusals = new Set([
  'Could not send this request. Try again.',
  'This request is too large to send.',
  'This request is too large. Try sending less text or fewer attachments.',
  'Too many requests at once. Wait a moment and try again.',
  'No active session',
])

export function isDefiniteLocalSendRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'message' in error &&
    typeof error.message === 'string' && localRefusals.has(error.message)
}
