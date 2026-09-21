import { expect, test } from 'bun:test'
import { hundredAttemptAutoModeFixture } from '../../../src/utils/autoModeUsage.fixture.js'
import { reduceAutoModeUsage } from '../../../src/utils/autoModeUsage.js'
import { autoModeOverviewEdges } from './usageAutoModeState.js'
import { autoModeFlowConserves, layoutAutoModeFlow } from './usageAutoModeFlowState.js'

const edges = autoModeOverviewEdges(reduceAutoModeUsage(hundredAttemptAutoModeFixture()))

test('lays out the canonical decision path with conservation and a stable node order', () => {
  const layout = layoutAutoModeFlow(edges)
  expect(layout).not.toBeNull()
  expect(autoModeFlowConserves(edges)).toBe(true)
  expect(layout!.total).toBe(87)
  expect(layout!.nodes.map(node => node.id)).toEqual([
    'Attempts', 'Stage 1', 'Stage 2', 'Approved', 'Blocked',
  ])
  expect(layout!.nodes.map(node => [node.id, node.column])).toEqual([
    ['Attempts', 0], ['Stage 1', 1], ['Stage 2', 2], ['Approved', 3], ['Blocked', 3],
  ])
  expect(layout!.links.every(link => Math.abs(link.height - link.count * layout!.scale) < 0.000001)).toBe(true)
  for (const node of layout!.nodes.filter(node => node.id !== 'Attempts' && node.column !== 3)) {
    expect(node.incoming).toBe(node.outgoing)
  }
  expect(layoutAutoModeFlow([...edges].reverse())!.nodes.map(node => node.id)).toEqual(layout!.nodes.map(node => node.id))
})

test('preserves rare route sizes without a visual minimum', () => {
  const layout = layoutAutoModeFlow([
    { from: 'Attempts', to: 'Stage 1', count: 10 },
    { from: 'Stage 1', to: 'Stage 2', count: 10 },
    { from: 'Stage 2', to: 'Approved', outcome: 'allowed', count: 9 },
    { from: 'Stage 2', to: 'Blocked', outcome: 'policy_blocked', count: 1 },
  ])
  expect(layout).not.toBeNull()
  expect(layout!.links.find(link => link.to === 'Blocked')!.height).toBe(layout!.scale)
  expect(layout!.links.find(link => link.from === 'Stage 2' && link.to === 'Approved')!.height).toBe(layout!.scale * 9)
})

test('stacks the three approval paths without changing their values', () => {
  const layout = layoutAutoModeFlow([
    { from: 'Attempts', to: 'Approved', outcome: 'allowed', count: 75 },
    { from: 'Attempts', to: 'Stage 1', count: 25 },
    { from: 'Stage 1', to: 'Approved', outcome: 'allowed', count: 20 },
    { from: 'Stage 1', to: 'Stage 2', count: 5 },
    { from: 'Stage 2', to: 'Approved', outcome: 'allowed', count: 4 },
    { from: 'Stage 2', to: 'Blocked', outcome: 'policy_blocked', count: 1 },
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

test('leaves readable vertical space between terminal nodes', () => {
  const layout = layoutAutoModeFlow([
    { from: 'Attempts', to: 'Stage 1', count: 100 },
    { from: 'Stage 1', to: 'Stage 2', count: 100 },
    { from: 'Stage 2', to: 'Approved', outcome: 'allowed', count: 99 },
    { from: 'Stage 2', to: 'Blocked', outcome: 'policy_blocked', count: 1 },
  ])
  expect(layout).not.toBeNull()

  const nodes = layout!.nodes.filter(node => node.column === 3)
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = nodes[index - 1]!
    expect(nodes[index]!.y - (previous.y + previous.height)).toBeGreaterThanOrEqual(20)
  }
})

test('rejects route graphs that do not conserve a continued population', () => {
  const invalid = [
    { from: 'Attempts', to: 'Stage 1', count: 10 },
    { from: 'Stage 1', to: 'Approved', outcome: 'allowed' as const, count: 9 },
  ]
  expect(autoModeFlowConserves(invalid)).toBe(false)
  expect(layoutAutoModeFlow(invalid)).toBeNull()
})
