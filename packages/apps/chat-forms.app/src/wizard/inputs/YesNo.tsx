import { Button } from '@roomy-ai/ui'
import type { InputComponentProps } from '../types'

export function YesNoInput({
  value,
  onChange,
  disabled,
}: InputComponentProps<string | null>) {
  return (
    <div className="flex justify-center gap-4">
      <Button
        type="button"
        variant={value === 'Yes' ? 'default' : 'outline'}
        size="lg"
        disabled={disabled}
        onClick={() => onChange('Yes')}
      >
        Yes
      </Button>
      <Button
        type="button"
        variant={value === 'No' ? 'default' : 'outline'}
        size="lg"
        disabled={disabled}
        onClick={() => onChange('No')}
      >
        No
      </Button>
    </div>
  )
}
