# GonkArena — Agent Protocol v1.0

This is everything you need to write a bot that plays GonkArena. Read it once,
then write code. You should not need any other source.

When you've used the protocol to play a match, please reply with concrete
feedback: what was confusing, what fields you wished existed, what error cases
the spec didn't cover, anything you tried that the server rejected for a reason
you couldn't have anticipated from this doc.

---

## What you are

You control one character on a 64×64 isometric tile grid. Other agents (humans
or AIs) control other characters. The match runs at 10 Hz on an authoritative
server. The match ends when only one character is alive, or after 300 ticks
(30 s) — whichever comes first.

You are an **external program**: you connect over a WebSocket and exchange
JSON messages. The server is the source of truth — it validates every move you
ask for, runs A* between the waypoints you submit, and walks your character
along the result one tile per tick.

The bot author (you) writes long-running code that consumes the server's
incoming stream and decides what actions to send. Calling an LLM per tick is
unnecessary and expensive — the recommended pattern is to write code that
handles the common cases, and only call an LLM when the situation is novel,
when your code's plan is failing, or to update your high-level strategy.

---

## Connection

- URL: `ws://localhost:2567/agent` (the server default; override per
  deployment).
- One WebSocket per agent per match. No reconnection in v1 — if the socket
  drops, you forfeit.
- Messages are JSON text frames, one JSON object per frame. Every message has
  a `type` field that is a `snake_case` string. There is no compression, no
  binary framing, no envelope around the JSON.

A 3-line connection in Python:

```python
import json, websocket
ws = websocket.create_connection("ws://localhost:2567/agent")
welcome = json.loads(ws.recv())
```

A 3-line connection in Node.js:

```js
import { WebSocket } from 'ws'
const ws = new WebSocket('ws://localhost:2567/agent')
ws.on('message', (raw) => console.log(JSON.parse(raw.toString())))
```

---

## Lifecycle

```
   bot                                   server
    │  WS upgrade                          │
    │ ───────────────────────────────────▶ │
    │                                       │
    │ ◀── welcome ────────────────────────  │   one-shot context (see below)
    │                                       │
    │     (server waits briefly for         │
    │      other agents to connect)         │
    │                                       │
    │ ◀── match_start ────────────────────  │   tick stream begins now
    │ ◀── perception_tick (every 100 ms) ─  │
    │                                       │
    │  ─── action ──────────────────────▶  │   bot-initiated, any time
    │ ◀── action_reply ─────────────────── │   always one reply per action
    │                                       │
    │  ─── get_ticks ───────────────────▶  │   bot-initiated, any time
    │ ◀── get_ticks_reply ─────────────── │
    │                                       │
    │     …match plays out…                 │
    │                                       │
    │ ◀── perception_tick (events:[death])  │   you got killed (or didn't)
    │ ◀── match_end ───────────────────── │   final summary, then WS closes
```

Important lifecycle facts:

- `welcome` is sent exactly once, immediately on connect.
- `perception_tick` does **not** stream until you receive `match_start`. Don't
  start your main loop before then.
- After `match_end` the server closes the socket. There is no "play again" —
  reconnect to play a new match.
- If you submit an action between `welcome` and `match_start`, it's rejected
  with reason `not_in_match`.

---

## Message: `welcome` (server → bot, once)

```jsonc
{
  "type": "welcome",
  "protocol_version": "1.0",
  "agent_id": "p_74048e46",
  "match_id": "m_2026-05-22T18-03-00",
  "server_time_ms": 1747940583042,

  "world": {
    "grid_size": [64, 64],
    "tick_rate_hz": 10,
    "fov_radius": 8,
    "max_path_length": 16,
    "max_waypoints_per_action": 8,
    "max_actions_per_second": 20,
    "max_inflight_get_ticks": 4,
    "slice_buffer_ticks": 100,
    "min_agents_for_match": 1,
    "attacks": {
      "punch": {
        "kind": "instinctual",
        "locks_movement": true,
        "range": { "shape": "facing_adjacent" },
        "damage_at": "punch.jab",
        "damage_amount": 10,
        "entry": "punch.stance",
        "fsm": {
          "punch.stance": { "transitions": ["punch.jab", "punch.exit"], "min_duration_ticks": 0, "control": "bot" },
          "punch.jab":    { "transitions": ["punch.stance"],            "min_duration_ticks": 4, "control": "server" },
          "punch.exit":   { "transitions": [],                          "min_duration_ticks": 0, "control": "terminal" }
        }
      }
    }
  },

  "self_spawn": { "pos": [34, 34], "hp": 100, "facing": "down" },

  "schemas": { /* same shapes as documented below — given inline for LLMs */ },

  "rules": {
    "move":   "Send action.set_path with a list of waypoints. Server runs A* between consecutive waypoints and walks the player one tile per tick. A new set_path replaces the current path immediately.",
    "attack": "Attacks are frame-by-frame state machines (see world.attacks). Submit action.attack_step with a chosen attack_id and the next move_id. The FSM enforces transitions; some frames are bot-paced, others server-paced. Damage applies at the attack's damage_at move. Punch is shipped to every agent.",
    "vision": "Each tick you receive your own state plus all entities whose Chebyshev distance from you is <= fov_radius. Entities outside the FOV are invisible. visible_entities[].attack_move_id shows the FSM frame they're currently in (e.g. you see them in punch.stance or punch.jab).",
    "tick":   "Server tick is 10 Hz. A perception_tick is pushed every tick from match_start until match_end."
  }
}
```

Read everything in `world` and bake those numbers into your code as constants —
don't hard-code different ones. The server will enforce them.

---

## Message: `lobby_update` (server → bot, while waiting)

Between `welcome` and `match_start`, the server emits `lobby_update` whenever
the lobby state changes — new agent joins, one leaves, or the pre-match
countdown begins. Bots can use this to show a "waiting for N more…" status
or just ignore it.

```jsonc
// Sit-and-wait — under the threshold:
{ "type": "lobby_update",
  "agents_present": 1,
  "agents_needed": 2,
  "starting_in_ms": null }

// Threshold reached — countdown is running:
{ "type": "lobby_update",
  "agents_present": 2,
  "agents_needed": 2,
  "starting_in_ms": 5000 }
```

The match does **not** start until `agents_present >= agents_needed`. The
v1.0 default is `min_agents_for_match: 1`, so a solo connect triggers the
pre-match countdown immediately; the match will run on the timeout (5 min)
since there are no opponents. To require multiple agents, run the server
with `MIN_AGENTS=N` and the threshold becomes N. Win conditions (combat,
elimination) are a separate iteration.

## Message: `match_start` (server → bot, once)

```jsonc
{ "type": "match_start", "tick": 0, "t_ms": 1747940590000, "n_agents": 2 }
```

This is the gun. After this message arrives, `perception_tick` messages start
arriving every 100 ms.

---

## Message: `perception_tick` (server → bot, every tick)

```jsonc
{
  "type": "perception_tick",
  "tick": 43,
  "t_ms": 1747940687142,

  "self": {
    "pos": [34, 35],
    "hp": 100,
    "facing": "right",
    "path_remaining": [[34, 36], [34, 37]],
    "path_id": "a_017",

    // Mid-FSM example — currently in jab, which is server-paced.
    // The server will auto-advance back to stance on tick 47 (since_tick=43,
    // min_duration_ticks=4). valid_next_moves is empty: for server-paced
    // frames the bot can't submit anything; it just waits.
    "attack_state": {
      "attack_id": "atk_1",
      "move_id": "punch.jab",
      "since_tick": 43,
      "auto_advance_at_tick": 47,
      "valid_next_moves": []
    }
    // When idle: attack_state is null.
    // When in stance (bot-paced): auto_advance_at_tick is null and
    // valid_next_moves is ["punch.jab", "punch.exit"].
  },

  "visible_entities": [
    { "id": "p_cc2ab573", "pos": [33, 31], "hp": 80, "kind": "player",
      "facing": "right", "attack_move_id": "punch.stance" }
  ],

  "events": [
    { "type": "path_step_completed", "to": [34, 35] }
    // see the full event catalog below
  ]
}
```

Key things to know:

- `self.path_remaining` is the **server's** view of what's still ahead. If
  you want to know whether your last `set_path` is still active, read this
  field — don't try to track it locally from `expanded_path` and step events,
  you'll get out of sync.
- `self.path_id` is the `action_id` of the `set_path` that produced your
  current path, or `null` when you're idle. Use this to correlate: if you
  see `path_id === "a_017"` and you sent `a_017` two seconds ago, the server
  is still walking you along it. If `path_id === null`, the path either
  completed naturally (see the `path_completed` event) or was interrupted.
- `visible_entities` lists everyone within Chebyshev distance `fov_radius` of
  your current position. **Anyone outside is invisible** — you have no way to
  ask "where is player X?" if X is not in your FOV. Each entry includes
  `attack_move_id`, the FSM frame the entity is currently in (e.g. you see
  them in `punch.stance` — they're guarding and *might* commit to a jab next
  tick, or in `punch.jab` — they've committed and damage is landing now).
  `null` when the entity is not in any attack FSM.
- `self.attack_state` mirrors **your own** position in any attack FSM you've
  entered. `null` when idle. The `valid_next_moves` array tells you exactly
  which `move_id` values you may submit next via `attack_step` (see the
  Attacks section below).
- `events` is everything that happened on **this** tick, server-confirmed. An
  empty list is the common case.

### Event catalog

| `type` | Fields | Meaning |
|---|---|---|
| `entity_entered_fov`     | `id`                                                                 | A new entity is visible to you this tick |
| `entity_left_fov`        | `id`                                                                 | An entity that was visible last tick is gone. No last-known-position is included — fog of war is intentional, you must remember positions yourself if you want to. |
| `damage_taken`           | `amount`, `by`                                                       | You were hit. |
| `damage_dealt`           | `attack_id`, `target_id`, `amount`, `move_id`                        | Your impact frame connected. Fires on the attacker. |
| `attack_step_committed`  | `attack_id`, `move_id`, `source` (`"bot"` or `"server"`)             | One of your attack frames locked in. `"server"` source means the server auto-advanced (committed-frame portion of the FSM). |
| `attack_whiffed`         | `attack_id`, `move_id`                                               | Your impact frame had no entity in the target tile. Fires on the attacker. |
| `path_step_completed`    | `to`                                                                 | You walked one tile of your active path |
| `path_completed`         | `path_id`                                                            | The `set_path` identified by `path_id` finished its last tile. You are now idle. |
| `path_interrupted`       | `halted_at`, `blocker_id`, `remaining_waypoints`, `path_id`          | The `set_path` identified by `path_id` hit an obstacle. You are now idle. Submit a new `set_path` to continue. |
| `death`                  | `by`                                                                 | Your HP reached 0 this tick. You'll receive `match_end` next tick. |

---

## Attacks: frame-by-frame state machines

Attacks are not single instant actions. They are state machines: a graph of
animation frames, where each frame transitions to one or more permitted
successor frames. You progress through an attack by submitting one
`attack_step` per transition. The server validates every transition against
the FSM declared in `world.attacks`.

It also defines what's *not* cancellable: some frames are server-paced
("committed"), once you cross into them the server completes the chain on
its own and you can't take it back.

### The punch FSM (shipped to every agent as "instinctual")

```
stance ←─────────┐
   │ (bot)        │
   ▼              │ (server, auto-advance)
 jab    ← damage applies here, uncancellable
```

- **stance** is bot-paced. You hold here indefinitely. You can submit
  `punch.jab` to commit, or `punch.exit` to leave the FSM and release
  movement.
- **jab** is server-paced: once you submit `punch.jab`, the server commits
  the punch (damage applies on entering this frame) and auto-advances back
  to stance after `min_duration_ticks`. You CANNOT cancel mid-jab —
  submitting any `attack_step` while in jab gets rejected with
  `move_server_controlled`. This is the "thrown punch / regaining balance"
  commitment.
- **`punch.exit`** is the terminal sentinel. Submitting it from `stance`
  drops you back to `attack_state: null` and releases movement.

`min_duration_ticks` applies to every frame: you must hold the current frame
for that many ticks before any transition is accepted. Stance is 0 ticks
(transition becomes legal on the next tick), jab is 4 ticks (400 ms at 10 Hz).

### Range and facing

Punch's `range.shape` is `"facing_adjacent"`: damage at `punch.jab` lands
on the tile immediately **left or right** of you, per your `facing`. Facing
up or down at the impact frame means you whiff — the punch has no up/down
range in v1.

**Facing updates from movement.** The server sets your `facing` from the
direction of each tile you walk: stepping one tile east → `facing: "right"`;
one tile north → `facing: "up"`; etc. To **turn without travelling**, send a
1-tile `set_path` in the desired direction immediately before entering the
FSM. The path-walking is movement-locked once you're in the FSM, so this
turn step *must* come first.

```jsonc
// I'm at [25, 21] facing "down". My target is at [26, 21] (one tile east).
// I need facing="right" before punching.
{ "type": "action", "action_id": "a_1",
  "action": { "type": "set_path", "waypoints": [[26, 21]] } }
// → server walks me to [26, 21], updates facing="right"
// → I'm now ADJACENT to the original target tile [27, 21] but they were at [26, 21]
// → better: pick a 1-tile path that updates facing without leaving range.
```

**Damage applies on entering `punch.jab`** — the same tick the server
commits the transition from stance. The server reads your `facing` and the
target tile's occupancy at that tick; if no valid target is there, the
attack whiffs.

### A note on `min_duration_ticks: 0`

`min_duration_ticks: 0` (used by `stance` and the `exit` sentinel) does
**not** mean "advance in the same tick". It means the next transition
becomes legal on the very next tick after the frame was entered. Per-tick
processing is sequential — actions arrive between ticks and are validated
against the tick at which they arrive.

### Movement lock

`punch.locks_movement === true`. While you are in **any** non-`null`
`attack_state`, `set_path` and `clear_path` are rejected with
`movement_locked_in_attack`. To walk again you must submit `attack_step` with
`move_id: "punch.exit"`.

### Visibility of others' attacks

`visible_entities[].attack_move_id` tells you what frame each visible
opponent is currently in. A bot that sees an opponent in `punch.stance`
should expect they may commit to a jab on the next tick — there's no
windup, so reaction-time defence is tight.

---

## Message: `action` (bot → server)

You send one of three sub-types under a common envelope:

```jsonc
// Set or replace your path. Server A*s between consecutive waypoints.
{ "type": "action", "action_id": "a_001",
  "action": { "type": "set_path", "waypoints": [[36, 34], [36, 36]] } }

// Stop walking immediately.
{ "type": "action", "action_id": "a_002",
  "action": { "type": "clear_path" } }

// Submit one transition in an attack FSM. attack_id is YOUR correlator for
// the attack instance (same role as path_id for paths); pick a fresh one when
// entering the FSM from idle. move_id is the next frame you want to be in.
{ "type": "action", "action_id": "a_003",
  "action": { "type": "attack_step",
              "attack_id": "atk_1",
              "move_id":   "punch.stance" } }
```

`action_id` is a string you pick for correlation. Any unique string works; the
server echoes it back in `action_reply`. You'll want to use it if you have
multiple actions in flight.

The smallest punch you can throw:

```text
1. attack_step attack_id=atk_1 move_id="punch.stance"   ← enter FSM
2. (next tick — stance min_duration is 0)
3. attack_step attack_id=atk_1 move_id="punch.jab"      ← commits, damage applies
4. (server auto-advances jab → stance after 4 ticks)
5. attack_step attack_id=atk_1 move_id="punch.exit"     ← releases movement
```

To not commit, replace step 3 with `move_id: "punch.exit"` — you leave the
FSM from stance and never throw.

### `action_reply` — always sent, one per `action`

```jsonc
// Accepted:
{ "type": "action_reply", "action_id": "a_001", "status": "accepted", "tick": 43,
  "result": { "expanded_path": [[34,34],[35,34],[36,34],[36,35],[36,36]] } }

// Rejected:
{ "type": "action_reply", "action_id": "a_001", "status": "rejected", "tick": 43,
  "reason": "no_path_to_waypoint",
  "detail": "no A* solution from [36,34] to [36,36]" }
```

For `set_path`, `result.expanded_path` is the **actual tile-by-tile route**
after A* — including diagonals. The route excludes your current tile, but
includes every tile you'll walk through (including waypoints). Use the length
to estimate ETA: 1 tile per tick.

For `clear_path`, `result` is `{}`.

For `attack_step` that enters or transitions a FSM, `result` is
`{ "attack_state": { attack_id, move_id, since_tick, auto_advance_at_tick, valid_next_moves } }`.
For `attack_step` with `move_id` set to the attack's terminal exit
(e.g. `"punch.exit"`), `result` is `{}` — you've left the FSM.

### Rejection reasons (closed enum — safe to `switch` on)

| `reason` | When it happens |
|---|---|
| `out_of_bounds`      | A waypoint or target tile is outside `world.grid_size` |
| `path_too_long`      | Expanded path exceeds `world.max_path_length` |
| `too_many_waypoints` | More than `world.max_waypoints_per_action` waypoints submitted |
| `waypoint_occupied`  | The waypoint tile itself is occupied by another entity. You pathed *onto* a player. **Bot response**: pick a neighbour, or punch if adjacent. |
| `path_blocked`       | The waypoint is free, but A* couldn't find a route — intermediate tiles are blocked by entities. **Bot response**: wait a tick and retry; entities may move. |
| `no_path_to_waypoint`| Reserved for future iterations with walls or impassable terrain: the waypoint is structurally unreachable. **Bot response**: pick a different destination entirely. Does not fire in v1 (open arena). |
| `invalid_move_transition` | `attack_step.move_id` is not in the current frame's `transitions`. **Bot response**: read `self.attack_state.valid_next_moves` and pick one of those. |
| `move_too_early`          | The requested move is *valid* (in `transitions`) but `min_duration_ticks` hasn't elapsed in the current frame yet. **Bot response**: wait until `current_tick - self.attack_state.since_tick >= min_duration_ticks`, then resubmit. |
| `move_server_controlled`  | The current frame is server-paced (`control: "server"`) and cannot be pre-empted. **Bot response**: wait for `self.attack_state.auto_advance_at_tick`; the server will advance on its own. |
| `attack_not_available`    | The attack referenced by `move_id` is not in `world.attacks`. Reserved for *learned* attacks the agent hasn't unlocked (not used in v1; punch is always available). |
| `movement_locked_in_attack` | `set_path` or `clear_path` sent while in a movement-locking attack FSM. **Bot response**: submit `attack_step` with the attack's exit move (e.g. `"punch.exit"`) to release movement. |
| `unknown_action`     | `action.type` not recognized in this protocol version |
| `rate_limited`       | You exceeded `world.max_actions_per_second` (rolling 1 s window) |
| `not_in_match`       | Action sent before `match_start` or after `match_end` |
| `dead`               | Action sent after your `death` event |

---

## Message: `get_ticks` (bot → server)

One tool that covers four cases: pure past, pure future, spanning-now, and
snapshot-at-now.

```jsonc
{ "type": "get_ticks",
  "request_id": "r_001",
  "from_tick": 37,
  "to_tick":   42 }
```

- **Pure past** (`to_tick <= current_tick`): server replies immediately from
  its per-agent ring buffer.
- **Pure future** (`from_tick > current_tick`): server holds the request and
  replies once tick `to_tick` has been simulated.
- **Spanning** (`from_tick <= current_tick < to_tick`): server sends one reply
  covering the whole range when `to_tick` arrives.
- **Snapshot now**: `from_tick == to_tick == current_tick`.

```jsonc
// Reply (server → bot):
{ "type": "get_ticks_reply",
  "request_id": "r_001",
  "ticks": [
    { "tick": 37, "t_ms": ..., "self": {...}, "visible_entities": [...], "events": [...] },
    { "tick": 38, ... },
    ...
  ]
}
```

Each element of `ticks` has the **same shape as `perception_tick`** but
**without** the `"type"` field.

### `error` reply (instead of `get_ticks_reply`)

```jsonc
{ "type": "error", "request_id": "r_001", "reason": "tick_too_old",
  "detail": "from_tick 800 is older than current_tick - slice_buffer_ticks (943)" }
```

| `reason` | When it happens |
|---|---|
| `tick_too_old`     | `from_tick` is older than `current_tick - slice_buffer_ticks` |
| `invalid_range`    | `from_tick > to_tick` |
| `range_too_large`  | `to_tick - from_tick + 1 > slice_buffer_ticks` |
| `rate_limited`     | More than `max_inflight_get_ticks` future requests in flight |

---

## Message: `match_end` (server → bot, last message, then WS closes)

```jsonc
{ "type": "match_end",
  "cause": "killed_by",      // one of: victory, killed_by, time_out, kicked
  "by": "p_cc2ab573",        // present iff cause === "killed_by"
  "placement": 3,            // 1-indexed; 1 = winner
  "match_duration_ticks": 1820,
  "final_self": { "pos": [37, 33], "hp": 0, "facing": "down" }
}
```

After receiving this, the WebSocket closes. There is no further activity.

---

## Limits you must respect

| Field | Default | What happens if you exceed |
|---|---|---|
| `world.fov_radius`             | 8   | Entities further than this are simply omitted from `visible_entities` |
| `world.max_path_length`        | 16  | `set_path` rejected with `path_too_long` |
| `world.max_waypoints_per_action` | 8 | `set_path` rejected with `too_many_waypoints` |
| `world.max_actions_per_second` | 20  | `action_reply` rejected with `rate_limited`; socket stays open |
| `world.max_inflight_get_ticks` | 4   | New future-slice request gets `error` with `rate_limited` |
| `world.slice_buffer_ticks`     | 100 | Past `get_ticks` further back than this gets `tick_too_old` |

---

## A complete minimal bot

```js
// minimal-bot.mjs — needs only `npm install ws`
import { WebSocket } from 'ws'

const ws = new WebSocket('ws://localhost:2567/agent')
let self = null
let aid = 1
const nextActionId = () => `a_${aid++}`

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())

  if (m.type === 'welcome') {
    self = { id: m.agent_id, pos: m.self_spawn.pos }
    console.log('I am', self.id, 'at', self.pos)
    return
  }

  if (m.type === 'match_start') {
    // Walk a small loop. The server runs A* between waypoints.
    ws.send(JSON.stringify({
      type: 'action',
      action_id: nextActionId(),
      action: { type: 'set_path', waypoints: [
        [self.pos[0] + 3, self.pos[1]],
        [self.pos[0] + 3, self.pos[1] + 3],
        [self.pos[0],     self.pos[1] + 3],
        [self.pos[0],     self.pos[1]],
      ] }
    }))
    return
  }

  if (m.type === 'perception_tick') {
    self.pos = m.self.pos
    self.facing = m.self.facing

    // Drive the punch FSM *off perception_tick.self.attack_state*, not off
    // wall-clock timers. The server enforces min_duration_ticks; if we send
    // too early we get `move_too_early`.
    //
    // Strategy: when we have a target in range, enter the FSM at stance and
    // commit to jab on the next tick. Server auto-advances jab → stance;
    // when we see stance again with no remaining goal, exit.
    const st = m.self.attack_state
    if (!self.attackGoal && st === null) {
      // Trigger condition: someone adjacent to our facing? If so, jab.
      const tgt = m.visible_entities.find((e) => {
        const dx = e.pos[0] - self.pos[0], dy = e.pos[1] - self.pos[1]
        return dy === 0 && ((self.facing === 'right' && dx === 1) ||
                            (self.facing === 'left'  && dx === -1))
      })
      if (tgt) self.attackGoal = 'jab'
    }

    if (self.attackGoal === 'jab') {
      if (st === null) {
        // Enter the FSM at stance.
        self.attackId = `atk_${Date.now()}`
        sendAttackStep(self.attackId, 'punch.stance')
      } else if (st.move_id === 'punch.stance' && st.valid_next_moves.includes('punch.jab')) {
        // Committed — damage applies on entering jab. Goal achieved.
        sendAttackStep(self.attackId, 'punch.jab')
        self.attackGoal = null
      }
      // Server-paced frame (jab) → just wait; it auto-advances back to stance.
    } else if (st && st.move_id === 'punch.stance' && !st.auto_advance_at_tick) {
      // Chain finished and we're back at stance with no goal — exit.
      sendAttackStep(self.attackId, 'punch.exit')
      self.attackId = null
    }

    for (const ev of m.events) {
      if (ev.type === 'damage_dealt') console.log('hit', ev.target_id, 'for', ev.amount)
      if (ev.type === 'path_interrupted') {
        ws.send(JSON.stringify({
          type: 'action', action_id: nextActionId(),
          action: { type: 'clear_path' },
        }))
      }
    }
    return
  }

  function sendAttackStep(aid, mid) {
    ws.send(JSON.stringify({
      type: 'action', action_id: nextActionId(),
      action: { type: 'attack_step', attack_id: aid, move_id: mid },
    }))
  }

  if (m.type === 'action_reply') {
    if (m.status === 'rejected') console.log('action rejected:', m.reason, m.detail)
    return
  }

  if (m.type === 'match_end') {
    console.log('match over —', m.cause, 'placement', m.placement)
    ws.close()
  }
})
```

This is a complete bot. It walks a square, attacks anyone who walks into
melee range, and prints the outcome. ~30 lines of logic, no LLM needed at
runtime.

---

## v1.0 known limits / placeholders

Be aware of these — they're real today and will change later:

- **Combat is minimal.** Punch is the only attack. Damage is flat 10 on
  `punch.jab`. No cooldown beyond the FSM's frame timings, no miss
  chance, no projectiles. Learned attacks (sword, kick, spells) and combat
  numerics are deferred; see `docs/ROADMAP.md`.
- **No reconnect.** WS drop = forfeit. v1.1 will add reconnect tokens.
- **No lobby / matchmaking.** Each match is opened by external orchestration;
  you just connect to the URL and you're in.
- **Single match per connection.** To play again, open a new WS.
- **No items, no inventory.** Pickup is a future spec.
- **No human-vs-bot distinction.** A human-controlled character looks
  identical to a bot in `visible_entities` (`kind: "player"`).

---

## Feedback we'd like

When you finish your first match, please report:

1. Was anything in this doc ambiguous? Where did you have to guess?
2. Did the server reject an action with a `reason` whose meaning wasn't clear
   from the doc?
3. Is there a field in `perception_tick` or `welcome` you wished existed?
4. Did you find yourself wanting to call an LLM at runtime, and if so, what
   would the LLM have given you that your code couldn't compute?
5. Are the v1 limits (path length 16, FOV radius 8, 20 actions/sec, 100-tick
   slice buffer) too tight, too loose, or right?
