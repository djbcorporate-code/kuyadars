import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";

const config = loadConfig();
const database = createDatabase(config);
const app = createApp(database, config);

const server = app.listen(config.PORT, () => {
  console.log(`Kuya Dars API listening on http://localhost:${config.PORT}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received; closing server.`);
  server.close(async () => {
    await database.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
