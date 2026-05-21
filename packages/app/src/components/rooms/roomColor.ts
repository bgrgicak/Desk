import { ROOM_PALETTE_VALUES } from './palette'

// `roomColor()` returns a saturated hex from `ROOM_PALETTE`. If the input is
// already in the palette it passes through unchanged; otherwise the nearest
// palette colour is picked by hue distance. Used to translate legacy pastel
// values (e.g. `#dbeafe`) without a DB migration.

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.trim().match(/^#?([\da-f]{6})$/i)
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

function rgbToHue({ r, g, b }: { r: number; g: number; b: number }): number {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const d = max - min
  if (d === 0) return 0
  let h: number
  if (max === rn) h = ((gn - bn) / d) % 6
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  h *= 60
  return h < 0 ? h + 360 : h
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

const FALLBACK = ROOM_PALETTE_VALUES[0]

export function roomColor(input: { bg?: string } | string | null | undefined): string {
  const raw = typeof input === 'string' ? input : input?.bg
  if (!raw) return FALLBACK
  if (ROOM_PALETTE_VALUES.includes(raw.toLowerCase()) || ROOM_PALETTE_VALUES.includes(raw)) return raw
  const rgb = hexToRgb(raw)
  if (!rgb) return FALLBACK
  const inputHue = rgbToHue(rgb)
  let bestHex = FALLBACK
  let bestDist = Infinity
  for (const hex of ROOM_PALETTE_VALUES) {
    const candHue = rgbToHue(hexToRgb(hex)!)
    const d = hueDistance(inputHue, candHue)
    if (d < bestDist) {
      bestDist = d
      bestHex = hex
    }
  }
  return bestHex
}
