import { Wizard } from '../../src/wizard/Wizard'
import type { Step } from '../../src/wizard/types'
import { readNumberParam, readQuestion } from '../../src/wizard/url'

export default function RatingFragment() {
  const steps: Step[] = [
    {
      id: 'q1',
      type: 'rating',
      question: readQuestion(),
      max: readNumberParam('max'),
    },
  ]
  return <Wizard steps={steps} />
}
