import { TILE_W, TILE_H } from './config'

export function worldToScreen(x: number, y: number): { sx: number; sy: number } {
  return {
    sx: (x - y) * (TILE_W / 2),
    sy: (x + y) * (TILE_H / 2),
  }
}

export function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  const a = sx / (TILE_W / 2)
  const b = sy / (TILE_H / 2)
  return {
    x: (a + b) / 2,
    y: (b - a) / 2,
  }
}
