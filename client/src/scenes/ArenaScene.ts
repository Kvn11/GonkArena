import Phaser from 'phaser'
// Glob-import every sprite PNG. Each file's basename becomes its Phaser texture
// key (e.g. .../walk_back_right_7.png → 'walk_back_right_7'), so the
// background asset script can add/remove frames without any code change here.
const SPRITE_URLS = import.meta.glob(
  '../../../assets/concept_art/sprites/*.png',
  { eager: true, query: '?url', import: 'default' },
) as Record<string, string>
const SPRITE_BY_KEY: Record<string, string> = {}
for (const [path, url] of Object.entries(SPRITE_URLS)) {
  const key = path.split('/').pop()!.replace(/\.png$/, '')
  SPRITE_BY_KEY[key] = url
}
// Count walk frames by direction. Source of truth is the filesystem — the
// animation creation loop reads this so changing SAMPLED_FRAMES in the asset
// script is the only place a frame count lives.
const WALK_FRAME_COUNT = Object.keys(SPRITE_BY_KEY)
  .filter((k) => k.startsWith('walk_back_right_'))
  .length
import { GRID_SIZE, TILE_W, TILE_H } from '../config'
import { worldToScreen } from '../iso'
import { NetClient } from '../net'
import type { PerceptionTick, Tile, Welcome } from '../../../server/src/protocol/messages'

const TARGET_H = TILE_H * 3
const IDLE_TIMEOUT_MS = 150
const REMOTE_TINT = 0xff8888           // visible bots get a reddish hue so the human can find them
const ACTION_SEND_MIN_GAP_MS = 90      // throttle WASD-driven set_paths to ~10/sec (< 20/s server limit)
const WS_URL = `ws://${window.location.hostname}:2567/agent`

// Punch frames keyed by FSM move_id. Value is the move portion of the
// texture key; the rendering code combines it with a back/front view and
// optional horizontal flip per facing direction to pick the final texture
// (e.g. 'jab' + back + flip → punch_jab_back with flipX=true → up-left jab).
const PUNCH_MOVE_BASENAME: Record<string, string> = {
  'punch.stance': 'punch_stance',
  'punch.jab':    'punch_jab',
}

// Punch sprites come in two POVs (back, front) and are authored right-handed.
// up    (away from camera, screen-right side) → back view, no flip
// left  (away from camera, screen-left side)  → back view, flipped
// right (toward camera,  screen-right side)   → front view, no flip
// down  (toward camera,  screen-left side)    → front view, flipped
const PUNCH_VIEW_FOR_DIR: Record<Dir, 'back' | 'front'> = {
  up: 'back', left: 'back', down: 'front', right: 'front',
}

// Human macro: ms between SPACE → stance and stance → jab. Tiny — the stance
// frame is only visible long enough to confirm the FSM entered; the jab
// commit follows immediately. The server's min_duration on stance is 0, so
// the bot is allowed to transition right away.
const PUNCH_MACRO_FRAME_MS = 80

type Dir = 'up' | 'down' | 'left' | 'right'

type Entity = {
  tile: { x: number; y: number }
  sprite: Phaser.GameObjects.Sprite
  lastDir: Dir | null
  currentAnimKey: string | null
  lastMoveAt: number
  attackMoveId: string | null    // last server-reported FSM frame (drives texture)
}

// In this iso projection (sx=(x-y)*tw/2, sy=(x+y)*th/2) the four cardinal
// grid directions map to screen diagonals: W goes upper-right, S lower-left,
// A upper-left, D lower-right. The 3/4-view sprites line up with that:
const ANIM_FOR_DIR: Record<Dir, string> = {
  up:    'walk_back_right',    // away from camera, body angled right
  down:  'walk_front_left',    // toward camera, body angled left
  left:  'walk_back_left',
  right: 'walk_front_right',
}

const RESTING_FRAME_FOR_DIR: Record<Dir, string> = {
  up:    'idle_back_right',
  down:  'idle_front_left',
  left:  'idle_back_left',
  right: 'idle_front_right',
}

// Punch sprites only exist in a right-facing variant; we flip them when the
// character is facing toward the screen-left side. (Unlike the walk/idle
// frames above, the punch art was authored for one orientation.) Iso dirs
// 'right' and 'up' point to the screen-right half, so no flip there; 'left'
// and 'down' point to the screen-left half, so flip.
const PUNCH_FLIP_FOR_DIR: Record<Dir, boolean> = {
  up: false, down: true, left: true, right: false,
}

const DEFAULT_IDLE = 'idle_front_right'   // before the entity has moved/faced

const WALK_FRAMES: Record<string, string[]> = {
  walk_back_right:  Array.from({ length: WALK_FRAME_COUNT }, (_, i) => `walk_back_right_${i + 1}`),
  walk_back_left:   Array.from({ length: WALK_FRAME_COUNT }, (_, i) => `walk_back_left_${i + 1}`),
  walk_front_right: Array.from({ length: WALK_FRAME_COUNT }, (_, i) => `walk_front_right_${i + 1}`),
  walk_front_left:  Array.from({ length: WALK_FRAME_COUNT }, (_, i) => `walk_front_left_${i + 1}`),
}

// One full step cycle (left+right footfall) at normal walking pace is ~1s.
// Auto-derive FPS from frame count so the cycle stays ~1s as we add frames.
const WALK_FPS = WALK_FRAME_COUNT

export class ArenaScene extends Phaser.Scene {
  // entitiesById holds EVERY entity rendered on screen (self + visible bots),
  // keyed by their server agent_id. `player` is a convenience alias to the
  // entry for our own agent. Re-initialized in create() because Phaser reuses
  // the Scene instance on restart.
  private entitiesById = new Map<string, Entity>()
  private player: Entity | null = null
  private selfAgentId: string | null = null
  private heldKeys = new Set<string>()
  private net: NetClient | null = null
  private matchActive = false
  private matchEnded = false                       // distinguishes "WS closed because match_end" from a true disconnect
  private lastActionSentAt = 0
  private statusText: Phaser.GameObjects.Text | null = null
  private punchMacroInFlight = false               // true between SPACE press and server-reported return to fighting_stance
  private punchAttackId: string | null = null      // correlator for the in-flight punch (also used to drive exit)
  private punchMacroCommitted = false              // true once we've crossed into committed (server-paced) frames, so the cycle-back to stance triggers exit only after the full chain
  private punchMacroTimers: ReturnType<typeof setTimeout>[] = []  // pending setTimeout IDs for the bot-paced submissions; cleared on success, rejection, close, restart

  constructor() {
    super({ key: 'ArenaScene' })
  }

  preload() {
    for (const [key, url] of Object.entries(SPRITE_BY_KEY)) {
      this.load.image(key, url)
    }
  }

  create() {
    this.entitiesById.clear()
    this.heldKeys.clear()
    this.player = null
    this.selfAgentId = null
    this.matchActive = false
    this.matchEnded = false
    this.lastActionSentAt = 0
    this.cancelPunchMacro()

    this.cameras.main.setBackgroundColor('#222222')

    this.drawArena()

    for (const key of Object.keys(WALK_FRAMES)) {
      if (!this.anims.exists(key)) {
        this.anims.create({
          key,
          frames: WALK_FRAMES[key].map((k) => ({ key: k })),
          frameRate: WALK_FPS,
          repeat: -1,
        })
      }
    }

    const halfW = (GRID_SIZE * TILE_W) / 2
    const fullH = GRID_SIZE * TILE_H
    this.cameras.main.setBounds(
      -halfW - TILE_W,
      -TILE_H,
      GRID_SIZE * TILE_W + TILE_W * 2,
      fullH + TILE_H * 2,
    )

    this.showStatus(`Connecting to ${WS_URL}…`)
    this.connect()

    const keyboard = this.input.keyboard
    if (!keyboard) return
    keyboard.on('keydown-W', () => this.handleDirKey('W', 'up', 0, -1))
    keyboard.on('keydown-S', () => this.handleDirKey('S', 'down', 0, 1))
    keyboard.on('keydown-A', () => this.handleDirKey('A', 'left', -1, 0))
    keyboard.on('keydown-D', () => this.handleDirKey('D', 'right', 1, 0))
    keyboard.on('keyup-W', () => this.heldKeys.delete('W'))
    keyboard.on('keyup-S', () => this.heldKeys.delete('S'))
    keyboard.on('keyup-A', () => this.heldKeys.delete('A'))
    keyboard.on('keyup-D', () => this.heldKeys.delete('D'))
    keyboard.on('keydown-SPACE', () => this.startPunchMacro())
  }

  update(time: number, _delta: number) {
    if (!this.player) return
    for (const e of this.entitiesById.values()) {
      if (e.currentAnimKey === null) continue
      // Player-only: respect heldKeys so OS initial-repeat delay doesn't
      // flicker idle/walk while a key is being held.
      if (e === this.player && this.heldKeys.size > 0) continue
      if (time - e.lastMoveAt <= IDLE_TIMEOUT_MS) continue
      this.stopWalk(e)
    }
  }

  // ─── Network ───────────────────────────────────────────────────────────

  private connect() {
    this.net = new NetClient(WS_URL)
    this.net.cb = {
      onOpen: () => this.showStatus('Waiting for match…'),
      onClose: () => {
        // Always cancel any pending macro timers so they don't fire send()
        // against a closed socket.
        this.cancelPunchMacro()
        // If match_end already happened, leave that message visible.
        if (!this.matchEnded) this.showStatus('Disconnected. Refresh page to retry.')
      },
      onWelcome: (m) => this.onWelcome(m),
      onLobbyUpdate: (m) => {
        if (m.starting_in_ms !== null) {
          this.showStatus(`Match starting in ${Math.round(m.starting_in_ms / 1000)} s (${m.agents_present}/${m.agents_needed} agents)…`)
        } else {
          this.showStatus(`Waiting for agents (${m.agents_present}/${m.agents_needed})…`)
        }
      },
      onMatchStart: () => {
        this.matchActive = true
        this.hideStatus()
      },
      onTick: (m) => this.onTick(m),
      onActionReply: (m) => {
        if (m.status === 'rejected') {
          console.warn('[net] action rejected:', m.reason, m.detail)
          // If a punch attack_step was rejected, the macro is dead in the
          // water — cancel any pending submissions and unjam the in-flight
          // latch so the user can press SPACE again.
          if (m.reason === 'invalid_move_transition' || m.reason === 'move_too_early' ||
              m.reason === 'move_server_controlled' || m.reason === 'attack_not_available' ||
              m.reason === 'movement_locked_in_attack') {
            this.cancelPunchMacro()
          }
        }
      },
      onMatchEnd: (m) => {
        this.matchActive = false
        this.matchEnded = true
        this.cancelPunchMacro()
        this.showStatus(`Match end — ${m.cause}, placement ${m.placement}. Refresh to play again.`)
      },
      onError: (m) => console.warn('[net] error', m.reason, m.detail),
    }
  }

  // Clears every piece of macro state: pending timers, latches, and stored
  // attack id. Safe to call multiple times and from any lifecycle hook.
  private cancelPunchMacro() {
    for (const t of this.punchMacroTimers) clearTimeout(t)
    this.punchMacroTimers = []
    this.punchMacroInFlight = false
    this.punchMacroCommitted = false
    this.punchAttackId = null
  }

  private onWelcome(m: Welcome) {
    this.selfAgentId = m.agent_id
    const spawn = m.self_spawn.pos
    const e = this.spawnEntityAtTile(m.agent_id, spawn[0], spawn[1])
    this.player = e
    this.cameras.main.startFollow(e.sprite, true)
    this.showStatus(`Connected as ${m.agent_id}. Match starts in ~5 s. WASD to move.`)
  }

  private onTick(m: PerceptionTick) {
    if (!this.player || !this.selfAgentId) return

    // 1. Reconcile own position. The server is authoritative — if we drifted
    // (e.g., an action was rejected so we didn't actually move), snap back.
    const serverPos = m.self.pos
    if (this.player.tile.x !== serverPos[0] || this.player.tile.y !== serverPos[1]) {
      this.moveEntityTo(this.player, serverPos[0], serverPos[1])
    }

    // 1b. Mirror our own attack frame from the server. Drives the sprite
    // texture when we're in the punch FSM; the macro sends one transition at a
    // time and the server's reply (and subsequent self.attack_state) drives
    // what we render.
    const ownAttackMoveId = m.self.attack_state?.move_id ?? null
    this.applyAttackFrame(this.player, ownAttackMoveId)

    // Track whether we've crossed into the (server-paced) jab frame, so we
    // know the FSM has actually cycled (vs. just entered stance) when it
    // returns to stance.
    if (this.punchMacroInFlight && ownAttackMoveId === 'punch.jab') {
      this.punchMacroCommitted = true
    }
    // After committing the jab and cycling back to stance, send the exit
    // transition so movement is released.
    if (this.punchMacroInFlight && this.punchMacroCommitted && ownAttackMoveId === 'punch.stance' && this.punchAttackId !== null) {
      this.net?.attackStep(this.punchAttackId, 'punch.exit')
      this.punchMacroInFlight = false
      this.punchMacroCommitted = false
      this.punchAttackId = null
    }

    // 2. Sync visible_entities. Spawn new, update existing, remove gone.
    const seenIds = new Set<string>()
    for (const v of m.visible_entities) {
      seenIds.add(v.id)
      let e = this.entitiesById.get(v.id)
      if (!e) {
        e = this.spawnEntityAtTile(v.id, v.pos[0], v.pos[1], { tint: REMOTE_TINT })
      } else if (e.tile.x !== v.pos[0] || e.tile.y !== v.pos[1]) {
        // Other agent moved — start their walk animation and snap position.
        const dir = directionFromDelta(v.pos[0] - e.tile.x, v.pos[1] - e.tile.y)
        if (dir) this.setFacing(e, dir)
        this.moveEntityTo(e, v.pos[0], v.pos[1])
        if (dir) this.startWalk(e, dir)
      }
      // Drive remote sprite from their attack frame.
      this.applyAttackFrame(e, v.attack_move_id)
    }
    // Remove sprites for bots that left our FOV.
    for (const [id, e] of this.entitiesById) {
      if (id === this.selfAgentId) continue
      if (!seenIds.has(id)) {
        e.sprite.destroy()
        this.entitiesById.delete(id)
      }
    }

    // 3. Optionally log notable events to console for debugging.
    for (const ev of m.events) {
      if (ev.type === 'path_interrupted') console.log('[evt] path_interrupted by', ev.blocker_id)
      if (ev.type === 'damage_taken') console.log('[evt] damage_taken', ev.amount, 'by', ev.by)
      if (ev.type === 'damage_dealt') console.log('[evt] damage_dealt', ev.amount, 'to', ev.target_id)
      if (ev.type === 'attack_whiffed') console.log('[evt] attack_whiffed', ev.move_id)
      if (ev.type === 'death') console.log('[evt] death by', ev.by)
    }
  }

  // Pull the texture for an entity from its server-reported attack_move_id.
  // When the entity exits the FSM, restore the resting walk frame. Texture
  // key is composed: <move>_<view>, where view is back/front per facing dir,
  // and flipX handles the screen-left half. Default view is 'front' before
  // the entity has faced anywhere.
  private applyAttackFrame(e: Entity, attackMoveId: string | null) {
    if (e.attackMoveId === attackMoveId) return
    e.attackMoveId = attackMoveId
    if (attackMoveId !== null) {
      const moveBase = PUNCH_MOVE_BASENAME[attackMoveId]
      if (moveBase) {
        if (e.currentAnimKey !== null) {
          e.sprite.stop()
          e.currentAnimKey = null
        }
        const view = e.lastDir ? PUNCH_VIEW_FOR_DIR[e.lastDir] : 'front'
        e.sprite.setTexture(`${moveBase}_${view}`)
        e.sprite.setFlipX(e.lastDir ? PUNCH_FLIP_FOR_DIR[e.lastDir] : false)
        this.resizeSprite(e.sprite)
      }
    } else {
      // Returned to idle. Stop any still-playing animation FIRST, otherwise
      // its next animationupdate will overwrite the resting texture we just
      // set.
      if (e.currentAnimKey !== null) {
        e.sprite.stop()
        e.currentAnimKey = null
      }
      e.sprite.setTexture(e.lastDir ? RESTING_FRAME_FOR_DIR[e.lastDir] : DEFAULT_IDLE)
      e.sprite.setFlipX(false)
      this.resizeSprite(e.sprite)
    }
  }

  // Human SPACE macro: enter the punch FSM at stance, then commit to jab
  // after a brief delay so the stance frame is briefly visible. The server
  // commits the jab (damage applies) and auto-advances back to stance —
  // the bot CANNOT cancel between jab → stance. When the server reports
  // the FSM back at stance, onTick sends the exit (releasing movement).
  //
  // Timer IDs are stored in `punchMacroTimers` so cancelPunchMacro() can clear
  // them on rejection, WS close, scene restart, or match_end.
  private startPunchMacro() {
    if (!this.player || !this.matchActive || !this.net) return
    if (this.punchMacroInFlight) return                     // ignore double-tap
    if (this.player.attackMoveId !== null) return           // already in a FSM
    const attackId = `atk_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    this.punchAttackId = attackId
    this.punchMacroInFlight = true
    const net = this.net
    net.attackStep(attackId, 'punch.stance')
    const t = setTimeout(() => {
      if (this.punchAttackId === attackId && net.isOpen) net.attackStep(attackId, 'punch.jab')
    }, PUNCH_MACRO_FRAME_MS)
    this.punchMacroTimers.push(t)
  }

  // ─── Input → server actions ────────────────────────────────────────────

  private handleDirKey(keyName: string, dir: Dir, dx: number, dy: number) {
    this.heldKeys.add(keyName)
    if (!this.player || !this.matchActive || !this.net) return
    this.setFacing(this.player, dir)

    const now = this.time.now
    if (now - this.lastActionSentAt < ACTION_SEND_MIN_GAP_MS) {
      // Held key, throttling. Keep the walk anim alive so it doesn't flicker.
      this.startWalk(this.player, dir)
      return
    }
    this.lastActionSentAt = now

    const target: Tile = [this.player.tile.x + dx, this.player.tile.y + dy]
    // Bounds: server would reject, but skip the round-trip for obvious OOB.
    if (target[0] < 0 || target[0] >= GRID_SIZE || target[1] < 0 || target[1] >= GRID_SIZE) {
      if (this.player.currentAnimKey !== null) this.stopWalk(this.player)
      return
    }
    this.net.setPath([target])
    // Optimistic anim: visually walk now; perception_tick will confirm/snap.
    this.startWalk(this.player, dir)
  }

  // ─── Rendering helpers (unchanged in spirit from pre-net code) ─────────

  private drawArena() {
    const g = this.add.graphics()
    g.lineStyle(1, 0xcccccc, 1)
    g.fillStyle(0xffffff, 1)
    const hw = TILE_W / 2
    const hh = TILE_H / 2
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const { sx, sy } = worldToScreen(x, y)
        g.beginPath()
        g.moveTo(sx, sy - hh)
        g.lineTo(sx + hw, sy)
        g.lineTo(sx, sy + hh)
        g.lineTo(sx - hw, sy)
        g.closePath()
        g.fillPath()
        g.strokePath()
      }
    }
  }

  private spawnEntityAtTile(id: string, tx: number, ty: number, opts?: { tint?: number }): Entity {
    const { sx, sy } = worldToScreen(tx, ty)
    const sprite = this.add.sprite(sx, sy, DEFAULT_IDLE).setOrigin(0.5, 1)
    if (opts?.tint !== undefined) sprite.setTint(opts.tint)
    this.resizeSprite(sprite)
    sprite.on('animationupdate', () => this.resizeSprite(sprite))
    const entity: Entity = {
      tile: { x: tx, y: ty },
      sprite,
      lastDir: null,
      currentAnimKey: null,
      lastMoveAt: 0,
      attackMoveId: null,
    }
    this.updateDepth(entity)
    this.entitiesById.set(id, entity)
    return entity
  }

  private moveEntityTo(e: Entity, tx: number, ty: number) {
    e.tile = { x: tx, y: ty }
    const { sx, sy } = worldToScreen(tx, ty)
    e.sprite.setPosition(sx, sy)
    this.updateDepth(e)
  }

  private updateDepth(e: Entity) {
    const { sy } = worldToScreen(e.tile.x, e.tile.y)
    e.sprite.setDepth(sy * 100 + e.tile.x)
  }

  private setFacing(e: Entity, dir: Dir) {
    e.lastDir = dir
    // Walk/idle frames are per-direction, so no flipping here. Reset FlipX in
    // case we were just rendering a (flipped) punch frame.
    e.sprite.setFlipX(false)
  }

  private startWalk(e: Entity, dir: Dir) {
    const animKey = ANIM_FOR_DIR[dir]
    if (e.currentAnimKey !== animKey) {
      e.sprite.play(animKey)
      this.resizeSprite(e.sprite)
      e.currentAnimKey = animKey
    }
    e.lastMoveAt = this.time.now
  }

  private stopWalk(e: Entity) {
    if (e.currentAnimKey === null) return
    e.sprite.stop()
    e.sprite.setTexture(e.lastDir ? RESTING_FRAME_FOR_DIR[e.lastDir] : DEFAULT_IDLE)
    e.sprite.setFlipX(false)
    this.resizeSprite(e.sprite)
    e.currentAnimKey = null
  }

  private resizeSprite(sprite: Phaser.GameObjects.Sprite) {
    const aspect = sprite.width / sprite.height
    sprite.setDisplaySize(TARGET_H * aspect, TARGET_H)
  }

  // ─── Status overlay ────────────────────────────────────────────────────

  private showStatus(msg: string) {
    if (!this.statusText) {
      this.statusText = this.add.text(10, 10, msg, {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: '#ffffff',
        backgroundColor: '#00000099',
        padding: { left: 6, right: 6, top: 4, bottom: 4 },
      })
      this.statusText.setScrollFactor(0)
      this.statusText.setDepth(10000000)
    } else {
      this.statusText.setText(msg)
      this.statusText.setVisible(true)
    }
  }

  private hideStatus() {
    if (this.statusText) this.statusText.setVisible(false)
  }
}

function directionFromDelta(dx: number, dy: number): Dir | null {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left'
  if (Math.abs(dy) > 0) return dy > 0 ? 'down' : 'up'
  return null
}
