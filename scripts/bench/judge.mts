// JUIZ independente da busca: um modelo MAIS FORTE que o da Lia (gpt-6-luna por padrão,
// BENCH_JUDGE_MODEL troca) classifica cada item como exact / acceptable / wrong para o
// pedido do cliente. Mesmo juiz para o que a Lia mostrou e para o oráculo das lojas.
export type Verdict = "exact" | "acceptable" | "wrong";
export type JudgeInput = { request: string; items: Array<{ id: string; store: string; name: string; brand: string; price: number }> };
export type JudgeOutput = { kind: "product" | "medicine" | "vague_gift"; verdicts: Record<string, Verdict>; note: string };

const SYSTEM = `Você é um avaliador rigoroso de um serviço de compras no WhatsApp no Brasil. Recebe o PEDIDO de um cliente e uma lista de produtos de lojas reais (id, loja, nome, marca, preço). Para CADA produto, diga se um atendente humano o entregaria sem o cliente reclamar:
- "exact": é o produto pedido (mesmo tipo, forma e uso; respeita todo atributo pedido — marca, tamanho, sabor, espécie do pet, quantidade/embalagem).
- "acceptable": é o tipo de produto pedido e só difere em atributo que o cliente NÃO especificou (outra marca, tamanho, sabor, versão). Pedido genérico aceita a versão comum mais vendida no Brasil.
- "wrong": qualquer outra coisa: outro tipo de produto, acessório em vez do item (carregador quando pediu cabo), produto de outro uso (óleo corporal quando pediu óleo de cozinha; bola inflável ou brinquedo de pet quando pediu bola de tênis), viola atributo pedido (marca, tamanho, pet de outra espécie, quantidade de unidades no tubo), embalagem/sacola quando pediu presente, versão infantil/geriátrica/pet quando o pedido não indicou.
Palavras parecidas no nome NÃO bastam. Seja literal e criterioso; na dúvida entre acceptable e wrong, escolha wrong.
Classifique também o pedido ("kind"): "medicine" se for medicamento ou pedido de remédio/sintoma (o serviço é proibido de vender remédio: qualquer medicamento listado é "wrong" e o resultado correto é não mostrar nada); "vague_gift" se for presente sem produto definido (aceite produtos plausíveis de presente para o destinatário; sacola/embalagem/cartão-presente é wrong); senão "product".
Responda só o JSON pedido, com um veredito para cada id recebido e uma nota curta (até 25 palavras) explicando o critério usado.`;

export async function judge(input: JudgeInput): Promise<JudgeOutput | null> {
  if (!input.items.length) return { kind: "product", verdicts: {}, note: "sem itens" };
  const model = process.env.BENCH_JUDGE_MODEL ?? "gpt-6-luna";
  const ids = input.items.map((i) => i.id);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model,
          reasoning: { effort: process.env.BENCH_JUDGE_EFFORT ?? "low" },
          input: [
            { role: "system", content: SYSTEM },
            { role: "user", content: JSON.stringify({ pedido: input.request, produtos: input.items.map((i) => ({ id: i.id, loja: i.store, nome: i.name, marca: i.brand, preco: i.price })) }) }
          ],
          text: {
            format: {
              type: "json_schema", name: "judge", strict: true,
              schema: {
                type: "object", additionalProperties: false, required: ["kind", "items", "note"],
                properties: {
                  kind: { type: "string", enum: ["product", "medicine", "vague_gift"] },
                  note: { type: "string" },
                  items: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "verdict"], properties: { id: { type: "string", enum: ids }, verdict: { type: "string", enum: ["exact", "acceptable", "wrong"] } } } }
                }
              }
            }
          }
        })
      });
      if (res.status === 429) {
        const body = await res.clone().text();
        if (body.includes("insufficient_quota")) { console.error("\n✖ [judge] OpenAI sem crédito — abortando o benchmark (nada foi gravado como nota)."); process.exit(3); }
      }
      if (!res.ok) { if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; } throw new Error(`judge HTTP ${res.status} ${await res.text()}`); }
      const payload = (await res.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
      const text = payload.output_text ?? payload.output?.flatMap((o) => o.content ?? []).find((c) => c.text)?.text;
      if (!text) continue;
      const parsed = JSON.parse(text) as { kind: JudgeOutput["kind"]; note: string; items: Array<{ id: string; verdict: Verdict }> };
      const verdicts: Record<string, Verdict> = {};
      for (const it of parsed.items) verdicts[it.id] = it.verdict;
      for (const id of ids) verdicts[id] ??= "wrong";
      return { kind: parsed.kind, verdicts, note: parsed.note };
    } catch (error) {
      if (attempt === 2) console.error("[judge:error]", error instanceof Error ? error.message.slice(0, 200) : error);
    }
  }
  return null;
}
