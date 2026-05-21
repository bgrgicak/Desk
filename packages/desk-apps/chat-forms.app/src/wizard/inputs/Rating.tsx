import { Button } from '@agent-desk/ui'
import type { InputComponentProps, Step } from '../types'

export function RatingInput({
  value,
  onChange,
  disabled,
  step,
}: InputComponentProps<number | null>) {
  const max = (step as Extract<Step, { type: 'rating' }>).max ?? 5
  const current = typeof value === 'number' ? value : 0

  return (
    <div className="flex justify-center gap-2">
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => {
        const filled = n <= current
        return (
          <Button
            key={n}
            type="button"
            variant="outline"
            size="lg"
            disabled={disabled}
            onClick={() => onChange(n)}
            aria-label={`${n} of ${max}`}
            className="text-2xl"
          >
            <span aria-hidden>{filled ? '★' : '☆'}</span>
          </Button>
        )
      })}
    </div>
  )
}
