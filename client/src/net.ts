// Browser WebSocket wrapper for the GonkArena v1.0 agent protocol. The Phaser
// scene drives this object via callbacks set after construction. All sends
// expect the socket to be open; the caller should wait for `onWelcome` before
// sending actions.

import type {
  ActionMessage,
  ActionPayload,
  ActionReply,
  ErrorMsg,
  GetTicksMessage,
  GetTicksReply,
  LobbyUpdate,
  MatchEnd,
  MatchStart,
  PerceptionTick,
  ServerMessage,
  Tile,
  Welcome,
} from '../../server/src/protocol/messages'

export type NetCallbacks = {
  onWelcome?: (m: Welcome) => void
  onMatchStart?: (m: MatchStart) => void
  onLobbyUpdate?: (m: LobbyUpdate) => void
  onTick?: (m: PerceptionTick) => void
  onActionReply?: (m: ActionReply) => void
  onGetTicksReply?: (m: GetTicksReply) => void
  onError?: (m: ErrorMsg) => void
  onMatchEnd?: (m: MatchEnd) => void
  onOpen?: () => void
  onClose?: () => void
}

export class NetClient {
  private ws: WebSocket
  private nextActionId = 1
  private nextRequestId = 1
  cb: NetCallbacks = {}

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.onopen = () => this.cb.onOpen?.()
    this.ws.onclose = () => this.cb.onClose?.()
    this.ws.onmessage = (ev) => this.handleMessage(ev.data)
  }

  // Returns true if the socket is currently OPEN. Use this before scheduling
  // any send-on-timeout to avoid InvalidStateError exceptions.
  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  private handleMessage(data: unknown) {
    if (typeof data !== 'string') {
      // Server only sends text frames; ignore anything else.
      console.warn('[net] non-string ws frame, ignoring')
      return
    }
    let msg: ServerMessage
    try {
      msg = JSON.parse(data) as ServerMessage
    } catch (err) {
      console.warn('[net] failed to parse ws frame:', err)
      return
    }
    this.dispatch(msg)
  }

  private dispatch(msg: ServerMessage) {
    switch (msg.type) {
      case 'welcome':           return this.cb.onWelcome?.(msg)
      case 'match_start':       return this.cb.onMatchStart?.(msg)
      case 'lobby_update':      return this.cb.onLobbyUpdate?.(msg)
      case 'perception_tick':   return this.cb.onTick?.(msg)
      case 'action_reply':      return this.cb.onActionReply?.(msg)
      case 'get_ticks_reply':   return this.cb.onGetTicksReply?.(msg)
      case 'error':             return this.cb.onError?.(msg)
      case 'match_end':         return this.cb.onMatchEnd?.(msg)
    }
  }

  // Returns the action_id, or empty string if the socket wasn't OPEN. Callers
  // that schedule sends via setTimeout should check isOpen first.
  sendAction(action: ActionPayload): string {
    if (!this.isOpen) return ''
    const action_id = `a_${this.nextActionId++}`
    const msg: ActionMessage = { type: 'action', action_id, action }
    try {
      this.ws.send(JSON.stringify(msg))
    } catch {
      // Socket transitioned away from OPEN between the check and the call.
      return ''
    }
    return action_id
  }

  setPath(waypoints: Tile[]): string {
    return this.sendAction({ type: 'set_path', waypoints })
  }

  clearPath(): string {
    return this.sendAction({ type: 'clear_path' })
  }

  attackStep(attack_id: string, move_id: string): string {
    return this.sendAction({ type: 'attack_step', attack_id, move_id })
  }

  getTicks(from_tick: number, to_tick: number): string {
    if (!this.isOpen) return ''
    const request_id = `r_${this.nextRequestId++}`
    const msg: GetTicksMessage = { type: 'get_ticks', request_id, from_tick, to_tick }
    try {
      this.ws.send(JSON.stringify(msg))
    } catch {
      return ''
    }
    return request_id
  }

  close() {
    try { this.ws.close() } catch { /* already closed */ }
  }
}
