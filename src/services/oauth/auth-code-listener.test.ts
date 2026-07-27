import { expect, test } from 'bun:test'

import { AuthCodeListener } from './auth-code-listener.js'

test('closing a pending OAuth listener rejects its authorization wait', async () => {
  const listener = new AuthCodeListener()
  await listener.start()
  const pending = listener.waitForAuthorization('expected-state', async () => {})

  listener.close()

  await expect(pending).rejects.toThrow('OAuth login cancelled')
})
