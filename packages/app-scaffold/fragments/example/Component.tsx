import { useState } from 'react'
import { Button } from '@agent-desk/ui'

// Single source of truth for the "example" fragment UI. Imported by the
// full app's App.tsx (rendered at /example) and by this fragment's own
// standalone main.tsx (mounted at #root for chat-message embedding).
export default function ExampleFragment() {
  const [count, setCount] = useState(0)
  return (
    <div className="rounded-md border p-4">
      <p className="mb-3 text-sm">
        Example fragment — replace this with the real UI.
      </p>
      <div className="flex items-center gap-2">
        <Button onClick={() => setCount((n) => n + 1)}>
          Clicked {count} times
        </Button>
        <Button variant="outline" onClick={() => setCount(0)}>
          Reset
        </Button>
      </div>
    </div>
  )
}
