// chat-forms doesn't have a useful standalone SPA — fragments are the
// product. This index just lists what ships, so opening the app root by
// itself isn't a blank page.

const FRAGMENTS: { name: string; description: string }[] = [
  { name: 'yes-no', description: 'Binary yes/no question.' },
  { name: 'single-choice', description: 'Pick one of N options.' },
  { name: 'multi-select', description: 'Select any subset of N options.' },
  { name: 'short-text', description: 'Single-line free-text answer.' },
  { name: 'long-text', description: 'Paragraph-length free-text answer.' },
  { name: 'number', description: 'Numeric answer.' },
  { name: 'date', description: 'Calendar date answer.' },
  { name: 'rating', description: '1..N star rating.' },
  {
    name: 'multi-step',
    description: 'Wizard that combines several questions into one chat turn.',
  },
]

export default function App() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="mb-2 text-xl font-semibold">chat-forms</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Built-in Desk app. Each fragment below renders as its own iframe when
          attached to a chat message — open the listed paths under{' '}
          <code>/opt/desk-apps/chat-forms.app/dist/fragments/</code> rather than
          this index.
        </p>

        <ul className="flex flex-col gap-2">
          {FRAGMENTS.map((f) => (
            <li key={f.name} className="rounded-md border p-3">
              <div className="text-sm font-medium">{f.name}</div>
              <div className="text-sm text-muted-foreground">
                {f.description}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
