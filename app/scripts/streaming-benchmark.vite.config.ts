import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import { executionTargets, instrumentExecutions, transcriptMode } from './streaming-benchmark-instrumentation.js'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')
const appSource = resolve(appRoot, 'renderer/src/App.tsx')
const observerImport = `import { useLayoutEffect as benchmarkUseLayoutEffect } from 'react'\nimport { benchmarkObserveBatch, benchmarkObserveCommit, benchmarkWrapRawReducer } from '../../scripts/streaming-benchmark-observer.js'\n`

export function streamingBenchmarkTransform(): Plugin {
  return {
    name: 'catcode-streaming-benchmark-observer',
    enforce: 'pre',
    transform(source, id) {
      const path = id.split('?')[0]!
      if (!path.startsWith(resolve(appRoot, 'renderer/src') + '/')) return null
      if (path !== appSource) return executionTargets[basename(path)] ? { code: instrumentExecutions(source, basename(path)), map: null } : null
      const anchors = [
        `import {\n  useCallback,\n  useEffect,`,
        `export function App() {`,
        `  const [state, dispatch] = useReducer(\n    reduceServerFrameBatched,\n    undefined,\n    createRawMessageLogState,\n  )`,
        `    const unsubscribe = bridge.subscribe(frames => {`,
        `const reduceServerFrameBatched = withBatch(reduceServerFrame)`,
      ]
      for (const anchor of anchors) {
        if (source.split(anchor).length !== 2) throw new Error(`App.tsx benchmark anchor drifted: ${anchor.slice(0, 48)}`)
      }
      let transformed = observerImport + source
      transformed = transformed.replace(
        `const reduceServerFrameBatched = withBatch(reduceServerFrame)`,
        `const reduceServerFrameBatched = withBatch(benchmarkWrapRawReducer(reduceServerFrame))`,
      )
      transformed = transformed.replace(
        anchors[2],
        `${anchors[2]}\n  benchmarkUseLayoutEffect(() => { benchmarkObserveCommit(performance.now(), state) }, [state])`,
      )
      transformed = transformed.replace(
        anchors[3],
        `${anchors[3]}\n      benchmarkObserveBatch(frames)`,
      )
      const mode = transcriptMode(process.env.CATCODE_STREAMING_BENCHMARK_TRANSCRIPT_MODE)
      transformed = `localStorage.setItem('catcode.transcriptMode.v1', JSON.stringify({ version: 1, mode: '${mode}' }))\n` + instrumentExecutions(transformed, 'App.tsx')
      return { code: transformed, map: null }
    },
  }
}

const outDir = process.env.CATCODE_STREAMING_BENCHMARK_RENDERER_OUT ?? resolve(appRoot, '.streaming-benchmark-output-must-be-overridden')

export default defineConfig({
  root: resolve(appRoot, 'renderer'),
  base: './',
  plugins: [streamingBenchmarkTransform(), react(), tailwindcss()],
  build: { outDir, emptyOutDir: true },
})
