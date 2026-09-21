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
  expect(layout!.links.every(link => Math.abs(link.height - link.count * layout!.scale) < 0.000001)).toBe(true)
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

test('stacks ribbons at each node in the same order as their opposite endpoints', () => {
  const layout = layoutAutoModeFlow([
    { from: 'Attempts', to: 'Base checks', count: 100 },
    { from: 'Base checks', to: 'allowed', outcome: 'allowed', count: 75 },
    { from: 'Base checks', to: 'Stage 1', count: 25 },
    { from: 'Stage 1', to: 'allowed', outcome: 'allowed', count: 20 },
    { from: 'Stage 1', to: 'Stage 2', count: 5 },
    { from: 'Stage 2', to: 'review_required', outcome: 'review_required', count: 5 },
  ])
  expect(layout).not.toBeNull()

  for (const node of layout!.nodes) {
    const outgoing = layout!.links
      .filter(link => link.from === node.id)
      .sort((left, right) => left.toNode.y - right.toNode.y)
    const incoming = layout!.links
      .filter(link => link.to === node.id)
      .sort((left, right) => left.fromNode.y - right.fromNode.y)
    expect(outgoing.map(link => link.fromY)).toEqual([...outgoing.map(link => link.fromY)].sort((left, right) => left - right))
    expect(incoming.map(link => link.toY)).toEqual([...incoming.map(link => link.toY)].sort((left, right) => left - right))
  }
})

test('leaves readable vertical space between crowded nodes', () => {
  const outcomes = [
    'allowed',
    'policy_blocked',
    'review_required',
    'operational_error',
    'cancelled',
    'unknown_outcome',
    'incomplete',
  ] as const
  const layout = layoutAutoModeFlow([
    { from: 'Attempts', to: 'Base checks', count: 100 },
    ...outcomes.map((outcome, index) => ({
      from: 'Base checks',
      to: outcome,
      outcome,
      count: index === 0 ? 94 : 1,
    })),
  ])
  expect(layout).not.toBeNull()

  const nodes = layout!.nodes.filter(node => node.column === 5)
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = nodes[index - 1]!
    expect(nodes[index]!.y - (previous.y + previous.height)).toBeGreaterThanOrEqual(20)
  }
})

test('rejects route graphs that do not conserve a continued population', () => {
  const invalid = [
    { from: 'Attempts', to: 'Base checks', count: 10 },
    { from: 'Base checks', to: 'allowed', outcome: 'allowed' as const, count: 9 },
  ]
  expect(autoModeFlowConserves(invalid)).toBe(false)
  expect(layoutAutoModeFlow(invalid)).toBeNull()
})
