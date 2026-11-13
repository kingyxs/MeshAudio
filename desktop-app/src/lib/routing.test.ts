import { describe, expect, it } from 'vitest'
import { edgeForPorts, addRoute } from './routing'
const graph = { sourceIds: new Set(['s1', 's2']), busIds: new Set(['b1', 'b2']), outputs: new Map([['o1', { enabled: true }], ['off', { enabled: false }]]) }
describe('port connections', () => {
  it('normalizes forward and reverse drags', () => {
    expect(edgeForPorts({ id: 's1', side: 'out' }, { id: 'b1', side: 'in' }, graph)).toEqual(['s1', 'b1'])
    expect(edgeForPorts({ id: 'o1', side: 'in' }, { id: 'b1', side: 'out' }, graph)).toEqual(['b1', 'o1'])
  })
  it('rejects bypass, same-side, self and disabled output connections', () => {
    for (const [id, side, target, other] of [['s1', 'out', 'o1', 'in'], ['b1', 'out', 'off', 'in'], ['s1', 'out', 'b1', 'out'], ['b1', 'out', 'b1', 'in']] as const) {
      expect(edgeForPorts({ id, side }, { id: target, side: other }, graph)).toBeNull()
    }
  })
  it('preserves fan-out, mixing and duplicate idempotence', () => {
    let routes: [string, string][] = []
    for (const edge of [['s1', 'b1'], ['s1', 'b2'], ['s2', 'b1'], ['b1', 'o1'], ['s1', 'b1']] as [string, string][]) routes = addRoute(routes, edge, graph)
    expect(routes).toHaveLength(4)
  })
})
