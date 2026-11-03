import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import axios from 'axios'
import { BridgeFatalError, createBridgeApiClient, type BridgeOAuthIdentity } from './bridgeApi.js'

const config = { bridgeId: 'bridge-id', machineName: 'isolated', dir: '/isolated', maxSessions: 1 }
afterEach(() => mock.restore())

test.each(['revision', 'selection', 'login'])('bridge delayed 401 binds repair and replay across %s', async change => {
  let token = 'original'
  let identity: BridgeOAuthIdentity = { accountId: 'a', generation: 1, revision: 0 }
  const first = Promise.withResolvers<{ status: number; data: object }>()
  const sent: string[] = []
  spyOn(axios, 'post').mockImplementation(async (_url, _body, options) => {
    sent.push(options!.headers!.Authorization as string)
    return (sent.length === 1 ? first.promise : { status: 200, data: { environment_id: 'env-id', environment_secret: 'secret' } }) as never
  })
  const recover = mock(async (failedToken: string, captured?: BridgeOAuthIdentity) => {
    expect(failedToken).toBe('original')
    expect(captured).toEqual({ accountId: 'a', generation: 1, revision: 0 })
    return true
  })
  const client = createBridgeApiClient({
    baseUrl: 'https://isolated.invalid', runnerVersion: 'test', getAccessToken: () => token,
    captureAuthIdentity: () => identity, onAuth401: recover,
  })
  const pending = client.registerBridgeEnvironment(config as never)
  token = 'successor'
  identity = change === 'revision' ? { accountId: 'a', generation: 1, revision: 1 }
    : change === 'selection' ? { accountId: 'b', generation: 1, revision: 0 }
      : { accountId: 'a', generation: 2, revision: 0 }
  first.resolve({ status: 401, data: {} })
  if (change === 'revision') {
    expect((await pending).environment_id).toBe('env-id')
    expect(sent).toEqual(['Bearer original', 'Bearer successor'])
  } else {
    await expect(pending).rejects.toBeInstanceOf(BridgeFatalError)
    expect(sent).toEqual(['Bearer original'])
  }
  expect(recover).toHaveBeenCalledTimes(1)
})

test('bridge without a bound identity never invokes an unrelated OAuth repair handler', async () => {
  spyOn(axios, 'post').mockResolvedValue({ status: 401, data: {} } as never)
  const recover = mock(async () => true)
  const client = createBridgeApiClient({
    baseUrl: 'https://isolated.invalid', runnerVersion: 'test', getAccessToken: () => 'external-token', onAuth401: recover,
  })
  await expect(client.registerBridgeEnvironment(config as never)).rejects.toBeInstanceOf(BridgeFatalError)
  expect(recover).not.toHaveBeenCalled()
  expect(axios.post).toHaveBeenCalledTimes(1)
})

test('bridge does not replay when repair reports failure or leaves the original revision unchanged', async () => {
  for (const result of [false, true]) {
    spyOn(axios, 'post').mockResolvedValue({ status: 401, data: {} } as never)
    const identity = { accountId: 'a', generation: 1, revision: 0 }
    const client = createBridgeApiClient({
      baseUrl: 'https://isolated.invalid', runnerVersion: 'test', getAccessToken: () => 'original',
      captureAuthIdentity: () => identity, onAuth401: async () => result,
    })
    await expect(client.registerBridgeEnvironment(config as never)).rejects.toBeInstanceOf(BridgeFatalError)
    expect(axios.post).toHaveBeenCalledTimes(1)
    mock.restore()
  }
})
