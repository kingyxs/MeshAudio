import type { RouteEdge } from './types'

export interface RouteGraph {
  sourceIds: ReadonlySet<string>
  busIds: ReadonlySet<string>
  outputs: ReadonlyMap<string, { enabled: boolean }>
}

export function canConnect(from: string, to: string, graph: RouteGraph): boolean {
  return (graph.sourceIds.has(from) && graph.busIds.has(to))
    || (graph.busIds.has(from) && graph.outputs.get(to)?.enabled === true)
}

export type PortSide = 'in' | 'out'
export function edgeForPorts(start: { id: string; side: PortSide }, end: { id: string; side: PortSide }, graph: RouteGraph): RouteEdge | null {
  if (start.side === end.side || start.id === end.id) return null
  const edge: RouteEdge = start.side === 'out' ? [start.id, end.id] : [end.id, start.id]
  return canConnect(edge[0], edge[1], graph) ? edge : null
}

export function addRoute(routes: readonly RouteEdge[], edge: RouteEdge, graph: RouteGraph): RouteEdge[] {
  if (!canConnect(edge[0], edge[1], graph)) return [...routes]
  if (routes.some(([from, to]) => from === edge[0] && to === edge[1])) return [...routes]
  return [...routes, edge]
}

export function removeRoute(routes: readonly RouteEdge[], index: number): RouteEdge[] {
  return routes.filter((_, routeIndex) => routeIndex !== index)
}

export interface Point { x: number; y: number }

export function bezierPath(from: Point, to: Point): string {
  const dx = Math.max(35, (to.x - from.x) * 0.42)
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`
}
