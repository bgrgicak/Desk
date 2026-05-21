import { Wizard } from '../../src/wizard/Wizard'
import type { Step } from '../../src/wizard/types'
import { readQuestion } from '../../src/wizard/url'

export default function DateFragment() {
  const steps: Step[] = [
    { id: 'q1', type: 'date', question: readQuestion() },
  ]
  return <Wizard steps={steps} />
}
