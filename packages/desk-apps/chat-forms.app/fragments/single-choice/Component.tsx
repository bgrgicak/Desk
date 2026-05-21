import { Wizard } from '../../src/wizard/Wizard'
import type { Step } from '../../src/wizard/types'
import { readOptions, readQuestion } from '../../src/wizard/url'

export default function SingleChoiceFragment() {
  const steps: Step[] = [
    {
      id: 'q1',
      type: 'single-choice',
      question: readQuestion(),
      options: readOptions(),
    },
  ]
  return <Wizard steps={steps} />
}
