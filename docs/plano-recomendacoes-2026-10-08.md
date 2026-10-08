# Plano: a Lia recomenda (intenção/ocasião → produtos concretos)

_Escrito em 08/10/2026 a pedido do dono ("se eu falar tô com muita fome, quero algo doce, ela
sabe me dar algo doce?"). Plano de implementação; nada construído ainda. Decisão de ligar é do
dono (§7)._

## 0. Resposta curta: o que acontece HOJE com "tô com muita fome, quero algo doce"

Testado offline em 08/10 (`detectIntent` + ranking do catálogo, sem IA):

| Mensagem | Caminho hoje | O que o cliente vê |
|---|---|---|
| "tô com muita fome, quero algo doce" | `free_text` → gerente de diálogo (IA) | Depende da IA: ou `unclear` ("o que você quer?"), ou `search "doce"` |
| "quero algo doce" | idem | idem |
| "algo gostoso pra comer" | `vague_request` (regex) | Texto fixo: "Me diz o que você está com vontade… lasanha, pizza, chocolate…" |
| "me indica um presente pra minha mãe" | busca | `giftSearchPhrase` colapsa em **uma** consulta ("perfume feminino") |
| "o que tem de bom pra jantar hoje?" | `free_text` → IA | provavelmente `unclear` |

Se a IA decide `search "doce"`, o ranking léxico devolve **uva doce, batata doce e doce de leite**
(testado em Mambo e Prezunic) — a palavra "doce" casa com nome de produto, não com a vontade. O
rerank da IA depois julga "tipo certo" contra a palavra "doce" e tende a aprovar doce de leite.
Ou seja: **hoje a Lia não recomenda**. Ela ou pergunta de volta, ou busca a palavra literalmente.
Única exceção: presente sem produto, que vira uma categoria fixa (perfume/brinquedo), sem
variedade e sem pergunta.

Sobre a pergunta geral ("ela sabe analisar perguntas genéricas e sugerir mesmo que não esteja no
nome do produto?"): **não**. Toda a inteligência atual é "o cliente nomeou um produto → ache o
produto certo" (extração → candidatos → estoque no CEP → rerank). Falta a camada de cima:
"o cliente nomeou uma vontade/ocasião → quais produtos concretos resolvem isso".

## 1. O que a recomendação precisa ser (princípios)

1. **Recomendar = traduzir a vontade em 3–4 produtos concretos e compráveis agora**, não dar
   conselho. "Algo doce" vira cards de chocolate, sorvete, bolo, biscoito recheado — com preço,
   loja, prazo e botão de escolher. Conselho sem produto é o "conselheiro neutro" que o
   CLAUDE.md já descartou.
2. **Nunca inventar.** A IA só escolhe **o que buscar**; quem decide **o que mostrar** continua
   sendo o funil de verdade (catálogo + busca ao vivo da loja → estoque no CEP → rerank). Mesma
   regra do rerank de hoje: sku que não veio dos candidatos não existe.
3. **Variedade, não variantes.** 4 cards de 4 tipos diferentes (chocolate, sorvete, bolo,
   biscoito), não 4 chocolates. A diversificação de hoje (`sameProductVariant`) age dentro de um
   produto; a recomendação precisa agir entre produtos.
4. **Uma pergunta só quando a resposta muda tudo.** "Presente pra quem?" muda a categoria
   inteira; "chocolate ao leite ou amargo?" não. Na dúvida, mostra e deixa refinar ("sem
   chocolate", "mais barato", "outras").
5. **Honesta com o prazo.** "Tô com muita fome" quer dizer agora; a Lia entrega no prazo da loja
   (horas, às vezes amanhã). A copy diz o prazo no card como hoje e nunca promete "mata a fome
   já" — isso é iFood, não Lia.
6. **Só o que a Lia compra sozinha.** Candidatos de lojas da compra automática (`VTEX_API_STORES`)
   com estoque no CEP. Remédio nunca entra por recomendação (sintoma → remédio é decisão
   pendente do dono, fora deste plano).
7. **Placar antes de ligar.** Regra do projeto (evals/README.md): mudança de conversa só entra se
   subir o placar. Recomendação ganha placar próprio (§5).

## 2. Arquitetura: três camadas, uma por fase

### Camada 1 — intenção → consultas concretas (a que resolve "algo doce")

```
"tô com fome, quero algo doce"
  → gerente de diálogo: ação nova  recommend {need:"algo doce", occasion:"lanche", constraints:[]}
  → expandRecommendation(need, perfil, hora)  [IA, JSON estrito, gpt-6-luna, timeout 6 s]
      = 5–6 consultas concretas + motivo curto:
        [{query:"chocolate ao leite", why:"clássico"}, {query:"sorvete pote", …},
         {query:"bolo pronto", …}, {query:"biscoito recheado", …}, {query:"brigadeiro", …}]
      fallback sem IA: tabela curada por intenção (doce, salgado, gelado, jantar rápido,
        café da manhã, churrasco, presente mãe/pai/criança, ressaca, festa infantil, pet novo)
  → cada consulta roda no funil de hoje, em paralelo (como a lista de 4 itens já roda):
        candidatos cross-store → checagem ao vivo no CEP → rerank
  → 1 opção por consulta (a melhor), até 4 cards; consulta sem produto comprável é pulada
  → copy: "Pra matar a vontade de doce, achei isso 🍫" + cards (ou tela de lista)
  → escolha/refino/"outras" reusam pick / refine / more_options
```

**Onde mexe (arquivos):**

| Peça | Arquivo | Mudança |
|---|---|---|
| Ação `recommend` | `src/lib/dialogue/types.ts`, `model.ts` (prompt + schema), `plan.ts`, `execute.ts` | Nova ação com `need`, `occasion`, `constraints`; regra no prompt: vontade/ocasião **sem produto nomeado** = `recommend`, nunca `search` da frase nem `unclear`. Exemplo fixo: "algo salgado, tipo um hambúrguer" continua `search "hambúrguer"` (tem exemplo concreto). |
| Pré-cadastro | `src/lib/dialogue/presignup.ts` | `vague` deixa de ser texto fixo: vira `recommend` depois do CEP (o funil precisa do CEP pro estoque), guardando o pedido bruto como hoje guarda `items`. |
| Regex de hoje | `src/lib/lia-intents.ts` | `VAGUE_REQUEST_RE` e `isVagueWant` passam a devolver `{kind:"recommend", need}` em vez de `vague_request`; ampliar pra "algo doce/salgado/gelado/leve/quente", "o que tem de bom pra X", "me indica/sugere/recomenda". Caminho sem IA continua funcionando. |
| Expansão | `src/lib/recommend.ts` (novo, puro, testado) + `src/lib/adapters/ai.ts` | `expandRecommendation()` com prompt próprio e schema estrito; `RECOMMEND_TABLE` curada como fallback e como gabarito; `pickDiverse()` escolhe 1 por consulta. Generaliza `giftSearchPhrase` (presente vira 3–4 consultas: perfume, chocolate, flores, kit banho — não só perfume). |
| Execução | `src/lib/delivery-service.ts` | `handleRecommend()` que reusa `buildChoices` por linha (o mesmo caminho da lista de N itens) e monta **uma** escolha com `PendingChoice.recommendation = {need, queries, shownQueries}`. "Outras" = próximo lote de consultas (não mais variantes das mesmas); refine ("sem chocolate") filtra as consultas e refaz. |
| Copy | `src/lib/lia-copy.ts` | `recommendIntro(need)`, `recommendNone(need)` ("não achei nada doce com entrega no seu CEP hoje; quer que eu procure X?"), `recommendAsk(question)` (só as perguntas da lista fechada, §3). |
| Vitrine | `src/lib/list-flow.ts` / cards | 4 cards (hoje 3): confirmar com o dono; a tela de lista já aceita 4 por item. |
| Flag | `LIA_RECOMMEND=true` | Desligada = comportamento de hoje. |

**Contexto que a expansão recebe:** a frase, a hora do dia (café/almoço/jantar/madrugada), o
perfil leve do cliente quando existir (§camada 2) e o que já está na cesta (não recomendar
chocolate pra quem acabou de pôr chocolate). Nada de preço nem prazo: isso vem do funil.

**Latência e custo:** 1 chamada de IA a mais (~1–2 s, luna) + 5–6 buscas em paralelo, que é o
que uma lista de 5 itens já custa hoje. Hedge da chamada como o rerank faz. Custo por
recomendação ≈ o de uma lista.

### Camada 2 — pergunta única e memória do cliente

- **Pergunta única (lista fechada):** só quando a resposta troca a categoria inteira.
  Presente: "pra quem?" (se não disse). Pet: "cachorro ou gato?" (se não disse e não há
  perfil). Refeição pra grupo: "pra quantas pessoas?". Nada mais. A expansão devolve
  `ask?: "gift_recipient" | "pet_species" | "headcount"`; o código só aceita essas chaves e
  manda a copy fixa; a resposta volta pelo gerente de diálogo como `recommend` enriquecido.
  Teste: pedido com a informação já na frase **nunca** pergunta.
- **Memória leve (`User.preferences` Json, migration pequena):** restrições ditas pelo cliente
  ("sou diabético", "sem lactose", "vegano"), pet (espécie/porte), pessoas na casa, marcas que ele
  escolheu 2+ vezes, categorias dos últimos pedidos pagos. Fonte: o que ele **disse** + pedidos
  pagos. Nunca inferir saúde; só registrar o que ele falou, com a data. Entra no prompt da
  expansão e no ranking ("o de sempre" já existe via `preferredSkus`: estender pra "a marca de
  sempre" na categoria).
- **Copy de memória:** "Da última vez você levou Lacta; pus ela primeiro" — só quando for verdade.

### Camada 3 — recomendação proativa (depois de dado real)

- **Complemento no fechamento:** ao `close_list`, no máximo **1** sugestão ("quem leva carvão
  costuma levar pão de alho; quer?"), vinda de co-ocorrência nos pedidos pagos (quando houver
  volume) ou da tabela curada. Desligável, e some depois de 1 "não".
- **Reposição:** "faz 30 dias da ração; quer repetir?" — só com template aprovado pela Meta
  (mensagem fora da janela de 24 h) e opt-in. Fica como ideia; não entra sem decisão do dono.

## 3. Regras de comportamento (pra copy e testes)

1. Vontade sem produto → recomenda; vontade com exemplo concreto → busca o exemplo (regra 6 do
   gerente, mantida). "Algo doce tipo um chocolate" = busca chocolate.
2. Nunca mais de 1 pergunta antes de mostrar produto. Depois dos cards, refino livre.
3. 4 cards = 4 tipos. Variante só entra quando o cliente refina ("mais chocolate").
4. Sem nada comprável no CEP: diz isso e oferece o tipo mais perto que exista ("hoje não tenho
   sorvete com entrega aí; tem chocolate e biscoito, quer ver?"). Nunca "não achei doce".
5. Remédio nunca por recomendação; "algo pra dor" segue a regra de sintoma (decisão pendente).
6. Cesta cheia de X → não recomenda X.
7. A IA sugere consultas; o card só sai se o funil confirmou estoque e entrega no CEP.
8. Cada recomendação grava `SearchMiss`-equivalente (`RecommendLog`: need, consultas, o que
   saiu, o que o cliente escolheu) → `/ops` mostra o que as pessoas pedem de forma vaga e o que
   converte. É o dado que alimenta a camada 3 e a tabela curada.

## 4. Fases e estimativa

| Fase | Entrega | Esforço |
|---|---|---|
| **1** | Ação `recommend` + expansão (IA + tabela) + execução reusando o funil + copy + flag + placar de pedidos vagos + tabela-ouro | ~1 dia |
| **2** | Pergunta única (3 chaves) + `User.preferences` + memória na expansão e no ranking + cenários de conversa | ~1 dia |
| **3** | Complemento no fechamento + `/ops` de recomendações | ~½ dia, depois de ≥ 50 recomendações reais logadas |

Fase 1 liga em produção só depois de: placar de recomendação ≥ meta (§5), placar de busca e de
conversas **sem queda** (a nova ação não pode roubar `search`), suíte verde, teste no celular do dono.

## 5. Placar (o que "funciona" quer dizer)

- **`evals/recommend-requests.json`** (~60 pedidos vagos): doce, salgado, gelado, leve, jantar
  rápido, café da manhã pra 4, churrasco pra 8, presente (mãe/pai/namorada/criança 5 anos/
  amigo secreto até R$50), ressaca, noite de filme, festa infantil, lanche da tarde, pet novo,
  "algo pra limpar a casa", "sem glúten". Metade com restrição (orçamento, "sem lactose").
- **`scripts/bench-recommend.mts`**: roda o caminho real no CEP do bench; juiz gpt-6-luna
  (regra do dono: nunca sol) responde por pedido: **atende a vontade** (≥ 1 card resolve),
  **variedade** (tipos distintos), **pergunta desnecessária** (a frase já dizia), **sugestão
  errada** (card que não tem nada a ver), **respeita restrição**, latência. Metas de partida:
  atende ≥ 90 %, variedade ≥ 80 %, pergunta desnecessária ≤ 5 %, errada ≤ 5 %, p50 ≤ 8 s.
- **Cenários de conversa c101–c110** em `evals/conversation-scenarios.json`: cliente simulado
  com vontade vaga até o Pix (juiz de sempre: objetivo, produto errado, promessa falsa, beco).
- **Tabela-ouro unitária** (`tests/recommend-golden.test.ts`, sem rede): frase → `recommend` vs
  `search` vs `unclear` (30 frases, incluindo as da §0), tabela curada por intenção, `pickDiverse`,
  "cesta com X não recomenda X", pergunta só quando falta a chave.
- **E2E com costura** (`__setDialogueModelForTests` + `__setRerankForTests` + expansão fake):
  "quero algo doce" → 4 cards de tipos diferentes → "o 2" → total → Pix. "algo doce sem
  chocolate" → nenhum card de chocolate. "presente pra minha mãe" → sem pergunta; "um presente"
  → 1 pergunta → cards.

## 6. Riscos e como o plano lida

- **Roubar a busca normal** (a IA mandar `recommend` pra "quero chocolate"): regra explícita no
  prompt + placar de busca como régua de regressão + tabela-ouro das 30 frases.
- **Recomendação ruim é pior que pergunta:** por isso o juiz mede "errada" e a tabela curada
  é o fallback (nunca a frase literal na busca).
- **Latência:** paralelismo + hedge; se a expansão falhar, tabela; se o funil demorar, mostra o
  que chegou (como a lista faz).
- **Custo:** 1 chamada luna a mais por pedido vago; pedidos vagos são minoria das mensagens.
- **Expectativa de "agora":** copy e card com prazo real; nunca prometer rapidez.

## 7. Decisões do dono antes de começar

1. Ligar pra **cliente novo antes do CEP**? Proposta: pedir o CEP primeiro (como `items` faz),
   porque sem CEP não há estoque nem prazo, e card sem prazo é promessa.
2. **4 cards** (um por tipo) em vez de 3? Proposta: 4 na tela de lista, 3 no carrossel quando o
   Flow estiver desligado.
3. Camada 3 (complemento no fechamento) entra já na fase 1 desligada por flag, ou só depois do
   dado? Proposta: depois do dado.
4. Pergunta "pra quem?" em presente sem destinatário: perguntar ou mostrar um mix (perfume,
   chocolate, flores) e deixar refinar? Proposta: mostrar o mix, sem pergunta, e perguntar só
   quando o cliente der orçamento sem destinatário.
