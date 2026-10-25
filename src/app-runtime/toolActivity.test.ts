import { expect, spyOn, test } from 'bun:test'
import { AppSessionController } from './AppSessionController.js'
import { recordToolActivity, recordToolTimeout } from './toolActivity.js'
import type { AppSessionEvent } from './sessionEvents.js'
import { normalizeMessage } from '../utils/queryHelpers.js'
import { createProgressMessage } from '../utils/messages.js'

test('turn-scoped activity delivers phases and bounded Bash output on the ordinary session subscription', async () => {
  let now = 10000
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  const events: AppSessionEvent[] = []
  const controller = new AppSessionController({
    async *runTurn() {
      recordToolActivity('command', 'reviewing')
      now += 30000
      recordToolActivity('command', 'executing')
      recordToolTimeout('command', 120000)
      const output = (text: string) => [...normalizeMessage(createProgressMessage({ toolUseID: 'progress', parentToolUseID: 'command', data: {
        type: 'bash_progress', output: text, fullOutput: text, totalLines: 1000000, totalBytes: 50000, elapsedTimeSeconds: 2,
      } }))]
      output('😺'.repeat(10000) + '\nraw newest line')
      output('throttled')
      now += 1000
      output('next line')
    },
  })
  controller.subscribe(event => events.push(event))
  try {
    await controller.submit('check')
    const activity = events.filter(event => event.type === 'tool.activity')
    expect(activity).toHaveLength(4)
    expect(activity[0]).toMatchObject({ toolUseId: 'command', phase: 'reviewing', startedAt: 10000 })
    expect(activity[1]).toMatchObject({ phase: 'executing', startedAt: 40000 })
    const firstOutput = activity[2]!
    expect(firstOutput.output?.endsWith('raw newest line')).toBe(true)
    expect(Buffer.byteLength(firstOutput.output!)).toBeLessThanOrEqual(2048)
    expect(firstOutput.output).not.toContain('�')
    expect(firstOutput).toMatchObject({ totalLines: 1000000, timeoutMs: 120000, startedAt: 40000 })
    expect(activity[3]).toMatchObject({ output: 'next line', startedAt: 40000 })
    recordToolActivity('outside', 'executing')
    expect(events.filter(event => event.type === 'tool.activity')).toHaveLength(4)
  } finally { clock.mockRestore() }
})
