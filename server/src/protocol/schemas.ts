// Inline JSON-Schema-lite definitions shipped in `welcome.schemas`. Bot authors
// (and the LLM helping them) can paste this object into a prompt and have the
// entire wire surface in context.
//
// "JSON-Schema-lite" means: not formally valid JSON Schema — just human/LLM-
// readable shape descriptors. Each value is either a primitive name ("number",
// "string", etc.) or an object literal that describes a nested shape. Arrays
// are described as `[ <element-shape> ]`.

export const SCHEMAS = {
  welcome: {
    type: '"welcome"',
    protocol_version: 'string',
    agent_id: 'string',
    match_id: 'string',
    server_time_ms: 'number',
    world: {
      grid_size: '[number, number]',
      tick_rate_hz: 'number',
      fov_radius: 'number',
      max_path_length: 'number',
      max_waypoints_per_action: 'number',
      max_actions_per_second: 'number',
      max_inflight_get_ticks: 'number',
      slice_buffer_ticks: 'number',
      min_agents_for_match: 'number',
      attacks:
        '{ [attack_name: string]: { kind: "instinctual"|"learned", locks_movement: boolean, range: { shape: "facing_adjacent" }, damage_at: string, damage_amount: number, entry: string, fsm: { [move_id: string]: { transitions: string[], min_duration_ticks: number, control: "bot"|"server"|"terminal" } } } }   // registry of attacks available to the agent; punch is always present',
    },
    self_spawn: {
      pos: '[number, number]',
      hp: 'number',
      facing: '"up" | "down" | "left" | "right"',
    },
    schemas: 'object (this very object)',
    rules: '{ [key: string]: string }',
  },

  match_start: {
    type: '"match_start"',
    tick: 'number',
    t_ms: 'number',
    n_agents: 'number',
  },

  perception_tick: {
    type: '"perception_tick"',
    tick: 'number',
    t_ms: 'number',
    self: {
      pos: '[number, number]',
      hp: 'number',
      facing: '"up" | "down" | "left" | "right"',
      path_remaining: '[ [number, number] ]   // [] if no active path',
      path_id: 'string | null   // action_id of set_path currently executing; null when idle',
      attack_state:
        '{ attack_id: string, move_id: string, since_tick: number, auto_advance_at_tick: number | null, valid_next_moves: string[] } | null   // non-null while in any attack FSM',
    },
    visible_entities: [
      {
        id: 'string',
        pos: '[number, number]',
        hp: 'number',
        kind: '"player"',
        facing: '"up" | "down" | "left" | "right"',
        attack_move_id: 'string | null   // current attack frame the entity is in (e.g. "punch.jab"); null when idle',
      },
    ],
    events:
      '[ { type: "entity_entered_fov" | "entity_left_fov" | "damage_taken" | "damage_dealt" | "attack_step_committed" | "attack_whiffed" | "path_step_completed" | "path_completed" | "path_interrupted" | "death", ... } ]',
  },

  lobby_update: {
    type: '"lobby_update"',
    agents_present: 'number',
    agents_needed: 'number   // == world.min_agents_for_match',
    starting_in_ms: 'number | null   // non-null when pre-match countdown is running',
  },

  action: {
    type: '"action"',
    action_id: 'string',
    action:
      '{ type: "set_path", waypoints: [[number,number]] } | { type: "clear_path" } | { type: "attack_step", attack_id: string, move_id: string }   // attack_step: submit one FSM transition. To enter the FSM from idle, use the attack\'s entry move_id (e.g. "punch.stance"). To exit, use "<attack>.exit".',
  },

  action_reply: {
    type: '"action_reply"',
    action_id: 'string',
    status: '"accepted" | "rejected"',
    tick: 'number',
    'result (when accepted)':
      '{ expanded_path: [[number,number]] }   // set_path  |  {}   // clear_path or attack_step → exit  |  { attack_state: { attack_id, move_id, since_tick, auto_advance_at_tick, valid_next_moves } }   // attack_step → entered/transitioned',
    'reason (when rejected)':
      '"out_of_bounds" | "path_too_long" | "too_many_waypoints" | "no_path_to_waypoint" | "path_blocked" | "waypoint_occupied" | "invalid_move_transition" | "move_too_early" | "move_server_controlled" | "attack_not_available" | "movement_locked_in_attack" | "unknown_action" | "rate_limited" | "not_in_match" | "dead"',
    'detail (when rejected)': 'string',
  },

  get_ticks: {
    type: '"get_ticks"',
    request_id: 'string',
    from_tick: 'number',
    to_tick: 'number',
  },

  get_ticks_reply: {
    type: '"get_ticks_reply"',
    request_id: 'string',
    ticks: '[ <perception_tick body without "type" field> ]',
  },

  match_end: {
    type: '"match_end"',
    cause: '"victory" | "killed_by" | "time_out" | "kicked"',
    by: 'string (present iff cause === "killed_by")',
    placement: 'number (1-indexed; 1 = winner)',
    match_duration_ticks: 'number',
    final_self: {
      pos: '[number, number]',
      hp: 'number',
      facing: '"up" | "down" | "left" | "right"',
    },
  },

  error: {
    type: '"error"',
    request_id: 'string',
    reason:
      '"tick_too_old" | "invalid_range" | "range_too_large" | "rate_limited"',
    detail: 'string',
  },
} as const

export const RULES = {
  move: 'Send action.set_path with a list of waypoints. Server runs A* between consecutive waypoints and walks the player one tile per tick. A new set_path replaces the current path immediately.',
  attack:
    'Attacks are frame-by-frame state machines (see world.attacks). Submit action.attack_step with a chosen attack_id and the next move_id. The FSM enforces transitions; some frames are bot-paced (you must submit next), others are server-paced (auto-advance). Damage applies at the attack\'s damage_at move. Punch is shipped to every agent under world.attacks.punch; range is the tile immediately left/right per your facing.',
  vision:
    'Each tick you receive your own state plus all entities whose Chebyshev distance from you is <= fov_radius. Entities outside the FOV are invisible. visible_entities[].attack_move_id shows the FSM frame the entity is currently in (e.g. you see them in punch.stance or punch.jab).',
  tick: 'Server tick is 10 Hz. A perception_tick is pushed every tick from match_start until match_end.',
} as const
