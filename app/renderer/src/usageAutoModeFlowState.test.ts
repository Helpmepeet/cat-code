import { expect, test } from 'bun:test'
import { hundredAttemptAutoModeFixture } from '../../../src/utils/autoModeUsage.fixture.js'
import { reduceAutoModeUsage } from '../../../src/utils/autoModeUsage.js'
import { autoModeRouteEdges } from './usageAutoModeState.js'
import { autoModeFlowConserves, layoutAutoModeFlow } from './usageAutoModeFlowState.js'

const edges = autoModeRouteEdges(reduceAutoModeUsage(hundredAttemptAutoModeFixture()))

test('lays out the aggregated route edges with conservation and a stable node order', () => {
  const layout = layoutAutoModeFlow(edges)
  expect(layout).not.toBeNull()
  expect(autoModeFlowConserves(edges)).toBe(true)
  expect(layout!.total).toBe(100)
  expect(layout!.nodes.map(node => node.id)).toEqual([
    'Attempts', 'Base checks', 'Stage 1', 'Stage 2',
    'allowed', 'policy_blocked', 'review_required', 'operational_error',
  ])
  expect(layout!.nodes.map(node => [node.id, node.column])).toEqual([
    ['Attempts', 0], ['Base checks', 1], ['Stage 1', 3], ['Stage 2', 4],
    ['allowed', 5], ['policy_blocked', 5], ['review_required', 5], ['operational_error', 5],
  ])
  expect(layout!.links.every(link => link.height === link.count * layout!.scale)).toBe(true)
  for (const node of layout!.nodes.filter(node => node.id !== 'Attempts' && node.column !== 5)) {
    expect(node.incoming).toBe(node.outgoing)
  }
  expect(layoutAutoModeFlow([...edges].reverse())!.nodes.map(node => node.id)).toEqual(layout!.nodes.map(node => node.id))
})

test('preserves rare route sizes without a visual minimum', () => {
  const layout = layoutAutoModeFlow([
    { from: 'Attempts', to: 'Base checks', count: 10 },
    { from: 'Base checks', to: 'allowed', outcome: 'allowed', count: 9 },
    { from: 'Base checks', to: 'policy_blocked', outcome: 'policy_blocked', count: 1 },
  ])
  expect(layout).not.toBeNull()
  expect(layout!.links.find(link => link.to === 'policy_blocked')!.height).toBe(layout!.scale)
  expect(layout!.links.find(link => link.to === 'allowed')!.height).toBe(layout!.scale * 9)
})

test('rejects route graphs that do not conserve a continued population', () => {
  const invalid = [
    { from: 'Attempts', to: 'Base checks', count: 10 },
    { from: 'Base checks', to: 'allowed', outcome: 'allowed' as const, count: 9 },
  ]
  expect(autoModeFlowConserves(invalid)).toBe(false)
  expect(layoutAutoModeFlow(invalid)).toBeNull()
})
