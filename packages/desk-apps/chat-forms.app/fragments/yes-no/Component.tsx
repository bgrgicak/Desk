import { useState } from 'react'
import { Button } from '@agent-desk/ui'
import { getChatClient } from '../../src/storage/client'

function getQuestion(): string {
  const params = new URLSearchParams(window.location.search)
  return params.get('question') ?? ''
}

export default function YesNoFragment() {
  const question = getQuestion()
  const [submitted, setSubmitted] = useState<string | null>(null)

  const handleAnswer = async (answer: 'Yes' | 'No') => {
    try {
      await getChatClient().sendMessage(answer)
      setSubmitted(answer)
    } catch {
      // If sendMessage fails (e.g. no chat context), still show submitted
      setSubmitted(answer)
    }
  }

  const displayQuestion = question || 'No question provided.'

  return (
    <div className="flex min-h-[200px] items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
        <p className="mb-6 text-center text-lg font-medium">
          {displayQuestion}
        </p>

        <div className="flex justify-center gap-4">
          <Button
            variant="default"
            size="lg"
            disabled={submitted !== null}
            onClick={() => handleAnswer('Yes')}
          >
            Yes
          </Button>
          <Button
            variant="outline"
            size="lg"
            disabled={submitted !== null}
            onClick={() => handleAnswer('No')}
          >
            No
          </Button>
        </div>

        {submitted && (
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Submitted: {submitted}
          </p>
        )}
      </div>
    </div>
  )
}
