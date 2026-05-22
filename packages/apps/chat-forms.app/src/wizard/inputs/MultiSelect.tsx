import { Checkbox } from '@roomy-ai/ui'
import type { InputComponentProps, Step } from '../types'

export function MultiSelectInput({
  value,
  onChange,
  disabled,
  step,
}: InputComponentProps<string[]>) {
  const options = (step as Extract<Step, { type: 'multi-select' }>).options ?? []
  const selected = new Set(value ?? [])

  const toggle = (option: string) => {
    const next = new Set(selected)
    if (next.has(option)) next.delete(option)
    else next.add(option)
    onChange(options.filter((o) => next.has(o)))
  }

  return (
    <div className="flex flex-col gap-3">
      {options.map((option, idx) => {
        const id = `${step.id}-opt-${idx}`
        return (
          <label
            key={id}
            htmlFor={id}
            className="flex cursor-pointer items-center gap-3 rounded-md border p-3 hover:bg-accent"
          >
            <Checkbox
              id={id}
              checked={selected.has(option)}
              disabled={disabled}
              onCheckedChange={() => toggle(option)}
            />
            <span>{option}</span>
          </label>
        )
      })}
    </div>
  )
}
