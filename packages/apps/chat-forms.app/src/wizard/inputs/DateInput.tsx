import { Input } from '@roomy-ai/ui'
import type { InputComponentProps } from '../types'

export function DateInput({
  value,
  onChange,
  disabled,
}: InputComponentProps<string>) {
  return (
    <Input
      type="date"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      autoFocus
    />
  )
}
