// Reference bot — exercises the v1.0 protocol end-to-end against a running
// server (default ws://localhost:2567/agent). Used as both a verification
// harness and a worked example for bot authors.
//
// Run after `npm run dev` in another terminal:
//   npm run test:bot              # one bot
//   npm run test:bot -- "alpha"   # tagged bot for log clarity

import { WebSocket } from 'ws'
import type {
  ActionMessage,
  GetTicksMessage,
  ServerMessage,
  Tile,
  Welcome,
} from '../src/protocol/messages.js'

const TAG = process.argv[2] ?? 'bot'
const URL = process.env.WS_URL ?? 'ws://localhost:2567/agent'

const log = (...args: unknown[]) => console.log(`[${TAG}]`, ...args)

let nextActionId = 1
let nextRequestId = 1
const actionId = () => `a_${TAG}_${nextActionId++}`
const requestId = () => `r_${TAG}_${nextRequestId++}`

const ws = new WebSocket(URL)

let welcome: Welcome | null = null
let firstTickSeen = false
let pendingPathActionId: string | null = null
let pendingPastSliceId: string | null = null
let pendingFutureSliceId: string | null = null
const ticksObserved: number[] = []
const pathStepsObserved: Tile[] = []
let assertions: { name: string; pass: boolean; detail?: string }[] = []

// ─── Punch FSM test state ─────────────────────────────────────────────────
// Punch tests run on a tick schedule relative to the first observed tick so
// they don't race with the path-testing phase above.
const PUNCH_ATTACK_ID = `atk_${TAG}_1`
let punchPhase: 'idle' | 'entering' | 'invalid_tested' | 'movement_lock_tested' | 'exiting' | 'reentered' | 'committing' | 'done' = 'idle'
const pendingActionIds = new Map<string, string>()   // action_id → label (for routing replies)
const observedEvents = {
  attack_step_committed_bot: 0,
  attack_step_committed_server: 0,
  attack_whiffed: 0,
  damage_dealt: 0,
}

function sendAttackStep(moveId: string, label: string) {
  const id = actionId()
  pendingActionIds.set(id, label)
  const msg: ActionMessage = {
    type: 'action',
    action_id: id,
    action: { type: 'attack_step', attack_id: PUNCH_ATTACK_ID, move_id: moveId },
  }
  log('→ attack_step', moveId, `(${label})`)
  ws.send(JSON.stringify(msg))
  return id
}

function sendSetPath(waypoints: Tile[], label: string) {
  const id = actionId()
  pendingActionIds.set(id, label)
  const msg: ActionMessage = { type: 'action', action_id: id, action: { type: 'set_path', waypoints } }
  log('→ set_path', waypoints, `(${label})`)
  ws.send(JSON.stringify(msg))
  return id
}

function assertEq<T>(name: string, actual: T, expected: T, detail?: string) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  assertions.push({ name, pass, detail: detail ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` })
  log(pass ? '✓' : '✗', name, pass ? '' : `(${detail ?? 'mismatch'})`)
}

function assertOk(name: string, cond: boolean, detail?: string) {
  assertions.push({ name, pass: cond, detail })
  log(cond ? '✓' : '✗', name, cond ? '' : `(${detail ?? 'failed'})`)
}

ws.on('open', () => log('connected to', URL))

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString()) as ServerMessage

  if (msg.type === 'welcome') {
    welcome = msg
    log('welcome →', msg.agent_id, 'spawn', msg.self_spawn.pos, 'protocol', msg.protocol_version)
    return
  }

  if (msg.type === 'match_start') {
    log('match_start @ tick', msg.tick, 'n_agents', msg.n_agents)
    // Submit a 2-waypoint path that walks the agent a short distance.
    const start = welcome!.self_spawn.pos
    const waypoints: Tile[] = [
      [start[0] + 2, start[1]],
      [start[0] + 2, start[1] + 2],
    ]
    pendingPathActionId = actionId()
    const action: ActionMessage = {
      type: 'action',
      action_id: pendingPathActionId,
      action: { type: 'set_path', waypoints },
    }
    log('→ set_path', waypoints)
    ws.send(JSON.stringify(action))
    return
  }

  if (msg.type === 'action_reply') {
    if (msg.action_id === pendingPathActionId) {
      assertEq('set_path accepted', msg.status, 'accepted')
      if (msg.status === 'accepted' && 'expanded_path' in msg.result) {
        log('expanded_path length', msg.result.expanded_path.length)
        assertOk('expanded_path non-empty', msg.result.expanded_path.length > 0)
      }
    }
    const label = pendingActionIds.get(msg.action_id)
    if (label !== undefined) {
      pendingActionIds.delete(msg.action_id)
      log('  ↳ reply', label, msg.status, msg.status === 'rejected' ? msg.reason : '')

      switch (label) {
        case 'enter_stance':
          assertEq('enter_stance accepted', msg.status, 'accepted')
          break
        case 'invalid_jump_to_unknown':
          assertEq('invalid_jump rejected', msg.status, 'rejected')
          if (msg.status === 'rejected') {
            assertEq('invalid_jump reason', msg.reason, 'invalid_move_transition')
          }
          break
        case 'movement_locked_set_path':
          assertEq('movement_locked rejected', msg.status, 'rejected')
          if (msg.status === 'rejected') {
            assertEq('movement_lock reason', msg.reason, 'movement_locked_in_attack')
          }
          break
        case 'exit_fsm':
          assertEq('exit_fsm accepted', msg.status, 'accepted')
          break
        case 'reenter_stance':
          assertEq('reenter_stance accepted', msg.status, 'accepted')
          break
        case 'commit_jab':
          assertEq('commit_jab accepted', msg.status, 'accepted')
          break
      }
    }
    return
  }

  if (msg.type === 'perception_tick') {
    if (!firstTickSeen) {
      firstTickSeen = true
      log('first perception_tick @', msg.tick)
      // Schedule a past-slice query a moment later.
      setTimeout(() => {
        const cur = msg.tick + 5     // by the time it fires we'll have a few more ticks
        pendingPastSliceId = requestId()
        const req: GetTicksMessage = {
          type: 'get_ticks',
          request_id: pendingPastSliceId,
          from_tick: Math.max(1, cur - 2),
          to_tick: cur - 1,
        }
        log('→ get_ticks (past)', req.from_tick, '..', req.to_tick)
        ws.send(JSON.stringify(req))
      }, 800)
      setTimeout(() => {
        // Future slice: next 3 ticks.
        const here = ticksObserved[ticksObserved.length - 1] ?? 1
        pendingFutureSliceId = requestId()
        const req: GetTicksMessage = {
          type: 'get_ticks',
          request_id: pendingFutureSliceId,
          from_tick: here + 1,
          to_tick: here + 3,
        }
        log('→ get_ticks (future)', req.from_tick, '..', req.to_tick)
        ws.send(JSON.stringify(req))
      }, 1500)
    }
    ticksObserved.push(msg.tick)
    for (const ev of msg.events) {
      if (ev.type === 'path_step_completed') pathStepsObserved.push(ev.to)
      if (ev.type === 'path_interrupted') log('!! path_interrupted by', ev.blocker_id, 'at', ev.halted_at)
      if (ev.type === 'entity_entered_fov') log('+ FOV:', ev.id)
      if (ev.type === 'entity_left_fov') log('- FOV:', ev.id)
      if (ev.type === 'attack_step_committed') {
        log('  evt attack_step_committed', ev.move_id, 'source', ev.source)
        if (ev.source === 'bot') observedEvents.attack_step_committed_bot++
        if (ev.source === 'server') observedEvents.attack_step_committed_server++
      }
      if (ev.type === 'attack_whiffed') {
        log('  evt attack_whiffed', ev.move_id)
        observedEvents.attack_whiffed++
      }
      if (ev.type === 'damage_dealt') {
        log('  evt damage_dealt', ev.amount, '→', ev.target_id)
        observedEvents.damage_dealt++
      }
    }

    // Drive the punch FSM tests off a tick counter, after the path-test phase
    // has had time to run.
    const localTick = ticksObserved.length
    advancePunch(msg.tick, localTick, msg.self.attack_state?.move_id ?? null)
    return
  }

  if (msg.type === 'get_ticks_reply') {
    if (msg.request_id === pendingPastSliceId) {
      assertOk('past slice returned ticks', msg.ticks.length > 0, `got ${msg.ticks.length}`)
      log('past slice:', msg.ticks.map((t) => t.tick).join(','))
    } else if (msg.request_id === pendingFutureSliceId) {
      assertEq('future slice length', msg.ticks.length, 3)
      log('future slice:', msg.ticks.map((t) => t.tick).join(','))
    }
    return
  }

  if (msg.type === 'error') {
    log('!! error', msg.request_id, msg.reason, msg.detail)
    return
  }

  if (msg.type === 'match_end') {
    log('match_end:', msg.cause, 'placement', msg.placement, 'duration', msg.match_duration_ticks)
    assertOk('observed >= 50 ticks', ticksObserved.length >= 50, `got ${ticksObserved.length}`)
    assertOk('observed path steps', pathStepsObserved.length >= 1, `got ${pathStepsObserved.length}`)
    assertOk('observed server auto-advance events', observedEvents.attack_step_committed_server >= 1,
      `got ${observedEvents.attack_step_committed_server} (expected ≥ 1 for jab → stance)`)
    assertOk('observed attack_whiffed (solo match)', observedEvents.attack_whiffed >= 1,
      `got ${observedEvents.attack_whiffed}`)
    assertOk('punch FSM reached done state', punchPhase === 'done', `phase=${punchPhase}`)
    const failed = assertions.filter((a) => !a.pass)
    log(failed.length === 0 ? `ALL ${assertions.length} ASSERTIONS PASSED` : `${failed.length}/${assertions.length} FAILED`)
    ws.close()
    setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 50)
    return
  }
})

// Jab FSM driver. Runs on every perception_tick. localTick is the number
// of perception_ticks we've observed (so it starts at 1 on first tick and
// climbs deterministically regardless of when the bot connected mid-match).
// FSM is stance ↔ jab; jab is server-paced (min_duration_ticks=2) and
// auto-advances back to stance.
function advancePunch(_serverTick: number, localTick: number, currentMoveId: string | null) {
  // Phase 1 — start at local tick 20 (~2 s after match_start; path test will
  // be done by then, plenty of slice buffer to play with).
  if (punchPhase === 'idle' && localTick === 20) {
    sendAttackStep('punch.stance', 'enter_stance')
    punchPhase = 'entering'
    return
  }
  // Negative test: from stance, attempting to transition to an unknown move
  // should be rejected with invalid_move_transition (only "punch.jab" and
  // "punch.exit" are in stance's transitions).
  if (punchPhase === 'entering' && localTick === 23) {
    sendAttackStep('punch.full_punch', 'invalid_jump_to_unknown')
    punchPhase = 'invalid_tested'
    return
  }
  // Movement-lock test: in stance, set_path should be rejected.
  if (punchPhase === 'invalid_tested' && localTick === 26) {
    const here = welcome!.self_spawn.pos
    sendSetPath([[here[0], here[1] + 1]], 'movement_locked_set_path')
    punchPhase = 'movement_lock_tested'
    return
  }
  // Exit the FSM (feint — never committed to a jab).
  if (punchPhase === 'movement_lock_tested' && localTick === 29) {
    sendAttackStep('punch.exit', 'exit_fsm')
    punchPhase = 'exiting'
    return
  }
  // Re-enter and commit a jab (no target adjacent → whiff).
  if (punchPhase === 'exiting' && localTick === 32) {
    sendAttackStep('punch.stance', 'reenter_stance')
    punchPhase = 'reentered'
    return
  }
  if (punchPhase === 'reentered' && localTick === 35) {
    sendAttackStep('punch.jab', 'commit_jab')
    punchPhase = 'committing'
    return
  }
  // Server now auto-advances jab → stance. When we see the FSM back at
  // stance, mark done and close.
  if (punchPhase === 'committing' && currentMoveId === 'punch.stance' && localTick > 35) {
    log('jab FSM cycled back to stance — chain complete')
    punchPhase = 'done'
    setTimeout(finishAndExit, 200)
    return
  }
}

function finishAndExit() {
  log('all scheduled tests complete; closing socket and reporting')
  assertOk('observed >= 50 ticks', ticksObserved.length >= 50, `got ${ticksObserved.length}`)
  assertOk('observed path steps', pathStepsObserved.length >= 1, `got ${pathStepsObserved.length}`)
  assertOk('observed server auto-advance events', observedEvents.attack_step_committed_server >= 3,
    `got ${observedEvents.attack_step_committed_server} (expected ≥ 3 for extending → full_punch → arm_pulling_back)`)
  assertOk('observed attack_whiffed (solo match)', observedEvents.attack_whiffed >= 1,
    `got ${observedEvents.attack_whiffed}`)
  assertOk('punch FSM reached done state', punchPhase === 'done', `phase=${punchPhase}`)
  const failed = assertions.filter((a) => !a.pass)
  log(failed.length === 0 ? `ALL ${assertions.length} ASSERTIONS PASSED` : `${failed.length}/${assertions.length} FAILED`)
  ws.close()
  setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 50)
}

ws.on('close', () => log('socket closed'))
ws.on('error', (err) => log('socket error', err.message))
