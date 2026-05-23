import Phaser from 'phaser'
import idleUrl from '../../../assets/concept_art/sprites/01_idle_front.png?url'
import walk1Url from '../../../assets/concept_art/sprites/03_walk_1.png?url'
import walk2Url from '../../../assets/concept_art/sprites/04_walk_2.png?url'
import walk3Url from '../../../assets/concept_art/sprites/05_walk_3.png?url'
import walk4Url from '../../../assets/concept_art/sprites/06_walk_4.png?url'
import { GRID_SIZE, TILE_W, TILE_H, START_TILE } from '../config'
import { worldToScreen } from '../iso'

const TARGET_H = TILE_H * 3
const IDLE_TIMEOUT_MS = 150

type WasdKeys = {
  W: Phaser.Input.Keyboard.Key
  A: Phaser.Input.Keyboard.Key
  S: Phaser.Input.Keyboard.Key
  D: Phaser.Input.Keyboard.Key
}

export class ArenaScene extends Phaser.Scene {
  private charTile = { x: START_TILE.x, y: START_TILE.y }
  private charSprite!: Phaser.GameObjects.Sprite
  private lastMoveAt = 0
  private moving = false
  private lastFacingFlip = false
  private keys?: WasdKeys

  constructor() {
    super({ key: 'ArenaScene' })
  }

  preload() {
    this.load.image('idle', idleUrl)
    this.load.image('walk_1', walk1Url)
    this.load.image('walk_2', walk2Url)
    this.load.image('walk_3', walk3Url)
    this.load.image('walk_4', walk4Url)
  }

  create() {
    // Phaser reuses the Scene instance across restarts; re-init per-run state here
    // because class-field initializers only run in the constructor.
    this.charTile = { x: START_TILE.x, y: START_TILE.y }
    this.lastMoveAt = 0
    this.moving = false
    this.lastFacingFlip = false
    this.keys = undefined

    this.cameras.main.setBackgroundColor('#222222')

    this.drawArena()

    const { sx, sy } = worldToScreen(this.charTile.x, this.charTile.y)
    this.charSprite = this.add.sprite(sx, sy, 'idle').setOrigin(0.5, 1)
    this.resizeSpriteToTarget()

    if (!this.anims.exists('walk')) {
      this.anims.create({
        key: 'walk',
        frames: [
          { key: 'walk_1' },
          { key: 'walk_2' },
          { key: 'walk_3' },
          { key: 'walk_4' },
        ],
        frameRate: 8,
        repeat: -1,
      })
    }

    this.charSprite.on('animationupdate', () => this.resizeSpriteToTarget())

    const halfW = (GRID_SIZE * TILE_W) / 2
    const fullH = GRID_SIZE * TILE_H
    this.cameras.main.setBounds(
      -halfW - TILE_W,
      -TILE_H,
      GRID_SIZE * TILE_W + TILE_W * 2,
      fullH + TILE_H * 2,
    )
    this.cameras.main.startFollow(this.charSprite, true)

    const keyboard = this.input.keyboard
    if (!keyboard) return
    this.keys = keyboard.addKeys('W,A,S,D') as WasdKeys

    keyboard.on('keydown-W', () => { if (this.tryMove(0, -1)) this.bumpMoved() })
    keyboard.on('keydown-S', () => { if (this.tryMove(0, 1))  this.bumpMoved() })
    keyboard.on('keydown-A', () => { if (this.tryMove(-1, 0)) this.startWalk(true) })
    keyboard.on('keydown-D', () => { if (this.tryMove(1, 0))  this.startWalk(false) })
  }

  update(time: number) {
    if (!this.moving || !this.keys) return
    const anyHeld =
      this.keys.W.isDown || this.keys.A.isDown ||
      this.keys.S.isDown || this.keys.D.isDown
    if (anyHeld) return
    if (time - this.lastMoveAt <= IDLE_TIMEOUT_MS) return

    this.charSprite.stop()
    this.charSprite.setTexture('idle')
    this.charSprite.setFlipX(this.lastFacingFlip)
    this.resizeSpriteToTarget()
    this.moving = false
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

  private startWalk(flip: boolean) {
    this.charSprite.setFlipX(flip)
    this.lastFacingFlip = flip
    if (!this.moving) {
      this.charSprite.play('walk')
      // Phaser skips ANIMATION_UPDATE for the first frame of a freshly-played anim,
      // so the listener doesn't fire; size walk_1 explicitly.
      this.resizeSpriteToTarget()
      this.moving = true
    }
    this.bumpMoved()
  }

  private bumpMoved() {
    this.lastMoveAt = this.time.now
  }

  private resizeSpriteToTarget() {
    const aspect = this.charSprite.width / this.charSprite.height
    this.charSprite.setDisplaySize(TARGET_H * aspect, TARGET_H)
  }

  private tryMove(dx: number, dy: number): boolean {
    const nx = this.charTile.x + dx
    const ny = this.charTile.y + dy
    if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) return false
    this.charTile = { x: nx, y: ny }
    const { sx, sy } = worldToScreen(nx, ny)
    this.charSprite.setPosition(sx, sy)
    return true
  }
}
