import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  build: {
    // Phaser alone is ~1.3 MB minified — that's the floor for a Phaser game,
    // not something to chase down. Bumping the threshold so the build doesn't
    // emit a noisy warning every time.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // Pull Phaser into its own chunk. Total bytes are unchanged, but
        // because game code changes far more often than the Phaser version,
        // this lets browsers keep the vendor chunk cached across deploys.
        manualChunks: {
          phaser: ['phaser'],
        },
      },
    },
  },
})
