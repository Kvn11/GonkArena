import Phaser from 'phaser'
import idleUrl from '../../../assets/concept_art/sprites/01_idle_front.png?url'
import left1Url from '../../../assets/concept_art/sprites/walking_left_1.png?url'
import left2Url from '../../../assets/concept_art/sprites/walking_left_2.png?url'
import left3Url from '../../../assets/concept_art/sprites/walking_left_3.png?url'
import left5Url from '../../../assets/concept_art/sprites/walking_left_5.png?url'
import left6Url from '../../../assets/concept_art/sprites/walking_left_6.png?url'
import up1Url from '../../../assets/concept_art/sprites/walking_up_1.png?url'
import up2Url from '../../../assets/concept_art/sprites/walking_up_2.png?url'
import up3Url from '../../../assets/concept_art/sprites/walking_up_3.png?url'
import up4Url from '../../../assets/concept_art/sprites/walking_up_4.png?url'
import up5Url from '../../../assets/concept_art/sprites/walking_up_5.png?url'
import up6Url from '../../../assets/concept_art/sprites/walking_up_6.png?url'
import down1Url from '../../../assets/concept_art/sprites/walking_down_1.png?url'
import down2Url from '../../../assets/concept_art/sprites/walking_down_2.png?url'
import down3Url from '../../../assets/concept_art/sprites/walking_down_3.png?url'
import down4Url from '../../../assets/concept_art/sprites/walking_down_4.png?url'
import down5Url from '../../../assets/concept_art/sprites/walking_down_5.png?url'
import down6Url from '../../../assets/concept_art/sprites/walking_down_6.png?url'
import { GRID_SIZE, TILE_W, TILE_H, START_TILE } from '../config'
import { worldToScreen } from '../iso'

const TARGET_H = TILE_H * 3
const IDLE_TIMEOUT_MS = 150

const AI_SPAWN_TILE = { x: 35, y: 32 }
const AI_TINT = 0xff8888

type Dir = 'up' | 'down' | 'left' | 'right'

// tryMove's outcome: callers (and future planners) can distinguish "off the
// arena" from "another entity is there" without a second predicate.
type MoveResult = 'moved' | 'oob' | 'blocked'

type Entity = {
  tile: { x: number; y: number }
  sprite: Phaser.GameObjects.Sprite
  lastDir: Dir | null
  currentAnimKey: string | null
  lastMoveAt: number
}

const ANIM_FOR_DIR: Record<Dir, 'walk_up' | 'walk_down' | 'walk_left'> = {
  up: 'walk_up',
  down: 'walk_down',
  left: 'walk_left',
  right: 'walk_left',
}

// First frame of each direction doubles as the standing-still pose. left/right
// reuse walk_left_1 (front-facing standing) since side-facing idle art doesn't
// exist yet; flipX picks left vs right.
const RESTING_FRAME_FOR_DIR: Record<Dir, string> = {
  up: 'walk_up_1',
  down: 'walk_down_1',
  left: 'walk_left_1',
  right: 'walk_left_1',
}

const WALK_FRAMES: Record<'walk_left' | 'walk_up' | 'walk_down', string[]> = {
  walk_left: ['walk_left_2', 'walk_left_3', 'walk_left_5', 'walk_left_6'],
  walk_up:   ['walk_up_1',   'walk_up_2',   'walk_up_3',   'walk_up_4',   'walk_up_5',   'walk_up_6'],
  walk_down: ['walk_down_1', 'walk_down_2', 'walk_down_3', 'walk_down_4', 'walk_down_5', 'walk_down_6'],
}

const WALK_FPS: Record<keyof typeof WALK_FRAMES, number> = {
  walk_left: 14,
  walk_up: 8,
  walk_down: 8,
}

export class ArenaScene extends Phaser.Scene {
  // Authoritative entity list; `player` is a convenience alias into this.
  // Re-initialized in create() because Phaser reuses the Scene instance on restart.
  // The AI Entity is currently only reachable via `entities` — when AI control
  // is wired up, capture it into a `private ai!: Entity` field at spawn time.
  private entities: Entity[] = []
  private player!: Entity
  private heldKeys = new Set<string>()

  constructor() {
    super({ key: 'ArenaScene' })
  }

  preload() {
    this.load.image('idle', idleUrl)
    this.load.image('walk_left_1', left1Url)
    this.load.image('walk_left_2', left2Url)
    this.load.image('walk_left_3', left3Url)
    this.load.image('walk_left_5', left5Url)
    this.load.image('walk_left_6', left6Url)
    this.load.image('walk_up_1', up1Url)
    this.load.image('walk_up_2', up2Url)
    this.load.image('walk_up_3', up3Url)
    this.load.image('walk_up_4', up4Url)
    this.load.image('walk_up_5', up5Url)
    this.load.image('walk_up_6', up6Url)
    this.load.image('walk_down_1', down1Url)
    this.load.image('walk_down_2', down2Url)
    this.load.image('walk_down_3', down3Url)
    this.load.image('walk_down_4', down4Url)
    this.load.image('walk_down_5', down5Url)
    this.load.image('walk_down_6', down6Url)
  }

  create() {
    this.entities = []
    this.heldKeys.clear()

    this.cameras.main.setBackgroundColor('#222222')

    this.drawArena()

    this.player = this.spawnEntity(START_TILE.x, START_TILE.y)
    this.spawnEntity(AI_SPAWN_TILE.x, AI_SPAWN_TILE.y, { tint: AI_TINT })

    for (const key of Object.keys(WALK_FRAMES) as Array<keyof typeof WALK_FRAMES>) {
      if (!this.anims.exists(key)) {
        this.anims.create({
          key,
          frames: WALK_FRAMES[key].map((k) => ({ key: k })),
          frameRate: WALK_FPS[key],
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
    this.cameras.main.startFollow(this.player.sprite, true)

    const keyboard = this.input.keyboard
    if (!keyboard) return

    keyboard.on('keydown-W', () => this.handleDirKey('W', this.player, 'up', 0, -1))
    keyboard.on('keydown-S', () => this.handleDirKey('S', this.player, 'down', 0, 1))
    keyboard.on('keydown-A', () => this.handleDirKey('A', this.player, 'left', -1, 0))
    keyboard.on('keydown-D', () => this.handleDirKey('D', this.player, 'right', 1, 0))
    keyboard.on('keyup-W', () => this.heldKeys.delete('W'))
    keyboard.on('keyup-S', () => this.heldKeys.delete('S'))
    keyboard.on('keyup-A', () => this.heldKeys.delete('A'))
    keyboard.on('keyup-D', () => this.heldKeys.delete('D'))
  }

  update(time: number, _delta: number) {
    for (const e of this.entities) {
      if (e.currentAnimKey === null) continue
      // Player-only: respect heldKeys so OS initial-repeat delay (up to ~250 ms
      // on X11) doesn't flicker idle/walk before the second keydown arrives.
      if (e === this.player && this.heldKeys.size > 0) continue
      if (time - e.lastMoveAt <= IDLE_TIMEOUT_MS) continue
      this.stopWalk(e)
    }
  }

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

  private spawnEntity(tx: number, ty: number, opts?: { tint?: number }): Entity {
    if (tx < 0 || tx >= GRID_SIZE || ty < 0 || ty >= GRID_SIZE) {
      throw new Error(`spawnEntity: tile (${tx},${ty}) out of bounds for ${GRID_SIZE}x${GRID_SIZE} arena`)
    }
    if (this.isOccupied(tx, ty)) {
      throw new Error(`spawnEntity: tile (${tx},${ty}) is already occupied`)
    }
    const { sx, sy } = worldToScreen(tx, ty)
    const sprite = this.add.sprite(sx, sy, 'idle').setOrigin(0.5, 1)
    if (opts?.tint !== undefined) sprite.setTint(opts.tint)
    this.resizeSprite(sprite)
    // Listener belongs on every entity sprite, not just the player's, so
    // future animated entities (the AI once it gets behavior, NPCs, etc.) get
    // per-frame aspect-ratio correction for free.
    sprite.on('animationupdate', () => this.resizeSprite(sprite))
    const entity: Entity = {
      tile: { x: tx, y: ty },
      sprite,
      lastDir: null,
      currentAnimKey: null,
      lastMoveAt: 0,
    }
    this.updateDepth(entity)
    this.entities.push(entity)
    return entity
  }

  private isOccupied(tx: number, ty: number, exclude?: Entity): boolean {
    for (const e of this.entities) {
      if (e === exclude) continue
      if (e.tile.x === tx && e.tile.y === ty) return true
    }
    return false
  }

  // Iso depth: feet-of-sprite lower on screen renders on top. Multiplying sy
  // by 100 leaves room for tile.x as a deterministic tie-breaker, so two
  // entities on the same iso row don't z-fight by display-list order.
  private updateDepth(e: Entity) {
    const { sy } = worldToScreen(e.tile.x, e.tile.y)
    e.sprite.setDepth(sy * 100 + e.tile.x)
  }

  private handleDirKey(keyName: string, e: Entity, dir: Dir, dx: number, dy: number) {
    this.heldKeys.add(keyName)
    // Face the direction even on blocked moves so the resting pose reflects intent.
    this.setFacing(e, dir)
    const result = this.tryMove(e, dx, dy)
    if (result === 'moved') {
      this.startWalk(e, dir)
    } else if (e.currentAnimKey !== null) {
      // Blocked or out-of-bounds while moving: stop the walk anim instead of
      // letting it march in place until the key is released.
      this.stopWalk(e)
    }
  }

  private setFacing(e: Entity, dir: Dir) {
    e.lastDir = dir
    e.sprite.setFlipX(dir === 'right')
  }

  private startWalk(e: Entity, dir: Dir) {
    const animKey = ANIM_FOR_DIR[dir]
    if (e.currentAnimKey !== animKey) {
      e.sprite.play(animKey)
      // Phaser skips ANIMATION_UPDATE for the first frame of a freshly-played
      // anim, so size it explicitly to avoid drawing frame 1 at the previous
      // texture's aspect.
      this.resizeSprite(e.sprite)
      e.currentAnimKey = animKey
    }
    e.lastMoveAt = this.time.now
  }

  private stopWalk(e: Entity) {
    if (e.currentAnimKey === null) return
    e.sprite.stop()
    if (e.lastDir === null) {
      e.sprite.setTexture('idle')
      e.sprite.setFlipX(false)
    } else {
      e.sprite.setTexture(RESTING_FRAME_FOR_DIR[e.lastDir])
      e.sprite.setFlipX(e.lastDir === 'right')
    }
    this.resizeSprite(e.sprite)
    e.currentAnimKey = null
  }

  private resizeSprite(sprite: Phaser.GameObjects.Sprite) {
    const aspect = sprite.width / sprite.height
    sprite.setDisplaySize(TARGET_H * aspect, TARGET_H)
  }

  private tryMove(e: Entity, dx: number, dy: number): MoveResult {
    const nx = e.tile.x + dx
    const ny = e.tile.y + dy
    if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) return 'oob'
    if (this.isOccupied(nx, ny, e)) return 'blocked'
    e.tile = { x: nx, y: ny }
    const { sx, sy } = worldToScreen(nx, ny)
    e.sprite.setPosition(sx, sy)
    this.updateDepth(e)
    return 'moved'
  }
}
