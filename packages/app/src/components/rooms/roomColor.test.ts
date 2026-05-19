import { describe, expect, it } from 'vitest'
import { roomColor } from './roomColor'
import { ROOM_PALETTE_VALUES } from './palette'

describe('roomColor', () => {
  it('returns the input unchanged when already in the saturated palette', () => {
    for (const value of ROOM_PALETTE_VALUES) {
      expect(roomColor(value)).toBe(value)
    }
  })

  it('maps a pastel hex to its nearest saturated palette colour by hue', () => {
    // Pastel blue → saturated blue
    expect(roomColor('#dbeafe')).toBe('#2563eb')
    // Pastel green → saturated green
    expect(roomColor('#d1fae5')).toBe('#16a34a')
    // Pastel pink → saturated pink
    expect(roomColor('#fce7f3')).toBe('#ec4899')
    // Pastel amber → saturated amber (warm yellow)
    expect(roomColor('#fef3c7')).toBe('#f59e0b')
  })

  it('accepts a workspace-info-shaped object via the `bg` field', () => {
    expect(roomColor({ bg: '#dbeafe' })).toBe('#2563eb')
  })

  it('falls back to the first palette colour for empty / invalid input', () => {
    expect(roomColor(null)).toBe(ROOM_PALETTE_VALUES[0])
    expect(roomColor(undefined)).toBe(ROOM_PALETTE_VALUES[0])
    expect(roomColor('')).toBe(ROOM_PALETTE_VALUES[0])
    expect(roomColor('not-a-hex')).toBe(ROOM_PALETTE_VALUES[0])
    expect(roomColor({ bg: undefined })).toBe(ROOM_PALETTE_VALUES[0])
  })
})
