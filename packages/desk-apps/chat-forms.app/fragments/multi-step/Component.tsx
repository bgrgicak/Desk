import { useMemo } from 'react'
import { Wizard } from '../../src/wizard/Wizard'
import type { Step } from '../../src/wizard/types'
import { readBooleanParam } from '../../src/wizard/url'
import { parseStepsParam } from './parse'

export default function MultiStepFragment() {
  const { steps, error } = useMemo(() => parseStepsParam(), [])
  const showProgress = useMemo(() => readBooleanParam('showProgress', true), [])

  if (error) {
    return (
      <div className="p-4">
        <div className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
          <p className="mb-2 text-center text-sm font-medium text-destructive">
            multi-step: bad input
          </p>
          <p className="text-center text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    )
  }

  return <Wizard steps={steps as Step[]} showProgress={showProgress} />
}
