import Phaser from 'phaser'
import idleUrl from '../../../assets/concept_art/sprites/01_idle_front.png?url'
import { GRID_SIZE, TILE_W, TILE_H, START_TILE } from '../config'
import { worldToScreen } from '../iso'

export class ArenaScene extends Phaser.Scene {
  private charTile = { x: START_TILE.x, y: START_TILE.y }
  private charSprite!: Phaser.GameObjects.Sprite

  constructor() {
    super({ key: 'ArenaScene' })
  }

  preload() {
    this.load.image('idle', idleUrl)
  }

  create() {
    this.cameras.main.setBackgroundColor('#222222')

    this.drawArena()

    const { sx, sy } = worldToScreen(this.charTile.x, this.charTile.y)
    this.charSprite = this.add.sprite(sx, sy, 'idle').setOrigin(0.5, 1)

    const targetHeight = TILE_H * 3
    const scale = targetHeight / this.charSprite.height
    this.charSprite.setScale(scale)

    const halfW = (GRID_SIZE * TILE_W) / 2
    const fullH = GRID_SIZE * TILE_H
    this.cameras.main.setBounds(
      -halfW - TILE_W,
      -TILE_H,
      GRID_SIZE * TILE_W + TILE_W * 2,
      fullH + TILE_H * 2,
    )
    this.cameras.main.startFollow(this.charSprite, true)

    const keyboard = this.input.keyboard!
    keyboard.on('keydown-W', () => this.tryMove(0, -1))
    keyboard.on('keydown-S', () => this.tryMove(0, 1))
    keyboard.on('keydown-A', () => this.tryMove(-1, 0))
    keyboard.on('keydown-D', () => this.tryMove(1, 0))
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

  private tryMove(dx: number, dy: number) {
    const nx = this.charTile.x + dx
    const ny = this.charTile.y + dy
    if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) return
    this.charTile = { x: nx, y: ny }
    const { sx, sy } = worldToScreen(nx, ny)
    this.charSprite.setPosition(sx, sy)
  }
}
