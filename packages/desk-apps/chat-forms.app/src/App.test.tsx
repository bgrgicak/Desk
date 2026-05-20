import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from './App'
import YesNoFragment from '../fragments/yes-no/Component'
import MultiStepFragment from '../fragments/multi-step/Component'
import { Wizard } from './wizard/Wizard'
import { formatAnswers } from './wizard/format'
import { isAnswered } from './wizard/validation'
import { parseSteps } from '../fragments/multi-step/parse'
import type { Step } from './wizard/types'

describe('chat-forms app shell', () => {
  it('lists every registered fragment', () => {
    const html = renderToString(<App />)
    expect(html).toContain('chat-forms')
    for (const name of [
      'yes-no',
      'single-choice',
      'multi-select',
      'short-text',
      'long-text',
      'number',
      'date',
      'rating',
      'multi-step',
    ]) {
      expect(html).toContain(name)
    }
  })
})

describe('yes-no fragment', () => {
  it('renders the question when none is provided', () => {
    const html = renderToString(<YesNoFragment />)
    expect(html).toContain('No question provided.')
    expect(html).toContain('Yes')
    expect(html).toContain('No')
  })
})

describe('multi-step fragment', () => {
  it('surfaces an error when steps param is missing', () => {
    const html = renderToString(<MultiStepFragment />)
    expect(html).toContain('multi-step: bad input')
    expect(html).toContain('Missing required `steps` param')
  })
})

describe('Wizard progress indicator', () => {
  // React 19's SSR inserts <!-- --> markers between adjacent dynamic text
  // nodes — strip them so assertions can match the user-visible string.
  const visible = (html: string) => html.replace(/<!--\s*-->/g, '')

  const threeSteps: Step[] = [
    { id: 'q1', type: 'short-text', question: 'Test name?' },
    { id: 'q2', type: 'short-text', question: 'B?' },
    { id: 'q3', type: 'short-text', question: 'C?' },
  ]

  it('shows the indicator by default for multi-step forms', () => {
    const html = visible(renderToString(<Wizard steps={threeSteps} />))
    expect(html).toContain('Step 1 of 3')
  })

  it('hides the indicator when showProgress is false', () => {
    const html = visible(
      renderToString(<Wizard steps={threeSteps} showProgress={false} />),
    )
    expect(html).not.toContain('Step 1 of 3')
    expect(html).toContain('Test name?')
  })

  it('never shows the indicator for a single-step form', () => {
    const oneStep: Step[] = [{ id: 'q1', type: 'short-text', question: 'Only?' }]
    const html = visible(renderToString(<Wizard steps={oneStep} />))
    expect(html).not.toContain('Step 1 of 1')
  })
})

describe('validation', () => {
  it('accepts a yes-no answer only when set to Yes or No', () => {
    const step: Step = { id: 'q1', type: 'yes-no', question: 'ok?' }
    expect(isAnswered(step, '')).toBe(false)
    expect(isAnswered(step, 'maybe')).toBe(false)
    expect(isAnswered(step, 'Yes')).toBe(true)
    expect(isAnswered(step, 'No')).toBe(true)
  })

  it('requires min selections for multi-select', () => {
    const step: Step = {
      id: 'q1',
      type: 'multi-select',
      question: 'pick',
      options: ['a', 'b', 'c'],
      min: 2,
    }
    expect(isAnswered(step, ['a'])).toBe(false)
    expect(isAnswered(step, ['a', 'b'])).toBe(true)
  })

  it('requires non-empty trimmed text for short-text', () => {
    const step: Step = { id: 'q1', type: 'short-text', question: 'name' }
    expect(isAnswered(step, '   ')).toBe(false)
    expect(isAnswered(step, 'Bero')).toBe(true)
  })

  it('requires a finite number for number', () => {
    const step: Step = { id: 'q1', type: 'number', question: 'n' }
    expect(isAnswered(step, null)).toBe(false)
    expect(isAnswered(step, Number.NaN)).toBe(false)
    expect(isAnswered(step, 0)).toBe(true)
    expect(isAnswered(step, 42)).toBe(true)
  })

  it('requires rating > 0', () => {
    const step: Step = { id: 'q1', type: 'rating', question: 'r' }
    expect(isAnswered(step, 0)).toBe(false)
    expect(isAnswered(step, 1)).toBe(true)
  })
})

describe('formatAnswers', () => {
  it('returns the raw answer for a single-step submission', () => {
    const steps: Step[] = [{ id: 'q1', type: 'yes-no', question: 'ok?' }]
    expect(formatAnswers(steps, { q1: 'Yes' })).toBe('Yes')
  })

  it('appends /max for rating answers', () => {
    const steps: Step[] = [
      { id: 'q1', type: 'rating', question: 'how was it?', max: 5 },
    ]
    expect(formatAnswers(steps, { q1: 4 })).toBe('4/5')
  })

  it('produces a markdown summary for multi-step submissions', () => {
    const steps: Step[] = [
      { id: 'q1', type: 'short-text', question: 'Name?' },
      { id: 'q2', type: 'yes-no', question: 'Ship it?' },
    ]
    const out = formatAnswers(steps, { q1: 'Bero', q2: 'Yes' })
    expect(out).toContain('**Q1: Name?**')
    expect(out).toContain('A: Bero')
    expect(out).toContain('**Q2: Ship it?**')
    expect(out).toContain('A: Yes')
  })

  it('joins multi-select answers with commas', () => {
    const steps: Step[] = [
      {
        id: 'q1',
        type: 'multi-select',
        question: 'Which?',
        options: ['a', 'b', 'c'],
      },
      { id: 'q2', type: 'short-text', question: 'Note?' },
    ]
    const out = formatAnswers(steps, { q1: ['a', 'c'], q2: 'fine' })
    expect(out).toContain('A: a, c')
  })
})

describe('parseSteps', () => {
  it('errors when raw param is missing', () => {
    const { steps, error } = parseSteps(null)
    expect(steps).toEqual([])
    expect(error).toMatch(/Missing required/)
  })

  it('errors when raw is not valid JSON', () => {
    const { error } = parseSteps('not-json')
    expect(error).toMatch(/not valid JSON/)
  })

  it('errors when a step uses an unknown type', () => {
    const { error } = parseSteps(
      JSON.stringify([{ type: 'fancy', question: 'x' }]),
    )
    expect(error).toMatch(/`type` must be one of/)
  })

  it('errors when single-choice has no options', () => {
    const { error } = parseSteps(
      JSON.stringify([{ type: 'single-choice', question: 'pick' }]),
    )
    expect(error).toMatch(/`options` must be /)
  })

  it('accepts comma-separated options as a string', () => {
    const { steps, error } = parseSteps(
      JSON.stringify([
        {
          type: 'single-choice',
          question: 'Pick a color',
          options: 'red, green, blue',
        },
      ]),
    )
    expect(error).toBeNull()
    expect(steps[0]).toMatchObject({
      type: 'single-choice',
      options: ['red', 'green', 'blue'],
    })
  })

  it('parses a well-formed multi-step payload', () => {
    const { steps, error } = parseSteps(
      JSON.stringify([
        { type: 'short-text', question: 'Name?' },
        {
          type: 'single-choice',
          question: 'Color?',
          options: ['red', 'green'],
        },
        { type: 'yes-no', question: 'Ship?' },
      ]),
    )
    expect(error).toBeNull()
    expect(steps).toHaveLength(3)
    expect(steps[0]).toMatchObject({ type: 'short-text', question: 'Name?' })
    expect(steps[1]).toMatchObject({
      type: 'single-choice',
      options: ['red', 'green'],
    })
    expect(steps[2]).toMatchObject({ type: 'yes-no', question: 'Ship?' })
  })

  it('auto-generates ids for steps that omit them', () => {
    const { steps } = parseSteps(
      JSON.stringify([
        { type: 'short-text', question: 'A?' },
        { type: 'short-text', question: 'B?' },
      ]),
    )
    expect(steps.map((s) => s.id)).toEqual(['q1', 'q2'])
  })
})
