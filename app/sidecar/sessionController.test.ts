import { expect, test } from 'bun:test'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import {
  P1_1_CWD,
  createNormalSidecarQueryEngineConfig,
  createSidecarSessionController,
} from './sessionController.js'

test('normal startup exposes the permission-context tools to the model', () => {
  const config = createNormalSidecarQueryEngineConfig()

  expect(config.tools.length).toBeGreaterThan(0)
  expect(config.tools.some(tool => tool.name === 'Bash')).toBe(true)
})

test('normal startup constructs a real runtime-backed controller without starting a turn', () => {
  const controller = createSidecarSessionController({ probe: false })

  expect(controller).toBeInstanceOf(AppSessionController)
  expect(P1_1_CWD).toBe('/Users/pt/cat-code')
  expect(controller.getAbortState()).toEqual({ status: 'idle' })
  expect(controller.getGoalSnapshot()).toBeNull()
  expect(controller.getPendingPermissionRequests()).toEqual([])
})
