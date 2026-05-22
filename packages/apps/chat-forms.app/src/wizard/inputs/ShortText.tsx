import { Input } from '@roomy-ai/ui'
import type { InputComponentProps, Step } from '../types'

export function ShortTextInput({
  value,
  onChange,
  disabled,
  step,
}: InputComponentProps<string>) {
  const placeholder =
    (step as Extract<Step, { type: 'short-text' }>).placeholder ?? ''
  return (
    <Input
      type="text"
      value={value ?? ''}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      autoFocus
    />
  )
}
