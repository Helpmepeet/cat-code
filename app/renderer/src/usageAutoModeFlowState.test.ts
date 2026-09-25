import { expect, test } from 'bun:test'
import { hundredAttemptAutoModeFixture } from '../../../src/utils/autoModeUsage.fixture.js'
import { reduceAutoModeUsage } from '../../../src/utils/autoModeUsage.js'
import { autoModeOverviewEdges } from './usageAutoModeState.js'
import { autoModeFlowConserves, layoutAutoModeFlow } from './usageAutoModeFlowState.js'

const edges = autoModeOverviewEdges(reduceAutoModeUsage(hundredAttemptAutoModeFixture()))

test('lays out every attempt through a route into a display group', () => {
  const layout = layoutAutoModeFlow(edges)
  expect(layout).not.toBeNull()
  expect(autoModeFlowConserves(edges)).toBe(true)
  expect(layout!.total).toBe(100)
  expect(layout!.nodes.map(node => node.id)).toEqual([
    'Attempts', 'Base paths', 'Stage 1', 'Stage 2', 'allowed', 'blocked', 'error',
  ])
  expect(layout!.nodes.filter(node => node.column === 2).reduce((total, node) => total + node.incoming, 0)).toBe(100)
  expect(layout!.links.every(link => Math.abs(link.height - link.count * layout!.scale) < 0.000001)).toBe(true)
  for (const node of layout!.nodes.filter(node => node.id !== 'Attempts' && node.column !== 2)) {
    expect(node.incoming).toBe(node.outgoing)
  }
  expect(layoutAutoModeFlow([...edges].reverse())!.nodes.map(node => node.id)).toEqual(layout!.nodes.map(node => node.id))
})

test('preserves rare outcome sizes without a visual minimum', () => {
  const layout = layoutAutoModeFlow([
    { from: 'Attempts', to: 'Base paths', count: 10 },
    { from: 'Base paths', to: 'allowed', outcome: 'allowed', count: 9 },
    { from: 'Base paths', to: 'error', outcome: 'error', count: 1 },
  ])
  expect(layout).not.toBeNull()
  expect(layout!.links.find(link => link.to === 'error')!.height).toBe(layout!.scale)
  expect(layout!.links.find(link => link.from === 'Base paths' && link.to === 'allowed')!.height).toBe(layout!.scale * 9)
})

test('stacks routes and groups without changing their values', () => {
  const layout = layoutAutoModeFlow([
    { from: 'Attempts', to: 'Base paths', count: 75 },
    { from: 'Attempts', to: 'Stage 1', count: 25 },
    { from: 'Base paths', to: 'allowed', outcome: 'allowed', count: 75 },
    { from: 'Stage 1', to: 'allowed', outcome: 'allowed', count: 24 },
    { from: 'Stage 1', to: 'blocked', outcome: 'blocked', count: 1 },
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

test('leaves readable vertical space between outcome nodes', () => {
  const layout = layoutAutoModeFlow([
    { from: 'Attempts', to: 'Stage 2', count: 100 },
    { from: 'Stage 2', to: 'allowed', outcome: 'allowed', count: 99 },
    { from: 'Stage 2', to: 'blocked', outcome: 'blocked', count: 1 },
  ])
  expect(layout).not.toBeNull()

  const nodes = layout!.nodes.filter(node => node.column === 2)
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = nodes[index - 1]!
    expect(nodes[index]!.y - (previous.y + previous.height)).toBeGreaterThanOrEqual(20)
  }
})

test('rejects route graphs that do not conserve a continued population', () => {
  const invalid = [
    { from: 'Attempts', to: 'Safety check', count: 10 },
    { from: 'Safety check', to: 'Approved', outcome: 'allowed' as const, count: 9 },
  ]
  expect(autoModeFlowConserves(invalid)).toBe(false)
  expect(layoutAutoModeFlow(invalid)).toBeNull()
})
