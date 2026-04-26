import pg from "pg";

export interface PoolConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  max?: number;
}

export function createPool(config?: PoolConfig): pg.Pool {
  const connectionString =
    config?.connectionString ??
    process.env.DATABASE_URL ??
    buildConnectionString();

  const pool = new pg.Pool({
    connectionString,
    max: config?.max ?? 10,
    ...config,
  });

  // Pin every new session to UTC. TIMESTAMPTZ columns are already stored
  // as UTC instants, but the session TZ governs how psql / TO_CHAR /
  // DATE_TRUNC render and bucket them — so without this, raw SQL output
  // drifts with the host's locale while the JSON API (via toISOString)
  // stays UTC. Making the server side unambiguous as well.
  pool.on("connect", (client) => {
    client.query("SET TIME ZONE 'UTC'").catch(() => { /* best-effort */ });
  });

  return pool;
}

function buildConnectionString(): string {
  const host = process.env.DESK_DB_HOST ?? "/var/run/postgresql";
  const port = process.env.DESK_DB_PORT ?? "5432";
  const database = process.env.DESK_DB_NAME ?? "desk";
  const user = process.env.DESK_DB_USER ?? "desk";
  const password = process.env.DESK_DB_PASSWORD;

  if (password) {
    return `postgresql://${user}:${password}@${host}:${port}/${database}`;
  }
  return `postgresql:///${database}?host=${host}&user=${user}`;
}

export async function withTx<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
