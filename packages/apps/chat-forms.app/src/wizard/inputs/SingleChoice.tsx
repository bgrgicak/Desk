import { RadioGroup, RadioGroupItem } from '@roomy-ai/ui'
import type { InputComponentProps, Step } from '../types'

export function SingleChoiceInput({
  value,
  onChange,
  disabled,
  step,
}: InputComponentProps<string | null>) {
  const options = (step as Extract<Step, { type: 'single-choice' }>).options ?? []
  return (
    <RadioGroup
      value={value ?? ''}
      onValueChange={(next: string) => onChange(next)}
      disabled={disabled}
      className="flex flex-col gap-3"
    >
      {options.map((option, idx) => {
        const id = `${step.id}-opt-${idx}`
        return (
          <label
            key={id}
            htmlFor={id}
            className="flex cursor-pointer items-center gap-3 rounded-md border p-3 hover:bg-accent"
          >
            <RadioGroupItem id={id} value={option} />
            <span>{option}</span>
          </label>
        )
      })}
    </RadioGroup>
  )
}
