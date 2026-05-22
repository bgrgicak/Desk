import { Routes, Route, Link } from 'react-router-dom'
import { Button } from '@roomy-ai/ui'
import ExampleFragment from '../fragments/example/Component'

export default function App() {
  return (
    <div className="flex flex-col bg-background text-foreground">
      <header className="flex items-center justify-between p-6 pb-4">
        <h1 className="text-xl font-semibold">Roomy app</h1>
        <nav className="flex gap-2">
          <Link to="/">
            <Button variant="ghost" size="sm">Home</Button>
          </Link>
          <Link to="/example">
            <Button variant="ghost" size="sm">Example</Button>
          </Link>
        </nav>
      </header>
      <main className="px-6 pb-6">
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
        This is the scaffold for an agent-authored Roomy app. Replace this with
        your own surfaces and import each fragment from
        <code> fragments/&lt;name&gt;/Component.tsx</code>.
      </p>
    </div>
  )
}
