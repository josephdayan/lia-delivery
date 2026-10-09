// Sobe o Postgres local embutido (o mesmo do test:local) e deixa rodando para o talk-prod.mts.
// Uso: npx tsx scripts/local-pg.mts   (Ctrl+C para parar). Banco: lia_talk, migrado na subida.
import EmbeddedPostgres from "embedded-postgres";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.LIA_LOCAL_PG_PORT ?? 54329);
const DIR = join(process.cwd(), ".local-pg", "data");
const DB = process.env.LIA_LOCAL_PG_DB ?? "lia_talk";
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB}?schema=public`;
const pg = new EmbeddedPostgres({ databaseDir: DIR, user: "postgres", password: "postgres", port: PORT, persistent: true });
if (!existsSync(join(DIR, "PG_VERSION"))) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase(DB);
} catch {
  /* já existe */
}
const env = { ...process.env, DATABASE_URL: URL, DIRECT_URL: URL };
if (spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", env }).status !== 0) throw new Error("migrate falhou");
console.log(`[local-pg] pronto: ${URL}`);
const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => undefined, 1 << 30);
