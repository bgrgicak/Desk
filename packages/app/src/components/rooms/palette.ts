// Saturated colour palette used for room accents (dots, breadcrumb tint,
// avatar fills). Replaces the earlier pastel set; legacy pastel values are
// translated on read via `roomColor()`.

export const ROOM_PALETTE = [
  { value: '#2563eb', label: 'Blue'   },
  { value: '#16a34a', label: 'Green'  },
  { value: '#ec4899', label: 'Pink'   },
  { value: '#f59e0b', label: 'Amber'  },
  { value: '#a855f7', label: 'Purple' },
  { value: '#f97316', label: 'Orange' },
  { value: '#ef4444', label: 'Red'    },
  { value: '#14b8a6', label: 'Teal'   },
] as const

export type RoomColor = (typeof ROOM_PALETTE)[number]['value']

export const ROOM_PALETTE_VALUES: readonly string[] = ROOM_PALETTE.map(c => c.value)
