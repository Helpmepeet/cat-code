import type { SidecarAccountsDomain } from './accountsDomain.js'
import { ACCOUNT_CONTROL_VERSION, MAX_ACCOUNT_CONTROL_RECORD_BYTES, parseAccountControlVerb, type AccountControlEvent } from '../shared/accountControlWorker.js'
import { scanForSecrets } from '../shared/secretGuard.js'

/** No session/controller is constructed. The real account domain owns OAuth and writes. */
export async function serveAccountControl(
  input: AsyncIterable<Uint8Array>,
  domain: Pick<SidecarAccountsDomain, 'runVerb' | 'setOAuthProgressSink'>,
  publish: (event: AccountControlEvent) => Promise<void>,
): Promise<void> {
  let provider: 'openai' | 'anthropic' = 'openai'
  let output = Promise.resolve()
  const emit = (event: AccountControlEvent) => {
    if (!scanForSecrets(event).ok) throw new Error('account control output failed secret scan')
    output = output.then(() => publish(event))
    return output
  }
  domain.setOAuthProgressSink(progress => {
    void emit({ type: 'progress', version: ACCOUNT_CONTROL_VERSION, provider, progress })
  })
  let pending = Buffer.alloc(0)
  try {
    for await (const chunk of input) {
      pending = Buffer.concat([pending, chunk])
      let newline: number
      while ((newline = pending.indexOf(0x0a)) >= 0) {
        if (newline > MAX_ACCOUNT_CONTROL_RECORD_BYTES) throw new Error('account control request too large')
        const line = pending.subarray(0, newline)
        pending = pending.subarray(newline + 1)
        const verb = parseAccountControlVerb(JSON.parse(line.toString('utf8')))
        if (!verb) throw new Error('invalid account control request')
        const previousProvider: 'openai' | 'anthropic' = provider
        if (verb.type === 'account.login') provider = verb.provider ?? 'openai'
        const { result, poolChanged } = await domain.runVerb(verb)
        if (verb.type === 'account.login' && !result.ok) provider = previousProvider
        if (verb.type === 'account.oauthCancel' && result.ok) {
          await emit({ type: 'progress', version: ACCOUNT_CONTROL_VERSION, provider, progress: null })
        }
        await emit({ type: 'result', version: ACCOUNT_CONTROL_VERSION, requestId: verb.requestId, verb: verb.type, ...result, changed: poolChanged })
      }
      if (pending.byteLength > MAX_ACCOUNT_CONTROL_RECORD_BYTES) throw new Error('account control request too large')
    }
    if (pending.byteLength) throw new Error('incomplete account control request')
    await output
  } finally {
    await domain.runVerb({ type: 'account.oauthCancel', requestId: 'worker-close' })
  }
}
