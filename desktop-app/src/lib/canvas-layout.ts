export interface CardSize { id: string; height: number }
export function layoutCards(cards: CardSize[], saved: Record<string, number>, gap = 20, preferredId?: string): Record<string, number> {
  let fallback = 0
  const desired = cards.map((card, index) => {
    const top = Number.isFinite(saved[card.id]) ? Math.max(0, Math.min(20000, saved[card.id]!)) : fallback
    fallback += card.height + gap
    return { ...card, index, top }
  }).sort((a, b) => a.top - b.top || (a.id === preferredId ? -1 : b.id === preferredId ? 1 : a.index - b.index))
  const result: Record<string, number> = {}
  let cursor = 0
  for (const card of desired) { result[card.id] = Math.max(cursor, card.top); cursor = result[card.id]! + card.height + gap }
  return result
}
