import pg from "pg";

export interface SearchResult {
  type: "file" | "chat" | "message";
  id: string;
  title: string;
  snippet?: string;
}

export async function search(
  pool: pg.Pool,
  query: string,
  scope: "artifacts" | "chats" | "library" | "all" = "all",
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const pattern = `%${query}%`;

  if (scope === "all" || scope === "artifacts" || scope === "library") {
    const classFilter = scope === "library" ? "AND class = 'library'" : scope === "artifacts" ? "AND class = 'artifact'" : "";
    const { rows } = await pool.query(
      `SELECT id, name, class FROM files WHERE name ILIKE $1 ${classFilter} ORDER BY created_at DESC LIMIT 20`,
      [pattern],
    );
    for (const row of rows) {
      results.push({ type: "file", id: row.id as string, title: row.name as string });
    }
  }

  if (scope === "all" || scope === "chats") {
    const { rows } = await pool.query(
      `SELECT id, title FROM chats WHERE title ILIKE $1 ORDER BY updated_at DESC LIMIT 20`,
      [pattern],
    );
    for (const row of rows) {
      results.push({ type: "chat", id: row.id as string, title: row.title as string });
    }
  }

  return results;
}
