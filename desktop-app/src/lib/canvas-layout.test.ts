import { describe, expect, it } from 'vitest'
import { layoutCards } from './canvas-layout'
describe('vertical canvas layout', () => {
  const cards = [{ id: 'a', height: 100 }, { id: 'b', height: 150 }, { id: 'c', height: 80 }]
  it('stacks new cards with readable gaps', () => { expect(layoutCards(cards, {})).toEqual({ a: 0, b: 120, c: 290 }) })
  it('allows free vertical space and moving a card below its neighbors', () => {
    const result = layoutCards(cards, { a: 500, b: 120, c: 290 })
    expect(result.a).toBe(500); expect(result.b).toBe(120); expect(result.c).toBe(290)
  })
  it('prevents overlapping cards and rejects invalid saved positions', () => {
    const result = layoutCards(cards, { a: -5, b: 10, c: NaN })
    expect(result.a).toBe(0); expect(result.b).toBeGreaterThanOrEqual(120); expect(result.c).toBeGreaterThanOrEqual(result.b! + 170)
  })
  it('moves the preferred card to the top even when both desired positions are zero', () => {
    expect(layoutCards(cards, { a: 0, b: 0, c: 290 }, 20, 'b')).toEqual({ b: 0, a: 170, c: 290 })
  })
})
