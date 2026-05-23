import { randomUUID } from 'node:crypto'
import { PerceptionBuffer, type TickBody } from '../agents/PerceptionBuffer.js'
import { expandPath } from '../agents/Pathing.js'
import {
  PROTOCOL_VERSION,
  type ActionMessage,
  type ActionReply,
  type ActionRejectReason,
  type AttackDef,
  type AttackState,
  type ErrorMsg,
  type Event,
  type Facing,
  type GetTicksMessage,
  type GetTicksReply,
  type LobbyUpdate,
  type MatchEnd,
  type MatchStart,
  type PerceptionTick,
  type ServerMessage,
  type Tile,
  type VisibleEntity,
  type Welcome,
  type WorldConfig,
} from '../protocol/messages.js'
import { RULES, SCHEMAS } from '../protocol/schemas.js'

export type ConnSend = (msg: ServerMessage) => void
export type ConnClose = () => void

export type AgentAttackState = {
  attackId: string                  // bot-chosen instance correlator
  moveId: string                    // current frame, e.g. "punch.stance"
  sinceTick: number                 // tick the current frame began
  autoAdvanceAtTick: number | null  // non-null = server will advance on this tick; null = waiting on bot
}

export type Agent = {
  id: string
  pos: Tile
  hp: number
  facing: Facing
  path_remaining: Tile[]
  pathId: string | null         // action_id of the currently-executing set_path; null when idle
  originalWaypoints: Tile[]     // last-submitted waypoint list (the bot's view), retained for path_interrupted
  attackState: AgentAttackState | null  // non-null while in any attack FSM (incl. stance)
  alive: boolean
  lastAttackerId: string | null // who landed the killing blow, for match_end.by
  diedThisTick: boolean         // set on the tick alive flips false; lets the emit phase deliver one final perception_tick
  send: ConnSend
  close: ConnClose
  buffer: PerceptionBuffer
  lastVisible: Set<string>
  actionTimestamps: number[]    // for max_actions_per_second rate limiting
  pendingFutureSlices: { request_id: string; from_tick: number; to_tick: number }[]
}

// Punch attack definition — instinctual, shipped to every agent in welcome.world.attacks.
//
// Jab FSM:
//
//   stance ←─────────┐
//     │ (bot)         │
//     ▼               │ (server, auto-advance)
//   jab  ← damage applies here, uncancellable
//
// The bot enters at stance, can submit `punch.jab` (the commit) or
// `punch.exit`. Jab is server-paced: once committed, it auto-advances
// back to stance after min_duration_ticks — the bot CANNOT transition
// out mid-jab. This is the "thrown punch / regaining balance" commitment
// the FSM enforces. Damage applies on entering the jab frame.
const PUNCH_ATTACK: AttackDef = {
  kind: 'instinctual',
  locks_movement: true,
  range: { shape: 'facing_adjacent' },
  damage_at: 'punch.jab',
  damage_amount: 10,
  entry: 'punch.stance',
  fsm: {
    'punch.stance': { transitions: ['punch.jab', 'punch.exit'], min_duration_ticks: 0, control: 'bot' },
    // 4 ticks (400 ms @ 10 Hz) — long enough that the extended-arm pose is
    // visually unambiguous as a thrown punch before it returns to stance.
    'punch.jab':    { transitions: ['punch.stance'],            min_duration_ticks: 4, control: 'server' },
    'punch.exit':   { transitions: [],                          min_duration_ticks: 0, control: 'terminal' },
  },
}

// Parse a positive-integer env var with a default. `??` alone wouldn't reject
// empty strings or non-numeric input — MIN_AGENTS="" would yield 0 (disabled
// lobby) and MIN_AGENTS="3a" would yield NaN (lobby never starts).
function envPositiveInt(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return defaultValue
  return Math.floor(n)
}

const DEFAULT_WORLD: WorldConfig = {
  grid_size: [64, 64],
  tick_rate_hz: 10,
  fov_radius: 8,
  max_path_length: 16,
  max_waypoints_per_action: 8,
  max_actions_per_second: 20,
  max_inflight_get_ticks: 4,
  slice_buffer_ticks: 100,
  min_agents_for_match: envPositiveInt('MIN_AGENTS', 1),
  attacks: { punch: PUNCH_ATTACK },
}

const MATCH_TIMEOUT_TICKS = 3000        // 5 min @ 10 Hz
const PRE_MATCH_DELAY_MS = 5000          // gap between welcome and match_start
                                         // (generous so multiple agents have
                                         //  time to connect before lockout)

export class ArenaRoom {
  readonly id = `m_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  readonly world: WorldConfig
  private agents = new Map<string, Agent>()
  private tick = 0
  private state: 'waiting' | 'active' | 'ended' = 'waiting'
  private tickTimer: NodeJS.Timeout | null = null
  private startTimer: NodeJS.Timeout | null = null
  private startTimerArmedAt: number | null = null   // Date.now() when startTimer was armed; null when not armed
  private occupancy = new Map<string, string>()   // "x,y" -> agentId
  private initialAgentCount = 0                   // set at startMatch()
  // Events emitted between ticks (from handleAction) that land in the NEXT
  // perception_tick's events[]. Drained by onTick at the start of the
  // event-emission phase.
  private pendingEventsForNextTick: { agentId: string; event: Event }[] = []
  onEnded: (() => void) | null = null             // callback for server to spin up a fresh room

  constructor(world: Partial<WorldConfig> = {}) {
    this.world = { ...DEFAULT_WORLD, ...world }
    // Validate that every server-paced move has a non-zero min_duration. A
    // zero-duration server-paced frame would re-schedule its auto-advance for
    // the same tick it's entered, and even with the while→if change, two
    // such moves chained could mis-behave under reentrant calls.
    for (const [name, def] of Object.entries(this.world.attacks)) {
      for (const [moveId, move] of Object.entries(def.fsm)) {
        if (move.control === 'server' && move.min_duration_ticks < 1) {
          throw new Error(`attack "${name}" move "${moveId}" is server-controlled with min_duration_ticks=${move.min_duration_ticks}; must be >= 1`)
        }
      }
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  join(send: ConnSend, close: ConnClose): Agent {
    // 'ended' is the only state where we hard-reject — the room is dead and
    // the server will spawn a fresh one for the next connection.
    if (this.state === 'ended') {
      const err: ErrorMsg = { type: 'error', request_id: '-', reason: 'tick_too_old', detail: 'room_ended' }
      send(err)
      close()
      return {
        id: '-', pos: [0, 0], hp: 0, facing: 'down', path_remaining: [], pathId: null,
        originalWaypoints: [], attackState: null, alive: false,
        lastAttackerId: null, diedThisTick: false,
        send, close, buffer: new PerceptionBuffer(1), lastVisible: new Set(),
        actionTimestamps: [], pendingFutureSlices: [],
      }
    }
    const id = `p_${randomUUID().slice(0, 8)}`
    const spawn = this.pickSpawn()
    const agent: Agent = {
      id,
      pos: spawn,
      hp: 100,
      facing: 'down',
      path_remaining: [],
      pathId: null,
      originalWaypoints: [],
      attackState: null,
      alive: true,
      lastAttackerId: null,
      diedThisTick: false,
      send,
      close,
      buffer: new PerceptionBuffer(this.world.slice_buffer_ticks),
      lastVisible: new Set(),
      actionTimestamps: [],
      pendingFutureSlices: [],
    }
    this.agents.set(id, agent)
    this.occupancy.set(this.key(spawn), id)
    console.log(`[room ${this.id}] +join ${id} @ [${spawn[0]},${spawn[1]}] state=${this.state} agents=${this.agents.size}`)

    const welcome: Welcome = {
      type: 'welcome',
      protocol_version: PROTOCOL_VERSION,
      agent_id: id,
      match_id: this.id,
      server_time_ms: Date.now(),
      world: this.world,
      self_spawn: { pos: agent.pos, hp: agent.hp, facing: agent.facing },
      schemas: SCHEMAS as Record<string, unknown>,
      rules: RULES as unknown as Record<string, string>,
    }
    send(welcome)

    if (this.state === 'waiting') {
      // Match starts when we hit min_agents_for_match — then run a short
      // pre-match countdown so anyone connecting on the heels of the threshold
      // also gets in. If we're under the threshold, just sit and broadcast
      // lobby_update; the timer doesn't start.
      this.broadcastLobby()
      if (this.agents.size >= this.world.min_agents_for_match && !this.startTimer) {
        this.startTimer = setTimeout(() => this.startMatch(), PRE_MATCH_DELAY_MS)
        this.startTimerArmedAt = Date.now()
        this.broadcastLobby()  // re-broadcast with starting_in_ms set
      }
    } else {
      // 'active' state — late joiner. Drop them straight into the running
      // match: synthesize a match_start so their client transitions out of
      // the pre-match status, then they'll naturally pick up the next tick.
      const start: MatchStart = {
        type: 'match_start',
        tick: this.tick,
        t_ms: Date.now(),
        n_agents: this.agents.size,
      }
      send(start)
    }
    return agent
  }

  // Called when a connection drops. We remove the agent from the room. If
  // that empties the room, we either cancel the pre-match timer (if waiting)
  // or end the match early (if active).
  leave(agentId: string) {
    const a = this.agents.get(agentId)
    if (!a) return
    this.agents.delete(agentId)
    this.occupancy.delete(this.key(a.pos))
    console.log(`[room ${this.id}] -leave ${agentId} state=${this.state} agents=${this.agents.size}`)
    if (this.state === 'waiting') {
      // If a leave drops us below the threshold, cancel the pre-match timer.
      if (this.agents.size < this.world.min_agents_for_match && this.startTimer) {
        clearTimeout(this.startTimer)
        this.startTimer = null
        this.startTimerArmedAt = null
      }
      this.broadcastLobby()
    }
    if (this.state === 'active' && this.agents.size === 0) {
      this.endMatch(null)
    }
  }

  private broadcastLobby() {
    if (this.state !== 'waiting') return
    const remaining = this.startTimerArmedAt !== null
      ? Math.max(0, PRE_MATCH_DELAY_MS - (Date.now() - this.startTimerArmedAt))
      : null
    const msg: LobbyUpdate = {
      type: 'lobby_update',
      agents_present: this.agents.size,
      agents_needed: this.world.min_agents_for_match,
      starting_in_ms: remaining,
    }
    for (const a of this.agents.values()) a.send(msg)
  }

  private startMatch() {
    this.startTimer = null
    this.startTimerArmedAt = null
    if (this.state !== 'waiting') return
    this.state = 'active'
    this.tick = 0
    this.initialAgentCount = this.agents.size
    const start: MatchStart = {
      type: 'match_start',
      tick: 0,
      t_ms: Date.now(),
      n_agents: this.initialAgentCount,
    }
    for (const a of this.agents.values()) a.send(start)
    this.tickTimer = setInterval(() => this.onTick(), 1000 / this.world.tick_rate_hz)
  }

  private onTick() {
    if (this.state !== 'active') return
    this.tick++

    // 1. Walk paths and emit move-related events.
    const perTickEvents = new Map<string, Event[]>()
    for (const a of this.agents.values()) {
      perTickEvents.set(a.id, [])
    }
    // Drain inter-tick events queued by handleAction (attack_step_committed
    // for bot-initiated frames, etc.).
    for (const { agentId, event } of this.pendingEventsForNextTick) {
      const list = perTickEvents.get(agentId)
      if (list) list.push(event)
    }
    this.pendingEventsForNextTick = []

    for (const a of this.agents.values()) {
      if (!a.alive || a.path_remaining.length === 0) continue
      const next = a.path_remaining[0]
      const blockerId = this.occupancy.get(this.key(next))
      const pid = a.pathId ?? 'unknown'
      if (blockerId !== undefined && blockerId !== a.id) {
        // Emit the bot's ORIGINAL waypoints (filtered to those not yet
        // reached), not the A*-expanded tile-by-tile remainder. This lets the
        // bot resubmit something close to its original intent without blowing
        // through max_waypoints_per_action.
        const unreachedWaypoints = a.originalWaypoints.filter((w) => {
          const reached = a.pos[0] === w[0] && a.pos[1] === w[1]
          return !reached
        })
        perTickEvents.get(a.id)!.push({
          type: 'path_interrupted',
          halted_at: a.pos,
          blocker_id: blockerId,
          remaining_waypoints: unreachedWaypoints,
          path_id: pid,
        })
        a.path_remaining = []
        a.pathId = null
        a.originalWaypoints = []
      } else {
        const prev = a.pos
        this.occupancy.delete(this.key(prev))
        a.pos = next
        a.facing = this.facingFromMove(prev, next) ?? a.facing
        this.occupancy.set(this.key(a.pos), a.id)
        a.path_remaining.shift()
        perTickEvents.get(a.id)!.push({ type: 'path_step_completed', to: a.pos })
        if (a.path_remaining.length === 0) {
          perTickEvents.get(a.id)!.push({ type: 'path_completed', path_id: pid })
          a.pathId = null
          a.originalWaypoints = []
        }
      }
    }

    // 1b. Advance server-controlled attack frames. Exactly one advance per
    // tick — if a future attack ever wires two server-paced frames with
    // min_duration_ticks=0 we don't want a same-tick infinite loop. The
    // world-config validation below rejects min_duration_ticks<1 on
    // server-controlled frames, but defence-in-depth.
    for (const a of this.agents.values()) {
      if (!a.alive || a.attackState === null) continue
      if (a.attackState.autoAdvanceAtTick === this.tick) {
        this.serverAdvanceAttack(a, perTickEvents)
      }
    }

    // 2. Compute visibility and enter/leave-FOV events for each agent.
    // Note: an agent that died THIS tick still gets one last perception_tick
    // so the queued `death` event reaches them before match_end.
    for (const a of this.agents.values()) {
      if (!a.alive && !a.diedThisTick) continue
      const visible = this.computeVisible(a)
      const events = perTickEvents.get(a.id)!
      const curIds = new Set(visible.map((v) => v.id))
      for (const id of curIds) if (!a.lastVisible.has(id)) events.push({ type: 'entity_entered_fov', id })
      for (const id of a.lastVisible) if (!curIds.has(id)) events.push({ type: 'entity_left_fov', id })
      a.lastVisible = curIds

      const body: TickBody = {
        tick: this.tick,
        t_ms: Date.now(),
        self: {
          pos: a.pos,
          hp: a.hp,
          facing: a.facing,
          path_remaining: a.path_remaining.slice(),
          path_id: a.pathId,
          attack_state: this.toWireAttackState(a),
        },
        visible_entities: visible,
        events,
      }
      a.buffer.push(body)
      const msg: PerceptionTick = { type: 'perception_tick', ...body }
      a.send(msg)
      a.diedThisTick = false   // one-shot — they won't get another perception_tick
    }

    // 3. Resolve any pending future-slice requests whose `to_tick` has arrived.
    for (const a of this.agents.values()) {
      const stillPending: typeof a.pendingFutureSlices = []
      for (const req of a.pendingFutureSlices) {
        if (this.tick >= req.to_tick) {
          const ticks = a.buffer.slice(req.from_tick, req.to_tick)
          if (ticks === null) {
            const err: ErrorMsg = {
              type: 'error',
              request_id: req.request_id,
              reason: 'tick_too_old',
              detail: 'future slice expired before service',
            }
            a.send(err)
          } else {
            const reply: GetTicksReply = { type: 'get_ticks_reply', request_id: req.request_id, ticks }
            a.send(reply)
          }
        } else {
          stillPending.push(req)
        }
      }
      a.pendingFutureSlices = stillPending
    }

    // 4. End-of-match check. Elimination-victory only applies when at least
    // two agents started — otherwise a solo match would end on tick 1.
    const alive = [...this.agents.values()].filter((a) => a.alive)
    const eliminationVictory = this.initialAgentCount >= 2 && alive.length <= 1
    if (eliminationVictory || this.tick >= MATCH_TIMEOUT_TICKS) {
      this.endMatch(eliminationVictory ? (alive[0]?.id ?? null) : null)
    }
  }

  private endMatch(victorId: string | null) {
    if (this.state === 'ended') return
    this.state = 'ended'
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null

    // Snapshot agents before sending+closing — `a.close()` may synchronously
    // fire its 'close' handler which re-enters `leave()` and mutates
    // `this.agents` mid-iteration.
    const snapshot = [...this.agents.values()]
    let placement = snapshot.length
    for (const a of snapshot) {
      const cause: MatchEnd['cause'] =
        a.id === victorId ? 'victory' : !a.alive ? 'killed_by' : 'time_out'
      const end: MatchEnd = {
        type: 'match_end',
        cause,
        ...(cause === 'killed_by' ? { by: a.lastAttackerId ?? 'unknown' } : {}),
        placement: a.id === victorId ? 1 : placement--,
        match_duration_ticks: this.tick,
        final_self: { pos: a.pos, hp: a.hp, facing: a.facing },
      }
      a.send(end)
      a.close()
    }
    if (this.onEnded) this.onEnded()
  }

  get isEnded() { return this.state === 'ended' }

  // ─── Per-agent message handlers ────────────────────────────────────────

  handleAction(agentId: string, msg: ActionMessage): ActionReply {
    const a = this.agents.get(agentId)
    if (!a) return this.reject('-', 'not_in_match', 'no such agent')
    if (this.state !== 'active') return this.reject(msg.action_id, 'not_in_match', 'match not active')
    if (!a.alive) return this.reject(msg.action_id, 'dead', 'agent is dead')

    // Rate limit window: trailing 1 s.
    const now = Date.now()
    a.actionTimestamps = a.actionTimestamps.filter((t) => now - t < 1000)
    if (a.actionTimestamps.length >= this.world.max_actions_per_second) {
      return this.reject(msg.action_id, 'rate_limited', `max ${this.world.max_actions_per_second} actions/sec`)
    }
    a.actionTimestamps.push(now)

    const act = msg.action
    if (act.type === 'set_path' || act.type === 'clear_path') {
      // Movement lock: an active attack with locks_movement = true bars both
      // set_path and clear_path until the bot exits the FSM.
      if (a.attackState !== null) {
        const def = this.attackDefForMoveId(a.attackState.moveId)
        if (def && def.locks_movement) {
          return this.reject(msg.action_id, 'movement_locked_in_attack',
            `agent is in attack_state ${a.attackState.moveId}; submit attack_step with the attack's exit move to release movement`)
        }
      }
    }

    if (act.type === 'set_path') {
      if (act.waypoints.length > this.world.max_waypoints_per_action) {
        return this.reject(msg.action_id, 'too_many_waypoints',
          `max ${this.world.max_waypoints_per_action} waypoints; got ${act.waypoints.length}`)
      }
      const exp = expandPath(a.pos, act.waypoints, {
        gridW: this.world.grid_size[0],
        gridH: this.world.grid_size[1],
        isBlocked: (x, y) => {
          const occ = this.occupancy.get(`${x},${y}`)
          return occ !== undefined && occ !== a.id
        },
        maxPathLength: this.world.max_path_length,
      })
      if (!exp.ok) return this.reject(msg.action_id, exp.reason, exp.detail)
      a.path_remaining = exp.expanded_path
      a.pathId = msg.action_id
      a.originalWaypoints = act.waypoints.slice()
      return { type: 'action_reply', action_id: msg.action_id, status: 'accepted', tick: this.tick, result: { expanded_path: exp.expanded_path } }
    }

    if (act.type === 'clear_path') {
      a.path_remaining = []
      a.pathId = null
      a.originalWaypoints = []
      return { type: 'action_reply', action_id: msg.action_id, status: 'accepted', tick: this.tick, result: {} }
    }

    if (act.type === 'attack_step') {
      return this.handleAttackStep(a, msg.action_id, act.attack_id, act.move_id)
    }

    return this.reject(msg.action_id, 'unknown_action', `unknown action type`)
  }

  // Resolves the attack definition for a fully-qualified move_id like "punch.jab".
  private attackDefForMoveId(moveId: string): AttackDef | null {
    const dot = moveId.indexOf('.')
    if (dot <= 0) return null
    const name = moveId.slice(0, dot)
    return this.world.attacks[name] ?? null
  }

  // Validates a transition and applies it. Actions arrive between ticks (from
  // the WS read loop), so any emitted events land in `pendingEventsForNextTick`
  // and the tick loop drains them into the next perception_tick's events[].
  private handleAttackStep(
    a: Agent,
    actionId: string,
    attackId: string,
    moveId: string,
  ): ActionReply {
    const def = this.attackDefForMoveId(moveId)
    if (!def) {
      // The move_id's "<attack>." prefix didn't match any attack in the
      // world's registry. In v1 this only happens for typos/unknown attacks.
      // attack_not_available is reserved for the *learned-attacks* iteration
      // (the agent knows the attack exists but hasn't unlocked it).
      return this.reject(actionId, 'invalid_move_transition', `unknown attack or move_id "${moveId}"`)
    }
    const move = def.fsm[moveId]
    if (!move) return this.reject(actionId, 'invalid_move_transition', `no such move_id "${moveId}"`)

    if (a.attackState === null) {
      // Entering the FSM: only the attack's entry move is legal here.
      if (moveId !== def.entry) {
        return this.reject(actionId, 'invalid_move_transition',
          `agent is idle; only entry move "${def.entry}" can begin this attack`)
      }
      // locks_movement: drop any active path silently (bot caused this; their
      // action_reply tells them; no synthetic path_interrupted event).
      if (def.locks_movement) {
        a.path_remaining = []
        a.pathId = null
        a.originalWaypoints = []
      }
    } else {
      // Already in a FSM. Validate this transition.
      const cur = def.fsm[a.attackState.moveId]
      if (!cur) {
        return this.reject(actionId, 'invalid_move_transition', `unknown current move_id "${a.attackState.moveId}"`)
      }
      if (!cur.transitions.includes(moveId)) {
        return this.reject(actionId, 'invalid_move_transition',
          `from "${a.attackState.moveId}" cannot transition to "${moveId}"; valid: [${cur.transitions.join(', ')}]`)
      }
      const elapsed = this.tick - a.attackState.sinceTick
      if (elapsed < cur.min_duration_ticks) {
        return this.reject(actionId, 'move_too_early',
          `min_duration_ticks=${cur.min_duration_ticks} not elapsed (only ${elapsed} ticks in "${a.attackState.moveId}")`)
      }
      // Bot can't pre-empt a server-controlled frame.
      if (cur.control === 'server') {
        return this.reject(actionId, 'move_server_controlled',
          `current move "${a.attackState.moveId}" is server-controlled; cannot be transitioned by the bot (wait for auto_advance_at_tick)`)
      }
    }

    // On transitions (not entry), the canonical attack_id is the one stored
    // when the bot first entered the FSM. The bot-supplied attackId is
    // advisory; substituting prevents events from being labelled with a
    // stale/mismatched correlator.
    const canonicalAttackId = a.attackState !== null ? a.attackState.attackId : attackId

    // Terminal moves drop the agent back to attack_state = null.
    if (move.control === 'terminal') {
      a.attackState = null
      this.queueEvent(a.id, { type: 'attack_step_committed', attack_id: canonicalAttackId, move_id: moveId, source: 'bot' })
      return { type: 'action_reply', action_id: actionId, status: 'accepted', tick: this.tick, result: {} }
    }

    a.attackState = {
      attackId: canonicalAttackId,
      moveId,
      sinceTick: this.tick,
      autoAdvanceAtTick: move.control === 'server' ? this.tick + move.min_duration_ticks : null,
    }

    this.queueEvent(a.id, { type: 'attack_step_committed', attack_id: canonicalAttackId, move_id: moveId, source: 'bot' })

    const reportState: AttackState = {
      attack_id: canonicalAttackId,
      move_id: moveId,
      since_tick: this.tick,
      auto_advance_at_tick: a.attackState.autoAdvanceAtTick,
      valid_next_moves: move.transitions,
    }
    return { type: 'action_reply', action_id: actionId, status: 'accepted', tick: this.tick, result: { attack_state: reportState } }
  }

  private queueEvent(agentId: string, event: Event) {
    this.pendingEventsForNextTick.push({ agentId, event })
  }

  handleGetTicks(agentId: string, msg: GetTicksMessage): GetTicksReply | ErrorMsg | null {
    const a = this.agents.get(agentId)
    if (!a) return { type: 'error', request_id: msg.request_id, reason: 'tick_too_old', detail: 'no such agent' }
    if (msg.from_tick > msg.to_tick) {
      return { type: 'error', request_id: msg.request_id, reason: 'invalid_range', detail: `from_tick ${msg.from_tick} > to_tick ${msg.to_tick}` }
    }
    if (msg.to_tick - msg.from_tick + 1 > this.world.slice_buffer_ticks) {
      return { type: 'error', request_id: msg.request_id, reason: 'range_too_large', detail: `window ${msg.to_tick - msg.from_tick + 1} > slice_buffer_ticks ${this.world.slice_buffer_ticks}` }
    }
    if (a.pendingFutureSlices.length >= this.world.max_inflight_get_ticks && msg.to_tick > this.tick) {
      return { type: 'error', request_id: msg.request_id, reason: 'rate_limited', detail: 'max_inflight_get_ticks exceeded' }
    }
    // Pure future or spanning: queue, reply later from onTick.
    if (msg.to_tick > this.tick) {
      a.pendingFutureSlices.push({ request_id: msg.request_id, from_tick: msg.from_tick, to_tick: msg.to_tick })
      return null
    }
    // Pure past (or snapshot at exactly current_tick).
    const oldest = a.buffer.oldestTick ?? msg.from_tick
    if (msg.from_tick < oldest) {
      return { type: 'error', request_id: msg.request_id, reason: 'tick_too_old', detail: `from_tick ${msg.from_tick} older than oldest retained ${oldest}` }
    }
    const ticks = a.buffer.slice(msg.from_tick, msg.to_tick)
    if (ticks === null) {
      return { type: 'error', request_id: msg.request_id, reason: 'tick_too_old', detail: 'slice spans outside retained buffer' }
    }
    return { type: 'get_ticks_reply', request_id: msg.request_id, ticks }
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private reject(action_id: string, reason: ActionRejectReason, detail: string): ActionReply {
    return { type: 'action_reply', action_id, status: 'rejected', tick: this.tick, reason, detail }
  }

  private key(t: Tile) { return `${t[0]},${t[1]}` }

  private pickSpawn(): Tile {
    // Place agents along a ring around the arena center so they don't overlap.
    const [w, h] = this.world.grid_size
    const cx = Math.floor(w / 2)
    const cy = Math.floor(h / 2)
    const n = this.agents.size
    const r = 3 + Math.floor(n / 8)
    const theta = (n / Math.max(1, 8)) * 2 * Math.PI
    const x = Math.max(0, Math.min(w - 1, cx + Math.round(r * Math.cos(theta))))
    const y = Math.max(0, Math.min(h - 1, cy + Math.round(r * Math.sin(theta))))
    if (!this.occupancy.has(this.key([x, y]))) return [x, y]
    // Fallback: linear scan.
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      if (!this.occupancy.has(this.key([xx, yy]))) return [xx, yy]
    }
    return [0, 0]
  }

  private facingFromMove(from: Tile, to: Tile): Facing | null {
    const dx = to[0] - from[0]
    const dy = to[1] - from[1]
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left'
    if (Math.abs(dy) > 0) return dy > 0 ? 'down' : 'up'
    return null
  }

  private computeVisible(agent: Agent): VisibleEntity[] {
    const out: VisibleEntity[] = []
    const r = this.world.fov_radius
    for (const other of this.agents.values()) {
      if (other.id === agent.id || !other.alive) continue
      const dist = Math.max(Math.abs(other.pos[0] - agent.pos[0]), Math.abs(other.pos[1] - agent.pos[1]))
      if (dist > r) continue
      out.push({
        id: other.id,
        pos: other.pos,
        hp: other.hp,
        kind: 'player',
        facing: other.facing,
        attack_move_id: other.attackState?.moveId ?? null,
      })
    }
    return out
  }

  private toWireAttackState(a: Agent): AttackState | null {
    if (a.attackState === null) return null
    const def = this.attackDefForMoveId(a.attackState.moveId)
    const move = def?.fsm[a.attackState.moveId]
    return {
      attack_id: a.attackState.attackId,
      move_id: a.attackState.moveId,
      since_tick: a.attackState.sinceTick,
      auto_advance_at_tick: a.attackState.autoAdvanceAtTick,
      valid_next_moves: move?.transitions ?? [],
    }
  }

  // Server auto-advance of an attack frame (control: 'server'). Server-controlled
  // moves have a single deterministic next transition; on entering the impact
  // frame (def.damage_at) we resolve damage on the tile in front of the
  // attacker.
  private serverAdvanceAttack(a: Agent, perTickEvents: Map<string, Event[]>) {
    const st = a.attackState
    if (st === null) return
    const def = this.attackDefForMoveId(st.moveId)
    if (!def) { a.attackState = null; return }
    const cur = def.fsm[st.moveId]
    if (!cur || cur.transitions.length === 0) { a.attackState = null; return }
    const nextId = cur.transitions[0]
    const next = def.fsm[nextId]
    if (!next) { a.attackState = null; return }

    // Update attackState to the new frame (or null if next is terminal).
    if (next.control === 'terminal') {
      a.attackState = null
    } else {
      a.attackState = {
        attackId: st.attackId,
        moveId: nextId,
        sinceTick: this.tick,
        autoAdvanceAtTick: next.control === 'server' ? this.tick + next.min_duration_ticks : null,
      }
    }

    const eventsForAttacker = perTickEvents.get(a.id)!
    eventsForAttacker.push({ type: 'attack_step_committed', attack_id: st.attackId, move_id: nextId, source: 'server' })

    // Resolve damage on entering the impact frame.
    if (nextId === def.damage_at) {
      this.resolveImpact(a, def, st.attackId, nextId, perTickEvents)
    }
  }

  // Compute the target tile based on the attack's range shape and the
  // attacker's facing, then apply damage (or whiff).
  private resolveImpact(
    attacker: Agent,
    def: AttackDef,
    attackId: string,
    moveId: string,
    perTickEvents: Map<string, Event[]>,
  ) {
    let targetTile: Tile | null = null
    if (def.range.shape === 'facing_adjacent') {
      if (attacker.facing === 'left')  targetTile = [attacker.pos[0] - 1, attacker.pos[1]]
      if (attacker.facing === 'right') targetTile = [attacker.pos[0] + 1, attacker.pos[1]]
      // up/down whiff by definition until those sprites + range shapes exist.
    }

    const attackerEvents = perTickEvents.get(attacker.id)!
    if (targetTile === null) {
      attackerEvents.push({ type: 'attack_whiffed', attack_id: attackId, move_id: moveId })
      return
    }
    const targetId = this.occupancy.get(this.key(targetTile))
    if (targetId === undefined) {
      attackerEvents.push({ type: 'attack_whiffed', attack_id: attackId, move_id: moveId })
      return
    }
    const target = this.agents.get(targetId)
    if (!target || !target.alive) {
      attackerEvents.push({ type: 'attack_whiffed', attack_id: attackId, move_id: moveId })
      return
    }

    target.hp = Math.max(0, target.hp - def.damage_amount)
    target.lastAttackerId = attacker.id
    attackerEvents.push({
      type: 'damage_dealt',
      attack_id: attackId,
      target_id: target.id,
      amount: def.damage_amount,
      move_id: moveId,
    })
    perTickEvents.get(target.id)!.push({
      type: 'damage_taken',
      amount: def.damage_amount,
      by: attacker.id,
    })
    if (target.hp === 0) {
      target.alive = false
      target.diedThisTick = true            // emit one final perception_tick this tick so the death event is delivered
      target.attackState = null             // clear any pending FSM so toWireAttackState doesn't leak it
      this.occupancy.delete(this.key(target.pos))
      perTickEvents.get(target.id)!.push({ type: 'death', by: attacker.id })
    }
  }

  // For graceful shutdown.
  shutdown() {
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.startTimer) clearTimeout(this.startTimer)
    for (const a of this.agents.values()) a.close()
  }

  currentTick(): number { return this.tick }
}
