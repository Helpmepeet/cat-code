import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { NativePowerObservation, parsePowerObservation, unknownPowerObservation, type PowerObservation } from './powerObservation.js'

const open: PowerObservation = { ...unknownPowerObservation(), lid: 'open', thermal: 'nominal', lidNotifications: true }
const wait = async (predicate: () => boolean) => {
  for (let i = 0; i < 300 && !predicate(); i++) await Bun.sleep(10)
  expect(predicate()).toBe(true)
}

test('hardware vocabulary preserves uncertainty and forbids open-lid display observations', () => {
  expect(parsePowerObservation(open)).toEqual(open)
  expect(parsePowerObservation({ ...open, lid: 'closed', display: 'software-awake' })?.display).toBe('software-awake')
  expect(parsePowerObservation({ ...open, lid: 'closed', display: 'unknown' })?.physicalBacklight).toBe('unavailable')
  for (const value of [null, [], { ...open, display: 'software-awake' }, { ...open, thermal: 'safe' },
    { ...open, lid: 'unknown', display: 'software-asleep' }, { ...open, physicalBacklight: 'off' },
    { ...open, extra: 'private-data' }, { ...open, thermal: { toString: () => 'nominal' } }]) {
    expect(parsePowerObservation(value)).toBeUndefined()
  }
})

test('observer accepts only bounded closed observations, stops on inactivity, and cleans its exact child', async () => {
  let child: ReturnType<typeof spawn> | undefined
  let exited = false
  let launches = 0
  const events: string[] = []
  const observer = new NativePowerObservation('unused', reason => events.push(reason), () => {
    launches++
    const process = spawn(globalThis.process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(open) + '\n')}); process.stdin.resume(); process.stdin.on('end', () => process.exit(0))`], { stdio: 'pipe' })
    child = process
    process.once('close', () => { exited = true })
    return process
  })
  try {
    observer.setActive(true); observer.setActive(true)
    await wait(() => observer.read().status === 'observing')
    expect(launches).toBe(1)
    expect(observer.read().observation).toEqual(open)
    expect(events).toEqual(['hardware-state'])
    observer.setActive(false)
    expect(observer.read()).toMatchObject({ status: 'inactive', observation: unknownPowerObservation() })
    await wait(() => exited)
  } finally { observer.setActive(false); if (!exited) child?.kill('SIGKILL') }
})

test('malformed helper output becomes unknown and retires without gating assertions', async () => {
  let child: ReturnType<typeof spawn> | undefined
  let exited = false
  const observer = new NativePowerObservation('unused', () => {}, () => {
    const process = spawn(globalThis.process.execPath, ['-e', `process.stdout.write('x'.repeat(5000)); process.stdin.resume(); process.stdin.on('end', () => process.exit(0))`], { stdio: 'pipe' })
    child = process
    process.once('close', () => { exited = true })
    return process
  })
  try {
    observer.setActive(true)
    await wait(() => exited)
    expect(observer.read()).toMatchObject({ status: 'unavailable', observation: unknownPowerObservation(), failures: 1 })
  } finally { observer.setActive(false); if (!exited) child?.kill('SIGKILL') }
})

test('observer startup failure recovers with a single replacement and bounded retry', async () => {
  let launches = 0
  let child: ReturnType<typeof spawn> | undefined
  let exited = false
  const events: string[] = []
  const observer = new NativePowerObservation('unused', reason => events.push(reason), () => {
    launches++
    if (launches === 1) return spawn('/nonexistent/cat-power-observer-test', [], { stdio: 'pipe' })
    const process = spawn(globalThis.process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(open) + '\n')}); process.stdin.resume(); process.stdin.on('end', () => process.exit(0))`], { stdio: 'pipe' })
    child = process
    process.once('close', () => { exited = true })
    return process
  })
  try {
    observer.setActive(true)
    await wait(() => observer.read().status === 'observing')
    expect(launches).toBe(2)
    expect(observer.read().failures).toBe(1)
    expect(events).toEqual(['hardware-observer-unavailable', 'hardware-state'])
    observer.setActive(false)
    await wait(() => exited)
  } finally { observer.setActive(false); if (!exited) child?.kill('SIGKILL') }
})
