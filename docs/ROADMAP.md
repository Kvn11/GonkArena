# GonkArena Roadmap

Items captured from real-world feedback that are intentionally out of scope
for the iteration they were raised in. Each entry names the iteration that
should pick it up, the constraint it must respect, and where the agent
feedback came from.

## Coarse off-FOV awareness (sound / footsteps)

**Status**: deferred — not for v1.0 of the protocol.

**Problem**: with strict FOV-only vision, agents tasked with "find the
player" do a 25-point sweep grid before any interaction. That's gameplay
fine but boring strategy — there's no in-game pressure to *commit* to a
direction, no escalating "warmer/colder" tension.

**Idea**: emit coarse, FOV-respecting hints in `perception_tick.events[]`:

```jsonc
// Example shape (not yet implemented):
{ "type": "footstep_heard",
  "bearing": "NE",         // one of 8 compass directions
  "intensity": "near"       // near | mid | far — bucketed, not exact distance
}
```

Hints fire on a tick where another agent **moved** within some radius
larger than FOV (say 2× FOV, so 16 tiles for default fov_radius 8). They
do **not** identify which agent moved; just that *something* did, where,
and roughly how close.

**Constraints to respect when implementing**:

1. **No precise positions.** Bearing must be bucketed (8-way), distance
   must be bucketed (3 buckets: `near` / `mid` / `far`). Anything finer
   collapses fog of war.
2. **Bot-emittable, not server-omniscient.** The agent does not get a list
   of "all entities and their movements" — just the hint, with no entity
   id. Knowing *who* would reintroduce the omniscience the FOV system was
   designed to prevent.
3. **No persistence.** The hint is for the tick on which the movement
   happened. Bots that want to track "I heard footsteps NE three ticks
   ago" maintain that themselves.
4. **Cap the emission rate.** A noisy match shouldn't drown a bot's
   perception in hints. Probably: at most one `footstep_heard` event per
   tick per agent, prioritising the closest source.
5. **Walls (when added) muffle.** Once walls are in, hints should respect
   simple line-of-sight rules — a wall between you and the source bumps
   the bucket down by one.

**Feedback origin**: agent test of `docs/agent-protocol.md`, point #4 —
*"FOV-only vision forces sweeping. Intentional, but for find-the-player
tasks it means a 25-point scan grid before any interaction. A coarse
off-FOV hint (sound, footsteps, 'warmer/colder') would create more
interesting strategy without breaking the fog-of-war design."*

**When to pick this up**: after combat numerics (HP, cooldowns,
projectiles) land — combat creates the *reason* to want to find a player
quickly, which is when the sweep tax becomes load-bearing on gameplay.

## Learned attacks (sword, kick, spells, etc.)

**Status**: deferred — punch is the only attack in v1, shipped as
`kind: "instinctual"`.

**Problem**: combat is one-dimensional (punch or don't). The vision is that
players acquire new attacks by finding scrolls, books, or talking to trainer
NPCs; each new attack has its own FSM (some uninterruptible, some with
combos, some with longer reach).

**Scope**:

1. New event `attack_learned { attack: AttackDef }` that the server can fire
   mid-match to add an attack to the agent's available registry.
2. A `welcome.world.attacks` registry that starts populated only with the
   instinctual ones; learned attacks accumulate over a match (or persist via
   a save layer, eventually).
3. `attack_step` continues to work unchanged — it already accepts any
   `move_id` whose attack is in the registry.
4. Authoring API for designers: declarative `AttackDef` (frames, transitions,
   damage shape) so adding a new attack is a config change, not a code
   change.

**Constraints to respect when implementing**:

- **No retroactive registry mutation.** When a new attack is learned, the
  registry grows; existing in-flight FSM frames are not touched.
- **Per-attack `locks_movement`.** The protocol already supports it
  (`AttackDef.locks_movement`). A sword swing locks movement; a kick may
  allow chained movement. Design each new attack with this lever in mind.
- **Range shapes beyond `facing_adjacent`.** Sword wants `facing_arc_3`
  (3-tile front arc), spells want `targeted` (tile coordinate) or
  `ranged_line`. Extend `AttackRange` shape variants as needed; keep the
  union closed.

**When to pick this up**: after combat numerics land (HP balance creates
real pressure to pick up better attacks).

## Combat numerics

**Status**: deferred — placeholder in v1.0 (punch deals flat 10 damage; no
cooldown beyond the FSM frame timings).

**Problem**: bots can't make tactical decisions about combat (engage vs.
flee, melee vs. range, when to retreat at low HP) without real HP/damage/
cooldown numbers.

**Scope**: HP per attack, cooldowns (`AttackDef.cooldown_ticks`), projectile
travel ticks, miss chance, possibly weapon types.

**When to pick this up**: next major iteration after the agent protocol
stabilises with humans in the room. Spec it before implementing — combat
balance is hard to back out of.

## Reconnection tokens

**Status**: deferred — WS drop = forfeit in v1.0.

**Problem**: a brief network hiccup costs a bot the match.

**Scope**: server issues a `reconnect_token` in `welcome`; if the bot
reconnects within N seconds with the same token, it resumes its agent
slot. Otherwise the agent is forfeit as today.

**When to pick this up**: when external bots start running on real
networks (not localhost) and connection stability matters.

## Items, inventory, pickups

**Status**: out of scope for v1.0 protocol.

**Scope**: pickup actions, inventory slots, item events in
`perception_tick.events[]`, item rendering in `visible_entities` (or a
separate `visible_items` list).

**When to pick this up**: after combat numerics — items only mean
something once combat creates the demand for them (weapons, healing).

## Matchmaking / lobby

**Status**: out of scope — every match is opened by external
orchestration; bots just connect to the URL.

**Scope**: a `lobby` endpoint that queues bots, matches them by ELO or
agent kind, runs multiple concurrent rooms.

**When to pick this up**: when GonkArena has enough bots to make queue
order matter.
