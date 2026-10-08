# Plano: a Lia recomenda (pedido por necessidade → produtos concretos)

> **Status (08/10, noite): IMPLEMENTADO nas 4 fases** (cadeia completa, memória, remédio por sintoma com alertas,
> complemento no fechamento, painel `/ops/recomendacoes`, placar próprio). Registro vigente no topo de `AGENTS.md`.
> Pendências do dono na seção 7.

_Escrito em 08/10/2026 a pedido do dono. 2ª rodada no mesmo dia, depois da orientação dele:
"primeiro ela precisa reconhecer que pediram uma recomendação; depois saber procurar nos
nossos produtos pela inteligência dela, não pelo nome; pensar no macro, pra funcionar pra
qualquer recomendação". Plano de implementação; nada construído ainda._

## 0. O que acontece HOJE com "tô com muita fome, quero algo doce"

Testado offline em 08/10 (`detectIntent` + ranking do catálogo, sem IA):

| Mensagem | Caminho hoje | O que o cliente vê |
|---|---|---|
| "tô com muita fome, quero algo doce" | `free_text` → gerente de diálogo (IA) | Ou `unclear` ("o que você quer?"), ou `search "doce"` |
| "me recomenda um chocolate bom" | busca "chocolate" | O chocolate que o ranking léxico/rerank põe primeiro — sem julgar "bom" |
| "tô com dor de barriga" | `looksLikeSymptomAsk` → `symptomExplainerMip` | "Indicar remédio eu não posso — isso é com o farmacêutico" + itens de conforto |
| "algo gostoso pra comer" | `vague_request` (regex) | Texto fixo pedindo o nome de um produto |
| "me indica um presente pra minha mãe" | `giftSearchPhrase` | Uma consulta fixa ("perfume feminino"), sem variedade |

Se a IA decide `search "doce"`, o ranking devolve **uva doce, batata doce e doce de leite**
(Mambo e Prezunic): a palavra casa com o nome do produto, não com a vontade. **Hoje a Lia não
recomenda.** Toda a inteligência atual é "o cliente nomeou um produto → ache o produto certo"
(extração → candidatos → estoque no CEP → rerank). Falta tudo que vem antes disso.

## 1. O macro: por que isso é mais que "ligar a IA"

Um pedido de recomendação quebra duas suposições do funil de hoje:

1. **A busca supõe que a mensagem contém o nome do produto.** Em "tô com dor de barriga" não
   há produto; em "me recomenda um chocolate bom" há, mas o pedido é de **julgamento**, e o
   funil de hoje julga só "é o produto pedido?", nunca "é bom?".
2. **A IA não enxerga o que a Lia vende.** São ~97 mil itens em 6,8 mil categorias de ~45
   lojas. Pedir "sugira produtos" direto à IA gera nome bonito que não existe na prateleira.

Logo, recomendar bem é uma **cadeia de 5 etapas, cada uma com dono, fallback e placar próprio**.
O que vale pra "fome", "dor de barriga", "presente" e "chocolate bom" é a cadeia; o que muda
entre eles é só a tabela de conhecimento que cada etapa consulta.

```
mensagem
 │
 ▼ ENTENDER   que forma tem o pedido? (produto / produto+julgamento / necessidade)
 │            + critérios (rápido, bom, barato), restrições, pra quem, urgência
 ▼ MAPEAR     necessidade → prateleiras REAIS da Lia (mapa derivado dos catálogos)
 │            "dor de barriga" → antiácido, antidiarreico, antigases, probiótico (MIP)
 ▼ BUSCAR     prateleira → itens com estoque e prazo no CEP (o funil que já existe)
 ▼ JULGAR     ordenar pelo critério da necessidade (não pela palavra): o que mais
 │            ajuda primeiro; 1 motivo curto por card; honesto quando não há
 ▼ APRENDER   registrar pedido → prateleiras → cards → escolha; juiz; mapa cresce
```

### 1.1 ENTENDER — reconhecer que é recomendação

Não é lista de palavras-chave: é classificar a **forma** do pedido. Três formas:

| Forma | Exemplo | O que a Lia faz |
|---|---|---|
| **produto** | "quero chocolate", "2 cocas" | busca de hoje (nada muda) |
| **produto + julgamento** | "me recomenda um chocolate bom", "qual o melhor shampoo pra cabelo cacheado", "qual ração vale a pena pro meu gato" | busca na prateleira do produto e **julga pelo critério** (bom = marca/popularidade, não o mais barato) |
| **necessidade** | "tô com fome", "tô com dor de barriga", "algo doce", "churrasco pra 8", "presente pra minha mãe", "preciso limpar o banheiro" | mapeia a necessidade em prateleiras e recomenda |

Além da forma, a etapa extrai: **critérios** (rápido / bom / barato / saudável), **restrições**
(orçamento, "sem lactose", "sem chocolate"), **pra quem** (pet, criança, namorada),
**urgência** ("agora", "hoje") e **sintoma/estado** quando houver.

Como fazer isso funcionar sempre:

- **Saída estruturada única** do gerente de diálogo: ação `recommend {form, product?, need?,
  criteria[], constraints[], recipient?, urgency?}`. A IA já decide ações por JSON estrito;
  isto é mais uma, com regra no prompt: *pedido de julgamento ("melhor", "bom", "recomenda",
  "indica", "vale a pena", "o que você sugere") ou estado/necessidade sem produto = recommend;
  produto nomeado sem julgamento = search.*
- **Sinais sem IA** (`lia-intents.ts`): "me recomenda/indica/sugere", "qual o melhor", "o que
  é bom pra", "tô com (fome/sono/dor/frio/calor/ressaca)", "algo (doce/salgado/gelado/leve)",
  "preciso de algo pra". Garante o caminho quando a IA cai.
- **Continuidade:** depois de uma recomendação, "tem mais barato?", "sem chocolate", "outras"
  continuam dentro dela (`PendingChoice.recommendation`), não viram busca nova.
- **Placar da etapa:** tabela-ouro de ~120 frases → forma + campos (sem rede). A regressão
  mais perigosa é `recommend` roubar `search` ("quero chocolate" nunca pode virar recomendação);
  o placar de busca de hoje é a régua.

### 1.2 MAPEAR — necessidade → prateleiras reais

A ponte entre a inteligência da IA e os 97 mil itens é um **mapa de prateleiras**: ~150–250
nós curados, gerados a partir das categorias reais dos catálogos (`category` de cada item,
6,8 mil strings colapsadas por sinônimo), cada nó com nome, lojas que o têm, e
sinalizadores (MIP, pet, infantil, pronto-pra-comer, gelado). É o "que a Lia vende" em uma
página que cabe no prompt.

- A IA recebe a necessidade + o mapa e devolve **até 6 prateleiras, em ordem do que mais
  ajuda**, cada uma com uma consulta de busca concreta e um motivo curto. Ela escolhe entre
  nós que existem; nunca inventa prateleira.
- **Tabelas curadas por domínio** entram no mapa como conhecimento fixo e revisado, onde errar
  custa caro:
  - **Sintoma → classe MIP** (ver §1.6): "dor de barriga" → antidiarreico (loperamida),
    antiespasmódico (butilescopolamina), antigases (simeticona), antiácido, probiótico; "dor de
    cabeça" → analgésico (dipirona, paracetamol, ibuprofeno); "azia" → antiácido; "ressaca" →
    analgésico + hidratação. Só isentos; ordem = o mais indicado primeiro.
  - **Ocasião → kit**: churrasco (carvão, carne, pão de alho, cerveja, gelo), café da manhã
    (pão, café, leite, queijo, fruta), festa infantil, noite de filme, limpeza de banheiro.
  - **Estado → tipo**: fome (pronto pra comer: salgadinho, chocolate, sanduíche, biscoito;
    critério = chega rápido), sede/calor (gelado), frio (sopa, chá), sono (café/energético).
  - **Presente → mix por destinatário**: mãe (perfume, chocolate, flores, kit banho), criança
    (brinquedo por idade), amigo secreto (até R$X).
- **Sem IA ou IA fora do ar:** só as tabelas curadas; necessidade fora delas → pergunta
  honesta com exemplos (a copy de hoje).
- **Placar da etapa:** ~80 necessidades → prateleiras esperadas (juiz gpt-6-luna avalia
  "cada prateleira ajuda?" e "faltou a óbvia?").

### 1.3 BUSCAR — prateleira → itens no CEP

Reusa o funil: busca ao vivo por loja + cópia → estoque e prazo no CEP → candidatos. Duas
adições:

- **Busca por prateleira, não só por palavra.** A busca inteligente da VTEX aceita caminho de
  categoria (`product_search/<categoria>/…`); para prateleiras do mapa, consultar a categoria
  da loja dá a prateleira inteira (todos os antidiarreicos), não os 8 que casam com uma
  palavra. Onde não houver caminho, cai na consulta textual que a IA escreveu.
- **Paralelismo = lista de N itens** (já existe): 5–6 prateleiras em paralelo custam o que
  uma lista de 5 itens custa hoje.

### 1.4 JULGAR — ordenar pelo critério da necessidade

O rerank de hoje responde "é o produto pedido e cumpre as exigências?". Recomendação precisa
de um **juiz de aptidão**: recebe a necessidade, os critérios e os candidatos (com preço,
prazo real no CEP, popularidade, marca) e devolve, por prateleira, o melhor e por quê.

- **Critérios viram ordem concreta:**
  - *rápido / urgência* ("tô com fome") → menor prazo real no CEP primeiro, pronto-pra-comer antes
    do que precisa preparar; nunca prometer "agora" — o card mostra o prazo verdadeiro.
  - *bom / melhor* ("chocolate bom") → marca reconhecida + popularidade do catálogo
    (`popularity`) + faixa de preço média-alta; nunca o mais barato por padrão.
  - *barato* → preço, como hoje (`cheapestFirst`).
  - *sintoma* → ordem da classe mais indicada (da tabela), depois apresentação básica da marca
    (regra do remédio de 08/10), depois preço.
  - *pra quem* → público/espécie como exigência dura (já existe no rerank).
- **Variedade entre prateleiras:** 1 card por prateleira, até 4 cards, tipos distintos.
  Variante só quando o cliente refina ("mais chocolates").
- **Motivo de 1 linha por card** ("chega em 2h", "o mais vendido", "alivia cólica e gases"),
  escrito pelo juiz a partir de fatos que o card tem — nunca promessa de efeito que o produto
  não declara.
- **Honestidade:** prateleira sem item no CEP é pulada; nenhuma → "hoje não tenho X com
  entrega aí; tenho Y e Z, quer ver?". Nunca "não achei doce".
- **Placar da etapa:** juiz avalia "o 1º card ajuda?", "ordem faz sentido pro critério?",
  "motivo é verdadeiro?".

### 1.5 APRENDER — fechar o ciclo

- `RecommendLog` (migration): mensagem, forma, necessidade, prateleiras, cards, escolha,
  refino, resultado (Pix ou não). `/ops/recomendacoes` mostra o que pedem de forma vaga, o que
  converte e onde o mapa falhou.
- Pedido vago sem prateleira → entra na fila de revisão do mapa (como `SearchMiss` faz pra
  busca). Mapa e tabelas crescem de dado, não de palpite.
- Camada futura (depois de ≥ 50 recomendações reais): complemento no fechamento ("quem leva
  carvão leva pão de alho", 1 por pedido) por co-ocorrência nos pedidos pagos.

### 1.6 Remédio por sintoma — o que muda e o que não muda

O dono pediu (08/10) que "tô com dor de barriga" redirecione para remédios que ajudem, os
melhores antes. Isso **substitui** a decisão pendente de 07/10 ("não indico, é com o
farmacêutico") e a copy `symptomExplainerMip`. Regras para fazer com segurança:

- **Só isento (MIP)**, pela tabela curada sintoma → classe → princípios ativos; receita e
  controlado nunca. A tabela é revisada pelo dono (e pelo advogado sanitário que já está em
  PENDENCIAS) antes de ligar; a IA reconhece o sintoma e escolhe entre as classes da tabela,
  não inventa classe.
- **Sinais de alerta → não recomenda:** dor forte/persistente, sangue, febre alta, gestante,
  bebê/criança pequena, "há vários dias", mistura de remédios. Nesses casos a Lia manda
  procurar médico/farmacêutico e compra só se o cliente nomear o MIP.
- **Copy fixa de cuidado** em toda recomendação de remédio: "isentos de receita; se não
  melhorar em 1–2 dias ou piorar, procure um médico" + "leia a bula". Motivo do card descreve
  a classe ("alivia cólica"), nunca promete cura.
- CPF do cliente, compra na farmácia no nome dele e nota fiscal: como já funciona.

## 2. Onde mexe (arquivos)

| Etapa | Arquivo | Mudança |
|---|---|---|
| Entender | `src/lib/dialogue/types.ts`, `model.ts`, `plan.ts`, `execute.ts` | ação `recommend` com forma e campos; regra e exemplos no prompt |
| Entender | `src/lib/dialogue/presignup.ts` | `vague` e sintoma viram `recommend` guardado até o CEP (sem CEP não há estoque nem prazo) |
| Entender | `src/lib/lia-intents.ts` | `vague_request`, `looksLikeSymptomAsk`, `giftSearchPhrase` convergem para `{kind:"recommend", …}`; sinais novos sem IA |
| Mapear | `src/lib/recommend/shelf-map.ts` (gerado por `scripts/build-shelf-map.mts` a partir dos catálogos) + `tables.ts` (sintoma, ocasião, estado, presente) | mapa e tabelas curadas, puros e testados |
| Mapear | `src/lib/adapters/ai.ts` | `mapNeedToShelves()` — prompt + JSON estrito + hedge + timeout; validação: só nós do mapa |
| Buscar | `src/lib/stores/live-search.ts`, `index.ts` | busca por caminho de categoria quando a prateleira tem um; `gatherCrossStoreCandidates` por prateleira |
| Julgar | `src/lib/adapters/ai.ts`, `src/lib/recommend/judge.ts` | `judgeFitness()` com critérios; ordem determinística de fallback por critério (prazo, popularidade, preço) |
| Executar | `src/lib/delivery-service.ts` | `handleRecommend()` reusa `buildChoices` por prateleira; `PendingChoice.recommendation`; "outras" = próximas prateleiras; refino filtra prateleiras |
| Copy | `src/lib/lia-copy.ts` | `recommendIntro`, `recommendNone`, `recommendMedicineCare`, `recommendRedFlag`; `symptomExplainerMip` sai de cena com a flag |
| Aprender | `prisma/schema.prisma` (`RecommendLog`), `/ops/recomendacoes` | registro e painel |
| Flag | `LIA_RECOMMEND=true`; `LIA_RECOMMEND_MEDICINE=true` separada | desligada = hoje |

## 3. Regras de comportamento (pra copy e testes)

1. Produto nomeado sem julgamento → busca de hoje. Julgamento ou necessidade → recomendação.
   "Algo doce tipo um chocolate" = busca chocolate (exemplo concreto vence).
2. No máximo 1 pergunta antes de mostrar produto, e só de lista fechada: presente sem
   destinatário ("pra quem?"), pet sem espécie, refeição pra grupo sem número. Depois dos
   cards, refino livre.
3. 4 cards = 4 prateleiras. Ordem = critério da necessidade.
4. Urgência nunca vira promessa: o card mostra o prazo real; a copy pode dizer "o que chega
   mais rápido aí é…".
5. Remédio só por tabela MIP, com copy de cuidado; sinal de alerta → não recomenda.
6. Cesta com X → não recomenda X.
7. A IA escolhe prateleiras e julga; o card só sai se o funil confirmou estoque e entrega no CEP.
8. Toda recomendação é registrada.

## 4. Fases

| Fase | Entrega | Esforço |
|---|---|---|
| **1 — cadeia completa, sem remédio** | ação `recommend` (3 formas) + mapa de prateleiras gerado + tabelas de ocasião/estado/presente + busca por prateleira + juiz de aptidão + copy + `RecommendLog` + placares das etapas + E2E | ~2 dias |
| **2 — memória e pergunta única** | `User.preferences` (restrições ditas, pet, marcas repetidas, categorias recentes) na etapa Mapear e Julgar; 3 perguntas de lista fechada; cenários de conversa | ~1 dia |
| **3 — remédio por sintoma** | tabela sintoma→classe MIP revisada + sinais de alerta + copy de cuidado + flag própria; placar com casos de alerta | ~1 dia + revisão do dono/advogado |
| **4 — proativo** | complemento no fechamento + `/ops/recomendacoes` | ~½ dia, depois do dado |

Liga em produção só com: placares das etapas na meta, placar de busca e de conversas sem queda,
suíte verde, teste no celular do dono.

## 5. Placar

- **Entender:** `tests/recommend-golden.test.ts`, ~120 frases → forma + campos; meta ≥ 97 %
  e **zero** produto-nomeado virando recomendação.
- **Mapear:** `evals/recommend-needs.json` (~80 necessidades) → juiz: prateleira ajuda? faltou
  a óbvia? meta ≥ 90 %.
- **Julgar / ponta a ponta:** `scripts/bench-recommend.mts` no CEP do bench: 1º card ajuda
  (≥ 90 %), variedade (≥ 80 %), pergunta desnecessária (≤ 5 %), card sem nada a ver (≤ 5 %),
  respeita restrição (100 %), motivo verdadeiro, p50 ≤ 8 s. Juiz gpt-6-luna (nunca sol).
- **Remédio (fase 3):** 30 casos de sintoma + 15 de alerta; alerta recomendado = 0.
- **Conversa:** c101–c112 em `evals/conversation-scenarios.json` (cliente simulado com
  necessidade até o Pix).
- **E2E com costura** (dialogue + rerank + mapa fakes): "quero algo doce" → 4 cards distintos →
  "o 2" → Pix; "algo doce sem chocolate" → nenhum chocolate; "me recomenda um chocolate bom" →
  busca chocolate ordenada por marca/popularidade, não o mais barato; "tô com fome" → cards
  prontos-pra-comer ordenados por prazo, copy com prazo real.

## 6. Riscos

- **Roubar a busca normal:** regra explícita, tabela-ouro, placar de busca como régua.
- **IA sugerir prateleira que não existe:** validação contra o mapa; fora do mapa = descartada.
- **Remédio:** tabela curada, flag própria, sinais de alerta, revisão jurídica antes de ligar.
- **Latência:** paralelismo + hedge; expansão falhou → tabelas; funil lento → mostra o que chegou.
- **Custo:** 2 chamadas luna a mais (mapear + julgar) por pedido de recomendação.
- **"Agora" vs prazo da loja:** copy honesta; o critério "rápido" ordena, não promete.

## 7. Decisões do dono

Tomadas em 08/10 (2ª rodada): recomendar é prioridade; sintoma redireciona a remédios que
ajudem (isentos), os melhores antes; o desenho precisa valer pra qualquer recomendação.

Ainda abertas:
1. Cliente novo: pedir CEP antes de recomendar? Proposta: sim (sem CEP não há estoque nem prazo).
2. 4 cards (um por prateleira) em vez de 3? Proposta: 4 na tela de lista, 3 no carrossel.
3. Presente sem destinatário: perguntar ou mostrar mix? Proposta: mix, sem pergunta.
4. Remédio por sintoma: ligar na fase 3 só depois da revisão do advogado sanitário (já em
   PENDENCIAS)? Proposta: sim; a tabela pode ser escrita antes.
