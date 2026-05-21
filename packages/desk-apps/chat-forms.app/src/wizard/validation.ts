import type { Answer, Step } from './types'

export function isAnswered(step: Step, value: Answer): boolean {
  switch (step.type) {
    case 'yes-no':
      return value === 'Yes' || value === 'No'
    case 'single-choice':
      return typeof value === 'string' && value.length > 0
    case 'multi-select': {
      if (!Array.isArray(value)) return false
      const min = step.min ?? 1
      return value.length >= min
    }
    case 'short-text':
    case 'long-text':
      return typeof value === 'string' && value.trim().length > 0
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'date':
      return typeof value === 'string' && value.length > 0
    case 'rating':
      return typeof value === 'number' && value > 0
  }
}

export function defaultValue(step: Step): Answer {
  switch (step.type) {
    case 'multi-select':
      return []
    case 'number':
    case 'rating':
      return null
    default:
      return ''
  }
}
