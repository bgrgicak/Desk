// chat-cards doesn't have a useful standalone SPA — fragments are the
// product. This index lists what ships so opening the app root by itself
// isn't a blank page.

const FRAGMENTS: { name: string; description: string }[] = [
  { name: 'grid', description: 'Responsive grid of cards. Good for image-led or browseable result sets.' },
  { name: 'list', description: 'Vertical stack of cards, one per row. Good for text-heavy result lists.' },
]

export default function App() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="mb-2 text-xl font-semibold">chat-cards</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Built-in Desk app. Each fragment below renders as its own iframe when
          attached to a chat message — open the listed paths under{' '}
          <code>/opt/desk-apps/chat-cards.app/dist/fragments/</code> rather
          than this index.
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
