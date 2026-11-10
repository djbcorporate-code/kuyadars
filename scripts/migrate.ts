import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
});

const dir = path.join(process.cwd(), "db", "migrations");
const migrations = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();

await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");

for (const name of migrations) {
  const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
  if (applied.rowCount) continue;
  const sql = await readFile(path.join(dir, name), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
    await client.query("COMMIT");
    console.log(`Applied ${name}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

await pool.end();
