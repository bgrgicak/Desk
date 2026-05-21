import { Wizard } from '../../src/wizard/Wizard'
import type { Step } from '../../src/wizard/types'
import { readNumberParam, readQuestion } from '../../src/wizard/url'

export default function NumberFragment() {
  const steps: Step[] = [
    {
      id: 'q1',
      type: 'number',
      question: readQuestion(),
      min: readNumberParam('min'),
      max: readNumberParam('max'),
    },
  ]
  return <Wizard steps={steps} />
}
