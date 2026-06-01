import { Card } from '../../src/cards/Card'
import { readItems, readTitle } from '../../src/cards/parseItems'

export default function GridFragment() {
  const items = readItems()
  const title = readTitle()

  if (items.length === 0) {
    return (
      <div className="p-4">
        <p className="text-sm text-muted-foreground">
          No items provided. Pass a non-empty JSON array via{' '}
          <code>--param items=…</code>.
        </p>
      </div>
    )
  }

  return (
    <div className="p-4">
      {title && (
        <h2 className="mb-3 text-base font-semibold leading-snug">{title}</h2>
      )}
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns:
            'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))',
        }}
      >
        {items.map((item, i) => (
          <Card key={i} item={item} />
        ))}
      </div>
    </div>
  )
}
