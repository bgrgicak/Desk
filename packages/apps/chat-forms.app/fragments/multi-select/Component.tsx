import { Wizard } from '../../src/wizard/Wizard'
import type { Step } from '../../src/wizard/types'
import {
  readNumberParam,
  readOptions,
  readQuestion,
} from '../../src/wizard/url'

export default function MultiSelectFragment() {
  const steps: Step[] = [
    {
      id: 'q1',
      type: 'multi-select',
      question: readQuestion(),
      options: readOptions(),
      min: readNumberParam('min'),
      max: readNumberParam('max'),
    },
  ]
  return <Wizard steps={steps} />
}
