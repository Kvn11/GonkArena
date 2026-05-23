import Phaser from 'phaser'
import { ArenaScene } from './scenes/ArenaScene'

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: '#222222',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [ArenaScene],
})

// Expose for headless test drivers (CDP can grab the scene to invoke
// keyboard macros directly when raw key dispatch is unreliable).
;(window as unknown as { game: Phaser.Game }).game = game
