## REGRA VIGENTE — Nunca cobrar o que a compra não consegue fazer (08/10/2026, noite, dono: "o maior problema da Lia")

Caso real: a vitrine prometeu TURBO 30 min (Drogarias Pacheco), o dono pagou, a compra estornou ("nenhuma entrega
dentro do prazo prometido"). Causa: a simulação era só por CEP e a compra manda as COORDENADAS do endereço; a TURBO é
por raio e some com elas. Estornos de 30 dias no banco: prazo prometido inexistente, item sem estoque na hora,
janela de entrega obrigatória (Mambo), Pix de saída recusado pelo Asaas. Três travas, todas ANTES de cobrar:
- **Simulação com as mesmas coordenadas da compra** (`simulationGeo` em live-freight.ts, mesma fonte do
  vtex-address.ts, cache por CEP): vitrine, cotação e pré-voo veem as mesmas entregas que o checkout. Medido na loja:
  sem coordenada "rápida 30m", com coordenada "60m".
- **Ensaio da compra** (`src/lib/purchase/rehearsal.ts`, via `findChargeBlock` em order-payments.ts): primeiro
  `executabilityFailure` — **toda compra é por API, não existe fila manual** (dono, 08/10): cesta de 2 lojas
  (`split`, fica a loja com mais R$), loja fora da API/sem liberação/sem conta (`store`) ou item sem link de
  compra nunca são cobrados (Pague Menos 23/09 e ML 06/10 foram cobrados → "fila manual" → estorno). Depois roda os
  MESMOS passos da compra automática (cesta, perfil, endereço com coordenadas, entrega dentro do prazo prometido, Pix,
  conferência, **preço ≤ teto cotado**) e para antes de fechar; esvazia a cesta. Recusa da loja = nada cobrado (item →
  alternativas; entrega/preço/checkout → `copy.deliveryNotConfirmed` e a Lia **recota no mesmo turno**; endereço →
  pede o endereço de novo). **Sem loop**: a 2ª recusa seguida da MESMA loja/itens (`ctx.rehearsalRefused`) tira a
  loja do caminho e busca o item em outra (`copy.rehearsalGaveUpStore`). Vale em TODA cobrança: cotação aceita,
  troca Pix↔cartão, Pix vencido e "manda de novo" (`recheckOpenCharge` → `guardOpenCharge`, que fecha o pedido
  aberto sem dinheiro por `closeUnpaidOrder`). Loja fora do ar/403/5xx ou orçamento estourado
  (`LIA_PURCHASE_REHEARSAL_BUDGET_MS`, 45 s) não inventa recusa. Reproduzido na loja real com o pedido de 08/10:
  promessa 30 min → NÃO COBRA; 60 min → cobra. `LIA_PURCHASE_REHEARSAL=false` desliga.
  Janela que sobra (aceita): Pix emitido e pago até 60 min depois — a loja pode mudar nesse meio; aí a compra falha
  e o estorno automático é o caminho (único caso restante).
- **Trava do Pix de saída sem janela de 6h** (`pixOutReadiness`): vale a última recusa do Asaas de quando for, sem Pix
  pago depois → testa de novo (a cada 10 min) antes de cobrar.

## 08/10/2026 (noite) — Recomendação por necessidade/ocasião/sintoma ("quero algo doce", "dor de barriga") — LIGADA

Decisão do dono (08/10): a Lia recomenda. Plano e arquitetura: `docs/plano-recomendacoes-2026-10-08.md`. Cadeia de 5 etapas,
cada uma com fallback sem IA e teste próprio (`src/lib/recommend/`):
- **ENTENDER** — forma do pedido: produto (busca de sempre), produto+julgamento ("me recomenda um chocolate bom") ou
  necessidade ("tô com fome", "algo doce", "churrasco pra 8", "presente pra mãe", "dor de barriga"). Ação `recommend` no
  gerente de diálogo e no pré-cadastro + regras em `detect.ts` (tabela-ouro `tests/recommend-golden.test.ts`, 234 frases,
  **zero produto nomeado virando recomendação** — regra: na dúvida, NÃO recomenda).
- **MAPEAR** — `shelf-map.ts` = 241 prateleiras GERADAS dos catálogos (`scripts/build-shelf-map.mts`; regenerar ao somar loja);
  `tables.ts` = necessidades/ocasiões/presentes, sintoma → classe ISENTA em ordem de indicação, sinais de alerta. A IA
  (gpt-6-luna) escolhe prateleiras do mapa; fallback = tabelas. Sintoma: só classes da tabela; necessidade sem sintoma: nunca remédio.
- **BUSCAR** — `gatherShelfCandidates` (sem Mercado Livre, só lojas que entregam no CEP, remédio só em prateleira `mip`) +
  conferência ao vivo de sempre; busca VTEX por categoria disponível (`liveSearchByCategory`).
- **JULGAR** — 1 card por prateleira pelo critério (rápido = prazo real; bom = marca/popularidade, nunca o mais barato;
  barato; saudável; sintoma = classe mais indicada e apresentação básica), motivo factual no card, até 4 cards.
- **APRENDER** — `RecommendLog` + `/ops/recomendacoes` (o que pedem, o que converte, prateleiras vazias = fila de revisão do mapa).
Regras de segurança (revisão adversarial 08/10): emergência (peito, falta de ar, sangue, desmaio…) responde SAMU/PS em qualquer
forma e ANTES do CEP; bebê/criança/idoso/gestante/comorbidade → médico/farmacêutico, compra só se o cliente nomear o isento;
pet doente → veterinário, nunca remédio humano; ressaca sem AINE/Engov; loperamida só em "diarreia". Copy: `recommendRedFlag(reason, kind)`.
Memória (`memory.ts`, `User.preferences`): só o que o cliente DISSE (restrições, pet, casa) + marcas repetidas dos pedidos pagos;
"esquece minhas preferências" apaga. Complemento no fechamento (`complement.ts`, 1 oferta sim/não por pedido, tabela curada,
nunca com remédio). Placar: `scripts/bench-recommend.mts` (80 pedidos, juiz luna) e cenários c102–c113.
Flags: `LIA_RECOMMEND` (padrão `all` = todos, liberado pelo dono em 08/10 noite junto com o fim do modo offline; `test` = só dono/admins; `false` = desliga), `LIA_RECOMMEND_MEDICINE` (ligado; exige `LIA_MEDICINE_MIP`), `LIA_RECOMMEND_AI`,
`LIA_RECOMMEND_COMPLEMENT` (ligado em prod; a suíte antiga roda desligada), `LIA_RECOMMEND_MAX_CARDS` (4).
**Pendente do dono:** revisão da tabela de sintomas com o advogado sanitário (loperamida, aciclovir, melatonina, cetoconazol,
descongestionantes — bloco "REVISÃO PENDENTE" no topo de `tables.ts`); `RecommendLog.phone` em texto puro (SearchMiss usa hash).

**Rodada de qualidade q9 (08/10, noite):** placar principal q8 → q12 = atende 88,6% → 98,6%, card errado 2,9% → 2,9%, variedade 95,7% → 94,2%, motivo 100%, restrição 100%, sem cards 1,4%;
difícil q7 → q12 = atende 73,9% → 95,8%, card errado 19,0% → 4,3%, variedade 61,9% → 78,3%, restrição 100%, motivo 81,0% → 100%, sem cards 8,7% → 4,2%. O que mudou: (1) **quantidade por número de pessoas**
(`quantity.ts`: tabela g/ml/un por pessoa por prateleira, tamanho lido do NOME; o card leva `ChoiceOption.suggestedQty` e "sugestão: 3x pra 12
pessoas"; escolher o card já põe a quantidade; orçamento vale pro total); (2) **fome pede refeição**: entradas `curated` em `NEED_TABLE`
(fome, sono, jantar leve, gelado, proteico) vão direto da tabela, sem IA; macarrão instantâneo/sanduíche/prato pronto antes de petisco, e
`ensureMealCard` garante 1 refeição; pedido de ESTADO (fome, sede…) não é kit (orçamento não soma os cards); (3) **urgente = entrega mais rápida da
loja** (`confirmOptionsLive(..., {urgent})` usa `fastEstimate`: Drogal 30 min em vez de 3 h, como a vitrine do "pra hoje"); card que só chega
amanhã diz o prazo no motivo; (4) **atributo pedido que o nome precisa provar** (`PROOF_ATTRS` em quality.ts: renal, urinário, pulga/carrapato,
queda, caspa [strict: sem prova a prateleira sai]; castrado, filhote, light, pele sensível [prefere quem prova]) e motivo que afirma atributo sem
prova é descartado (`whyClaimsUnproven`); motivo de dieta natural ("fruta, naturalmente sem lactose"); (5) "algo gelado" só prateleira com flag
`cold`; "gelado e doce" = sorvete/iogurte; (6) ressaca sem o soro mip; unha encravada = Povidine + curativo; jantar leve sem sopa; (7) dieta com prova
buscável: a prateleira de risco não sai do plano pela palavra (busca "sorvete sem lactose"), e as de risco vão DEPOIS das livres. Sem solução:
r77 (detergente — Mambo marca todos indisponíveis pro CEP no check ao vivo), h17 (alergia a amendoim em salgadinho: copy honesta, por desenho).
## 08/10/2026 (noite, 2ª) — Tempo da lista: índice do catálogo (CPU 7 s → 1 s), thread livre, retry da busca ao vivo

Depois das três correções abaixo, o dono pediu que "nunca mais" aconteça e mandou consertar o tempo. Medido
no repro local da lista de 4 itens: a PONTUAÇÃO da cópia dos catálogos (`rankCatalog`/`scoreCatalogMatch`,
~90 mil itens em 39 vitrines) custava **~1,8 s de CPU por linha** — 4 linhas = 7 s com a thread travada,
e as respostas das lojas (busca ao vivo, simulação) esperavam na fila de eventos com o timeout correndo.
Era o segundo motivo do "não tinha gin" e a maior fatia dos 17 s de "search+live" do turno de produção.
- **Índice do catálogo** (`candidateItems` em `src/lib/stores/types.ts`): por catálogo (identidade do array,
  WeakMap), palavra → itens; a consulta casa os tokens (frase + aliases) contra o vocabulário com os MESMOS
  casadores (`isSameNoun`/`tokenMatchesWordSyn`/`tokenMatchesWord`, memoizados) e só os itens apontados
  passam pelo `scoreCatalogMatch` inteiro. Condição necessária, nunca suficiente: resultado **idêntico** ao
  da varredura (teste de equivalência `tests/catalog-index-2026-10-08.test.ts`: 316 pedidos reais do placar +
  60 casos de borda × 5 catálogos grandes, top-12 igual). 4 linhas × 39 lojas: **7,1 s → 1,1 s** (com a
  construção do índice; quente, 2,2 s → 0,14 s em 5 catálogos). Regra: mexeu em `scoreQuery` de um jeito
  que possa pontuar SEM casar palavra do nome/marca/categoria, o índice tem que acompanhar (o teste acusa).
  `__setCatalogFullScanForTests(true)` volta à varredura.
- **Thread livre entre lojas**: `searchStoreItems` cede a vez (`setImmediate`) antes de pontuar cada loja,
  para as respostas de rede entrarem no meio.
- **Busca ao vivo tenta de novo UMA vez no timeout** (`liveSearchItems`): estouro isolado não vira "não achei".
Fica para medir em produção: o turno de 4 linhas tinha extração 4 s + busca/checagem 17 s + juiz 8 s;
a parte de busca/checagem deve cair para poucos segundos. Juiz e extração são IA (`gpt-6-luna`); o
`LIA_AI_EFFORT=none` segue "a medir antes de virar padrão".

## 08/10/2026 (noite) — Teste da lista pelo dono: gin "não achei", lista reenviada, "cancelei por inatividade"

Conversa real (16:44 UTC, lista "2 vodkas absolute / suco de laranja / gin / 4 red bull"), reconstruída
pelos logs da Vercel e pelo banco. Três causas, três regras:
- **Fila de chamadas às lojas** (`src/lib/store-throttle.ts`, `withStoreSlot`, `LIA_STORE_FETCH_CONCURRENCY`=32).
  Lista de 4 itens = ~150 chamadas simultâneas (busca ao vivo em ~40 lojas × 4 linhas + simulação por
  SKU); no repro local TODAS as 39 buscas ao vivo do "gin" estouravam o timeout de 3 s, e a Mambo
  sozinha responde em 0,8 s. Como a cópia local não tem os gins da Mambo, a linha virava "não achei";
  um turno depois, com uma linha só, a mesma busca achava Seagers/Apogee. Com a fila, o timeout de
  cada chamada conta da SAÍDA da fila (o `AbortSignal` nasce dentro do slot) e o gin aparece com as
  mesmas 4 linhas. Vale para `liveSearchItems` e `simulateItems`. Não subir o timeout no lugar da fila.
- **Lista reenviada é ignorada** (`isRecentDuplicateInbound`, `LIA_DUPLICATE_INBOUND_MS`=3 min). A mesma
  lista chegou duas vezes em 23 s (wamids diferentes: o dono reenviou enquanto o 1º turno, de 37 s,
  ainda buscava); o 2º turno esperou o lock e virou `search+swap+search(retry)` em cima do formulário,
  com três carrosséis — o "mandou os cards e também a lista". Texto idêntico ao inbound anterior, em
  menos de 3 min, com cara de pedido de produto (`looksLikeProductList`) = silêncio total, antes do
  lock. "1"/"ok" repetidos não entram no dedupe.
- **Pedido parado + pedido novo = missão nova em silêncio.** O "Cancelei o pedido #X por inatividade"
  (`staleQuoteRestart`) saiu do TTL de abandono: o pedido velho morre em silêncio e a mensagem segue.
  E a regra do Pix (04/09) vale agora para total/entrega na mesa: cotação há **10+ min**
  (`LIA_NEW_MISSION_AFTER_MS`) + pedido de produto do nada sem "adiciona" = cotação cancelada em
  silêncio (nada cobrado), cesta velha NÃO volta, mensagem vira pedido novo — fica antes do gerente de
  diálogo, que tratava a lista como edição ("Atualizei seu pedido"). Até 10 min continua reabrindo
  (mesmo pedido). `staleQuoteRestart` só sobrevive no toque num botão de frete vencido.
Teste: `tests/feedback-2026-10-08-lista.test.ts` (3 dos 7 falham no código anterior); `manual-concierge`
ajustado. Pendente (não é regra): o turno de 4 linhas ainda leva ~30 s em produção (extração 4 s +
busca/checagem 17 s + rerank 8 s + miniaturas); a fila tira as falhas, não o tempo.

## 08/10/2026 — Nomes: projeto Vercel `lia-delivery` (repositório GitHub também vai para `lia-delivery`)

O projeto na Vercel foi renomeado de `shopping-agent-mvp` para **`lia-delivery`** (painel:
vercel.com/josephdayans-projects/lia-delivery). Endereços que respondem: **liadelivery.com.br** (o oficial;
use este em todo link público — fotos da Petz e volta do Mercado Pago já usam), `lia-delivery.vercel.app` e o
antigo `shopping-agent-mvp.vercel.app` (mantido como reserva). O repositório no GitHub será renomeado para
`josephdayan/lia-delivery`: o GitHub redireciona o nome antigo; em sessões novas do Claude, escolha o repositório
pelo nome novo; num clone local, `git remote set-url origin https://github.com/josephdayan/lia-delivery.git`.

## REGRA VIGENTE — Modelo: SÓ `gpt-6-luna`. NUNCA `gpt-6-sol` (dono, repetido em 08/10)

Lia, juiz dos placares, cliente simulado, visão, comprador — tudo `gpt-6-luna`. Sol custa ~20× e o dono proibiu;
`scripts/bench/preflight.mts` aborta se `OPENAI_MODEL`/`BENCH_JUDGE_MODEL`/`BENCH_SIM_MODEL` tiver "sol". Rodadas
antigas julgadas por sol (rodada3 de 07/10, hard-sol-r3) não servem de "antes": compare luna com luna.
Custo dos testes (o que doeu em 07/10, ~US$30/dia): iterar com os 15 repetentes e pass@1; os 316 e o pass@3 só no fechamento.

## Sessões na nuvem (claude.ai/code): `NODE_USE_ENV_PROXY=1`

O `fetch` do Node não usa o proxy do ambiente (o curl usa): sem `NODE_USE_ENV_PROXY=1`, ViaCEP, OpenAI e lojas
falham em silêncio ("Host not in allowlist") e a Lia cai nos fallbacks. Suíte e placares: `NODE_USE_ENV_PROXY=1 npm run
test:local`, `NODE_USE_ENV_PROXY=1 npx tsx scripts/bench-search.mts …`. Postgres embutido precisa de `.local-pg*/` com
dono `postgres` (`chown -R postgres .local-pg .local-pg-bench`).

## REGRA VIGENTE — Modelo de preço e nota fiscal (dono, 08/10/2026 noite): taxa da Lia NUNCA aparece; compra e nota no CPF do cliente

Dono, 08/10 noite: "essa taxa da Lia de 50 centavos não pode aparecer; embute em outra coisa". `LIA_PRICING_MODE`
padrão = **markup** (`src/lib/pricing.ts`): a margem da Lia (faixas 10/6/4/3%) vai **embutida no preço de cada item**
(card, lista, resumo, pedido nativo do cartão) — **nenhuma linha de "taxa" em mensagem nenhuma**. A taxa fixa do
remédio isento (que não leva margem) **soma na linha "Entrega"** (`summary`/`manualQuoteSummary` dobram `serviceLine`
no frete; `whatsapp-pay` põe em `shipping`, nunca em `tax`). `LIA_PRICING_MODE=service_fee` (só se pedido) põe o item
pelo preço da loja e a margem também vai pra entrega. A IA diz "não tem taxa separada, o serviço vem no preço" e
**nunca fala em "taxa de serviço"**. A compra e a nota fiscal continuam no **nome e CPF do cliente** quando ele
cadastrou CPF (`customerInvoiceEnabled`, agora independente do modo; `LIA_CUSTOMER_INVOICE=false` volta à nota no
nome da Lia). Ressalva conhecida: a nota da loja mostra o preço da loja (menor que o item na Lia). A suíte antiga roda
em markup com `LIA_CUSTOMER_INVOICE=false` (`tests/helpers/load-env.ts`); a regra nova tem
`tests/service-fee-mode.test.ts`. Substitui a regra da manhã de 08/10 (preço da loja + "Taxa de serviço da Lia").

## REGRA VIGENTE — Uma loja por pedido: a Lia junta a lista numa loja só (dono, 08/10/2026 noite, "Conserta")

Caso real: "2 vodkas absolute, 1 suco de laranja, 1 gin, 4 red bull" caiu em Santa Luzia + Americanas + Mambo,
travou no mínimo da Americanas, a troca ia levar o suco pra uma 4ª loja, e "Quando chega" respondeu "Até agora…
diz só isso" duas vezes. 90 dias: 50 cotações com mais de uma loja, **nenhuma paga**. Regras:
- **Juntar no fechamento** (`consolidateBasketStores` em delivery-service.ts, chamado em `continueAfterBasket`
  antes do pedido mínimo): cesta em 2+ lojas → procura cada linha nas lojas da cesta (depois nas outras de compra
  automática) e escolhe a loja que cobre TUDO (mais itens nativos, depois menor total). Linha comparada com o que o
  cliente PEDIU (`BasketItem.ask`, gravado em toda entrada na cesta): "vodka absolut" aceita qualquer Absolut, com
  preferência pelo que distinguia a escolha (mesmo sabor/marca, ex.: Raspberri, Natural One) e contra palavra nova
  ("e Maçã"); preço entre 0,5× e 1,5×; tamanho do pedido quando ele disse um. Sem `ask`: mesmo nome, marca real
  (marca = nome da loja não conta) e tamanho. Troca anunciada (`copy.basketConsolidated`), uma tentativa por cesta
  (`ctx.consolidationTried`), teto `LIA_CONSOLIDATE_BUDGET_MS` (15 s). Medido na cesta real: Mambo com Absolut
  Raspberri 750 ml + Natural One laranja integral, 2,1 s. Nenhuma loja cobre → cesta segue (a cobrança divide).
- **"Quando chega?" com a lista na mesa** (status sem pedido): é pergunta de prazo — a Lia diz que o prazo é da
  loja e vem no total e **fecha agora** (`copy.etaComesWithTotal`); escolha em aberto termina antes.

## REGRA VIGENTE — Pix em UMA mensagem e sem número do pedido pro cliente (dono, 08/10/2026 noite)

- **Pix**: quando a bolha nativa (`LIA_NATIVE_PIX=1`) sai, ela é a ÚNICA mensagem da cobrança (já tem total, botão do
  banco e "copiar código") — o copia-e-cola em texto não vai junto, nem na troca cartão→Pix (`sendPixCharge` em
  order-payments.ts). Bolha recusada → instruções + código como sempre. "Manda o código de novo" reenvia em texto.
- **Número do pedido (`#GT…`) é nosso**: nenhuma mensagem ao cliente leva `#id` (status, cancelamento, nota fiscal,
  código de entrega, bolha do Pix). O pedido é ancorado por data e itens. O `#id` continua no /ops e nos avisos do dono.
- "🤖 Recebedor novo aprovado sozinho" é `notifyOwner` — só o dono recebe.

## REGRA VIGENTE — Remédio: a Lia VENDE remédio isento (MIP) desde 05/10/2026

`LIA_MEDICINE_MIP=true` em produção (dono, 05/10). A Lia vende remédio isento de prescrição (dipirona, Advil, Dorflex,
ibuprofeno, paracetamol, omeprazol, colírio, pomada de assadura, vitaminas…) no CPF do cliente, pelo preço da farmácia
+ taxa de serviço, e produtos de saúde em geral. Só recusa remédio de receita/controlado (antibiótico, tarja, Euthyrox).
A entrada de 29/09 ("implementado, DESLIGADO") é histórica. **Não dizer nem assumir "a Lia não vende remédio".**
Placares (`scripts/bench-search.mts`, `bench-conversations.mts`) e juízes medem com MIP ligado desde 07/10 (noite).

## 07/10/2026 (noite) — Lista com 2+ itens vira tela de escolha (WhatsApp Flow), atrás de flag

Decisão do dono: pedido com 2 ou mais itens responde com a tela "Escolher minha lista" (Flow `lista_lia_v1`,
`src/lib/meta-setup.ts`), todos os itens numa tela, até 4 opções por item com miniatura (sharp, 96×96 base64),
sugestão marcada e "Não quero este item". Plano: `/Users/joseph/.claude/plans/t-assim-a-outra-snug-scott.md`.
- **Contagem de itens tem um dono só**: `src/lib/list-items.ts` (`resolveListItems`/`countDistinctItems`), com motivo
  por item (`[list-split]`) e tabela-ouro `tests/list-items-golden.test.ts`. Regras: nome composto curado → 1;
  cauda só de atributo herda o substantivo ("leite integral e desnatado" = 2 leites); marca no fim vale pros dois;
  catálogo local decide o resto; na dúvida separa (no Flow, item a mais custa um toque). Não chamar
  `parseBasketLines` direto para contar itens. Pendente: "arroz feijão" sem separador continua 1 item.
- **Cesta pré-montada**: a sugestão já entra na cesta; Pagar funciona sem abrir a tela. "Mais perto" e item acima
  do teto ficam sem pré-seleção. Resposta da tela só vale se o id e a cesta forem os mesmos do envio.
- **Faltantes**: status único por item (achado / mais perto / não existe / sem entrega no CEP / proibido), mesma copy
  na mensagem, na tela e no resumo. `ctx.listMisses[]` substitui `lastMiss` (espelhado para o `dialogue`).
  Todo item faltante grava `SearchMiss` → `/ops/faltantes` (migration `20261007150000_search_miss`).
- Lista com remédio isento NÃO usa a tela (regra Meta de 05/10: remédio em cards soltos). Mercado Livre fora.
- Flags: `LIA_LIST_FLOW=true` liga; `LIA_FLOW_LIST_ID` força o id. Desligada = comportamento antigo.
- Ajustes do dono (07/10, após teste no celular): opções em ordem crescente de preço e a marcada é a mais em conta
  (`cheapestFirstForLine`, antes do composer); "Nenhuma — ver outras" (`more`) vira escolha por cards daquele item
  (`showListFlowMoreOptions`) e a vaga sai do formulário; notas do composer/embalagem vão no corpo da tela (nada de
  mensagem solta); texto dos botões = "Para fechar o pedido:".

## 07/10/2026 — Regras que o placar ensinou

- Crédito da OpenAI zerado degrada a Lia sem erro visível (fallback sem IA mostra produto errado). Conferir
  saldo antes de testar ou religar; os placares abortam sem crédito.
- A IA que julga a busca recebe a MENSAGEM original: se o código reescreve o pedido (2 litros → 2× 1 litro),
  a IA tem que receber o reescrito, senão recusa tudo. Quantidade de unidades não é atributo do produto.
- Depois de "não achei", o contexto do pedido (`lastMiss`) continua 20 min: "tenta de novo" refaz uma vez e
  depois diz a verdade; "uma Wilson" soma ao pedido anterior só se a marca aparece numa opção.
- "outras"/refino/"mais barato" também passam pelo juízo da IA (`aiApprovePool`).
- Modelo da Lia: gpt-6-luna. `LIA_AI_EFFORT=none` corta ~0,7 s/chamada (a medir antes de virar padrão).


## 07/10/2026 — Placar de verdade (evals/) e busca ao vivo (opt-in)

Regra nova: **mudança de busca ou de conversa só entra se subir o placar** (`evals/README.md`).
`scripts/bench-search.mts` mede produto certo / cobertura / honestidade contra o catálogo ao vivo
das lojas, com juiz gpt-5.5; `scripts/bench-conversations.mts` roda 40 cenários de cliente (nascidos
de reclamações reais) com juiz. Os dois abortam sem crédito OpenAI. Diagnóstico medido: a busca
procura numa CÓPIA do catálogo (produto fora da cópia nunca aparece) e o rerank aprova produto de
outro tipo em vez de devolver vazio ("bola de tênis" → bola inflável/futebol). Conserto 1 pronto e
desligado: `src/lib/stores/live-search.ts` (busca inteligente da própria loja VTEX em paralelo à
cópia, seller "1", sem remédio, farmácia só nas categorias liberadas) — liga com
`LIA_LIVE_SEARCH=true`; vira padrão só depois do placar. A Lia segue OFFLINE até o dono mandar.
**Modelo da Lia (dono, 07/10): `gpt-6-luna`** (`liaTextModel()` em ai.ts; `OPENAI_MODEL` na Vercel vence o padrão — conferir que não está fixada no antigo). Visão segue no modelo antigo até testar a luna com imagem. Juiz dos placares, cliente simulado, comprador local e visão: tudo `gpt-6-luna` (dono, 07/10: "tudo é o 6 luna"). Só o áudio usa `gpt-4o-mini-transcribe`. (Corrigido: o modelo é `gpt-6-luna`, US$0,10/US$0,50 por 1M — não o 5.6.)


## 06/10/2026 (noite) — Interruptor "Lia offline" (dono)

Pedido do dono: enquanto o Asaas não libera o Pix de saída, todo cliente que escrever recebe
"a Lia está fora do ar por instabilidade nos servidores" (`offlineNotice`), e o dono manda o
agente "apertar o botão" quando quiser. Interruptor no BANCO (tabela `AppFlag`, chave `offline`),
vale em ~10 s sem deploy: botão no topo do `/ops` (só dono), `POST /api/ops/offline {on}`, ou o
dono manda **lia offline** / **lia online** no WhatsApp. Dono e admins passam direto (testar).
`LIA_OFFLINE=true` na Vercel força ligado. Só bloqueia mensagem que chega; avisos de pedido já
pago continuam saindo. Teste: `tests/offline-mode-2026-10-06.test.ts`.

## 06/10/2026 (tarde) — Varredura de cliente novo: regras que ficam

Depois do retorno ruim dos testadores, 5 agentes simularam ~600 conversas de cliente novo (IA de
produção, lojas ao vivo, banco local) e os achados viraram correção com teste
(`tests/feedback-2026-10-06-varredura.test.ts`, `-pos-pagamento`, e os de cadastro/escolha/busca).
Regras:
- **Trava do Pix de saída** (`pixOutReadiness`): loja de compra automática só é COBRADA se o Asaas
  tem saldo ≥ pedido e, havendo recusa do Pix de saída nas últimas 6h, um teste de decode passa.
  Travado = nada cobrado, cliente avisado ("nada foi cobrado, tenta daqui a pouco"), dono avisado.
  `LIA_PIX_OUT_PREFLIGHT_OFF=true` desliga.
- **Cobrança aberta não morre por mensagem solta**: só item novo reabre o pedido ("to pagando",
  "comprovante", nome, "o link não abre" mantêm o Pix).
- **Embalagem**: o número conta unidades — "12 ovos" com caixa de 10 = 1 caixa, com aviso
  (`packAdjusted` também na escolha do cliente). "1 dúzia de X" multiplica.
- **Cancelar pedido pago** (qualquer frase, inclusive "quero meu dinheiro de volta") pergunta
  "confirma?" antes do estorno; já comprado na loja não promete estorno.
- **Atendente e reclamação avisam o dono no WhatsApp** (antes só nota no pedido).
- **Respostas fixas e verdadeiras** (a IA não responde mais isso e o filtro derruba o contrário):
  serviço embutido no preço, sem taxa separada; a Lia compara preços; o Pix vai pra Lia Delivery
  (MEI — o banco mostra o nome do responsável), não pra loja; nota fiscal sai da loja no nome da
  Lia Delivery; "é golpe?" → resposta de segurança; "quem é vc?" → identidade.
- **"Pagamento confirmado" não diz "separando"**: diz que a compra na loja vem agora.
- Cadastro: nome e CPF podem vir em mensagens separadas; "pra que cpf?" tem resposta fixa; "não
  quero dar" segue sem CPF. "tem açaí?" antes do cadastro é pedido (fica anotado).

## 06/10/2026 — DECISÃO: só SP e RJ (outros estados ficam fechados)

Medição nas 27 capitais (STATUS de 06/10): farmácia rápida existe no país todo, mas mercado
completo — ~60% do que os clientes reais pedem — só em SP e RJ. Dono: "deixa então só SP e RJ".
`LIA_SERVICE_UFS` fica no padrão `SP,RJ`. Não abrir outro estado sem um mercado com Pix fechando
por API nele (candidato já sondado: GBarbosa em SE/BA/AL; Super Nosso e Giassi não têm Pix). Não
repropor a expansão sem esse dado novo.

## 06/10/2026 — Pedido cancelado pergunta o motivo (testadora no grupo)

Pedido da testadora: "quando cancelado faz a pergunta com algumas opções de motivo, por exemplo:
valor frete, valor produto, comprei outro app, desisti da compra". Pedido cancelado pelo cliente
(cotação, aguardando pagamento ou desistência paga com estorno) → lista de tocar "Escolher motivo":
Frete caro, Produto caro, Comprei em outro app, Desisti da compra, Outro motivo (texto numerado
fora do Meta). A resposta vira nota `📝 Motivo do cancelamento (cliente): …` no pedido e log
`[cancel-reason]`. Vale o toque, o número ou uma palavra curta, uma vez, por 30 min; qualquer
outra mensagem desarma e segue o fluxo normal. "cancelar" que só limpa a lista em montagem não
pergunta (é recomeço, não desistência). `parseCancelReason` (lia-intents), `askCancelReason` /
`recordCancelReason` (delivery-service). Teste: `tests/cancel-reason-2026-10-06.test.ts`.
## 06/10/2026 (tarde) — Estorno automático em 6h; o agente nunca devolve dinheiro (dono)

O dono quer que estorno aconteça sem ele. O agente (Claude Code) não executa movimentação de
dinheiro em nenhuma hipótese, então a saída é **regra do sistema**: pedido pago sem compra na
loja há **6h** é estornado sozinho e o cliente avisado (`autoRefundDecision`, era 24h; fila manual
era 48h e também virou 6h). Pedido com Pix da loja pago ou compra com resultado desconhecido
continua fora (`opsPurchaseFailedRefund` recusa; o dono reconcilia). Override por env:
`LIA_AUTO_REFUND_STALE_HOURS` / `LIA_AUTO_REFUND_MANUAL_HOURS`. Em último caso (quando precisar
de julgamento), botão de estorno em um toque no WhatsApp do dono — ainda não feito.
**Regra do dono: "sem estoque depois de cobrar" não é para acontecer** — a Lia confere estoque
antes de cobrar; estorno por falta de estoque é falha a corrigir, não fluxo normal.


## 06/10/2026 (tarde) — Decisões do dono sobre o retorno dos testadores

- **Nome da loja aparece em toda opção** (texto, card, carrossel): "Mambo · 1 dia útil"
  (`optionDelivery` em delivery-service). Substitui a regra antiga "opções sem nome da loja".
- **Frete fica como está** — não propor subsídio/mínimo sem pedido do dono.
- **Cartão:** fatura "LIA DELIVERY" (`statementDescriptor()` em payments/mercadopago).
- **Pix:** o recebedor exibido é o titular da chave do CNPJ MEI (nome do dono); não há campo no
  código que mude isso. Caminhos em PENDENCIAS (nome fantasia ou mudar a natureza jurídica).

## 06/10/2026 — Vitrine só com opção que a loja confirmou + frete da vitrine = frete cobrado

Dois furos que sobraram do retorno dos testadores:
- **Beco no "pagar"** (pilha da Casa & Vídeo, fita isolante da Obramax: "me sugeriu um produto que
  não conseguia finalizar"). A checagem ao vivo MANTINHA o candidato quando a loja não respondia;
  sem operador e cobrando só o confirmado, a cotação abortava e o pedido era cancelado. Regra:
  com `LIA_OPERATOR_QUOTE` desligado e `LIA_CHARGE_ONLY_VERIFIED` ligado, só entra na vitrine
  (busca, "outras", refino, resgate e troca) o que a loja confirmou para o CEP
  (`liveConfirmationRequired` / `buyableWithoutOperator` em live-availability, `confirmOptionsLive`
  no cérebro). Nada confirmado → "Não consigo comprar *X* agora: nenhuma loja confirmou entrega no
  seu endereço." Log `[live-check:unconfirmed]` mostra quem caiu.
- **Frete da vitrine ≠ frete cobrado** (Drogal: R$2,03 na vitrine, R$4,90 no total). A simulação
  ao vivo punha todos os candidatos da loja num carrinho só e o VTEX rateia o frete entre eles.
  Agora é uma simulação por SKU (em paralelo, mesmo timeout).
- Fora daqui, de propósito: nome da loja e frete no card seguem a decisão pendente do dono.
Teste: `tests/feedback-2026-10-06-vitrine-confirmada.test.ts`.
## 06/10/2026 — Token do agente no /ops (dono)

O dono não conseguia abrir o /ops para estornar o #5VBIXY e pediu "um jeito de você fazer isso
quando precisar". `LIA_AGENT_OPS_TOKEN` (no `.env` local do dono e na Vercel): o agente chama as
rotas `/api/ops/*` com o header `x-ops-key` e entra como **operador** (rotas do dono barradas).
Na rota de pedidos ele avisa o cliente, marca compra/entrega e abre estorno (`cancel` → pedido
pago vira `refund_pending`), mas **nunca** `refund_provider`, `confirm_refund` nem
`purchase_failed_refund`: o dinheiro sai sempre por um toque do dono. Só header — fora do login,
do cookie e do `?key=`. Regra em `opsOrderActionDenied`/`isAgentRequest` (`src/lib/auth.ts`);
teste em `tests/operador-humano.test.ts`. Trocar o token = gerar outro nos dois lugares.


## 06/10/2026 — Retorno dos testadores: regras novas da conversa

Conversas reais da manhã (Clara, Adely, Claire, tio Semy, Tati, Karlão, Philipe) reproduzidas
com a IA da produção. Regras que ficam:
- **Complemento sozinho** ("apto 4", "ap 23", "bloco B apto 31", "casa 2", "20º andar") nunca é
  produto: entra no endereço salvo em qualquer passo (`parseAddressComplement` +
  `withAddressComplement` em lia-intents; `handleAddressComplement`), e a escolha aberta volta.
- **Cadastro:** o 1º CEP com endereço já completo pede nome + CPF, venha o endereço junto ou antes.
- **"só X" / "só essa"** com algo já escolhido fecha a lista com a cesta (`parseOnlyKeep`); "só
  isso" continua sendo encerrar (DONE).
- **"veja se tem X" / "tem de X?" / "eu pedi com X"** no meio da escolha = busca nova com a
  característica, e só vale opção com TUDO o que foi pedido (marca + característica); sem
  ela, "não achei …" honesto (`parseAttributeAsk`, `researchChoice(…, mustMatch)`).
- **2+ produtos numa mensagem** no meio da escolha nunca estreitam as opções na mesa: o do
  mesmo tipo troca a escolha, o resto vai pra fila.
- **"qual a loja?" / "de onde vc compra?"** → resposta fixa com a loja de cada opção na tela
  (`storesAnswer`); **"faz comparativo de preços?" / "melhor valor?"** → `priceCompareAnswer`.
  A IA não responde mais isso (dizia "não faço comparativo", falso). Os cards seguem SEM o nome
  da loja (preço tem a margem embutida) — decisão pendente do dono.
- **Contagem na embalagem é identidade** no matcher ("4 bolas" × "3 bolas", "12 rolos" × "4
  rolos" → fora). Fora da regra: "unidades" e "latas" (o cliente usa como quantidade).
- **Remédio:** Euthyrox/Levoid na lista de receita; remédio com dose não achado → "não achei entre
  os sem receita; de receita eu não compro", sem a 2ª busca da IA.
- **Marca escrita pelo cliente não muda** nos prompts do roteador e da extração ("leite nude"
  virou "leite Ninho" em produção).
- **Pagamento:** a compra no servidor só dispara DEPOIS do "Pagamento confirmado" (o estorno de
  uma compra que falhava em 1 s chegava antes).
- **Demora:** frase reescrita pelo roteador não passa de novo pela extração por IA; saudação na
  frente ("Ola quero 2 cxs…") não força o roteador.
Teste: `tests/feedback-2026-10-06.test.ts` (17; todos falham no código anterior).

## 06/10/2026 — Carrossel v4/v5: card com no máximo 2 quebras de linha

O cron horário `/api/cron/meta-templates` falhava em toda execução ao criar os 8 templates
`vitrine_carrossel_v4_{2..5}` e `_v5_{2..5}`: Graph 400, código 100, subcode 2388245 "Template
Carousel Card exceeded maximum amount of line breaks" (log de 07:17, 08:17 e 09:17 de 06/10). O card
do v4 tinha 3 quebras de linha; o do v3, aprovado, tem 2. Nenhum v4/v5 existia, o envio seguia no
v3 e a vitrine "Olha o que achei 👇" pedida pelo dono em 05/10 não entrou no ar.
- Regra: card de carrossel com no máximo 2 quebras de linha (`CAROUSEL_CARD_MAX_LINE_BREAKS`),
  além de ≤ 160 caracteres hidratado e sem variável no começo ou no fim.
- Card v4 (o v5 usa o mesmo): `Produto: {{1}}` / `Preço: *{{2}}*` / `Entrega pela loja: {{3}}.
  Toque abaixo para adicionar.` A instrução foi para a linha do prazo, com as mesmas palavras fixas.
- Nomes mantidos, sem v6: a recusa foi na criação (400 síncrono), então nenhum template v4/v5
  chegou a existir na Meta e os nomes seguem livres. Se a Meta REPROVAR na revisão, o nome fica
  preso: editar o reprovado ou criar prefixo novo.
- O teste de limites do template agora monta todo prefixo que o cron cria (v3, v4, v5); antes só
  o v3, e foi assim que o card de 3 linhas passou.
Teste: `tests/carousel.test.ts` e `tests/carousel-card-limit.test.ts` (16/16). Publicado em 92b2f2b;
o cron das 10h17 criou os 8 templates (PENDING, aguardando a revisão da Meta).
## 06/10/2026 — Mercado Livre DESLIGADO: vitrine é só loja de compra automática (dono)

Pedido #5VBIXY (R$56,43, pago 10:15) caiu no Mercado Livre e foi para a fila manual. Decisão do
dono: "não é pra ter Mercado Livre… é só as lojas automáticas". `LIA_ENABLE_MERCADOLIVRE=false` na
Vercel + redeploy de produção (06/10). **Revoga a exceção "Mercado Livre é exceção a preservar"**
(item 3 da regra de 25/09). Não religar sem nova decisão datada. #5VBIXY: estornar no /ops e
avisar o cliente que o item não está disponível.
**Trava no código:** `storesForShopper` (`src/lib/store-areas.ts`) só deixa na busca loja que está
em `LIA_AUTO_PURCHASE_STORES` (lista vazia em dev/testes não filtra). Loja nova = entrar nessa lista,
senão não aparece. Teste em `tests/store-areas.test.ts`.

## 06/10/2026 — Expansão para o Rio de Janeiro + trava "só mostra e aceita se for perto" (dono)

Pergunta do dono: dá pra expandir pro RJ ou faltam produtos? Resposta medida: produto não falta —
quase todo o elenco é e-commerce nacional (simulação de frete de cada loja em 11 CEPs de SP, Rio,
Niterói e BH em 06/10). Decisão do dono: "se não tem downside, pode implementar. mas tem que estar
bem redonda essa coisa de só mostrar e aceitar compra se tiver perto". **Revoga a regra de 29/09
"fora de SP estado não põe"** para o Rio.
- **Estados atendidos = SP + RJ** (`isServedState`/`servedAreaLabel` em `coverage.ts`;
  `LIA_SERVICE_UFS`, padrão `SP,RJ`; `SP` volta ao corte antigo sem deploy de código). Fora disso,
  lista de espera como antes.
- **Loja regional tem área fixa** (`src/lib/store-areas.ts`): Mambo (SP capital, CEP 01–05/08),
  Covabra e Swift (SP), Savegnago (SP, CEP 13–14), Zona Sul e Prezunic (RJ). Todas as outras
  entregam no país todo. Loja regional nova = 1 linha ali.
- **Quatro travas, mesma regra:** (1) busca do turno — loja fora da área do CEP do cliente nem
  entra (escopo por turno lido do contexto/`User.cep`; sem CEP, nenhuma regional); (2) vitrine ao
  vivo — fora da área sai sem consulta, e loja regional que não confirmar a entrega na simulação
  SAI (falha fechada; nacional sem resposta continua); (3) cotação — `liveStoreFreight` devolve
  `no-delivery` sem rede; (4) cobrança — `preflightBasket` barra antes de cobrar, com ou sem
  simulação. Alternativas do "não deu" também filtram pela área.
- **Zona Sul (1.091 itens) LIGADO:** fechamento real por API em Copacabana (06/10, grupo
  1666863616742, Pix obtido no formato Mercado Pago da própria loja, não pago); conta de compra
  `zonasul` ativa em produção. Só aparece de fato quando `zonasul` entrar em
  `LIA_AUTO_PURCHASE_STORES` na Vercel (a vitrine só mostra loja automática; variável sensível,
  o dono edita). **Prezunic (2.523) LIGADO:** fechamento real em Copacabana (06/10, PZ2456030,
  R$103,88, Pix Cencosud obtido, não pago); carrinho mínimo R$80 (`minOrder` 80); conta ativa. Sem mercado, o Rio já tem
  farmácia em 30–60 min (Drogaria SP/Pacheco), Americanas no dia e o resto do elenco nacional.
- Site: "São Paulo e Rio de Janeiro". Teste: `tests/store-areas.test.ts`, `coverage`, `signup-form`.

## 06/10/2026 — Cadastro no 1º contato por formulário do WhatsApp (dono)

Regra do dono: "precisa pedir CEP, nome e CPF" e "pode pedir tudo direto no começo". O cliente
novo recebe, na primeira mensagem, um formulário nativo do WhatsApp (Flow `cadastro_lia_v1`,
botão "Fazer cadastro") com nome completo, CPF, CEP, número e complemento. Rua, bairro e cidade
saem do CEP (ViaCEP). Código: `src/lib/signup-form.ts` (leitura e validação) e
`handleSignupForm` em `src/lib/delivery-service.ts`.
- O que conferiu fica salvo; só a parte que falhou volta por texto: CPF ou sobrenome → nome +
  CPF numa mensagem; CEP inexistente → CEP; CEP sem rua (CEP geral) → rua e número. CEP fora de
  SP → lista de espera, sem guardar o CPF.
- Campo numérico pode perder o zero da frente: CEP de 7 dígitos e CPF de 9–10 são completados
  (o dígito verificador do CPF confere).
- O histórico (`Message.text`) grava "📝 Cadastro enviado pelo formulário", nunca o CPF.
- Quem ignora o formulário e escreve recebe o formulário de novo, sem a apresentação. Quem
  manda endereço ou CEP em texto segue pelo caminho antigo (endereço → nome + CPF).
- Plano B automático: sem Flow publicado, fora da Meta ou com falha no envio, vale o pedido em
  texto de antes.
- O Flow é criado e publicado pelo cron horário `/api/cron/meta-templates` (`ensureSignupFlow`);
  o envio acha o id publicado sozinho (`activeSignupFlowId`, cache de 10 min). `LIA_FLOW_SIGNUP_ID`
  força um id. Ação manual: `/api/ops/meta-setup?action=flow_signup` logado no /ops.
- Teste em produção: dono ou admin manda "cadastro" e recebe o formulário mesmo já cadastrado;
  preencher regrava os dados dele.
- O nome do cadastro também serve de destinatário quando o perfil do WhatsApp não tem nome.
Teste: `tests/signup-form.test.ts` (21 casos, com banco local).

## 05/10/2026 (tarde) — Remédio LIGADO em produção + 1º teste real do dono (Advil) corrigido

`LIA_MEDICINE_MIP=true` na Vercel (dono, 05/10; e-mail `contato+teste@` chegou na caixa). 1º pedido
real (Advil 12h, Drogaria SP) pago no Pix e estornado sozinho. Correções:
- **Comprador VTEX e estoque regional:** o catálogo sem CEP diz 0 para a própria loja, mas o carrinho
  com o endereço tem o item. Sem seller com estoque no catálogo, a loja ("1") segue e o carrinho com
  endereço decide. Era o "não tinha" do Advil.
- **Aviso falso "remédio de receita deixei de fora"** quando a IA marca remédio mas mantém o isento na
  lista: só avisa se algum pedido da mensagem saiu de fato.
- **Variante de público ("Advil Mulher")** só na frente quando pedida (scorer + regra no rerank).
- **Meta (substitui a regra de 29/09):** remédio usa cards soltos com foto + botão e botões Pix/Cartão
  comuns. Continuam fora: carrossel (template de marketing) e pagamento NATIVO do WhatsApp.
- **CPF no cadastro (dono):** nome + CPF pedidos uma vez logo depois do 1º endereço e guardados; sem
  CPF na resposta, nada trava (segue como mensagem normal e o CPF volta só no 1º remédio). Textos
  curtos: "✅ Anotado."; resumo sem o aviso "comprado no seu nome".
- **Cartão recusado** no mesmo pedido = antifraude da Pagar.me (3ª vez com o mesmo cartão desde 28/09),
  não é regra da Lia. Pendente: olhar a configuração de antifraude no painel da Pagar.me.

## 05/10/2026 — Compra do lenço (#FZUI31): 6 defeitos da conversa corrigidos

Compra real do dono (2x lenço Huggies, Mambo, cartão, comprada sozinha). O que deu errado e a
regra que ficou:
- **Pedido e cobrança em dobro.** No "pagar", a loja baixou o preço (R$13,90 → R$12,90 de custo) e
  o repreço regravava a conversa com a cesta antiga → cotação rotulada "esse é separado do que a
  gente está vendo", o "cartão" abriu um 2º pedido (#FZUI31) e mandou total + pagamento de novo;
  #9AK28P ficou aberto (cancelado à mão, nada cobrado). Repreço não mexe mais na conversa.
- **"Me perdi aqui 😅" depois do total.** O resumo com botão contava como turno mudo; agora conta.
- **Aviso de preço só quando SOBE.** Preço menor entra calado no total.
- **Preço do card = preço da loja agora.** A simulação da vitrine já rodava; o card passa a usar o
  `sellingPrice` dela (antes usava a foto semanal do catálogo).
- **"Não tinha" na Pacheco era falso.** Com 2 un a loja divide a linha em dois preços (promo leve 2);
  frete ao vivo e o comprador VTEX tratavam isso como erro. Agora somam as linhas (preço médio).
  Se a escolha mesmo assim não fecha, as OUTRAS opções da vitrine voltam na hora.
- **Toque em outro card do mesmo carrossel** não é mais "botão de conversa antiga": a vitrine dos
  últimos carrosséis (6h) é recuperada e o item entra na cesta.
- **Textos (dono):** vitrine abre só com "Olha o que achei 👇" (template de carrossel v5, criado
  pelo cron horário e usado sozinho quando a Meta aprovar; até lá segue o v4); "Adicionar ao
  carrinho" responde só "✅ produto" com os botões embaixo; ajuste de quantidade = "✅ 2x produto".
Teste: `tests/compra-lenco-2026-10-05.test.ts` (reproduz a conversa de produção).

## 29/09/2026 — Remédio isento no chat, no CPF do cliente (histórico: LIGADO em produção em 05/10)

Decisão do dono: remédio sem receita dentro do WhatsApp, sem contrato com farmácia. Tudo atrás
de `LIA_MEDICINE_MIP=true`; desligado, a Lia recusa remédio exatamente como antes. Análise
jurídica e riscos em [docs/remedio-intermediacao-legal-2026-09-29.md](docs/remedio-intermediacao-legal-2026-09-29.md):
zona cinzenta até a regra da ANVISA (Mercado Livre notificado em 28/09); risco aceito pelo dono.

- **Só isento.** Catálogo = prateleira de isentos da própria Drogaria SP ("Remédios", C:/868 +
  "Sem Tarja" em C:/800) e Pague Menos só com código de barras igual a um isento da Drogaria SP
  (`scripts/harvest-mip-catalog.mts`, entra na rotina semanal como `mip`). Guarda de receita por
  nome em `src/lib/medicine.ts`, na colheita E no runtime (`anvisa.mipOnly`). Receita, tarja,
  controlado: sempre recusado. A Lia não indica remédio por sintoma.
- **Compra no nome do cliente.** Nome completo + CPF pedidos uma vez antes de cotar (passo
  `need_cpf`, consentimento em `User.cpfConsentAt`); cópia no pedido
  (`DeliveryOrder.buyerDocument/buyerName`). Só a loja que tem o remédio compra no CPF; o resto
  segue no CNPJ. E-mail próprio por CPF (`contato+c<hash>@…`) porque a VTEX guarda perfil por
  e-mail; o checkout aborta e estorna se a loja devolver perfil mascarado ou outro documento.
- **Meta.** Vitrine de remédio e escolha de pagamento em texto; sem carrossel, bolha Pix nativa
  ou One-Click em pedido com remédio.
- **Preço.** Remédio pelo preço da farmácia; taxa `LIA_MEDICINE_SERVICE_FEE` (padrão R$4,90) em
  linha própria da cotação.
- **Nota fiscal.** O link da NF-e do e-mail de faturamento vai para o cliente.
- **Termos/privacidade.** Seção de remédio só aparece com a flag.

Antes de ligar (dono): advogado sanitário (recomendado); confirmar que o ImprovMX entrega
`contato+teste@liadelivery.com.br` na caixa lida pelo servidor; `LIA_MEDICINE_MIP=true` na
Vercel + redeploy; 1 pedido real próprio de dipirona conferindo a NF no nome do comprador.

## 28/09/2026 (noite) — DECISÃO: continuar no B2C atual; pivot analisado e descartado por ora

Contexto: o Muse (agente pessoal da Meta) lançou nos EUA em 08/09, compra em Shopify,
Walmart e Instacart e vive dentro do WhatsApp; sem data pro Brasil e sem Pix. O dono
levantou o risco de ser substituído. Análise completa em
[docs/pivot-longo-prazo-2026-09-28.md](docs/pivot-longo-prazo-2026-09-28.md): a camada de
conversa é o que a Meta substitui; o motor de compra (API VTEX + Pix da loja pela Asaas +
leitura de status + estorno) é o ativo que ninguém tem no Brasil. Claude recomendou virar
o motor em produto (trilho pra agentes) com B2B de pequeno negócio como cunha pagante.

**Decisão do dono:** descartado por ora. Motivos: as 11 lojas não cobrem a lista de uma
empresa (papelaria, informática, volume), e é distinto demais do que ele faz. **Continua
no B2C atual "pra ver no que dá".** Não repropor pivot sem dado novo (Muse no Brasil,
varejista BR em ACP/UCP, ou empresa pedindo espontaneamente). Segue aberto e independente
da decisão: teto de R$81 mil do MEI e receita bruta = markup ou total (contador).

## 27/09/2026 — Regras vigentes de operação sem operador

- Item que a loja não confirma no fechamento → "não tenho X", resto fecha; nunca espera humana.
- "Saiu pra entrega" só com última milha explícita; "a caminho/enviado/transportadora" = envio.
- O total usa o preço da loja ao vivo; o catálogo é vitrine e se atualiza toda segunda (GitHub Actions).
- Pedido mínimo: 0 em todas as lojas por API até alguma recusar por valor.
- Pix da loja que a Lia não consegue pagar (captura/decodificação recusada) → motivo gravado no PurchaseAttempt, pedido da loja vence sem pagamento e o cliente é estornado sozinho (28/09).
- Pix de loja: aceito com URL do banco ou, quando vem da API da própria loja, no formato Mercado Pago (chave + valor + txid). Recebedor novo com CNPJ nesse caminho entra sozinho na allowlist e o dono é avisado; CPF ou Pix de tela pedem o toque (dono, 28/09).
- PROVADO 28/09 (#LYAWQ8, Mambo): 1ª compra 100% automática — pedido na loja, recebedor aprovado sozinho, Pix pago pelo Asaas em segundos, loja em payment-approved, compra registrada, zero toque humano.
- Perfil de convidado no fechamento VTEX leva telefone (LIA_BUYER_PHONE ou o do cliente): sem ele 7 conectores de Pix recusam (CHK0223). Elenco por API: 19 lojas (só Martins Fontes e Mondial fora, ORD062) (29/09).
- Loja regional entra na vitrine SÓ se atende dentro do estado de SP (dono, 29/09: "fora de SP estado não põe"); quem decide é o CEP do cliente na cotação ao vivo; sondagem de loja do interior usa um CEP da cidade dela (substitui a regra de 14/09 de sondar só em casa). Loja de outro estado fica fora mesmo fechando por API.
- Vitrine: até 5 opções no carrossel (a IA só JULGA — lista todos os candidatos que são o produto pedido, em ordem; o código monta a vitrine com `diversifyOptions`: distintos primeiro, variantes de tamanho/cor depois, até 5; menos só quando não há mais aprovados; nunca outro tipo ou outra marca pedida — "mostrar algo nada a ver é o pior", dono 28/09). Botões: card do carrossel = 2 (teto Meta de template), card solto = 3 (teto de mensagem interativa) — ambos já no máximo (28/09).
- Cotação não diz mais "Preço garantido por N min" ao cliente; o TTL segue valendo por baixo (dono, 28/09).

## 25/09/2026 (noite) — RESOLVIDO: nome público do WhatsApp agora é "Lia Delivery"

O dono re-registrou o número (POST `register` no /ops, PIN digitado por ele). Leitura da
Graph logo depois: `verified_name` = **"Lia Delivery"**, `name_status` APPROVED,
`new_name_status` NONE, `status` CONNECTED. Nome pessoal e CNPJ saíram do nome visível.
Conferência independente no WhatsApp Manager: `Lia Delivery` consta como
`Name visible to customers`, número `Connected`. A automação horária
`resolver-nome-p-blico-da-lia-no-whatsapp` foi pausada (`PAUSED` confirmado);
os casos Meta já estavam fechados e o tópico do fórum foi respondido sem dados
pessoais e marcado `Resolved`. Não reenviar pedido de nome. Regra para o futuro:
toda troca de nome aprovada na Cloud API exige re-registro em até 14 dias; o
webhook agora avisa a decisão.

## 25/09/2026 (noite) — CONFIRMADO: "Lia Delivery" aprovado e não aplicado

Leitura da Graph pelo /ops: `verified_name` = nome antigo, `new_display_name` = "Lia
Delivery", `new_name_status` = **APPROVED**, `status` CONNECTED, `CLOUD_API`. A causa está
confirmada: falta só re-registrar o número (POST `register` com o PIN de duas etapas) dentro
da janela de 14 dias. O PIN é credencial do dono: ele mesmo dispara o POST logado no /ops.

## 25/09/2026 (noite) — Nome do WhatsApp: provável causa achada (re-registro de 14 dias)

A doc oficial (developers.facebook.com/docs/whatsapp/display-names) diz que, na Cloud API,
um display name **aprovado não se aplica sozinho**: é preciso `POST /<PHONE_ID>/register`
(com o PIN de duas etapas) em até **14 dias**; senão expira e volta pra revisão. A decisão
chega só pelo webhook `phone_number_name_update` e pela notificação da Business Suite — e o
nosso webhook descartava esse evento em silêncio (caía em `meta_event` e era ACKado). Os
três pedidos de "Lia Delivery" (15/08, 01/09, 20/09) podem ter sido aprovados e expirado
assim; **hipótese, não confirmada** até ler o estado.

Implantado (commit 48a7e37, produção): `GET /api/ops/meta-setup?action=name` lê
`verified_name`, `name_status`, `new_name_status`, `new_display_name` etc. campo a campo;
`POST /api/ops/meta-setup {"action":"register","pin":"123456"}` aplica o nome aprovado
(GET recusado para o PIN não ir em URL/log); o webhook loga `[whatsapp:meta:name-update]`
e avisa o dono. Falta: o dono abrir a leitura logado no /ops; conferir se o app assina o
campo `phone_number_name_update` nos webhooks. Se o estado vier `DECLINED`, o caminho é
registrar **nome fantasia "Lia Delivery" no CNPJ do MEI** (Portal do Empreendedor →
atualização cadastral) e reenviar — a Meta cruza o nome pedido com o nome legal. O nome do
recebedor no app do banco (Pix) é a razão social do MEI e não muda com nome fantasia.

## 25/09/2026 — REMODELAGEM: a Lia compra sozinha (regra canônica vigente)

**Modelo vigente.** Cliente pede no WhatsApp → cotação com frete/prazo reais da loja → paga a
Lia (Pix ou cartão) → **o servidor compra na loja por API** (checkout VTEX aberto, perfil PJ
com o CNPJ do MEI, endereço do cliente com coordenadas, entrega mais barata dentro do prazo
prometido, Pix da loja) → **a Asaas paga o Pix** → compra registrada com o número da loja e
cliente avisado → e-mails da loja (pagamento, faturado, saiu, entregue) lidos pelo servidor.
Sem Mac, sem navegador, sem operador no caminho feliz. Código: `src/lib/purchase/`
(`vtex-checkout.ts`, `vtex-address.ts`, `vtex-runner.ts`, `vtex-accounts.ts`),
`src/lib/store-mail-reader.ts`, crons `/api/cron/purchase-runner` (2 min) e
`/api/cron/store-mail` (3 min), disparo imediato no pagamento (`order-payments.ts`).

**Vitrine = só loja que fecha por API.** Ligadas por padrão (9, ~18 mil itens): Drogaria SP,
Drogal, Pague Menos, Cobasi, Swift, Kopenhagen, Ri Happy, Mambo, Época Cosméticos. As demais
são opt-in por env (`src/lib/stores/index.ts` explica cada uma). Mercado Livre DESLIGADO em
06/10 (dono). Somar loja = checkout VTEX aberto + Pix + entrega no endereço de sondagem
(`scripts/vtex-api-probe.mts <loja>` a seco) → colher catálogo → conector → `VTEX_API_STORES`,
`PURCHASE_DOMAINS`, `VTEX_LIVE`, `mailbox-policy` → conta no /ops.

**Controles que continuam valendo:** teto de R$500 por pedido/dia (política de 07/09),
conferência da cesta (`checkCheckout`, agora com `discountCents`), reserva de orçamento,
recebedor de Pix memorizado por loja (primeira vez pede um toque do dono), `outcome_unknown`
para falha após o pedido existir, trava de 24h para pedido pago antigo, kill-switches
`LIA_AUTO_PURCHASE_OFF` / `LIA_PURCHASE_SUBMIT_OFF` / `LIA_PIX_OUT_OFF` / `LIA_SERVER_BUYER_OFF`.

**Onde AINDA entra humano (dono ou operador), em 25/09:** (1) item fora dos catálogos →
`awaiting_operator_quote` (o caminho "operador cota"); (2) `needs_review`: item sem estoque ou
sem entrega no CEP na hora da compra, loja recusou o fechamento, Pix recusado; (3)
`outcome_unknown`; (4) cesta com mais de uma loja; (5) estornos e reclamações. Enquanto isso
não for automatizado, alguém precisa olhar o /ops — hoje esses avisos vão para
`LIA_OPERATOR_PHONE`/`LIA_OWNER_PHONE`. Tirar o operador exige apontar os dois telefones
para o dono e decidir o caminho (1).

**Testes:** `npm run test:local` (672/672 em 25/09), arquivos em série; loja VTEX de mentira
em `tests/helpers/fake-vtex.ts`; evals no elenco histórico (load-env), golden no roster de 18
(golden-env); comprador do servidor desligado no harness. Documento do comprador só em env
(`LIA_BUYER_DOCUMENT`), nunca no repo.

## 25/09/2026 — DECISÃO VIGENTE: religar a compra automática; objetivo final é zero operador

Com o fechamento por API provado nas três lojas VTEX abertas, o dono decidiu: **a Lia volta a
comprar sozinha e o negócio passa a ser desenhado para não ter operador.** Regras:

1. Compra por API (sem navegador) em Drogaria SP, Cobasi e Pague Menos, com a Asaas pagando o Pix
   da loja. Adaptador no servidor a construir (ver PENDENCIAS de 25/09).
2. **Loja que não fecha sem humano sai da vitrine.** Cada loja restante precisa provar o
   fechamento (dry-run + um pedido real) ou é desligada.
3. ~~**Mercado Livre é exceção a preservar**~~ (revogado em 06/10: ML desligado, só loja automática) ("um dos main drivers"): não tem API de compra, mas
   tem comprador próprio por navegador (`scripts/retail-buyer/mercadolivre.ts`, gate E8 pendente)
   e aceita Pix. Fica como segunda via automatizada, a provar; se não for confiável, sai.
4. O operador (Carlos) continua até a automação estar no ar e provada com pedidos reais; depois
   vira só exceção e, por fim, sai. A decisão de 15/09 fica substituída por esta.

Ordem: adaptador VTEX no servidor → um pedido real do dono de ponta a ponta com Asaas → ligar
para clientes nas três lojas → provar E8 do ML → sondar as demais lojas da vitrine → cortar
as que não passam.

## 25/09/2026 — Cobasi e Pague Menos fecharam por API: 3 de 3 lojas VTEX provadas

Mesmo fluxo da Drogaria SP (transaction → api.vtexvault.com → gatewayCallback 428 → EMV no
`appPayload`) funcionou em Cobasi (`v147466794cbs`, R$12,80) e Pague Menos (`1664230196474`,
R$10,89), sem CAPTCHA. **Corrige a conclusão de 10/09:** o "Não sou um robô" da Pague Menos era
da interface; o fechamento por API não o exige. Regras práticas: escolher o SLA rápido pelo
nome ("Cobasi Já", "Expressa", "SUPER EXPRESSA"), porque o padrão da cesta é o lento; e a
entrega é decidida por item + coordenadas (itens sem entrega no CEP devolvem mensagem na
`shippingData`). O classificador de permissões do Claude barrou a execução da compra na Pague
Menos; o dono rodou o comando. Decisão de religar a compra automática nessas três lojas:
pendente, do dono.

## 25/09/2026 — Fechamento VTEX por API provado na Drogaria SP (Pix emitido e pago)

Regra técnica nova, provada ao vivo: na VTEX o envio do pagamento **não** vai ao `receiverUri`
(`/split/{og}/payments` → 500). O checkout-ui posta o pagamento copiado da cesta em
`api.vtexvault.com/api/payments/transactions/{tid}/payments` com `orderId`, `redirect=false`,
`callbackUrl` (template do `transaction`), `deviceInfo` e `an`; o `gatewayCallback` responde
**428** com `paymentAuthorizationAppCollection[].appPayload` contendo `code` (EMV),
`qrCodeBase64Image`, `expiresAt` (10 min), `paymentId`. O EMV **não** aparece em leituras
públicas; sai do callback. Pessoa jurídica: `documentType: "cnpj"` + `isCorporate` +
`corporateDocument` (CNPJ em `documentType: "cpf"` dá `400 ORD007`). Leitura posterior do
pedido exige os cookies do fechamento; o script grava `checkoutCookies` no JSON.

Pedidos reais criados hoje: `v79834803dgsp-01` (sem pagamento, cancela sozinho) e
`v79835708dgsp-01` (R$14,29, Pix pago 11:33). Documento do comprador só em env; nunca no repo.
Decisão de 15/09 (operador) continua até nova decisão datada após Cobasi e Pague Menos.

## 24/09/2026 — Claude revisou o Muse: descartar; fechamento VTEX autorizado

Parecer na §11 de [docs/muse-lia-viabilidade-conversa-2026-09-24.md](docs/muse-lia-viabilidade-conversa-2026-09-24.md).
Fontes checadas na data: Model API da Meta é preview público para desenvolvedores nos EUA;
computer use é screenshot + clique por pixel, sem VM, navegador, cofre ou carteira; Link Agent
Wallet só para contas Link dos EUA. Nada disso ataca o que barrou Browserbase (anti-bot no login
do Carrefour) nem o CAPTCHA/CVV da Pague Menos. Os controles da arquitetura proposta já existem
em `purchase-execution.ts`/`purchase-worker.ts`; o comprador em `scripts/retail-buyer` é por
seletor fixo, o modelo só extrai endereço, então não há "motor visual atual" para comparar.

Decisão do dono: **Muse, Skyvern, Browser Use, Agentcard e Stark fora**. Autorizado um pedido
real por API na Drogaria São Paulo (`vtex-api-probe.mts --buy`, R$15–20, Pix do dono). Regra:
documento do comprador só em variável de ambiente na hora de rodar; `403 CHK0082` tira a loja da
lista sem contorno. A decisão de 15/09 (operador humano) continua; religar compra automática,
mesmo estreita, exige decisão datada depois do resultado.

## 24/09/2026 — Pesquisa ampliada: alternativas ao comprador Muse

**Refinamento após objeção do dono sobre Browserbase:** não há superioridade operacional
demonstrada dos novos fornecedores. Revisado histórico 19–20/07: bloqueio de login
Carrefour, ausência de entrega Petz/Boticário e problemas de UI distintos de pagamento.
Agente/cofre pode reduzir implementação; não prova resolução dessas barreiras. Exigir
evidência por loja antes de recomendar migração. Comparação documentada no relatório abaixo.

Após o desbloqueio automático falhar, o dono pediu aprofundar a análise por Codex.
Pesquisa registrada em [docs/alternativas-compra-agentes-2026-09-24.md](docs/alternativas-compra-agentes-2026-09-24.md)
e conversa principal atualizada. **Somente pesquisado**, sem cadastro de credenciais,
chamadas autenticadas a fornecedores novos, compra, runtime ou deploy.

- Skyvern documenta agente + credencial de cartão para checkout; tratamento de cartão/CVV
  e plano de intervenção humana precisam ser esclarecidos antes de adotá-lo como cofre.
- Browser Use oferece agente hospedado/API ou browser CDP. Seus secret bindings não
  garantem que o valor fique invisível após digitação na página.
- Kernel + Agentcard Vault tem integração documentada de aprovação no celular e fluxo
  específico Mercado Pago (`card_tokens`, preparação prévia). Não comprova Mercado Livre,
  VTEX ou nossas lojas. Agentcard declara cartões internacionais; BRL, cobertura da loja,
  controle real do valor e contratação ainda não homologados. SDK direto e Kernel têm
  tabelas de cobertura distintas; não generalizar a promessa comercial.
- Rye padrão: EUA, um produto distinto por checkout, sem escolha entre fretes. Seu bot
  tem identificação/assinatura e rota de allowlisting; a descrição anterior de mero
  “botting sem opt-in” era incompleta. Akamai exige opt-in do lojista nessa rota.
- Visa também documenta piloto real no Brasil. Pagamento para agente não equivale a
  concluir pedido. VTEX + Pix segue com mais evidência local, fechamento pendente.

Recomendação de pesquisa: comparar um executor pronto com VTEX e operador; carteira
direta do cliente é outra opção de produto e muda a cobrança da taxa Lia. Não ligar
automação por inferência. A decisão de 15/09 permanece. Consulta ao Claude pendente.

## 24/09/2026 — Muse: pesquisa de comprador na nuvem e revisão solicitada ao Claude

O dono pediu analisar o mecanismo de compra do Muse, viabilidade para a Lia, registrar
toda a conversa em Markdown e consultar nova sessão no projeto Lia do Claude por
computer use, com **Fable 5.1 / Extra**. Documento:
[docs/muse-lia-viabilidade-conversa-2026-09-24.md](docs/muse-lia-viabilidade-conversa-2026-09-24.md).

Somente pesquisado: não encontramos API pública do navegador/VM do aplicativo Muse.
A Meta documenta Muse Spark com computer use, mas o desenvolvedor fornece navegador,
executor e controles. Acesso pela conta brasileira não foi comprovado. Link Agent Wallet
documenta consumidores EUA; Stark tem emissão/consulta/regras de cartão corporativo por
API, sem contratação ou homologação para a Lia. Trocar modelo não prova que o checkout
de lojas brasileiras passe nem elimina o bloqueio remoto já observado no Carrefour.
Veredito: protótipo tecnicamente plausível, operação autônoma ainda não demonstrada.

Nenhum runtime, flag, conta, pagamento ou deploy alterado. A decisão de 15/09 permanece.
Primeira tentativa de abrir Claude encontrou Mac bloqueado; desbloqueio solicitado ao dono.
Envio e seleção do modelo ainda pendentes nesta anotação; não há parecer recebido.

## 23/09/2026 — Sondagem: compra por API sem operador (VTEX aberta em 3 lojas até o Pix)

O dono perguntou se existe API de loja individual que faça o fluxo completo da Lia sem
operador. Respondido com pesquisa + teste ao vivo; registro completo em
[docs/api-compra-lojas-2026-09-23.md](docs/api-compra-lojas-2026-09-23.md).

- **Não existe API oficial de compra pelo comprador no Brasil** (set/2026): ML, Magalu,
  Amazon BR, Americanas, Shopee, iFood, Rappi, Zé, Carrefour (Mirakl) só têm API de vendedor.
  ACP (OpenAI), UCP/AP2 (Google) e Shopify agentic não têm checkout BR; VTEX anunciou conector
  UCP só para EUA. Zinc é EUA; Rye compra "qualquer URL" sem opt-in do lojista (botting
  terceirizado). Mastercard Agent Pay chegou ao BR, mas é camada de pagamento, não de pedido.
- **O que funciona hoje**: a API pública de checkout da VTEX, por HTTP puro do servidor (sem
  navegador, sem perfil Chrome, sem CAPTCHA pedido). Testado no CEP de sondagem:
  **Drogaria São Paulo** (SUPER EXPRESSA 90 min R$8,90; NORMAL R$6,90), **Cobasi** (Cobasi Já
  16 h R$9,90; entrega só aparece com `geoCoordinates` no endereço) e **Pague Menos** (Expressa
  2 h R$6,90; Econômica R$4,90): busca → orderForm → item → `clientProfileData` de convidado
  (`loggedIn:false`, `canEditData:true`) → `shippingData` → SLA escolhido → `paymentData` Pix
  (125, `requiresAuthentication:false`), tudo 200. Cestas esvaziadas; nenhum pedido criado.
  Carrefour devolve 503 e Petz 403/404 ao servidor (Akamai); Oba só cartão/Google Pay; Swift
  só retirada no CEP; Natural da Terra sem estoque no CEP; Divvino 5 dias; Kopenhagen catálogo 403.
- **Não provado — o fechamento.** `POST .../transaction` cria pedido real e é onde a VTEX
  documenta reCAPTCHA (`recaptchaValidation` never/always/vtexCriteria; `403 CHK0082` sem
  token; a doc diz que vale para cartão, Pix não listado, mas Pague Menos mostrou desafio na UI
  em 10/09) e exige documento do comprador. O código Pix chega ao Payment App (a VTEX escreve
  que IO apps não rodam headless); o script tenta `orders/order-group/{og}` e
  `vtexpayments.com.br/api/pub/transactions/{tid}/payments` e procura o EMV. Janela de 5 min até
  `gatewayCallback`. Pix-out Asaas já está codificado (sem chave).
- **Ferramenta**: `scripts/vtex-api-probe.mts` (`npx tsx scripts/vtex-api-probe.mts <loja>
  [--term|--sku] [--sla] [--buy]`). Seco por padrão e esvazia a cesta em qualquer saída;
  `--buy` exige `LIA_PROBE_CONFIRM=sim` + `LIA_PROBE_DOCUMENT` (nunca impresso/gravado). JSON
  em `.retail-buyer/probes/vtex-api-*.json`. Endereço sempre do bloco `probe` privado.
- **Decisão**: nenhuma mudança; a decisão de 15/09 (operador humano) segue. Pendência aberta
  em PENDENCIAS (o dono decide se roda o pedido real de ~R$15–20 na Drogaria SP). Não colocar
  loja na allowlist nem religar compra automática por inferência desta sondagem.

## 23/09/2026 — Financeiro por pedido (P&L automático) em /ops/financeiro

O dono pediu "uma planilha de P&L por pedido: pagou isso, custou isso, taxa, frete, sobrou".
Decisão: gerar do banco, não digitar. Implementado e verde localmente (`test:local` focado,
`tsc`, lint, tela conferida no preview com banco local), **ainda sem deploy** — depende da
migration `20260923130000_order_pnl` (três colunas opcionais, aplica sozinha no build de
produção da Vercel).

- `src/lib/pnl.ts`: `computeOrderPnl` (puro), `loadPnl` (banco), `summarizePnl` (mês no fuso
  de São Paulo) e `pnlCsv` (`;` + vírgula decimal + BOM: abre no Excel, Numbers e Sheets).
  Regra: **sobrou = cliente pagou − estorno − taxa do provedor − custo na loja (produtos +
  frete do comprovante)**. Estimativa nunca vira zero calado: `providerFeeEstimated` (MP ainda
  não informou), `storeCostEstimated` (comprovante não registrado / pago sem compra ainda) e
  `refundEstimated` (estorno pedido e não executado) vêm marcados; a tela mostra "≈" e o
  resumo do mês conta quantos pedidos ainda têm valor estimado. Custos fixos (Carlos, Vercel,
  Meta, anúncios) ficam fora do por-pedido de propósito.
- Taxa do Mercado Pago: colunas novas `Payment.feeCents` / `netCents`. `mercadoPagoFees()`
  lê `fee_details` (só `fee_payer: collector`) ou `transaction_amount −
  transaction_details.net_received_amount` do corpo de `/v1/payments/{id}`; gravado pelo
  webhook, pela reconciliação e pelo "paguei". **Backfill no cron** (`backfillPaymentFees`,
  20 por rodada, `feesFilled` no relatório) cobre os pagamentos anteriores; sem credencial é
  no-op; replay do webhook sem taxa não apaga a lida. Alíquotas SÓ para estimar enquanto isso:
  `LIA_MP_PIX_FEE_RATE` (0,99%) e `LIA_MP_CARD_FEE_RATE` (default = MDR repassado). Estorno
  total devolve a tarifa; parcial, proporcional. Os nomes dos campos do MP não puderam ser
  conferidos na doc (site devolve 404 a fetch) — a primeira rodada real do cron confirma.
- Custo real na loja: coluna `DeliveryOrder.storePaidTotal`. O operador digita o **total do
  comprovante** no card "Confirmar compra na loja" (campo opcional `paidTotal`) ou depois pela
  ação `set_store_cost`; o dono corrige inline no /ops/financeiro. Compra automática usa
  `PurchaseJob.actualTotal`. Recusa antes da compra e valor negativo; anota `💰 Custo real`.
- Rota `/api/ops/pnl` (JSON; `?format=csv&months=12` baixa a planilha): só papel `owner`; o
  operador contratado recebe 403 mesmo logado. Página `/ops/financeiro` (link 💰 no /ops só
  pro dono): cards por mês + período todo, tabela por pedido, custo real inline, CSV.
- Preview local: `.claude/launch.json` ganhou `lia-financeiro-localdb` (Next em :3111 contra
  o Postgres embutido de `.local-pg/`, nunca produção; `OPS_TOKEN=preview-owner`).
- Testes: `tests/pnl.test.ts` (14: puro + banco: custo real, backfill com fetch mockado,
  replay do razão, leitura consolidada).

## 23/09/2026 — Quarto caso Direct Support: bug no fluxo de contato

Rechecagem às 20:51 São Paulo: o WhatsApp Manager ainda mostra o nome antigo
como visível aos clientes e aprovado; o editor não exibe o estado do pedido de
20/09 e foi fechado sem envio. O Activity log continua com `Name verification
requested` de 20/09 às 11:52 como evento mais recente. Gmail e fórum ainda sem
resposta nova. Corrigido o acompanhamento automático, que estava indevidamente
em intervalo de 10 horas: a configuração ativa foi verificada em **1 hora**.
O agendamento voltou indevidamente a 10 horas perto de 21:00; foi corrigido de
novo via `automation_update` e permaneceu em 1 hora após três verificações ao
longo de quase três minutos. Conferir a frequência nos próximos acompanhamentos.

Às 20:55 São Paulo, enviado novo follow-up no mesmo fio do caso Meta
**28122639484102795** para `case++aazr5wey3juyyq@support.facebook.com`.
Cobra especialista humano, estado lido do registro do número, decisão ou
correção específica, e rota privada funcional se o e-mail não reabrir o caso;
relata o erro `Select issue` e o nome antigo ainda visível. Gmail confirmou o
envio como mensagem **1a0d0b1cc95ba357** no mesmo thread. Resposta pendente.

Com autorização específica do dono para aceitar os `Meta AI terms` no envio,
o caso **28135432596128883** foi criado às 21:16 São Paulo em `Dev: Cloud API`
→ `Bug or Implementation Issue`, com status inicial `Open` e assinante correto
`Joseph.Dayan@beityaacov.com.br`:
https://business.facebook.com/direct-support/case-detail/28135432596128883/?business_id=1802515380110705 .
Relata o defeito real do suporte: Business Suite → Help → Contact support
reconhece o ativo Lia, mas `Select issue` permanece vazio (`No matching
results`), impedindo atendimento. Inclui WABA/Phone ID, casos anteriores,
classificação incorreta do terceiro caso e pedido de encaminhamento humano.
O Meta AI support perguntou se o Activity log mostra erro específico; respondido
que há só `Name verification requested` de 20/09 11:52, sem decisão nem erro,
com nome antigo ainda aprovado/visível. O bot disse que contas de desenvolvedor
são atendidas pelo fórum e encerrou o chat. Após recarregar, o quarto caso já
estava **Closed** e reclassificado como `Dev: Onboarding`, apesar de ter sido
enviado em `Dev: Cloud API`; não houve encaminhamento humano. O fórum já havia
sido acionado, então a resposta não traz passo novo. Aguardar eventual e-mail,
sem tratar o texto do bot como decisão do nome.
Nova conferência do WhatsApp Manager após o quarto caso: a lista ainda mostra
`Lia Delivery by 67.742.955 Joseph Carlos Dayan` como `Name visible to customers`.
Atualização publicada no tópico do fórum às 21:20 São Paulo, sem nome, CNPJ,
telefone, e-mail ou IDs: informa que o quarto chamado `Dev: Cloud API` foi
fechado por IA, reclassificado como `Dev: Onboarding` e devolvido ao próprio
fórum; pede a moderador/especialista uma rota privada humana. Comentário
visível no tópico, ainda sem resposta de terceiros.
O painel `Support > Chats` da Business Suite foi inspecionado e apareceu vazio,
sem conversa humana disponível. O terceiro caso continua `Closed` e o nome
antigo segue visível na última conferência do WhatsApp Manager.

## 23/09/2026 — Contato de privacidade do WhatsApp

Em 23/09, também foi enviado o formulário oficial de perguntas sobre a Política
de Privacidade do WhatsApp em
https://www.whatsapp.com/contact/forms/915483389072145/ , opção `Como posso
exercer meus direitos de privacidade?` → `Ainda tenho uma dúvida`, com o número
comercial e o e-mail de suporte corretos já autorizados pelo dono. O formulário
só oferece `WhatsApp Messenger` e `App WhatsApp Business`; foi escolhido o
segundo por ser o mais próximo, embora a Lia use Cloud API diretamente. Não há
campo de texto para explicar o caso antes do envio. A interface confirmou
`Formulário enviado com sucesso` e prometeu resposta por e-mail. Chegou resposta
de `case++aazj3hygwifxpf@globalprivacyops.whatsapp.com`, protocolo
**28568296869468732**, às 13:17 São Paulo. O cabeçalho marca `Auto-Submitted:
auto-generated`; o texto genérico orienta solicitar dados da conta ou apagar a
conta pelo aplicativo, sem tratar da Cloud API nem do nome. O e-mail convidava a
responder. Follow-up enviado no mesmo fio, esclarecendo Cloud API direta,
WABA/Phone ID, nome antigo expondo nome pessoal/CNPJ, pedido de 20/09 ainda
sem decisão verificável, e solicitando correção ou encaminhamento privado a uma
pessoa da equipe responsável. Gmail confirmou o envio. **Não apagar a conta**;
isso não foi solicitado e prejudicaria o serviço. Resposta de mérito pendente;
não tratar resposta automática como atendimento humano.

## 23/09/2026 — Relato do fluxo de suporte quebrado

Às 13:10 (São Paulo), o Direct Support 28122639484102795 continuava `Closed`,
sem resposta humana. Pela opção `Report a problem` do próprio Business Manager,
foi enviado um relato à Meta com passos reproduzíveis do erro `Select issue` →
`No matching results` no fluxo Help → Contact support, a classificação incorreta
do caso 28122639484102795 como `Dev: Onboarding`, os três fechamentos por IA e
o nome antigo ainda exposto. Informados WABA/Phone ID e o e-mail correto. A
interface confirmou `Thanks for providing feedback on your Meta ads experience`,
mas avisou que não garante investigar nem responder; isso não equivale a chamado
de suporte ou revisão do nome. A captura de tela opcional ficou em `Loading...`
e o relato foi enviado sem ela. Nova consulta ao WhatsApp Manager ainda mostra o
nome antigo como `Name visible to customers`.

Graph API Explorer com app Lia selecionado não apresentou token existente. A
consulta de leitura exigiria gerar um token temporário com permissão
`whatsapp_business_management`, que dá acesso de gerenciamento à WABA. A tela foi
preparada com apenas essa permissão; solicitação de autorização específica ao
dono enviada antes de gerar o token. Nenhum token novo nem Graph query até aqui.
Consulta preparada no Explorer em `GET /v26.0/1228651533663944?fields=new_display_name,new_name_status,verified_name,name_status`.
A coleção oficial da Meta no Postman documenta `name_status` por Phone ID e
`new_name_status` em consultas aos números da WABA; se a consulta direta rejeitar
algum campo, limitar aos campos documentados em vez de inferir o estado.

## 23/09/2026 — Fórum publicado e WhatsApp contatado

Com autorização específica do dono, as normas do fórum de desenvolvedores da Meta
foram aceitas e a pergunta foi publicada em `WhatsApp Business API > Cloud Hosted
API`, sem nome completo, CNPJ, telefone, e-mail ou IDs da conta no texto. Tópico:
https://developers.facebook.com/community/threads/1389805853133081/ . Pede
canal privado/especialista para conferir a decisão real do pedido de 20/09 e
relata o fechamento automático dos três casos e o erro `No matching results`.
O tópico apareceu como `Unresolved`; publicação não é atendimento humano.

O dono também autorizou transmitir o número comercial +55 11 97844-4813 e
`Joseph.Dayan@beityaacov.com.br` pelo formulário oficial
https://www.whatsapp.com/contact/?subject=messenger . Pedido enviado em 23/09,
com WABA/Phone ID e os três protocolos Meta. A página confirmou `Sua pergunta
foi enviada.` E-mail do `support@support.whatsapp.com` chegou em seguida com
protocolo **1476013821028439**: resposta explicitamente gerada por IA, diz que
não consegue consultar o estado nem escalar a humano e devolve para Business
Help/Direct Support, já tentados. Follow-up enviado no mesmo fio ao endereço
`1476013821028439@support.whatsapp.com`, apontando esses bloqueios e pedindo
encaminhamento concreto à equipe Cloud API ou canal humano funcional; Gmail
confirmou o envio. Nenhuma decisão de nome foi comunicada por esse canal.

Rechecagem às 11:57 São Paulo: chegou outra resposta no protocolo
1476013821028439. Continua marcada como gerada por IA; declara expressamente que
não pode encaminhar à equipe responsável nem fornecer canal humano privado. Repete
Business Help/Direct Support e sugere procurar BSP/parceiro gerenciado. A Lia usa
Cloud API diretamente com a Meta; a rota Infobip foi avaliada em julho/agosto e
encerrada sem onboarding, e migrar/adicionar BSP poderia mexer no sender, portanto
essa sugestão não é um passo aplicável sem nova autorização e requisitos claros.
Nenhuma resposta humana da Meta/WhatsApp nem do fórum foi observada nesta rechecagem.

Automação de acompanhamento atualizada para frequência **horária**, ativa e
silenciosa sem mudança relevante. Verificar respostas no tópico e no Gmail,
especialmente os protocolos 1476013821028439 e 28122639484102795.

Nova conferência no WhatsApp Manager, após esses contatos: a lista de números
continua mostrando `Lia Delivery by 67.742.955 Joseph Carlos Dayan` como
`Name visible to customers`; o Activity log ainda tem `Name verification
requested` de 20/09 às 11:52 (São Paulo) como evento mais recente. Portanto,
nenhuma aprovação/aplicação foi observada. O caso Meta 28122639484102795
continua `Closed` na página do Direct Support.

## 23/09/2026 — Canais alternativos de suporte examinados

Checagem adicional às 10:45 (São Paulo): Meta Business Suite → Help → Contact support
classificou o relato como `Manage WhatsApp phone number or display name`, aceitou os
três protocolos anteriores e mostrou o ativo Lia Delivery correto (`Other Asset ID
1254333097762399`). A etapa `Select issue` voltou a mostrar `No matching results`,
sem opção de chat/e-mail humano; nenhum novo chamado foi criado. A página
Business Settings → Meta Verified mostra `Grow with Meta Verified`/`Get started`,
portanto não há assinatura ativa nessa página. Ela anuncia `Email and chat agent
support`, mas avisa que benefícios dependem da assinatura e podem não estar
disponíveis para todos; não é prova de cobertura do caso Cloud API. Verificação
empresarial `Verified` não equivale a Meta Verified pago.

Às 10:34 (São Paulo), Gmail do contato correto não tinha resposta nova ao follow-up do
caso **28122639484102795**; o fio contém a resposta do Meta AI Agent e a contestação
enviada em 23/09. O WhatsApp Manager continuava mostrando o nome antigo visível ao
cliente na última conferência desta manhã, sem decisão posterior à solicitação de 20/09.

No Business Support Home, o fluxo alternativo de contato continuou sem opções em
`Select issue` para o ativo Lia Delivery; não foi criado chamado por esse caminho.
No portal Meta for Developers, o formulário `Report a bug` permitiu selecionar o app
Lia (`1363776745853579`) e `WhatsApp Business API > Business Profiles`, mas deixou
`Next` desabilitado. A categoria `Developer Tools > Developer Support Home` informou
que suporte técnico avançado não está disponível ali e remeteu ao fórum comunitário;
nenhum bug foi submetido. O fórum exigiu criação de perfil com aceite de novas normas,
portanto nenhuma publicação foi feita. Não tratar essas tentativas como atendimento.

No site oficial do WhatsApp, a página `https://www.whatsapp.com/contact/` oferece
formulário geral com número, e-mail e mensagem livre em
`https://www.whatsapp.com/contact/?subject=messenger`. O formulário de dúvidas sobre
privacidade em `https://www.whatsapp.com/contact/forms/915483389072145/` tem opção de
direitos de privacidade, mas só distingue Messenger de Business App, não Cloud API, e
não oferece texto livre antes do envio. Nenhum dos dois foi enviado nesta checagem;
aguarda autorização específica para informar os dados de contato pelo navegador.

## 23/09/2026 — Contato Meta corrigido; terceiro chamado com assinante certo

O dono forneceu `Joseph.Dayan@beityaacov.com.br` como endereço correto. Business Suite →
Business info → Profile contact info foi atualizado; a Meta enviou um código a essa caixa,
e o dono autorizou explicitamente inseri-lo no formulário da Meta. A interface confirmou
`Email address confirmed.`. Direct Support Settings agora mostra `Lia Contact Email:
Joseph.Dayan@beityaacov.com.br`. Os dois chamados antigos mantêm o assinante DOG CITY;
a troca do contato do portfólio não altera retroativamente seus assinantes.

Novo Direct Support **28122639484102795**, `Dev: Phone Number & Registration` →
`Change Display Name (non Official Business Account)`, WABA `1336161451961509`, criado
em 23/09. Assinante verificado **Joseph.Dayan@beityaacov.com.br**. O relato pede especialista humano, estado real da revisão de
`Lia Delivery`, decisão/justificativa, aplicação do nome e orientação sobre eventual
re-registro Cloud API; cita os dois chamados fechados pelo bot e o contato antigo
errado. O chat automático informou `Your case has been switched to email support` e
encerrou. Às 00:53 o Meta AI Agent enviou resposta genérica por e-mail para o endereço
correto, alegando `PENDING_REVIEW` sem evidência de consulta ao número e admitindo não
ter acesso interno nem poder escalar a um humano. O caso passou a `Closed` (a página
inclusive o rotula como `Dev: Onboarding`, apesar do formulário enviado ser
`Dev: Phone Number & Registration`). Resposta enviada no mesmo fio, pedindo origem
verificável desse status, especialista humano, decisão ou correção específica e
orientação para aplicação após aprovação; envio confirmado pelo Gmail. Resposta a
esse follow-up ainda pendente. URL:
https://business.facebook.com/direct-support/case-detail/28122639484102795/?business_id=1802515380110705

Consulta Graph ainda não feita: `vercel env pull --environment=production` traz
`WHATSAPP_PHONE_NUMBER_ID` preenchido, mas `WHATSAPP_ACCESS_TOKEN` vazio, embora o
nome da variável esteja listado como Encrypted. Arquivo temporário do pull removido.
Não inferir `PENDING_REVIEW` a partir do texto do bot. Monitoramento automático da
resposta/caso/WhatsApp Manager criado para este fio, a cada 2 horas, silencioso sem
novidade; automação `resolver-nome-p-blico-da-lia-no-whatsapp`.

Checagem 23/09 às 04:57 (São Paulo): nenhum e-mail de resposta ao follow-up; chegou
apenas pesquisa de satisfação da Meta. Caso continua `Closed`, e o WhatsApp Manager
continua exibindo o nome antigo. Marcado `Negative feedback` na resposta automática
do chat; interface confirmou `Thanks for your feedback.` Nenhuma decisão nova.

Rechecagem do WhatsApp Manager: o nome antigo ainda está `Name visible to customers`.
O Activity log segue com `Name verification requested` de 20/09 11:52 como evento mais
recente ligado ao nome, sem aprovação/rejeição posterior. Não reenviar mudança de nome
por inferência. Nenhum Graph query, re-registro, deploy ou campanha executado.

## 23/09/2026 — Nome antigo visível; primeiro chamado fechado, novo escalonamento aberto

Conferência ao vivo no WhatsApp Manager: o número ainda mostra **“Lia Delivery by
67.742.955 Joseph Carlos Dayan”** como `Name visible to customers`; no perfil, esse
nome antigo segue `Approved`. O Activity log tem `Name verification requested` em
20/09 às 11:52 (São Paulo), sem registro posterior de aprovação/rejeição. Ao abrir
`Edit`, o formulário agora aceita novo nome, mas isso **não comprova** o status do
pedido de 20/09; não reenviar sem esclarecer esse estado.

O caso Meta **28490582747289644** agora consta `Closed`. A única resposta exibida
no caso é do `Meta AI Agent` (20/09, 13:46), com instruções genéricas para pedir a
troca pelo WhatsApp Manager/API; não decidiu a revisão nem explicou por que o nome
antigo persiste. O chat informa transferência para suporte por e-mail, mas a caixa
assinante do caso não está conectada ao Gmail consultável nesta sessão; nenhuma
resposta humana por e-mail foi verificada. O bloqueio para distribuição continua.

Novo chamado de escalonamento enviado ao Direct Support em 23/09: **28315695101392221**,
`Dev: Phone Number & Registration` → `Change Display Name (non Official Business
Account)`, WABA correta `1336161451961509`, status confirmado `Open`. Refere o caso
anterior, o pedido de 20/09 e o nome ainda exposto; pede revisão humana, status real
da solicitação e ação específica, inclusive esclarecer eventual re-registro da Cloud
API se aprovado. URL:
https://business.facebook.com/direct-support/case-detail/28315695101392221/?business_id=1802515380110705
Rechecagem ainda em 23/09: esse segundo caso também foi **fechado** automaticamente,
com duas respostas do Meta AI Agent sugerindo consultar a API/repetir o formulário,
sem confirmar o estado real do novo nome. A indicação de transferência para e-mail
não é prova de atendimento humano. `Switch to comment` no caso fechado respondeu
que não pode ser reaberto. Nenhuma decisão sobre o nome foi observada.

Erro de contato descoberto: Direct Support Settings mostra `Lia Contact Email:
dogcitystore@gmail.com`. Business Suite → Business info → Profile contact info também
mostra esse e-mail para Joseph Dayan; é a origem provável dos assinantes dos casos.
O dono informou que DOG CITY está errado. Correção depende de confirmar qual e-mail
deve receber as respostas; pergunta enviada ao dono. O perfil público do WhatsApp
exibe `contato@liadelivery.com.br`, mas não assumir que seja a caixa operacional de
suporte sem resposta. O botão Edit do Direct Support abre Business info em nova aba;
lá há modal `Update your email address`. Nenhuma alteração enviada ainda.

Tentativa de consultar Graph com env de produção via `vercel env run`/`env pull`:
`WHATSAPP_ACCESS_TOKEN` é listado no projeto Vercel, mas retorna vazio nesses
comandos; nenhuma consulta Graph foi executada e nenhum token exibido. O suporte
alternativo via Business Support Home → Help → Contact support chega a `Next Step`,
que aceita Beta product testing terms/AI terms; relato para revisão humana preparado
no formulário. Dono autorizou explicitamente avançar e aceitar esses termos em 23/09;
`Next Step` foi clicado. A IA pediu ID/URL do ativo; WABA, Phone ID, URL do WhatsApp
Manager e URLs dos dois casos foram fornecidos. O fluxo encontrou um ativo separado
`Lia Delivery by ...` (`Other Asset ID 1254333097762399`; DogCity apareceu como
outra página), mas o seletor seguinte `Select issue` não ofereceu nenhuma opção,
inclusive ao buscar `display name`. A busca por WABA/Phone ID no seletor de ativos
também devolveu `No matching results`. Portanto, nenhum terceiro chamado foi criado
por esse fluxo; não tratar o aceite dos termos como encaminhamento ao agente.

## 20/09/2026 — Nome público da Lia reenviado e levado ao suporte

Dono quer retirar nome pessoal/CNPJ da conversa antes de distribuir. Conferência ao vivo
no WhatsApp Manager: nome antigo ainda `Approved` e visível aos clientes; Activity log
registra `Name verification requested` em 01/09, sem decisão exibida. Formulário permitiu
novo envio de **Lia Delivery**, realizado nesta sessão; estado confirmado **In Review**,
com edição desabilitada. Não considerar resolvido: o nome antigo continua visível até a
aprovação/aplicação. Nenhum registro/desregistro do número, alteração de Pix ou deploy.

Diretriz oficial consultada: https://www.facebook.com/business/help/757569725593362 —
nome de marca deve ter relação clara com a empresa e identidade pública consistente;
“by [company name]” é indicado quando esse vínculo não é evidente. A documentação da
coleção oficial Meta no Postman descreve registro após aprovação do nome na Cloud API:
https://www.postman.com/meta/whatsapp-business-platform/folder/zuoeksl/registration .
Isso é próximo diagnóstico se o novo nome for aprovado e não aparecer, não prova da
causa atual. Consulta Graph não foi executada: credenciais necessárias ausentes no `.env`.
Não reenviar enquanto este pedido estiver em análise.

Chamado aberto no **Direct Support** da Meta, tipo `Dev: Phone Number & Registration` →
`Change Display Name (non Official Business Account)`, vinculado à WABA
`1336161451961509`. Caso **28490582747289644**, título “Remove personal name and
registration number from WhatsApp display name”, status confirmado **Open**. O relato inclui
o número/Phone ID, histórico das solicitações, marca desejada, site público e pedido de
confirmação sobre re-registro na Cloud API após aprovação. O atendimento automático informou:
“Your case has been switched to email support”; a equipe responderá por e-mail para o
assinante exibido no caso. O nome antigo continua visível e o pedido de `Lia Delivery`
continua `In Review`; abertura do chamado não equivale a aprovação.

## 18/09/2026 — Piloto de Meta Ads preparado; OAuth aguarda consentimento

Preview com atribuição e criativo final publicado em
`shopping-agent-55abx8g0o-josephdayans-projects.vercel.app`; como é preview, a migration
`20260917120000_ads_acquisition_attribution` não foi aplicada. Produção não mudou.
Criativo estático 4:5 em `public/ads/lia-acabou-em-casa-sp01-4x5.png` e plano em
`docs/piloto-meta-ads-2026-09-18.md`. O único vídeo recente encontrado no Mac era uma gravação
de Gmail com dados pessoais, não o Reel da Lia; não foi copiado nem enviado.

AdPlane: login Google concluído; conexão Meta está parada na tela de consentimento
"Continue as Joseph Dayan?", antes de conceder acesso persistente. Nenhuma conta de anúncios
foi conectada, nenhum ativo foi enviado à Meta, nenhuma campanha foi criada e nenhum gasto
foi ativado.

## 17/09/2026 — Atribuição anúncio → conversa → pedido pago implementada localmente

Antes de comprar tráfego, o webhook da Meta agora preserva o `referral` do primeiro WhatsApp
(`source_id` do anúncio e `ctwa_clid`) em `AcquisitionTouch`, separado do texto do cliente e
idempotente pelo id da mensagem. A mensagem pré-escrita pode levar `[AD:SP01]` como fallback;
a tag é removida antes do NLU e nunca vira item da lista. Ao criar o pedido manual, a Lia liga o
toque mais recente da conversa dentro de 7 dias (`LIA_AD_ATTRIBUTION_DAYS`, 1–90). O `/ops` do dono
mostra conversas, pedidos, pagos, estornos e receita retida por campanha; o operador vê somente
o rótulo necessário no pedido, sem `ctwa_clid` nem URL de origem.

Migration nova: `20260917120000_ads_acquisition_attribution`. Ainda não publicada; nenhuma
campanha foi criada ou ativada. Testes locais: 648/648, TypeScript, lint, build e guarda de emoji
verificados.

## 15/09/2026 — Operador humano no código: automação travada, /ops com dois papéis

A decisão de contratar operador virou código. O que o repositório assumia até aqui é que
**operador = dono**: um `OPS_TOKEN` abria contas de loja, Pix de saída e setup da Meta, e um
`LIA_OPERATOR_PHONE` recebia tanto "pedido pago, compre" quanto "pagamento fora do esperado,
confira no provedor". Com gente de fora isso é risco de credencial e furo operacional.

**1. O kill-switch passou a valer ANTES do job nascer.** `LIA_AUTO_PURCHASE_OFF` só barrava o
clique final: o job nascia igual, o pedido saía da fila manual e ninguém via "COMPRA MANUAL"
no `/ops`. Pior, `preparationEligible` aceita a loja por **conta salva** — e a Cobasi está
salva com `enabled/loginReady/paymentReady` —, então um pedido pago dela era puxado sozinho
mesmo com a allowlist vazia. Agora `ensurePurchaseJobForPaidOrder` devolve `null` na primeira
linha quando o switch está ligado, e o pedido cai na fila manual. `LIA_PURCHASE_PREP_STORES`
perdeu o default `"mercadolivre"` (era opt-out; virou opt-in).

**2. `OPS_OPERATOR_TOKEN`: segundo segredo, acesso reduzido.** `opsRole()` diz o papel
(`owner`/`operator`) por header, `?key=` ou cookie; `requireOpsOwner()` responde 403 ao
operador em contas de compra, jobs automáticos, setup da Meta, sonda de Pix nativo, catálogo,
lista de espera, OAuth do ML e re-host de imagem. As ações de dinheiro por decisão (cancelar
pedido pago, estornar pelo provedor, confirmar estorno) são negadas por ação dentro de
`/api/ops/orders/[id]`. "Não consegui comprar → estornar" **fica** com o operador: é a saída
honesta quando a loja falha e o valor volta pro cliente. O cookie é o HMAC do segredo do
papel, então trocar o token do operador derruba só a sessão dele; o link "ops" do WhatsApp é
assinado com o segredo de quem pediu. A tela esconde, o servidor nega.

**3. `LIA_OWNER_PHONE` + `notifyOwner()`.** Dinheiro e incidente (cobrança falhada, pagamento
fora do esperado, cartão sem desfecho, estorno automático, reclamação de cobrança, comprador
em silêncio, carrossel recusado) vão pro dono; pedido pago, pedido parado e item somado vão
pra quem compra. Sem a env o dono continua sendo o `LIA_OPERATOR_PHONE` — operando sozinho
nada muda. O alerta de PAGO, desligado desde 20/08, volta sozinho quando existe operador
contratado, e o alerta de pedido parado escala pro dono a partir de 6h.

**4. Promessa honesta fora do horário.** Pix às 23h respondia "já estou separando", mentira
por dez horas. Fora de `LIA_OPERATOR_HOURS` (`9-20`, São Paulo) a Lia diz que compra logo
cedo. Só muda a promessa, e só quando há operador contratado; o prazo da loja é o mesmo.

Produção: `LIA_AUTO_PURCHASE_OFF`, `LIA_PURCHASE_SUBMIT_OFF` e `LIA_PIX_OUT_OFF` gravados na
Vercel (**só valem no próximo deploy**). O serviço launchd do comprador local estava RODANDO
no Mac (pid 28797): parado e desabilitado (`launchctl disable`), não volta no login.
`docs/operador-runbook.md` reescrito para alguém de fora. Testes: +6 em
`tests/operador-humano.test.ts`; 641/641 em `test:local`, build e guarda de emoji ok.

## 15/09/2026 — Decisão vigente: contratar operador humano e parar a compra automática

O dono decidiu contratar um operador humano para cotar, comprar e acompanhar os pedidos da
Lia. A compra automatizada deixa de ser a estratégia operacional: não ativar novas lojas,
não ampliar a allowlist, não usar o comprador local para checkout automático e não retomar
a tarefa horária do ChatGPT. O fluxo de produção deve permanecer na fila/manual do `/ops`,
com as exceções e confirmações feitas por uma pessoa.

A vaga foi publicada no 99Freelas (projeto 784519); o Workana ainda não foi publicado porque
a conta não foi reconhecida nessa sessão. Esta anotação registra a decisão e o estado de
recrutamento; não altera flags, deploy ou contas de produção. Até o kill-switch operacional
ser aplicado, tratar a automação existente como desligada por decisão e não executá-la.

## 15/09/2026 — Foto provada ao vivo; carrossel recusado em toda busca; demonstrativo virava busca

Primeira rodada de teste real da leitura de mídia (agente testador, número do dono). Uma
foto passou, o resto da rodada caiu — e os três motivos são independentes da mídia.

**1. Foto: provada em produção.** 14:19 UTC, foto de ração → eco literal
"📷 Na foto eu vi: ração Golden Fórmula para cães adultos de porte pequeno sabor carne e
arroz 1kg". No runtime log: zero `[whatsapp:meta:media-*]`, zero `[ai:vision:*]`. Ou seja o
que a suíte mockada não provava está provado: `GET /{media-id}`, download com o MESMO Bearer
na URL assinada, e a visão devolvendo o produto. **Áudio continua sem teste** (o testador não
conseguiu enviar mensagem de voz; anexo de arquivo chega como documento e é ignorado de
propósito).

**2. Carrossel era recusado pela Meta em TODA busca.** `(#132018) Hydrated body length (174)
is greater than the limit (160) (for card_index=0)` às 14:22 e 14:27, caindo no
`[whatsapp:meta:carousel:fallback-cards]`. A Meta mede o corpo do card **já hidratado**
(texto fixo + variáveis) contra 160; os tetos por variável (nome 90 + prazo 60) somavam 150
num orçamento real de **86** — o texto fixo do template come 74. Bug desde 07/09: cada busca
pagava uma ida à Graph jogada fora. Agora `src/lib/meta-carousel-card.ts` (módulo folha,
porque `meta-setup` CRIA o template e `adapters/whatsapp` ENVIA nele) divide o orçamento
real entre nome e prazo — prazo cede espaço primeiro, nome fica com o resto, **preço nunca é
truncado**, corte visível com "…". O teste hidrata o template de verdade e mede o que a Meta
mede; era o teste que faltava em 07/09.

**3. Demonstrativo sozinho virava termo de busca.** "quero 2 desse" depois da foto (o
WhatsApp Web não deixa legendar encaminhamento, então a legenda vira mensagem separada) →
`[llm-router] basket_edit "quero 2 desse"` → a palavra "desse" foi BUSCADA: "*2x desse* eu
não achei em nenhuma loja agora". O caminho determinístico já estava certo ("não peguei qual
você quer" + opções); quem sequestrava era o **roteador de IA, que é o último recurso da
escolha, ANTES** do `choiceNotUnderstood` (delivery-service:3207). Agora `isDemonstrativeOnly`
barra no funil único de busca (`handleSearch`): com opções na mesa a Lia pergunta *de qual
deles* e devolve os cards; sem opções, pede o nome do produto. Demonstrativo nunca chega à
busca. Regressão cobre os dois estados, com o veredicto do roteador injetado (sem
`OPENAI_API_KEY` o caso não reproduz).

**O que NÃO era bug:** o "Ainda procurando — já te respondo" depois do cancelar é o watchdog
(`[turn:deadline] passou de 45000ms` às 14:27:22 e 14:27:36) chegando atrasado, não o
cancelar quebrado. E o pedido #5GUY4Z com o "Pago e memorizo?" apareceu porque o teste rodou
no **`LIA_OPERATOR_PHONE`** — o canal do operador, com um pedido Cobasi real em curso. A nota
2/10 da rodada mede essa mistura, não a leitura de mídia.

Testes: +10 (7 do limite do card, 3 do demonstrativo) e +2 no E2E de mídia; afetados
307/307; build e guarda de emoji ok.

## 15/09/2026 — A Lia passou a LER áudio e foto do cliente

Até aqui só texto entrava: áudio, foto e figurinha caíam em "só consigo ler texto" e o
cliente refazia o pedido na mão. Agora áudio e foto viram TEXTO e seguem pelo mesmo NLU de
quem digitou — um caminho só, nenhuma regra de produto duplicada.

- **Mídia da Meta são dois passos na Graph**, não um: o webhook recebe só o `media.id`; o id
  devolve uma URL assinada de vida curta (~5 min) e a URL devolve os bytes — e as DUAS
  chamadas precisam do `Bearer WHATSAPP_ACCESS_TOKEN` (a URL sozinha dá 401).
  `whatsappAdapter.downloadMedia` faz isso e nunca lança.
- **Áudio** → `/v1/audio/transcriptions` (`gpt-4o-mini-transcribe`, `language: pt`). O OGG/Opus
  do WhatsApp vai direto, sem conversão, mas o arquivo precisa ir com **extensão** certa
  (`audio.ogg`): a API escolhe o decoder pela extensão, não pelo content-type. O prompt leva
  o vocabulário das lojas, senão "Boticário"/"Cobasi" saem fonéticos e a busca perde a marca.
- **Foto** → Responses API com `input_image` (data URL). Resolve rótulo do que acabou, lista
  escrita no papel e print de produto. `NAO_PRODUTO` (selfie, meme, remédio) vira null: **não
  se chuta produto a partir de foto ambígua**. A legenda entra junto e, se a foto não der
  produto mas a legenda já for um pedido, vale a legenda.
- **A conversão fica DEPOIS do dedupe**, dentro de `handleDeliveryMessage`. Transcrever custa
  segundos e turno lento é exatamente quando a Meta re-entrega o mesmo wamid — do outro lado
  do dedupe cada áudio é baixado, transcrito e ecoado UMA vez (senão: custo dobrado e dois
  ecos).
- **Eco antes da busca** ("🎧 Ouvi: …" / "📷 Na foto eu vi: …"): transcrição erra, e o cliente
  tem que ver o que ela entendeu enquanto ainda dá pra corrigir. Zero espera: sai na hora,
  antes da cotação.
- **A conversa gravada diz a origem** (`[áudio] …` / `[foto] …`): transcrição errada não pode
  parecer coisa que o cliente digitou.
- Flags: `LIA_MEDIA_AUDIO=false` / `LIA_MEDIA_IMAGE=false` desligam separado (custo e latência
  são diferentes); `LIA_MEDIA_MAX_BYTES` (12 MB), `LIA_MEDIA_TIMEOUT_MS`, `LIA_AUDIO_TIMEOUT_MS`,
  `LIA_VISION_TIMEOUT_MS`, `OPENAI_TRANSCRIBE_MODEL`, `OPENAI_VISION_MODEL`. Falha fechada:
  qualquer erro vira "não consegui entender o áudio/a foto", nunca silêncio.
- Figurinha, vídeo, contato e documento continuam no aviso — que agora diz a verdade:
  "texto, áudio e foto".

Código: `src/lib/media-understanding.ts` (orquestração, deps injetáveis),
`downloadMedia` em `adapters/whatsapp.ts`, `transcribeCustomerAudio` +
`describeProductImage` em `adapters/ai.ts`, encaixe em `delivery-service.ts`.
Testes: `tests/media-understanding.test.ts` (16) + `tests/media-inbound.db.test.ts` (5,
inclui o retry da Meta não transcrevendo duas vezes). Build e guarda de emoji passam.

**Não homologado ao vivo**: suíte mockada não prova o download da Graph (mesma lição dos
cards de 08/08). Falta 1 áudio + 1 foto reais no número de produção com leitura do log.

## 13/09/2026 — E8 bloqueado pelo limite de tentativas do Mercado Livre

Captura enviada pelo dono mostra: “Você alcançou o limite de tentativas. Por favor,
tente novamente mais tarde.” A página não informa prazo, causa nem alcance do bloqueio.
Não interpretar como senha incorreta ou desativação permanente da conta. Setup local
interrompido para encerrar a janela de configuração; perfil preservado. Não repetir login,
sondagem ou trocar perfil/rede para contornar a restrição. Retomar pelo fluxo normal após
liberação do ML; se persistir, usar recuperação/suporte oficial. E8 continua não homologado,
sem carrinho preparado ou compra nesta sessão. Gmail E0 validado permanece concluído.

## 13/09/2026 — E8 iniciado: perfil ML reaberto

Primeira abertura falhou porque o processo setup anterior ainda mantinha o perfil ML.
Processo anterior encerrado; `purchase-worker:setup -- mercadolivre` reabriu o perfil
persistente com sucesso. Leitura da janela Chrome pela ferramenta de UI falhou por timeout
em duas tentativas. Solicitado ao dono confirmar login/2FA e fechar a janela para liberar
perfil à sondagem. Autenticação ainda não homologada; nenhum item adicionado ou compra.
Gmail E0 continua validado. Seletores/limpeza/frete/endereço ML ainda sem prova real.

## 13/09/2026 — E0 concluído: Gmail readonly validado ao vivo

Consentimento Google concluído para a caixa operacional confirmada. Script retornou
`{"mailbox":"gmail","authorization":"stored"}` e gravou refresh token no Chaves.
`npm run purchase-worker:mailbox-check` terminou com exit code 0 e
`{"mailbox":"gmail","status":"ready"}`. Client ID, Secret e Refresh Token ficam no
Chaves; valores não registrados em Markdown. A leitura via `security` foi liberada pelo
dono. Isso valida autenticação/API, não uma mensagem real de login/rastreio de loja.
App continua externo/Testando. Próximo: E8, sessão do ML e sondagem; não ativar serviço
ou allowlist por inferência deste teste. Nenhuma compra ou mensagem enviada.

## 13/09/2026 — Chaves liberado; autorização chegou ao login Google

**Avanço:** login Google concluído; tela final do app pede somente “Ver suas configurações e mensagens de e-mail” (`gmail.readonly`). Aguardando o dono clicar Permitir, por ser concessão nova de acesso à caixa. Refresh token ainda pendente.


`mailbox-authorize` leu as credenciais e emitiu URL OAuth com escopo único
`gmail.readonly`, PKCE e callback local. URL aberta no navegador interno; conta operacional
selecionada, Google solicitou senha novamente. Aguarda login do dono e consentimento.
Refresh token ainda não confirmado; processo tem prazo de cinco minutos após emitir URL.

## 13/09/2026 — leitura das duas credenciais confirmada

Checagens isoladas com `security find-generic-password -w` leram Client ID e Client
Secret com exit code 0, sem exibir valores. Logo não há evidência de senha incorreta;
as tentativas anteriores de autorização falharam na leitura, com erro genérico do script.
Fluxo `purchase-worker:mailbox-authorize` reiniciado; nova leitura aguarda o Chaves.
Permitir uma vez nas checagens não autoriza automaticamente o processo seguinte.
OAuth/refresh token e `mailbox-check: ready` ainda não concluídos.

## 13/09/2026 — retomada do OAuth

Dono esclareceu que a janela reaparece sem mensagem explícita de senha incorreta.
Processo identificado aguardando `Lia Gmail Client Secret`; leitor solicita ID e Secret
em sequência, portanto repetição visual pode ser o segundo item. Isso ainda não comprova
sucesso na leitura do primeiro. Orientado liberar o item Secret e acompanhar resultado.


Client ID e Client Secret continuam presentes no Chaves; refresh token ausente.
Nova execução de `purchase-worker:mailbox-authorize` aguarda leitura pelo `security`,
ainda sem URL de consentimento. Solicitado texto exato da janela ao dono para diagnosticar
a recusa anterior. Nenhuma alteração de senha/ACL, leitura de e-mail ou ativação realizada.

## 11/09/2026 — OAuth criado, Gmail API ativa; liberação do Chaves pendente
**Diagnóstico seguinte (11/09):** dono relatou que a senha do Mac não liberou o acesso.
A autorização encerrou sem URL/refresh token. Itens Gmail existem no chaveiro login;
controle de acesso inspecionado sem alteração: confirmar acesso, aplicativo confiável
`swift-frontend` (gravador), enquanto leitor usa `security`. Motivo exato da recusa ainda
não confirmado; solicitar texto do diálogo antes de nova tentativa. Não redefinir
chaveiro nem ampliar acesso para todos os aplicativos.



Com aceite do dono, configuração OAuth criada no projeto `alpine-anvil-497620-p3`:
app “Lia Comprador — leitura de e-mails”, externo/Testando; conta operacional confirmada
adicionada como único usuário de teste. Cliente Desktop “Lia Purchase Worker Mac” criado.
Client ID e Client Secret importados para os serviços correspondentes no Chaves; presença
verificada sem revelar valores. Gmail API mostrou status Ativado no console.
`purchase-worker:mailbox-authorize` iniciado, mas aguarda `security` ler o Chaves; nenhuma
URL de consentimento emitida ainda. Diálogo SecurityAgent indisponível para automação:
dono deve liberar acesso local com a senha do Mac. Refresh token e `mailbox-check: ready`
ainda pendentes. Nenhuma leitura de e-mail ou ativação do comprador realizada.

## 11/09/2026 — Google Cloud autenticado; cadastro OAuth preparado

Dono confirmou que a conta conectada no Google Cloud é a caixa operacional das lojas.
No projeto `alpine-anvil-497620-p3` (My First Project), a plataforma OAuth ainda não
estava configurada. Formulário preparado: “Lia Comprador — leitura de e-mails”, público
externo/teste, suporte/contato na conta confirmada. Parado antes do aceite da política
de dados das APIs Google, aguardando confirmação do dono. Nenhum OAuth client, segredo,
escopo, consentimento de leitura ou refresh token criado nesta etapa.

## 11/09/2026 — endereço de sondagem salvo; criação OAuth ainda pendente

Dono forneceu endereço operacional, CEP e destinatário. Dados salvos somente no
`probe` do `.retail-buyer/config.json` privado (0600, fora do git); bairro/cidade/UF
conferidos pelo CEP. Não copiar endereço completo para documentação versionada.
Dono confirmou que ainda não criou o cliente OAuth Gmail. Google Cloud aberto no
navegador interno do Codex, parado na tela de login; aguarda entrada do dono na conta
que recebe e-mails das lojas. Nenhum cliente OAuth, consentimento ou token novo criado.
Sondagem ML ainda não executada; login no perfil comprador não confirmado.

## 11/09/2026 — conferência local de E0/E8 e abertura do perfil ML

Conferido no Mac: `config.json` privado contém Mercado Livre; bloco `probe` ausente.
`mailbox-check` falhou por ausência de Client ID, Client Secret e refresh token Gmail.
No Chaves, conta `lia-purchase-worker`: **Lia Purchase Worker presente** (validade no
servidor não testada); **Lia Tracking Worker ausente**. Os nomes corretos não têm o
sufixo “Token”. Serviço `com.liadelivery.purchase-worker` ainda não instalado.
Executado `purchase-worker:setup -- mercadolivre`: perfil criado e janela aberta para
login/2FA do dono; autenticação ainda não confirmada. Aguardando endereço operacional e
estado da criação do OAuth. Nenhum carrinho preparado, compra, mensagem ou ativação.

O commit documental `001593c`/STATUS já registra o deploy zero de `398217b` e 23/23
migrations; o cabeçalho anterior que dizia “nada publicado” ficou histórico. Produção
não foi revalidada nesta conferência. Não repetir deploy por esse cabeçalho antigo.
Atenção à sondagem atual: `mercadolivre.ts` lê itens/preços, mas `snapshot` usa endereço,
e-mail e frete fornecidos pelo job (no probe, frete zero); não comprova frete real,
endereço ou identidade da conta. Esses dados continuam exigindo conferência no app.

## 11/09/2026 — plano de compra IMPLEMENTADO localmente (Fases 0–7; 597/597; nada publicado)

O que existe agora no código (todos os interruptores desligados por padrão):
- **Mercado Livre degrau C**: comprador monta o carrinho na conta → botões **Comprei / Não
  deu** no WhatsApp do dono (assinados `op1.<id>.<escolha>.<hmac>`, HMAC com `OPS_TOKEN`)
  → número do pedido por mensagem → cliente avisado. Espelho no `/ops`. Nunca clique automático
  no ML (`automaticPurchaseDecision` com canal `owner_confirm`).
- **VTEX + Pix da loja pago pela Lia**: `pix-emv.ts` (CRC), `payments/pix-out/` (asaas | mock;
  Efí depois de E5), `PixPayout` (um por job; timeout = `outcome_unknown`, nunca 2ª chamada),
  allowlist de recebedor por loja com um toque, conciliação no cron.
- **Fundações**: `customerName` gravado (perfil do WhatsApp; pergunta só em loja executável),
  evidência `payment` discriminada, `manual_queue` no `/ops` (estorno automático em 48h),
  domínios extras (ML → Mercado Pago), destinatário editável no painel.
- **E-mail → etapa** (`mailbox-policy.ts`, `report_mail`, leitor local a cada 2 min) e
  **exceções por um toque** (recebedor novo, Pix recusado, loja em silêncio, acima do teto,
  comprador sem sinal). **Arrependimento**: cliente pago desiste até a compra sair; estorno na hora.
- **Operação**: `npm run purchase-worker:install-service` (launchd + caffeinate); sondagens
  `purchase-worker:probe`; caminho da tarefa horária do ChatGPT **removido**
  (`/api/purchase-worker/claim`, `purchase-worker-client`, `PURCHASE_AUTOMATION_MODE`).
- Migrations novas: `20260911120000_purchase_receivers_actions`, `20260911150000_pix_payout`
  (mais as 3 de 06–07/09, todas pendentes de deploy).

**Ordem para ligar (não pular):** (1) deploy zero = aplicar as 5 migrations com o código
atual; (2) publicar com flags off; (3) E0 OAuth da caixa + E8 sondagem do ML → conta ML no
`/ops` (saldo MP) + `LIA_AUTO_PURCHASE_STORES=mercadolivre` → degrau C em produção → desligar
a tarefa do ChatGPT; (4) E2/E3 sondagem VTEX + E5/E6 banco → `LIA_PIX_OUT_PROVIDER=asaas` +
`ASAAS_API_KEY` + receita da loja no `config.json` + nome na allowlist. Runbook:
[docs/operador-runbook.md](docs/operador-runbook.md) (seção 11/09).

## 11/09/2026 — plano de implementação aprovado pelo dono (7 fases, ML degrau C primeiro)

Dono aprovou [docs/plano-implementacao-compra-2026-09-11.md](docs/plano-implementacao-compra-2026-09-11.md)
e respondeu: começar pelo **ML degrau C**; destinatário = **nome do WhatsApp, perguntar só se
faltar** (sem CPF); **mudar a regra de arrependimento** (estorno imediato enquanto a compra na
loja não saiu); Pix-out com **interface neutra, Efí e Asaas em paralelo**. Fases: 0 sondagens
(mailbox genérico, `selectPix`, `probe LOJA`) → 1 fundações (`customerName` nunca era gravado —
bloqueio real; evidência de pagamento generalizada; allowlist com ML; `manual_queue`) → 2 ML
degrau C (`MercadoLivreBuyer` DOM, `cart_ready → awaiting_owner_confirm`, `OpsAction` + botões
assinados `op1.<id>.<hmac>`) → 3 Pix-out + captura VTEX → 4 e-mail → DeliveryEvent → 5 exceções
por um toque → 6 arrependimento → 7 operação. Deploy zero = commitar e aplicar as 3 migrations
pendentes. Cada fase fecha com `tsc` + `npm run test:local` verde e commit.

## 11/09/2026 — dono: Mercado Livre FICA (é o canal principal)

"Eu não posso ter Mercado Livre fora, é meu principal." Revoga a exclusão do ML nos planos
de 10/09. Registrado na seção 13 de [plano-compra-viavel](docs/plano-compra-viavel-2026-09-10.md).
Fatos verificados em 11/09: **não existe API de compra** no ML (a API de Orders é do
vendedor; comprador só lê as próprias orders/envios, e a conta da Lia nem cria app —
OPT02); os Termos (11/05/2026, cl. 4, 7 e 12) vedam usar a conta para "intermediar…
operações de terceiros" e o acesso automatizado a áreas autenticadas — risco de
desativação da conta, assumido pelo dono. Tecnicamente o ML é a melhor loja: um checkout
para a cauda longa, **pagamento com saldo Mercado Pago** (o Pix do cliente já cai lá: sem
CVV, sem QR, sem banco, sem float), melhor rastreio. A 2FA do ML **não vai por e-mail**
(SMS/WhatsApp/ligação/autenticador/rosto): perfil persistente + TOTP no Chaves. Escada:
**C** preparar carrinho + dono confirma no app do celular com 1 toque (ligar já; substitui
a tarefa do ChatGPT) → **A** automático após sondagem (E8–E10) → **B** Afiliados como seguro
(oficial, 2–16% de comissão, cliente compra na própria conta; não é "paga no chat").
Conta PJ no Mercado Livre Negócios, ≤ 3 pedidos/dia no início, nunca HTTP puro.

## 11/09/2026 — cruzamento dos dois planos de compra (Claude × Codex)

Os planos [plano-compra-viavel](docs/plano-compra-viavel-2026-09-10.md) e
[plano-validacao-compra-pix](docs/plano-validacao-compra-pix-2026-09-10.md) convergiram sem
combinação: Pix no lugar de cartão, gates antes de código, Chrome local, provedor por condição
comprovada, Pague Menos/Oba/ML fora. Conclusões registradas na seção 12 do primeiro:
(1) **cliente paga primeiro**; não criar pedido na loja antes do dinheiro (o Codex propunha o
inverso na Etapa 4); (2) **Swift é a primeira loja** (leitor OAuth já conectado ao Acesso
Rápido), Cobasi depois, Ri Happy e Drogaria SP como sondagens a R$0; (3) 5 compras no Mac
atual como `launchd`, host dedicado só para o piloto de 30; (4) **teto continua R$500/dia até
o fim do piloto** (corrige a sugestão de subir cedo); (5) perguntar a Efí e Asaas em paralelo;
(6) 29/30 é o gate da loja, "<10% de toques" é a métrica operacional. Passo único que destrava
tudo, do dono: criar o cliente OAuth do Google (Gmail somente leitura) e rodar
`npm run purchase-worker:mailbox-authorize`. Higiene: "Decisão proposta" do plano do Codex
ainda cita Pague Menos como candidata inicial; `config.json` lista Oba e Pague Menos.

## 10/09/2026 — plano de compra viável (proposta; aguarda decisão do dono)

Dono: "está muito difícil de operar… não está dando pra implementar a compra automatizada
que bolamos… impossível que não exista forma melhor que tarefa agendada do meu GPT". Resposta
em [docs/plano-compra-viavel-2026-09-10.md](docs/plano-compra-viavel-2026-09-10.md)
(6 pesquisas na web, 5 propostas, 15 críticas adversariais, síntese, verificação direta nos
checkouts e as evidências reais de hoje). Verdade estrutural: não existe API de compra do lado
do comprador no Brasil; todo caminho é automatizar o site de cada loja; a meta correta é
"humano só em exceção, por um toque", não "zero humano". Caminho recomendado, nesta ordem:
(A) pagar a loja por **Pix via API bancária** (Efí `idEnvio` idempotente ou Asaas com tentativa
única) em vez de cartão salvo; (B) **caixa de e-mail operacional legível por máquina** (leitor
OAuth já escrito) para códigos de login e rastreio; (C) **conta própria envelhecida por loja no
Chrome local** como `launchd` (não convidado com e-mail novo, não nuvem); (D) **exceções por um
toque no WhatsApp do operador**. Gates antes de código (R$0–75): sondar Ri Happy, Drogaria SP,
Cobasi e Swift até a tela de pagamento com Pix; 1 pedido real pago pelo app; perguntas por
escrito a Efí/Asaas; R$1 de Pix-out a terceiro. Fatos verificados hoje: Pix em 6/9 VTEX; Oba
sem Pix; Pague Menos com CAPTCHA mesmo em Pix; captura do copia-e-cola só documentada no modal
(navegador continua necessário); teto R$500/dia limita a 4–8 pedidos/dia; mandato não cabe no
MEI; ML fora por Termos. Decisões pendentes do dono na seção 5 do plano (revenda × mandato,
teto diário, provedor/float, MP PJ, cobertura de exceções). Nenhum código, conta ou compra.

## 10/09/2026 — leitor local de códigos implementado; OAuth real ainda pendente

Foi implementado `scripts/retail-buyer/mailbox.ts`: Gmail OAuth somente leitura, refresh local, busca restrita a mensagens recentes de domínios permitidos, corte pelo instante da solicitação e recusa de código ambíguo. Conteúdo e código não são gravados, enviados ao backend nem exibidos em logs. O acesso rápido da Swift usa esse leitor somente se a sessão persistente não corresponder à conta operacional. Segredos ficam no Chaves sob `lia-purchase-worker`; `npm run purchase-worker:mailbox-check` só retorna ready/erro. Testes de parser/OAuth simulados, verificador do navegador, TypeScript, lint e suíte Postgres aprovados (**577/577**). Não há client OAuth, consentimento nem refresh token reais; Swift continua desativada e fora da allowlist até a prova real de login, Pix, recibo e rastreio.

## 10/09/2026 — Cobasi e Swift: Pix anunciado, mas login depende do e-mail

Cobasi e Swift foram testadas com os menores carrinhos legítimos disponíveis, sem criar pedido. Cobasi: uma unidade de R$2,80; o cadastro enviou código ao e-mail operacional, cuja caixa não estava autenticada no perfil. Swift: uma unidade de R$4,50, total de R$22,40 com frete; o acesso rápido também enviou chave por e-mail antes do pagamento. Os carrinhos foram esvaziados e nenhum pedido, Pix, pagamento ou cobrança foi criado. Ambas permanecem fora da allowlist. Próximo gate: acesso programático e auditável ao e-mail operacional ou sessão homologada sem código por compra; não montar outra cesta antes disso. O teto autorizado nunca é meta de gasto.

## 10/09/2026 — Oba reprovada: checkout online sem Pix

Depois da reprovação da Pague Menos, a Oba foi testada até a tela real de pagamento. O dono autorizou aderir ao Programa Cliente Bem Querer e ampliou o orçamento disponível, mas esclareceu que isso é teto, não meta: nunca comprar ou montar item caro desnecessário. Cadastro concluído uma vez, marketing desmarcado. Usou-se cesta temporária de itens úteis no menor total prático acima do pedido mínimo de R$89,90: R$97,76. O endereço operacional autorizado foi salvo, embora o site tenha apresentado inconsistência na unidade de entrega. Para isolar o gate sem criar pedido, avançou-se com retirada em loja. As únicas formas de pagamento exibidas foram cartão de crédito e Google Pay; Pix não estava disponível. Nenhum pedido, pagamento ou cobrança foi criado; a cesta foi esvaziada. Oba continua fora da allowlist e está reprovada para a arquitetura de pagamento automatizado por QR Pix.

## 10/09/2026 — Pague Menos reprovada para automação também por Pix

Na cesta real já preparada, trocar cartão por Pix não retirou a etapa humana: o checkout informou que o QR só seria gerado após “Finalizar compra”, continuou exibindo “Não sou um robô” e manteve o botão final desabilitado. Nenhum CAPTCHA foi resolvido, pedido criado, pagamento ou compra feita. A regra geral documentada da VTEX para pagamentos sem cartão não correspondeu ao comportamento real desta loja. Não implementar adaptador Pix da Pague Menos nem colocá-la na allowlist. Plano em execução e evidências em [plano de validação Pix](docs/plano-validacao-compra-pix-2026-09-10.md) e [registro da prova](docs/evidencias-validacao-compra-pix-2026-09-10.md). Próximo gate: uma única loja alternativa deve emitir QR sem desafio antes de retomar integração bancária.

## 09/09/2026 — Pague Menos: compra real concluída, mas recompra exige CVV

Conta e perfil persistente `paguemenos` estão autenticados; os dados obrigatórios ficaram salvos. Checkout real autorizado pelo dono concluiu o pedido `#1660399032770`, total R$24,39, e o cartão passou a aparecer salvo na conta. A primeira finalização exigiu verificação de robô, concluída manualmente pelo dono. Na segunda preparação, o checkout pulou direto para entrega/pagamento e reconheceu o cartão salvo, mas exige novamente o código de segurança. Não guardar CVV nem marcar a loja como totalmente automática. A segunda cesta está preparada, sem nova compra: para testar a recorrência do CAPTCHA seria necessário preencher o CVV e obter autorização explícita para uma segunda cobrança. Pague Menos continua fora da allowlist e sem seletores homologados de envio, recibo e rastreio. Estado em [configuração das lojas](docs/configuracao-lojas-2026-09-07.md).

## 08/09/2026 — dados e senha fornecidos; acesso ainda não confirmado

Dono forneceu nome/e-mail, CPF, celular e senha para os sites. Drogaria São Paulo preenchida integralmente, mas cadastro, login e envio de código não confirmaram sucesso. Não pedir senha nem autorização para gerar outra: usar a fornecida, sem transcrever em arquivos. Chaves não foi utilizado. Pague Menos em tentativa como alternativa. Nenhum cartão salvo, conta habilitada ou compra. Estado em [configuração das lojas](docs/configuracao-lojas-2026-09-07.md).

## 08/09/2026 — autorização permanente de compra até R$ 500

Dono: “sim isso sim. eu atorizo ate 500 reais. queroo mais automatico que der mesmo se isso significar menos lojas.” Autorizada compra sem aprovação individual. Interpretação conservadora comunicada: teto R$500 por pedido e R$500 total por dia de São Paulo, frete incluso; não interpretar como orçamento diário ilimitado. Priorizar poucas lojas com checkout real validado; interromper expansão de cadastros até concluir a primeira. Não exige loja parceira. Autorização não significa conta/cartão prontos.

Implementado localmente: `purchase-policy.ts`, lista explícita `LIA_AUTO_PURCHASE_STORES` (vazia por padrão, ML assistido), `LIA_AUTO_PURCHASE_OFF`, aprovação por política após pagamento real/carrinho/endereço/conta verificados, nova conferência antes do envio. `PurchaseSpend` registra a reserva em centavos antes do clique, dentro da mesma transação da tentativa e de uma trava global entre lojas. Compras com aprovação individual também consomem orçamento; autorização individual é exceção explícita aos limites, indicada no painel. Resultado incerto, cancelamento e estorno não liberam saldo automaticamente. Revogação ou disputa pelo saldo antes de begin devolve para revisão sem clicar. Falha do comprador avisa o operador.

Painel mostra limites, gasto/reserva do dia e lojas explicitamente liberadas. Quando há lista automática, o comprador restringe novas reservas a ela; não altera a pesquisa automática do ML nem substitui produto escolhido pelo cliente. Cesta multiloja continua assistida. Lista de lojas liberadas vazia: nenhuma conta real homologada. Não preencher allowlist por inferência de cadastro/login.

Validação: 567/567 testes em Postgres local, migration sem drift; TypeScript do app/runtime, lint, build e painel no Chrome simulado aprovados. Migration aditiva `20260907120000_purchase_spend` precisa preceder publicação. Nenhum deploy, cartão salvo, compra real ou processo de compra iniciado nesta alteração. Falta concluir primeira conta/cartão, observar botão/comprovante/status, configurar processo e publicar. Detalhes: [política de compra](docs/compra-automatica-500-2026-09-08.md).

## 07/09/2026 — contas no Chrome em preparação

Por pedido do dono, preparar todas as lojas nos perfis persistentes do comprador. Cadastros incompletos; faltam dados, autenticação e verificação de cartão/checkout. Não considerar lojas habilitadas. Estado em [configuração das lojas](docs/configuracao-lojas-2026-09-07.md).

# Lia — contexto obrigatório para agentes

## 15/09/2026 (2ª) — "manda o número do pedido do Mercado Livre" num pedido da Cobasi

Dono tocou em **Confirmar** no alerta `store_silent` do #5GUY4Z (Pix da loja pago às 01:45,
loja sem confirmar por 30 min; ação criada 15:10, consumida 15:46 por `wa:…6065:confirm`) e
recebeu "Beleza. Manda só o número do pedido do **Mercado Livre** do #5GUY4Z". O pedido é da
**Cobasi** (Ração Úmida Whiskas 290 g, R$ 11,39): `operatorAskStoreNumber`/
`operatorStoreNumberSaved` tinham a loja FIXA no texto, herdada do degrau C do ML.
- Agora a loja vem do `PurchaseJob` (`storeLabelOf` em ops-actions-inbound; `listStores()`
  e NÃO `getStore`, que cai numa loja padrão quando a chave é desconhecida — nome errado é
  pior que nenhum). Texto em posição neutra ("— loja: Cobasi") pra não errar artigo.
- Teste em `tests/lia-copy.test.ts`.

**Risco ainda ABERTO (decisão do dono):** enquanto existe `await_store_number` pendente (30
min), QUALQUER mensagem só-números de 6–20 dígitos do telefone do operador é consumida como
número do pedido — e o dono usa o mesmo número como cliente. Um CEP (8 dígitos) digitado
nesse intervalo vira "número do pedido" e não chega no fluxo de cliente.

**Estado do #5GUY4Z:** job `pix_paid` na Cobasi, `storeOrderNumber` nulo, ação
`await_store_number` pendente até 16:16 de 15/09. O dono precisa mandar o número do pedido
da Cobasi ou deixar expirar (nada é estornado sozinho por expirar).


## 15/09/2026 — botão do card: "Adicionar ao carrinho"

Dono: "muda o escolher esse pra adicionar ao carrinho no card". Limites da Meta mandam no
texto: botão de template (carrossel) aceita 25 caracteres, botão de mensagem interativa
aceita 20 e a Meta RECUSA a mensagem inteira se passar. "Adicionar ao carrinho" tem 21.
- Carrossel: `CAROUSEL_ADD_BUTTON = "Adicionar ao carrinho"` (meta-setup.ts).
- Card interativo do fallback: `CARD_ADD_BUTTON = "Adicionar"` (adapters/whatsapp.ts), com
  teste garantindo ≤ 20 em todo botão de card.
- Copies alinhadas (`productDetailsLink`, `productDetailsList`, `demonstrativeNeedsChoice`,
  corpo do carrossel).
- Texto de botão é parte do template → **templates v3** (`vitrine_carrossel_v3_2..5`,
  prefixo `CAROUSEL_TEMPLATE_PREFIX`). Enquanto os v3 não são criados/aprovados, o envio
  do carrossel falha no Graph ("template name does not exist"), é capturado e a vitrine
  sai nos cards soltos já com "Adicionar" — sem apagão.
- Ambiente: o `git` do sistema aponta pro Xcode sem licença aceita; usei
  `/Library/Developer/CommandLineTools/usr/bin/git`. Pro dono resolver de vez:
  `sudo xcodebuild -license` (precisa da senha dele).


## 10/09/2026 — vitrine de 5 no carrossel, 3 nos cards soltos

Dono: "agora que tem carrossel fica suave colocar umas 5 … um pouco mais de variação, mas
dentro do que o cliente pediu". Feito:
- `vitrineLimit()` em delivery-service: 5 com `LIA_CAROUSEL=true`, 3 sem (e nos testes);
  `LIA_VITRINE_MAX` (2–5) sobrepõe. Vale em `buildChoices`, paginação ("outras"), refino,
  re-busca por marca e plano B. `sendDeliveryCarousel` aceita até 5; `sendDeliveryChoices`
  (fallback) e a recuperação do carrossel seguem em 3 mensagens.
- `rerankShoppingOptions(message, lines, limit)`: o prompt recebe o teto e a regra 3 diz
  explicitamente que as vagas extras são pra VARIAR dentro do pedido (marca, loja, faixa
  barato/intermediário/premium) e que é melhor devolver menos do que repetir variante.
- Templates `vitrine_carrossel_v2_4` (id 1777270419939303) e `_v2_5` (id 2204265320507915)
  criados em 10/09. Ordinais "quarto"/"quinto" em `parseChoiceReply`.
- Deploy travou duas vezes: `.vercelignore` existia (só LIA_WHATSAPP.md) e sobrepõe o
  `.gitignore`, então `.retail-buyer/` (1,3 GB de perfis do Chrome do comprador) subia.
  Agora ignora `.retail-buyer/`, `.local-pg/`, `node_modules/`.


## 08/09/2026 — carrossel: 1º uso real ficou em SILÊNCIO (131042) → desligado + rede de segurança

Dono mandou "quero um relógio barato"; a Lia buscou, mandou o carrossel, a Graph aceitou
(2xx) e 14 s depois o webhook trouxe status `failed` **131042 "Business eligibility
payment issue: conta WhatsApp Business sem moeda configurada"**. Carrossel é template de
MARKETING (pago) e a conta nunca teve cobrança configurada; o código achou que enviou e
não caiu nos cards. Feito na hora:
- `LIA_CAROUSEL=false` na Vercel (vitrine voltou aos cards soltos, grátis).
- Rede de segurança: `sendDeliveryCarousel` devolve o wamid; `rememberCarousel` grava
  `Message(sender "carousel", metadata = wamid, text = {header, pending})`; o webhook, ao
  receber `failed` daquele wamid, chama `recoverFailedCarousel` → header + cards soltos
  (ou lista em texto), idempotente (linha vira `carousel-recovered`). Se o erro for
  131042, `notifyOperator` avisa uma vez. Teste em `tests/carousel.test.ts`.
- **Ação do dono pra religar**: configurar moeda/cobrança da conta WhatsApp Business no
  Business Manager (link do erro: `business.facebook.com/billing_hub/accounts/details/
  ?business_id=1802515380110705&asset_id=1336161451961509&wizard_name=CHANGE_COUNTRY_CURRENCY`)
  → mandar uma vitrine de teste → `LIA_CAROUSEL=true`. Lição: template pago exige conta
  com cobrança; o `pedido_atualizacao` (utility) só funcionou porque utility na janela é
  grátis — fora da janela vai falhar do mesmo jeito até a cobrança existir.
- **09/09**: dono configurou moeda/cobrança; `LIA_CAROUSEL=true` de volta. Ação nova
  `?action=carousel_test` (manda um carrossel de amostra pro `LIA_OPERATOR_PHONE` e devolve
  o wamid) — prova real de entrega: sem `Message(sender meta-status-failed)` em minutos =
  entregue. Sessão do /ops no navegador interno se perde ao reabrir o painel; pedir link
  novo ("ops" pra Lia).


## 07/09/2026 — carrossel da vitrine (dono: "eu quero fazer carrossel")

Na Meta, carrossel só existe como **template de MARKETING**: cobrado por envio (~R$0,33 no
Brasil, mesmo dentro da janela de 24h) e com número de cards fixo por template. Feito:
- `meta-setup.ts`: `buildCarouselTemplate(n, handle)` gera `vitrine_carrossel_2` e `_3`
  (corpo com 1 variável = cabeçalho da vitrine; card = foto por link + `{{nome}}`,
  `{{preço}}`, `{{prazo}}` + botões "Escolher este" e "Ver detalhes"). Ações novas em
  `/api/ops/meta-setup`: `?action=carousel` cria os dois templates (imagem de exemplo =
  marca, upload resumable) e `?action=templates` mostra status/motivo de recusa.
- `adapters/whatsapp.ts`: `buildCarouselPayload` + `sendDeliveryCarousel(to, header,
  options)`: 2–3 opções, todas com foto pública e viva → UMA mensagem de template; senão
  `null`. O toque volta como `button.payload` = `optsku:<sku>` / `optinfo:<sku>`, que o
  `parseInbound` já lia. Erro do Graph (template não aprovado) → `null` com warn.
- `sendChoices`: com `LIA_CAROUSEL=true` tenta o carrossel antes; qualquer `null` cai nos
  cards soltos de sempre (grátis).
- **v2 (mesma noite, dono: "precisa ter o botão outras opções")**: a Meta permite 2 botões
  por card e IGUAIS em todos, então cada card leva "Escolher este" + "Outras opções"
  (`opt:outras`); "Ver detalhes" saiu do carrossel e o corpo diz "escreva *detalhes* e o
  número". Templates novos `vitrine_carrossel_v2_2` (id 2073146943589296) e
  `_v2_3` (id 1397179925708771); os v1 ficam órfãos na Meta (podem ser apagados).
- Testes: `tests/carousel.test.ts` (limites do template, payload, envio, fallback).
- Ativação: deploy → `?action=carousel` → esperar APPROVED em `?action=templates` →
  `LIA_CAROUSEL=true` na Vercel. Se a Meta recusar, o motivo aparece em `templates`.
- Criados em 07/09 pela sessão do /ops (`vitrine_carrossel_2` id 1056736890461959,
  `vitrine_carrossel_3` id 1540758381155769), APROVADOS em ~5 min; `LIA_CAROUSEL=true`
  na Vercel desde 07/09 à noite. Duas recusas antes, ambas
  regra de texto da Meta: (1) "Params Words Ratio Exceeds Limit" — card só com variáveis;
  precisa de rótulos fixos; (2) "Leading or Trailing Params Not Allowed" — variável não
  pode abrir nem fechar o corpo nem o card. `tests/carousel.test.ts` guarda as duas.


## 07/09/2026 — referências: serviços por WhatsApp no Brasil e no mundo

Levantamento a pedido do dono (Magalu, Magie, JioMart, Uber Índia, iFood, KLM, MyGov, Poke,
Luzia/Zapia, Yohana/Duckbill, Magic, Rappi) com números e a lição de cada um; padrões de
quem deu certo (transação curta no chat, começar com quem já confia, proatividade,
documento no chat, áudio/foto/PDF como entrada, bot de nicho com dinheiro). Detalhe em
[docs/servicos-whatsapp-referencias-2026-09-07.md](docs/servicos-whatsapp-referencias-2026-09-07.md).


## 07/09/2026 — concorrência: "não existe uma Lia" era falso

Pesquisa web a pedido do dono. O modelo existe em pedaços: Magic (EUA, 2015, "qualquer
coisa por SMS", cobra o cartão), Rappi "Qualquer Coisa" (Brasil, compra em qualquer loja
desde 2018), Amazon "Buy for Me" (agente compra em ~400 mil sites, 2026), Google/Perplexity
checkout por agente (EUA). No WhatsApp brasileiro, a **Lu do Magalu** fecha compra com Pix no
chat sobre 37 milhões de anúncios (1P + sellers). A OpenAI **matou** o checkout no ChatGPT em
03/2026: o cliente compra onde já tem conta. Meta proíbe bot de IA de uso geral na API desde
15/01/2026 (bot de compras é permitido; não virar assistente geral). Combinação exata da Lia
(WhatsApp + qualquer loja + paga no chat + entrega do varejista) não encontrada no Brasil.
Detalhe e fontes: [docs/concorrencia-2026-09-07.md](docs/concorrencia-2026-09-07.md).


## Atualização 07/09/2026 — Mercado Livre entra sozinho: acabou o "procuro no Mercado Livre?"

**Decisão do dono (07/09):** "não tem que perguntar se ele quer no Mercado Livre, só tem
pesquisar. Se não tiver matches boas nas lojas normais já tem que ir pro Mercado Livre se
a IA julgar melhor." Reverte o opt-in da revisão de 02/09.

- **Padrão agora é automático.** `longTailOptInEnabled()` só é verdadeiro com
  `LIA_LONGTAIL_OPTIN=true` (kill-switch de custo; a Vercel não tem a env → automático).
  Fluxo: vitrines locais primeiro; se nenhuma passa no piso (`needsLongTailSearch`), o ML
  entra na MESMA busca; se o rerank da IA descartou tudo o que havia, o resgate
  (`turnElapsedMs <= LIA_RESCUE_BUDGET_MS`) busca no ML e mostra as opções direto. Quem
  julga se a vitrine local serviu é a IA (rerank) — esse é o "se a IA julgar melhor".
- **Frase completa do cliente no ML também no caminho automático.** `ParsedLine.raw`
  (06/09) agora chega ao `gatherCrossStoreCandidates` por `longTailQuery` (só o ML recebe a
  frase completa; as vitrines locais seguem com a linha curta), e o resgate automático
  busca por `raw ?? phrase`. `ChoicesResult.lines` expõe as linhas extraídas pra linha
  "fraca" (descartada pelo piso/rerank) recuperar o `raw`.
- **A oferta (`longTailOffer`, botões `longtail_sim`/`longtail_nao`) continua no código**
  só pro modo opt-in; os testes dela ligam a env por teste. Aviso de busca lenta
  (`buildChoicesWithSearchNotice`) continua cobrindo a busca fria do ML.
- Testes: `tests/lighter-longtail.test.ts` ganhou o caso padrão ("queria um isqueiro pra
  charuto" → maçaricos do ML sem pergunta) e o do `longTailQuery`. `.env.example` atualizado.



## 07/09/2026 — início da configuração real da primeira loja

Dono autorizou começar a configuração. Foi aberta a Drogaria São Paulo no Chrome com
perfil exclusivo `.retail-buyer/profiles/drogariasp`, usando o comando setup do comprador.
A navegação inicial concluiu. Aguardando o dono entrar/criar sua conta diretamente nessa
janela e fechá-la ao concluir. Login, cartão salvo e dados reais ainda NÃO foram
confirmados; nenhuma conta foi marcada pronta no painel. Nenhuma compra, cobrança ou
mensagem enviada. Próximo passo: reabrir o perfil salvo e validar o checkout antes de
orientar o cadastro do cartão ou ampliar para outras lojas.


## 06/09/2026 — esforço de autenticação e identidade na entrega

Dono considera autenticação/CAPTCHA recorrentes um gargalo inaceitável e perguntou sobre
cadastro de cartão e nome no pacote. Esclarecimento de escopo: há um cadastro operacional
por loja ativada; a configuração local inicial contém só Drogaria SP, enquanto o
preparador comum possui nove origens. Não pedir cadastro em nove lojas antes de homologar
uma. Login persistente está implementado, mas não garante ausência de verificações da
loja. A frequência real ainda não foi medida; operação com desafios frequentes não atende
a expectativa do dono e deve reprovar a homologação para execução automática.

Verificação do código: clientProfileData permanece da conta operacional; receiverName,
CEP e endereço de entrega recebem os dados do cliente em cada pedido e são reconferidos.
Isso não comprova o nome que cada loja imprime na etiqueta/nota/comprovante. Antes de
ativar uma loja, validar também destinatário no pacote e quais dados do comprador ficam
visíveis ao cliente. Não prometer que cadastrar dados pessoais do dono é invisível nem
alterar dados fiscais para tentar ocultá-los. Nenhum cadastro ou compra real feito.


## 06/09/2026 — aprovação sem janela de cinco minutos

Dono pediu poder aprovar quando olhar o WhatsApp. Implementado localmente: o resumo e a
aprovação ficam persistidos sem expirar após 5 minutos. Após preparar, o comprador remove
somente os itens conferidos da própria cesta, confirma carrinho vazio, fecha o perfil e
libera a conta. Outros pedidos/rastreios podem usar a conta durante a espera. A aprovação
pode chegar antes ou depois dessa liberação; não se perde na corrida nem exige navegador
aberto. Pedidos aprovados são retomados pelo comprador com token novo.

Ao reconstruir o carrinho, só condições idênticas ao resumo aprovado habilitam a execução
por 60 s. Mudança gera nova conferência/aprovação; violações do teto, endereço, estoque ou
prazo do cliente exigem revisão. O botão não expira por idade do resumo. Pedido cancelado,
estornado ou com pagamento inválido continua bloqueado: as regras de estorno do vigia
não foram removidas. Interrupção durante uma ação de navegador continua exigindo
reconciliação; resultado financeiro incerto nunca é repetido automaticamente.

Validação desta alteração: **560/560 testes**, sem skips, schema/migrations coerentes,
TypeScript do app e do runtime, lint e build aprovados; comprador e painel testados no
Chrome com todas as requisições simuladas.

**Não basta login em todas as lojas para funcionar perfeitamente.** É necessário cartão
corporativo configurado e homologação do checkout/comprovante/status por loja. O aviso
chega pelo WhatsApp; a aprovação continua no painel aberto pelo link. Exceções como
CAPTCHA, autenticação, indisponibilidade e site alterado continuam possíveis. Mudança
local, não publicada, sem compras/mensagens reais. Não requer nova migration além das
já pendentes. Documento operacional: [compra e acompanhamento](docs/compra-e-acompanhamento-2026-09-06.md).


## 06/09/2026 — comprador e leitor implementados, ativação real pendente

Pedido do dono: “faça isso acontecer e implemente”. Entrega local:
contas operacionais por loja, comprador contínuo com perfil Chrome próprio, preparação
VTEX, conferência de carrinho e aprovação única no /ops (5 min para conferir, 60 s para
executar), tentativa durável sem repetir clique incerto, recuperação auditada, trava
compra/estorno/cancelamento e agenda de acompanhamento com leitor de credencial separada.
Status explícito do pedido inteiro gera avisos; previsões e pacotes isolados não geram.
Pedidos já comprados antes da migration são incluídos por número/loja.

**Não implantado nem homologado em conta real.** Nove origens VTEX têm preparador comum;
botão final, comprovante e página de status precisam de seletores observados em cada
loja. Sem configuração final homologada, o runtime não reserva compras. ML permanece
no caminho assistido anterior. E-mail operacional ainda não informado; cartão/login
não cadastrados; leitor de e-mail não implementado. Não prometer zero aprovação humana.
Não há parceria/API por acordo, nem subagentes acessando o mesmo carrinho simultaneamente.

Novas tabelas PurchaseAccount/TrackingSubscription e campos de PurchaseJob estão na
migration aditiva `20260906150000_purchase_execution`, após DeliveryEvent. Dois tokens
separam comprador e leitor; aprovação requer sessão /ops. Chrome não herda chaves do
processo. `LIA_PURCHASE_SUBMIT_OFF=true` pausa novas finalizações. A tarefa horária não
foi modificada e nenhum processo foi deixado comprando.

Validação final: **558/558**, zero skips, migrations sem drift, TypeScript do app e
do runtime, lint e build aprovados. Chrome com loja e painel simulados aprovados.
Teste antigo de adulteração do token corrigido para não depender do caractere sorteado.

Implementação, validações e ativação: [compra-e-acompanhamento-2026-09-06.md](docs/compra-e-acompanhamento-2026-09-06.md).

## Decisão 06/09/2026 — SEM lojas parceiras

Dono: **“eu nao vou ter loja parceira acaba com essa ideia”**. Restrição vigente:
a Lia compra como cliente nos sites existentes. Não propor parceria comercial, API
privada de varejista dependente de acordo, faturamento negociado ou pivot para atender
lojistas como solução de compra. Esta decisão substitui recomendações contrárias na
revisão de 06/09 e no histórico abaixo.
Arquitetura a desenvolver: contas da Lia nos sites, meio de pagamento corporativo,
preparação/execução pelo checkout disponível ao comprador, fila por conta e
reconciliação; rastreio por e-mails, links e área Meus pedidos. A restrição não autoriza
compras nem elimina exigências de confirmação do canal. Reduzir intervenção dentro
desse modelo; não voltar a oferecer parceria como saída para suas limitações.
Relatório revisado: [docs/revisao-completa-2026-09-06.md](docs/revisao-completa-2026-09-06.md).


## Atualização 06/09/2026 — revisão integral, compras e acompanhamento (LOCAL, NÃO PUBLICADO)

Pedido do dono: revisar código/eficiência, negócio, arquitetura de compra por IA e avisos
de saída/entrega. Relatório atual: [docs/revisao-completa-2026-09-06.md](docs/revisao-completa-2026-09-06.md).
Correções locais: pagamento + razão atômicos; replay preserva estorno; segunda cobrança
vira inesperada; estornos concorrentes serializados com identidade por parcela e conferência
do resultado; rollback de emissão não sobrescreve pago; timeout de Pagar.me/Meta.
Worker exige razão real e cesta/endereço válidos, domínio exato e reserva por loja; lease
vencido exige reconciliação. Preparação pode habilitar nove VTEX por
`LIA_PURCHASE_PREP_STORES`, mas o default continua ML e o payload sempre `cart_only`.
Isso NÃO implementa robô para as lojas nem autoriza checkout final.

`DeliveryEvent` + migration aditiva `20260906090000_delivery_events`: mudança de etapa e
evento na mesma transação, número da compra obrigatório, dedupe, link preservado,
aviso por template fora da janela, estados de envio/recibos Meta e pendências no /ops.
Rota interna de evidência de rastreio usa `requireOpsKey`, desativada salvo
`LIA_TRACKING_INGEST_ENABLED=true`; exige loja/número exatos e recusa múltiplas entregas.
Não há conector real de e-mail/transportadora nesta entrega. **O monitor local alterado
também consulta DeliveryEvent: não rodar contra produção antes da migration.**
Plano B não aceita consulta desconhecida; margem passa a ser por unidade e devolve
diferenças positivas menores que R$1. Ainda falta simulação da cesta substituta inteira.
Teste sem TEST_DATABASE_URL não herda produção; shadow nunca usa DATABASE_URL como fallback.

Validação: baseline 531/531; final 551/551, zero skips, Postgres local + migration/drift;
tsc, lint e build aprovados. Busca determinística 34/38, sem LLM pago. Auditoria de
dependências: 25 alertas (22 high, 3 moderate); Next14 fora de suporte, atualização ainda
pendente. Nenhum deploy, compra, cobrança ou mensagem real nesta revisão. Automação horária
foi apenas inspecionada; seu prompt já prepara outras lojas com cartão corporativo salvo
e exige confirmação final. A fila durável, antes, representava somente ML.

Recomendação (não mudança comercial aprovada): poucas lojas homologadas, uma loja por
pedido no primeiro fluxo automatizado, compra disparada por evento de pagamento, meio de
pagamento operacional separado do PSP do cliente, acompanhamento por pacote/evidência.
Subagentes não removem aprovação financeira exigida pelo canal de Computer Use; eventual
a execução deve respeitar as confirmações financeiras do canal.
Consulta READ ONLY do razão às 10:18 UTC: 3 pedidos com PSP registrado, R$63,54, R$24,14
de estorno registrado, 1 número de compra, 0 deliveredAt. Não é todo histórico nem prova
de liquidação ou de inexistência de entregas; não usar 466 registros totais como vendas.


## Atualização 06/09/2026 — caso real do isqueiro pra charuto (pai do dono): 4 consertos

Conversa real 06/09 22h36: "Queria um isqueiro pra charuto" → a IA extraiu "isqueiro" (perdeu
o qualificador) → sem vitrine local → oferta do ML → aceitou → isqueiros USB genéricos →
"Estes não são bons. Tem que ser estilo tocha" (virou item novo "Estes não são bons") →
"Isqueiro maçarico" (nada local → oferta do ML com escolha aberta) → "sim" ignorado (o
handler da oferta exigia sem escolha aberta) → desistiu. Consertos:
1. **`ParsedLine.raw`**: em `mergeShoppingLines`, quando a IA encurta a frase e a versão
   determinística tem mais tokens de produto (≤ 6), a completa vai em `raw`; a oferta e
   `rescueLongTail` buscam no ML com `raw` ("isqueiro pra charuto"), não com "isqueiro".
2. **Especificação durante a escolha vira busca nova no ML** (`researchChoice`): texto que
   compartilha o substantivo com a escolha aberta ("isqueiro maçarico") e não existe nas
   vitrines → busca com `forceLongTail` e troca as opções ("Ficou entre essas de…"), sem
   oferecer/perguntar. Paginação e refino sobre opções do ML também buscam no ML
   (`choiceCandidates` com `forceLongTail` quando `storeKey === "mercadolivre"`).
3. **"Estes não são bons. Tem que ser estilo X"** (`STYLE_ASK_RE`/`REJECT_ONLY_RE`):
   rejeição opcional + "tem que ser / estilo / tipo / modelo X" → busca "<produto> X";
   rejeição sozinha → próximas opções.
4. **Oferta do ML com escolha aberta**: o BOTÃO "Sim, procura" vale sempre; a busca nova
   substitui a escolha aberta do mesmo produto e mantém as de outros itens.
Testes: `lighter-longtail` (4, ML por SearchCache semeado). Suíte 564/564.

## Atualização 05/09/2026 (2ª) — "mais vendido da loja" como desempate

Dono: *"dá pra ranquear os que vêm antes por mais comprado?"* Pela Lia ainda não (7 pedidos
reais); pela loja, sim, nas 9 VTEX: o harvest (`harvest-vtex-catalog.mts`) já varre com
`O=OrderByTopSaleDESC`, então a posição no arquivo É o rank de vendas. Agora:
1. `CatalogItem.popularity` (1 = campeão). O harvest emite o campo; os 9 catálogos existentes
   ganharam por `scripts/backfill-popularity.mts` (sem rede, pela ordem do arquivo). Carrefour,
   Petz, Boticário e demais NÃO têm o campo (ordem de página não é venda) — `ensurePopularity`
   não roda em runtime por isso.
2. `rankCatalog` usa `popularity` como desempate DEPOIS de relevância, variante infantil,
   embalagem comum e básico-antes-de-variante (regras do dono) e ANTES do preço. Nunca passa
   por cima de um match melhor. ML já pontuava por vendas/avaliações.
3. Ranking pela própria Lia ("mais comprado aqui") fica para quando o piloto tiver volume.
Testes: `popularity-rank` (3). Suíte 531/531.

## Atualização 05/09/2026 — regra do prazo por loja + "preciso pra hoje"

Dono (05/09): *"pras que está exato você sempre manda; pras que não são, não manda; e se o
cara fala 'preciso de algo que chega hoje', você precisa achar uma coisa que chega hoje."*

1. **Prazo/frete só de loja consultável** (9 lojas VTEX: Pague Menos, Drogaria SP, Cobasi,
   Oba, Swift, Divvino, Kopenhagen, Ri Happy, Natural da Terra) — valor e SLA vêm do checkout
   da própria loja para o CEP e a cesta, no instante. As outras 9 (Carrefour, Petz, Boticário,
   Decathlon, Kalunga, Cacau Show, Droga Raia, Imigrantes, Giuliana) não mostram prazo, usam
   tabela semeada e NUNCA são cobradas automático (operador confere). Já era assim; confirmado
   com amostra real por loja em 05/09 (Oba responde "0bd" = "prazo da loja: hoje").
2. **"Pra hoje"** (`hasUrgencySignal` no texto do pedido): `liveItemAvailability` passa a
   devolver também a entrega MAIS RÁPIDA do item (`fastEstimate/fastEtaMinutes/fastFee`);
   em `buildChoices`, com urgência, a vitrine fica só com candidatos cuja entrega mais rápida
   é < 1 dia (`LIA_SAME_DAY_MAX_MINUTES`, 1440), o card mostra esse prazo ("prazo da loja:
   2h") e o cabeçalho vira **"Chega hoje — opções de X:"**. Sem ninguém entregando hoje:
   **"Nada chega hoje para X nas lojas que consigo confirmar. O mais rápido que tenho:"** com
   a vitrine normal. O aviso genérico `urgencyHonest` (28/08) saiu. A cotação depois oferece
   a opção rápida (08/09 8ª) — o cliente escolhe e o operador compra com ela.
3. Farmácia sem remédio: Drogaria SP, Pague Menos e Droga Raia estão na vitrine; medicamento
   é barrado pelo filtro ANVISA (`anvisa.ts`) em qualquer loja.
Gancho de teste: `__setLiveSimulateForTests` (live-availability). Testes: `urgency-today` (3).

## Atualização 04/09/2026 (8ª) — entrega expressa da loja é escolha do cliente, com o prazo

Dono: *"tem que dar essa opção de super expressa e expressa na hora pro cara escolher"* e
*"tem que dar o tempo também, não só rápido e devagar"*. Reaproveitado o fluxo barato × rápido
do ML (`choosing_freight`):
1. `liveStoreFreight` devolve `faster` = a entrega mais rápida da loja para a cesta (por item
   o menor prazo, empate pelo preço), só se for mais rápida que a mais barata e o extra couber
   em `LIA_FAST_FREIGHT_MAX_EXTRA` (R$ 20). Leva o nome da opção ("SUPER EXPRESSA").
2. Cotação instantânea de **uma loja só** com `faster` → em vez de publicar direto, manda a
   escolha: "*1)* Mais barata — R$ X · prazo da loja: 1 dia útil / *2)* Mais rápida — R$ Y ·
   prazo da loja: 60 min", botões com o tempo ("Mais rápido · 60 min"). `freightChoice.kind =
   "store"`; ML continua `kind` ausente/"ml" com "chega até <data>".
3. Escolha → nota ao operador *"comprar com ESSA opção de entrega no site da loja, AGORA (o
   prazo conta da compra)"* e o resumo sai com o prazo da loja escolhido.
Cesta com mais de uma loja não oferece (combinação confunde); fica para depois se aparecer.
Lembrete: com compra manual, a expressa só é honesta se o operador comprar em minutos.

## Atualização 04/09/2026 (7ª) — "chegava em 90 min": prazo é da loja, contado da compra

Dono: *"tava escrito que chegava em 90 min mas não acho que é verdade."* Verificado na
simulação da Drogaria SP para o CEP dele: a loja realmente tem SLA de 60–90 min (SUPER
EXPRESSA) e 1 dia útil (NORMAL, R$ 6,90, a que cobramos). O problema não era o dado, era a
frase: "chega em 90 min" faz o relógio começar no toque do cliente, mas o prazo da loja
conta a partir da compra na loja — que hoje é manual (o pedido ficou horas sem compra).
Mudanças:
1. `humanEstimate` agora escreve **"prazo da loja: 90 min" / "prazo da loja: 1 dia útil"**
   em cards e mensagens — diz de quem é o prazo. "Chega em" volta quando a compra for
   automática e o relógio for nosso.
2. O **resumo da cotação instantânea** passa a mostrar o prazo da loja (SLA da simulação,
   o mais lento entre as lojas da cesta) — antes só o card mostrava e o resumo saía sem prazo
   (`publishInstantQuote.storeEstimate`).
Card e cotação usam o MESMO SLA (o mais barato com entrega), então prazo e frete batem.
Lembrete estrutural: enquanto a compra for manual, nenhum prazo curto da loja é honesto sem
alguém comprando em minutos — é a decisão pendente de compra automática.

## Atualização 04/09/2026 (6ª) — conversa real do dono (desodorante): 5 regras novas

Teste real às 14h04 (pedido #OG9F4M, pago no cartão salvo). Decisões do dono, todas em código:

1. **Pedido parado + item novo do nada = pedido NOVO, sem perguntar.** A pergunta "juntar ou
   pedido novo?" (01/09) saiu: *"se ele esquece do outro e pede outra coisa, só dá o que ele
   pede."* O contexto vira endereço-só e a busca do item novo roda na hora; o pedido antigo
   em `awaiting_payment` fica como está (Pix válido até vencer). "Adiciona/bota/mais um" ou
   cobrança emitida há <10 min continuam fundindo. `resetConversationForClosedOrder` agora
   preserva escolha em voo (`pending`) quando o Pix antigo é pago no meio.
2. **Texto que nomeia uma opção NÃO escolhe.** "masculino"/"tio joão"/"a parmalat" com uma
   só opção batendo mostrava o card e já fechava. Agora `parseChoiceReply` devolve
   `{ type: "name" }` e `narrowChoiceByName` com 1 resultado estreita para aquele card
   ("Ficou entre essas…"); só número, ordinal, "mais barato/caro" ou o botão escolhem.
3. **Refino sem match à risca busca com a frase inteira.** "quero do grande masculino",
   "100ml": atributo que nenhum candidato casa não morre em "não achei"; `refineOptions`
   roda `choiceCandidates` com a frase refinada (marca + atributos como termos) e mostra
   "Não achei exatamente *grande masculino*. O mais perto que tenho:" (`copy.refineClosest`).
4. **Rodapé "Cobrança segura via Pagar.me" removido** dos botões do cartão salvo.
5. **Uma confirmação só após o cartão:** o `order_status` nativo leva
   `copy.paymentConfirmed()` e `markDeliveryOrderPaid(…, { notifyCustomer: false })` não
   repete; se o status falhar, o texto de sempre sai.

Testes: `choice-refine-2026-09-04` (2 E2E), `manual-concierge` (3 reescritos), `saved-card`,
`lia-intents` ajustados. Suíte 524/524.

## Atualização 04/09/2026 (5ª) — recursos do WhatsApp: digitando, localização, lista, boas-vindas, perfil, Flow

Pedido do dono ("implementar esses"). O que entrou no código (`adapters/whatsapp.ts`,
webhook, `reverse-geocode.ts`, `meta-setup.ts`):

1. **"Digitando…"** — `markReadWithTyping(messageId)` no webhook, fire-and-forget, antes de
   processar: marca como lida e mostra o indicador por até 25 s. `LIA_TYPING_OFF=true` desliga.
2. **Botão "Enviar localização"** — todo pedido de CEP/endereço (`askAddress`) vai como
   `location_request_message`. A localização volta como tipo `location`; o webhook faz
   geocodificação reversa (Nominatim, 4 s, `reverseGeocode`) e injeta o **CEP** como texto —
   o fluxo segue normal (ViaCEP resolve a rua e pede o número). Sem CEP legível →
   `copy.locationNotResolved`.
3. **Lista** — `sendListMessage` (≤10 linhas; título 24, descrição 72). Primeiro uso:
   quantidade virou lista 1–6 + "Outra" (ids `qty:N` de sempre). "Ver outras" continua em
   cards por decisão de manter a vitrine.
4. **Boas-vindas + perguntas sugeridas** — configuradas na Meta (`conversational_automation`:
   welcome + 4 prompts). O primeiro toque chega como `request_welcome` e vira "oi" no webhook
   (onboarding com botão de localização). Só ligar DEPOIS do deploy do webhook, senão o
   cliente recebe "só leio texto".
5. **Perfil comercial** — about/descrição/e-mail/site/vertical + foto
   (`public/brand/lia-whatsapp-profile-hd.png` via upload resumível).
6. **Flow de endereço** — formulário no chat (CEP/rua/bairro/cidade pré-preenchidos, número
   obrigatório, complemento). Criado e publicado via `POST /{WABA}/flows` (`ADDRESS_FLOW_JSON`);
   enviado em `askStreetAndNumber` quando `LIA_FLOW_ADDRESS_ID` existe; a resposta
   (`nfm_reply.response_json`) vira linha de endereço completo (`flowAddressToText`) que o
   parser já entende. Sem env → texto de sempre.
7. **Carrossel** — NÃO implementado: na Cloud API só existe em **template de marketing**
   (aprovação + custo de marketing por envio, sem janela grátis). Cards separados ficam.

Configuração na Meta roda de dentro da Vercel (`/api/ops/meta-setup`, sessão do /ops; GET =
status, POST {action}) porque o token é sensível e não sai da Vercel. Testes:
`whatsapp-2026-features` (7) + adapter ajustado. Suíte 520/520.

## Atualização 04/09/2026 (4ª) — "o de sempre": produto já comprado vem primeiro, com destaque

Decisão do dono sobre a vitrine: **fica o modelo de até 3 opções**. A única mudança pedida:
*"quando alguém já pediu algo e pede de novo, tem que ser o primeiro ou ter destaque."*
Implementado em `buildChoices`: `preferredSkuCounts(userId)` (pedidos pagos/entregues) já
subia o sku no ranking, mas a IA/diversificação e a ordenação por prazo podiam deixá-lo fora
ou abaixo. Agora o já comprado (a) **entra garantido** nas opções se sobreviveu à verificação
ao vivo, (b) **vem primeiro** (`byRepeatThenVerifiedThenEta`), e (c) ganha **destaque**:
`ChoiceOption.repeat` → card Meta com linha "⭐ Você já pediu este" (`badge`), texto/foto com
"⭐ … · _você já pediu_" (`choiceLine`). "Ir direto" (pular a escolha) NÃO foi ligado, por
decisão de manter a escolha. Testes: `repeat-purchase` (3) + eval de memória ajustado.

Registrado como direção futura (não fazer agora): card único com "Ver outras" quando o pedido
é específico ou básico; pergunta única quando há ambiguidade conhecida ("óleo", "leite").
Números de 04/09: golden determinístico acerta a 1ª posição em 30/33; no chat real, escolhas
por número foram "1" 592×, "2" 30×, "3" 10×, "outras" 22× (inflado por outras perguntas).

## Atualização 04/09/2026 (3ª) — "nunca é pra não ter algo": pré-voo, plano B e lembrete em 30 min

Dono: *"precisamos melhorar tudo pra ter certeza que nunca vai falhar e chegar nesse ponto
[estorno]."* Três garantias novas em código, na ordem em que a cadeia pode falhar:

1. **Pré-voo antes de cobrar** (`preflightBasket` em `live-freight.ts`, chamado em
   `issueValidatedRetailerQuotePayment`): no instante em que o cliente diz "pix"/"cartão",
   a loja consultável é simulada de novo com a cesta inteira e as quantidades reais para o
   CEP. "Não" definitivo (sem estoque / sem entrega) → **nada é cobrado**, o pedido fecha com
   nota `🛫 PRÉ-VOO`, o resto da cesta volta pro contexto e os itens que faltaram são buscados
   de novo (a verificação ao vivo tira a loja que falhou e mostra só o confirmado). Loja fora
   do ar ou não consultável não inventa indisponibilidade. Gancho de teste
   `__setPreflightForTests`.
2. **Plano B automático** (`src/lib/plan-b.ts`): pedido PAGO com nota `🛑 COMPRA BLOQUEADA`
   → no próximo tick do cron (≤10 min, sem esperar balde) a Lia busca o mesmo item em outra
   loja consultável, confirma AO VIVO para o CEP (`checkCandidatesLive`), respeita a
   tolerância de preço (`LIA_PLAN_B_PRICE_TOLERANCE`, 15%), e oferece a troca com botões
   **Trocar** / **Devolver o dinheiro** (`sendPlanBButtons`; fora da janela de 24h vai por
   template com instrução em texto). Só troca a cesta inteira (item sem substituto = sem plano
   B, nota `🔁 PLANO B: sem substituto verificado`). **Trocar** → reconfirma ao vivo,
   substitui os itens do pedido (continua `paid`), devolve em parcial a diferença a favor do
   cliente (`refundOrderViaProvider(id, valor)`), absorve até a tolerância, limpa o bloqueio,
   nota `🔁 PLANO B aceito em <iso>` e alerta o operador com o link para comprar. **Devolver**
   → estorno integral na hora. Substituto esgotou entre oferta e aceite → estorno com motivo.
   Contexto: `ctx.planB` + passo `awaiting_plan_b`; handler no cérebro antes de
   `awaiting_merge_decision`. O relógio do estorno automático reinicia na oferta e no aceite.
3. **Primeiro lembrete em 30 min** (era 2h): baldes `30min, 2h, 6h, 12h, 24h, 48h, 72h`;
   bloqueio entra no cron na hora (query com `notes contains 🛑`). Cliente com bloqueio e sem
   plano B é avisado no primeiro alerta; com plano B já tem a pergunta na tela.

Sequência completa hoje: cards só do confirmado → pré-voo na cobrança → compra → se travar,
plano B em ≤10 min → sem resposta/sem substituto, estorno automático em 6h. Testes: `plan-b`
(8 E2E) + `paid-order-watchdog` ajustado. Suíte 510/510.

**O que NÃO é código e depende do dono (registrado em PENDENCIAS):**
- **Execução da compra.** Hoje 100% das compras são manuais: `ensurePurchaseJobForPaidOrder`
  só cria job para cesta 100% Mercado Livre, e o prompt do Codex manda parar antes do botão
  final. Enquanto ninguém aperta o botão, o pedido pago espera um humano — esta é a única
  etapa sem garantia. Opções: (a) autorizar o Codex a finalizar checkout dentro do teto
  (`approvalMaxTotal`) com cartão da empresa; (b) job de compra para toda loja consultável
  com link exato; (c) continuar manual com SLA de 30 min.
- **Carrefour, Petz e Boticário** não têm checkout consultável: não passam pelo pré-voo nem
  pelo plano B como destino. Manter via operador, ou tirar da vitrine automática.

## Atualização 04/09/2026 (2ª) — estorno AUTOMÁTICO quando a compra não dá certo

Decisão do dono (04/09): *"nunca é pra não dar certo, mas às vezes não vai, porque não é
perfeito, e aí tem que ir sem mim e sem /ops."* Regra em `autoRefundDecision` +
`watchPaidOrder` (`ops-lifecycle.ts`), executada pelo cron de reconciliação a cada 10 min:

1. Pedido **pago** (`status = paid`), **sem número de compra na loja** (`storeOrderNumber`
   vazio) e com nota `🛑 COMPRA BLOQUEADA` (sem estoque, sem entrega, mínimo, preço acima do
   teto) há **6h** (`LIA_AUTO_REFUND_BLOCKED_HOURS`) → estorno integral pelo provedor
   (`opsPurchaseFailedRefund` com `origin: "auto"`), pedido `refunded`, nota
   `🤖 Estorno automático (regra 04/09): …`, cliente avisado com motivo em linguagem simples
   (`customerReasonFromBlock`: "a loja ficou sem o item para o seu endereço" etc.) e alerta
   ao operador (`operatorAutoRefundAlert`).
2. Sem bloqueio mas **sem compra há 24h** (`LIA_AUTO_REFUND_STALE_HOURS`) → idem, motivo
   "não consegui confirmar a compra a tempo".
3. **Nunca** toca pedido que o operador moveu para `operator_buying`/`retailer_preparing`
   nem pedido com número de compra. Kill-switch: `LIA_AUTO_REFUND_OFF=true`.
   **Só pedidos pagos a partir de 04/09/2026 12:00 UTC** (`LIA_AUTO_REFUND_SINCE`): no primeiro
   tick do cron (13:00 UTC de 04/09) a regra pegou 15 pedidos `paid` antigos de junho–agosto
   (testes/sandbox sem linha em `Payment`) — nenhum dinheiro saiu (o provedor recusou por
   falta de razão), mas o operador recebeu 15 alertas "FALHOU" e as notas ganharam o marcador.
   Corte por data publicado 2 min depois; marcadores limpos no banco. Lição: regra retroativa
   sobre dinheiro precisa de data de corte desde o primeiro deploy.
4. Estorno vem ANTES do alerta de "pendente Nh" do mesmo tick. Se o provedor falhar, o
   pedido continua `paid`, nota `⚠️ ESTORNO AUTOMÁTICO FALHOU` + alerta ao operador **uma
   vez**, e o cron tenta de novo a cada 10 min (`auto_refund_failed`).
5. Sequência vista pelo cliente com bloqueio: 2h "travou na loja, estou tentando outra; se
   não der, devolvo" → 6h "não consegui comprar (motivo). Estornei R$X". Sem bloqueio: 6h/12h
   "está demorando" → 24h estorno.

O botão "Não consegui comprar → estornar" continua no /ops para antecipar. Testes: 4 cenários
novos em `paid-order-watchdog` (estorna, não estorna cedo, kill-switch/em compra, provedor
falha). Relatório do cron ganha `autoRefunds`.

## Atualização 04/09/2026 — login do /ops pelo WhatsApp (acabou o "pega o OPS_TOKEN na Vercel")

Dono, 04/09: *"eu nunca consigo abrir essa droga de ops… odeio entrar na Vercel e pegar
coisas."* A barreira era o `?key=OPS_TOKEN` na URL. Regra nova:

1. O operador manda **"ops"** (ou "painel", "login", "entrar") pra Lia no WhatsApp.
   Só telefone de operador recebe resposta especial: `LIA_OPERATOR_PHONE` e
   `LIA_ADMIN_PHONES` (`isAdminPhone` em `turn-runtime.ts`); cliente comum cai no fluxo
   normal. A Meta garante o remetente, por isso o telefone basta como identidade.
2. A Lia responde com `https://liadelivery.com.br/api/ops/login?login=<token>`: token de
   **10 min** assinado com o próprio `OPS_TOKEN` (`createOpsLoginToken`/`verifyOpsLoginToken`
   em `auth.ts`; nada novo pra guardar). Abrir o link grava o mesmo cookie `ops_session`
   (HMAC do token) por **1 ano** e redireciona pro `/ops`. Link vencido → `/ops?expired=1`.
3. `?key=` continua funcionando como alternativa. Sem `OPS_TOKEN` em deploy não há link
   (fail-closed, revisão 01/09).
4. `LIA_PUBLIC_URL` só se o domínio não for `liadelivery.com.br`.

Mesmo dia, fila do /ops: pedido pago e travado ficava no FIM da página atrás de cotações
abandonadas (ordem `createdAt asc`). Agora `getOperatorQueue` ordena por **prioridade de
ação** (estorno pendente → pago → cotação manual → comprando → preparando → saiu → aguardando
cliente) e, no grupo, o mais novo em cima. Idade no card virou dias → horas → minutos
("há 1d 22h 5min"; absoluto no tooltip) porque "há 46h05" parecia hora do relógio.

Limite: o link não é de uso único (expira em 10 min). Se vazar dentro desse tempo, quem abrir
entra; aceitável no piloto, registrado em PENDENCIAS. Testes: `ops-login-token` (unit) e
`ops-whatsapp-login` (E2E).

## Atualização 03/09/2026 (3ª) — janela de 24h da Meta: aviso proativo vai por template ou não vai

Descoberta ao auditar o vigia do chá: os alertas de 12h e 24h saíram do código, mas a Meta
**descartou** o aviso ao cliente e o alerta ao operador com erro `131047 Re-engagement` —
mensagem livre só chega até 24h depois da última mensagem daquele telefone; a Graph responde
200 e a falha vem depois, pelo webhook de status. O operador quase nunca escreve pra Lia,
então **todo alerta interno fora da janela vinha morrendo em silêncio**.

Regra agora (`deliverNotice` em `turn-runtime.ts`):
1. Aviso PROATIVO (vigia, estorno por compra falhada, alerta ao operador) mede a janela pela
   última mensagem inbound gravada (`lastInboundAt`, limite 23h). Dentro → texto normal.
2. Fora → **template aprovado** (`LIA_TEMPLATE_ORDER_UPDATE`, body `{{1}}` = pedido, `{{2}}` =
   texto; `sendTemplateMessage` no adapter Meta, parâmetros saneados sem quebra de linha).
3. Fora e sem template → **não envia** (falharia) e grava na nota do pedido
   "⚠️ Aviso ao cliente NÃO enviado: fora da janela de 24h…" para o operador avisar por outro
   canal. Resposta a mensagem do cliente (dentro do turno) não muda: está sempre na janela.

**Dono:** criar o template no WhatsApp Manager (categoria Utility, ex. `pedido_atualizacao`,
body sugerido "Olá! Aqui é a Lia, com uma atualização sobre o seu pedido {{1}}: {{2}} Se precisar de algo, é só responder esta mensagem."), esperar aprovação e setar
`LIA_TEMPLATE_ORDER_UPDATE` na Vercel e **redeploy**. Passo a passo completo em
[docs/whatsapp-template-avisos.md](docs/whatsapp-template-avisos.md) (a Meta rejeita corpo que
começa ou termina com variável). Enquanto não existe, cliente fora da janela só é
alcançável se ele escrever primeiro (ou pelo telefone pessoal do dono). Alternativa para o
operador: alerta por outro canal (e-mail/push) — pendência.

## Atualização 03/09/2026 (2ª) — "só ofereço o que a loja confirmou": verificação ao vivo antes dos cards

Regra do dono depois do chá: *"se ele quer um chá, tem que dar em um lugar que tenha chá,
que esteja disponível e que chegue rápido."* Implementado como regra de produto, não
conserto pontual:

1. **Verificação ao vivo ANTES dos cards** (`src/lib/live-availability.ts` +
   `liveItemAvailability` em `live-freight.ts`): para cada linha buscada, os candidatos
   de lojas com checkout consultável (VTEX_LIVE: Pague Menos, Drogaria SP, Cobasi, Oba,
   Swift, Divvino, Kopenhagen, Ri Happy, Natural da Terra) são simulados no site da
   PRÓPRIA loja para o CEP do cliente, uma chamada por loja (≤12 skus, em paralelo, timeout
   4,5s). Sem estoque ou sem opção de entrega no endereço → **sai da vitrine**. Confirmado
   → ganha `verified`, `etaMinutes` e o prazo real no card (`delivery`: "chega em 1 dia
   útil"). Vale também na paginação/refino ("outras"). Loja que não responde = desconhecido
   (mantém, nunca inventa indisponibilidade). Log `[live-check:dropped]`.
2. **Ordem dos cards**: confirmado pela loja vem antes do não-verificável; entre
   confirmados, o que chega antes vem primeiro; empate mantém a relevância do rerank.
3. **Prazo no card volta — só com dado real.** A regra dura de 17/08 ("nenhum prazo em
   card") era contra estimativa nossa/frase genérica do anúncio. O prazo que a simulação
   devolve para o CEP do cliente é o dado real que a regra exigia; ML continua sem prazo no
   card (a busca do actor não é por CEP).
4. **Cobrança automática SÓ do que foi confirmado ao vivo** (`LIA_CHARGE_ONLY_VERIFIED`,
   default true): na cotação instantânea, loja cuja fonte de frete não é `vivo` (tabela
   semeada ou tarifa padrão) manda o pedido pro operador conferir estoque/entrega/mínimo
   antes de cobrar, com o motivo na nota. Zero-espera continua para lojas VTEX (a maioria
   das vitrines) e para o ML (frete por anúncio ao vivo); Carrefour, Petz e Boticário
   (bloqueiam consulta externa) passam pelo operador até haver forma de confirmar.
   Nos evals (`load-env`) o modo estrito fica desligado porque a simulação está off; o
   estrito tem teste próprio em `tests/paid-order-watchdog.test.ts`.

Testes: `tests/live-availability.test.ts` (puro, simulação injetada), `live-freight.test.ts`
(+3: por item, erro→null, prazo humano), watchdog (+1 estrito). Suíte 491/491.

**O que ainda NÃO é garantido:** lojas sem checkout consultável (Carrefour, Petz,
Boticário, Imigrantes, Kalunga, Decathlon, Cacau Show, Giuliana, Droga Raia) — nelas o
operador é a verificação. Próximo passo natural: mapear se alguma expõe simulação por
outro caminho ou tirá-las da vitrine automática.

## Atualização 03/09/2026 — chá pago sem estoque: 4 consertos (caso real do amigo do dono)

Pedido `cmtk5b3lr000jlsj15w41epw0` (02/09 10h45, cartão, R$24,14): Ice Tea de R$4,49 na
Natural da Terra cobrado com **"tarifa padrão R$18"**; na hora de comprar, o item não tinha
estoque para o CEP, o site exige mínimo de R$50 e a Pague Menos não entregava no CEP. O
cliente ficou o dia inteiro sem notícia. Causa raiz: a Natural da Terra **não estava em
`VTEX_LIVE`** (live-freight.ts) — a simulação do próprio site responde `withoutStock` para
esse item/CEP, ou seja, o bloqueio antes de cobrar era possível — e a cotação instantânea
cobrava em cima de "tarifa padrão", que é chute. Consertos, todos com E2E em
`tests/paid-order-watchdog.test.ts`:

1. **Natural da Terra na simulação ao vivo** (`VTEX_LIVE`, sku `naturaldaterra-<id>`) e
   **mínimo default R$50** (`LIA_NATURALDATERRA_MIN_ORDER`). Giuliana Flores testada: não é
   VTEX (404) — segue sem simulação.
2. **"Tarifa padrão" não cobra automático**: loja sem política calibrada nem simulação
   (`source === "padrao"`) manda a cotação pro operador conferir estoque, entrega e mínimo,
   com o motivo na nota. Zero-espera continua valendo para lojas calibradas; calibrar uma
   loja (SEED_STORE_FREIGHT / LIA_STORE_FREIGHT_<LOJA> / VTEX_LIVE) devolve o automático.
3. **Vigia de pedido pago sem compra** (`watchPaidOrder`, no cron de 10 min): pago há 2h+
   sem `storeOrderNumber` → alerta ao operador (buckets 2/6/12/24/48/72h, idempotente por
   marcador `⏰ COMPRA PENDENTE Nh`); com nota `🛑 COMPRA BLOQUEADA` avisa o cliente já no
   1º alerta (e em 24h+); sem bloqueio, avisa o cliente a partir de 6h. Copy honesta, sem
   prazo (`purchaseDelayedCustomer`).
4. **Botão "Não consegui comprar → estornar"** no card de pedido pago do /ops
   (`opsPurchaseFailedRefund`): estorna pelo provedor (razão `Payment`), fecha como
   `refunded`, solta a conversa e explica ao cliente com o motivo e o valor
   (`purchaseFailedRefunded`). Sem razão de pagamento (pedido antigo) lança mensagem
   legível e o caminho manual continua.

**Decisão do dono pendente para o pedido do amigo:** estornar (um clique no botão novo,
motivo "sem estoque para o seu endereço") ou comprar em outra loja e "Confirmar compra".

## Atualização 02/09/2026 (4ª) — monitor de todas as lojas, não apenas jobs do ML

Pedido do dono: checar todos os pedidos sempre e atender o chá pago que estava invisível
ao worker. `npm run purchase-worker:monitor` agora consulta TODOS os pedidos ativos de
`DeliveryOrder`, encerrados/alterados nas últimas 24h e pendências financeiras, sem filtro
por loja, por existência de job ou limite N. `purchase-worker:inspect -- ID` traz o detalhe
de um pedido. Ambos são SOMENTE LEITURA; resumo compacto sem dados pessoais, evidência
de pagamento real antes de sugerir compra, bloqueios e jobs reservados exigem revisão.
**`purchase-worker:claim` com `job:null` NÃO significa que não há pedido.** O executor
continua restrito ao Mercado Livre; não ampliar checkout recorrente implicitamente.

A automação horária local `operador-de-compras-da-lia` foi atualizada para monitorar todas
as lojas e inspecionar impedimentos; preparação do carrinho ML continua parando antes
da confirmação final. Nenhum deploy/migration necessário para o monitor local.
Pedido #41EPW0: pagamento real confirmado, mas chá indisponível na Natural da Terra e
mínimo da loja de R$50 incompatível com a cotação; alternativa consultada sem entrega
ao CEP. Bloqueio anotado no pedido, **nenhuma compra/entrega realizada**. Não substituir
produto/loja nem aumentar gasto sem autorização. Gate: tsc, lint, 481/481 em `test:local`.
Detalhes: [docs/operador-automatico-local.md](docs/operador-automatico-local.md).

## Atualização 02/09/2026 (3ª) — deploy das melhorias em produção ("faz isso")

O dono mandou executar a lista de ações. Feito: **deploy de produção pela CLI**
(`shopping-agent-8pcyha9nk`, READY em 2 min) — o build aplicou sozinho as 4 migrations
(`waitlist_petz_image_indexes`, `payment_ledger`, `retailer_delivery_default`,
`drop_legacy_models`; confirmadas em `_prisma_migrations`); **`CRON_SECRET` criada** na Vercel
(Production + Preview; valor não registrado); **29 variáveis mortas removidas** da Vercel
(Twilio, Uber, Lalamove, Browserbase/Contexts, `ADMIN_*`, `LIA_MANUAL_CONCIERGE`,
`LIA_OPERATOR_PICKUP_*`, `LIA_REQUIRE_REAL_COURIER_DISPATCH`, `PURCHASE_AUTOMATION_ENABLED`,
`APIFY_WEBHOOK_SECRET`, `APIFY_MERCADO_LIVRE_CALLBACK_URL`, `MERCADO_LIVRE_REFRESH_TOKEN`,
`MERCADO_LIVRE_REDIRECT_URI`); **tabelas legadas do motor de junho DROPADAS** (Product,
ProductOption, Order, OpsTask, Preference — autorização explícita do dono); `.env.local.bak`
apagado. **Não feito por mim:** `git push origin main` (bloqueado pela política da sessão —
`main` está 10 commits à frente de `origin/main`; o dono roda o push) e abrir `/ops?key=`
(cookie do navegador do dono). Fica também o projeto Supabase exclusivo (plano gratuito no
limite de 2 projetos).

## Atualização 02/09/2026 (2ª) — as quatro melhorias da revisão EXECUTADAS ("pode fazer tudo isso")

Decisão do dono em 02/09: executar os quatro itens da seção 3 do relatório
[docs/revisao-completa-2026-09-01.md](docs/revisao-completa-2026-09-01.md). Feito em
cinco commits (fases 1, 2, 3a, 3c, 3b, 4), cada um com `tsc`, lint e suíte inteira verde.
Regras novas que valem a partir daqui:

1. **Teste ≠ produção.** `npm run test:local` sobe um Postgres embutido (`embedded-postgres`,
   pasta `.local-pg/`), recria `lia_test`, aplica as migrations, roda o gate de drift
   (`npm run db:check`) e a suíte inteira: **476 testes em ~15 s** (antes: 53 min no banco
   remoto de produção). É o gate padrão; **nunca mais rodar a suíte contra o DATABASE_URL de
   produção**. `TEST_DATABASE_URL` redireciona a suíte; `LIA_REQUIRE_DB=1` transforma "sem
   banco → skip" em falha (CI em `.github/workflows/ci.yml`: tsc, lint, unit, E2E com Postgres
   em serviço). O build de PRODUÇÃO na Vercel aplica as migrations pendentes
   (`scripts/migrate-on-build.mjs`); Preview não toca no banco.
2. **Dinheiro de ponta a ponta.** Tabela `Payment` (razão: provedor, id, valor, quanto voltou,
   referência) alimentada por `markDeliveryOrderPaid` com evidência. Estorno pela API do
   provedor (`refundOrderViaProvider` → MP `/refunds` ou Pagar.me `DELETE /charges`) via
   `opsRefundViaProvider` e botão "Estornar pelo provedor" no /ops (manual continua). Em
   deploy de produção **não existe mock de pagamento** (`paymentsAreMocked()` é false; Pix/
   link sem credencial lançam). Pagar.me 4xx = `unavailable` (nunca "cartão recusado").
   Workflow do cartão: reentrada `duplicate` cobra; retries esgotados → `unknown_outcome` +
   nota + alerta. Pix vencido → `markPixExpired` (limpa código, avisa uma vez). Cron
   `/api/cron/reconcile-payments` (a cada 10 min, `CRON_SECRET`) reconcilia tentativas e Pix.
3. **Legado apagado.** Twilio, /admin, /chat, /api/v1, /api/conversations, /api/twilio,
   callback Apify, motor de busca ML de junho (chat-service, suppliers, products, messaging,
   fulfillment, payment, types.ts, aiAdapter), fluxo legado de catálogo dentro do cérebro
   (`LIA_MANUAL_CONCIERGE` não existe mais — o concierge é o único caminho), couriers/motoboy
   (Uber/Lalamove/Loggi, `LIA_OPERATOR_PICKUP_*`, "motoboy na hora" no /ops), guarda de
   km/geo/nearest, pergunta de quantidade legada. **Não reintroduzir.** Os modelos Prisma
   `Product/ProductOption/Order/OpsTask/Preference` continuam no schema, anotados como
   legado, até o dono autorizar o DROP (migration destrutiva). `courierKey` default agora
   é `retailer_delivery`; `statusAfterStorePurchase` é sempre `retailer_preparing`.
4. **Cérebro em módulos.** `src/lib/conversation-types.ts` (tipos e contas puras),
   `turn-runtime.ts` (ctx/CAS, lock, reply, alertas), `order-payments.ts` (Pix/cartão,
   troca, saída de awaiting_payment, evidência, pago), `ops-lifecycle.ts` (cotação manual,
   comprado, saiu, entregue, estorno, fila, lista de espera) e `delivery-service.ts` (só a
   conversa, 4.085 linhas; re-exporta a API pública). Camadas sem ciclo: tipos ← turno ←
   pagamentos ← operação ← conversa. Função nova vai no módulo da sua camada.
5. **Classificar antes de buscar.** Frase solta passa pelo roteador LLM ANTES da busca
   (`classifyFirstEnabled`, kill-switch `LIA_CLASSIFY_FIRST=false`); lista com quantidades
   vai direto. `unknown` em pergunta responde `questionNotUnderstood` ("não sei") em vez de
   virar produto. **Cauda longa opt-in**: a primeira busca é só nas vitrines locais (sem
   prefetch pago); o que não tem preço vira "quer que eu procure no Mercado Livre?"
   (botões `longtail_sim`/`longtail_nao`, texto sim/não); "sim" → `rescueLongTail`. Kill-
   switch `LIA_LONGTAIL_OPTIN=false` (os testes de resgate automático o usam). Memória de
   compra (`preferredSkuCounts`) passou a valer no concierge.

**Ações do dono depois deste ciclo:** (a) deploy — o build de produção aplica 3 migrations
(WaitlistLead/PetzImage+índices, Payment, default retailer_delivery); (b) `CRON_SECRET` na
Vercel (sem ela o cron nega); (c) abrir `/ops?key=<OPS_TOKEN>` uma vez; (d) observar o
primeiro pedido real com `[payment:unexpected]`, `[cron:reconcile-payments]` e a oferta do
Mercado Livre (copy nova, ajustar se soar estranha); (e) autorizar ou não o DROP das 5
tabelas legadas; (f) apagar `.env.local.bak`; (g) remover da Vercel as envs mortas
(`TWILIO_*`, `UBER_*`, `LALAMOVE_*`, `BROWSERBASE_*`, `*_BROWSER_CONTEXT_ID`,
`LIA_OPERATOR_PICKUP_*`, `LIA_REQUIRE_REAL_COURIER_DISPATCH`, `LIA_MANUAL_CONCIERGE`,
`ADMIN_USER/PASSWORD`, `MERCADO_LIVRE_REFRESH_TOKEN`, `APIFY_WEBHOOK_SECRET`,
`APIFY_MERCADO_LIVRE_CALLBACK_URL`).

## Atualização 02/09/2026 — revisão completa (código + negócio) com o modelo novo

Pedido do dono: revisão completa do código, sugestões e leitura do modelo de negócio.
Relatório canônico: [docs/revisao-completa-2026-09-01.md](docs/revisao-completa-2026-09-01.md)
(19 correções, achados abertos por severidade, inventário de legado, métricas reais do
banco e três caminhos de produto com recomendação). O que mudou no código, tudo com
regressão (`tests/payment-reconcile.test.ts` 6 E2E, `auth` +2, `pricing` +2):

1. **Dinheiro que chega tem que bater com a cobrança na mesa.** `markDeliveryOrderPaid`
   aceita evidência (provedor, id, valor); o webhook do MP a repassa. Valor diferente,
   Pix que não é o vigente, ou pedido fora de `awaiting_payment` → nota
   `⚠️ PAGAMENTO FORA DO ESPERADO` + alerta ao operador + aviso ao cliente
   (`copy.unexpectedPaymentReceived`), NUNCA aprovação. Replay idempotente. Webhook
   devolve 503 em falha nossa (o MP reenvia) e valida o id antes de ir na URL.
2. **Saída única de `awaiting_payment` sem dinheiro** (`closeUnpaidOrder`): guarda de
   status no UPDATE, bloqueio se há cartão salvo CONFIRMADO (`hasInFlightCardAttempt`,
   sem filtro de TTL) e cancelamento best-effort do Pix antigo no MP
   (`cancelMercadoPagoPayment`, nunca lança). Usada por cancelar, reabrir pra editar,
   juntar/pedido novo; a troca Pix↔cartão cancela o Pix anterior depois de gravar o novo.
3. `chargeConfirmedPaymentAttempt` reconfere status e valor do pedido ANTES do PSP;
   captura em pedido que saiu de `awaiting_payment` vira alerta via evidência.
4. `issueValidatedRetailerQuotePayment`: base recomposta de subtotal+margem+frete (o
   gross-up de um cartão que falhou não contamina o Pix seguinte) e o `catch` restaura
   `total` E `quoteExpiresAt` (sem isso o "pix" seguinte cancelava como "preço vencido").
5. `/ops`: `parseMoneyInput` ("12,90" era NaN → frete R$ 0) no cliente e no servidor;
   `awaiting_payment` entrou na fila; botão **"Cancelar e solicitar estorno"** voltou
   para pedido pago (ação excepcional do operador; o cliente segue sem cancelar pós-pago
   pelo chat); erros de domínio chegam com a mensagem real (409/400).
6. **Auth do /ops unificada** em `requireOpsKey` (auth.ts): fail-closed em deploy, tempo
   constante, cookie = HMAC do token, sem fallback pra `API_TOKEN`. **Depois do deploy,
   abrir `/ops?key=<OPS_TOKEN>` uma vez** (cookie antigo não vale). Callback Apify
   fail-closed + telefone tem que ser o dono da conversa; petz-image só raster + nosniff;
   OAuth do ML exige sessão admin.
7. Conversa: lock de turno 180s (`LIA_TURN_LOCK_TTL_MS`; 60s era menor que a busca
   fria); relógio de abandono considera `order.updatedAt` (cotação manual publicada tarde
   não é cancelada no "pix"); "trocar endereço" com o mesmo CEP não restaura a rua velha;
   "pix"/"cartão" sem cesta acha cotação publicada com a conversa em outro assunto.
8. Infra: migration `20260901120000_waitlist_petz_image_indexes` (IF NOT EXISTS + 3
   índices por cliente — **ainda não aplicada em produção**, decisão do dono),
   `migration_lock.toml`, `.env.example` com as 14 envs operacionais, `.gitignore` não
   engole mais `.env.example`; removidos `/api/mercadolivre/{notifications,callback}`,
   `scripts/preflight-oba-internal.mts`, `serverComponentsExternalPackages` morto.

**Regras que saem desta revisão:** (a) nenhuma aprovação de pagamento sem evidência
(id + valor) — não reintroduzir `markDeliveryOrderPaid(id)` seco em caminho de webhook;
(b) nenhuma saída de `awaiting_payment` fora de `closeUnpaidOrder`; (c) rota nova do
`/ops` usa `requireOpsKey`, nunca cópia local. Gate: `tsc`, lint, 109 unitários,
`payment-reconcile` + `payment-issue-failure` + `saved-card` + `whatsapp-pay.db`
23/23 com banco.

**Leitura de negócio (resumo; detalhe no relatório):** 10 semanas, 295 commits, 5
pedidos reais pagos (≈R$215, todos do dono/testadores), zero concluído de ponta a ponta
pelo varejista. A família de falha presente em 100% das rodadas (frete fragmentado /
mínimo por loja / troca forçada) é desenho, não bug. Markup de 10% em cesta de R$50–80
não paga o turno manual. Recomendação: congelar features por 4 semanas e rodar piloto de
30 pedidos com desconhecidos sob contrato simples (taxa fixa, uma loja por cesta, SLA
humano visível), com a rota de parceria com um varejista testada em paralelo. Decisão do
dono pendente.

## Atualização 01/09/2026 (5ª) — revisão da 4ª: três brechas fechadas

Revisão de código da entrega da 4ª (mesmo dia) achou três furos reais; todos fechados
com teste de regressão:

1. **Toque em "Pagar •••• 1234" ainda disparava "Me perdi aqui 😅" em produção.** O
   botão traz só o `attemptId` (sem last4), `handleSavedCardPay` não respondia nada e, em
   prod, `confirmSavedCardTap` só inicia o workflow durável e retorna — turno mudo → rede
   anti-silêncio. Agora o toque busca a tentativa e responde "Cobrando no cartão final
   *1234*" (replay de tentativa já cobrada só marca o turno). A suíte NÃO exercita o
   caminho do workflow (NODE_ENV≠production); a prova final é um toque real no canal.
2. **"Cobrança fresca" media o campo errado.** `chargeFresh` usava `DeliveryOrder.updatedAt`,
   que qualquer nota renova (reclamação, "quero falar com atendente", troca de método) —
   cliente reclamava e o item seguinte era fundido em silêncio de novo. Relógio novo:
   `ctx.paymentIssuedAt` (epoch ms, gravado nas duas escritas de `step: "awaiting_payment"`);
   fallback pro updatedAt só em contexto antigo sem o campo.
3. **Pix pago com a pergunta "juntar ou pedido novo?" aberta engolia o item novo.** O
   reset pós-pagamento apagava `mergeDecision` sem aviso. `markDeliveryOrderPaid` lê o
   pedido pendurado ANTES do reset e, depois da confirmação, manda `copy.newItemAfterPayment`
   ("como este pedido já está pago, vira pedido novo — me manda de novo"). Resposta
   atrasada "1"/"2" cai fora do passo e não mexe no pedido pago.

Menores: `wantsNew` não aceita mais "outro" sozinho ("quero outro modelo" durante a
pergunta é refinamento e cancelaria um Pix emitido) — só "novo", "separado" ou "outro
pedido"; o golden inverso ("apoio de pé para violão") passou de `/p[eé]/` (casava
"pedal", "especial") para `/apoio de p[eé]|descanso/`.

Gate: tsc, units 87/87, concierge "01/09" 10/10 (3 E2E novos: reclamação não renova a
janela + "outro modelo" re-pergunta; Pix pago com pergunta aberta avisa do item; regressão
do juntar×novo agora envelhece `paymentIssuedAt`, não o pedido), saved-card com asserção
"Cobrando…" + nunca "Me perdi" no toque e no replay.

## Atualização 01/09/2026 (4ª) — conversa real do dono expôs 4 defeitos; todos fechados

Caso real (livro #GAS8P9 esperando Pix há 2h + "preciso de um apoio pra guitarra de chão"):

1. **Fusão silenciosa morreu.** Pedido não-pago PARADO (cobrança > 10 min) + item novo
   do nada → a Lia PERGUNTA "juntar no pedido ou pedido novo?" (botões `juntar_pedido`/
   `pedido_novo`, estado `awaiting_merge_decision`, ctx.mergeDecision guarda pedido+texto).
   "Pedido novo" cancela o antigo (nada cobrado, note própria) e busca o item; "Juntar"
   segue o reopen de sempre. Adicionar explícito ("adiciona/bota/põe/mais um") ou cobrança
   recém-emitida (< 10 min) continuam fundindo direto — é edição, não missão nova.
   Futuro (PENDENCIAS): manter os DOIS pedidos abertos em paralelo.
2. **"Me perdi aqui 😅" espúrio**: os botões do cartão salvo saem direto pelo adapter
   (whatsapp-pay) sem passar pelo reply() — a rede anti-silêncio achava o turno mudo e
   mandava o fallback logo depois dos botões. `createCardAttempt` agora é wrapper local
   que marca o turno respondido.
3. **Botão "Editar itens"** no resumo da cotação (junto de Trocar endereço): responde o
   manual curto (`editItemsHelp`: tira/troca/2x/adicionar) — os comandos já funcionavam,
   faltava o caminho visível.
4. **Busca "apoio pra guitarra de chão"** devolveu apoio de PÉ como top1 → 2 casos novos
   no golden (`search-golden.ts`, deterministic:false) SEM conserto de scorer ainda —
   regra do projeto: caso primeiro, conserto medido pelo `scripts/eval-search.mts` depois.

## Atualização 01/09/2026 (3ª) — nome público reenviado sem CNPJ/nome pessoal

O print real do iPhone confirmou que o cabeçalho público ainda mostrava
`Lia Delivery by 67.742.955 Joseph Carlos Dayan`. No WhatsApp Manager do número
`+55 11 97844-4813`, o nome antigo estava **Approved**. Por ordem do dono, foi
reenviada a alteração para **Lia Delivery**; a Meta aceitou a solicitação e o status
atual é **In Review**. Até a aprovação, o nome antigo continua visível. Isso é
configuração do display name na Meta: não altera código, número, WABA, webhook, Pix
nem cartão.

## Atualização 01/09/2026 (2ª) — quatro pedidos do dono após a 1ª bolha real

O dono viu a bolha real no ar (pedido #GAS8P9, R$51,77) e pediu quatro mudanças, todas
implementadas no mesmo dia:

1. **Botão "Ver total" → "Pagar"** (follow-up pós-escolha). O rótulo tinha virado
   "Ver total" na rodada 1 porque "Pagar" prometia cobrança imediata; com a bolha
   nativa o caminho até o pagamento ficou curto e o dono mandou voltar. Decisão do
   dono, 01/09 — não re-renomear sem ele.
2. **Pix v2 — "veio os dois":** a bolha nativa agora vai PRIMEIRO e, quando a Graph
   aceita, o texto `pixInstructions` NÃO sai — só o copia-e-cola solitário depois dela
   (fallback universal: WhatsApp Web/cliente antigo não renderiza `order_details`, e o
   código precisa ser mensagem sozinha pra colar no banco). Bolha recusada/flag off/
   mock → as duas mensagens de sempre. `maybeSendNativePixBubble` devolve boolean.
3. **"Ver detalhes" no card, para TODAS as lojas** (reviews/fotos/specs a um toque):
   cada card com `productUrl` ganha o botão `optinfo:<sku>` (último card fica com 3
   botões — teto Meta). O toque responde com a PÁGINA REAL do anúncio em texto puro
   (link clicável), sem mexer na escolha. Digitado também: "detalhes", "detalhes 2",
   "ver anúncio" (intent `product_details`; "link" seco fica de fora — colide com
   link de pagamento; "detalhes do pedido" continua status). Cobertura: os wrappers
   de vitrine já propagam `productUrl` do catálogo (Boticário, Cobasi, Divvino…); os
   catálogos SEM url por item (Carrefour, Petz) usam fallback de link de BUSCA da
   loja (`STORE_SEARCH_URL` no cérebro — `mercado.carrefour.com.br/s?q=` e
   `petz.com.br/busca?q=`, ambos validados ao vivo em 01/09). Item sem nada →
   resposta honesta.
4. **A pergunta "Quantas unidades?" morreu — e ajustar virou botão**: escolher sem
   dizer quantidade assume **1 un** e segue, com dica na confirmação
   (`choiceConfirmedAssumedOne`). Nesse caso o follow-up troca "Cancelar" por
   **"Mudar quantidade"** (teto de 3 botões; "cancelar" digitado segue valendo):
   o toque (`qtd_alterar`) reabre os botões 1/2/Outra da pergunta clássica para o
   último item, e `qty:1`/`qty:2`/`qty:other` fora do estado legado ajustam o último
   item da cesta em vez de fechar escolha. Ajuste por texto continua ("bota 3",
   número seco pós-item). `choosing_quantity` + `finishQuantityChoice` ficam vivos SÓ
   para conversas em voo no deploy — `beginQuantityChoice` foi removida; não
   reintroduzir a pergunta sem o dono.

## Atualização 01/09/2026 — bolha nativa de Pix ATIVADA em produção (sonda provou: sem habilitação)

A hipótese de 31/08 se confirmou ao vivo: a Graph **aceita `pix_dynamic_code` no nosso
número sem a habilitação** que barrou o One-Click de cartão. Sequência do teste real:
1ª sonda voltou 200 mas não chegou (erro Meta **131047** — janela de atendimento de 24h
fechada; a sonda livre depende dela, a cobrança real não, porque o cliente acabou de
escrever); dono mandou "oi" pra Lia, repetiu a sonda, 200 de novo e **a bolha chegou**.

Ativação feita pelo dono na Vercel (Production + Preview): `LIA_NATIVE_PIX=1`,
`LIA_PIX_MERCHANT_NAME=Lia Delivery`, `LIA_PIX_KEY=<chave CNPJ, Sensitive>`,
`LIA_PIX_KEY_TYPE=CNPJ`; redeploy `dpl_FNqQtvJzTPHmYCDgFcDBRFNsG7ym` (READY,
alias liadelivery.com.br). **Estado vigente: toda cobrança Pix real envia o fluxo
textual/copia-e-cola de sempre e, em seguida, a bolha nativa "Lia Delivery".** Mock
nunca envia bolha.

Decisões registradas nessa ativação:
- **Identidade do recebedor:** a bolha mostra "Lia Delivery", mas o app do banco é
  obrigado a mostrar o recebedor oficial do Pix — e o CNPJ é MEI, cujo nome
  empresarial contém o nome civil do dono. Limitação **aceita pelo dono**; não é bug.
- **OPS_TOKEN foi trocada** (a antiga era Sensitive e irrecuperável na Vercel). O
  valor NUNCA vai em doc/commit/log. `/ops?key=<token>` troca a chave por cookie
  httpOnly de 90 dias.
- Falta provar no primeiro **pedido real** com Pix: bolha com código MP de verdade
  abrindo o banco (a sonda usou EMV não-pagável). Olhar `[whatsapp:native-pix]` e
  `[whatsapp:meta:status-failed]` no primeiro pedido. V2 na fila: enxugar textos
  redundantes e `order_status` "pago ✅" quando o webhook MP confirmar.

## Atualização 31/08/2026 — bolha nativa de Pix (order_details) atrás de flag

O dono viu um bot concorrente cobrando com a bolha nativa de pagamento do WhatsApp
(total + "Pagar com Pix" + "Copy Pix code" dentro do chat) e pediu o mesmo. Descoberta:
a doc pública da Meta (payments-br, atualizada 05/2026) **não lista allowlist para
`pix_dynamic_code`** — diferente do One-Click de cartão (`offsite_card_pay`), que exigia
habilitação e a Meta negou em 08/2026. Implementado como experimento:

- `buildPixOrderDetailsPayload` + `whatsappAdapter.sendPixOrderDetails` (mesmo
  `order_details`/`review_and_pay` do One-Click, com `payment_settings: pix_dynamic_code`
  = código copia-e-cola do Mercado Pago + chave/nome do recebedor). Item de linha único
  = total (frete/taxa já embutidos; a bolha é apresentação, a cobrança é o código).
- `maybeSendNativePixBubble` no cérebro, chamada nos 3 pontos de emissão de Pix
  (cobrança nova, cotação manual aprovada, troca cartão→pix). **ADITIVA**: sai DEPOIS
  dos textos de sempre — se a Graph rejeitar (ou aceitar e descartar assíncrono, lição
  dos cards Meta) o cliente já tem o copia-e-cola. Falha nunca bloqueia a cobrança;
  `reference_id` = `pix-<pixId MP>` (único por cobrança, não por pedido).
- **Envs (todas necessárias, senão a bolha é pulada com warn):** `LIA_NATIVE_PIX=1`,
  `LIA_PIX_MERCHANT_NAME` (nome do recebedor como aparece no banco),
  `LIA_PIX_KEY` + `LIA_PIX_KEY_TYPE` (CPF|CNPJ|EMAIL|PHONE — a chave da conta Mercado
  Pago que recebe). Mock nunca envia bolha.
- Copies novas: `nativePixBody` / `nativePixItemName`. Teste: payload em unidade
  (whatsapp-pay.test.ts). O que SÓ o teste real prova: se a Graph aceita
  `pix_dynamic_code` no nosso número sem habilitação — ligar a flag, mandar um pedido
  de teste e olhar o log `[whatsapp:native-pix]` + `[whatsapp:meta:status-failed]`.

## Atualização 30/08/2026 (3ª) — auditoria pós-rodadas 1–5: 479/479 e sete lacunas fechadas

Pente-fino independente depois dos dois ciclos estruturais. A suíte COMPLETA rodou
contra o banco (sem skips): **479/479**, além de `tsc`, lint e build de produção. Sete
lacunas encontradas e corrigidas: `quero sim` volta a ser confirmação comum; o teto de
preço sobrevive tanto ao descarte local→resgate ML quanto ao refino por marca
(`fone até 150`→`Philco`); suporte classificado pela IA durante escolha agora recebe
`userId`, grava flag e alerta o operador; o filtro da IA também barra confirmação falsa
de Pix/cartão/pagamento; o compositor calcula frete grátis pelo subtotal real da loja
(não pelo preço com margem), nunca aumenta o número de entregas e usa copy própria
quando apenas redistribui itens entre as mesmas lojas. Regressões novas cobrem todos os
casos, inclusive ML via cache real no banco. Relatório:
[docs/auditoria-pos-rodadas-1-a-5-2026-08-30.md](docs/auditoria-pos-rodadas-1-a-5-2026-08-30.md).

## Atualização 30/08/2026 (2ª) — os dois ciclos estruturais: roteador LLM + cesta-como-conjunto

Decisão do dono ("então faz tudo isso"): sair do loop de conserto-por-regex e atacar
as duas causas estruturais da média estagnada.

**1. Roteador LLM de fallback** (`interpretCustomerMessage` em src/lib/adapters/ai.ts
+ `tryLlmInterpret` em delivery-service):
- Entra SÓ nos becos onde a Lia responderia mal: busca que não achou nada, mensagem
  sem produto/intent, e o "não peguei qual você quer" final da escolha. Uma tentativa
  por turno (flag no `turnMeta`); OpenAI off/timeout/`LIA_LLM_ROUTER=false` → o
  comportamento determinístico de sempre (todos os testes existentes valem intactos).
- Ações: `product_request` reescreve a busca ("uma 51" → "cachaça 51", "negocio de
  passar roupa" → "ferro de passar roupa" — provado ao vivo); `basket_edit` normaliza
  pra comando canônico ("tira aquele negocio de lavar louça" → "tira o detergente") e
  despacha pelos handlers de sempre; `question/support/smalltalk/manipulation`
  respondem na voz da Lia — support também flag no pedido + alerta ao operador.
- **A IA nunca decide dinheiro**: prompt proíbe desconto/gratuidade/confirmação de
  pagamento/promessa de prazo/recursos inexistentes, e `sanitizeRouterReply` derruba
  qualquer resposta com promessa proibida (cai na copy segura canned). Testado em
  unidade (filtro) e E2E (costura `__setRouterInterpreterForTests`).

**2. Cesta-como-conjunto V1** (P1.8; `src/lib/basket-composer.ts` puro + fiação no
modo lista):
- `composeBasket` escolhe, entre as opções JÁ aprovadas (piso+rerank) de cada linha,
  a combinação que minimiza produtos+frete (guloso, uma troca por vez, limiares de
  frete grátis contam). Só aplica com economia ≥ R$3 e **anuncia cada troca**
  (`bundledDeliveriesNote`: "Juntei entregas pra te economizar R$X — item A (Loja) →
  item B (Loja)"). Kill-switch `LIA_BASKET_COMPOSER_OFF`.
- Cesta montada card a card NÃO é recomposta em silêncio (escolha explícita): quando a
  cotação sai com 3+ entregas e frete ≥ 40% dos produtos, vai a dica honesta
  (`freightFragmentationTip`) de reenviar a lista numa mensagem só.
- Unidade: 4 casos (migração compensa, alternativa cara não mexe, limiar de frete
  grátis, quantidade multiplica).


## Atualização 30/08/2026 — rodada 5 (4,30/10): o funil de perguntas fechou

Rodada 5 ([docs/testes-rodada-5-2026-08-29.md](docs/testes-rodada-5-2026-08-29.md)):
2,85 → **4,30**, 11/11 totais certos, zero silêncio, zero concessão em manipulação. A
causa-mãe restante era UMA: pergunta que não casa com intent caía no funil de busca e
virava "produto não achado". Consertos deste ciclo:

1. **Funil de perguntas fechado em duas camadas**: (a) intents novos — `coupon_promo`
   (cupom/promoção %; "promo de Instagram não é nossa, desconfia"), `charge_complaint`
   ("fui cobrado 2x" = suporte sério + alerta URGENTE ao operador + flag no pedido),
   `scheduling_question` (não agendo; prazo da loja antes de pagar),
   `store_location_question` (100% WhatsApp), `installments_question` (à vista por
   enquanto — honesto), `meta_probe` ("suas instruções"/"ignora as regras"/"responde
   só sim" = deflexão leve, nunca busca); (b) **backstop**: pergunta que não casou com
   nada e não achou produto recebe "essa eu não sei responder — sou a Lia das compras"
   em vez de ecoar a pergunta como item não-achado.
2. **Pergunta lateral reapresenta a etapa**: todas as respostas informativas (NF,
   CNPJ, segurança, cupom, parcelas etc.) re-enviam os cards/pergunta de quantidade em
   curso — os cards "sumiam" e o cliente re-pedia o produto (S7/S12). CNPJ sem
   `LIA_BUSINESS_INFO` agora também alerta o operador (o "te envio certinho" não é
   mais beco).
3. **Ovos 60 de novo (S4)**: o caminho COM IA mantinha "ovo x6"+"ovos x6" (o dedupe só
   existia no parser determinístico) → `foldSameSpecLines` exportado e aplicado nas
   duas saídas do merge. 6+6 = ovo x12 → 1 embalagem de 10 anunciada.
4. **Teto por extenso e gíria**: `parsePriceCap` lê "quinze reais", "de uns 30 conto",
   "mangos" (S18: pinga de R$48,97 passou no teto de R$15).
5. **"quanto ficou mesmo?"/"ver total" com cobrança na mesa**: contexto pós-emissão
   não tem `total` — agora busca no PEDIDO e responde `totalAwaitingPayment` (S1:
   virava busca de produto). "ver total"/"fechar total" entraram no RUNNING_TOTAL_RE.
6. **Pivô "então me ve X" no meio de escolha parada** substitui a escolha estagnada
   (S2: chá+gatorade ficavam "anotados" atrás da touca térmica pra sempre).
7. **Comparação de opções** (S17): "qual a diferença entre o 1 e o 2?" → compara
   nome/preço/loja com honestidade sobre specs, e re-envia os cards.
8. **Marca-como-genérico** (S11): `BRAND_GENERIC` reescreve linha de 1 token — gilete→
   aparelho de barbear, bombril→palha de aço, maisena→maizena amido de milho,
   danone→iogurte. Header duplicado "coca cola coca cola" colapsado (S15).

## Atualização 28/08/2026 — rodada 4 (cliente difícil, 2,85/10): ciclo de conserto

A rodada 4 (protocolo v4, propositalmente hostil: comandos compostos, interrupções,
emoji, perguntas de confiança) derrubou a média de 6,80 pra **2,85** — mas os totais
seguiram 12/12 certos e zero cobrança indevida. Relatório:
[docs/testes-rodada-4-2026-08-28.md](docs/testes-rodada-4-2026-08-28.md). Consertos:

1. **Rede anti-silêncio estrutural**: turno que termina com ZERO respostas manda
   fallback ("Me perdi aqui 😅") — `reply()` e todos os envios interativos contam num
   `AsyncLocalStorage` por turno; mensagem SEM texto (áudio/figurinha/imagem) responde
   "só leio texto" (antes era um **400 mudo no webhook**); reação de emoji é ACK sem
   resposta (spam se respondesse). 4 sessões tiveram silêncio absoluto na rodada.
2. **Perguntas de confiança viraram intents com resposta própria** (respondem em
   QUALQUER estado): segurança/golpe (`trust_question`), nota fiscal e CNPJ
   (`fiscal_question`, dados via env `LIA_BUSINESS_INFO`), quem entrega, "no site tá
   mais barato" (`price_dispute` — explica o serviço com honestidade), "meu filho que
   paga" (`third_party_pay` — Pix copia-e-cola pode ser encaminhado), xingamento leve
   (`insult` — resposta digna + oferta de atendente).
3. **Pausa e retomada**: "pera/espera/já volto" = `hold` (nada de busca — "nao pera"
   virava busca de PERA fruta); "voltei, onde a gente tava?" = `resume_where` (resume o
   estado e reapresenta a etapa); "na vdd quero sim, ainda dá?" = `resume_canceled`
   (recupera a compra recém-cancelada pelo `lastCanceledOrderId`).
4. **Comando composto**: "troca o arroz por integral, tira o café e bota 2 leites"
   divide em cláusulas (`splitCommandClauses`) e executa em sequência; lado de troca
   com 1 token compõe com o item ("arroz integral").
5. **Editar DEPOIS do total reabre o pedido** (`reopenOrderForEdit`): add/troca/tira em
   `awaiting_quote_confirmation`/`awaiting_payment`/`choosing_freight` cancela a
   cotação/cobrança não paga, restaura a cesta e aplica a edição — o catch-all do menu
   de pagamento só responde a quem não pediu mudança.
6. **Semântica de cesta**: "1 arroz" depois de "2kg de arroz" é linha própria (dobra na
   anterior só com "mais/outro" — flag `additive`); linhas repetidas do mesmo produto
   somam ("meia dúzia de ovo" + "6 ovos" = 12); **conversão de embalagem** anunciada
   (12 ovos ÷ caixa de 10 = 1 caixa — antes: 12 caixas, R$118); teto GLOBAL "nada acima
   de 20 reais cada" vale pra lista inteira; correção embutida ("aliás esquece o café",
   "deixa só chá") remove/deduplica; "óleo" com 2+ itens de despensa vira "óleo de
   soja"; urgência sai da frase de busca + resposta honesta de prazo; "tira tudo que
   for de limpeza" remove SÓ a categoria (mapa `CATEGORY_KEYWORDS`; desconhecida =
   resposta honesta sem apagar nada).
7. **Escolha**: "👍" com cards na mesa re-pergunta (não "de nada"); "1️⃣ mano" escolhe
   (keycap normalizado + gíria de preenchimento removida); "o de melhor custo
   benefício" pega a mais barata; "um shampoo qualquer, escolhe vc" auto-escolhe o topo
   (flag `autoPick`); monossílabos na quantidade ("ta"→1; "n"→1 + dica de tirar).
8. **Miudezas de honestidade**: sintoma sem remédio ("algo pra dor de cabeça") explica
   o limite ANTES das opções de conforto; cigarro/tabaco recusado com explicação
   (`looksLikeTobacco` — nunca sumir em silêncio); troca pix↔cartão avisa que o código
   anterior não vale; "quando chega o DE HOJE?" sem pedido de hoje diz isso antes de
   citar o antigo; esperando CEP, referência vaga re-pede o CEP (nunca busca).

## Atualização 27/08/2026 (2ª) — rodada 3 (média 6,80): dinheiro fechou 12/12, ciclo de conserto do mesmo dia

Rodada 3 do protocolo (v3, [docs/protocolo-teste-persona-v3.md](docs/protocolo-teste-persona-v3.md))
validou os consertos da rodada 2: **média 4,15 → 6,80**, cesta contaminada 0/20,
**12/12 totais batendo linha a linha**, minswap anunciado, botão velho nomeado,
furadeira segurada, "de sempre" com conferência, S3 narrativa longa = 9/10. Relatório:
[docs/testes-rodada-3-2026-08-27.md](docs/testes-rodada-3-2026-08-27.md).

Achados novos, TODOS consertados no mesmo dia (com teste):

1. **Auto-apresentação virava produto** ("seu Jorge aqui" → imagem de São Jorge, 3
   sessões): padrões de auto-apresentação no `NARRATIVE_SEGMENT_RE` (honorífico+nome+
   "aqui", "aqui é a X", "sou o X", "me chamo X").
2. **Sujeito-parente engolia a query** ("meu neto quer um violão" era a busca inteira):
   strip do sujeito ANTES do vocativo — o parente sai, o produto fica ("violão").
3. **Narrativa na escolha ESCOLHIA produto** (S15: "meu neto que pediu isso ai" casou
   "Meu Primeiro Violão" e foi pra quantidade): a guarda de narrativa subiu pra ANTES
   de qualquer parser de escolha.
4. **Cotação vencida engolia a mensagem** (S18: o CEP de Campinas morreu atrás de
   "Esse preço venceu"): o ramo de expiração agora restaura a cesta e deixa a mensagem
   seguir o roteamento normal (else-if — não cai mais no menu de pagamento).
5. **"aa esquece o carregador" virava "pula" do item errado** (S14): "esquece" entrou
   no REMOVE_START_RE com tolerância a interjeição; e remoção na pergunta de
   quantidade cancela o próprio item ("só a pilha, sem carregador" idem).
6. **"não gostei" seco descartava o item** (S17): agora pagina outras opções;
   "outra opção" no singular também.
7. **"Philco" (marca sem match local)**: a re-busca combinada agora FORÇA a cauda
   longa (ML); se ainda falhar e o token for só-marca (campo brand), responde "não
   achei fone bluetooth philco" e re-mostra — nunca mais enfileira a marca seca (que
   virava air fryer).
8. Copy: recusa de item vira "eu não achei em nenhuma loja agora" (era "não consigo
   trazer hoje", que soava como recusa de serviço).

Pendências que a rodada 3 reforçou (ver PENDENCIAS): frete fragmentado é o problema
nº 2 por frequência (6/20) — P1.8 cesta-como-conjunto é o próximo ciclo grande;
"óleo" sozinho não achou nada (golden registrado); resíduo #YAQHF8 apareceu nos 20
encerramentos (rotulado certo, mas o dono precisa resolver o pedido); S10 repete a
mesma copy de esgotamento na 3ª tentativa; forense pendente do "e arroz" da S18
(cotação na mesa + item novo → troca disparou sem adicionar o arroz).

## Atualização 27/08/2026 — rodada 2 (20 sessões): forense + conserto dos achados

Rodada 2 do protocolo v2 deu **4,15/10** (relatório em
[docs/testes-rodada-2-2026-08-27.md](docs/testes-rodada-2-2026-08-27.md)): perda de
estado caiu de 12/20 pra 3/20, mas surgiram "P0s" novos. A forense no banco mudou o
diagnóstico dos dois piores:

- **#YAQHF8 "cancelado que virou pago" NÃO é corrupção**: é um pedido REAL pago no
  cartão em 25/08 (Pagar.me charge `ch_VAolM1vcKiwjnK8m`, R$20,62, escova de dente),
  parado em `paid` desde então — nunca comprado nem estornado. Idem **#QTNL2T** (mochila
  R$80,93, pago 23/08, `retailer_preparing`). O telefone de teste acumula pedidos vivos
  e as 20 sessões compartilham a MESMA conversa — "cadê meu pedido?" achava esses
  legitimamente. **Decisão pendente do dono: comprar/entregar ou estornar os dois.**
- **A cesta "PlayStation fantasma" (S19)** foi pedida pelo próprio telefone às 9h38 e
  largada em `awaiting_payment`; a retomada mostrou o pedido pendente correto. Sem
  fronteira de sessão, persona nova herda pedido da anterior — artefato de teste, mas a
  APRESENTAÇÃO era o bug real.

Consertos implementados (todos com teste):

1. **Status/cancelamento ancorados**: `orderStatusLine` agora imprime data ("de ontem",
   "de sábado", "de 23/08") + prévia de itens em todo pedido citado; `handleCancel` grava
   `lastCanceledOrderId` e "cadê meu pedido?" pós-cancelamento fala PRIMEIRO do
   cancelado (pago antigo vira segunda linha rotulada); "pedido de ONTEM/anterior" pula a
   cesta e busca o passado; `nothingToCancel` nomeia o pago com data+itens.
2. **Anti-turno-velho**: `rememberCtxSnapshot` após a releitura pós-lock (mensagem que
   esperava o lock morria em falso conflito de CAS, sem resposta NENHUMA);
   `TurnSupersededError` propaga em `tryPublishInstantQuote` (turno superado não cai
   mais no caminho manual falando); `opsPublishManualQuote` checa `movedOn` antes de
   sobrescrever o contexto e rotula a cotação com `#pedido (data)` quando a conversa já
   está em outro assunto.
3. **Troca de loja NUNCA silenciosa**: oferta e aceite do minswap listam
   "antigo (R$a) → novo (R$b)" item a item; resumo pagável (`manualQuoteSummary`) imprime
   preço por linha quando a margem exata existe — soma das linhas = "Produtos" sempre.
4. **Pós-total com controle**: em `awaiting_quote_confirmation`, "entrega mais rápida"
   republica com a opção rápida guardada (`freightChoice` agora sobrevive à publicação)
   ou responde honesto ("só tem uma modalidade"); "mais barato" cancela a cotação e
   reabre a última escolha ordenada por preço (`lastChoice` também sobrevive) — cumprindo
   a promessa do haggle; nada disso cai mais no menu "Como prefere pagar?".
5. **Narrativa não vira produto**: `NARRATIVE_SEGMENT_RE` filtra orações de contexto
   ("meu neto vem sábado", "que não seja muito caro") no parser E no resgate do merge
   (que re-promovia o que a IA descartara); "coisa simples de farmácia"/"compra da
   semana" viraram modificadores; prompt da IA ganhou a regra 7a (não inferir produto de
   desejo narrativo); eco de não-achados trunca frase longa (~6 palavras).
6. **Escolha destravada**: resposta curta de 1 token ("Philco") tenta a busca COMBINADA
   ("fone bluetooth philco") antes de virar item novo — refina se cobrir a query E o
   token; narrativa no meio da escolha re-pergunta em vez de "anotar"; botão de conversa
   antiga tem intent (`stale_option_tap`) e copy próprios; "outras" esgotado faz UMA
   re-busca relaxada (forceLongTail) e depois pede reformulação em vez de repetir;
   "tira X, quero Y" com vírgula agora separa remove+busca.
7. **"O de sempre" confere antes de fechar** (resumo + "É isso? responde *sim*");
   `LIA_BULK_AUTOPICK_MAX` caiu de 300 pra **100** (furadeira de R$142 entrou sozinha);
   copy do caminho manual ficou honesta ("assim que conferir", não "em instantes") e
   nomeia QUAL item travou a cotação (nota do /ops inclui os itens da loja abortada).

Adiados com registro (PENDENCIAS): SLA/watchdog para `awaiting_operator_quote`, opção
rápida para anúncios ML com frete grátis, item indisponível numa loja abortar SÓ a loja,
name≠productUrl no sku dsp-548880 + mídia 500 (Meta 131053) na S20.

## Validação ao vivo — 20 clientes simulados (2026-08-26)

Foram executadas 20 sessões sequenciais no WhatsApp, sem pagamento e sem confirmar Pix
ou cartão. A média atribuída durante a rodada foi **4,55/10**; a auditoria posterior
reclassificou a sessão 19 de 7 para 2 porque ela chegou ao Pix com seis itens da sessão
18 já cancelada, levando a média auditada a **4,30/10**. A lista direta e a
troca de loja funcionaram em vários casos, e a guarda de dipirona funcionou quando a
mensagem chegou em uma etapa estável. Permanecem graves a perda de estado com mensagens
rápidas, perguntas de entrega sem resposta, códigos de cancelamento/estorno para pedidos
que o cliente não reconhece, limites de preço ignorados e promessas de prazo nos cards.
O diagnóstico completo está em
[docs/relatorio-completo-problemas-lia-2026-08-26.md](docs/relatorio-completo-problemas-lia-2026-08-26.md);
scorecards e transcrições em
[docs/testes-20-clientes-2026-08-26.md](docs/testes-20-clientes-2026-08-26.md).

_Última atualização: 2026-08-26._

## Atualização 26/08/2026 (2ª) — página /cartao com o branding + seleção de múltiplos cartões

Dois pedidos do dono no mesmo dia, com o Pagar.me em ativação:

1. **/cartao rebrandeada** (Berinjela & lima): fundo papel, cartão branco, logo LiaBrand
   + selo "🔒 pagamento seguro" em roxo, total em faixa roxa com valor em lima, campos
   com foco lima e CTA "Salvar e pagar R$X" em lima/roxo; rodapé "os dados vão direto
   pro Pagar.me — a Lia não vê o número". Só classes/copy — NENHUM atributo
   `data-pagarmecheckout-*` foi tocado (contrato do tokenizecard.js). Verificada ao
   vivo em dev com sessão real de cadastro.
2. **Vários cartões salvos**: `listOneClickCredentials` (até 5, ativos, desc); a oferta
   de cobrança lista os demais numerados ("Também tenho salvo: 2) Visa •••• 5678") e
   responder o número expira a tentativa pendente e cria outra no cartão escolhido
   (idempotência preservada). "Usar outro cartão" segue cadastrando mais um — o enroll
   acumula credenciais (dedupe só do MESMO cartão físico). Teste novo: 2 cartões →
   listagem → "2" → tentativa antiga `expired`, nova `pending` no cartão certo
   (saved-card 7/7).

Colaterais: `.env.local` do `vercel env pull` (todos os valores VAZIOS — Sensitive não
baixa) sobrescrevia o `.env` e quebrava QUALQUER dev local com banco; movido para
`.env.local.bak` — não regenerar sem saber disso. `.claude/launch.json` criado
(lia-dev, PAGARME_MOCK=true) pro preview.

## Atualização 26/08/2026 — teste em massa (20 personas): Blocos 1-3 do relatório implementados

O protocolo de persona rodou 20 sessões reais e o relatório
([docs/relatorio-completo-problemas-lia-2026-08-26.md](docs/relatorio-completo-problemas-lia-2026-08-26.md))
derrubou a média pra 4,30/10 com 2 P0 de estado. Implementado no mesmo dia, na ordem que
o próprio relatório recomendou:

**Bloco 1 — segurança de estado (P0.1/P0.2, a raiz de tudo):**
- **Escrita CONDICIONAL de contexto (CAS)**: cada turno guarda o snapshot do contexto
  que leu (AsyncLocalStorage — `runTurnScoped` no webhook, zero mudança nos 88 call
  sites) e toda `writeCtx` vira compare-and-swap contra ele. Outra escrita no meio
  (cancelar, turno mais novo) → `TurnSupersededError` → o turno velho PARA sem gravar e
  sem responder (o webhook o engole com log `[turn-superseded]`). É a cura estrutural da
  cesta da sessão 18 ressuscitando no Pix da 19.
- **Barge vira último recurso**: `TURN_LOCK_MAX_WAIT_MS` 15s → 120s (env). Quem fura
  depois disso é inofensivo — o CAS mata a escrita perdedora.
- **Status mira a compra ATUAL**: cesta/escolha na mesa → responde o total parcial;
  senão pedido da conversa → ativo mais novo → só então o último de qualquer estado.
  Cancelado sem pagamento agora diz "*nada foi cobrado*"; "estorno" só com `paidAt`.
- **Cancelar por fallback nunca mira pedido com dinheiro** (`CANCELABLE_FALLBACK_
  STATUSES`); havendo pago ativo, a recusa o NOMEIA (`nothingToCancel(shortId)`).

**Bloco 2 — integridade da compra (P0.3/P1.3/P1.4):**
- **Teto de preço viaja** (`ParsedLine.cap` → `PendingChoice.cap`): paginação, refino,
  mais-baratas e o RESGATE do ML (que reconstrói a frase com "até R$X") re-filtram.
- **Lista direta não auto-escolhe item caro**: acima de `LIA_BULK_AUTOPICK_MAX` (300),
  a linha vira cards (a peça de trator de R$2.556 nunca mais entra sozinha).
- **Prazo NUNCA em card de busca**: o slot de entrega do card do ML foi removido de vez
  (regra dura de 17/08; o prazo aparece no resumo, com o dado da consulta de frete).

**Bloco 3 — conversa e operação (P1.2/P1.5/P1.6/P1.7/P1.9/P2.3/P2.4):**
- "quanto custa a entrega?" → tópico `fee` (era "área"); identidade/golpe em frase
  composta ("oi... quem é vc? isso é golpe?") → apresentação; "pensando bem melhor não"
  → reject; "kkkk beleza" → obrigado; regateio ("faz por 10?") → intent `haggle` com
  resposta própria (+ "mais barato" como saída).
- **Remédio é guarda GLOBAL** (antes de qualquer etapa — na pergunta de quantidade a
  dipirona virava "responde o número"); a etapa em curso é reapresentada após a recusa.
- **A pergunta de quantidade deixou de ser prisão**: 2ª resposta sem número fecha 1
  unidade e roteia a mensagem como pedido normal (`quantityChoice.misses`).
- **Troca é atômica**: sem substituto forte, o item original FICA na cesta
  (`swapKeptOriginal`) — "tira o frango, quero peixe" não mutila mais a lista.
- **Alerta de operador nunca vai pro chat do próprio cliente**
  (`[operator-alert:suppressed-self]` quando `LIA_OPERATOR_PHONE` == cliente).

**Adiado com registro (produto, não bug):** otimização da cesta como conjunto (P1.8 —
menos entregas/frete), expectativa do fallback manual pós-preço (P1.10), latência da
busca fria (P2.1 — teto é o actor; API oficial segue bloqueada), pergunta de
esclarecimento pra item vago/caro (P2.5) e golden cases de semântica (toalha≠lenço,
frutas≠congelada) — próximos ciclos em PENDENCIAS.

Gate: tsc; intents 47/47; copy 12/12; bateria nova 26/08 6/6 (CAS, status×2, dipirona
na quantidade, fuga da quantidade, teto na paginação); regressão completa das 3 suítes
E2E rodada antes do deploy.

## Atualização 23/08/2026 — piloto do operador automático local

Por decisão do dono, a automação de compra volta como piloto local e gradual. Isso não
reativa o Browserbase legado nem muda o concierge manual como caminho geral. A primeira
fila aceita somente pedidos pagos do Mercado Livre com URL exata para todos os itens;
linhas livres, cestas mistas e divergências continuam no `/ops`. A fila tem claim com
lease, retry, auditoria e reconciliação com `opsMarkBought`. O modo inicial obrigatório é
`PURCHASE_AUTOMATION_MODE=cart_only`: o Luna consulta a fila a cada hora, prepara e
confere o carrinho, mas a confirmação financeira final continua humana. Ativar `purchase`
exige antes aprovação expirada por tempo, hash imutável do carrinho, teto de valor e teste
real de não duplicação. Manual: `docs/operador-automatico-local.md`.

Leia este arquivo antes de planejar, responder sobre o estado do produto ou alterar o
projeto. Ele é a memória canônica curta da Lia. Para detalhes, leia também:

1. [STATUS.md](STATUS.md) — estado técnico e operacional;
2. [PENDENCIAS.md](PENDENCIAS.md) — checklist canônico de progresso e lançamento;
3. [docs/decisoes-operacionais-2026-07-14.md](docs/decisoes-operacionais-2026-07-14.md) —
   evidências e decisão operacional vigente;
4. [docs/operacao-canais-2026-07.md](docs/operacao-canais-2026-07.md) — canais e operação;
5. [docs/automacao-compra-varejistas.md](docs/automacao-compra-varejistas.md) — automação
   segura de cotação e compra por varejista;
6. [CLAUDE.md](CLAUDE.md) — histórico de arquitetura e decisões.

Em caso de conflito, prevalece a decisão mais recente documentada neste arquivo e no
registro de 14/07/2026. Não ressuscite uma premissa histórica sem nova evidência.

## Régua de copy vigente (2026-08-17) — leia antes de escrever qualquer mensagem

Revisão do dono sobre as ~110 mensagens automáticas. O levantamento com antes/depois de
cada uma está em [docs/todas-as-mensagens-da-lia.md](docs/todas-as-mensagens-da-lia.md);
o texto vive em `src/lib/lia-copy.ts` (cabeçalho do arquivo repete estas regras).

1. Verbo na frente, resultado primeiro.
2. Sem preâmbulo de simpatia: "Prontinho", "Opa", "Deixa comigo", "Poxa", "Claro!",
   "Fechado!", "Sem problema" — todos fora.
3. Sem explicar a mecânica interna (quantas lojas parceiras, como o frete é calculado,
   que a Pagar.me tokeniza o cartão, por que a cotação venceu).
4. No máximo 1 emoji, e só onde carrega informação (📍 endereço, 🛵 entrega, ✅ ok). O 💚
   está limitado a 2 mensagens no produto inteiro (`greeting` e `thanks`) — não somar mais.
5. Uma saída por mensagem: nunca oferecer 3 caminhos quando 1 resolve.
6. Sem lista de exemplos de produto. A constante `EXAMPLES` foi removida; não recriar.
7. Sem endereço ou CEP fictício de exemplo — descrever os campos ("rua, número,
   complemento, bairro, cidade e CEP"), nunca inventar um endereço.

**Prazo — regra dura, não é questão de tom.** Quem manda no prazo é o checkout da loja e
ele varia: às vezes é no mesmo dia, às vezes leva dias. Nenhuma mensagem genérica pode
dizer "chega hoje", "no mesmo dia", "em ~1h" ou "1 a 2 horas". O prazo aparece **uma vez
só**, na linha de entrega do resumo (`deliveryLine`), e **somente com dado real da loja** —
os fallbacks `etaMinutes ?? 40` e `?? 90` foram removidos de propósito; sem prazo, a linha
sai só com o valor. Antes de cotar, a Lia diz que *mostra* o prazo, nunca qual é.
Ao somar mensagem nova, não reintroduza promessa de same-day em lugar nenhum.

✅ A landing (`src/app/page.tsx`, `layout.tsx`, `opengraph-image.tsx`, mock do celular)
passou pela mesma revisão em 2026-08-18: sem promessa de prazo, "Pix ou cartão" em vez de
"paga no Pix", letreiro sem preço inventado, sem "sem taxa escondida" (dono vetou) e mock
com as mensagens reais de `lia-copy.ts`. Paleta escolhida pelo dono no seletor ao vivo
(seletor temporário, removido após a escolha): **Berinjela & lima** — roxo `#3A225E` + papel lilás
`#F7F4FB` + lima `#D9FF5B`, CTAs em lima. O logo/avatar/favicon e a arte da foto de perfil do
WhatsApp foram refeitos na mesma paleta (lima `#D9FF5B` + roxo `#3A225E`).

## Atualização 25/08/2026 — troca de mínimo agora cai no Mercado Livre quando a vitrine local não cobre

Pergunta do dono ("se o item de R$15 tá preso no mínimo de R$30 do Carrefour, ele pode ir
pro Meli comprar direto, não?") — sim, e agora o fluxo faz: `offerMinimumSwap` ganhou o
FALLBACK do ML. Ordem da busca por substituto, por item preso: (1) vitrine local sem
mínimo com frete CONHECIDO (fecha rápido, frete barato); (2) vitrine local sem mínimo em
tarifa padrão; (3) **Mercado Livre** — sem mínimo por definição (cada anúncio é um
checkout próprio). Só entra anúncio que fecha sozinho: com id de anúncio (frete ao vivo)
ou frete grátis declarado — senão a troca viraria espera de operador. Piso de match e
guarda ANVISA valem igual (searchMercadoLivre já filtra). Busca fria do ML pode atrasar a
OFERTA em ~20-40s (a mensagem do mínimo já saiu; cache de 6h torna a segunda instantânea).

Teste novo `tests/minimum-swap-ml.test.ts` (farmácias OFF pra forçar o fallback; ML
responde do CACHE semeado no banco — zero rede; anúncio de frete grátis fecha com fee 0).
Detalhe de harness: `mercadoLivreEnabled()` exige `APIFY_API_TOKEN` mesmo com cache — o
teste seta um token fake que nunca é usado. Gate: swap local 2/2 + ML store 13/13 verdes.

## Atualização 24/08/2026 (2ª) — 2º testador: pedido mínimo ganhou saída (troca de loja) + reversão de árvore reparada

Segundo teste externo (+5511973741800): a pasta Colgate de R$6 ficou presa no pedido
mínimo de R$30 do Carrefour a sessão INTEIRA — dois "pagar" bateram na parede, "quanto
falta?" e "o que posso pedir pra completar o valor" viraram busca/beco, "outro"
(singular) não paginava, e os desodorantes que ele somou eram de OUTRA loja (nunca
ajudaram no mínimo). Nenhum pedido saiu. Consertos:

1. **Oferta de troca de loja** (`offerMinimumSwap`): quando só o mínimo de uma loja
   trava o fechamento e TODOS os itens dela têm equivalente forte em loja sem mínimo,
   a Lia oferece com botões — *Trocar de loja* / *Deixar como está* (`minswap:yes/no`;
   "trocar de loja" por texto vale). Aceite substitui os itens e fecha com total NA
   HORA; recusa mantém a cesta. Entre as lojas candidatas, frete CONHECIDO ganha de
   tarifa padrão e o fee menor desempata (senão a pasta de R$6 fechava com R$18 de
   frete da Droga Raia em vez de R$4,90 da Pague Menos). A oferta sai nos dois pontos
   que reclamam do mínimo (fechamento e "pagar") e no "quanto falta?".
2. **Intent `missing_question`**: "quanto falta?", "o que posso pedir pra completar o
   valor/pedido/mínimo" respondem o que falta (ou o total parcial) — nunca viram busca.
3. **"outro"/"outra" no singular** paginam igual a "outras" (`wantsMoreOptions`).
4. **Reversão de árvore reparada**: uma sessão paralela reverteu `delivery-service.ts`
   pra antes do markup progressivo e o commit `a1c7f0f` selou a reversão — produção
   voltou ao flat 10% sem ninguém notar. A fiação inteira foi reaplicada (displayPrice/
   serviceFee em todos os caminhos). Regra antiga da memória confirmada: **commitar
   batch verde na hora e conferir `git status` antes de `add -A`**.

Testes: `tests/minimum-swap.test.ts` novo (2 E2E; arquivo próprio porque o roster de
teste desliga as farmácias e o registry nasce no import — bootstrap dinâmico religa a
Pague Menos antes de importar o cérebro), intents 46/46, pricing/copy/instant-quote
69/69, mínimo legado + 1º testador verdes.

## Atualização 24/08/2026 — feedback do 1º testador externo: 4 defeitos do onboarding fechados

Primeiro teste de gente de fora (conversa real no banco, +5511992475750). Relato dele:
"pede endereço sem parar", "pedi colírio e disse que não consegue hoje", "falei nada a
ver e ele achou que era produto", "perguntei quem é você e pediu endereço". Reprodução
determinística confirmou tudo e ainda achou o pior: "Quem é vc" virou pendingRequest e
depois BUSCA — casando com o blush "Quem Disse, Berenice?". Consertos:

1. **Pergunta de identidade vira apresentação** (`detectIntent`): "quem é vc/você",
   "com quem eu falo", "vc é um robô?" → `help` (a apresentação da Lia), em qualquer
   estado — nunca busca, nunca pendingRequest.
2. **Pergunta sobre o endereço responde o endereço** (intent nova `address_question`):
   "vc salvou o endereço já?", "pegou meu cep?" → confirma o endereço em arquivo (ou
   pede, se não houver). Antes virava busca e o cliente lia "*Vc salvou o endereço já*
   eu não consigo trazer hoje".
3. **Quebra do loop de endereço** (`handleDeliveryAddress`): com endereço JÁ verificado
   no contexto, o passo `need_address` órfão não retém mais ninguém — pergunta sobre
   endereço confirma; produto destrava pra coleta e busca; resto confirma e pede itens.
   E o ESTOQUE de pedido (pendingRequest) só aceita `free_text` que não é pergunta —
   "pode ser amanhã" (affirm) e afins ficam de fora. A conversa travada do testador se
   destrava sozinha na próxima mensagem dele.
4. **Colírio entrou na lista de farmácia** (`MEDICINE_WORDS`): a recusa agora explica
   ("remédio eu não posso vender — por lei, só farmácia") em vez do "não consigo trazer
   hoje" que soou como falha de estoque. Se o dono quiser liberar lubrificante ocular
   (Systane é OTC), é decisão de produto a registrar — a régua atual é conservadora.

Gate: tsc, intents 45/45, E2E novos 2/2 (fluxo completo do testador + destravamento do
step órfão) + onboarding/endereço 10/10 (1 assert atualizado pro vocabulário novo:
"Seu pedido continua valendo").

## Atualização 23/08/2026 (2ª) — markup progressivo por faixa + fim do "cotar" na fala com o cliente

Duas decisões do dono no mesmo turno:

1. **Markup progressivo** (10% flat era demais em compra cara): faixas MARGINAIS por
   preço unitário — 10% até R$200, 6% de 200–500, 4% de 500–1000, 3% acima. Marginal =
   contínuo (R$201 nunca custa menos de margem que R$199). Exemplos: item de R$80,93 →
   R$8,09 (10%); violão de R$1.389 → R$69,67 (5% efetivo). Módulo novo
   `src/lib/pricing.ts` (displayPrice/serviceFeeForItems/serviceFeeForSubtotal) é o ponto
   ÚNICO — `display()` delega, e todos os caminhos que multiplicavam `MARKUP` direto
   (linha exibida, mínimo de loja, botões de frete, publicação instantânea,
   `order_details` do One-Click, fulfillments legados) agora passam por ele. A cotação
   instantânea propaga o serviceFee EXATO por item (bate com os cards); cotação manual do
   /ops (só subtotal) aplica as faixas sobre o subtotal. Calibrável sem deploy:
   `LIA_PRICE_MARKUP` segue mandando na 1ª faixa; `LIA_MARKUP_TIERS`
   ("200:0.06,500:0.04,1000:0.03") nas de cima. A margem fina em item caro reduz o
   colchão de preço defasado — risco registrado; item caro é quase sempre ML com preço
   ao vivo na cotação.
2. **"Cotar/cotação" saiu da fala com o CLIENTE** (dono: "ele tem que comprar, não
   cotar"): "Cotação válida por X min" → "Preço garantido por X min"; "Essa cotação
   venceu" → "Esse preço venceu"; "em cotação" → "com o total sendo fechado"; "Ainda
   estou cotando" → "Fechando seu total"; "Incluí na cotação" → "Incluí no pedido";
   trocas de endereço idem. O `/ops` e os alertas de operador MANTÊM "cotação" (jargão
   interno de quem opera; nomes de status/funções idem — churn sem valor).

Gate: tsc, pricing 5/5 (novo), copy/intents/frete/pay 87 units, E2E dinheiro+lista+frete
15/15.

## Atualização 23/08/2026 — frete grátis-lento × expresso pago: a escolha não escapava mais (caso QTNL2T)

Compra real do pedido pago #QTNL2T (mochila MLB4125746307, "frete grátis"): na hora de
comprar, o operador viu grátis chegando ~1 semana × ~R$17 chegando amanhã — e o CLIENTE
nunca recebeu essa escolha. Diagnóstico com a resposta real do endpoint: a consulta
ANÔNIMA achata as datas (grátis-slow e expresso-standard "chegam" ambos 26/08), e a
regra do `fasterThan` exigia data ESTRITAMENTE anterior → sem gap, sem botões. Os
R$15,99 que apareciam eram `shipping_option_type: agency` (ponto de retirada — filtrado
certo; o expresso de ENDEREÇO é o de R$17,99, os "dezessete" do relato).

Conserto em duas camadas, sem quebrar a regra dura de prazo:
1. `fasterThan` ganhou a REGRA 2 (por classe): base grátis/lenta (`slow` ou custo 0) com
   opção de classe expressa (`standard`/`next_day`/`same_day`/`express`) mais cara e
   data NÃO-posterior vira escolha — com a data do lado rápido REMOVIDA (sem gap
   comprovado, não se promete data; botão sai "Mais rápido" e a copy "sem data
   publicada"). Expresso × expresso sem gap continua NÃO sendo escolha.
2. `mlBasketFreight` não recai mais na data do barato quando o rápido vem sem data
   (`?? outcome.isoDate` era o vazamento): qualquer item de data desconhecida deixa a
   cesta rápida inteira sem data.

Verificado contra os DOIS anúncios reais: mochila → grátis 26/08 × R$17,99 sem data;
sacola (MLB5574835066) → grátis 25/08 × R$9,99 24/08 (regra 1 intacta). Gate: tsc,
ml-freight 14/14 (2 casos novos), instant-quote/copy/adapter 39/39, E2E choosing_freight
4/4.

## Atualização 20/08/2026 (5ª) — decisão do dono: agente GPT executa as compras manuais

O dono validou que um agente de IA (GPT) consegue fazer as compras manuais nos sites —
a pendência "achar um operador" (19/08) fica SUPERADA: sem contratação humana por ora;
o dono supervisiona. O fluxo não muda: a Lia cota/cobra, o `/ops` continua sendo o
painel (comprado/despachado/entregue, estornos), muda só quem digita no checkout.

Riscos aceitos/vigiados, registrados na decisão:
1. **Anti-bot dos varejistas.** Agente de IA num checkout é automação aos olhos da loja
   — a MESMA classe que fez o Carrefour banir a sessão remota em 19/07. Em volume de
   piloto tende a passar; se uma loja bloquear, a compra volta pra mão humana NAQUELA
   loja. Não insistir contra bloqueio (regra antiga do projeto, continua valendo).
2. **Conta do Mercado Livre.** "Robô = banimento" foi o motivo de nunca automatizar
   compra no ML. Um agente comprando pela conta do dono reabre esse risco exatamente
   onde a cauda longa mora. Mitigação: volume baixo, sessão logada do próprio dono,
   e o passo de PAGAMENTO confirmado por humano enquanto o piloto durar.
3. **Quem olha o /ops?** O alerta de pedido PAGO foi desligado hoje a pedido do dono
   (ele era o operador). Com a compra delegada ao agente, pedido pago sem ninguém
   olhando volta a ser o cenário do zumbi de 11/08 — religar com
   `LIA_OPERATOR_PAID_ALERT=true` na Vercel quando entrar gente de fora.

## Atualização 20/08/2026 (4ª) — correção fina em cima da lista: "coca zero em vez da normal"

Sequência do modo lista (pedido do dono): a cesta montada precisa aceitar ajuste
NATURAL, sem sintaxe de comando. Três peças novas, todas com guarda:

1. **"X em vez de/da/do Y" e "X no lugar de Y"** (`SWAP_INSTEAD_RE`, ordem invertida —
   o novo vem primeiro) viram `swap_item`. "bota coca zero em vez da normal" funciona.
2. **"não quero de X, quero de Y"** (`SWAP_NEG_RE`) vira troca; com "de" nos DOIS lados
   é troca de ATRIBUTO (`attr: true`) e o cérebro compõe a busca com o substantivo do
   item trocado — "de laranja" busca "suco laranja", nunca a fruta. Guarda: comando
   nunca é lado de troca ("não quero mais nada, quero PAGAR" segue sendo fechamento).
3. **Referência à cesta ≠ busca** (handleSwap): "de uva" apontando pro "Suco de Uva" da
   cesta agora resolve por presença de token quando aponta pra UM item só — a regra de
   aposição da busca (1 palavra não casa qualificador) zerava a remoção. E quando o
   `from` não nomeia nada ("da normal"), o alvo cai pro item que compartilha token com
   o TO ("coca zero" → a coca da cesta), também exigindo unicidade.

Gate: tsc, intents 44/44, copy 12/12, E2E 12/12 (2 novos de correção fina + lista 3 +
trocas/endereço 7 de regressão).

## Atualização 20/08/2026 (3ª) — lista encaminhada vira cesta direta + alerta de PAGO opcional

Pedido do dono: encaminhar uma lista do WhatsApp ("1 coca ¶ 2 vodka ¶ 2 sucos") tem que
montar a cesta inteira de uma vez, sem interrogatório de cards por item.

- **Modo lista** (`handleConciergeRequest`): mensagem com **3+ linhas** que resolvem
  **2+ itens** → a Lia escolhe o topo do ranking de cada linha (o MESMO ranking de
  "escolhe você": rerank por IA ou determinístico) e monta a cesta com as quantidades da
  lista; resposta = resumo "Montei a cesta da sua lista" (item a item com preço) + os
  botões de sempre (Ver total/Adicionar mais/Cancelar). Sem cards/foto por item de
  propósito (10 cards é spam); ajuste fino continua por "troca X por Y" e "tira X".
  Linha sem preço é recusada na mesma resposta; a cesta monta com o resto. Lista por
  VÍRGULA continua no fluxo de cards (o gatilho é ter 3+ LINHAS — formato de lista
  encaminhada). Quantidade some da pergunta: a da linha vale, sem qty explícita = 1.
- **Numeração ≠ quantidade** (`stripListNumbering`, lia-intents): "1. coca ¶ 2. vodka ¶
  3. suco" com separador (./)/-) é índice → tudo qty 1; número NU ("2 vodka") segue
  sendo quantidade. Exige 3+ linhas todas numeradas.
- **Alerta de pedido PAGO ao operador desligado por padrão** (pedido do dono — ele é o
  operador e o /ops mostra). Religar com `LIA_OPERATOR_PAID_ALERT=true` quando entrar
  gente de fora: foi esse alerta que matou o pedido-zumbi de 11/08. Os alertas de
  cotação manual/item adicionado continuam.

Gate: tsc, intents 43/43 (5 casos novos de numeração), E2E 3/3 novos (lista direta,
numerada, com item impossível) + 6/6 de regressão dos fluxos de card/instantânea.

## Atualização 20/08/2026 (2ª) — recusa da "mochila saco pequena": o actor chegava 5s atrasado

Reteste pós-watchdog: a Lia avisou aos 45s (camada 1 funcionou) mas terminou em recusa
honesta — errada, porque o ML TEM o produto. Diagnóstico com prova: reproduzi o run do
actor com a query exata (`UqcgaIfRnXkHV9IqU`): **SUCCEEDED com 24 mochilas em 44,8s** —
contra teto de espera de 40s em produção. A Lia desistiu 5s antes do resultado, nos dois
turnos (zero entradas no cache). Agravante: prefetch (frase crua) + busca (frase extraída)
+ resgate = até 3 runs de 4GB simultâneos = 12GB > 8GB da conta Apify → runs enfileiram e
o teto estoura em cascata. Consertos: `LIA_ML_MAX_WAIT_MS` 40s→**75s** (o watchdog já
avisou o cliente aos 45s; esperar é honesto), `LIA_RESCUE_BUDGET_MS` 90s→**120s** (com o
run completando e gravando no cache, o resgate da mesma query vira acerto de cache em vez
de 3º run), e log `[ml:apify:wait-timeout]` quando um run vivo é abandonado (era
invisível — o diagnóstico de hoje só saiu reproduzindo o run à mão). Copy do watchdog
ajustada a pedido do dono: "Ainda procurando — já te respondo."

## Atualização 20/08/2026 — silêncio absoluto no teste da mochila: garantias anti-silêncio

Reteste do dono ("Oi quero uma mochila saco pequena barata", 11:16): a Lia mandou
"Procurando…" e depois NADA — nem opções, nem erro. Evidência dos logs: a mensagem
chegou, `[mercado-livre:official-search] 401` (token legado de 55 dias na Vercel; token
do ML dura 6h) e o turno morreu sem log de erro — morte pelo teto de duração da função
dentro do `waitUntil`, onde o catch do webhook não alcança. O caminho sem limite eram os
fetches da OpenAI (extração roda 2x quando há resgate de última chance) sem timeout.

Cinco garantias, em camadas:
1. **Watchdog do turno** (webhook): processamento passou de `LIA_TURN_DEADLINE_MS` (45s)
   → o cliente recebe `copy.turnStillWorking()` ("Tá demorando mais que o normal aqui.
   Já te respondo — não precisa mandar de novo."). Se a resposta real chegar depois, a
   sequência continua coerente; se a função morrer, o silêncio absoluto não existe mais.
2. **Timeout em TODAS as chamadas OpenAI** (`LIA_AI_TIMEOUT_MS`, 10s) — pendurada vira o
   fallback determinístico que já existia. O rerank mantém os 6s próprios.
3. **Timeout nas chamadas do Mercado Pago** (`LIA_MP_TIMEOUT_MS`, 10s) — mesma classe.
4. **Orçamento do resgate** (`LIA_RESCUE_BUDGET_MS`, 90s): turno que já queimou o
   orçamento NÃO roda a 2ª rodada de ML (extração+actor+rerank ~40-70s) — recusa honesta
   agora vence morrer no teto em silêncio.
5. **Rota oficial do ML de castigo 10 min após 401/403** — o token morto custava 4s de
   timeout em toda busca fria. O env `MERCADO_LIVRE_ACCESS_TOKEN` (55 dias, inválido por
   definição) foi REMOVIDO de Production; a busca vai direto ao actor até o dono criar o
   app no DevCenter.

Conferir no dashboard da Vercel (1 min, dono): **Fluid Compute ativo** no projeto — sem
ele, `maxDuration=300` vira 60s no plano Hobby e o teto mata turno de ML frio.

## Atualização 19/08/2026 (2ª) — teste real da mochila: 5 defeitos de conversa fechados

Teste real do dono ("Oi quero uma mochila de academia sacola", screenshots) expôs cinco
defeitos num fluxo só; todos fechados no mesmo dia:

1. **"Procurando as melhores opções…" saía DUAS vezes** (busca inicial + resgate de
   última chance criam timers separados). `searchNoticeTimer` agora deduplica por
   telefone (90s): um aviso por rajada.
2. **"sacola eu não consigo trazer hoje" seguido dos cards de mochila lia como
   contradição.** Quando outras linhas da MESMA mensagem acharam opções, a recusa usa
   copy com escopo (`itemsNotAvailableWithOptions`): "*sacola* eu não achei — o resto
   achei e tá logo abaixo."
3. **"Mais barata" seco ESCOLHIA a mais barata da mesa e punha no carrinho** — o cliente
   estava rejeitando as 3. Regra nova: preferência de preço só escolhe com verbo de pegar
   ("quero o mais barato") ou artigo definido ("o mais barato"); seca, ela NAVEGA —
   `parseChoiceReply` devolve `cheaper`/`pricier` e `showPriceSortedOptions` mostra o
   pool ordenado por preço (distintos primeiro, variantes preenchem). Nunca compra.
4. **"Outras opções" tocado com a escolha já fechada caía no "Me diz de outro jeito"**
   (`opt:outras` fora da escolha era `reject`). Agora é intent `more_options`: o contexto
   guarda a última escolha concluída (`ctx.lastChoice`, com o sku escolhido) e o toque
   REABRE ela (`reopenLastChoice`) — pageMoreOptions segue dali; o novo pick SUBSTITUI o
   item na cesta (`PendingChoice.replaceSku`), nunca soma um segundo. Só vale no passo
   `collecting`; com cotação/pagamento na mesa não mexe.
5. **"Mais barato" digitado depois disso caía no "não entendi"** (virava modificador
   vazio). Seco e sozinho, vira `more_options{cheaper}` → reabre a última escolha
   ordenada por preço.

Latência (~2 min até os cards) é limitação conhecida do actor do ML (busca fria 20-25s
×2 quando há resgate); o caminho pra ~1s é a API oficial (pendência do dono no
DevCenter). Testes: units de intents (54) + 2 E2E novos (navegar por preço sem comprar;
reabrir e substituir). Golden intacto (scorer não mudou).

## Atualização 19/08/2026 — /admin fechado com login (revisão pré-lançamento)

A revisão completa pré-amigos-e-família achou o painel `/admin` e as rotas `/api/admin/*`
e legadas `/api/conversations/*` **abertas em produção** (PII de clientes + estorno/aprovação
sem token; confirmado ao vivo com 200 sem auth). Decisão do dono: login por **usuário e
senha** (token na URL incomoda). Implementado em `src/lib/admin-auth.ts`: cookie httpOnly
`admin_session` (HMAC derivado da senha — trocar `ADMIN_PASSWORD` derruba todas as sessões),
form em `/admin`, guarda `requireAdminSession` nas 12 rotas e o `/chat` de demonstração
atrás do mesmo login. **Falha fechado**: sem `ADMIN_USER`/`ADMIN_PASSWORD` no ambiente,
ninguém entra (o `dev:demo` exporta demo/demo). Credenciais Sensitive criadas em
Production/Preview na Vercel. Na sequência, os guards de `src/lib/auth.ts`
(API_TOKEN, webhook, assinaturas Twilio/Meta) passaram a **falhar fechado em deploy
Vercel** quando o segredo estiver ausente (localmente seguem liberando, pro dev:demo e
testes); os quatro segredos foram conferidos presentes em Production antes do deploy.
Os demais achados da revisão (Pix mock em falha do MP;
conversa presa após cancelamento no /ops + `choosing_freight` sem TTL) estão em sessões
paralelas próprias; landing revisada publicada junto deste deploy.

## Decisão vigente — remodelagem concierge (2026-07-20)

O produto foi remodelado para um **concierge de WhatsApp com largura**, comprado e
cotado **à mão pelo operador**, com **entrega na hora por motoboy que sai da base do
operador**. Isso resolve a fragilidade estrutural da automação de checkout (o Carrefour
bloqueou o Browserbase em 19/07; Petz/Boticário não expõem frete no Context há semanas).

- **Largura é o diferencial**: o cliente pede **qualquer coisa, de qualquer lugar**, numa
  mensagem só. Item fora de catálogo **não é recusado** — vira uma linha livre que o
  operador cota e compra. O moat é a largura + estar no WhatsApp (onde o Rappi não está) +
  memória do cliente. Velocidade pura contra Rappi/iFood é armadilha e não é o jogo.
- **Escopo geográfico**: a Lia opera **somente no estado de São Paulo**. No concierge, a
  fronteira de UF é rígida: CEP/UF fora de SP vira lista de espera e nunca chega a cotação,
  cobrança ou compra. Dentro de SP, o CEP exato, a disponibilidade do varejista e o frete
  ainda precisam ser confirmados pedido a pedido.
- **Cotação manual**: ao fechar a lista (`"só isso"`/`"pagar"`), a Lia cria um pedido em
  `awaiting_operator_quote`. O operador cota no `/ops` (custo dos produtos + frete +
  modalidade + prazo) e envia; o pedido reaproveita `awaiting_quote_confirmation` e toda a
  máquina de pagamento (Pix/cartão) já existente. Nada é cobrado antes da aprovação.
- **Motoboy na hora sai do OPERADOR, não da loja**: o operador compra e entrega o pacote ao
  courier (Uber Direct/Lalamove) na própria base → sem o problema de documento do titular
  na retirada em rede grande (que matou o motoboy-de-balcão em 14/07). Modalidade alternativa
  no `/ops`: entrega do próprio varejista.
- **Browserbase sai do caminho crítico**: com `LIA_MANUAL_CONCIERGE=true` (default), a
  cotação por checkout automatizado e as guardas de distância de loja não rodam. O fluxo
  legado de catálogo/auto-cotação permanece atrás de `LIA_MANUAL_CONCIERGE=false` (é o que os
  evals de conversa continuam exercitando).
- **Envs novos**: `LIA_MANUAL_CONCIERGE` (default on), `LIA_COVERAGE_PRESET=estado-sp`,
  `LIA_OPERATOR_PICKUP_ADDRESS` e `LIA_OPERATOR_PICKUP_CEP` (base de onde o motoboy retira).
- **Prontidão**: o código e a publicação estão configurados para operar em SP; a primeira
  validação com pedidos reais é uma decisão do operador, não uma pendência de desenvolvimento.
  A empresa é MEI, a operação financeira será pela PJ e a PJ é a titularidade operacional da
  compra. MEI não exige contador fixo nem contabilidade formal: mantém relatório mensal de
  receitas e DASN anual. Para NF, venda a PF é dispensada salvo solicitação; venda a PJ exige
  documento fiscal. O formato exato para mercadoria/serviço deve ser documentado, mas não exige
  contratar contador mensalmente. TypeScript, lint, testes focados (fluxo manual + evals legados)
  e build estão verdes.
- **Pós-venda decidido em 02/08**: antes do pagamento, o cliente pode limpar a lista; depois do
  pagamento não há cancelamento iniciado pelo cliente nem substituição. Se faltar item, a Lia
  estorna o valor daquele item; se houver atraso, avisa o cliente. O procedimento de estorno
  parcial ainda é manual e precisa de referência do provedor para auditoria.
- **Estado em 21/07**: os commits `bb48c2e` (fluxo), `ededf6a` (documentação) e `7ab8453`
  (kit do operador) estão verdes localmente. Um pedido concierge percorreu, em ambiente local
  mockado e sem cobrança, cotação → Pix confirmado → compra → despacho pela base do operador →
  entrega; as mensagens ao cliente também foram conferidas. O concierge **não está implantado**:
  publicar agora misturaria uma migration Oba inacabada de outro trabalho. Fazer deploy somente
  quando houver publicação limpa. Há 19 pedidos técnicos na fila de produção; removê-los requer
  autorização explícita. A decisão operacional é **contratar um operador** para o piloto.

### Atualização 23/07/2026 — vitrines de referência (10 lojas)

Por decisão do operador, a vitrine integrada foi ampliada para **10 lojas**: Carrefour
(de volta como vitrine seed — a automação de checkout segue proibida; o bloqueio de
19/07 era contra o robô, não contra o operador comprando como cliente comum), Oba, Petz,
Boticário, Decathlon (restaurada + ampliada) e as novas **Swift, Kalunga, Ri Happy,
Cacau Show e Kopenhagen**. As novas vitrines são seeds de dados REAIS colhidos dos sites
públicos em 23/07 (nome/preço/URL verificados; sem invenção). No concierge, o preço da
vitrine é referência — a autoridade é a cotação manual do operador. A seção de 19/07
abaixo ("exatamente três fontes") fica **superada** por esta decisão. `quoteBasket`
passou a tolerar loja sem unidade física (sem balcão → sem guarda de distância; frete
cotado pelo CEP do cliente). Supersede também o item "não adicionar lojas agora": o
operador decidiu ampliar a vitrine antes do piloto.

**Totais da vitrine (seed/histórico, sob `LIA_RETAILER_TEST_SEED` ou como referência):**
Carrefour 1.045 · Petz 2.812 · Boticário 1.380 · Ri Happy 1.196 · Swift 925 · Kopenhagen
248 · Decathlon 17 · Kalunga 15 · Cacau Show 12 · Droga Raia 13 · Oba 2 (Oba usa busca ao
vivo em prod). ~7,7 mil itens. Ri Happy/Swift/Kopenhagen colhidos pela API pública VTEX via
`scripts/harvest-vtex-catalog.mts` (sem Chrome). Decathlon/Kalunga/Cacau/Raia têm API
bloqueada (Akamai/não-VTEX) e ficaram em seed real menor — aprofundar exige DOM/Apify.

**Bug de roteamento corrigido (23/07):** as dicas de vocação (pet/beleza) testavam a query
COM acento contra regex SEM acento, então "ração" perdia o empate para o Carrefour. Agora
normaliza (NFD) e pesa +2 → item de pet vai pra Petz, beleza pra Boticário.

**Deploy 24/07:** remodelagem concierge + kit do operador + 11 vitrines + fix de roteamento
foram para produção (`dpl_9upchNgpPZ15…`, READY). **Suíte completa 209/209 verde** (com banco),
TypeScript, lint e build limpos. `liadelivery.com.br` responde (landing 200, `/ops` 401,
webhook 403). A vitrine profunda ainda NÃO aparece pro cliente no concierge (fluxo é livre →
operador); mostrar opções com foto seria a "vitrine híbrida" — decisão de produto em aberto.
Pendências humanas: conciliar os 7 pedidos pagos antigos, documentar a rotina fiscal do MEI,
rotacionar a senha Carrefour/PIN do WhatsApp e as demais credenciais expostas. A validação com
pedidos reais é opcional e não é requisito de desenvolvimento.

O restante deste arquivo descreve o fluxo legado de automação por varejista; ele continua
válido como referência, mas **o produto ativo é o concierge manual acima**.

### Atualização 02/08/2026 — reconciliação de produção, escopo SP e segurança operacional

- O deploy limpo de 24/07 continua sendo a versão pública: concierge manual, kit do operador,
  11 vitrines e correção de roteamento. A landing responde 200; `/ops` abre a interface, mas as
  APIs internas continuam protegidas e o webhook rejeita chamadas sem assinatura.
- O snapshot publicado foi consolidado no Git sem descartar alterações do usuário. `main` foi
  avançada localmente até o commit `a700290`, que contém o limite estadual de SP, a titularidade
  na PJ e a política de pós-venda;
  o worktree está limpo. O push remoto de `main` ainda é uma ação separada.
- O item de segurança operacional foi reforçado no código: em produção Meta, despacho mockado do
  courier agora falha fechado; o despacho por motoboy também exige `LIA_OPERATOR_PICKUP_ADDRESS`
  e um `LIA_OPERATOR_PICKUP_CEP` válido. Demos locais continuam usando o provider `mock`.
- A auditoria de nomes de variáveis da Vercel encontrou Contexts/credenciais históricas. A base
  do operador foi configurada como Sensitive em Production (endereço e CEP informados pelo
  operador). `LIA_MANUAL_CONCIERGE=true`, `LIA_REQUIRE_REAL_COURIER_DISPATCH=true`,
  `PURCHASE_AUTOMATION_MODE=cart_only` e compra automática desligada estão ativas; o redeploy
  `dpl_5kTpBbsitN6BgP5vcQrDh22AfqP4` ficou `Ready`. O código impõe `estado-sp` no concierge.
- A fila tinha 19 entradas: 12 preflights internos sem pagamento foram removidos; 7 pedidos
  pagos ficaram intactos para conciliação/estorno. A decisão é receber na PJ, manter a PJ como
  titularidade operacional e, no pós-venda, não aceitar cancelamento/substituição depois do
  pagamento, estornar item faltante e avisar atraso. Restam a confirmação contábil do documento
  fiscal exato e a rotação de segredos. A conta Mercado Pago PJ foi confirmada pelo dono no
  painel; as variáveis de produção já estão presentes. A
  validação real fica para quando o operador decidir; não é um gate técnico.
- **2ª rodada de 02/08 — decisões do dono:** (1) o piloto será operado **pelo próprio dono**,
  sem contratar operador agora; (2) a rotina fiscal foi decidida e documentada em
  [docs/rotina-fiscal-mei.md](docs/rotina-fiscal-mei.md) (intermediação de compras; NF do
  produto é a do varejista; NFS-e só para PF que pedir ou cliente PJ; resta confirmação
  contábil pontual do teto de receita antes do lançamento público); (3) a rotação das
  credenciais expostas foi **abandonada como gate de piloto** — risco aceito e registrado,
  reabrir só por pedido explícito ou incidente; (4) a conta Mercado Pago foi confirmada no
  painel pelo dono como PJ, com a aplicação `LIA - APP` em Produção; as variáveis de acesso e
  webhook já estão na Vercel Production. As credenciais mostradas em captura permanecem
  tratadas como expostas, sem marcar a rotação como concluída.
  Verificação do dia: suíte **213/213 verde com banco**, `tsc` limpo, produção `READY` em
  `a700290`; vitrine runtime com **7.652 produtos em 11 lojas**.

### Atualização 03/08/2026 — One-Click reativado (decisão do dono)

O cartão nativo no WhatsApp saiu de "adiado" para "em ativação" ("vamos fazer isso"). Nada
mudou no desenho canônico (Meta Cloud API direta + Pagar.me V5, sem 360dialog) nem no código —
os gates são externos. Em 03/08, dois desdobramentos: (1) a **Infobip
respondeu NÃO** — a rota de allowlist via eles morreu; a rota restante é ticket no Suporte
Direto da Meta (rascunho entregue ao dono) — mas a verificação de 03/08 mostrou que a
Payments API BR segue em **beta fechado** ("select customers"); habilitações documentadas
passam por BSPs, então o ticket direto tem chance baixa/prazo indefinido para um MEI. Vale
abrir mesmo assim; plano B = Checkout Pro até a GA. A WABA também precisará de Meta Product
Catalog vinculado; (2) a pergunta técnica ao Pagar.me foi **resolvida por documentação, sem e-mail**:
`recurrence_cycle` marca recorrência externa, é opcional e "não cria cobrança recorrente" —
a recompra da Lia é avulsa iniciada pelo cliente, então **o adaptador atual (`card_id` sem
`recurrence_cycle`) está correto**; CVV para card_id avulso não é exigido pela doc (antifraude
é o que o sandbox valida); domínio do tokenizecard.js se libera pelo dashboard. Contatos:
relacionamento@pagar.me / homologacao@pagar.me. O piloto não espera o One-Click: Pix + Checkout Pro cobrem cartão. Sequência
pós-chaves (agente): envs Sensitive → webhook com 6 eventos → ajuste do adaptador conforme o
PSP → sandbox completo → só então `LIA_ENABLE_WA_PAYMENTS=true`.

### Atualização 04/08/2026 — ticket da Payments API aberto na Meta

O pedido de habilitação da **Payments API Brasil** foi aberto no Suporte Direto da Meta em
04/08, no portfólio **Lia** (`Business ID 1802515380110705`). Protocolo
**`37565409896407734`**, status inicial **Open**, assunto **Dev: Cloud API** e tipo
**Messages API and Webhook**. O chamado pede a habilitação de `order_details` / one-click
offsite card payment para a WABA **Lia Delivery** (+55 11 97844-4813), preservando número,
webhook e Graph API na Cloud API direta, sem migração de sender, com Pagar.me no backend.
O formulário recusou português para esse tipo de pergunta; a mesma solicitação foi enviada em
inglês. Abertura do ticket **não é habilitação nem prazo**: a flag continua desligada e o gate
agora é aguardar resposta da Meta. Acompanhar em
<https://business.facebook.com/direct-support/case-detail/37565409896407734/?business_id=1802515380110705>.

### Atualização 06/08/2026 — busca da vitrine: a IA passa a escolher o produto (rerank + golden set)

Caso real do dono: "carregador usb c" devolvia **3 carregadores veiculares** (o mesmo item em
3 cores). Quatro falhas léxicas empilhadas: o token "c" era descartado (1 letra); o item certo
("Carregador de Parede … Usb-C", Pague Menos) EMPATAVA no score com o veicular; o roteador de
loja única resolvia o empate pela ORDEM do registry (Petz vem antes); e o desempate final era
preço. Diagnóstico geral: o matcher conta palavras em comum, não entende o pedido — e a IA,
que já rodava na extração, **nunca participava da escolha do produto**.

Desenho novo (implementado e testado):

1. **Candidatos largos** — `gatherCrossStoreCandidates` (stores/index.ts) junta o top-4 de
   TODAS as vitrines e rankeia globalmente (score → variantes não pedidas → preço). No
   concierge, o roteador de loja única (`pickStoreForQueries`) sai do caminho: a cesta já era
   mista mesmo (quem compra é o operador). O fluxo legado travado em uma loja não muda.
2. **Rerank por IA** — `rerankShoppingOptions` (adapters/ai.ts): UMA chamada batched por
   mensagem decide, por item, quais candidatos são REALMENTE o produto pedido e em que ordem,
   diversificando cor/embalagem. Lista vazia = nada serve → linha livre do operador (o
   resultado honesto). Skus são validados contra os candidatos enviados (IA não inventa
   produto); timeout de 6s (`LIA_SEARCH_RERANK_TIMEOUT_MS`) e kill-switch
   `LIA_SEARCH_RERANK_OFF`; qualquer falha cai no determinístico de sempre. Quando o rerank
   roda, ELE substitui o piso `conciergeMatchIsStrong` — a IA entende "escova de dente" ≈
   "Escova Dental", que o piso léxico mata.
   *Custo/latência:* é a 2ª chamada de LLM por mensagem (a 1ª é a extração, que já existia),
   uma só por mensagem independente do nº de itens, com payload pequeno (≤12 candidatos por
   linha). Some ~1–3s ao turno; o teto de 6s garante que a Lia nunca fique presa esperando.
3. **Determinístico melhor mesmo sem IA** (regras principiais, nunca por produto): compostos
   ("usb c"/"tipo c" viram token único; o genérico "usb" ainda serve o específico "Usb-C");
   typo-fuzzy passa a exigir palavra de catálogo com 6+ letras ("miojo" casava com a vinícola
   **Miolo** e com "Miolo de Alcatra" — em 5 letras, palavras reais colidem a distância 1);
   marca nunca typo-casa (nome próprio); substantivo de categoria ganha o bônus de head
   ("Pack Macarrão … Nissin **Miojo** 510g" vale como miojo); "sem X" bonifica quem diz
   "Sem/Zero X" no nome ("leite sem lactose" acha o Italac sem lactose, não o desnatado mais
   barato); e as 3 opções são **diversificadas** — cores do mesmo produto ocupam 1 vaga
   (pedir uma cor desliga a regra).

**O método já se pagou no mesmo dia.** Rodar 60 pedidos realistas pelo pipeline (varredura
exploratória, o passo "procurar busca ruim" do método) achou quatro bugs que ninguém tinha
reportado, todos consertados por regra principial — nunca por regra de produto:

- **"cotonete" não achava cotonete**, que ESTÁ no catálogo ("Hastes Flexíveis **Cotonetes**
  Johnson & Johnson"). A regra de pedido-de-uma-palavra zerava tudo que não fosse head. O que
  separa o caso legítimo do falso positivo é a **preposição**: em "Macarrão COM Ovos" a palavra
  é ingrediente; em "Hastes Flexíveis Cotonetes" ela nomeia o produto. Agora vale quando está
  justaposta e na frase inicial do nome (até a 3ª palavra) — no fim do nome é sabor
  ("Petisco para Cachorro Purina FRANGO" não responde por "frango").
- **"leite" devolvia loção de pele** ("Leite de Rosas"), leite de coco e leite pet. Três causas:
  a lista de variantes processadas tinha soja/amêndoas mas não coco; a marca "Leiteria" casava
  com "leite" por prefixo; e a versão pet não era penalizada. Agora: qualificador "de X" não
  pedido penaliza em consulta de uma palavra (regra geral no lugar da lista), marca só casa
  exato/plural (nome próprio não admite aproximação — foi o mesmo defeito do "Miolo") e item de
  espécie pet perde pontos quando o cliente não falou de bicho.
- **"água" vinha com gás** — "gas" entrou nas variantes de desempate, junto de integral/zero.
- **Armadilha achada no próprio conserto:** em catálogo brasileiro **"PET" é a garrafa
  plástica** ("Coca-Cola Pet 2L"). A penalidade de item-pet usava o mesmo regex do guarda
  duro, que inclui "pet" solto, e passou a punir refrigerante como se fosse ração. A
  penalidade agora usa só palavras de espécie.

**Invariante que saiu daí — penalidade REORDENA, guarda EXCLUI.** Fora do scorer,
`score > 0` é lido como "casa ou não casa" (`itemMatchesPhrase`, do "tira o X", é um
desses). Duas penalidades novas somadas derrubaram um match legítimo de head para -1
("Acessório de Comedouro … para Cães" com a consulta "Acessório") e o cliente perdeu a
capacidade de REMOVER o item da cesta — a busca continuava certa, o comando é que quebrou.
Agora, item que passou pelas guardas nunca cai abaixo de 1: quem exclui é `return 0`
explícito (espécie, negação, piso de relevância, pedido de uma palavra), penalidade só
empurra pra baixo no ranking. Pego pelo eval de conversa legado, não pelo golden — os dois
harnesses cobrem coisas diferentes e vale rodar ambos.

**Método novo — fim da tentativa-e-erro infinita.** A qualidade da busca agora é MEDIDA:
`tests/helpers/search-golden.ts` guarda os casos rotulados (28 hoje);
`tests/search-golden.test.ts` trava os determinísticos no `npm test` (regressão dura, roster
completo de 18 lojas); `npx tsx scripts/eval-search.mts` roda o pipeline completo (extração +
rerank com a chave real) e imprime o placar DET/IA. Fluxo de melhoria: busca ruim reportada →
vira caso no golden → mede → conserta → placar sobe → commit. Placar da época: **31/32
determinístico · 32/32 com IA** (placar vigente: ver a entrada mais recente datada). Regra:
mudança de scorer/prompt só entra acompanhada do caso que a justifica.

Bônus: consertado o bug que escondia a IA dos scripts — `scripts/talk-env.mts` usava
`__dirname` (inexistente em ESM), o `catch` engolia o erro e o `.env` nunca era carregado; o
`talk-lia` sempre rodou determinístico mesmo com `OPENAI_API_KEY` presente no `.env` (origem
da crença "não tem chave local"). Em produção o rerank vale automaticamente onde
`OPENAI_API_KEY` já está configurada (a mesma chave da extração).

**07/08 — pedido durante a cotação do operador (screenshot de produção).** Com um pedido em
`awaiting_operator_quote`, QUALQUER mensagem de produto respondia "Ainda estou cotando…
segura aí!" e o item era descartado — o cliente teve que CANCELAR o pedido pra conseguir
pedir um cotonete. Agora o item novo entra no MESMO pedido como linha livre (a cotação ainda
não saiu; o operador cota tudo junto), com nota "➕ Cliente adicionou durante a cotação" no
/ops e confirmação ao cliente (`copy.addedToPendingQuote`). Pergunta ("já saiu o total?")
continua com a resposta de andamento; só remédio continua recusado. Regressão em
`tests/manual-concierge.test.ts`. No mesmo screenshot: o "1x cotonete" como linha livre e o
emoji literal `🙂` são o código ANTIGO em produção — o cotonete já resolve com o
deploy (match por apposição + rerank), e o emoji não existe em NENHUMA versão do fonte
(artefato do build implantado; conferir na primeira conversa pós-deploy).

**10/08 — frete AO VIVO por CEP (`src/lib/live-freight.ts`).** A cotação instantânea agora
consulta o checkout real da loja (VTEX `orderForms/simulation`, allowlist de 8 lojas
abertas) com a cesta exata e o CEP do cliente, em paralelo com timeout 4,5s; o frete vem
exato por endereço e o frete grátis é o do próprio site. Hierarquia: **ao vivo → tabela
semeada (`SEED_STORE_FREIGHT`) → tarifa padrão**; resposta válida sem SLA de entrega =
site não atende o CEP → pedido cai pra cotação manual. Cesta simulada tem que ser 100%
parseável (sku `<loja>-<id>`) senão desiste — cesta parcial daria frete grátis errado.
Fonte por loja na nota do /ops e log `[instant-quote:live]`; kill-switch
`LIA_LIVE_FREIGHT_OFF` (pinado nos testes), teto `LIA_LIVE_FREIGHT_MAX` (150). Carrefour e
Petz bloqueiam consulta externa → sempre tabela. Validação real 10/08: PM R$4,90, Oba
R$9,90 same-day, Swift R$0 (grátis auto), Campinas R$4,90 — e a incógnita restante é só
se os sites tratam o IP da Vercel diferente (o log responde no 1º pedido; se bloquear,
degrada pra tabela sozinho).

**10/08 — diversidade nas opções (caso do dono: "quase o mesmo carregador 3x").** Pedir
"carregador" ou "ração" mostrava 3 variantes quase iguais do mesmo produto. Três causas e
três consertos: (1) `gatherCrossStoreCandidates` agora ordena produtos DISTINTOS primeiro —
cada loja manda seu top-4, que costuma ser a mesma ração em 4 tamanhos, e as variantes
esgotavam as 12 vagas antes de o rerank sequer ver um produto diferente; (2)
`sameProductVariant` (stores/types.ts): identidade = tokens do nome sem cor/medida
(Jaccard ≥ 0.75 = variante; marcas declaradas diferentes nunca são variantes; pedir
cor/tamanho mantém o atributo na identidade) — `diversifyOptions` passou a usar isso no
lugar do dedupe só-por-cor; (3) regra 3 do prompt do rerank endurecida: produto realmente
diferente (marca/modelo/tipo/faixa de preço), variante só como preenchimento quando não há
3 distintos. Golden ganhou o campo `distinctOptions` (checado no unit E no eval); casos
novos/marcados: "carregador usb", "racao para cachorro", "carregador de celular". Placar
pós-mudança: **32/33 determinístico · 33/33 com IA** (o × é o caso que só a IA resolve por
desenho). A regra "3 opções ainda que repetidas > lista curta" continua: variantes
preenchem quando o catálogo não tem 3 produtos distintos.

**17/08 (8ª) — quem escolhe a entrega é o CLIENTE, com botão.** Dono, na sequência do frete
real: "tem q perguntar se ele quer o mais rápido e caro ou mais demorado e barato e tem q ter
botão". Quando o anúncio oferece uma opção que chega ANTES pagando MAIS, a cotação
instantânea **para** (nada cobrado) e a Lia pergunta com dois botões — `frete:barato` /
`frete:rapido`, título com a DATA (`Mais barato · 25/08`, 19 dos 20 chars que a Meta
permite) e `Cancelar` sempre visível. Os dois totais já vêm calculados, então o toque
publica a cotação na hora: é escolha, não espera. `1`/`2`, "mais rápido", "mais em conta"
etc. funcionam por texto (fallback é a lista numerada). Detalhes que são regra, não acaso:
(a) só é escolha quando a opção realmente chega antes E custa mais — mais cara no mesmo dia
não é oferecida; (b) o novo passo `choosing_freight` fica ANTES do onboarding de endereço no
roteador, senão o toque `frete:barato` viraria item de cesta na varredura de lista;
(c) trocar endereço nesse passo preserva o pedido (é pedido sem preço na fila), como no
`awaiting_operator_quote`; (d) a escolha vai pra nota do /ops ("comprar ESSA opção de envio
no anúncio") — comprar a errada quebraria a data prometida. Testes: ml-freight 12/12,
adapter 7/7 (o teto de 20 chars do botão é teste, porque passar dele derruba a mensagem
inteira e o cliente fica esperando), copy 12/12, instant-quote 6/6, intents 41/41, tsc.

**17/08 (7ª) — FRETE REAL POR ANÚNCIO do ML (fim do R$18 chute), via API pública que não
pede token.** Dono: "os 18 automático tá péssimo (...) pensa que eu tô comprando uma
mochila, no app aparece 10,99 entrega até amanhã, grátis a partir de depois de amanhã — ele
tem que saber isso direto". No ML o frete é do ANÚNCIO + CEP, não política de loja, então
`LIA_FREIGHT_DEFAULT` ali sempre foi chute (fantasma pra cima, margem comida pra baixo).
**Descoberta que resolve** (testada ao vivo em 17/08, sem credencial nenhuma):
`GET api.mercadolibre.com/items/<MLB...>/shipping_options?zip_code=<CEP>` responde **HTTP
200 em ~0,35s** com exatamente o que o app do ML mostra — cada opção com `cost` e
`estimated_delivery_time.date` (Av. Paulista: padrão R$14,99 chegando 25/08, Sedex R$25,99
chegando 20/08; mesmo anúncio em Campinas R$14,99). É a única rota aberta: `/items/<id>`,
`/products/<id>` e `/sites/MLB/search` dão 403 PolicyAgent, e a página do anúncio cai no
"suspicious traffic" — ou seja, **isto NÃO depende do app do DevCenter** que está em
PENDENCIAS (esse segue valendo só pra busca rápida).
Implementação em `src/lib/ml-freight.ts` (novo): `mlItemIdFrom` tira o id do ANÚNCIO do
link (`produto.mercadolivre.com.br/MLB-123...`, ou `wid=`/`item_id=` em link de catálogo);
`mlItemFreight` consulta e escolhe a opção **mais barata de entrega no endereço** (ponto de
retirada não serve ao concierge; opção mais rápida é decisão do operador, não conta do
cliente), com teto de sanidade (`LIA_ML_FREIGHT_MAX` 150), timeout 3s e kill-switch
`LIA_ML_LIVE_FREIGHT_OFF`; `mlBasketFreight` soma por anúncio (cada anúncio é um checkout;
qty NÃO multiplica frete) e devolve a data do último item a chegar, que vira o
`deliveryPromise` do cliente ("chega até 25/08"). Invariante preservada: **nada é cobrado
sem número real** — anúncio sem estoque/sem entrega pro CEP, link só de catálogo (a rota
produto→anúncio é 403) ou consulta falhando derrubam a cotação instantânea e o pedido vai
pro operador com o motivo na nota do /ops. Anúncio que declara frete grátis segue fechando
na hora mesmo sem consulta (grátis nunca cobra a menos).
Auditoria de markup do mesmo turno: 10% confirmado em TODOS os caminhos vivos (cards, teto
"até X reais", cotação instantânea/manual, mínimo de loja, order_details) — único furo é o
pipeline LEGADO do ML (`/api/apify/mercadolivre/callback` → chat-service), que manda preço
cru; é inalcançável em produção (o webhook só chama `handleDeliveryMessage`), mas se voltar
precisa passar pelo `display()`. Testes: ml-freight 8/8, instant-quote 6/6, tsc limpo (o
eval E2E não rodou: o Postgres remoto está em ~2,6s por query e a suíte não termina).

**17/08 (6ª) — RAPPI DESCARTADO como vitrine (decisão do dono, com evidência) + frete do
anúncio do ML.** O dono quis o Rappi "tipo o ML no fluxo". Investigação (17/08, tudo
testado): o site do Rappi é SSR e a busca DENTRO de uma loja funciona com fetch puro —
`rappi.com.br/lojas/<slug>/s?term=<q>` devolve produtos no `__NEXT_DATA__`
(`fallback["storefront/<slug>/search/<termo>"].products`): 40 itens em 1,2s, com preço,
foto, estoque, e a página da loja ainda traz `delivery_price`/`eta_value`. Seria a
integração mais barata do projeto — **mas só vale para lojas do Rappi Mall** (e-commerce
nacional: Nespresso, Kalunga, Granado). Os SUPERMERCADOS (Carrefour/PdA/Extra, o turbo de
1h — o único motivo de querer Rappi) exigem localização definida no CLIENTE: slug de
mercado cai em landing genérica, `lat/lng` em URL e cookie não mudam nada, a API interna
responde 401 e o edge bloqueia sondagem (403 PATH_NOT_ALLOWED). Só com navegador — que
foi removido do produto de propósito (03/08). E o que é raspável (Mall) é entrega em
dias, ou seja, o trabalho que o ML já faz melhor. Actors de Rappi no Apify são de
RESTAURANTE (~US$0,5 só o start) e não fazem busca de produto em mercado.
**Conclusão do dono: "não precisa do Rappi se não ajuda em nada".** Rappi segue como
CANAL DE COMPRA manual do operador (tag ⚡), nunca como vitrine — não reabrir sem fato
novo (ex.: API de parceiro). No mesmo turno, o achado colateral virou conserto: item do
ML caía na tarifa padrão R$18 porque o ML não tem política de loja — taxa fantasma sobre
anúncio que estampa "Chegará grátis". Agora `CatalogItem.freeShipping` (do `freteGratis`/
texto do anúncio) viaja até `computeStoreFreights`: loja cujos itens são TODOS de frete
grátis sai com fee 0; um item pago no meio traz a política de volta (nunca cobrar a
menos). Testes: instant-quote 5/5, ML 11/11, live-freight, tsc.

**17/08 (5ª) — card do ML: slot de entrega é PRAZO, não benefício de frete.** Reclamação
do dono: "tá vindo frete grátis mas é pra vir prazo de entrega". Investigação no dataset
real: quando o anúncio não publica data, o actor devolve `envio: "Frete grátis"` ou vazio
(`Tiempo` é timestamp da raspagem, `disponivelEm` é variação de cor — não há prazo
escondido em outro campo), e os sem-data são com frequência anúncios INTERNACIONAIS
("enviado da China"). Três consertos em `mercadolivre.ts`: (1) `deliveryLabelFrom` não
devolve mais "frete grátis" — sem data publicada, sem rótulo (inventar prazo segue
proibido; o contrato é a cotação do operador); (2) `toCatalogItem` descarta
`eCompraInternacional`/`enviadoDe: China` na entrada; (3) `rankMercadoLivre` desempata
por TEM-PRAZO antes de vendas/avaliações — anúncio FULL publica prazo e agora domina os
3 cards. Cache versionado (`ml:v2:`) para valer sem esperar o TTL de 6h. Conector 11/11.

**17/08 (4ª) — vitrine fit/congelados: o gargalo do "sorvete que não engorda" era prateleira.**
Pergunta do dono: "quero um sorvete bom e que não engorda pra agora — ele resolve?".
Diagnóstico com dado: entender ele vai (rerank já julga contra a mensagem original), mas
as vitrines só tinham sorvete comum — e a FONTE tinha o produto: a API da Natural da
Terra vende Sorvete Napolitano Zero Açúcar Nestlé, Açaí Zero Frooty, Yamo Zero; YoPRO
existe em 3 mercados. O top-vendas da colheita nunca traz esse nicho. Conserto
estrutural: `--ft=<termo;termo>` no `harvest-vtex-catalog.mts` (varreduras complementares
por texto, mesmo dedupe/deny) + lista `GROCER_FT` (sorvete; açaí; zero açúcar; proteico;
yopro; whey; diet; light; sem lactose; sem glúten) nos 3 mercados do refresh. Resultado:
NdT 904→1.543 itens, Swift 920→968; **Oba caiu 1.494→1.000** (a API passou a parar em
`_from=1000` — não é regressão nossa; água mineral e essenciais continuam). Efeito
colateral pego pelo golden: "água" seca passou a devolver saborizada → "saborizada"
entrou em `PROCESSED_VARIANTS` (só vale se pedida). Verificado no roster de produção:
"sorvete zero açúcar" → Nestlé Zero R$32,99 em 1º; "açaí zero" → 3 opções de 3 lojas.
Gate: catalog-gaps + golden 40/40, tsc. A "vitrine Rappi ao vivo" segue registrada como
projeto só-se-o-piloto-provar-demanda (actors atuais são de restaurante, ~R$3/busca).

**17/08 (3ª) — tag "⚡ quer HOJE" no /ops (pedido do dono) + direções registradas.**
Contexto: o dono quer usar o **Rappi como canal de entrega urgente** (compra manual do
operador com o endereço do cliente — zero código, igual ao ML) e perguntou "como separar"
urgente de não-urgente. O NLU já detectava urgência ("urgente", "pra hoje", "queria
receber hoje") mas JOGAVA FORA a informação. Agora: `hasUrgencySignal` (lia-intents, puro,
unit-testado — "carregador rápido"/"carga rápida" NÃO contam, é atributo de produto),
`ctx.urgent` marcado em qualquer mensagem do turno (depois dos dois resets de TTL, senão a
marca morre na mesma mensagem), nota `⚡ URGENTE: cliente quer receber hoje.` no pedido
(criação e update), alerta do operador com prefixo ⚡ e **badge laranja "⚡ quer HOJE"**
no card do /ops. Nada muda para o cliente. A escolha do canal continua DO OPERADOR na
cotação (atenção à margem: preço dentro do Rappi é ~10-20% acima da gôndola + taxas —
conferir o total no Rappi antes de cotar urgência). Direção registrada (passo maior,
sem código ainda): **busca consultiva** — "quero algo pra X" (ex.: dor nas costas) deve
virar recomendação assessorada, não match literal; o dono sabe que remédio continua
proibido, o exemplo era ilustrativo.

**17/08 (2ª) — busca fria do ML: ~30s → ~20-22s (pedido do dono: "mais rápido").** O teto
é o próprio actor; medições reais de 17/08: karamelo em 1GB = 28,5s, **4GB = 21,1s**, 8GB =
19,7s (marginal) — na Apify CPU escala com memória, e em actor pay-per-event o compute é
conta do desenvolvedor, então 4GB é de graça pra nós. Alternativas testadas e DESCARTADAS:
gio21/mercado-livre-scraper (35s, voltou bloqueado com 1 warning), riseandcode (35,6s, 5
itens), fetch direto de lista.mercadolivre.com.br (200 mas "suspicious-traffic-frontend"),
API oficial `api.mercadolibre.com/sites/MLB/search` (403 sem token de app). Três cortes:
(1) `memory=4096` no run (`LIA_ML_MEMORY_MB`); (2) `waitForFinish` no POST do run — o
polling de 2,5s virou fallback; (3) **prefetch em paralelo**: `buildChoices` dispara o run
frio ANTES da extração de IA quando o parser determinístico já vê linha sem match local
forte (`prefetchLongTailIfNeeded`), e o retry de última chance pré-dispara com a frase
determinística — buscas idênticas em voo compartilham UM run (`inflight` no conector).
Para chegar em 10-15s ou menos só com a **API oficial do ML** (token de app via
client_credentials, ~1s/busca, grátis): exige o dono criar um aplicativo em
developers.mercadolivre.com.br — registrado em PENDENCIAS.

**17/08 — match local ERRADO bloqueava a cauda longa (caso "violão").** O dono pediu um
violão e ouviu "não tenho como trazer" — com o ML ligado, que tem violões aos milhares
(verificado no actor: Tagima R$1.389, Giannini, Vogga R$290). Causa: o gate
`needsLongTailSearch` só perguntava "existe match local forte?" e **"violão" casa com
"Brinquedo Musical - Violão - Patrulha Canina" (Ri Happy)** — o ML nem era consultado; o
rerank depois descartava o brinquedo (com razão) e a linha ficava órfã. Conserto: o ML
deixa de ser decidido por HEURÍSTICA PRÉVIA e passa a ser a ÚLTIMA CHANCE — quando o
pipeline inteiro (piso + rerank) esvazia a linha e o cliente ia ouvir "não tenho", roda
`buildChoices` de novo só para essas linhas com `forceLongTail`. O custo do ML é pago
exatamente quando a alternativa era recusar. Vale para a família toda do problema
(violão/brinquedo, microfone/karaokê infantil, panela/brinquedo de cozinha), não só o
caso relatado. A quantidade pedida na mensagem original é preservada no resgate.
Também: `searchingWider` virou "🔎 Procurando as melhores opções pra você…" — a versão
anterior expunha a mecânica ("procurei nas lojas parceiras e não achei, vou procurar em
outro lugar"), que o dono classificou como péssima. Suíte 344/344.

**16/08 (7ª) — ML entregou; 2 ajustes do 1º teste bem-sucedido.** O dono comprou o fluxo
até o resumo (camiseta R$120,89 com foto e prazo). Duas críticas dele, ambas certas:
1. **"Trouxe umas coisas estranhas"** — o actor publica `quantidadeVendida`,
   `numeroAvaliacoes`, `produtoReviews`, `lojaOficial` e `posicaoItem`, e a vitrine
   ordenava só por semelhança de texto: no resultado real dele, o 3º card era um
   anúncio com ZERO venda e ZERO avaliação. `rankMercadoLivre`: relevância manda
   primeiro (pedido específico continua vencendo), depois `trustScore` (vendas e
   avaliações em log10, nota >4 como bônus, loja oficial no desempate), depois a ordem
   do próprio ML. Anúncio não-validado vai pro fim. Sinais viajam no item (`mlTrust`,
   `mlPosition`), então sobrevivem ao cache.
2. **"Por que pede CEP e depois endereço?"** — os DOIS são necessários (CEP decide
   cobertura/frete; número+complemento é o que o entregador usa), mas cabiam numa
   pergunta só: `askNewCep`/`askCepAgain` agora pedem "endereço completo com o CEP" com
   exemplo, e o parser já lia os dois juntos desde 06/08. Quando só o CEP chega, a
   pergunta seguinte explica o PORQUÊ ("pro entregador achar você") em vez de parecer
   burocracia.

**16/08 (6ª) — 1º teste real do ML: busca OK, cards descartados por WebP.** O dono ligou
a flag e pediu camiseta: a busca levou ~28s e achou 3 camisetas reais do Corinthians com
preço, link e "chega amanhã" — e NENHUM card chegou. Causa (diagnóstico do dono):
`131053 — WebP image uploads are not currently supported`. O CDN do ML serve `.webp` e a
Meta recusa; como a falha é ASSÍNCRONA (a Graph aceita e descarta depois), o try/catch
não caía no fallback de texto e a conversa ficava presa em `choosing` esperando escolha
de opções invisíveis. Dois consertos, um específico e um genérico:
1. `mlImageAsJpg`: o mesmo arquivo existe em JPG trocando a extensão — verificado ao
   vivo nas 3 URLs que falharam (206 `image/jpeg`). Mesmo padrão do Boticário, que força
   `f_jpg` no Cloudinary por causa do AVIF.
2. **Pré-flight passa a validar o CONTENT-TYPE**, não só se a URL responde
   (`META_IMAGE_TYPES` = jpeg/png). Formato recusado → card SEM foto em vez de card
   descartado. Isso protege qualquer vitrine futura, não só o ML.
**Lição de método (a mais importante):** o teste do ML usava WebP e o teste dos cards da
Meta usava JPG — cada um passava sozinho e o defeito vivia no VÃO entre eles. Agora há
teste CRUZADO ML→Meta (foto WebP derruba só a foto; os dois cards saem) e o mock do
teste antigo, que devolvia `text/plain` como se fosse imagem boa, foi corrigido.

**16/08 (5ª) — MERCADO LIVRE volta como vitrine de cauda longa (atrás de flag).**
Pergunta do dono: "o fluxo é manual, por que não uso o ML que tem tudo?". Procede — o
motivo histórico de abandonar o ML era AUTOMATIZAR o checkout (sem API de comprador,
robô = banimento); com compra manual pelo operador esse bloqueio não existe. E os 7
ciclos de teste real mostraram que as recusas recorrentes eram justamente cauda longa
(cabo USB-C, camiseta, lancheira). O dono também apontou que a entrega das lojas locais
é D+1 na maioria dos casos (só Oba é same-day de verdade), então "hoje" não era o
diferencial que eu supunha — o diferencial é a CONVERSA.
**Validação antes de codar (16/08, actor real karamelo/mercadolivre-scraper):** 22,7s
("cabo usb-c 2 metros") e 25,1s ("camiseta futebol"), 48 itens cada, ~R$0,03/busca, com
título, preço, link, foto, estoque, flag de patrocinado E o campo `envio` — que traz o
PRAZO DO ANÚNCIO ("Chegará grátis hoje Enviado pelo FULL").
Desenho (`src/lib/stores/mercadolivre.ts`): 19ª vitrine, **desligada por padrão**
(`LIA_ENABLE_MERCADOLIVRE=true` liga; `false` volta atrás sem deploy); fallback estrito
— as 18 lojas locais são consultadas primeiro e o actor só roda quando nenhuma delas
tem match forte; cache de 6h no `SearchCache` que já existia;
aviso ao cliente se a busca passar de 2,5s (`copy.searchingWider`) porque 25s de
silêncio parece travamento; prazo do anúncio no card (`choiceLine` ganhou `delivery`) —
nunca estimativa nossa; descarta patrocinado/sem preço/sem estoque; e **guarda ANVISA
aplicada** (o ML vende dipirona — sem `withoutMedicine` a Lia venderia remédio).
O review antes da ativação pegou dois desvios do primeiro commit: `Promise.all` esperava
o ML até para item local e o prazo se perdia antes dos cards interativos da Meta. Ambos
foram corrigidos e travados: aviso só começa quando o fallback realmente dispara, e o
prazo atravessa `PendingChoice` + `sendDeliveryChoices`. Testes: 6 do conector, incluindo
pipeline completo com o payload REAL do actor mockado na rede. Pinado `false` no load-env
(suíte nunca vai à rede). Suíte completa 340/340, tsc, lint e build verdes.
**Ativação em Production (16/08):** `LIA_ENABLE_MERCADOLIVRE=true` foi criada como
Sensitive somente em Production e o commit corretivo `5040813` foi publicado no deploy
`dpl_9j9Yyn2fFWoCCWEUGDb8Bax7DMxZ` (`READY`, domínio reassumido). Smoke: landing 200,
`/ops` 200, webhook 403/401 sem assinatura e zero erro novo no scan de logs. O primeiro
pedido frio no WhatsApp ainda é a prova da integração runtime com o token Sensitive.
**Pendente (gate 2, não bloqueia piloto):** política do ML sobre muitas compras da mesma
conta para endereços diferentes — irrelevante em 5–10 pedidos, a verificar antes de
escalar.

**16/08 (4ª) — 6º ciclo (10 rodadas): 7 sucessos, 3 consertos.** A régua: 15→7→6→6→4→3.
1. "Para uma viagem" vazava pelo lado da IA (o determinístico já filtrava):
   `isRequestModifier` exportado e aplicado aos itens da extração em extractLines.
2. "sem pimenta" contaminando o pão de alho: o EXEMPLO da regra 7d do prompt ensinava o
   erro ('pão de alho sem pimenta' como par). Exemplo reescrito com o escopo certo —
   negação vale só pro vizinho imediato; os demais itens ficam intactos.
3. CEP órfão: endereço com "CEP 13010-050" no fim salvava "… - SP, CEP." depois de
   remover os dígitos — a palavra "cep" solta agora sai junto na captura.
Gate focado: tsc + 40 units + E2E da sequência da rodada 8 (endereço com CEP repetido).

**16/08 (3ª) — 5º ciclo de testes (10 rodadas): 4 consertos + gate focado.** Granola→aveia,
"sem remédio"+shampoo, presente≤R$100 e 4x→7x→5x passaram; fechados:
1. "Para domingo"/"Para uma viagem" (ocasião/dia) e "barato" seco = modificadores.
2. PLURAL no merge: "cafés moídos" não casava "café moído" e o gêmeo determinístico era
   resgatado como linha duplicada — `meaningfulProductTokens` singulariza; "cada" ignorado.
3. Adição relativa na MESMA mensagem ("…30 litros; mais um desses", "leite sem lactose;
   mais dois leites"): soma na linha anterior no parser; a linha nua da IA se dobra na
   rica ANTES da herança do gêmeo (depois contaria 2x); MORE_SAME ancorado no começo da
   mensagem (não sequestra mensagem que contém lista).
4. Trocar endereço com cotação na mesa PRESERVA a cesta (restaurada de `order.items` ao
   cancelar) e re-cota sozinho após o endereço novo.
Processo: a partir daqui o gate de publicação é FOCADO (tsc + units + golden + E2E dos
fluxos tocados); `npm test` completo só em mudança de core, antes de ciclo de teste do
dono, ou a pedido — decisão do dono em 16/08 (memória persistida).

**16/08 (2ª) — 4º ciclo de testes (10 rodadas): 6 consertos.** Perfume floral, leite sem
lactose relativo, sacos 30l e a guarda de remédio passaram; fechados:
1. **"cabo usb-c de 2 metros" devolvia carregador de parede**: o catálogo NÃO tem cabo
   USB-C — a resposta certa é "não tenho". Caso golden `none` (cabo ≠ carregador) +
   regra explícita no prompt do rerank: a recíproca de "carregador aceita cabo" NÃO
   vale; sem cabo de verdade, lista vazia. Lacuna de vitrine registrada (cabos/eletro).
2. **Teto de preço sobrevivia só no caminho determinístico**: a IA remove o preço da
   query (por instrução), e o merge descartava o gêmeo determinístico que carregava o
   "até R$25" — as opções passavam do limite (card de R$29,69). O merge agora re-anexa
   o cap do gêmeo. É o conserto REAL do "teto excedido"; o filtro em si sempre existiu.
3. **Tamanho vale para TODOS os cards**: "30 litros" filtra as 3 opções (antes 1 delas
   vinha sem o atributo); mesmo `attrMatchesItem` do refinamento.
4. **"Sem remédio" no COMEÇO da frase virava remoção** (REMOVE_START começa com "sem"):
   exceção pra negação de categoria — a frase segue como pedido e o shampoo é buscado.
5. **"pensando bem" e "chega amanhã/hoje" secos** viram filler/urgência (NOISE e
   MODIFIER); o swap sintetizado não emite mais "não tenho: pensando bem".
6. **Destino com CEP embutido** ("vou entregar em São Paulo, CEP 01310-100") consome o
   CEP direto (intent cep bare) — nada de "me manda o CEP" redundante.

**16/08 — botões de quantidade: "Outra quantidade" no lugar do 3 (pedido do dono).** Os
botões da pergunta de quantidade viraram *1 unidade · 2 unidades · Outra quantidade*
(id `qty:other`); o toque abre a pergunta livre (`copy.quantityAskFree`, "de 1 a 50") e
o número digitado no chat continua valendo em qualquer momento. O perfil do WhatsApp
(nome + CNPJ visíveis no contato) NÃO é código: edita-se no WhatsApp Manager da Meta —
o dono foi orientado; o nome legal verificado pela Meta não é removível, mas
descrição/sobre são.

**15/08 (2ª) — 3º ciclo de testes (10 rodadas): 6 consertos.** Quantidades, referência
por substantivo, cartão antigo por sku e guarda de remédio passaram; sobraram:
1. **Preferência negativa vira atributo, nunca linha**: "sem pimenta", "não veicular",
   "não quero brinquedo barulhento" → o segmento vira `sem <alvo>` grudado no item
   anterior (o matcher já exclui por `negatedWords`). Prompt da extração ganhou a 7d.
2. **"até R$30 cada"**: o "cada/por unidade" não quebra mais o padrão de orçamento;
   "queria algo barato" e "sem precisar de …" viraram modificadores descartáveis.
3. **"Antes de pagar, VOU entregar em Campinas, CEP 13010-100"** (crítica recorrente):
   "vou" entrou no deliver-to; e CEP chegando com o menu de pagamento aberto agora
   DERRUBA a cotação do endereço velho e segue pro fluxo de endereço — antes qualquer
   texto que não fosse pix/cartão devolvia o menu antigo.
4. **Adição relativa herda o item**: "Pode colocar mais um leite" com leite sem lactose
   na cesta incrementa O MESMO sku (a busca genérica adicionava leite integral novo);
   "mais um saco de lixo desses" captura o substantivo composto antes do marcador.
5. **"troca X por Y" numa lista NOVA** (mesma mensagem: "quero A e B; pensando bem,
   troca B por C"): com cesta vazia, a autocorreção vale pra própria mensagem — busca
   A + C, descarta B (antes: "não achei pra tirar").
6. Lancheira fora de catálogo agora recusa LIMPO (o "sem precisar de…" era o ruído);
   lacuna de vitrine registrada. Golden inalterado; unit + E2E dos três fluxos.

**15/08 — re-teste do dono (10 rodadas): 5, 6 e 15 PASSARAM; 5 ruídos restantes fechados.**
Transcrições reais de novo como fonte. (1) "três pacotes" virava "3x pacotes indisponível":
o branch de quantidade por extenso usava `\w` (ASCII) e "três" tem acento — corrigido; e
segmento só-de-embalagem ("três pacotes", "2x pacotes") agora TRANSFERE a quantidade pra
linha anterior em vez de virar linha. (2) "qualquer time" virou genérico: `qualquer <x>`
como segmento é sempre preferência. (3) "mas entrega hoje se der": adversativas
(mas/porém/só que/com) são limpas do começo do segmento antes do filtro de modificador.
(4) Confirmação de escolha mostra a quantidade ("✅ 4x …") quando ela já é conhecida —
o estado estava certo e o texto escondia (rodadas 3, 7, 9). (5) "mais um desse CAFÉ"
mira o item da cesta pelo substantivo (não cegamente o último). Bônus de relevância com
golden primeiro: "hidratante" não perde mais para "Sabonete Líquido Hidratante" — regra
principial no scorer: substantivo de categoria DIFERENTE antes da palavra pedida no nome
= penalidade (reordena; o sabonete segue como fallback). Golden 34 casos. Registrado sem
conserto: "o mais barato possível" ordena mas não restringe (decisão de produto).

**14/08 — 15 rodadas de teste real do dono → 7 consertos de NLU/fluxo.** Relatório em
[docs/testes-whatsapp-2026-08-14.md](docs/testes-whatsapp-2026-08-14.md); diagnóstico
refinado com as transcrições reais do banco (só o lado do cliente é persistido). A causa
nº 1 não era a busca: era o RESGATE do merge IA×determinístico devolvendo fragmentos
("até uns 100 reais", "qualquer marca", "se tiver", "queria receber hoje") como itens —
daí a cesta de R$167 (rodada 6: o cliente escolheu opção para a linha fantasma sem
perceber) e os "não tenho como trazer" contraditórios (3, 7, 10, 12).
1. `MODIFIER_SEGMENT_RE` no parser determinístico: restrição nunca vira linha; ORÇAMENTO
   gruda como teto na linha anterior ("presente… até uns 100 reais" → 1 item com cap,
   filtrado pelo splitPriceCap de sempre). Prompt da extração ganhou a regra 7b.
2. "Antes de pagar, quero entregar em Belo Horizonte" (rodada 15, a mais perigosa):
   "pagar" em oração subordinada não dispara pay; "quero entregar/receber em <lugar>"
   vira change_address (que já cancela cotação aberta); "receber em casa" fica de fora.
3. "quatro caixas" por extenso já era qty no parser; o E2E agora trava o ciclo inteiro:
   qty explícita não re-pergunta, número solto em collecting AJUSTA o último item
   (copy.qtyAdjusted), e "mais três do mesmo" vira intent `add_more_same` que soma no
   SKU do último item (nunca nova busca — que podia trazer outra marca). Em estado
   cotado (fluxo legado), o ajuste RE-COTA em vez de deixar total velho no menu.
4. Esclarecimento durante a escolha ("só shampoo normal, sem preferência" enquanto
   escolhe shampoo): mesmo substantivo (`sharesProductNoun`) = REFINA a escolha atual,
   nunca abre segunda linha (rodada 5: cliente levou 2 shampoos sem perceber).
5. "sem remédio"/"não quero remédio" é negação (`stripMedicineNegation` antes de
   qualquer detecção; prompt regra 7c) — some o falso "removi o medicamento" (4, 14).
6. Mensagem de pedido mínimo mostra o RESTO da cesta ("o resto continua guardado") —
   parecia resumo completo e o cliente achava que itens tinham sumido (3, 10).
7. Fallback manual explica o porquê ao cliente (conferência de estoque/entrega) e anota
   no /ops qual loja/motivo abortou a cotação instantânea (2, 11 — o runtime log de 1h
   não sobrevivia pro diagnóstico). P3: "Pagar" → "Fechar e ver total"; endereço com
   ponto final não gera mais "SP..".
Latência de ~15s no 1º turno (rodada 1) ficou registrada sem conserto: é cold start +
2 chamadas de LLM; otimizar só se o piloto mostrar recorrência.

**11/08 (7ª) — 2ª revisão: 4 lacunas de concorrência/consistência fechadas.**
1. **Lock de turno por conversa** (colunas `turnLock`/`turnLockAt`, migration
   20260811150000, **já aplicada no banco**): duas mensagens simultâneas do mesmo
   cliente liam a mesma cesta e a última gravação de contexto apagava o item da
   primeira. Agora `handleDeliveryMessage` reivindica o lock (claim atômico via
   updateMany; TTL 60s; espera máx. 15s e entra assim mesmo — webhook nunca pendura),
   recarrega a conversa DEPOIS do lock e processa em `handleDeliveryTurn`; release só
   se o token ainda é o nosso. Dedupe fica ANTES do lock (retry sai na hora). Efeito
   colateral: `lastActivityAt` deixou de olhar `Conversation.updatedAt` (o claim do
   lock o bumparia a cada turno) — só a mensagem anterior conta como atividade.
2. **Trocar endereço por estado**: com Pix/cartão emitidos (`awaiting_payment`/
   `payment_issuing`) a troca é bloqueada com orientação de cancelar primeiro (cobrança
   não fica órfã de conversa); com pedido AINDA na fila do operador, o pedido sobrevive
   — `deliveryOrderId` atravessa o fluxo de endereço e, confirmado o novo,
   `syncAwaitingQuoteOrderAddress` atualiza cep/endereço NO pedido, anota no /ops,
   alerta o operador e devolve a conversa pra espera da cotação.
3. **Falha parcial no envio da cotação**: rollback só quando o RESUMO falha (peça
   essencial), e a reescrita do contexto só quando o rollback de fato flipou o status
   (`rolled.count`) — menu/validade falhando depois do resumo apenas loga ("pix" por
   texto funciona); reverter aí desalinharia pedido (avançado por um toque) e conversa.
4. **Eco da simulação VTEX validado de verdade**: multiconjunto id→quantidade do eco
   tem que ser idêntico ao pedido (id trocado, qty errada ou item repetido → tabela) e
   `logisticsInfo` é alinhado por `itemIndex` (repetido/fora da faixa = malformado).
Testes: corrida de mensagens diferentes (Promise.all), troca de endereço nos dois
estados, falha parcial, eco malformado (live-freight 10/10).

**11/08 (5ª) — revisão de código do lote: 6 P1 + 4 P2/P3 corrigidos.** Uma revisão
independente dos 19 commits achou defeitos que a suíte verde não pegava (cada um virou
teste):
1. **Frete VTEX cobrava por 1 item.** `logisticsInfo` é POR ITEM; o código achatava todos
   os SLAs e pegava o mais barato — cesta de N itens saía com o frete de um. Agora soma o
   SLA de entrega mais barato de CADA item, exige que a resposta cubra a cesta inteira,
   trata item indisponível como `item-unavailable` (→ operador, nunca tabela) e **preço
   ausente não é frete grátis** (só `price: 0` explícito é). Prazo exibido = o do item
   mais lento.
2. **Falha de envio deixava pedido zumbi.** `opsPublishManualQuote` movia o status ANTES
   de mandar as mensagens: erro no WhatsApp deixava o cliente sem total e o operador sem
   poder recotar (o /ops só cota `awaiting_operator_quote`). Agora falha de envio faz
   ROLLBACK do status, anota o erro no /ops e propaga o erro.
3. **Pedido mínimo da loja não valia no concierge** (a checagem vivia só no ramo legado,
   depois do return): cesta abaixo do mínimo era cotada, cobrada e recusada no checkout
   da loja. `conciergeStoresBelowMinimum` roda antes de criar o pedido (linha concierge
   não tem loja real → sem mínimo, senão herdaria o do default).
4. **Botão "Trocar endereço" não trocava**: em `awaiting_quote_confirmation` o bloco de
   pagamento capturava tudo e devolvia o menu — dava pra pagar cotação amarrada ao
   endereço velho. O `change_address` subiu para antes dos estados de espera e derruba a
   cotação aberta (o frete era do outro endereço).
5. **Escritas ler-depois-escrever por id**: cancelamento automático e publicação podiam
   se sobrescrever. Ambos agora são `updateMany` com o status no WHERE; quem perde a
   corrida não mexe no contexto da conversa.
6. **Dedupe de webhook não era atômico** (findFirst→create): duas entregas simultâneas do
   mesmo sid passavam juntas. Agora há índice ÚNICO PARCIAL
   (`Message_inbound_provider_id_key`, migration 20260811120000) sobre
   (conversationId, metadata) **WHERE sender = 'user'** e o P2002 decide. Parcial porque
   `metadata` de mensagens do ASSISTENTE guarda JSON de opções do fluxo legado, que se
   repete legitimamente (2 grupos assim existem em produção) — índice global exigiria
   apagar mensagens reais. **Índice já aplicado no banco.**
7. **TTL media o relógio errado**: `Conversation.updatedAt` só muda quando o contexto é
   gravado, então quem só perguntava ("já saiu o total?") era expirado no meio de uma
   conversa viva. `lastActivityAt` usa a última MENSAGEM (ou o updatedAt, o que for mais
   recente); vale para o TTL de cesta e o de cotação.
8. **"troca X por Y" só olhava o Carrefour** no concierge (`orderStore` cai no default
   quando a chave é "concierge"): agora usa `gatherCrossStoreCandidates` + diversidade +
   piso, como o pedido normal, e a opção carrega a loja dela.
9. **Refino apagava o histórico de paginação** (`shownSkus` era substituído) e "outras"
   repetia cards; agora acumula.
10. `tail-messages` ordenava ASC com `take: 60` — mostrava as 60 mais ANTIGAS, escondendo
    justo o erro recente. Agora é DESC + reverse (tail de verdade).
Efeito colateral saudável nos testes: com o mínimo valendo, fechar 1 refrigerante do
Carrefour (mínimo R$30, loja pinada no registro de teste) passou a ser barrado — os evals
que fechavam cesta agora usam quantidade que passa do mínimo, e há caso novo cobrindo os
dois lados.

**Bug MAIOR achado ao consertar o nº 6 — conversa duplicada divide a cesta.** O teste de
dedupe passava sozinho e falhava na suíte cheia (sob carga). Causa: `getOrCreateConvo`
fazia ler-depois-criar, então duas mensagens simultâneas do MESMO número abriam DUAS
conversas ativas — cada uma com seu contexto (cesta dividida, item sumindo) e com o
dedupe, que é por conversa, sem colidir. O banco confirmou o estrago: um número com **86
conversas ativas**. Conserto na raiz e sem tocar em dados: a criação virou `upsert` com id
DETERMINÍSTICO (`conv_<userId>`) — upsert por PK é atômico, então as duas chamadas
convergem para a mesma conversa. Conversa nunca é desativada no produto (o único
`status: "inactive"` é de cartão salvo), então reaproveitar o id é seguro. O teste trava a
raiz (1 conversa ativa), não só o sintoma. **Descartada** a alternativa de índice único
global por `metadata`: os ids de teste (`dup_1`) se repetem entre usuários diferentes nos
evals, e um índice global quebraria a suíte além de exigir apagar linhas reais.

**11/08 (4ª) — teste real do dono pegou 2 bugs + 1 pedido de UX.** (1) **"Escolher esse"
confirmava OUTRO produto**: o id do botão era a POSIÇÃO ("1"/"2"/"3"); depois de "Outras
opções" a lista trocava por baixo e o toque num card antigo escolhia a posição equivalente
da lista nova. Agora o id carrega o SKU (`optsku:<sku>`), `PendingChoice.shownOptions`
guarda tudo que já foi mostrado, e o toque em QUALQUER card do histórico escolhe
exatamente o produto daquele card (`confirmChosenOption` unifica número digitado, "mais
barata", nome e toque; a loja é a do produto escolhido, não a da opção 1). Sku fora do
histórico (card de outro item) → reapresenta a escolha, nunca chuta. (2) **"Outras" veio
com 1 opção só**: o preenchimento até 3 se perdia quando o filtro de variantes esvaziava —
agora completa do pool (pool mais fundo: 12/loja) e o eval trava 3. (3) Resumo da cotação
ganhou o botão **"Trocar endereço"** (`trocar_endereco`; corpo ≤1024 chars, senão texto com
a dica escrita de sempre). Testes: E2E do card antigo por sku, eval de 3-de-verdade,
botões no adapter, intents dos ids de máquina.

**11/08 (3ª) — FIM DA LINHA LIVRE no fluxo do cliente (decisão do dono: "pede → preço →
acabou; se não tem, fala que não tem").** O "Recebi seu pedido, vou cotar" deixou de
existir no caminho normal. Regra nova: item sem preço nas 18 lojas é RECUSADO com
honestidade na mesma resposta (`copy.itemsNotAvailable`, com convite a tentar outra
marca/versão) e NUNCA entra na cesta; fechar a lista com escolha aberta pede pra
confirmar o item (`finishChoiceFirst`) em vez de dobrar em linha livre. Consequência:
toda cesta é 100% precificada e TODO fechamento sai com total na hora. O caminho manual
(`awaiting_operator_quote`) vira fallback técnico (falha de frete/kill-switch
`LIA_INSTANT_QUOTE=false`), cercado pelo alerta ao operador e pela expiração de 1h.
`foldPendingIntoBasket`, `conciergeItemsNoted` e `conciergeSourcingNote` foram removidos;
adicionar item DURANTE uma cotação manual (só no fallback) continua dobrando no pedido.
Testes flipados para a regra nova em manual-concierge (helper `manualQuoteOrder` exercita
o fallback com `LIA_INSTANT_QUOTE=false`). A largura agora É a vitrine (17 mil itens):
lacuna de catálogo virou "não tenho" — ampliar catálogo é a resposta, não promessa de
cotação. Bônus da rodagem viva: o seed do Imigrantes tinha 151 palavras com encoding
corrompido ("�gua", "A��car") — corrigidas por dicionário; isso destravou 30 águas
invisíveis e expôs que "Sem A��car" ESCAPAVA da penalidade de variante (a Coca sem
açúcar vencia a original). "tonica"/"micelar"/"termal" entraram em PROCESSED_VARIANTS
(água tônica/micelar/termal não é água de beber — caso golden da água cobrou). Placar
golden mantido: 32/33 DET · 33/33 IA.

**11/08 (2ª) — botão Cancelar sempre visível + cotação abandonada expira sozinha.** Duas
regras do dono na sequência do zumbi: (1) "sempre tem que vir um botão cancelar" — o menu
de pagamento ganhou o 3º botão *Cancelar* e TODA mensagem de espera de cotação
(`operatorQuoteRequested`/`StillWorking`/`addedToPendingQuote`) sai como interativo com
botão *Cancelar pedido* (`sendCancelableNotice`; o toque volta como o texto "cancelar" e
cai no cancel contextual que já existia; fora do Meta, texto puro). (2) "sumiu por 1h =
não quer mais" — `LIA_QUOTE_ABANDON_TTL_MS` (60 min): cliente que volta depois de 1h+ com
pedido parado em `awaiting_operator_quote`/`awaiting_supplier_validation`/
`awaiting_quote_confirmation` tem o pedido não-pago cancelado sozinho (nota "⏰ Cancelado
automático" no /ops), a conversa recomeça do zero (endereço preservado,
`copy.staleQuoteRestart` avisa que nada foi cobrado) e a mensagem nova é processada
normalmente — a camiseta nunca mais cai dentro do pedido de sábado. Pedido PAGO nunca é
tocado; `awaiting_payment` fica de fora de propósito (o cliente pode estar pagando o Pix
naquele momento; cotação vencida já bloqueia pagamento velho). Complementa o TTL de
carrinho de 30 min que já existia (aquele só cobria cesta em montagem, não pedido criado).
Testes: E2E de abandono (viagem no tempo via SQL no `updatedAt`) + botões no adapter.

**11/08 — pedido zumbi + alerta ao operador + card sem foto (bug real de produção).**
"Quero uma camiseta de futebol" respondeu "anotei e já incluí na cotação" — o dono achou
que era a busca; era um pedido REAL de sábado preso 2 dias em `awaiting_operator_quote`
(nasceu 26 min ANTES do deploy da cotação instantânea, e a camiseta caiu dentro dele como
linha livre, por desenho de 07/08). Diagnóstico via `tail-messages` + banco. Causa raiz
sistêmica: NADA avisava o operador de que havia trabalho no /ops — cotação manual era "em
instantes" que nunca chega. Fechado: `notifyOperator` (env `LIA_OPERATOR_PHONE`; sem env =
silêncio; best-effort, nunca afeta o cliente) dispara no WhatsApp do operador em 3
momentos: pedido caiu pra cotação manual, cliente adicionou item durante a cotação, e
pedido PAGO (o mais urgente). Setar a env na Vercel + redeploy pra valer. No mesmo
mergulho: o card da ração de sábado foi descartado pela Meta por **foto 404 no CDN**
(erro assíncrono 131053 — classe nova, não é o encoding de 07/08); `sendMetaDeliveryChoices`
agora faz pré-flight da imagem (Range 1 byte, timeout `LIA_MEDIA_PREFLIGHT_TIMEOUT_MS`
1500ms; só 4xx definitivo derruba) e manda o card SEM foto em vez de perdê-lo — produto,
preço e botões sobrevivem. Desbloqueio do pedido preso: o próprio cliente manda "cancelar"
(cancela `awaiting_operator_quote` sem cobrança). Testes: alerta E2E em
manual-concierge, card sem header em whatsapp-adapter.

**10/08 (2ª rodada) — botão "Outras opções" + paginação cross-store.** Pedido do dono: quem
não gosta de NENHUMA das 3 opções precisa de uma saída visível. O último card de produto no
canal Meta ganhou um segundo botão **"Outras opções"** (id de máquina `opt:outras`, que volta
como texto e cai no MESMO ramo do "mostra outras" digitado); o fallback numerado anuncia o
atalho no `choicesAsk` ("*outras* que eu mostro mais") e `wantsMoreOptions` aceita "outras"
seco, "mostrar mais" e o id do botão. Toque atrasado fora da escolha vira `reject` educado
(nunca busca de produto). Por baixo, dois consertos na paginação: `choiceCandidates` agora
busca em TODAS as vitrines no concierge (paginava só a loja da opção 1, escondendo as
outras; cada opção carrega a própria loja) com pool mais fundo (40, 8/loja), e tanto a
paginação quanto o refinamento passam pelo `diversifyOptions` — "outras" nunca devolve
variante do que o cliente acabou de dispensar (só se não sobrar nada distinto). Pool
esgotado continua honesto (`noMoreOptions`). Testes: intents (botão/atalhos), adapter
(2 botões no último card), E2E de paginação por botão.
A vistoria de rodagem completa (talk-lia) no mesmo dia pegou o buraco que a suíte não via:
a paginação nunca teve piso de relevância — "outras" de "carregador de celular" devolvia
Sérum Nivea "Cellular" e chip de operadora (score>0 por token solto; o pool cross-store
escancarou). `choiceCandidates` agora aplica `conciergeMatchIsStrong` na paginação e no
refino. Limitação assumida: o rerank de IA não roda na paginação (resposta na hora), então
o piso léxico é estrito — "outras" de "carregador de celular" pode dizer "essas são todas"
mesmo havendo veicular/cabo no catálogo (o refinamento cobre); regressão E2E do sérum em
tests/conversation.eval.test.ts.

**09/08 — cotação instantânea (decisão do dono: cliente não espera no chat).** Cesta 100%
de vitrine fecha com o total NA HORA: `tryPublishInstantQuote` calcula o subtotal da vitrine
(custo real; o markup entra no publish, como na cotação manual) + **frete por loja** e
auto-chama `opsPublishManualQuote` em modo `retailer_delivery`, reutilizando por inteiro a
máquina de cotação/pagamento existente. **A entrega é pelo SITE do varejista** (correção do
dono: "não é via Uber, é via site" — o operador compra no site e a loja entrega; "2 lojas =
2 fretes" = dois checkouts), então o frete certo é a POLÍTICA DO SITE de cada loja:
`LIA_STORE_FREIGHT_<LOJA>` + limiar de frete grátis `LIA_STORE_FREE_ABOVE_<LOJA>` (comparado
ao subtotal de CUSTO daquela loja, como o carrinho do site vê); sem política, tarifa padrão
`LIA_FREIGHT_DEFAULT` (18) com marca "(tarifa padrão)" na nota do /ops. Sem km, sem courier
nessa conta — o desenho base+km/Uber foi descartado no mesmo dia, antes de ir ao ar como
preço. Linha livre mantém o fluxo manual (não se cobra o que não tem preço); kill-switch
`LIA_INSTANT_QUOTE=false`. A autoridade de preço do operador passa a valer só para linha
livre; para vitrine, o preço raspado (com markup como colchão) é o cobrado — defasagem acima
da margem segue a política de pós-venda (avisar + estornar diferença). Módulo
`src/lib/instant-quote.ts` (puro/testável). Testes em `tests/instant-quote.test.ts` (4) +
3 E2E no `tests/manual-concierge.test.ts`. Calibração dos valores por loja = ação do dono.

**07/08 (3ª rodada) — cards de opção descartados pela Meta sem erro visível.** Teste real:
header "Achei essas opções de cotonete:" saiu e nenhum card chegou. Runtime logs: webhook
200, zero exceção → a Graph API aceitou os cards e o WhatsApp os descartou DEPOIS (falha
assíncrona). Dois buracos fechados: (1) `safeMediaLink` (adapters/whatsapp.ts) percent-encoda
URLs de imagem com byte não-ASCII — caso real: `…cotonetes®-150…` da Pague Menos; o fetcher
da Meta rejeita o que o curl aceita — aplicado nos 3 envios de mídia Meta (card interativo,
mensagem de imagem, sendMedia); (2) o webhook LOGA todo `status: failed` da Meta
(`[whatsapp:meta:status-failed]`, com code/title/details) antes do ACK — era ACKado e
descartado em silêncio, o que tornava esse tipo de falha indiagnosticável. Lição de método:
teste com adapter mockado NÃO cobre a entrega real da Meta; validação de card exige teste
real + leitura do runtime log. Unit de `safeMediaLink` em tests/whatsapp-adapter.test.ts.

**07/08 (2ª rodada) — emoji literal RESOLVIDO na raiz + linha livre passou a contar que buscou.**
O `🙂` que aparecia no WhatsApp era **bug do minificador SWC do Next 14**: ao fundir
`[template, "", 'string'].join("\n")` num template literal único, ele emitia o emoji com barra
dupla (`\\uD83D\\uDE42`) — texto literal pro cliente. Por isso o 📝 da MESMA mensagem
renderizava e o 🙂 final não, e nenhuma versão do fonte tinha o problema. 5 emojis de copy
estavam corrompidos no bundle (💚×4, 💳, 📍×2, 🙂×2, 🛵). Conserto na raiz:
`experimental.serverMinification: false` no `next.config.mjs` (minificar servidor não paga
nada aqui) + guarda `scripts/check-bundle-emoji.mjs` no `npm run build` que FALHA o build se
um surrogate com barra dupla voltar ao bundle. Junto: o caso real "adaptador hdmi pra usb"
(nenhuma das 18 lojas tem) mostrou que a linha livre parecia "anotou sem procurar" — a copy
`conciergeItemsNoted` agora diz que PROCUROU nas lojas parceiras e que o operador cota por
fora. Guarda do teste breadth mantida (a frase de recusa legada continua proibida).

**Três bugs de onboarding achados ao validar a busca numa conversa real (mesmos consertados).**
Eles produziam exatamente o sintoma que motivou o trabalho — busca devolvendo lixo — só que a
origem era o endereço, não o matcher:

1. **Endereço + CEP na mesma mensagem** ("Av. Paulista 1000, apto 5, Bela Vista, São Paulo,
   01310-100" — o jeito mais natural de responder) era interceptado pelo ramo de CEP, que
   tratava o resto como ITENS: a Lia respondia "Já anotei: 1x apto 5" e pedia o endereço de
   novo. Agora `looksLikeDeliveryAddress` decide, e o endereço salvo vem do texto **cru** (com
   acento, maiúscula e vírgula) — o normalizado ia pro motoboy como "av paulista 1000 apto 5".
2. **Endereço como primeira mensagem** (cliente que não diz "oi") virava lista de compras pelo
   mesmo motivo; agora é salvo.
3. **Pedido feito enquanto a Lia espera o endereço** era descartado em silêncio; agora fica
   guardado em `pendingRequest` e roda assim que o endereço chega.

Regressões em `tests/manual-concierge.test.ts` (3 testes novos).

### Atualização 03/08/2026 — vitrine híbrida (o cliente passa a ver produto)

Até aqui o concierge só ANOTAVA o pedido: os 17,4 mil itens existiam mas nunca chegavam ao
cliente (a "vitrine híbrida" era proposta desde 24/07). Agora `handleConciergeRequest` busca
nas 18 lojas via `buildChoices` (sem travar loja — o operador compra onde precisar, então a
cesta pode ser mista) e mostra até 3 opções com foto e botão. Item sem match continua virando
linha livre: a largura é o moat e nada é recusado.

Três regras sustentam a qualidade — todas viraram teste:

1. **Piso de relevância do concierge** (`conciergeMatchIsStrong`, em `stores/types.ts`). O piso
   legado (`scoreCatalogMatch > 0`) é permissivo porque lá não havia alternativa ao catálogo.
   No concierge há: a linha livre. Então sugerir errado é PIOR que não sugerir. Caso real que
   motivou: "conserto de torneira" casava com **"Espumante Argentino Concerto Brut"** (o fuzzy
   trata conserto≈concerto) e o cliente recebia vinho. A regra é COBERTURA da consulta, não
   score: consulta de 1–2 palavras exige cobertura total; consulta longa tolera 1 palavra sem
   correspondência; token de tamanho ("2kg") nunca conta. Opção reprovada faz a linha voltar a
   ser livre. Coberto por `tests/concierge-match-floor.test.ts`.
2. **Escolher NÃO fecha a lista.** No legado, acabar as escolhas ia direto pra cotação porque
   escolher era o último passo. No concierge o cliente ainda soma itens e só fecha com
   "só isso" — `advancePending` ganhou o ramo concierge.
3. **Fechar com escolha pendente não descarta o item** (`foldPendingIntoBasket`). Antes, dizer
   "só isso" no meio das opções perdia o item silenciosamente; agora ele vira linha livre.

Regressões 2 e 3 cobertas em `tests/manual-concierge.test.ts`. Suíte: 220 testes, 219 verdes
(1 flake de conexão do Postgres sob carga, que passa isolado em 45s), `tsc`, lint e build limpos.

### Atualização 03/08/2026 — Browserbase removido; catálogo com rotina mensal

Por decisão do dono, **o Browserbase saiu do produto inteiro** ("não precisa disso, não estamos
fazendo assim"). Todo o navegador remoto era suporte ao caminho automatizado, que já estava
atrás de `manualConciergeEnabled()` e desligado por `PURCHASE_AUTOMATION_ENABLED=false` — ou
seja, código morto em todos os ambientes. Não reintroduzir sem mudança explícita de produto.

**Removido:** busca ao vivo (`browserbase-live-search.ts`), os 3 compradores automatizados
(`purchasing/stores/`), o lease de Context, `purchasing/` inteiro, `workflows/purchase-order.ts`,
as rotas `/api/ops/internal-preflight` e `/api/ops/live-retailer-session`, o cron
`/api/cron/prewarm-search` (só existia para aquecer o cache do robô) e o `vercel.json` que o
agendava. No `/ops` saíram os botões de preflight/sessão viva e os cards de PurchaseJob. No
cérebro saíram `beginRetailerQuote`, `publishValidatedRetailerQuote`, `issueDeferredOrderPayment`
e a guarda `usesRetailerCheckoutQuote`. As dependências `@browserbasehq/sdk` e `playwright-core`
saíram do `package.json` (`workflow` fica: é do One-Click de cartão).

**Preservado de propósito:** `issueValidatedRetailerQuotePayment` e
`setQuoteConversationAwaitingPayment` — o concierge manual reusa os dois para cobrar depois que
o operador publica a cotação. O modelo `PurchaseJob` continua no schema (nenhuma migration), só
não é mais alimentado.

**Oba deixou de ser exceção.** Ela dependia de busca ao vivo e tinha só 2 itens de seed. A API
pública VTEX dela responde direto (206 + JSON) — o navegador nunca foi necessário ali. Colhida:
**1.494 itens reais**. Petz e Boticário passam a servir o catálogo colhido (anti-bot impede
recolheita automática; seguem em colheita manual).

**Rotina mensal de preço** (`npm run catalog:refresh`, `scripts/refresh-catalogs.mts`): recolhe
as 10 lojas com API/SSR aberta, compara preço a preço com o catálogo atual e resume quantos
mudaram, a variação média e as maiores mexidas. `--dry` simula sem tocar em arquivo. Colheita
vazia **preserva** o catálogo anterior (vazio quase sempre é bloqueio, não loja sem produto).
As farmácias carregam allowlist + deny-regex dentro do script. Primeira execução já mostrou o
valor: o Divvino teve **320 preços diferentes em um dia** (+31,8% médio — a colheita de 02/08
pegou uma promoção que acabou).

Verificação: suíte **210/210 verde** (os 14 a menos são os testes do Browserbase removidos),
`tsc`, lint e build limpos.

**Publicado em 03/08:** push da `main` (27 commits) → deploy `dpl_BKzUbC4brKprMqrdMYJQ7QDnt5Kr`
(commit `cf131f5`) `READY` em Production. Smoke: landing 200, `/ops` 200, webhook 403 e as
rotas removidas do Browserbase respondendo 404. Produção e código local estão idênticos;
não há mais gate técnico para o piloto.

### Atualização 02/08/2026 — 7 vitrines novas (18 lojas, 17.264 itens)

Por decisão do dono ("adiciona todos esses"), as lacunas de demanda mapeadas contra os dados
de e-commerce/delivery BR foram fechadas. A vitrine saiu de **7.652 itens em 11 lojas** para
**17.264 itens em 18 lojas**. Todos os dados são reais (nome/preço/URL/imagem verbatim) e cada
CDN foi testado como hotlinkável antes de registrar a loja.

| Loja | Lacuna | Itens | Método |
|---|---|---|---|
| Drogaria São Paulo | farmácia s/ remédio | 4.682 | API VTEX + allowlist + deny-regex |
| Pague Menos | farmácia s/ remédio | 1.551 | API VTEX + allowlist + deny-regex |
| Natural da Terra | hortifruti/empório | 1.000 | API VTEX |
| Cobasi | pet (redundância da Petz) | 998 | API VTEX |
| Divvino | adega/vinho | 998 | API VTEX |
| Imigrantes Bebidas | cerveja/destilado | 406 | SSR (coletor próprio, sem Chrome) |
| Giuliana Flores | flores/presente | 204 | DOM renderizado (loja client-rendered) |

- **Regra ANVISA nas farmácias virou TRIPLA guarda — e a terceira foi necessária.** A colheita
  usa allowlist de categorias seguras **e** um deny-regex. Mas a auditoria profunda encontrou
  medicamento registrado que passou pelas duas, porque **a própria loja classifica medicamento
  dentro de categorias cosméticas**: esmalte antifúngico com ciclopirox, shampoo com cetoconazol,
  gel Rozex com metronidazol, "Dermodex Tratamento 100.000 U.I./g" e gel Zella. Por isso a
  terceira guarda mora em `src/lib/stores/anvisa.ts` e roda **em runtime no conector**
  (`withoutMedicine`), não no script: assim uma recolheita futura não reintroduz remédio por
  esquecimento de flag. Ela filtra princípio ativo, marca de medicamento, notação de dosagem
  (`mg/g`, `U.I./g`) e alegação terapêutica; removeu 18 itens (7 Drogaria SP, 11 Pague Menos).
  `tests/anvisa-pharmacy.test.ts` trava a regra nos dois sentidos: nenhum medicamento passa e a
  vitrine não pode ser esvaziada por um regex ganancioso. **Não afrouxar sem evidência de que o
  item não é medicamento registrado.** Sem a allowlist, a varredura por mais-vendidos de uma
  farmácia volta ~80% medicamento (o teste inicial trouxe Mounjaro e dipirona no topo).
- **A mesma auditoria pegou o lado pet, que ninguém tinha revisado.** A Cobasi veio com 65
  medicamentos veterinários e antipulgas (Simparic, Bravecto, NexGard, Apoquel, Drontal,
  Seresto) e 56 dietas de prescrição; a **Petz**, cujo seed era tido como "sem remédio/antipulga"
  desde 2026-06, tinha 58 itens da linha "Nutrição Clínica" (dieta terapêutica com receita).
  `withoutVeterinaryMedicine` (mesmo módulo) agora filtra as duas vitrines — e também os
  resultados da **busca ao vivo** da Petz, que não passa por curadoria humana. Removidos: 122
  na Cobasi e 87 na Petz. Antiparasitário e medicamento veterinário são regulados (MAPA) e
  dieta terapêutica exige receita; se um cliente pedir, o operador cota à mão com a receita.
- **Total após as guardas: 17.264 itens** (227 removidos por segurança do bruto colhido).
- **Roteamento:** `DRINK_HINT_RE` e `FLOWER_HINT_RE` foram somados às dicas de vocação. Sem
  elas, "vinho" e "buquê" empatavam com o Carrefour — o mesmo bug que "ração" tinha em 23/07.
  Conferido: vinho/cerveja → Divvino, buquê → Giuliana, ração → Petz, perfume → Boticário.
- **Leroy Merlin ficou de fora**, apesar de constar da lista: bloqueia fetch server-side (403)
  e, no navegador, a listagem não expõe imagem — a URL do CDN só aparece no `og:image` de cada
  página de produto, exigindo uma visita por item. Os 40 produtos reais colhidos na validação
  não foram persistidos. Reabrir só se alguém aceitar o custo de uma visita por produto; a
  restrição documentada de aceitar apenas itens "vendido e entregue por Leroy Merlin" continua
  valendo.
- **Decathlon segue servindo 4 de 17 itens**: o filtro `catalogWithImages` corta os 13 sem foto.
  É um bug conhecido de vitrine, não de dados.
- `scripts/harvest-vtex-catalog.mts` ganhou `--categories` e `--deny`; o novo
  `scripts/harvest-imigrantes-catalog.mts` cobre lojas SSR não-VTEX. O
  [README das vitrines](src/lib/stores/README.md) documenta os quatro métodos de colheita
  (VTEX / SSR / navegador / seed) e o requisito de imagem.

## O produto

A Lia é uma concierge de compras pelo WhatsApp. O cliente descreve o que quer, a Lia busca
produtos reais, monta uma sacola no varejista, calcula preço/frete/prazo, cobra por Pix ou
cartão, revalida e compra sob política controlada. Pix e o fallback de cartão usam Mercado
Pago; o cartão de recompra nativo no WhatsApp usa Pagar.me + Cloud API direta da Meta.

O fluxo principal vigente é **entrega feita pelo próprio varejista ao cliente**.

“Entrega hoje” só pode ser prometida quando:

- o próprio varejista oferecer same-day no checkout; ou
- existir parceiro/merchant que autorize formalmente retirada por courier.

## Decisão que não pode ser esquecida

A premissa antiga abaixo foi invalidada em 14/07/2026:

> comprar numa conta central por clique-e-retire e mandar qualquer motoboy buscar.

Por quê:

- Petz exige, na retirada por terceiro, documento de quem retira e documento original do
  titular, além de aguardar liberação do pedido;
- Carrefour não alimentar exige documentos do terceiro/titular, token e pode usar
  biometria;
- Carrefour alimentar exige autorização assinada e documentos do terceiro/titular;
- Uber Direct funcionar tecnicamente não autoriza o balcão a liberar uma compra de
  consumidor e o uso para varejista terceiro precisa de validação comercial.

Consequência: Uber Direct permanece como conector opcional para parceiros compatíveis, não
como fulfillment padrão. Não enviar documentos pessoais a entregadores on-demand.

Fontes e detalhes:
[docs/decisoes-operacionais-2026-07-14.md](docs/decisoes-operacionais-2026-07-14.md).

## Fluxo do cliente vigente (05/08) — resumo canônico

Primeira compra: onboarding endereço+CEP (1x) → pedido em linguagem natural → vitrine
híbrida (card com foto para match; linha livre para o resto; escolher NÃO fecha a lista) →
"só isso" → cotação manual no /ops → resumo com Pix (copia-e-cola) ou cartão (1ª vez: link
/cartao, digita UMA vez e salva tokenizado). Recompra no cartão: botão "Pagar •••• 1234",
um toque, sem CVV. Desvios: recusa → Checkout Pro; "outro cartão" → re-cadastro; toque
duplo → cobra 1x; fechar com escolha pendente → vira linha livre. Pós-pago: sem
cancelamento/substituição; item faltante = estorno do item; atraso = aviso. Cartão salvo
validado no sandbox real em 05/08; produção atrás de LIA_ENABLE_SAVED_CARD até habilitação
comercial + smoke de R$ 1. A seção "Fluxo-alvo" abaixo é o desenho legado da automação.

## Fluxo-alvo vigente

1. Cliente informa itens e endereço no WhatsApp.
2. Lia busca opções reais e resolve ambiguidades.
3. Lia monta uma sacola temporária antes de cobrar.
4. O checkout do varejista determina estoque, preço, frete, modalidade e prazo para o CEP.
5. Lia mostra a cotação com validade curta.
6. Cliente paga a Lia por Pix, Checkout Pro ou, quando habilitado, One-Click nativo no
   WhatsApp com Pagar.me.
7. Lia revalida itens, total, endereço e prazo.
8. Compra segue em `cart_only`/aprovação explícita durante a operação.
9. Varejista entrega; Lia acompanha e comunica o cliente.

O comportamento legado que cobra primeiro e só monta a sacola depois deve ser invertido.

## Canais ativos a partir de 19/07/2026

O produto ativo tem exatamente três fontes: **Oba Hortifruti** para mercado e essenciais,
**Petz** para pet e **O Boticário** para beleza. Carrefour foi removido do registro, roteamento,
cron de busca, comprador e telas operacionais; permanece apenas como histórico de uma decisão e
não deve ser reativado por fallback. Mambo foi avaliado tecnicamente, mas não integra o produto.

- **Oba:** conector Browserbase implementado em `cart_only`, implantado em Production e validado
  ao vivo em 19/07. Usa SKU/vendedor reais, limpa a sacola isolada, simula entrega pelo CEP e
  exige estoque, frete e prazo antes de cotar. O job técnico obteve arroz Camil 1 kg por R$ 5,99,
  frete R$ 9,90 e janela do varejista, totalizando R$ 15,89, no CEP público `01310-100`, e chegou
  a `cart_ready`. A chave Browserbase renovada e o `OBA_BROWSER_CONTEXT_ID` estão Sensitive em
  Production, sem segredo em arquivos. O primeiro retry revelou o fechamento prematuro da página
  (`PURCHASE_WORKER_ERROR`); a correção para aguardar o snapshot foi publicada no deploy
  `dpl_CpcjWKyHrteDuiQQ2DU9NZbj5Pwz`, que ficou `Ready`. A migration de defaults Oba também foi
  aplicada e conferida no banco. Não houve WhatsApp, cobrança ou pedido.
- **Petz:** o comprador agora exige subtotal, frete e promessa de entrega, falhando fechado se
  algum campo não aparecer. A navegação de carrinho/checkout havia sido validada ao vivo, mas a
  orquestração pré-cobrança atual precisa de preflight técnico. Em 19/07, o job técnico encontrou
  SKU, preço e subtotal reais, mas o Context não expôs frete/prazo mesmo após abrir a sacola
  completa; terminou corretamente em `needs_human`, sem cobrança ou compra. No retry posterior,
  a limpeza do carrinho revelou um redesenho transitório da sacola que invalida o seletor de
  remoção; o conector foi endurecido para reler o controle. O retry alcançou a rota real de
  sacola completa `/checkout/cart/<id>` e confirmou novamente SKU/preço, mas não expôs os campos
  de frete/prazo no Context. Continua em `needs_human` e requer diagnóstico da etapa de entrega.
- **Boticário:** o comprador agora também lê frete e prazo, além de SKU/quantidade e subtotal.
  Em 19/07, o job técnico confirmou SKU/quantidade/subtotal reais, mas a loja exibiu somente o
  convite para consultar frete. O conector passou a priorizar esse painel e falhou fechado quando
  o varejista não expôs a confirmação de CEP. Um link “Entrega Rápida” foi testado e leva apenas
  a uma página informativa, não ao cálculo; não deve ser usado como etapa da cotação. Falta
  resolver o gate real de CEP e validar ao vivo. No diagnóstico final, a própria sacola expôs o
  campo `postalCode`, mas com `data-disabled=true`; não forçar esse controle. A cotação fica
  bloqueada até o varejista/Context habilitar o cálculo de entrega.
- Em 20/07, novos pedidos técnicos isolados (não reaproveitados) confirmaram novamente: Petz
  resolve SKU/preço/subtotal, mas a rota `/checkout/cart/<id>` não expõe entrega; Boticário
  resolve SKU/preço/subtotal, mas não fornece prazo domiciliar. Um falso positivo anterior de
  promoção “frete grátis”/retirada foi removido do parser e coberto por teste. Nenhuma cobrança,
  mensagem ao cliente ou compra foi feita.
- Ainda em 20/07, o `/ops` passou a abrir uma sessão Browserbase viva e isolada para Petz ou
  Boticário, usando somente o Context persistente de cada loja. A sessão Petz foi aberta para o
  operador selecionar **entrega no endereço** diretamente na UI do varejista; ela não cria
  sacola, não envia mensagem, não coleta pagamento e não compra. A validação do frete/prazo só
  deve ser repetida depois dessa seleção manual do varejista. O acionamento abre antes a página
  inicial da loja (o debugger remoto nasce em aba vazia), sem preencher ou clicar em nada, e fica
  ativo por até uma hora para o operador concluir a etapa. Em 20/07, o visualizador embutido do
  Codex não apresentou essa sessão de modo interativo de forma estável; a mesma sessão foi aberta
  no Safari do operador. Não interpretar o problema do visualizador como falha de Context ou da
  cotação.
- Depois da ação direta do operador, foi implementado no `/ops` o encerramento autenticado das
  sessões vivas do mesmo Context, para tornar login/endereço persistentes antes do novo preflight.
  O retry fresco continuou em `needs_human`: resolveu o SKU e R$ 15,99, alcançou
  `/checkout/cart/<id>`, mas não expôs controles, frete ou prazo de entrega. O conector também
  tenta apenas o CTA explicitamente chamado “ir/continuar para checkout” a partir dessa rota; a
  Petz não o expôs. Isto não comprova que o login foi salvo e não autoriza insistir em UI remota;
  nenhuma cobrança, WhatsApp ou compra ocorreu.
- Novo preflight Boticário em 20/07 confirmou novamente SKU B88468, quantidade e subtotal de
  R$ 16,90 na sacola. O campo `postalCode` permaneceu bloqueado, com convite para consultar
  frete mas sem prazo; frete grátis promocional e retirada foram corretamente descartados.
  Permanece `needs_human`, sem cobrança, WhatsApp ou compra.
- Na triagem oficial de 20/07, os próximos candidatos foram priorizados: **Pão de Açúcar** para
  mercado em São Paulo (cálculo de frete/prazo por CEP e escolha de modalidade de entrega) e
  **Cobasi** para pet (frete/prazo por CEP no carrinho e entrega própria). Savegnago fica como
  alternativa para cidades do interior paulista, não São Paulo capital. Isso é pesquisa, não
  validação Browserbase nem autorização de compra; os dois ainda precisam de Context, carrinho e
  preflight `cart_only` ao vivo.
- A validação de navegação de 20/07 eliminou Pão de Açúcar para automação neste momento: a rota
  pública de produto foi desviada para `az-request-verify` antes de produto/CEP. A **Cobasi**
  passou no smoke ao vivo anônimo com o CEP público `01310-100`: produto real entrou na sacola e
  o checkout exibiu Cobasi Já, Econômica, frete, prazo e total antes de qualquer pagamento. O
  carrinho técnico foi limpo. Isto valida a interface do varejista, não o conector, o Context
  Browserbase, termos comerciais ou uma compra.
- Na validação completa de navegação ainda em 20/07, a Cobasi avançou da sacola até o gate de
  login (sem inserir credencial, endereço pessoal, cartão ou criar pedido). A **Leroy Merlin**
  também passou no mesmo critério com SKU vendido e entregue pela própria Leroy: CEP público,
  entrega domiciliar, frete, prazo, total e, ao continuar, login antes de qualquer pagamento.
  As duas sacolas técnicas foram esvaziadas. Leroy só pode ser candidata se o conector restringir
  itens a “Vendido e entregue por Leroy Merlin”; itens de marketplace exigem validação separada.
  **Sephora** não passou: a navegação chegou a produto/CEP, mas ficou instável antes da sacola;
  não a tratar como fonte candidata. Cobasi e Leroy seguem sem conector, Context/preflight da Lia,
  validação comercial ou autorização de compra.
- A cotação dos três reserva um Context por loja, cria a sacola antes de cobrar, expira em curto
  prazo e não reconstrói a sacola depois do pagamento. A compra continua `cart_only`, com
  revalidação e aprovação do operador.

## O que foi validado de verdade

### Petz

- conta autenticada em Context persistente do Browserbase;
- endereço salvo e reconhecido pelo checkout;
- busca, produto, sacola, frete e prazo reais;
- checkout alcançado sem finalizar compra;
- formas vistas: cartão, Pix, NuPay, Click to Pay e boleto;
- modalidades vistas: padrão, expressa, agendada e retirada, variáveis por CEP/horário;
- opção de salvar cartão para compras futuras;
- botão financeiro final identificado como `Pagar agora`;
- nenhuma compra foi finalizada.

No teste noturno de 14/07/2026 em São Paulo, a menor promessa domiciliar era o dia
seguinte. Isso não é SLA: sempre cotar ao vivo.

### Busca e carrinho

- Carrefour, Petz e Boticário têm busca ao vivo com links/preços reais;
- Petz e Boticário usam cache curto de 15 minutos;
- produção falha fechada: sem URL/preço real, não mostrar opção;
- compradores Petz/Boticário montam e revalidam carrinhos em Browserbase;
- carrinhos antigos são limpos pelos conectores antes de um novo preflight;
- o job persiste o ID da sessão para revalidação, não credenciais/cartão;
- cada Context Browserbase é isolado por um lease persistente no banco: o workflow enfileira
  conflitos como `RETAILER_BUSY`, tenta novamente a cada minuto por até uma hora e nunca mistura
  carrinhos. Leases abandonados expiram em 15 minutos; falhas de banco/configuração não são
  disfarçadas como fila. A regressão é coberta em `tests/purchase-context-lease.test.ts`.

### Cotação Carrefour antes da cobrança

- **Implementado em código em 15/07:** com a automação Carrefour habilitada, a Lia cria
  a cotação pendente, monta o carrinho em `cart_only` e só mostra Pix/cartão após o
  checkout expor total, frete e promessa de entrega do varejista;
- a cotação expira em 5 minutos por padrão, exige escolha explícita de Pix/cartão depois
  do resumo e libera o Context se vencer ou for cancelada;
- o checkout falha fechado para `needs_human` se não expuser itens, total, frete ou prazo;
- migrations aplicadas e versão implantada em produção em 15/07/2026;
- em 16/07, a UI atual foi mapeada ao vivo: o modal de CEP fecha pelo botão
  `button[type=submit]` (Enter não fechou), e frete/prazo aparecem no carrinho completo,
  não no minicarrinho. Para o SKU técnico, a tela mostrou item R$ 1,99, frete a partir de
  R$ 9,90, prazo a partir de sábado e total R$ 11,89, além do mínimo de R$ 30. Isto valida
  seletores/parsers da UI, não o workflow Browserbase;
- o conector foi alterado para abrir o carrinho completo, ler rótulos/valores em linhas
  separadas, capturar `orderFormId`, limpar carrinho antigo pelo checkout e diagnosticar o
  campo faltante. TypeScript, lint, 8 testes Carrefour, a suíte de 203 testes (161 passaram,
  42 dependentes do banco foram pulados) e build passaram;
- após deploys e retries controlados, o workflow avançou por CEP ausente, regionalização,
  falso positivo de login e carrinho antigo; o bloqueio final verdadeiro é
  `LOGIN_REQUIRED` no Context persistente. Foi criada e aberta uma sessão viva para login
  humano. **A validação Browserbase de estoque, frete, prazo, cartão e 3DS continua pendente.**
  Não tratar o mapeamento da UI como evidência de cobertura ou cotação operacional.
- após a reautenticação humana em 16/07, o preflight confirmou que o login passou, mas o
  minicarrinho não expôs seu CTA para o carrinho completo (`MANUAL_ACTION_REQUIRED`). O
  conector passou a abrir somente a rota de resumo `/checkout/cart` como fallback seguro.
  A publicação inicial via artefato pré-construído revelou incompatibilidade do Prisma gerado
  no macOS com o runtime Linux ARM da Vercel; `linux-arm64-openssl-3.0.x` foi incluído nos
  `binaryTargets`, o artefato foi reconstruído e a produção ficou `Ready` em 16/07. O POST
  do preflight voltou a responder 200, mas o workflow atual falhou fechado em `LOGIN_REQUIRED`;
  uma nova sessão viva foi aberta para login humano. Nenhuma ação financeira foi executada.
- Ainda em 16/07, o painel Browserbase foi acessado com sucesso e uma sessão Carrefour nova foi
  aberta, mas a reautenticação humana não foi concluída. O operador pediu para pausar e tentar
  em outro momento. Não abrir novas sessões nem repetir o preflight até a próxima tentativa
  coordenada; o motivo da falha não foi confirmado. Nenhuma ação financeira foi executada.
- Em 19/07, depois de a configuração Browserbase de produção ser comprovada pelo avanço até
  `LOGIN_REQUIRED`, uma nova sessão viva chegou à rota de autenticação Carrefour e foi bloqueada
  pelo próprio varejista com a mensagem de que o acesso não estava em conformidade com suas
  políticas de segurança. A mesma conta funciona no navegador comum do operador. A evidência
  torna o ambiente remoto Browserbase não confiável para autenticação/checkout Carrefour no
  piloto; não tentar contornar o bloqueio com proxy, fingerprint, CAPTCHA ou repetição de sessões.
- **Decisão de 19/07:** pausar a cotação/compra Carrefour via Browserbase e removê-la do caminho
  crítico do lançamento. A busca pública pode continuar falhando fechada, mas o checkout
  automatizado Carrefour só deve voltar com API/parceria oficial ou ambiente formalmente
  autorizado pelo varejista. O primeiro piloto deve ser reposicionado para Petz, cujo carrinho,
  frete, prazo e checkout já foram validados ao vivo, depois de levar para esse conector a mesma
  orquestração de cotar antes de cobrar. Não houve WhatsApp, cobrança ou compra nessa tentativa.
- A opção de entregar links para o cliente concluir no Carrefour foi explicitamente rejeitada pelo
  operador em 19/07 e não faz parte do produto: a Lia deve concluir o pedido nos bastidores. No
  curto prazo, as alternativas restantes são operação humana invisível em navegador comum para
  testes internos/controlados ou um modelo próprio de shopper que compre na loja física; nenhum dos
  dois é automação escalável e ambos exigem desenho operacional antes de dinheiro real. No longo
  prazo, buscar parceria homologada com Carrefour ou plataforma de delivery para receber catálogo,
  cotação e criação de pedido por canal autorizado. A API pública do Marketplace Carrefour é para
  sellers gerirem ofertas/pedidos, não para a Lia comprar como consumidora. As APIs iFood públicas
  encontradas também são do lado merchant. A API VTEX permite carrinho/simulação em tese, mas o
  endpoint padrão no domínio headless Carrefour respondeu 500 e os termos atuais vedam ferramentas
  automatizadas; não prototipar contra endpoints internos sem autorização escrita. Automação em
  navegador local, extensão, proxy residencial ou troca de fingerprint não é caminho aprovado.
- **Estratégia de varejistas de 19/07:** a Lia deixa de tratar qualquer loja como garantida e passa
  a homologar conectores por gates: acesso público, catálogo/SKU real, carrinho isolado, cotação de
  estoque/frete/prazo antes do login/pagamento, persistência de sessão, entrega do varejista,
  bloqueio financeiro e autorização comercial/termos. Petz é referência técnica já validada ao
  vivo, mas ainda não equivale a autorização comercial. No teste técnico público de 19/07, Oba e
  Mambo criaram orderForms anônimos e receberam dois SKUs regionalmente disponíveis no CEP público
  `01310-100`. Ambos devolveram estoque, preços, frete e estimativa/janelas de entrega sem login:
  Oba montou uma sacola de R$ 18,98 e expôs Convencional por R$ 9,90 (`0bd`, com seis janelas) e
  Express por R$ 14,90 (`2h`, sem janela disponível no horário); Mambo montou R$ 22,78 e expôs
  Entrega Agendada por R$ 12,90 (`2h`, 19 janelas). Os dois carrinhos foram esvaziados ao fim.
  Isto valida catálogo, disponibilidade regional, carrinho e simulação pública de logística — não
  valida login, persistência, checkout financeiro, pedido, escala ou autorização comercial. Oba é
  o primeiro candidato para mercado/essenciais; Mambo é fallback regional em São Paulo e seus
  termos vinculam uma conta individual ao CPF. Savegnago permanece candidato regional. Pão de
  Açúcar respondeu `200`, porém apresentou gestão de bots. St. Marche segue depriorizado após a
  recuperação judicial informada pelo Grupo Hortus.
- **Boticário em 19/07:** a busca ao vivo e o comprador Browserbase continuam implementados. O
  comprador limpa, monta e revalida SKU/quantidade, subtotal, frete e promessa; sem estes campos,
  falha fechada. Ainda não houve preflight Browserbase ao vivo nesta rodada, portanto não está
  homologado para cotação antes da cobrança.

### Pagamentos e canal

- Mercado Pago Pix e Checkout Pro estão integrados;
- WhatsApp Meta Cloud API está ativo em produção;
- domínio de produção: `https://liadelivery.com.br`;
- confirmar situação PJ/NF do Mercado Pago antes do lançamento público;
- Pix e Checkout Pro do Mercado Pago permanecem o caminho ativo.
- O One-Click BR (Meta Cloud API direta + Pagar.me) está implementado, mas permanece
  desligado até a habilitação da Meta, chaves/domínio/webhook Pagar.me e sandbox. As
  migrations já estão aplicadas; o ticket Meta `37565409896407734` está **Open** desde
  04/08. Não depende de 360dialog. Ver
  [docs/whatsapp-one-click-pagarme.md](docs/whatsapp-one-click-pagarme.md).
- Em 16/07, Samuel Santana, da Infobip, respondeu sobre `order_details` /
  `offsite_card_pay` com Mercado Pago PJ e pediu volume, categoria das mensagens, países e
  canais para encaminhar a oportunidade. A Infobip documenta WhatsApp Payments no Brasil e
  orienta acionar gerente/suporte, portanto o contato é uma via plausível de habilitação.
  Isso ainda é somente qualificação comercial: não confirma elegibilidade, compatibilidade
  do Mercado Pago, geração de `credential_id`, custos ou preservação da WABA/número. O
  onboarding padrão da Infobip também contempla registrar/migrar o sender para a API deles;
  a resposta deve exigir explicitamente Cloud API direta, Graph API/webhook atuais e nenhum
  compartilhamento ou migração de BSP sem autorização separada.
- Em 18/07, Samuel classificou a Lia como **Self-Service** pelo volume inicial (2.000–10.000
  mensagens/mês) e encaminhou as dúvidas técnicas ao Customer Success
  (`success@infobip.com`); também ofereceu criar uma conta de teste. Isso não é aprovação
  técnica, habilitação de Payments, confirmação de compatibilidade com Mercado Pago PJ nem
  garantia de `credential_id`. Só solicitar/usar teste se ficar documentado que ele não
  migra nem compartilha WABA/número, preserva a Cloud API/Graph API e o webhook atuais, e
  se o escopo de `order_details`/`offsite_card_pay`, sandbox, webhook e custos for confirmado.
  O contato ao Customer Success foi enviado em 18/07, com Samuel em cópia; em 03/08 a Infobip
  respondeu negativamente e essa rota foi encerrada. Não criar conta de teste nem migrar sender.
- A revisão da documentação Pagar.me V5 confirmou `tokenizecard.js`, domínio liberado e
  cobrança por `card_id`. `recurrence_cycle=first|subsequent` descreve recorrência externa e
  não se aplica à recompra avulsa da Lia; o adaptador atual (`card_id` sem o campo) está
  correto. CVV/3DS, recusa e antifraude ainda precisam passar no sandbox antes de ligar a flag.

### Deploy e testes

- produção foi implantada e estava `Ready` após as mudanças de busca/carrinho;
- `npx tsc --noEmit` passou;
- testes focados de compra/busca/política passaram;
- em 15/07, os evals foram alinhados ao onboarding de endereço completo e `npm test` passou
  integralmente (201 testes). O build local de produção também passou; isso não substitui
  validação ao vivo de checkout ou piloto.
- em 16/07, a operação de entrega direta foi implementada localmente com estados explícitos
  `retailer_preparing` e `retailer_out_for_delivery`. O `/ops` agora mostra modalidade,
  promessa e rastreio do varejista, bloqueia courier externo em `retailer_delivery` e mantém
  os estados antigos apenas para parceiros formalmente autorizados. Cancelamento pago virou
  fluxo auditável `refund_pending -> refunded`: a confirmação ao cliente só ocorre depois de
  registrar a referência real do provedor. O runbook de `needs_human`/estorno está em
  `docs/operacao-piloto-needs-human-estorno.md`. TypeScript, lint, 210 testes (168 passaram,
  42 dependentes do banco foram pulados) e build passaram. Alteração ainda não implantada nem
  validada ao vivo.

## Segurança e limites financeiros

- Produção deve permanecer com `PURCHASE_AUTOMATION_MODE=cart_only` até piloto auditado.
- Nunca clicar no botão final de compra sem confirmação explícita no momento da ação.
- Nunca repetir automaticamente um clique financeiro quando o resultado for incerto.
- CAPTCHA, OTP, login, CVV e 3DS viram `needs_human`; não burlar desafios.
- O hash que protege uma aprovação deve incluir itens, total, frete e promessa de entrega;
  uma mudança em qualquer um deles invalida a aprovação anterior.
- Não guardar número de cartão ou CVV. O Pagar.me recebe os dados diretamente pelo
  `tokenizecard.js`; a Lia persiste somente IDs tokenizados, últimos quatro dígitos e o
  registro de consentimento necessários para a recompra.
- Não pedir cartão pelo chat. O usuário digita dados financeiros diretamente no checkout
  seguro do provedor/varejista.
- Um PIN de registro do WhatsApp estava salvo em um Markdown local ignorado pelo Git. O valor
  foi removido em 16/07; ele deve ser rotacionado e mantido apenas no cofre de segredos antes
  do piloto. Não registrar PINs em Markdown, chat ou logs.
- Credenciais já expostas em chats ou em diagnósticos locais devem ser rotacionadas e
  atualizadas na Vercel. Em 15/07, uma saída de diagnóstico incluiu credenciais de
  Browserbase/Vercel: tratá-las como expostas e rotacioná-las antes do piloto. O token OIDC
  local da Vercel foi renovado em 15/07 sem expor valores; ainda falta regenerar a chave
  Browserbase e atualizar os ambientes que a consomem. Em 15/07 foi aberta uma sessão
  persistente do Context Carrefour somente para reautenticação manual; não houve carrinho,
  checkout ou cobrança. Uma chave Browserbase de reposição foi colada em conversa em 15/07:
  ela também é exposta, não deve ser configurada mesmo com autorização posterior e precisa
  ser regenerada novamente. A validação da variável puxada de produção retornou
  `401 Missing x-bb-api-key`; não abrir novo preflight antes de configurar chave válida na
  Vercel e implantar. Em 15/07 a URL de Environment Variables da Vercel foi aberta no
  navegador embutido, mas exigiu login manual na conta Vercel antes da configuração. Após
  uma tentativa de salvar somente em Production, uma nova leitura de `vercel env pull`
  ainda não trouxe valor para `BROWSERBASE_API_KEY`; conferir no painel que a edição foi
  realmente salva com um valor não vazio antes de implantar. A tela de edição revelou em
  seguida um valor com prefixo `sk_live_`, que não é uma chave Browserbase (`bb_live_`):
  não implantar até substituir pelo segredo Browserbase correto e marcá-lo como Sensitive.
  Uma segunda leitura do Production após a alegada correção continuou sem a variável; o
  deploy e o preflight Carrefour permanecem bloqueados. Posteriormente, o painel confirmou
  `BROWSERBASE_API_KEY` como Sensitive, Production e "Updated just now"; um novo deploy de
  produção ficou Ready em 15/07. A confirmação de autenticação Browserbase ainda não pode
  ser feita localmente porque a variável Sensitive não é baixada pelo CLI; a sessão Carrefour
  foi reaberta para login humano antes de qualquer preflight. Em seguida, o operador informou
  que concluiu o login na tela; falta escolher o endereço salvo e o item de teste antes do
  preflight de carrinho, frete e prazo. Não houve item, checkout ou cobrança neste ciclo.
- Em 16/07, credenciais de login do Carrefour foram coladas diretamente no chat. Não
  persistir, repetir em logs/documentação, copiar para `.env` nem tratá-las como segredo
  reutilizável. A senha precisa ser rotacionada após a reautenticação controlada do Context
  e antes do piloto; o inspetor remoto não expôs campos seguros para automação, então a
  sessão viva ficou aberta para login humano.
- Em 18/07, o operador optou por não trocar a senha Carrefour neste momento. Nenhuma alteração
  de senha foi iniciada; a credencial continua tratada como exposta e bloqueia o uso do Context
  Carrefour e qualquer piloto até que seja rotacionada pelo titular.
- **Cobrança mock só existe SEM credencial (18/08).** Com `MERCADO_PAGO_ACCESS_TOKEN`
  setado, uma falha do Mercado Pago (timeout/5xx) NUNCA pode virar Pix/link de mentira. O
  bug corrigido em 18/08: `createPix`/`createLink` engoliam o erro, logavam
  `[pix:create:fallback-mock]` e devolviam `mockpix_...` para um pedido real — o cliente
  recebia um código incolável com a dica de sandbox e, como o cérebro trata pixId iniciado
  em "mock" como sandbox, um "paguei" marcava o pedido como PAGO sem dinheiro nenhum. Hoje
  o adapter lança `PaymentProviderError`; o cérebro avisa o cliente
  (`copy.paymentIssueFailed`, "nada foi cobrado — responde *pix* ou *cartão*"), mantém o
  pedido aguardando, anota a falha no `/ops` e alerta o operador
  (`copy.operatorPaymentFailedAlert`). Repetir *pix*/*cartão* reemite a cobrança. Além
  disso, `handlePaidClaim` só aceita o atalho de sandbox quando `paymentsAreMocked()` — um
  pixId "mock" residual em produção não aprova nada. Travado por
  `tests/payment-issue-failure.test.ts`. **Não reintroduzir fallback mock em caminho de
  dinheiro real.**
- Manter idempotência, hash do carrinho e revalidação imediatamente antes de qualquer
  aprovação.
- Em 16/07, foi criado `OPS_TOKEN` dedicado (Sensitive, Production e Preview) sem
  substituir `API_TOKEN`; o redeploy de produção ficou `Ready` e o painel `/ops` foi
  autenticado com sucesso. O token não foi exibido nem registrado em documentação. A fila
  contém pedidos legados/pagos e alguns cancelados: não reutilizá-los para validar checkout.
  Em seguida, foi criado pelo painel um pedido técnico isolado com o SKU Carrefour exato
  então visível, usando somente a região já salva no Context persistente (nenhum endereço
  real foi copiado ou persistido). O workflow terminou em `needs_human` /
  `PREFLIGHT_NEEDS_HUMAN`: não conseguiu confirmar conjuntamente item, total, frete e prazo.
  O valor interno de R$ 1,99 não é cotação válida. Não houve WhatsApp, cobrança nem compra;
  a validação ao vivo continua pendente até o checkout expor todos esses campos.
- Em 16/07, a causa genérica acima foi decomposta com retries seguros. O endpoint técnico
  agora reutiliza o mesmo job, injeta somente o CEP público `01310-100`, possui status GET e
  uma página leve em `/ops/teste-carrefour`. O último retry limpou o carrinho anterior e
  terminou em `LOGIN_REQUIRED`; uma sessão viva do mesmo Context foi aberta para
  reautenticação humana. O detergente usado no mapeamento do navegador comum foi removido.
  Nenhuma etapa financeira foi aberta.

- Em 18/07, a chave Browserbase exposta foi regenerada no painel oficial e atualizada como
  `BROWSERBASE_API_KEY` Sensitive em Production. Um valor intermediário que apareceu no
  controle de rotação foi invalidado imediatamente e substituído por uma chave limpa, sem
  registrá-la no projeto ou na documentação. O redeploy de produção da versão
  `ops-direct-retailer-delivery` / `9a06eab` ficou `Ready`. Isso comprova a rotação e a
  configuração implantada, não a autenticação da API Browserbase nem o checkout Carrefour:
  não houve preflight, sessão nova, cobrança ou compra. Continuam pendentes a senha Carrefour,
  o PIN de registro WhatsApp e as demais credenciais expostas (Mercado Pago/Uber).
- Em 18/07, o operador pediu para suspender novas rotações de credenciais e priorizar o
  funcionamento do produto. Nenhuma rotação adicional deve ser iniciada sem novo pedido
  explícito. O trabalho funcional imediato é validar, em `cart_only` e sem cobrança/compra,
  a cotação Carrefour e os estados recém-implantados no `/ops`; os riscos de credenciais já
  documentados continuam bloqueios para piloto, não autorização para alterar segredos.
- Na primeira validação funcional coordenada de 18/07, o endpoint técnico de produção
  `/ops/teste-carrefour` iniciou um preflight sintético em `cart_only` (sem WhatsApp,
  cobrança ou compra) e terminou em `needs_human` / `CONFIGURATION_REQUIRED`: a credencial
  Browserbase configurada para Carrefour não foi aceita pelo runtime. Isto confirma que o
  deploy `Ready` não validou a variável em execução; não iniciar novo preflight até corrigir
  a configuração existente e confirmar a autenticação Browserbase. Não é autorização para
  nova rotação de credenciais.
- Ainda em 18/07, a causa foi confirmada: `BROWSERBASE_API_KEY` em Production continha um
  valor com prefixo `sk_live_`, que não era uma chave Browserbase. A variável foi substituída
  diretamente pela chave mascarada do painel Browserbase (sem registrá-la), e o redeploy
  `EEaegLWbmNtiwG6opHEbWirJBX57` ficou `Ready`. O retry do mesmo preflight técnico avançou até
  `LOGIN_REQUIRED`, confirmando que a autenticação Browserbase e o Context Carrefour voltaram
  a ser acessíveis pelo runtime. A cotação completa continua pendente de login humano no
  Context; não houve WhatsApp, cobrança ou compra.

## Cobertura e cotação

- A antiga regra “cidade coberta + loja a até 12 km” é legado do motoboy.
- Para entrega direta, o checkout do varejista é a autoridade de cobertura, frete e prazo.
- Distância até loja pode continuar como filtro comercial ou para parceiros same-day, mas
  não prova entregabilidade.
- Meta de cotação por loja: busca 2–8 s; carrinho/frete 10–25 s; total normalmente
  15–30 s. Medir p95 antes de prometer SLA.
- Cotação deve expirar em poucos minutos e ser revalidada antes da cobrança e da compra.

## Bloqueios antes do lançamento

1. Definir juridicamente comprador, titular da NF, múltiplos destinatários, troca,
   devolução, chargeback e responsabilidade pelo pós-venda.
2. Validar nos termos de cada varejista o uso de uma conta central para diferentes clientes.
3. Validar ao vivo a cotação real antes da cobrança. A rota Carrefour/Browserbase foi pausada
   após bloqueio de segurança do varejista em 19/07; priorizar a orquestração de cotação
   pré-cobrança e o piloto controlado na Petz, já validada até o checkout.
4. Validar ao vivo no `/ops` os estados de entrega/rastreio do varejista e o fluxo
   auditável de estorno. O código da revisão está implantado em produção desde 18/07,
   mas ainda não foi validado com massa técnica nova.
5. Testar cartão salvo, CVV, 3DS, CAPTCHA e antifraude sem habilitar compra automática.
6. Pilotar 5–10 pedidos controlados com entrega direta.
7. Para same-day, obter parceiro local ou contrato merchant/courier antes de desenvolver
   nova automação de retirada.
8. Antes de ativar One-Click: confirmar as migrations de pagamento já aplicadas, liberar
   Payments API BR na WABA, liberar o domínio no Pagar.me e configurar as chaves/webhooks
   em produção.

## Estado dos conectores

- **Petz:** busca/carrinho/checkout validados; é o conector recomendado para o primeiro piloto,
  após receber a orquestração de cotação antes da cobrança. Finalização financeira ainda bloqueada.
- **Carrefour:** busca pública disponível; automação de carrinho implementada, mas autenticação e
  checkout via Browserbase pausados após bloqueio de segurança do varejista em 19/07. Só retomar
  com API/parceria oficial ou ambiente autorizado. Handoff para o cliente foi rejeitado; qualquer
  alternativa deve preservar a compra concluída pela Lia nos bastidores.
- **Boticário:** busca e carrinho preparados; política de entrega/titularidade ainda precisa
  da mesma validação operacional.
- **Candidatos supermercado:** Oba primeiro e Mambo como fallback regional; ambos passaram em
  19/07 por catálogo, disponibilidade regional, carrinho anônimo e simulação pública de frete/prazo
  no CEP `01310-100`, com limpeza posterior. Savegnago vem depois; Pão de Açúcar exige cautela por
  gestão de bots. Nenhum deles tem login, checkout financeiro ou autorização comercial homologados.
- **Mercado Pago:** cobrança do cliente.
- **Pagar.me + Meta One-Click:** código pronto, flag desligada; depende da habilitação
  externa e de validação sandbox.
- **Browserbase:** navegação persistente e auditável, mas a viabilidade é específica por varejista;
  foi validado na Petz e bloqueado pelo Carrefour na autenticação em 19/07.
  Falhas de credencial, indisponibilidade e sessão expirada devem ser classificadas de forma
  explícita e falhar fechadas; não transformá-las em tentativa de checkout.
- **Uber Direct:** opcional para parceiro que autorize courier.

## Mapa rápido do código

- conversa e orquestração: `src/lib/delivery-service.ts`;
- intenções: `src/lib/lia-intents.ts`;
- copy: `src/lib/lia-copy.ts`;
- conectores de lojas: `src/lib/stores/`;
- busca Browserbase: `src/lib/stores/browserbase-live-search.ts`;
- compra e política: `src/lib/purchasing/`;
- workflow durável: `src/workflows/purchase-order.ts`;
- pagamentos: `src/lib/payments/`;
- guia de ativação One-Click: `docs/whatsapp-one-click-pagarme.md`;
- webhook WhatsApp: `src/app/api/whatsapp/webhook/route.ts`;
- operação: `src/app/ops/` e `src/app/api/ops/`;
- convenções de estado/entrega/estorno: `src/lib/order-flags.ts`;
- runbook do piloto: `docs/operacao-piloto-needs-human-estorno.md`;
- schema: `prisma/schema.prisma`;
- testes: `tests/`.

## Validação ao vivo — 15/08/2026

Uma nova rodada de 10 cenários foi executada no WhatsApp contra a versão já publicada,
sem alteração de código e sem cobrança. Passaram de forma clara a adição relativa pelo
SKU, a preservação da cesta e o cancelamento antes do pagamento. Permaneceram observados
em produção: cabo de 2 m retornando carregador de parede; fillers como “pensando bem” e
“chega amanhã” virando linhas indisponíveis; “sem remédio” sendo confundido com remoção;
cards acima de teto explícito; e CEP embutido na frase de troca de endereço sendo pedido
novamente. O relatório detalhado está em
[docs/testes-whatsapp-2026-08-14.md](docs/testes-whatsapp-2026-08-14.md). Isso é evidência
de comportamento ao vivo, não registro de conserto ou de novo deploy.

### Perfil público do WhatsApp — 15/08/2026

No WhatsApp Manager da conta conectada `+55 11 97844-4813`, foi solicitada a troca do nome
visível de `Lia Delivery by 67.742.955 Joseph Carlos Dayan` para **Lia Delivery**. O painel
marcou o número como **In Review**. Até a aprovação da Meta, o CNPJ e o nome anterior ainda
podem aparecer no WhatsApp; não há nova ação de código ou de pagamento associada.

### Atualização do perfil público — 19/08/2026

A foto de perfil com o monograma lima “L” em fundo berinjela foi enviada e salva no
WhatsApp Manager para o número conectado `+55 11 97844-4813`. Na conferência feita logo
depois, o nome visível continuava `Lia Delivery by 67.742.955 Joseph Carlos Dayan`, com
status **Approved**. O histórico registra `Name verification requested` em 17/08, mas não
registra aprovação nem rejeição. Portanto, a troca para **Lia Delivery** ainda não se
refletiu no perfil; não reenviar nem alterar outros campos sem orientação do dono. Uma
versão nova da foto foi preparada em `public/brand/lia-whatsapp-profile-hd.svg` e PNG
2048×2048, renderizada diretamente do vetor com o símbolo 30% maior. Após comparar as duas
composições, o dono escolheu manter a estrela na posição original, um pouco além da ponta do
“L”. Essa versão foi enviada e salva no WhatsApp Manager em 19/08; a Meta avisou que pode
levar alguns minutos para aparecer no WhatsApp.

### Validação independente — 15/08/2026

Outra rodada de 10 cenários foi executada sem alteração de código. Passaram a troca
“granola → aveia”, “sem remédio” com shampoo, presente dentro de R$100 e 4x → 7x → 5x
do mesmo bombom. Ainda foram observados fillers/contexto (“Para domingo”, “Para uma
viagem”), preço (“barato”), combinação de itens na mesma mensagem, e perda da cesta
depois de salvar um novo endereço. O detalhe está no relatório de testes; isto é validação
ao vivo, não conserto nem novo deploy.

### Atualização 17/08/2026 — API oficial do Mercado Livre (em preparo, não ativada)

O DevCenter foi acessado com a conta operacional, mas a rota oficial de criação da primeira
aplicação retornou `OPT02-EN1XAJYDKPNW` e voltou à página inicial mesmo após o retry sugerido
pelo próprio site. Portanto **nenhuma aplicação, chave, token, notificação, compra ou mudança
de conta foi criada**. O ML informa que contas brasileiras precisam ter os dados do titular
validados antes de criar aplicação e podem ter limite de uma app; o próximo passo externo é
regularizar isso no suporte/DevCenter e só então criar uma app exclusiva da Lia.

O código local foi preparado, mas não implantado: `ML_CLIENT_ID`/`ML_CLIENT_SECRET` Sensitive,
callback fixo `https://liadelivery.com.br/api/mercadolivre/oauth/callback`, state anti-CSRF e
tokens cifrados no Postgres. A API oficial será uma busca rápida de vitrine de cauda longa;
Apify segue fallback. Ela **não** é API de compra nem de acompanhamento dos pedidos que a Lia
faz como compradora; não cadastrar `orders_v2`/`shipments` com essa expectativa.

### Correção 18–19/08/2026 — conversa presa em pedido morto e escolha de frete velha

Revisão dupla independente do `src/lib/delivery-service.ts` achou dois defeitos ligados,
ambos corrigidos e cobertos por eval E2E em `tests/manual-concierge.test.ts`:

1. **Cancelar/estornar no /ops não soltava a conversa.** `opsCancelRefund` fechava o pedido
   e deixava o contexto apontando pra ele: o cliente ouvia "ainda estou cotando" de um
   pedido cancelado e "cancelar" respondia "não tem pedido em andamento" sem limpar nada.
   Em `choosing_freight` era pior — o toque no botão de frete chamava
   `opsPublishManualQuote` num pedido cancelado, que lança, e a resposta virava erro
   genérico em loop; a única saída era "trocar endereço". Agora `opsCancelRefund` reseta o
   contexto (mesmo helper do pagamento, `resetConversationForClosedOrder`, que preserva
   cesta/pedido novo), `handleCancel` limpa o ponteiro morto antes de responder
   "não tem pedido", e o passo `awaiting_operator_quote` se cura sozinho quando o pedido
   não está mais na fila.
2. **`choosing_freight` não expirava nunca.** O cliente sumia dias e o toque em
   `frete:barato` publicava frete e promessa de data do anúncio consultados no passado
   (possivelmente já vencidos), numa cotação pagável. O passo entrou no TTL de abandono
   (`LIA_QUOTE_ABANDON_TTL_MS`, 1h) e a escolha passou a carregar `quotedAt`: toque mais
   velho que o TTL cancela o pedido não-cotado e recomeça, em vez de publicar. Toque em
   botão vencido não é reprocessado como lista de compras.

Gate: `tsc` limpo + suíte `tests/manual-concierge.test.ts`. Não publicado — deploy depende
de autorização do dono.

## Regras para continuar o trabalho

- Preserve mudanças existentes: o worktree pode estar sujo e contém trabalho do usuário.
- Não trate documentação histórica como verdade operacional quando conflitar com este
  arquivo.
- **Ao encerrar toda conversa com avanço, decisão, descoberta, bloqueio ou validação
  relevante, atualize automaticamente os Markdown canônicos — mesmo sem pedido explícito.**
  No mínimo revise `AGENTS.md`, `STATUS.md`, `PENDENCIAS.md` e o documento operacional
  datado; registre com clareza o que foi implementado, validado, somente pesquisado e o
  que ainda depende de ação externa.
- Ao mudar uma decisão de produto, atualize primeiro este arquivo, depois `STATUS.md` e o
  documento datado correspondente.
- Ao concluir, criar ou repriorizar trabalho, atualize `PENDENCIAS.md` no mesmo momento.
- Diferencie sempre: implementado, validado ao vivo, implantado, pendente e hipótese.
- Não declare “pronto para lançamento” enquanto qualquer bloqueio acima estiver aberto.
## 25/09/2026 — Acompanhamento do nome público do WhatsApp

Às 16:55 (São Paulo), Gmail do contato correto continuava sem resposta de mérito dos casos
Meta/WhatsApp; o fórum seguia `Unresolved`, sem resposta de terceiros. O WhatsApp Manager
ainda mostrava o nome antigo com nome pessoal/CNPJ como `Name visible to customers`.
O agendamento do acompanhamento havia voltado indevidamente para 10 horas; corrigido pela
automação do Codex para `FREQ=HOURLY;INTERVAL=1`, status `ACTIVE`, e confirmado no arquivo
de configuração. Continuar verificando a frequência, pois essa regressão já ocorreu antes.
