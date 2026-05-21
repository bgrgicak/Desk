import { Wizard } from '../../src/wizard/Wizard'
import type { Step } from '../../src/wizard/types'
import { readQuestion } from '../../src/wizard/url'

export default function YesNoFragment() {
  const steps: Step[] = [
    { id: 'q1', type: 'yes-no', question: readQuestion() },
  ]
  return <Wizard steps={steps} />
}
