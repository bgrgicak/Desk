import { useState } from "react";
import { api } from "../api";
import type { Route } from "../app";

interface SearchResult {
  type: string;
  id: string;
  title?: string;
  name?: string;
  snippet?: string;
}

function routeToHref(route: Route): string {
  switch (route.page) {
    case "chat": return `/chat/${route.id}`;
    case "library-item": return `/library/${route.id}`;
    default: return "#";
  }
}

export function Search({ nav }: { nav: (r: Route) => void }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searched, setSearched] = useState(false);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const { data } = await api<SearchResult[]>(
      `/search?q=${encodeURIComponent(query)}&scope=${scope}`,
    );
    setResults(Array.isArray(data) ? data : []);
    setSearched(true);
  }

  function linkFor(r: SearchResult): Route | null {
    if (r.type === "chat") return { page: "chat", id: r.id };
    if (r.type === "artifact") return { page: "library-item", id: r.id };
    if (r.type === "library") return { page: "library-item", id: r.id };
    return null;
  }

  return (
    <div>
      <h2>Search</h2>
      <form onSubmit={handleSearch}>
        <label>
          Query
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={'e.g. "meeting notes", "budget spreadsheet"'} required />
        </label>
        <label>
          Scope
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">All</option>
            <option value="artifacts">Artifacts</option>
            <option value="chats">Chats</option>
            <option value="library">Library</option>
          </select>
        </label>
        <button type="submit">Submit search</button>
      </form>

      {searched && results.length === 0 && <p>No results.</p>}
      <ul>
        {results.map((r, i) => {
          const route = linkFor(r);
          return (
            <li key={i}>
              [{r.type}]{" "}
              {route ? (
                <a href={routeToHref(route)} onClick={(e) => { e.preventDefault(); nav(route); }}>
                  {r.title ?? r.name ?? r.id}
                </a>
              ) : (
                r.title ?? r.name ?? r.id
              )}
              {r.snippet && <> — {r.snippet}</>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
