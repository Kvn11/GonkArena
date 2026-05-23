import Phaser from 'phaser'
import idleUrl from '../../../assets/concept_art/sprites/01_idle_front.png?url'
import left1Url from '../../../assets/concept_art/sprites/walking_left_1.png?url'
import left2Url from '../../../assets/concept_art/sprites/walking_left_2.png?url'
import left3Url from '../../../assets/concept_art/sprites/walking_left_3.png?url'
import left4Url from '../../../assets/concept_art/sprites/walking_left_4.png?url'
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

// Starting tile for the static AI character — placed visibly to the world-east
// of the player so a fresh player can immediately see them and walk into them.
const AI_SPAWN_TILE = { x: 35, y: 32 }

type Dir = 'up' | 'down' | 'left' | 'right'

type Entity = {
  tile: { x: number; y: number }
  sprite: Phaser.GameObjects.Sprite
}

const ANIM_FOR_DIR: Record<Dir, 'walk_up' | 'walk_down' | 'walk_left'> = {
  up: 'walk_up',
  down: 'walk_down',
  left: 'walk_left',
  right: 'walk_left',
}

// First frame of each direction's walk cycle doubles as a standing-still pose.
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
  private player!: Entity
  private ai!: Entity
  private lastMoveAt = 0
  private moving = false
  private currentAnimKey: string | null = null
  private lastDir: Dir | null = null
  private heldKeys = new Set<string>()

  constructor() {
    super({ key: 'ArenaScene' })
  }

  preload() {
    this.load.image('idle', idleUrl)
    this.load.image('walk_left_1', left1Url)
    this.load.image('walk_left_2', left2Url)
    this.load.image('walk_left_3', left3Url)
    this.load.image('walk_left_4', left4Url)
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
    // Phaser reuses the Scene instance across restarts; re-init per-run state.
    this.lastMoveAt = 0
    this.moving = false
    this.currentAnimKey = null
    this.lastDir = null
    this.heldKeys.clear()

    this.cameras.main.setBackgroundColor('#222222')

    this.drawArena()

    this.player = this.spawnEntity(START_TILE.x, START_TILE.y)
    this.ai = this.spawnEntity(AI_SPAWN_TILE.x, AI_SPAWN_TILE.y)

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

    // Only the player runs animations right now; AI is static.
    this.player.sprite.on('animationupdate', () => this.resizeSprite(this.player.sprite))

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

    // Track held keys with a Set (no addKey/addKeys: that would make Phaser
    // suppress repeat 'keydown-X' events, so holding a key would only move once).
    keyboard.on('keydown-W', () => { this.heldKeys.add('W'); if (this.tryMove(0, -1)) this.startWalk('up') })
    keyboard.on('keydown-S', () => { this.heldKeys.add('S'); if (this.tryMove(0, 1))  this.startWalk('down') })
    keyboard.on('keydown-A', () => { this.heldKeys.add('A'); if (this.tryMove(-1, 0)) this.startWalk('left') })
    keyboard.on('keydown-D', () => { this.heldKeys.add('D'); if (this.tryMove(1, 0))  this.startWalk('right') })
    keyboard.on('keyup-W', () => this.heldKeys.delete('W'))
    keyboard.on('keyup-S', () => this.heldKeys.delete('S'))
    keyboard.on('keyup-A', () => this.heldKeys.delete('A'))
    keyboard.on('keyup-D', () => this.heldKeys.delete('D'))
  }

  update(time: number) {
    if (!this.moving) return
    if (this.heldKeys.size > 0) return
    if (time - this.lastMoveAt <= IDLE_TIMEOUT_MS) return

    const sprite = this.player.sprite
    sprite.stop()
    if (this.lastDir === null) {
      sprite.setTexture('idle')
      sprite.setFlipX(false)
    } else {
      sprite.setTexture(RESTING_FRAME_FOR_DIR[this.lastDir])
      sprite.setFlipX(this.lastDir === 'right')
    }
    this.resizeSprite(sprite)
    this.moving = false
    this.currentAnimKey = null
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

  private spawnEntity(tx: number, ty: number): Entity {
    const { sx, sy } = worldToScreen(tx, ty)
    const sprite = this.add.sprite(sx, sy, 'idle').setOrigin(0.5, 1)
    this.resizeSprite(sprite)
    const entity: Entity = { tile: { x: tx, y: ty }, sprite }
    this.updateDepth(entity)
    return entity
  }

  // Iso depth: characters with feet lower on screen are closer to the viewer
  // and must render on top. Setting depth = screen-y of the sprite's feet
  // achieves that with a single ordering function.
  private updateDepth(e: Entity) {
    const { sy } = worldToScreen(e.tile.x, e.tile.y)
    e.sprite.setDepth(sy)
  }

  private isOccupied(tx: number, ty: number, exclude?: Entity): boolean {
    for (const e of [this.player, this.ai]) {
      if (!e || e === exclude) continue
      if (e.tile.x === tx && e.tile.y === ty) return true
    }
    return false
  }

  private startWalk(dir: Dir) {
    const flip = dir === 'right'
    const animKey = ANIM_FOR_DIR[dir]
    const sprite = this.player.sprite
    sprite.setFlipX(flip)
    this.lastDir = dir
    if (!this.moving || this.currentAnimKey !== animKey) {
      sprite.play(animKey)
      // Phaser skips ANIMATION_UPDATE for the first frame of a freshly-played anim;
      // size it explicitly so frame 1 isn't drawn at the previous texture's aspect.
      this.resizeSprite(sprite)
      this.currentAnimKey = animKey
      this.moving = true
    }
    this.bumpMoved()
  }

  private bumpMoved() {
    this.lastMoveAt = this.time.now
  }

  private resizeSprite(sprite: Phaser.GameObjects.Sprite) {
    const aspect = sprite.width / sprite.height
    sprite.setDisplaySize(TARGET_H * aspect, TARGET_H)
  }

  private tryMove(dx: number, dy: number): boolean {
    const nx = this.player.tile.x + dx
    const ny = this.player.tile.y + dy
    if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) return false
    if (this.isOccupied(nx, ny, this.player)) return false
    this.player.tile = { x: nx, y: ny }
    const { sx, sy } = worldToScreen(nx, ny)
    this.player.sprite.setPosition(sx, sy)
    this.updateDepth(this.player)
    return true
  }
}
