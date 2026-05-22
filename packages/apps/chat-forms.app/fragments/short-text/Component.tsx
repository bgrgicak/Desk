import { Wizard } from '../../src/wizard/Wizard'
import type { Step } from '../../src/wizard/types'
import { readQuestion, readStringParam } from '../../src/wizard/url'

export default function ShortTextFragment() {
  const steps: Step[] = [
    {
      id: 'q1',
      type: 'short-text',
      question: readQuestion(),
      placeholder: readStringParam('placeholder'),
    },
  ]
  return <Wizard steps={steps} />
}
