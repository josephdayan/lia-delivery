# evals/ — placar de verdade da Lia (07/10/2026)

Por que existe: as rodadas de teste de agosto–outubro mediam travas e frases, não o que o cliente
sente. Aqui se mede **produto certo, honestidade quando não existe, conversa que fecha e tempo**,
contra a **loja de verdade** e com um **juiz mais forte** que a IA da Lia. Toda mudança de busca ou
conversa precisa subir o placar antes de entrar. Nada aqui cobra, envia mensagem real ou toca o banco
de produção (Postgres embutido próprio, porta 54339/54340, pasta `.local-pg-bench/`).

## Placar da busca — `scripts/bench-search.mts`
- Entrada: `evals/search-requests.json` (316 pedidos: ~45 vindos de clientes/testadores reais,
  o resto do dia a dia por categoria; **o gabarito não é escrito à mão**).
- Sistema testado: `searchOptionsForPlanB` (extração → candidatos → checagem ao vivo no CEP → rerank),
  o mesmo caminho da produção, no CEP do `.retail-buyer/config.json` (ou `BENCH_CEP`).
- Oráculo: busca inteligente ao vivo de cada loja da vitrine (seller "1", com estoque) →
  `scripts/bench/oracle.mts`. Juiz: `gpt-6-luna` com raciocínio baixo (`BENCH_JUDGE_MODEL`, `BENCH_JUDGE_EFFORT`) dá exact/acceptable/wrong para o
  que a Lia mostrou e para o que as lojas têm (`scripts/bench/judge.mts`).
- Números: **top1WrongRate** (1ª opção errada — o erro que o cliente vê), **precisionItems**,
  **coverage** (achou quando existe), **honesty** (disse que não tem quando não existe),
  **medicineLeaks** (remédio mostrado) e latência.
- Pedido com falha da IA da Lia (429/timeout) vira `ia_indisponivel` e fica FORA da conta.

```bash
npx tsx scripts/bench-search.mts --label antes [--limit 40] [--cat mercado] [--concurrency 3]
LIA_LIVE_SEARCH=true npx tsx scripts/bench-search.mts --label depois-busca-ao-vivo
```

## Placar de conversas — `scripts/bench-conversations.mts`
40 cenários (`evals/conversation-scenarios.json`) nascidos de conversas reais e reclamações dos
testadores. Um cliente simulado (gpt-6-luna) conversa com a Lia de verdade até o Pix aparecer (nunca paga);
o juiz lê a transcrição: objetivo cumprido, produto errado, promessa falsa, beco sem saída, confuso,
lento. `npx tsx scripts/bench-conversations.mts --label antes [--only c01,c02] [--verbose]`.

## Regras
- Resultados em `evals/results/*.json` (compare antes × depois). Caches de rede em `evals/cache/` (ignorado).
- Os dois scripts abortam antes de começar se a chave da OpenAI estiver sem crédito.
- Limites honestos: o oráculo vê o top-8 da busca de cada loja (não o catálogo inteiro); o corpus
  sintético foi escrito por IA/humano, mas só o *pedido* — o gabarito vem da loja e do juiz;
  `AUTO_ROSTER` (lojas da vitrine) é o palpite do golden porque a lista real da Vercel é sensível.
- `evals/results/search-2026-10-07-parcial-sem-credito.json`: 1ª rodada, **parcial** — o crédito da
  OpenAI acabou no meio (≈ 60 pedidos com a IA da Lia em fallback e 45 sem nota do juiz). Serve para
  ler os defeitos qualitativos, **não** como linha de base numérica.

## Custo (preços por 1M tokens, 07/10)
Tudo em `gpt-6-luna` (US$0,10 entrada / US$0,50 saída; o gpt-5.4-mini custava 0,75 / 4,50 = 7,5–9× mais; o gpt-5.5 do
1º run, 5 / 30 = 50–60× mais). Rodada completa dos dois placares ≈ US$1. Ressalva: com o juiz e a Lia no mesmo
modelo o juiz deixa de ser "mais forte que a Lia"; para auditoria rigorosa use `BENCH_JUDGE_MODEL=gpt-6-sol`.
