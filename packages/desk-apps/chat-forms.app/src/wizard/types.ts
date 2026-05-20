export type Step =
  | { id: string; type: 'yes-no'; question: string }
  | {
      id: string
      type: 'single-choice'
      question: string
      options: string[]
    }
  | {
      id: string
      type: 'multi-select'
      question: string
      options: string[]
      min?: number
      max?: number
    }
  | {
      id: string
      type: 'short-text'
      question: string
      placeholder?: string
    }
  | {
      id: string
      type: 'long-text'
      question: string
      placeholder?: string
    }
  | {
      id: string
      type: 'number'
      question: string
      min?: number
      max?: number
    }
  | { id: string; type: 'date'; question: string }
  | { id: string; type: 'rating'; question: string; max?: number }

export type Answer = string | string[] | number | null

export type Answers = Record<string, Answer>

export interface InputComponentProps<V> {
  value: V
  onChange: (next: V) => void
  disabled?: boolean
  step: Step
}
