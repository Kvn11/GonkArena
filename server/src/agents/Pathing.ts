import type { Tile } from '../protocol/messages.js'

export type PathExpansion =
  | { ok: true; expanded_path: Tile[] }
  | {
      ok: false
      reason: 'no_path_to_waypoint' | 'path_blocked' | 'waypoint_occupied' | 'path_too_long' | 'out_of_bounds'
      detail: string
    }

export type PathingOpts = {
  gridW: number
  gridH: number
  isBlocked: (x: number, y: number) => boolean
  maxPathLength: number
}

function inBounds(x: number, y: number, w: number, h: number) {
  return x >= 0 && y >= 0 && x < w && y < h
}

function chebyshev(a: Tile, b: Tile) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))
}

// 8-connected neighbors (Chebyshev movement).
const NEIGHBORS: ReadonlyArray<[number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
]

// Minimal binary min-heap keyed by f-score. Sufficient for 64x64 grids.
class MinHeap {
  private heap: { key: number; node: number; gScore: number }[] = []

  push(item: { key: number; node: number; gScore: number }) {
    this.heap.push(item)
    this.bubbleUp(this.heap.length - 1)
  }

  pop(): { node: number; gScore: number } | undefined {
    if (this.heap.length === 0) return undefined
    const top = this.heap[0]
    const last = this.heap.pop()!
    if (this.heap.length > 0) {
      this.heap[0] = last
      this.bubbleDown(0)
    }
    return { node: top.node, gScore: top.gScore }
  }

  get size() { return this.heap.length }

  private bubbleUp(i: number) {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.heap[parent].key <= this.heap[i].key) break
      ;[this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]]
      i = parent
    }
  }

  private bubbleDown(i: number) {
    const n = this.heap.length
    while (true) {
      const l = 2 * i + 1
      const r = 2 * i + 2
      let smallest = i
      if (l < n && this.heap[l].key < this.heap[smallest].key) smallest = l
      if (r < n && this.heap[r].key < this.heap[smallest].key) smallest = r
      if (smallest === i) break
      ;[this.heap[smallest], this.heap[i]] = [this.heap[i], this.heap[smallest]]
      i = smallest
    }
  }
}

// A* from `start` to `goal` on an 8-connected grid. Returns the tile sequence
// INCLUDING start and goal, or null if no path exists. Uniform step cost of 1.
function astar(start: Tile, goal: Tile, opts: PathingOpts): Tile[] | null {
  const { gridW: w, gridH: h, isBlocked } = opts
  if (!inBounds(start[0], start[1], w, h) || !inBounds(goal[0], goal[1], w, h)) return null
  if (start[0] === goal[0] && start[1] === goal[1]) return [start]
  // Goal tile being blocked is fine if it's the agent's current tile, but the
  // caller should not be requesting a path that ends on something blocked.
  if (isBlocked(goal[0], goal[1])) return null

  const nodeId = (x: number, y: number) => y * w + x
  const startId = nodeId(start[0], start[1])
  const goalId = nodeId(goal[0], goal[1])

  const gScore = new Map<number, number>()
  const cameFrom = new Map<number, number>()
  gScore.set(startId, 0)

  const open = new MinHeap()
  open.push({ key: chebyshev(start, goal), node: startId, gScore: 0 })

  while (open.size > 0) {
    const cur = open.pop()!
    if (cur.node === goalId) {
      const path: Tile[] = []
      let n: number | undefined = cur.node
      while (n !== undefined) {
        path.push([n % w, Math.floor(n / w)])
        n = cameFrom.get(n)
      }
      return path.reverse()
    }
    // Stale heap entry — skip if we've already found a shorter g-score.
    if (cur.gScore > (gScore.get(cur.node) ?? Infinity)) continue
    const cx = cur.node % w
    const cy = Math.floor(cur.node / w)
    for (const [dx, dy] of NEIGHBORS) {
      const nx = cx + dx
      const ny = cy + dy
      if (!inBounds(nx, ny, w, h)) continue
      if (isBlocked(nx, ny) && !(nx === goal[0] && ny === goal[1])) continue
      const nId = nodeId(nx, ny)
      const tentative = cur.gScore + 1
      if (tentative < (gScore.get(nId) ?? Infinity)) {
        gScore.set(nId, tentative)
        cameFrom.set(nId, cur.node)
        const h2 = Math.max(Math.abs(nx - goal[0]), Math.abs(ny - goal[1]))
        open.push({ key: tentative + h2, node: nId, gScore: tentative })
      }
    }
  }
  return null
}

// Expand a list of waypoints (the agent's submitted path) into a flat,
// tile-by-tile route. Each consecutive pair (start, w1), (w1, w2), ... is A*-d
// independently. The result is one contiguous path with no duplicated junctions.
// On failure, returns the reason and the segment that broke.
export function expandPath(start: Tile, waypoints: Tile[], opts: PathingOpts): PathExpansion {
  const { gridW: w, gridH: h, maxPathLength } = opts
  if (waypoints.length === 0) return { ok: true, expanded_path: [] }

  // Pre-flight: every waypoint in-bounds.
  for (const [x, y] of waypoints) {
    if (!inBounds(x, y, w, h)) {
      return { ok: false, reason: 'out_of_bounds', detail: `waypoint [${x},${y}] is outside grid ${w}x${h}` }
    }
  }

  const route: Tile[] = []
  let from: Tile = start
  for (let i = 0; i < waypoints.length; i++) {
    const to = waypoints[i]
    // Distinguish "this exact tile is occupied" from "no path exists at all".
    // Bot authors care about the difference (the doc surfaces this as two
    // separate rejection reasons), and the only thing isBlocked currently
    // reflects is entity occupancy.
    if (opts.isBlocked(to[0], to[1])) {
      return {
        ok: false,
        reason: 'waypoint_occupied',
        detail: `waypoint [${to[0]},${to[1]}] is occupied by another entity`,
      }
    }
    const segment = astar(from, to, opts)
    if (segment === null) {
      // In v1 the goal-occupancy case is already handled above, and there are
      // no walls — so an A* failure here means intermediate tiles are blocked
      // by entities (rare but possible if the bot pathed into a pocket
      // surrounded by other agents). This is reported as `path_blocked` to
      // tell the bot "wait, things may move," distinct from
      // `no_path_to_waypoint` (reserved for future structurally-unreachable
      // walls/topology).
      return {
        ok: false,
        reason: 'path_blocked',
        detail: `no A* solution from [${from[0]},${from[1]}] to [${to[0]},${to[1]}] — intermediate tiles blocked by entities`,
      }
    }
    // Drop the first tile of each non-initial segment to avoid duplicating
    // the junction tile we just walked onto.
    const tail = i === 0 ? segment.slice(1) : segment.slice(1)
    route.push(...tail)
    from = to
    if (route.length > maxPathLength) {
      return {
        ok: false,
        reason: 'path_too_long',
        detail: `expanded path exceeds max_path_length=${maxPathLength}`,
      }
    }
  }
  return { ok: true, expanded_path: route }
}
