import { useMemo, useState } from 'react'
import { Button } from '@agent-desk/ui'
import type { Answer, Answers, Step } from './types'
import { defaultValue, isAnswered } from './validation'
import { formatAnswers } from './format'
import { getChatClient } from '../storage/client'
import { YesNoInput } from './inputs/YesNo'
import { SingleChoiceInput } from './inputs/SingleChoice'
import { MultiSelectInput } from './inputs/MultiSelect'
import { ShortTextInput } from './inputs/ShortText'
import { LongTextInput } from './inputs/LongText'
import { NumberInput } from './inputs/NumberInput'
import { DateInput } from './inputs/DateInput'
import { RatingInput } from './inputs/Rating'

export interface WizardProps {
  steps: Step[]
  /** Override the final-step submit button label. */
  submitLabel?: string
  /**
   * Show the "Step N of M" indicator above the question. Defaults to true.
   * Always hidden for single-step forms regardless of this value.
   */
  showProgress?: boolean
  /**
   * Override the chat-bridge submit. Defaults to
   * `window.desk.chat.sendMessage(text)`.
   */
  onSubmit?: (text: string, answers: Answers) => void | Promise<void>
}

export function Wizard({
  steps,
  submitLabel = 'Submit',
  showProgress = true,
  onSubmit,
}: WizardProps) {
  const initial = useMemo<Answers>(() => {
    const next: Answers = {}
    for (const step of steps) next[step.id] = defaultValue(step)
    return next
  }, [steps])

  const [answers, setAnswers] = useState<Answers>(initial)
  const [current, setCurrent] = useState(0)
  const [submittedText, setSubmittedText] = useState<string | null>(null)

  if (steps.length === 0) {
    return (
      <Shell>
        <p className="text-center text-sm text-muted-foreground">
          No questions provided.
        </p>
      </Shell>
    )
  }

  const step = steps[current]
  const value = answers[step.id]
  const ready = isAnswered(step, value)
  const isFirst = current === 0
  const isLast = current === steps.length - 1
  const disabled = submittedText !== null

  const submit = async (finalAnswers: Answers) => {
    const text = formatAnswers(steps, finalAnswers)
    setSubmittedText(text)
    try {
      if (onSubmit) {
        await onSubmit(text, finalAnswers)
      } else if (typeof window !== 'undefined') {
        await getChatClient().sendMessage(text)
      }
    } catch {
      // Keep submittedText set — UI still shows "Submitted" so the user
      // isn't stuck on an unresponsive form if the bridge fails.
    }
  }

  const advance = (nextAnswers: Answers) => {
    if (isLast) {
      void submit(nextAnswers)
    } else {
      setCurrent((c) => c + 1)
    }
  }

  // Yes/no auto-advances: clicking the answer IS the navigation action.
  const onChangeWithAutoAdvance = (next: Answer) => {
    const nextAnswers = { ...answers, [step.id]: next }
    setAnswers(nextAnswers)
    if (step.type === 'yes-no') advance(nextAnswers)
  }

  // Enter on text-style inputs (short-text/number/date) should advance
  // the wizard, same as clicking Next. We can't rely on the browser's
  // native form implicit-submission here — the wizard runs inside a
  // sandboxed iframe, and Playwright-driven keypresses in that context
  // don't reliably trigger the submit event. So we detect Enter on the
  // form explicitly and route it through `advance`. Textareas
  // (long-text) keep Enter-as-newline because `e.target.tagName` is
  // TEXTAREA — we bail out for those.
  const onFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Enter') return
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
    const target = e.target as HTMLElement | null
    if (target && target.tagName === 'TEXTAREA') return
    e.preventDefault()
    if (ready && !disabled) advance(answers)
  }

  const onFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (ready && !disabled) advance(answers)
  }

  return (
    <Shell onSubmit={onFormSubmit} onKeyDown={onFormKeyDown}>
      {showProgress && steps.length > 1 && (
        <p className="mb-2 text-center text-xs uppercase tracking-wide text-muted-foreground">
          Step {current + 1} of {steps.length}
        </p>
      )}

      <p className="mb-6 text-center text-lg font-medium">
        {step.question || 'No question provided.'}
      </p>

      <div className="mb-6">
        {renderInput(step, value, onChangeWithAutoAdvance, disabled)}
      </div>

      {step.type !== 'yes-no' && (
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isFirst || disabled}
            onClick={() => setCurrent((c) => Math.max(0, c - 1))}
          >
            Back
          </Button>
          <Button
            type="submit"
            variant="default"
            size="sm"
            disabled={!ready || disabled}
          >
            {isLast ? submitLabel : 'Next'}
          </Button>
        </div>
      )}

      {step.type === 'yes-no' && !isFirst && !disabled && (
        <div className="flex justify-start">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCurrent((c) => Math.max(0, c - 1))}
          >
            Back
          </Button>
        </div>
      )}

      {submittedText !== null && (
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Submitted.
        </p>
      )}
    </Shell>
  )
}

function Shell({
  children,
  onSubmit,
  onKeyDown,
}: {
  children: React.ReactNode
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLFormElement>) => void
}) {
  return (
    <div className="p-4">
      <form
        className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm"
        onSubmit={onSubmit}
        onKeyDown={onKeyDown}
        noValidate
      >
        {children}
      </form>
    </div>
  )
}

function renderInput(
  step: Step,
  value: Answer,
  onChange: (next: Answer) => void,
  disabled: boolean,
) {
  switch (step.type) {
    case 'yes-no':
      return (
        <YesNoInput
          step={step}
          value={(value as string | null) || null}
          onChange={(v) => onChange(v)}
          disabled={disabled}
        />
      )
    case 'single-choice':
      return (
        <SingleChoiceInput
          step={step}
          value={(value as string | null) || null}
          onChange={(v) => onChange(v)}
          disabled={disabled}
        />
      )
    case 'multi-select':
      return (
        <MultiSelectInput
          step={step}
          value={(value as string[]) ?? []}
          onChange={(v) => onChange(v)}
          disabled={disabled}
        />
      )
    case 'short-text':
      return (
        <ShortTextInput
          step={step}
          value={(value as string) ?? ''}
          onChange={(v) => onChange(v)}
          disabled={disabled}
        />
      )
    case 'long-text':
      return (
        <LongTextInput
          step={step}
          value={(value as string) ?? ''}
          onChange={(v) => onChange(v)}
          disabled={disabled}
        />
      )
    case 'number':
      return (
        <NumberInput
          step={step}
          value={(value as number | null) ?? null}
          onChange={(v) => onChange(v)}
          disabled={disabled}
        />
      )
    case 'date':
      return (
        <DateInput
          step={step}
          value={(value as string) ?? ''}
          onChange={(v) => onChange(v)}
          disabled={disabled}
        />
      )
    case 'rating':
      return (
        <RatingInput
          step={step}
          value={(value as number | null) ?? null}
          onChange={(v) => onChange(v)}
          disabled={disabled}
        />
      )
  }
}
