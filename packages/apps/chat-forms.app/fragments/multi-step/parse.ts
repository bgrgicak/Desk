import type { Step } from '../../src/wizard/types'
import { readParams } from '../../src/wizard/url'

const VALID_TYPES = new Set<Step['type']>([
  'yes-no',
  'single-choice',
  'multi-select',
  'short-text',
  'long-text',
  'number',
  'date',
  'rating',
])

export interface ParsedSteps {
  steps: Step[]
  error: string | null
}

/**
 * Pure parser. Takes the raw value of the `steps` URL param (already
 * URL-decoded by URLSearchParams). Exposed separately from the
 * window-reading wrapper so it can be unit-tested without jsdom.
 */
export function parseSteps(raw: string | null): ParsedSteps {
  if (!raw) {
    return { steps: [], error: 'Missing required `steps` param (JSON array).' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      steps: [],
      error: `\`steps\` is not valid JSON: ${(err as Error).message}`,
    }
  }

  if (!Array.isArray(parsed)) {
    return { steps: [], error: '`steps` must be a JSON array.' }
  }
  if (parsed.length === 0) {
    return { steps: [], error: '`steps` must contain at least one step.' }
  }

  const seenIds = new Set<string>()
  const steps: Step[] = []

  for (let i = 0; i < parsed.length; i++) {
    const candidate = parsed[i]
    if (!candidate || typeof candidate !== 'object') {
      return { steps: [], error: `Step ${i}: must be an object.` }
    }
    const obj = candidate as Record<string, unknown>
    const id = typeof obj.id === 'string' && obj.id ? obj.id : `q${i + 1}`
    const type = obj.type
    const question = obj.question

    if (typeof type !== 'string' || !VALID_TYPES.has(type as Step['type'])) {
      return {
        steps: [],
        error: `Step ${i}: \`type\` must be one of ${Array.from(VALID_TYPES).join(', ')}.`,
      }
    }
    if (typeof question !== 'string' || question.length === 0) {
      return { steps: [], error: `Step ${i}: \`question\` is required.` }
    }
    if (seenIds.has(id)) {
      return { steps: [], error: `Step ${i}: duplicate id "${id}".` }
    }
    seenIds.add(id)

    if (type === 'single-choice' || type === 'multi-select') {
      const rawOptions = obj.options
      let cleaned: string[]
      if (Array.isArray(rawOptions)) {
        cleaned = rawOptions.filter((o): o is string => typeof o === 'string')
        if (cleaned.length !== rawOptions.length) {
          return {
            steps: [],
            error: `Step ${i} (${type}): every option must be a string.`,
          }
        }
      } else if (typeof rawOptions === 'string') {
        // Agents naturally produce comma-separated `options` strings (the
        // single-question fragment skills teach that form), so accept both
        // shapes here rather than forcing the caller to JSON-array it.
        cleaned = rawOptions
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      } else {
        return {
          steps: [],
          error: `Step ${i} (${type}): \`options\` must be an array or comma-separated string.`,
        }
      }
      if (cleaned.length === 0) {
        return {
          steps: [],
          error: `Step ${i} (${type}): \`options\` must be non-empty.`,
        }
      }
      if (type === 'multi-select') {
        steps.push({
          id,
          type,
          question,
          options: cleaned,
          min: typeof obj.min === 'number' ? obj.min : undefined,
          max: typeof obj.max === 'number' ? obj.max : undefined,
        })
      } else {
        steps.push({ id, type, question, options: cleaned })
      }
      continue
    }

    if (type === 'number') {
      steps.push({
        id,
        type,
        question,
        min: typeof obj.min === 'number' ? obj.min : undefined,
        max: typeof obj.max === 'number' ? obj.max : undefined,
      })
      continue
    }

    if (type === 'rating') {
      steps.push({
        id,
        type,
        question,
        max: typeof obj.max === 'number' ? obj.max : undefined,
      })
      continue
    }

    if (type === 'short-text' || type === 'long-text') {
      steps.push({
        id,
        type,
        question,
        placeholder:
          typeof obj.placeholder === 'string' ? obj.placeholder : undefined,
      })
      continue
    }

    // yes-no, date — no extra fields
    steps.push({ id, type, question } as Step)
  }

  return { steps, error: null }
}

export function parseStepsParam(): ParsedSteps {
  return parseSteps(readParams().get('steps'))
}
