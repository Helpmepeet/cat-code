import http from 'node:http'
import https from 'node:https'
import { withClaudeCredentialSend, type ClaudeCredentialHandle } from './claudeAccountAuthority.js'
import { logForDebugging } from '../../utils/debug.js'

/** Fence the physical Node send, after Axios interceptors and adapter awaits. */
export function claudeAxiosCredentialOptions(handle: ClaudeCredentialHandle) {
  const captured = Object.freeze({ ...handle })
  return {
    adapter: 'http' as const,
    maxRedirects: 0,
    transport: {
      request(options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) {
        let started: http.ClientRequest | undefined
        try {
          withClaudeCredentialSend(captured, () => {
            started = (options.protocol === 'https:' ? https : http).request(options, callback)
            return started
          })
        } catch (error) {
          if (!started) throw error
          logForDebugging('Claude credential lock cleanup failed after authenticated send', { level: 'warn' })
        }
        if (!started) throw new Error('The saved Claude credential is no longer available')
        return started
      },
    },
  }
}
