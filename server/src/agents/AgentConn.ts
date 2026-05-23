import type { WebSocket } from 'ws'
import type { ArenaRoom } from '../room/ArenaRoom.js'
import type {
  ActionMessage,
  ClientMessage,
  GetTicksMessage,
  ServerMessage,
} from '../protocol/messages.js'

// One WebSocket = one agent in one match. The handler is responsible for
// (a) registering with the room, (b) sending all server messages onto the
// socket as JSON text frames, (c) parsing incoming JSON and routing to the
// room. The room owns simulation; this class owns transport.

export function attachAgentConn(ws: WebSocket, room: ArenaRoom) {
  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }
  const close = () => {
    try { ws.close() } catch { /* already closed */ }
  }

  const agent = room.join(send, close)

  ws.on('message', (raw) => {
    let parsed: ClientMessage
    try {
      parsed = JSON.parse(raw.toString()) as ClientMessage
    } catch {
      // Malformed JSON: drop with no reply. Bots are expected to send valid JSON.
      return
    }

    if (parsed.type === 'action') {
      // Validate the envelope before forwarding so a malformed message
      // (missing `action` or `action.type`) doesn't crash the room.
      const am = parsed as ActionMessage
      if (typeof am.action_id !== 'string' || !am.action || typeof am.action.type !== 'string') {
        // Drop malformed actions silently. Bots conforming to welcome.schemas
        // never produce this.
        return
      }
      const reply = room.handleAction(agent.id, am)
      send(reply)
    } else if (parsed.type === 'get_ticks') {
      const reply = room.handleGetTicks(agent.id, parsed as GetTicksMessage)
      if (reply !== null) send(reply)
      // null = queued future-slice; will be answered from the tick loop.
    } else {
      // Unknown top-level type: drop silently. Bots checking against
      // welcome.schemas should never produce one of these.
    }
  })

  // Single cleanup path. Both 'close' and 'error' route here; `leave` is
  // idempotent (no-ops if the agent was already removed) and `close()` is
  // safe to call twice.
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    room.leave(agent.id)
  }

  ws.on('close', cleanup)
  ws.on('error', () => {
    cleanup()
    try { ws.close() } catch { /* ignore */ }
  })
}
