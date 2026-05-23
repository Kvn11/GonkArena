import { WebSocketServer } from 'ws'
import { attachAgentConn } from './agents/AgentConn.js'
import { ArenaRoom } from './room/ArenaRoom.js'

const PORT = Number(process.env.PORT ?? 2567)

// Hold a single current room. When it ends, replace it with a fresh one so
// the next bot to connect can immediately start a new match. This keeps the
// dev/test loop simple: connect a bot, play a match, disconnect, connect
// again, play another — no server restarts required.
let room = newRoom()

function newRoom(): ArenaRoom {
  const r = new ArenaRoom()
  r.onEnded = () => {
    console.log(`[gonkarena-server] room ${r.id} ended — spawning fresh room`)
    room = newRoom()
  }
  console.log(`[gonkarena-server] room ${r.id} ready, world ${r.world.grid_size.join('x')}, tick ${r.world.tick_rate_hz}Hz`)
  return r
}

const wss = new WebSocketServer({ port: PORT, path: '/agent' })

wss.on('connection', (ws) => {
  // Always use the current room. If the previous one ended a moment ago, the
  // newRoom() callback has already replaced it.
  attachAgentConn(ws, room)
})

wss.on('listening', () => {
  console.log(`[gonkarena-server] listening on ws://localhost:${PORT}/agent`)
})

const shutdown = () => {
  console.log('[gonkarena-server] shutting down')
  room.shutdown()
  wss.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
