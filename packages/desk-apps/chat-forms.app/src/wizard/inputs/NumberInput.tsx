import { Input } from '@agent-desk/ui'
import type { InputComponentProps, Step } from '../types'

export function NumberInput({
  value,
  onChange,
  disabled,
  step,
}: InputComponentProps<number | null>) {
  const cfg = step as Extract<Step, { type: 'number' }>
  return (
    <Input
      type="number"
      value={value === null || value === undefined ? '' : value}
      min={cfg.min}
      max={cfg.max}
      disabled={disabled}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '') {
          onChange(null)
          return
        }
        const parsed = Number(raw)
        onChange(Number.isFinite(parsed) ? parsed : null)
      }}
      autoFocus
    />
  )
}
