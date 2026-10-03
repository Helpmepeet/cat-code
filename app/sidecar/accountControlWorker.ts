import { MAX_ACCOUNT_CONTROL_RECORD_BYTES } from '../shared/accountControlWorker.js'
import { bootstrapWorkerEngine, emitWorkerRecord, runDisposableWorker } from './workerRuntime.js'
import { serveAccountControl } from './accountControlSession.js'

// Normal auth discovery, without init(), hooks, MCP clients, or a chat session.
process.env.CLAUDE_CODE_SIMPLE = ''

async function main(): Promise<void> {
  const [{ createSidecarAccountsDomain }, codex, anthropic, providers] = await Promise.all([
    import('./accountsDomain.js'),
    import('../../src/services/api/codexAccountPool.js'),
    import('../../src/services/api/claudeAccountPool.js'),
    import('../../src/utils/model/providers.js'),
  ])
  await bootstrapWorkerEngine()
  await codex.loadPoolForObservation()
  anthropic.loadClaudePoolForObservation()
  const domain = createSidecarAccountsDomain({
    onProviderActivated: provider => providers.persistStartupProviderPreference(
      provider === 'openai' ? 'openai' : providers.getConfiguredAnthropicProvider(),
    ),
  })
  await serveAccountControl(process.stdin, {
    setOAuthProgressSink: sink => domain.setOAuthProgressSink(sink),
    async runVerb(verb) {
      if (verb.type === 'account.login') {
        // Dedicated delete/sign-out workers can change inventory while idle.
        await codex.loadPoolForObservation()
        anthropic.loadClaudePoolForObservation()
      }
      return domain.runVerb(verb)
    },
  }, event =>
    emitWorkerRecord(event, MAX_ACCOUNT_CONTROL_RECORD_BYTES, 'account control result'),
  )
  process.exit(0)
}

runDisposableWorker('account-control', main)
