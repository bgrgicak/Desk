// Parses `?items=` and `?title=` from the iframe URL into structured
// values. Defensive: silently filters out malformed action entries rather
// than crashing the whole render, so a single bad item doesn't blank the
// fragment. Returns an empty array when items is missing or unparseable —
// the caller decides how to surface that.

import type { Action, Item, OnClick } from './types'

function readParams(): URLSearchParams {
  if (typeof window === 'undefined' || !window.location) {
    return new URLSearchParams()
  }
  return new URLSearchParams(window.location.search)
}

export function readTitle(): string | undefined {
  const raw = readParams().get('title')
  if (raw === null) return undefined
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

export function readItems(): Item[] {
  const raw = readParams().get('items')
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: Item[] = []
  for (const candidate of parsed) {
    const item = coerceItem(candidate)
    if (item) out.push(item)
  }
  return out
}

function coerceString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function coerceItem(v: unknown): Item | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const item: Item = {}
  const title = coerceString(r.title)
  if (title) item.title = title
  const description = coerceString(r.description)
  if (description) item.description = description
  const image = coerceString(r.image)
  if (image) item.image = image
  const link = coerceString(r.link)
  if (link) item.link = link
  const onClick = coerceOnClick(r.onClick)
  if (onClick) item.onClick = onClick
  const actions = coerceActions(r.actions)
  if (actions.length > 0) item.actions = actions
  // Drop entirely empty cards — they would render as a sad bare border.
  if (
    !item.title &&
    !item.description &&
    !item.image &&
    !item.link &&
    !item.onClick &&
    !item.actions
  ) {
    return null
  }
  return item
}

function coerceOnClick(v: unknown): OnClick | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  const link = coerceString(r.link)
  if (link) return { link }
  const reply = coerceString(r.reply)
  if (reply) return { reply }
  return undefined
}

function coerceActions(v: unknown): Action[] {
  if (!Array.isArray(v)) return []
  const out: Action[] = []
  for (const candidate of v) {
    if (!candidate || typeof candidate !== 'object') continue
    const r = candidate as Record<string, unknown>
    const label = coerceString(r.label)
    if (!label) continue
    const link = coerceString(r.link)
    if (link) {
      out.push({ label, link })
      continue
    }
    const reply = coerceString(r.reply)
    if (reply) {
      out.push({ label, reply })
      continue
    }
    // Action with neither link nor reply is nonsense; drop it.
  }
  return out
}
