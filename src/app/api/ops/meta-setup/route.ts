import { NextResponse } from "next/server";
import { requireOpsOwner } from "@/lib/auth";
import { runMetaSetup, type MetaSetupAction } from "@/lib/meta-setup";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Configuração do número na Meta (perfil, boas-vindas, Flow de endereço) executada de
// dentro da Vercel, onde o token vive. Só com a sessão do /ops (mesma guarda das outras
// rotas de operação). GET = status (leitura); POST { action } = grava.
const ACTIONS: MetaSetupAction[] = ["status", "name", "register", "profile", "picture", "welcome", "flow", "flow_update", "flow_errors", "flow_signup", "flow_list", "carousel", "templates", "carousel_test"];

// GET sem `action` = status. GET ?action=profile|picture|flow|welcome executa a ação —
// estado por GET de propósito: o operador (ou o Codex) roda tudo abrindo URLs no navegador
// logado no /ops, sem precisar de JS/POST. Idempotente; auth igual às outras rotas.
export async function GET(request: Request) {
  const unauthorized = requireOpsOwner(request, { allowQuery: true });
  if (unauthorized) return unauthorized;
  const requested = new URL(request.url).searchParams.get("action") ?? "status";
  if (!ACTIONS.includes(requested as MetaSetupAction)) return NextResponse.json({ error: "unknown action" }, { status: 400 });
  const action = requested as MetaSetupAction;
  // PIN do número não pode ir em URL (fica no log de acesso): register só por POST.
  if (action === "register") return NextResponse.json({ error: "register só por POST com { pin }" }, { status: 405 });
  const flowId = new URL(request.url).searchParams.get("flow_id") ?? undefined;
  try {
    const result = await runMetaSetup(action, { flowId });
    if (action !== "status" && action !== "name") console.log("[ops:meta-setup]", action, JSON.stringify(result).slice(0, 300));
    return NextResponse.json({ ok: true, action, result });
  } catch (error) {
    console.error("[ops:meta-setup:error]", action, error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, action, error: error instanceof Error ? error.message.slice(0, 600) : "failed" }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const unauthorized = requireOpsOwner(request, { allowQuery: true });
  if (unauthorized) return unauthorized;
  const body = (await request.json().catch(() => ({}))) as { action?: string; flow_id?: string; pin?: string };
  const action = body.action as MetaSetupAction | undefined;
  if (!action || !ACTIONS.includes(action)) return NextResponse.json({ error: "unknown action" }, { status: 400 });
  try {
    const result = await runMetaSetup(action, { flowId: body.flow_id, pin: body.pin });
    console.log("[ops:meta-setup]", action, JSON.stringify(result).slice(0, 300));
    return NextResponse.json({ ok: true, action, result });
  } catch (error) {
    console.error("[ops:meta-setup:error]", action, error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, action, error: error instanceof Error ? error.message.slice(0, 600) : "failed" }, { status: 502 });
  }
}
