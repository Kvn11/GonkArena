// Wire protocol v1.0 — see /home/kev/.claude/plans/i-have-placed-some-sharded-engelbart.md
// All messages are JSON over WebSocket text frames. Every message has a `type` field.

export const PROTOCOL_VERSION = '1.0'

export type Tile = [number, number]
export type Facing = 'up' | 'down' | 'left' | 'right'
export type EntityKind = 'player'

// ─── Shared shapes ─────────────────────────────────────────────────────────

export type AttackState = {
  attack_id: string                  // bot-chosen correlator for one attack instance
  move_id: string                    // e.g. "punch.stance"
  since_tick: number                 // tick the current frame began
  auto_advance_at_tick: number | null  // non-null = server will auto-advance on this tick; null = waiting on bot
  valid_next_moves: string[]         // move_ids the bot may submit now (may include cancel target and ".exit")
}

export type SelfState = {
  pos: Tile
  hp: number
  facing: Facing
  path_remaining: Tile[]
  path_id: string | null   // action_id of the set_path currently being executed, or null when idle
  attack_state: AttackState | null   // non-null while in any attack FSM (incl. stance)
}

export type VisibleEntity = {
  id: string
  pos: Tile
  hp: number
  kind: EntityKind
  facing: Facing
  attack_move_id: string | null      // current attack FSM frame, or null when idle
}

export type Event =
  | { type: 'entity_entered_fov'; id: string }
  | { type: 'entity_left_fov'; id: string }
  | { type: 'damage_taken'; amount: number; by: string }
  | { type: 'damage_dealt'; attack_id: string; target_id: string; amount: number; move_id: string }
  | { type: 'attack_step_committed'; attack_id: string; move_id: string; source: 'bot' | 'server' }
  | { type: 'attack_whiffed'; attack_id: string; move_id: string }
  | { type: 'path_step_completed'; to: Tile }
  | { type: 'path_completed'; path_id: string }
  | {
      type: 'path_interrupted'
      halted_at: Tile
      blocker_id: string
      remaining_waypoints: Tile[]
      path_id: string
    }
  | { type: 'death'; by: string }

// ─── Server → Bot ──────────────────────────────────────────────────────────

// `control` semantics for a frame in an attack FSM:
//   "bot"      — held until the bot submits a transition (cancellable frames).
//   "server"   — server auto-advances at sinceTick + min_duration_ticks (committed frames).
//   "terminal" — sentinel; reaching this drops the agent back to attack_state = null.
export type AttackMoveControl = 'bot' | 'server' | 'terminal'

export type AttackMove = {
  transitions: string[]            // move_ids that may follow this one
  min_duration_ticks: number       // ticks that must elapse in this frame before any transition
  control: AttackMoveControl
}

export type AttackRange = { shape: 'facing_adjacent' }   // tile immediately left/right per attacker.facing

export type AttackDef = {
  kind: 'instinctual' | 'learned'
  locks_movement: boolean
  range: AttackRange
  damage_at: string                // move_id at which damage applies (the impact frame)
  damage_amount: number
  fsm: Record<string, AttackMove>
  entry: string                    // move_id used to enter this attack from attack_state = null
}

export type WorldConfig = {
  grid_size: [number, number]
  tick_rate_hz: number
  fov_radius: number
  max_path_length: number
  max_waypoints_per_action: number
  max_actions_per_second: number
  max_inflight_get_ticks: number
  slice_buffer_ticks: number
  min_agents_for_match: number    // match won't start until at least this many agents have connected
  attacks: Record<string, AttackDef>   // attack_id → definition; punch is shipped to every agent
}

export type Welcome = {
  type: 'welcome'
  protocol_version: string
  agent_id: string
  match_id: string
  server_time_ms: number
  world: WorldConfig
  self_spawn: { pos: Tile; hp: number; facing: Facing }
  schemas: Record<string, unknown>
  rules: Record<string, string>
}

export type MatchStart = {
  type: 'match_start'
  tick: number
  t_ms: number
  n_agents: number
}

// Sent during the 'waiting' lobby phase whenever an agent joins or leaves, and
// once when the pre-match countdown begins. Bots can show "waiting for N more"
// status, or just ignore and wait for match_start.
export type LobbyUpdate = {
  type: 'lobby_update'
  agents_present: number
  agents_needed: number              // == world.min_agents_for_match
  starting_in_ms: number | null      // non-null when the pre-match countdown is running
}

export type PerceptionTick = {
  type: 'perception_tick'
  tick: number
  t_ms: number
  self: SelfState
  visible_entities: VisibleEntity[]
  events: Event[]
}

export type ActionRejectReason =
  | 'out_of_bounds'
  | 'path_too_long'
  | 'too_many_waypoints'
  | 'no_path_to_waypoint'   // reserved for future walls/topology: goal is structurally unreachable
  | 'path_blocked'          // A* failed because intermediate tiles are occupied by entities — wait+retry may succeed
  | 'waypoint_occupied'     // the goal tile itself is occupied by another entity — pick a neighbour, or attack
  | 'invalid_move_transition'   // requested move_id is not in current frame's `transitions`
  | 'move_too_early'            // requested move_id is valid, but min_duration_ticks hasn't elapsed in the current frame yet
  | 'move_server_controlled'    // current frame is server-paced (control: "server"); bot cannot pre-empt — wait for auto_advance_at_tick
  | 'attack_not_available'      // move_id references an attack the agent hasn't unlocked (reserved for learned attacks)
  | 'movement_locked_in_attack' // set_path/clear_path during a movement-locking attack — submit attack exit first
  | 'unknown_action'
  | 'rate_limited'
  | 'not_in_match'
  | 'dead'

// Reply result variants:
//   set_path     → { expanded_path }
//   clear_path   → {}
//   attack_step  → { attack_state } when entering/transitioning a FSM, or {} when exiting (attack_state = null)
export type ActionReply =
  | {
      type: 'action_reply'
      action_id: string
      status: 'accepted'
      tick: number
      result:
        | { expanded_path: Tile[] }
        | Record<string, never>
        | { attack_state: AttackState }
    }
  | {
      type: 'action_reply'
      action_id: string
      status: 'rejected'
      tick: number
      reason: ActionRejectReason
      detail: string
    }

export type GetTicksReply = {
  type: 'get_ticks_reply'
  request_id: string
  ticks: Omit<PerceptionTick, 'type'>[]
}

export type GetTicksErrorReason =
  | 'tick_too_old'
  | 'invalid_range'
  | 'range_too_large'
  | 'rate_limited'

export type ErrorMsg = {
  type: 'error'
  request_id: string
  reason: GetTicksErrorReason
  detail: string
}

export type MatchEnd = {
  type: 'match_end'
  cause: 'victory' | 'killed_by' | 'time_out' | 'kicked'
  by?: string
  placement: number
  match_duration_ticks: number
  final_self: { pos: Tile; hp: number; facing: Facing }
}

export type ServerMessage =
  | Welcome
  | MatchStart
  | LobbyUpdate
  | PerceptionTick
  | ActionReply
  | GetTicksReply
  | ErrorMsg
  | MatchEnd

// ─── Bot → Server ──────────────────────────────────────────────────────────

export type ActionPayload =
  | { type: 'set_path'; waypoints: Tile[] }
  | { type: 'clear_path' }
  | { type: 'attack_step'; attack_id: string; move_id: string }

export type ActionMessage = {
  type: 'action'
  action_id: string
  action: ActionPayload
}

export type GetTicksMessage = {
  type: 'get_ticks'
  request_id: string
  from_tick: number
  to_tick: number
}

export type ClientMessage = ActionMessage | GetTicksMessage
