// A long-lived walker bot: connects, then once a match starts, sends a fresh
// 2-waypoint set_path every ~2 seconds so the human can see the bot moving.
// Used for visual integration tests, not protocol verification.
import { WebSocket } from 'ws'

const URL = process.env.WS_URL ?? 'ws://localhost:2567/agent'
const ws = new WebSocket(URL)
let aid = 1
let myPos = null
let matchActive = false

const send = (m) => ws.send(JSON.stringify(m))
const nextActionId = () => `wa_${aid++}`

ws.on('open', () => console.log('[walker] connected'))
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.type === 'welcome') {
    myPos = m.self_spawn.pos
    console.log('[walker] welcome', m.agent_id, 'spawn', myPos)
    return
  }
  if (m.type === 'match_start') {
    matchActive = true
    console.log('[walker] match_start, beginning patrol')
    patrol()
    return
  }
  if (m.type === 'perception_tick') {
    myPos = m.self.pos
    return
  }
  if (m.type === 'action_reply' && m.status === 'rejected') {
    console.log('[walker] action rejected:', m.reason)
  }
  if (m.type === 'match_end') {
    console.log('[walker] match_end', m.cause)
    process.exit(0)
  }
})
ws.on('close', () => process.exit(0))

function patrol() {
  if (!matchActive || !myPos) return
  // Alternate between two patrol points relative to current spot.
  const choices = [
    [[myPos[0] + 3, myPos[1]], [myPos[0] + 3, myPos[1] + 3]],
    [[myPos[0] - 3, myPos[1]], [myPos[0] - 3, myPos[1] - 3]],
    [[myPos[0], myPos[1] - 3], [myPos[0] + 3, myPos[1] - 3]],
  ]
  const pick = choices[Math.floor(Math.random() * choices.length)]
  send({ type: 'action', action_id: nextActionId(), action: { type: 'set_path', waypoints: pick } })
  setTimeout(patrol, 2500)
}
