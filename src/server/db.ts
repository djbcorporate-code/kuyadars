import pg from "pg";
import type { AppConfig } from "./config.js";

export type Database = pg.Pool;
export type DbClient = pg.PoolClient;

export function createDatabase(config: AppConfig): Database {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
    max: 15,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on("error", (error) => console.error("Unexpected PostgreSQL pool error", error.message));
  return pool;
}

export async function inTransaction<T>(db: Database, work: (client: DbClient) => Promise<T>, isolation = "SERIALIZABLE"): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
