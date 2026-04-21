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

  return new pg.Pool({
    connectionString,
    max: config?.max ?? 10,
    ...config,
  });
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
