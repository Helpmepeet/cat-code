import { spyOn } from 'bun:test'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setOriginalCwd } from '../bootstrap/state.js'
import * as file from './file.js'
import * as lockfile from './lockfile.js'

const configDir = process.env.CLAUDE_CONFIG_DIR
const projectDir = process.env.PROBE_PROJECT_DIR
const scenario = process.env.PROBE_SCENARIO
if (!configDir || !projectDir || !scenario) throw new Error('Missing project-save fixture')
const projectPath = realpathSync(projectDir)
setOriginalCwd(projectPath)
const configPath = join(configDir, '.config.json')
writeFileSync(configPath, JSON.stringify({
  numStartups: 42,
  hasCompletedOnboarding: true,
  projects: {
    [projectPath]: {
      allowedTools: [],
      mcpContextUris: [],
      projectOnboardingSeenCount: 7,
    },
  },
}))

const config = await import('./config.js')
config.enableConfigs()
const cachedBefore = config.getGlobalConfig()
const bytesBefore = readFileSync(configPath, 'utf8')
let updaterCalls = 0
let writeCalls = 0
const originalWrite = file.writeFileSyncAndFlush_DEPRECATED
const lockSpy = scenario === 'lock-error'
  ? spyOn(lockfile, 'lockSync').mockImplementation(() => {
      throw Object.assign(new Error('synthetic lock failure'), { code: 'EACCES' })
    })
  : undefined
const writeSpy = scenario === 'write-error'
  ? spyOn(file, 'writeFileSyncAndFlush_DEPRECATED').mockImplementation((...args) => {
      writeCalls++
      if (writeCalls === 1) throw new Error('synthetic write failure')
      originalWrite(...args)
    })
  : undefined
try {
  config.saveCurrentProjectConfig(current => {
    updaterCalls++
    if (scenario === 'updater-error' && updaterCalls === 1) {
      throw new Error('synthetic updater failure')
    }
    if (scenario === 'noop') return current
    return { ...current, projectOnboardingSeenCount: current.projectOnboardingSeenCount + 1 }
  })
} finally {
  lockSpy?.mockRestore()
  writeSpy?.mockRestore()
}
const cachedAfter = config.getGlobalConfig()
const bytesAfter = readFileSync(configPath, 'utf8')
const diskConfig = JSON.parse(bytesAfter)
process.stdout.write(`RESULT:${JSON.stringify({
  updaterCalls,
  writeCalls,
  bytesUnchanged: bytesAfter === bytesBefore,
  cacheUnchanged: cachedAfter === cachedBefore,
  projectCount: cachedAfter.projects?.[projectPath]?.projectOnboardingSeenCount,
  diskProjectCount: diskConfig.projects[projectPath].projectOnboardingSeenCount,
  numStartups: diskConfig.numStartups,
  successfulWrites: config.getGlobalConfigWriteCount(),
})}\n`)
process.exit(0)
