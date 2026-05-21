import type { Answer, Step } from './types'

export function formatAnswer(value: Answer): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

export function formatSingle(step: Step, value: Answer): string {
  if (step.type === 'rating' && typeof value === 'number') {
    const max = step.max ?? 5
    return `${value}/${max}`
  }
  return formatAnswer(value)
}

export function formatAnswers(steps: Step[], values: Record<string, Answer>): string {
  if (steps.length === 1) {
    const [only] = steps
    return formatSingle(only, values[only.id] ?? null)
  }
  return steps
    .map((step, idx) => {
      const formatted = formatSingle(step, values[step.id] ?? null)
      return `**Q${idx + 1}: ${step.question}**\nA: ${formatted || '(no answer)'}`
    })
    .join('\n\n')
}
