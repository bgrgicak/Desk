import { Textarea } from '@agent-desk/ui'
import type { InputComponentProps, Step } from '../types'

export function LongTextInput({
  value,
  onChange,
  disabled,
  step,
}: InputComponentProps<string>) {
  const placeholder =
    (step as Extract<Step, { type: 'long-text' }>).placeholder ?? ''
  return (
    <Textarea
      value={value ?? ''}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      rows={6}
      autoFocus
    />
  )
}
