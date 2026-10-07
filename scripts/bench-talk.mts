// Conversa roteirizada com a Lia num Postgres embutido próprio (porta 54341) — reproduz um
// defeito achado pelo placar de conversas sem tocar no banco de produção.
//   npx tsx scripts/bench-talk.mts "quero 1 shampoo" "1" "só isso" ...
// Cadastro/endereço entram como mensagens normais (use os do cenário). IA e lojas reais.
import "./talk-env.mts";
process.env.LIA_BENCH_PG_PORT ??= "54341";
process.env.LIA_AUTO_PURCHASE_STORES ??=
  "drogariasp,cobasi,paguemenos,swift,kopenhagen,rihappy,mambo,epocacosmeticos,drogal,casaevideo,obramax,brinox,creamy,telhanorte,zonacriativa,philco,oxford,polishop";

const { startBenchDb } = await import("./bench/db.mts");
const db = await startBenchDb();
try {
  const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
  const { handleDeliveryMessage, runTurnScoped } = await import("../src/lib/delivery-service");
  const phone = "+5500994123456";
  const out: string[] = [];
  (whatsappAdapter as any).sendMessage = async (_to: string, text: string) => { out.push(text); return {}; };
  (whatsappAdapter as any).sendMedia = async (_to: string, text: string) => { out.push(text); return {}; };
  let n = 0;
  for (const text of process.argv.slice(2)) {
    out.length = 0;
    const t0 = Date.now();
    await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `talk_${Date.now()}_${++n}` }));
    console.log(`\n🧑 ${text}`);
    for (const r of out) console.log(`🤖 ${r.split("\n").join("\n   ")}`);
    console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (process.env.BENCH_DUMP_CTX) {
      const { prisma } = await import("../src/lib/prisma");
      const user = await prisma.user.findUnique({ where: { phone } });
      const convo = user ? await prisma.conversation.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } }) : null;
      const c = JSON.parse(convo?.context ?? "{}");
      console.log("   ctx:", JSON.stringify({ step: c.step, pendingRequest: c.pendingRequest, cpfOnboarding: c.cpfOnboarding, lastMiss: c.lastMiss, notFound: c.notFound, pending: c.pending?.map((p: any) => p.query), basket: c.basket?.length }));
    }
  }
} finally {
  await db.stop();
}
process.exit(0);
