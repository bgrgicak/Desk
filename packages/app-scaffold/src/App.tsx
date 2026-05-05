import { Routes, Route, Link } from 'react-router-dom'
import { Button } from '@agent-desk/ui'
import ExampleFragment from '../fragments/example/Component'

export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Desk app</h1>
        <nav className="flex gap-2">
          <Link to="/">
            <Button variant="ghost" size="sm">Home</Button>
          </Link>
          <Link to="/example">
            <Button variant="ghost" size="sm">Example</Button>
          </Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/example" element={<ExampleFragment />} />
        </Routes>
      </main>
    </div>
  )
}

function Home() {
  return (
    <div className="prose">
      <p>
        This is the scaffold for an agent-authored Desk app. Replace this with
        your own surfaces and import each fragment from
        <code> fragments/&lt;name&gt;/Component.tsx</code>.
      </p>
    </div>
  )
}
