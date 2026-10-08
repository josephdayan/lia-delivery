// Postgres embutido PRÓPRIO dos benchmarks (porta 54339, pasta .local-pg-bench/): nunca o
// banco de produção e nunca o do `npm run test:local` (porta 54329). Chame startBenchDb()
// ANTES de importar qualquer módulo que carregue o prisma (use import() dinâmico depois).
import EmbeddedPostgres from "embedded-postgres";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.LIA_BENCH_PG_PORT ?? 54339);
const DIR = join(process.cwd(), ".local-pg-bench", `data-${PORT}`);
const DB = "lia_bench";
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB}?schema=public`;

export async function startBenchDb() {
  // BENCH_DATABASE_URL (08/10): Postgres local já de pé (o embutido falha onde falta libicu). Só 127.0.0.1/localhost.
  const external = process.env.BENCH_DATABASE_URL;
  if (external) {
    if (!/@(127\.0\.0\.1|localhost)[:/]/.test(external)) throw new Error("BENCH_DATABASE_URL precisa ser um Postgres local (127.0.0.1/localhost).");
    const env = { ...process.env, DATABASE_URL: external, DIRECT_URL: external };
    const migrated = spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: "ignore", env });
    if (migrated.status !== 0) throw new Error("migrate deploy falhou no banco do benchmark");
    process.env.DATABASE_URL = external;
    process.env.DIRECT_URL = external;
    return { url: external, stop: async () => {} };
  }
  const pg = new EmbeddedPostgres({ databaseDir: DIR, user: "postgres", password: "postgres", port: PORT, persistent: true });
  if (!existsSync(join(DIR, "PG_VERSION"))) await pg.initialise();
  await pg.start();
  try { await pg.dropDatabase(DB); } catch { /* não existia */ }
  await pg.createDatabase(DB);
  const env = { ...process.env, DATABASE_URL: URL, DIRECT_URL: URL };
  const migrated = spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: "ignore", env });
  if (migrated.status !== 0) throw new Error("migrate deploy falhou no banco do benchmark");
  process.env.DATABASE_URL = URL;
  process.env.DIRECT_URL = URL;
  return { url: URL, stop: () => pg.stop() };
}
