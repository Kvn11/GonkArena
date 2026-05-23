import type { PerceptionTick } from '../protocol/messages.js'

// A bounded ring buffer of recent `perception_tick` bodies for one agent.
// `slice(from, to)` returns the inclusive window. Out-of-range queries return
// null so the caller can emit a clean `tick_too_old` error.

export type TickBody = Omit<PerceptionTick, 'type'>

export class PerceptionBuffer {
  private ring: (TickBody | undefined)[]
  private head = 0           // next write index
  private oldest: number | null = null  // smallest tick currently in buffer
  private newest: number | null = null  // largest tick currently in buffer

  constructor(private capacity: number) {
    this.ring = new Array(capacity)
  }

  push(t: TickBody) {
    this.ring[this.head] = t
    this.head = (this.head + 1) % this.capacity
    if (this.oldest === null) this.oldest = t.tick
    else if (t.tick - this.oldest >= this.capacity) this.oldest = t.tick - this.capacity + 1
    this.newest = t.tick
  }

  get newestTick(): number | null { return this.newest }
  get oldestTick(): number | null { return this.oldest }

  // Inclusive window. Returns null if any tick in [from,to] is outside the
  // retained window. Caller is responsible for clamping to current_tick.
  slice(from: number, to: number): TickBody[] | null {
    if (this.oldest === null || this.newest === null) return null
    if (from < this.oldest || to > this.newest) return null
    const out: TickBody[] = []
    for (let t = from; t <= to; t++) {
      // The ring stores in insertion order; map tick → ring index.
      const offset = this.newest - t           // 0 = newest, capacity-1 = oldest
      const idx = (this.head - 1 - offset + this.capacity) % this.capacity
      const body = this.ring[idx]
      if (!body || body.tick !== t) return null  // safety net for corruption
      out.push(body)
    }
    return out
  }
}
