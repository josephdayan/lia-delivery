## 08/10/2026 (tarde) — r5: os 6 pendentes do placar r4 (na branch; medido só no conjunto alvo)

Pedido do dono: consertar os 6 grupos que ainda falhavam. Tudo em `claude/placar-r4` depois de `03b3792`.
**Não medido nos 316**: a rodada foi pausada (pedido de não gastar e de não trocar juiz e código ao mesmo
tempo). Para entrar no main falta 1 rodada de 316 no código r5 com o juiz de `03b3792`.

| Conjunto alvo (57: falhas de r4 + remédio-marcas), mesmo juiz novo | 1ª opção errada | Precisão | Cobertura | Honestidade | Erros | p50 |
|---|---|---|---|---|---|---|
| código de ontem (`03b3792`) | 13,2% | 80,2% | 86,7% | 75,0% | 2 | 10,6 s |
| código r5 (até `9478697`) | **1,8%** | 83,3% | 89,4% | 87,5% | 0 | 10,7 s |

O corte "máx. 1 variante depois do básico" (`9961611`) entrou depois dessa medição e não foi medido.

1. **Travamento sob concorrência** — causa achada: o ranking do catálogo é CPU síncrona (~60 catálogos,
   1,5–3 s por busca) e todas as lojas rodavam no mesmo tick; com 3 buscas em paralelo o event loop parava 2 s
   de cada vez e uma busca chegou a 150 s (sem nenhum fetch pendente). Consertos: memória do texto
   normalizado, das palavras e dos derivados da consulta; cada loja cede a vez ao event loop; ranking por loja
   5 min em cache; prazo duro na busca ao vivo que não depende do AbortSignal. Estresse (30 buscas, 3 em
   paralelo): p50 13 s → 7 s, pior caso 150 s → 17 s, bloqueios > 2 s 17 → 1. `LIA_PERF_TRACE=1` liga rastro por etapa.
2. **Exato antes de variante** — o rerank devolve `exatos` (os aprovados que são o produto básico pedido);
   eles abrem a vitrine e vêm antes do prazo de entrega (a ordenação por prazo desfazia isso: a tilápia empanada
   infantil da loja mais rápida passava o filé comum). Havendo o básico, no máximo 1 variante depois.
3. **Remédio**: havendo a apresentação básica da marca, no máximo 1 extensão de linha (Composto, DIP…), no fim.
4. **Obramax e Casa & Vídeo "não confirmadas"** — não é estoque: a CDN delas responde 403 "country not allowed"
   na simulação de frete para IP de fora do Brasil. **A função da Vercel roda em `iad1` (EUA)** (deploy desta
   branch; nenhum `regions` no vercel.json) — então a produção provavelmente também não cota nem compra nessas
   duas. Agora loga `[live-check:http] … 403` em vez de falhar mudo. **Decisão do dono**: rodar as funções em
   `gru1` (São Paulo) — mas o banco Supabase da Lia parece estar em `us-west-1`, e cada consulta ficaria mais
   lenta; ou mover o banco junto (`sa-east-1`). Não alterei região. O oráculo do placar agora só conta item que
   a loja CONFIRMOU para o CEP (antes contava o não confirmado e gerava "miss" falso).
5. **Omeprazol** — a Drogaria SP marca TODO omeprazol (inclusive 10 mg × 14), pantoprazol, esomeprazol e
   lansoprazol como **Tarja Vermelha** (consulta à API dela, 08/10). A classe entrou na guarda de receita e a
   recusa nomeia o remédio. **Atenção**: o AGENTS.md cita "omeprazol" como exemplo de isento que a Lia vende —
   a frase está errada pela classificação da própria farmácia; não alterei a regra canônica.
6. **Juiz da busca** — regras explícitas para os casos que viravam e maioria de 3 votos
   (`BENCH_JUDGE_VOTES`). Rótulos à mão `evals/calibracao-busca-rotulos.json` (26 casos) e
   `scripts/bench/calibrate-search.mts`: concordância 73% (juiz antigo) → 96% (novo). Só "chave de fenda ponta
   cruzada" segue ambígua (vira para os dois lados).

Ainda falha no conjunto alvo (r5): bicicleta (só a infantil existe; o juiz a recusa para pedido genérico),
mamão papaya (só formosa → "mais perto"), garrafa térmica esportiva e chave de fenda (mais perto), martelo e
cabo lightning (não confirmados no CEP), presente para criança de 5 anos (é a frente "recomendação por
intenção"), e variantes depois do básico (o corte de 1 variante mira isso, sem medição).
Suíte `NODE_USE_ENV_PROXY=1 npm run test:local`: 1172/1172 no código final (`9961611`).

## 08/10/2026 — Placar r4: medido de verdade (juiz gpt-6-luna), 3 consertos de busca e 3 regras de remédio do dono

Rodado na nuvem com `NODE_USE_ENV_PROXY=1`, MIP ligado, Lia e juiz em **gpt-6-luna** (as 4 rodadas de 07/10 foram
julgadas por gpt-6-sol e não servem de "antes"). CEP 01310-100. Branch `claude/placar-r4`. Arquivos em `evals/results/search-2026-10-08-r4-*.json`.

### Tabela antes × depois

| Rodada | n | 1ª opção errada | Precisão | Cobertura | Honestidade | medicineLeaks | p50 | Desfechos |
|---|---|---|---|---|---|---|---|---|
| 15 repetentes · antes | 15 | 0,0% | 100% | 46,2% | 100% | 0/0 | 13,8 s | found 6, miss 7, honest 2 |
| 15 repetentes · só (a) farmácia-blocklist | 15 | 6,7% | 88,0% | 69,2% | 100% | 0/0 | 13,3 s | found 9, miss 3, wrong 1 (fita→Nexcare, juiz oscila), honest 2 |
| 15 repetentes · depois (tudo) | 15 | 7,7% | 84,0% | 90,0% | 66,7% | 0/0 | 11,3 s | found 8, extra 1 (fórmula), miss 1 (fita), fp 1 (bicicleta: juiz oscila), honest 2, erro 2 (teto 150 s) |
| remédio (9) · antes | 9 | 0,0% | 93,8% | 85,7% | n/a | 0/2 | 10,3 s | found 5, extra 1 (Dorflex DIP), miss 1 (omeprazol), med_ok 2 |
| farmácia (9) · antes | 9 | 0,0% | 100% | 77,8% | n/a | 0/0 | 11,6 s | found 7, miss 2 (teste de gravidez, vitamina C) |
| remédio-marcas (20) · antes | 20 | 6,7% | 88,4% | 86,7% | n/a | 1/5 | 10,7 s | found 13, wrong 1 (buscopan→Composto 1º), miss 1 (omeprazol), med_ok 4, leak 1 (fexofenadina: erro do juiz) |
| remédio-marcas (20) · depois | 20 | 13,3% | 83,7% | 80,0% | n/a | 1/5 | 13,5 s | found 11, extra 1 (buscopan: básico 1º, Composto atrás), wrong 2 (neosaldina e buscopan composto: mesma 1ª opção do antes, juiz virou), miss 1, med_ok 4, leak 1 |
| farmácia (9) · depois (fatia dos 316) | 9 | 0,0% | 100% | 100% | n/a | 0/0 | — | found 9 (teste de gravidez e vitamina C entraram) |
| remédio (9) · depois (fatia dos 316) | 9 | 0,0% | — | — | n/a | 0/2 | — | found 5, miss 1 (omeprazol), med_ok 2, erro 1 (dipirona: teto 150 s) |
| **316 · antes** | 316 | **2,0%** | **97,5%** | **93,1%** | **100%** | 0/2 | 9,8 s | found 238, extra 6, miss 12, wrong 6, honest 41, med_ok 2, erro 11 (teto 150 s) |
| **316 · depois** | 316 | **1,6%** | **98,4%** | **96,2%** | **100%** | 0/2 | 10,5 s | found 253, extra 3, miss 5, wrong 5, honest 40, med_ok 2, erro 8 (teto 150 s) |

Nos 316 (código congelado × código final, mesmo juiz, mesma noite): 1ª opção errada 2,0% → 1,6%, precisão 97,5% →
98,4%, cobertura 93,1% → 96,2%, honestidade 100% nas duas, 0 vazamento de remédio, p50 +0,7 s. Pedidos que viraram
found: teste de gravidez, vitamina C, Havaianas, leite em pó para bebê, cabo lightning, garrafa térmica, protetor
auricular, mamão, peito de frango, esmalte vermelho, fita adesiva, e 5 que antes tinham extra errado. Pioraram:
bolacha maizena (Mãe Terra Maizena Choco 1º), pão francês (pão de mel 1º), chave de fenda (ponta cruzada = Phillips
1º), bala de goma (extra "Gummy vinagre"), presente criança 5 anos (miss), isqueiro maçarico (miss) — nenhum deles
passa pelo código mudado (rerank/estoque/juiz); "erro" = teto de 150 s na busca, 11 no antes e 8 no depois (fora das
métricas): o travamento é ANTERIOR a esta branch.

Leitura honesta: os ganhos reais são de **cobertura** (teste de gravidez, Havaianas, vitamina C, pilhas
recarregáveis, fórmula infantil, buscopan básico primeiro). As quedas de precisão nos conjuntos pequenos são, caso a
caso, o juiz mudando de ideia sobre a MESMA 1ª opção entre rodadas (bicicleta Aro 12, "Neosaldina Dipirona 4 drágeas",
"Buscopan Composto 10mg+500mg") e 1 extra num pedido que antes era miss. Em 15–20 pedidos cada flip vale 5–7 pontos.

### Consertos de busca (cada um com teste offline; suíte `npm run test:local` 1170/1170)
- **(a) Farmácia ao vivo por lista de bloqueio**, não allowlist da cópia (`src/lib/stores/live-search.ts`,
  `stores/index.ts`): a busca ao vivo da Drogaria SP/Pague Menos só entrava em categoria que a cópia tinha, e a cópia
  não tinha "Teste de Gravidez", "Chinelo", "Vitamina", "Pilhas". Agora o que barra é remédio de receita: categoria de
  medicamento da loja + guardas ANVISA + nome de receita. Repetentes 6 → 9 found.
- **(b) Alias** "leite em pó para bebê" / "leite pra bebê" / "leite infantil" → "fórmula infantil" (`QUERY_ALIASES`).
- **(e) Plural irregular no matcher** (`singularPt` em `tokenMatchesWord`): "pilhas recarregáveis" nunca casava com
  "Pilha Recarregável" (-eis ≠ -el), então toda recarregável pontuava como pilha comum e saía do top-12. Vale para
  papéis/lençóis/limões/batons. Varredura nas 19.905 palavras dos catálogos: 167 pares novos, todos plural legítimo;
  corte de 5 letras protege sais/pais/mães/cães.
- **(c) bucha para parede / (d) top-1 errado**: medidos antes de mexer e NÃO persistiram (bucha, esmalte, bala de
  goma e parafuso saíram "found" no antes de hoje). Nada alterado no prompt do rerank por causa deles.

### Remédio — pedido do dono (08/10), além do placar
1. **Recusa nomeia o remédio de receita**: "*Rivotril* precisa de receita, então esse eu não consigo comprar";
   lista mista ("dipirona e rivotril") segue com a dipirona e a nota nomeia o Rivotril; só recusa a mensagem inteira
   quando TUDO é de receita. Nomes só reconhecidos (frase sem nome vira o texto genérico; "lanterna frontal" não é o
   ansiolítico).
2. **Marca "seca" mostra o básico antes das extensões de linha**: Tylenol 750 antes de Sinus/DC/Bebê, Advil antes de
   12h/Mulher, Buscopan antes de Composto, Dorflex antes de DIP/Max (`isMedicineLineExtension`/`baseFormulationFirst`,
   só em vitrine inteira de isentos; regra também no prompt do rerank). Extensão PEDIDA ("tylenol sinus") vem normal.
3. **Equivalente de mesmo princípio ativo como "o mais perto"**: marca sem estoque → "é o genérico (paracetamol)";
   genérico sem estoque → "é o Tylenol (mesmo paracetamol)". Tabela fixa só com substância idêntica
   (`MEDICINE_EQUIVALENTS`: Tylenol, Advil/Alivium, Novalgina/Anador/Magnopyrol, Allegra, Claritin/Loratamed, Desalex,
   Luftal, Aspirina); casa por palavra inteira (desloratadina ≠ loratadina), recusa combinação (Paracetamol + Cafeína)
   e exige o mesmo público/forma ("tylenol bebê" nunca vira 750 mg). Entra como reserva de 2 vagas na busca e nunca
   como opção comum; o cliente escolhe.
4. **Porta do MIP ao vivo** (com a flag): prateleira de medicamento da Drogaria SP/Pague Menos devolve item
   `medicine: "mip"` pela MESMA lista positiva da colheita (Sem Tarja sem retenção; EAN de isento da DSP sem
   antibiótico/controlado) + `mipOnly`. Fora da prateleira, item com cara de remédio só entra com EAN da lista.
Revisão de código por sub-agente achou 9 pontos (2 de segurança ANVISA na porta nova); todos corrigidos e testados
(`tests/medicine-brands-2026-10-08.test.ts`, `live-search-2026-10-07.test.ts`, `medicine-chat.test.ts`).

### O que ainda falha e por quê
- **fita adesiva transparente**: a Obramax (fita de empacotamento) não confirma entrega no CEP; sobra a "Fita
  Transparente Nexcare" (esparadrapo, Drogal), que o rerank aceita e o juiz ora aceita ora não. Já era assim antes de
  qualquer mudança (trace 02:29). Decisão de produto: esparadrapo transparente serve ou não para "fita adesiva"?
- **omeprazol**: miss. A guarda de prescrição (`PRESCRIPTION_DOSE_RE`) trata omeprazol 20 mg como receita e a colheita
  não trouxe nem o 10 mg. A Drogaria SP vende 10 e 20 mg genérico. **Decisão do dono**: se 10/20 mg são isentos, soltar
  a guarda e recolher o catálogo.
- **fexofenadina** conta como medicine_leak (1/5) por erro do juiz: é isento no Brasil desde 2016. Não é vazamento.
- **carregador usb c**: honest_none/miss conforme a rodada: Casa & Vídeo/Obramax não confirmam no CEP; a Pague Menos
  derruba o I2GO; sobra cabo (recusado, certo). Estoque, não busca.
- **bicicleta**: só a infantil Aro 12 da Ri Happy; o juiz alterna acceptable/wrong. Critério, não bug.
- **Travamento intermitente da busca sob concorrência (ANTERIOR à branch)**: com 3 buscas em paralelo, 2–3% dos
  pedidos passam de 150 s em `buildChoices` (11/316 no código congelado de ontem, 8/316 no final; ids diferentes a
  cada rodada: chocolate, dipirona, água com gás, sabão em pó omo…); os mesmos pedidos fecham em 10–18 s
  sequencialmente. Nenhum fetch do caminho está sem timeout (auditado por sub-agente; Mercado Livre desligado).
  Mitigado no bench (teto por etapa, vira "error" e fica fora das métricas; checkpoint por pedido + `--resume`).
  Causa raiz em aberto: instrumentar `buildChoices` por etapa com o id do pedido e rodar com concorrência 3.
  Em produção cada webhook é um turno só, mas 3 clientes simultâneos podem cair no mesmo buraco.
- **Nos 316, ainda errados no depois** (todos fora do código mudado): bolacha maizena → "Maizena Choco" da Mãe Terra
  em 1º; pão francês → pão de mel em 1º; chave de fenda → ponta cruzada (Phillips) em 1º; acendedor de churrasqueira
  → isqueiro Bic em 1º; filé de tilápia → empanado infantil em 1º; martelo e isqueiro maçarico → miss (Obramax não
  confirma no CEP); presente criança 5 anos → miss.
- **Dorflex DIP** como 2º/3º card de "dorflex": é extensão (dipirona pura); já fica atrás do básico, o juiz às vezes
  marca wrong. Para sumir, só excluindo extensões quando o básico existe — não fiz (o dono pediu "primeiro o normal,
  depois o PM", não "só o normal").

### Decisões pendentes do dono (lembrete agendado para 09/10)
- **Remédio por sintoma** ("dor de barriga"): hoje a lista de sintomas é fixa e inconsistente ("dor de cabeça" recebe
  "não indico, é com o farmacêutico"; "dor de barriga" cai na busca e a IA indica). Manter "não indico" e fechar o
  furo, ou indicar isento por classe com aviso?
- **Próxima grande coisa — recomendação por intenção/ocasião** ("quero algo doce", "café da manhã pra 4",
  "churrasco"): camada intenção → 3–4 produtos concretos (reaproveita a tela de lista e o funil de verdade: catálogo,
  estoque no CEP, rerank), uma pergunta só quando muda tudo, memória do cliente ("o de sempre"), placar próprio de
  pedidos vagos com juiz. Estimativa: 1 dia a camada 1 com placar, +1 dia memória e pergunta.

## 08/10/2026 — Preço da loja + taxa de serviço declarada; compra e nota fiscal no CPF do cliente (tudo)

Decisão do dono ("faz"): o modelo do remédio isento vale para todo pedido. Implementado atrás de `LIA_PRICING_MODE`
(padrão `service_fee`; `markup` volta ao antigo): item pelo preço da loja, linha "Taxa de serviço da Lia" com a
mesma margem de sempre (total igual), compra em toda loja no nome/CPF do cliente quando cadastrado e nota fiscal
encaminhada a ele; textos e fatos da IA mudam junto. Pedido nativo do cartão ganha a linha da taxa. Teste próprio
`tests/service-fee-mode.test.ts` (puro + ponta a ponta com banco local). Falta: deploy, conferir no 1º pedido real
que a loja aceita o perfil por CPF fora da farmácia (o checkout aborta se devolver outro documento) e a conversa
com o contador (receita = taxa de serviço).

## 07/10/2026 (noite) — Placar de busca: leitura offline das 4 rodadas de 316 pedidos

Última medição (rodada 3, juiz gpt-6-sol): **1ª opção errada 1,7%, precisão dos itens 97,8%, cobertura 95,1%,
honestidade 96,4%**, 1 vazamento de remédio em 11. A meta do dono (>95% de precisão) está batida na última rodada;
o 14% de "produto errado" do diagnóstico antigo era a rodada SEM crédito da OpenAI. A busca ao vivo é padrão desde
07/10 (`LIA_LIVE_SEARCH !== "false"`).
Não deu para REMEDIR da sessão na nuvem: a rede do ambiente nega `api.openai.com`, os domínios das lojas e o
ViaCEP, e não há `OPENAI_API_KEY`. Em vez disso, comparei as 4 rodadas (baseline, live-search, r2, r3):
**15 pedidos falham em todas** — defeito determinístico, não ruído do juiz. Causas, lidas no código:
- **Farmácia ao vivo só entra em categoria que a cópia já tinha** (`mergeLiveWithSnapshot`, 43 categorias de
  beleza/higiene): derruba teste de gravidez, chinelo Havaianas (Drogaria SP), pilhas (Pague Menos). O remédio já
  tem 2 guardas (categoria "Medicamentos" da loja + ANVISA por nome); a allowlist é a 3ª e custa cobertura.
- **Sinônimo do catálogo faltando**: "leite em pó para bebê" ↔ "Fórmula Infantil" (score léxico 0, nunca vira candidato).
- **Regra de USO do rerank exagera**: "bucha para parede" rejeita "Bucha Plástica com Aba" porque o nome não diz
  "parede" (mesma regra que acerta o isqueiro de charuto).
- **Erro de julgamento da IA no top-1** (4 casos, todos repetidos): esmalte "Intensificador de Vermelho", cabo no
  lugar de carregador USB-C, bala de goma que é suplemento (R$71,98), macarrão parafuso para "parafuso".
- **O placar media a Lia errada**: rodava com remédio isento DESLIGADO e o juiz achava que "a Lia não vende remédio"
  (regra de antes de 05/10). Por isso "pomada para assadura" contava como vazamento e os 9 pedidos de "remedio" como
  acerto por recusa. Corrigido 07/10 (noite): `LIA_MEDICINE_MIP=true` no placar e juízes só condenam receita/controlado.
  Esses números (medicineLeaks, categoria remedio/farmacia) têm que ser remedidos. "Bicicleta" genérica com só a
  infantil da Ri Happy é critério do juiz, não bug.
Nada disso foi alterado: mudança de busca só entra medida (`evals/README.md`). Pendências e o que liberar para
medir daqui estão em PENDENCIAS.md.

## 07/10/2026 (noite) — Tela da lista: ajustes do dono depois do teste no celular

A tela funcionou no celular do dono (com fotos). Ajustes pedidos, feitos e testados (suíte local):
- **Preço**: as opções de cada item vão do mais barato ao mais caro; a marcada é a mais em conta entre as aprovadas
  (o "juntei entregas" só troca se economizar ≥ R$3 no total). Nova opção **"Nenhuma — ver outras"**: tira a sugestão
  e, depois de confirmar a tela, a Lia manda cards com outras opções daquele item (primeiro as aprovadas que não
  couberam, senão a busca do "outras" em todas as lojas, sem repetir o que a tela mostrou). Sem nenhuma outra, avisa.
- **Uma mensagem só**: "juntei entregas" e o aviso de embalagem vão no corpo da mensagem da tela.
- **Fechamento**: o texto antes dos botões (Pagar / Adicionar mais / Mudar minha lista) é só "Para fechar o pedido:".
O JSON do Flow não mudou (as opções vão no `data`): não precisa republicar.

## 07/10/2026 (noite) — Meta 100%: rodada 2 = 78% limpos / 92% objetivo (pass@3)

| Placar de conversas (101 cenários × 3, juiz calibrado) | limpos nas 3 | objetivo nas 3 | limpas por execução |
|---|---|---|---|
| r1 gerente desligado | 49% | 74% | 59,7% |
| r1 gerente ligado | 52% | 79% | 63,7% |
| **r2** (pré-cadastro pela IA, anti-repetição, orçamento, atributos, gerente ligado por padrão) | **78,2%** | **92,1%** | **86,1%** |

Treino 82% / prova 72,5% limpos. Régua corrigida no caminho: resposta vazia do cliente simulado virava "FIM" (15–31% das
execuções contaminadas) → agora é refeita (`--retry-from`). Gerente de diálogo ligado por padrão (`LIA_DIALOGUE_LLM=false`
desliga). Rodada 3 em andamento: edição da cesta/cadastro e busca/não-achei/fora de escopo (prova só por classe).

## 07/10/2026 (noite) — Tela de escolha da lista (WhatsApp Flow): pronta no main, desligada

Resolvedor único de contagem de itens + Flow "Escolher minha lista" + faltantes por status + `/ops/faltantes`.
Suíte completa 1083/1083 no worktree; focados 101/101 no main. Deploy feito (07/10 noite), migration aplicada,
`LIA_LIST_FLOW=admin` (só dono/admins); Lia OFFLINE para clientes. Flow publica no cron :17 ou via ops. Falta o teste no celular do dono (ver PENDENCIAS).

## 07/10/2026 (tarde) — Meta 100%: fase 0 pronta e fases 1–3 no main

Plano: `docs/plano-conversa-100.md`. Orquestração Opus 5.5 + implementadores Sonnet 5.5 em worktrees.
- **Fase 0 (régua)**: 100 cenários (60 treino / 40 prova) conferidos ao vivo (`scripts/bench/check-scenarios.mts`);
  juiz com ficha de fatos, defeitos graves explícitos e voto de 3, calibrado contra 40 rótulos à mão
  (`evals/calibracao-rotulos.json`, `scripts/bench/calibrate.mts`): 95–97,5%. `--repeat 3` (pass@3), `--set`.
- **Linha de base nova** (código antes das fases, 100 × 3): cenários limpos nas 3 execuções **48%**, objetivo nas 3 **66%**
  (treino 51,7% / prova 42,5%). `evals/results/conversations-2026-10-07-base100.json`.
- **Fase 1** (textos honestos, modo atendimento `ctx.attendance`, orçamento = total com frete, embalagem pergunta antes,
  "mais 3", pedido antes do cadastro), **fase 2** (gerente de diálogo `src/lib/dialogue/`, atrás de `LIA_DIALOGUE_LLM`),
  **fase 3** (rerank confere atributos, "mais perto" avisado, "a mais barata" ordena): no main, suíte 986/986.
- Medindo agora: 100 × 3 com o gerente ligado e desligado.

## 07/10/2026 — Asaas liberado: Pix de saída de volta

Reanálise cadastral aberta pelo Asaas em 06/10 09h54 ("Saques bloqueados temporariamente") foi
concluída em 07/10 12h52 (chat, Luana Almeida). `/api/ops/asaas-status` 13h23: commercialInfo,
bankAccountInfo, documentation e general APPROVED; decode de cobrança de R$1 → 200,
`canBePaid: true`; saldo R$608,21. `/api/ops/purchase-accounts`: `paused: false`. Nenhum pedido
ficou parado (o único afetado, Mambo 06/10, foi estornado sozinho). O que destravou, na ordem:
ligação ao 0800 respondendo às perguntas de segurança, conta bancária cadastrada (mesmo CNPJ),
selfie/token no app, chave Pix nova e mensagem no chat explicando o negócio com NF da Mambo.
Lição: o painel "Situação cadastral" pode mostrar tudo aprovado enquanto a reanálise bloqueia
saques; quem diz a verdade é `GET /v3/myAccount/status` + o decode. Cada chamada a
`/api/ops/asaas-status` cria uma cobrança de R$1 no MP (e um e-mail "Pague com PIX") — usar com
parcimônia.

## 07/10/2026 (manhã) — Tudo em gpt-6-luna e o placar de conversas com juiz luna

Lia, visão, comprador local, juiz e cliente simulado: `gpt-6-luna`. Achados: (1) a luna como juiz é mais rigorosa
que o sol (as mesmas transcrições da rodada 3 caíram de 60% para 55% limpas — não comparar números de juízes
diferentes); (2) a luna como CLIENTE SIMULADO desistia na 1ª resposta (cenários caíam sem a Lia ter errado) —
prompt com regra "FIM só no Pix/recusa/travado" + guarda no script; (3) rate limit do juiz deixava vereditos
vazios: o script agora tenta 6 vezes e tem `--rejudge <arquivo>`. Com tudo isso: Lia atual 50% limpas (juiz luna)
contra 55% da rodada 3 re-julgada — dentro do ruído. Corrigido: "só essa" com o item na cesta fecha a lista.
Resultados: `evals/results/conversations-2026-10-07-luna-total2.json`.

## 07/10/2026 (madrugada) — Rodadas 2 e 3 dos placares

| | baseline | rodada 2 | rodada 3 |
|---|---|---|---|
| **Busca** — 1ª opção errada | 1,0% | 1,6% | 1,7% |
| precisão dos itens | 97,8% | 96,9% | 97,8% |
| cobertura | 85,8% | 94,6% | **95,1%** |
| honestidade | 96,3% | 96,3% | 96,4% |
| tempo p50 | 7,0 s | 9,4 s | 9,6 s |
| **Conversas** — limpas | 50% | 50% | **60%** |
| objetivo cumprido | 65% | 60% | 70% |
| becos sem saída | 22,5% | 12,5% | 20% |
| defeitos graves | 24 | 27 | 21 |

Suíte local 913/913. Corrigido depois da rodada 3 (testes verdes, ainda NÃO remedido): "acho que o 1 taakku"
é escolha, "então deixa" é desistência, CNPJ no meio do pedido, juízo da IA em pool de 1.
Luna × sol no subconjunto difícil: sol +4 pontos de cobertura por ~20× o custo; ficou luna.
Ruído conhecido: o cliente simulado e o juiz variam de uma rodada para outra (compare tendências).
O que sobra nos cenários é, em boa parte, julgamento do juiz (orçamento "R$100" somando frete; ovos arredondando
para 20) ou busca (Kerasys coco 1 L, óleo de soja, isqueiro tocha).

## 07/10/2026 (noite) — Placar de verdade: linha de base e rodada 1 de correções

**Busca** (316 pedidos, oráculo ao vivo, juiz gpt-6-sol, Lia em gpt-6-luna; `evals/results/search-2026-10-07-*.json`):

| | baseline | + busca ao vivo (`LIA_LIVE_SEARCH=true`) |
|---|---|---|
| 1ª opção errada | 1,0% | 1,4% |
| precisão dos itens | 97,8% | 97,9% |
| cobertura (achou quando existe) | 85,8% | **92,6%** |
| honestidade (disse "não achei" quando não existe) | 96,3% | 96,0% |
| tempo p50 / p90 | 7,0 s / 9,7 s | 9,4 s / 12,1 s |

Achado importante: a primeira rodada (14% de 1ª opção errada) foi medida com a IA da Lia FORA DO AR
(OpenAI sem crédito → fallback determinístico). Com IA funcionando a precisão é 97,8%. **Crédito zerado = Lia
mostrando produto errado** (bola de tênis → bola de futebol). Ficam de fora da conta os pedidos em que a IA
falhou (`ia_indisponivel`). 11 timeouts do rerank a 6 s → agora espera 10 s.

**Conversas** (40 cenários): baseline 50% limpos, 65% objetivo cumprido, 22,5% produto errado, 12,5%
promessa falsa, 22,5% beco sem saída. Corrigidos com teste que FALHA sem a correção
(`tests/placar-2026-10-07-conversas*.test.ts`): escolha com eco do nome ("vou no 1, Omo 1,4kg"),
" / " separando itens (quantidade vazava), "tenta de novo"/"qualquer marca"/"pode tentar uma Wilson?"
depois de "não achei", "não gostei dessas, quero da Dove", orçamento do presente ("uns 100 reais" se
perdia), lugar de entrega virando item, 2º pedido de atendente repetindo o texto, "tira X, por favor"
(virava saudação no lugar do total), "trocar endereço — <endereço>", "2 litros de leite"/"12 ovos"
recusados pela IA, "outras" trazendo outro tipo de produto, frete mostrando "total".


## 07/10/2026 — Placar de verdade montado; crédito da OpenAI esgotou

- Montado: `evals/` (316 pedidos de busca, 40 cenários de conversa), oráculo ao vivo, juiz gpt-5.5,
  Postgres embutido próprio. Smoke: busca "carregador usb c" mostrou só cabos (existia carregador).
- 1ª rodada (parcial): 1ª opção errada em ~14% dos pedidos, honestidade 53% (mostra algo quando não
  existe), 1 vazamento de remédio (pomada p/ assadura). Detalhe e causas em
  `evals/results/search-2026-10-07-parcial-sem-credito.json`.
- **A conta OpenAI ficou sem crédito no meio** (`insufficient_quota`): vale também para a Lia em
  produção (extração e rerank caem no fallback). Sem crédito não dá para fechar a linha de base nem
  medir o conserto.
- Pronto e testado (7 testes): busca ao vivo opt-in `LIA_LIVE_SEARCH`.


## 06/10/2026 (fim da tarde) — Varredura concluída: tudo no main, suíte 887/887

Entraram os 4 corretores (pós-pagamento, cadastro/endereço, escolha/cesta, busca/frete) e a
rodada final ao vivo. Além da entrada de cima: pedido + endereço na mesma mensagem separa os
dois; CEP solto de cliente cadastrado pergunta antes de trocar; cidade do CEP divergente pede
confirmação; CEP com espaço/ponto; item depois do total soma (não apaga a cesta); quantidade
por texto ("quero 3", "6x", "tira um"); "na verdade quero o 2" troca a opção e não ressuscita
pedido cancelado; frete de uma loja = uma entrega (VTEX devolvia frete inteiro por linha);
produto por peso mostra a unidade (~180 g) e kg vira unidades; remédio não casa só pela dose;
básicos (detergente, açúcar, sabão em pó) com reserva quando a Mambo derruba SKUs; pack/fardo;
presente; matcher exige o produto (1ª palavra) — "cottage Yorgus" não vira iogurte.
Testes: `tests/feedback-2026-10-06-{varredura,pos-pagamento,cadastro,escolha,busca}.test.ts`,
golden 51/51. Ainda não deployado.

## 06/10/2026 (noite) — Busca, quantidade e frete (teste adversarial)

Corrigido com teste (`tests/feedback-2026-10-06-busca.test.ts` + 15 casos novos no golden):
- **Frete da cesta = uma entrega por loja**: SLA comum de menor total; a simulação da VTEX às vezes
  devolve o frete inteiro em CADA linha (Swift: 17,90 + 17,90 — medido ~1 em 3, também no
  orderForm) e isso agora vira um frete só (conferido com o item sozinho). O comprador escolhe a
  mesma SLA comum e reenvia o endereço até 3x quando a cesta volta sem rateio.
- **Vendido por peso**: o card diz "Banana Nanica (unidade ~180 g)" (VTEX `unitMultiplier`, lido
  na checagem ao vivo); "2kg de banana" = 11 unidades com aviso. O preço mostrado é por unidade.
- Remédio: dose sozinha não casa ("ibuprofeno 600mg" ≠ Sintocalmy 600mg); dose pedida é identidade.
- Tamanho só filtra dentro do produto pedido (ração de gato não vira de cachorro); reserva quando
  a loja derruba os primeiros candidatos (Mambo recusa ~metade dos skus para o CEP); sabão em pó ↔
  lava roupas em pó, xampu, caixa de leite; "2 litros de leite" = 2× 1 L; ovos/caixas arredondam
  para cima; pack/fardo só packs (ou N latas soltas); presente sem produto vira categoria
  (mãe → perfume feminino, menino 5 anos → brinquedo), sacola nunca é o presente; vitrine
  confere a quantidade pedida; loja sem resposta ganha 2ª tentativa.
- Fica aberto: "óleo" sozinho ainda pode dar "não achei" quando a IA recusa os óleos não-cozinha
  da 1ª leva; álcool sem confirmação de idade (decisão do dono).

## 06/10/2026 (tarde) — Varredura de cliente novo: ~600 conversas, correções em lotes

5 agentes testadores (cadastro, quantidade/busca, escolha/cesta, pagamento/pós-venda, conversa
fora do roteiro) e 4 corretores em worktree. Corrigido e no main: 12 ovos, "pix" como nome,
"tem açaí?", "cartão" na escolha, frete com número, CPF fora de hora, trava do Pix de saída,
cobrança aberta que morria por mensagem solta, atendente/reclamação avisando o dono, textos
falsos (margem, quem recebe o Pix, nota, "separando"), golpe/identidade, uber/pedido vago,
"ok"/"sim" com cesta, cancelamento pago com confirmação, status com loja/prazo/endereço.
Em andamento: cadastro/endereço (pedido+endereço juntos, laço do CEP, CEP solto), escolha/cesta
(item depois do total apagava a cesta, quantidade por texto, "na verdade quero o 2" ressuscitando
pedido cancelado), busca/frete (frete dobrado na mesma loja, produto por peso, remédio por dose,
básicos não achados). Relatórios em scratchpad da sessão; resumo em PENDENCIAS.

## 06/10/2026 — Fora da VTEX: Magento, Wake e Salesforce sondados (seco, sem pedido)

Pedido do dono: sondar Divinho, Havan e as plataformas "provável/talvez". Nenhuma repete a VTEX
(convidado + Pix + sem captcha, até o fechamento):
- **Magento:** Divinho (bebidas) tem carrinho, frete e `pagarme_pix` por API, mas reCAPTCHA
  invisível no fechamento → alto. Havan desligou checkout de convidado (exige conta) e, no item
  testado, só oferece retirada. Grand Cru (Next.js sobre Magento) não sondável daqui (filtro de
  rede "álcool" + rate limit). Droga Raia/Drogasil/Riachuelo: Akamai 403. Único limpo: Drogaria
  Minas Brasil (MG, `openpix_pix`, sem captcha, frete por transportadora) — fora de SP/RJ.
- **Wake (ex-Linx):** um GraphQL único para todas as lojas, token público, Pix configurado em
  todas, mas endereço/pagamento/fechamento exigem cliente logado (uma conta com CPF/CNPJ por
  loja). Lojas achadas: Polipet, Soneda, Balaroti, moda. Sem mercado nem bebidas.
- **Salesforce Commerce Cloud:** só a Puma vai até a lista de pagamentos com Pix (Payrails, Pix
  nasce depois do pedido); L'Occitane exige login, Sephora tem Akamai, Cacau Show pede CPF cedo e
  não lista Pix; Avon declara `guestCheckout:false`.
Conclusão: a VTEX segue sendo a única base que fecha sozinha. Scripts secos para repetir:
`scripts/magento-api-probe.mts`, `scripts/wake-api-probe.mts`, `scripts/sfcc-api-probe.mts`
(endereço lido do config privado; JSON em `.retail-buyer/probes/`).

## 06/10/2026 — Prezunic fecha pedido real por API no Rio

2º `--buy` em Copacabana (2x sabão líquido 5L, acima do mínimo de R$80): pedido PZ2456030,
R$103,88, Pix copia-e-cola obtido (recebedor Cencosud, formato Mercado Pago), não pago. Ligado no
código e conta de compra ativa em produção. Os dois mercados do Rio só aparecem depois que o dono
somar `zonasul,prezunic` em `LIA_AUTO_PURCHASE_STORES` e houver deploy.

## 06/10/2026 — Medição: dá pra abrir outros estados? (decisão: só SP e RJ)

Simulação de frete das 39 lojas por API num CEP de cada uma das 27 capitais (só consulta).
- Farmácia rápida em quase todo o país: Pague Menos 1–2h em quase todas as capitais; Extrafarma
  "Expressa" 2h no Norte/Nordeste; Drogaria SP/Pacheco 30 min–1h no Sudeste, Centro-Oeste e BA.
  Exceção: Acre (1 dia).
- Mercado no dia: só Americanas (R$12,90, sai da loja física) em todas as capitais menos MS, mas o
  catálogo colhido tem só ~16 itens de mercearia básica. Supermercado de verdade só em SP e RJ.
  Candidatos sondados a seco: **GBarbosa passou até o Pix em Aracaju e Salvador (entrega 2–4h)**;
  Super Nosso (BH) e Giassi (SC) entregam rápido mas sem Pix (fora da arquitetura); Super Muffato
  (Curitiba) e Rosário (Brasília) recusaram os CEPs testados; Condor e Angeloni sem catálogo
  público; Bretas sem item disponível.
- Pet: Cobasi 1–4h no Sudeste, Sul, Centro-Oeste e boa parte do Nordeste; 18–35 dias em AM, AP,
  RR, AC, RO, PI e MA.
- Lojas com algo em até 1 dia: SP 17, RJ 10, PR 8, MG 7, ES/GO/MT 6, DF/BA/PE 5, Norte 2–3.
- Casa, moda, livros, eletro e beleza: nacionais, 2–10 dias em qualquer lugar.

## 06/10/2026 — Motivo do cancelamento

Pedido cancelado pergunta o motivo (frete caro, produto caro, outro app, desisti, outro) e anota no
pedido. Testes: novo 3/3 + 12 arquivos de cancelamento 324/324 no Postgres local; `tsc` ok.
## 06/10/2026 (tarde) — Estorno automático: 6h sem compra (era 24h/48h)

Pedido pago sem compra na loja há 6h volta sozinho ao cliente (regra no topo do AGENTS.md).
Antes do deploy, só um pedido se encaixava: #5GUY4Z (Cobasi, R$21,50, 15/09), que fica fora
porque o Pix da loja foi pago (`pix_paid`, sem número de pedido) — **reconciliar à mão com a
Cobasi**. Testes: manual-queue, paid-order-watchdog, plan-b, operador-humano, vtex-runner,
purchase-execution 47/47 no Postgres local.


## 06/10/2026 (tarde) — Nome da loja em toda opção; cartão sai "LIA DELIVERY" na fatura

Dono liberou o nome da loja: texto, card e carrossel mostram "Mambo · 1 dia útil" no lugar de
"prazo da loja: 1 dia útil". Cobrança de cartão (Mercado Pago e Pagar.me) leva
`statement_descriptor` "LIA DELIVERY" (`LIA_STATEMENT_DESCRIPTOR` troca). Pix: a chave já é a do
CNPJ; o nome que o banco mostra é o do titular (MEI = nome do dono) — caminhos em PENDENCIAS.
Frete: dono decidiu não mexer. Suíte inteira 763/763 no Postgres local.

## 06/10/2026 — Zona Sul fecha pedido real por API no Rio; Prezunic pede mínimo de R$80

`vtex-api-probe.mts --buy` em Copacabana com o CNPJ digitado pelo dono: Zona Sul criou o pedido
(grupo 1666863616742, R$20,59, Pix copia-e-cola obtido, não pago) → ligado no código e conta de
compra ativa em produção. Prezunic respondeu ORD079 (carrinho mínimo R$80); `minOrder` 80 no
conector e novo teste acima do mínimo em andamento. Falta o dono somar as lojas em
`LIA_AUTO_PURCHASE_STORES` (variável sensível) e o deploy.

## 06/10/2026 — Vitrine sem opção que não fecha; frete da vitrine igual ao cobrado

Só entra na vitrine opção que a loja confirmou para o CEP (sem operador, a não confirmada virava
beco no "pagar": Casa & Vídeo e Obramax dos testadores); nada confirmado → "não consigo comprar
agora". Simulação ao vivo por SKU (o rateio do VTEX fazia a vitrine mostrar R$2,03 e o total
cobrar R$4,90). Testes focados 417/417 no Postgres local; `tsc` ok. Detalhe no AGENTS.
## 06/10/2026 — Token do agente no /ops; #5VBIXY estornado

#5VBIXY (Mercado Livre, R$56,43) estornado pelo dono no /ops ("Compra não realizada", MP refund
3421002000). Para o agente agir no /ops sem o dono abrir o painel: `LIA_AGENT_OPS_TOKEN` (operador
pelo header `x-ops-key`, sem nenhuma ação de dinheiro). Regra no topo do AGENTS.md.
Pendente à parte: auto-estorno do pedido `…guy4z` falhou às 10h50 ("Compra enviada ou com
resultado desconhecido — reconcilie a loja antes de estornar").


## 06/10/2026 — Retorno dos testadores: 12 defeitos de conversa corrigidos (e0e7e9e, 0141ee7)

Família e grupo "Teste zap" testaram de manhã. Conversas reproduzidas localmente com a IA da
produção (banco local, telefone de teste). Corrigido: "apto 4" virava busca de placa; CPF não
pedido quando o CEP vinha depois da rua; "de onde vc compra?" sem resposta; "só amora" virava
busca e "só essa" tirava a amora; "veja se tem kerasys de coco" repetia o mesmo shampoo; 2
produtos numa mensagem eram tratados como estreitamento; "qual a loja?" vago e "faz
comparativo?" com resposta falsa; tubo com 4 bolas trazia o de 3; Euthyrox com "me diz outra
marca"; "leite nude" virando Ninho (prompt); estorno chegando antes do "Pagamento confirmado";
2ª extração por IA na frase do roteador. Suíte inteira 761/761 no Postgres local; repetição com
a IA real: 3–13 s por conversa inteira (antes, turnos de mais de 45 s).
Já resolvido por outras sessões no mesmo dia: Mercado Livre desligado, vitrine só com loja de
compra automática, carrossel v4/v5, diagnóstico da Asaas.

## 06/10/2026 — Asaas recusa o Pix de saída: "conta não aprovada" (bankAccountInfo PENDING)

Pedido da Mambo (job cmuwozhi00005kevwy7gt5v4c, R$46,66) às 10h06: o decode do Pix da loja
voltou `Asaas 400 invalid_action: Assim que você tiver sua conta aprovada, você poderá utilizar o
Pix no Asaas`. Job cancelado e cliente estornado sozinho no MP (refund 3420560228). Na véspera
(05/10 13h49) o Asaas pagou R$41,70 à Mambo normalmente. Painel: cadastro/documentos/aprovação
geral "Aprovado", chave Pix ativa, saldo R$608,21, nenhum aviso. Diagnóstico pela API (rota nova
só de leitura `GET /api/ops/asaas-status`, commit 1799e4e): `commercialInfo/documentation/general
= APPROVED`, **`bankAccountInfo = PENDING`**, decode de uma cobrança de R$1 ainda recusado às
10h52. Enquanto isso, toda compra automática falha no Pix e vira estorno.
Feito pelo dono no mesmo dia (sem efeito na API até 12h05): conta bancária MP LIA (mesmo CNPJ)
cadastrada e "Aprovada", selfie validada (FACEMATCH), token no app ativado, chave Pix nova
(9c0d204e…). A tela Transferências do painel diz "Você poderá solicitar transferências quando a
aprovação do seu cadastro for concluída" (bloqueia TED também), contradizendo a Situação cadastral.
Só o suporte humano do Asaas destrava; o robô não tem procedimento.

## 06/10/2026 — Carrossel v4/v5 recusado na criação: card com 3 quebras de linha

O cron `/api/cron/meta-templates` dava ERRO nos 8 templates `vitrine_carrossel_v4/v5_{2..5}` a
cada hora (Graph 400, subcode 2388245, "exceeded maximum amount of line breaks"). O card do v4 tinha
3 quebras; agora tem 2 (a instrução "Toque abaixo para adicionar." foi para a linha do prazo).
Os nomes v4/v5 seguem livres porque nada chegou a ser criado. Testes: `tests/carousel.test.ts` +
`tests/carousel-card-limit.test.ts` 16/16 no Postgres local; `tsc` ok. Commit 92b2f2b, deploy de
produção READY às 10h06. Cron das 10h17: os 8 criados, todos **PENDING** (nenhum ERRO). Falta a
Meta aprovar; com o v5 aprovado o envio troca sozinho (o log das :17 mostra o status).
## 06/10/2026 — Mercado Livre DESLIGADO: vitrine é só loja de compra automática (dono)

Pedido #5VBIXY (R$56,43, pago 10:15) caiu no Mercado Livre e foi para a fila manual. Decisão do
dono: "não é pra ter Mercado Livre… é só as lojas automáticas". `LIA_ENABLE_MERCADOLIVRE=false` na
Vercel + redeploy de produção (06/10). **Revoga a exceção "Mercado Livre é exceção a preservar"**
(item 3 da regra de 25/09). Não religar sem nova decisão datada. #5VBIXY: estornar no /ops e
avisar o cliente que o item não está disponível.
**Trava no código:** `storesForShopper` (`src/lib/store-areas.ts`) só deixa na busca loja que está
em `LIA_AUTO_PURCHASE_STORES` (lista vazia em dev/testes não filtra). Loja nova = entrar nessa lista,
senão não aparece. Teste em `tests/store-areas.test.ts`.

## 06/10/2026 — Rio de Janeiro ligado (SP + RJ) com trava de área por loja

Regra e detalhes no topo do AGENTS.md. Medição: simulação de frete das 37 lojas em 11 CEPs — só
Mambo, Covabra, Savegnago e Swift são regionais; sondagem seca em Copacabana: Drogaria SP e Pacheco
30–60 min, Americanas no dia/2h, Zona Sul no dia, Prezunic 2h, Mambo não entrega. Conferência ao
vivo sem banco: "arroz 5kg" no Rio mostra Zona Sul/Prezunic e nunca Mambo/Covabra/Swift; em SP
nunca aparece mercado do Rio; em Guarulhos o Mambo some. Lista de espera fora de SP tinha 40
contatos, 39 de telefones de teste dos evals (só 1 real, Vila Velha). Suíte local completa 742/742.

## 06/10/2026 — Cadastro no primeiro contato por formulário do WhatsApp

Commit ac79556, publicado no deploy do push de 1fad7e1. O 1º contato manda um formulário nativo
(nome completo, CPF, CEP, número, complemento) no lugar de "endereço completo" + "nome e CPF" por
texto. Regra e detalhes no topo do AGENTS.md. Testes: `tests/signup-form.test.ts` 21/21 e
regressão do caminho em texto (medicine-chat, manual-concierge, lia-copy, carousel, adapter,
compra do lenço) 148/148 no Postgres local; `next build` + guarda de emoji ok numa cópia isolada.
O cron das 10h17 publicou o Flow `cadastro_lia_v1` (id 930932673109335) sem erro de validação; a
partir daí todo 1º contato recebe o formulário. Falta um teste real com o "cadastro" do dono.

## 06/10/2026 — Boas-vindas do WhatsApp: um convite só

Os botões de sugestão da 1ª conversa ("Quero um chá", "Ração pro meu cachorro"…) pareciam
estranhos (dono). Agora é um só: **"Peça qualquer coisa 🛒"**, lido como "quero fazer um pedido"
(`want_items`). Aplicado na Meta pelo dono em 06/10 (`/api/ops/meta-setup?action=welcome` → ok).

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

## 29/09/2026 (noite) — Remédio isento no chat implementado, desligado por padrão

Commits 5698ef5 e dd4570b + rotina semanal. Com `LIA_MEDICINE_MIP=true`: vitrine de remédio sem
receita em texto (1.252 isentos da Drogaria SP, 798 da Pague Menos confirmados por código de
barras), taxa da Lia de R$4,90 em linha própria, nome + CPF pedidos uma vez, compra na farmácia
no CPF do cliente com e-mail próprio por CPF e aborto com estorno se a loja devolver outro
documento, NF-e encaminhada ao cliente, seção nos termos e na privacidade. Receita e controlado
seguem recusados. Testes: `tests/medicine.test.ts` (10) e `tests/medicine-chat.test.ts` (5,
conversa com banco); suíte inteira 701/701 no Postgres local e `next build` ok numa cópia
isolada. Regra canônica no topo do AGENTS.md. O 1º lote quebrou o build do /ops (node:crypto em
`medicine.ts`); a outra sessão corrigiu em 34f315e com SHA-256 puro.

## 29/09/2026 (noite) — Varredura em massa terminou: 530 lojas VTEX abertas de 2.158

Contas VTEX descobertas pelo índice do Wayback (2.673; 2.157 sondadas após filtro de teste/país).
Sondagem seca no endereço do dono: **530 abrem até o Pix**. Agrupadas por nome (arquivo na pasta
temporária, lido pelo dono): farmácia 13, mercado 7, pet 16, beleza 8, casa 27, bebê 6, livros 7,
esporte 4, moda 70, sem setor no nome 372. Limite real que aparece agora: o modelo de catálogo
estático em `src/lib/stores/*-catalog.ts` (~1 MB por 5 mil itens, colheita de minutos por loja)
não escala para centenas de lojas. Para a cauda longa, o caminho é busca ao vivo na API pública
de catálogo da VTEX por loja na hora da cotação (não é navegador remoto), guardando só a lista
de lojas e o domínio. Decisão pendente do dono. Deploy 34f315e corrigiu o build (node:crypto
em `medicine.ts`, commit da outra sessão, no caminho do `/ops`).

## 29/09/2026 (tarde) — Varredura em massa: +18 lojas ligadas, elenco por API vai a 37

Varredura de 151 domínios (dono leu o CSV) → 24 abertas até o Pix; lote 1 fechou 16 de verdade
(Aramis, Capodarte, C&A, Casa Santa Luzia, Drogaria Catarinense, Drogarias Pacheco, Extrafarma,
Farmácia Indiana, Fila, Livrarias Curitiba, Motorola, Osklen, PBKids, Tok&Stok, Under Armour,
WePink) e o interior de SP fechou Savegnago (Ribeirão) e Covabra (Campinas), ambas com mínimo
R$30. Tudo ligado por `scripts/add-vtex-store.mts` (conector, registry, checkout, frete, e-mail,
allowlist, rotina, workflow, golden, load-env + colheita): 18 catálogos, 0 falhas. Fora: Dengo,
Dermage, Electrolux, São João (ORD062), Reserva (pedido sem Pix no callback), Atacadão (mínimo
R$250). Sondagem ganhou `--domain`, `--cep` (regional dentro de SP), janela de entrega automática
e termos de busca por setor. Descoberta em massa: 2.673 contas VTEX pelo índice do Wayback
(`*.vtexcommercestable.com.br` / `*.vtexassets.com`); varredura seca de 2.157 em curso (~1 em 5
abre). Suíte focada 77/77. Falta: conta de compra em produção para as 18 (script --db) e
`LIA_AUTO_PURCHASE_STORES` na Vercel com as 37.

## 29/09/2026 — Era o telefone: 7 lojas religadas, elenco por API vai a 19

`testa-cnpj-telefone.sh` (dono): CNPJ + telefone fecha na Kopenhagen e na Casa & Vídeo. Logo, o
CHK0223 das 7 lojas era só o perfil de convidado sem telefone; o CPF não é necessário. O
comprador do servidor agora manda `phone` no `clientProfileData` (`LIA_BUYER_PHONE` ou, sem
ele, o telefone do cliente). Religadas: Kopenhagen, Casa & Vídeo, Época, Polishop, Zona
Criativa, Obramax, Telhanorte. Golden volta a exigir carregador USB-C (Casa & Vídeo). Fora
só Martins Fontes e Mondial (ORD062). Suíte focada 65/65. Falta: dono atualizar
`LIA_AUTO_PURCHASE_STORES` na Vercel com as 19 lojas e redeploy.

## 29/09/2026 — Com CPF + telefone, 7 das 9 lojas desligadas fecham por API

Teste do dono (`testa-cpf.sh`, pedidos sem pagamento): Kopenhagen, Casa & Vídeo, Época,
Polishop, Zona Criativa, Obramax e Telhanorte criaram pedido com Pix dinâmico com URL
(Stone/Pagar.me, MagaluPay, BTG). Martins Fontes e Mondial seguem em ORD062 "Acesso negado"
(provável exigência de login). O 1º teste com CPF caiu em ORD007 "campo telefone inválido":
perfil de pessoa física exige telefone (a sondagem não mandava; com CNPJ a VTEX não exigia).
Falta isolar a causa: se CNPJ + telefone também passa, produção só ganha o telefone; se só
CPF passa, essas 7 lojas precisam de comprador CPF (documento do dono) + telefone no
`clientProfileData` do comprador do servidor. Atenção: em 4 delas o recebedor do Pix é
"Pagar Me Instituição de Pagamento" (subadquirente), não a loja.

## 28/09/2026 (noite) — Americanas entra no elenco: 21ª loja por API, 7.532 itens, entrega em 2h

Fechamento real provado por API (pedido 1665078885691 sem pagamento, Pix dinâmico da Stark Infra
com URL). Conector `src/lib/stores/americanas.ts` (mínimo R$30 = ORD079 da loja; sem remédio:
deny na colheita + `withoutMedicine`), catálogo só do seller próprio (`--seller=1`, flag nova da
colheita) em 15 categorias do dia a dia + 26 termos de busca: papelaria 1.965, beleza 871,
brinquedos 771, livros 692, alimentos 621, cama/mesa/banho 524, utilidades 512, limpeza 498,
eletroportáteis 280, saúde 265, cabelos 188, bebês 188. Ligada no registry, checkout por API,
frete ao vivo, leitor de e-mail, rotina semanal e golden. Suíte focada 83/83. Falta: conta de
compra em produção e `americanas` em `LIA_AUTO_PURCHASE_STORES` na Vercel; 1ª compra real.
Recebedor "Americanas s.a - em Recup" (recuperação judicial): acompanhar pós-venda.

## 28/09/2026 (fim de tarde) — Testes de outros caminhos: Americanas aberta por API; UCP vivo em Shopify BR

Sem criar pedido: **Americanas é VTEX e passa até o Pix** (fechamento real pendente, dono roda).
Divinho é VTEX sem Pix; Mundo Verde não entrega em SP; Kalunga (Wake) tem token no servidor.
**UCP (Google/Shopify) já responde em lojas Shopify brasileiras** sem cadastro: com o perfil de
agente da Lia publicado em `/.well-known/ucp-agent.json`, busca e `create_checkout` funcionaram
e a Dailus calculou frete real para o endereço de sondagem; travou só no CPF/CNPJ. Pagamento por
UCP é só cartão/Google Pay (sem Pix) — precisaria de cartão da empresa. Teste com CPF nas 9
lojas VTEX que recusam ainda depende do dono rodar. Detalhes em
[docs/pesquisa-formas-de-compra-2026-09-28.md](docs/pesquisa-formas-de-compra-2026-09-28.md).

## 28/09/2026 (noite) — Decisão: continuar no B2C atual

Muse (Meta) lançado nos EUA em 08/09, sem data pro Brasil. Pivot pra trilho de compra/B2B
analisado em [docs/pivot-longo-prazo-2026-09-28.md](docs/pivot-longo-prazo-2026-09-28.md) e
descartado pelo dono (lojas não cobrem lista de empresa; muito distinto do atual). Segue o
B2C. Registro canônico no AGENTS.md.

## 28/09/2026 (tarde) — Pix loja a loja: 11 passam, 9 desligadas

Pedido real sem pagamento em cada loja (dono rodou; vencem sozinhos), lendo o Pix emitido:

| Loja | Pix | Resultado |
|---|---|---|
| Cobasi, Pague Menos, Drogal, Ri Happy (Tuna) | Itaú com URL | passa |
| Drogaria SP | Adyen com URL | passa |
| Oxford | Bradesco com URL | passa (campo 59 do código traz "LIA DELIVERY"; o recebedor real vem do decode) |
| Philco (Britânia) | Cielo com URL | passa |
| Mambo, Swift, Brinox, Creamy | Mercado Pago (chave+valor+txid) | passa (Mambo pago de verdade) |
| Martins Fontes, Mondial | — | ORD062 "Acesso negado" no `transaction`: DESLIGADAS |
| Obramax, Telhanorte, Época, Casa & Vídeo, Kopenhagen, Polishop, Zona Criativa | — | CHK0223 "pagamento não autorizado", sem Tid: DESLIGADAS |

Seis lojas dão desconto no Pix (1–7%); a sondagem mandava o total cheio e a loja devolvia 200
sem pedido. Corrigida em 63eece5 (produção já usava o valor do Pix). Desligadas = opt-in no
registry (`LIA_ENABLE_<LOJA>=true` religa). Sem Casa & Vídeo não há carregador USB-C: o golden
exige "não tenho". Swift/Creamy cobram em Mercado Pago de apelido; se o documento for CPF, a
1ª compra pede o toque do dono. Hipótese para o CHK0223 (não testada): conector de Pix que
recusa pagador CNPJ.

## 28/09/2026 (tarde) — PROVADO: primeira compra 100% automática, sem nenhum toque humano

#LYAWQ8 (lenço Huggies na Mambo, R$31,19 no Pix Mercado Pago do cliente). 13:41:30 pago →
13:41:47 pedido 1664941370430-01 criado na Mambo → 13:41:50 Pix da loja (formato Mercado
Pago) conferido, recebedor SUPERMERCADOS MAMBO LTDA aprovado sozinho → Asaas pagou R$29,80 →
Mambo: `payment-approved`, entrega hoje 15h–18h → 13:44:38 Lia registrou a compra
(`retailer_preparing`). Ninguém tocou em nada.

O cartão do cliente foi recusado antes (e em #E0RH3W também) com a mensagem "Transação
aprovada com sucesso". O registro só guardava essa frase; agora grava o veredito inteiro do
Pagar.me (status do pedido, da cobrança, da transação, antifraude e gateway).

## 28/09/2026 (manhã) — Pix da loja: formato Mercado Pago liberado e recebedor novo sem toque

2ª compra na Mambo (#E0RH3W, R$35,68) também foi estornada sozinha, agora com o motivo gravado:
a recusa era da nossa guarda de "Pix dinâmico". A Mambo cobra pelo Mercado Pago
(`acquirer: MercadoPagoV2`), que emite o Pix do pedido com chave + valor + txid, sem URL.
Com o OK do dono: (1) esse formato vale quando o código vem da API de checkout da loja, com
valor embutido igual ao conferido e txid real (c0f578a); (2) recebedor novo com CNPJ nesse
caminho entra sozinho na allowlist e o dono recebe um aviso, podendo bloquear no /ops. CPF ou
Pix lido de tela continuam pedindo "Pagar e memorizar". O Asaas já pagou um Pix de loja de
verdade (Cobasi, 15/09). Testes de pagamento 17/17.

## 28/09/2026 — Carrossel volta a mostrar 5 opções; sai o "Preço garantido por N min"

O dono perguntou por que os cards traziam só 3 opções. Os dados mostraram que o carrossel
estava ligado e sendo entregue (5 envios em 10 dias, nenhum `meta-status-failed`), mas os
envios de 25/09 a 28/09 levaram só 3 cards. A causa era um `slice(0, 3)` fixo no
`rerankShoppingOptions`, que sobrou de 06/08: desde 10/09 o prompt pede até 5, e o corte
jogava fora o resto. O único carrossel de 5 (23/09) veio do fallback determinístico. Reproduzi
com as lojas de produção: lenço, shampoo e ração saem com 5; água de coco (3) e cabo USB-C
(2) saem com menos porque não há mais produtos que sirvam. Teste de regressão em
`tests/search-rerank.test.ts`. Botões: o card do carrossel já usa o teto da Meta (2) e o card
solto também (3: Adicionar / Ver detalhes / Outras opções). A mensagem "Preço garantido por
N min…" depois da cotação foi removida a pedido do dono.

Regra fechada com o dono no mesmo dia: se existem 5 opções do que foi pedido, mostra as 5;
se existem menos, mostra as que existem; nunca completa com outra coisa. O prompt agora
completa primeiro com produtos distintos e depois com variantes (a água de coco passa a
incluir os sabores). Também proíbe quebrar a marca pedida só para preencher vaga: "ração
golden" completava a 5ª vaga com Dog Chow e agora sai com 4 Golden. Golden set 33/38 contra
32/38 do prompt anterior, com as mesmas falhas antigas. A variação foi resolvida em seguida. O prompt pedia "escolha até N", e com isso a IA
decidia o tamanho da vitrine. Agora ela lista todos os candidatos que são o produto pedido
e o código monta os até 5 (`diversifyOptions`: distintos primeiro, variantes depois). A
segurança continua com a IA, porque item reprovado nunca volta. Medido 3 vezes por busca:
lenço, shampoo e leite sem lactose 5/5/5 (todos sem lactose); ração golden 4/4/4, só Golden;
água de coco 3/3/3, porque a IA julga de forma estável que a Sococo saborizada não é água
de coco pura. Golden set 33/38, igual ao anterior.

## 28/09/2026 (madrugada) — 1ª compra na Mambo: pedido criado, Pix da loja não pago, cliente estornado sozinho

Pedido #YYHUGW (2x lenço Huggies, R$48,92 no cartão Pagar.me). A Lia criou o pedido na
Mambo (1664831370279-01, janela amanhã 12h–15h), mas a captura do Pix da loja falhou antes
de qualquer pagamento: nenhum PixPayout, nenhum real saiu do Asaas. O motivo não era gravado
e o código da loja não é mais recuperável (callback agora devolve 204). Corrigido em af84adc:
a recusa grava `PIX_CAPTURE_REFUSED` + mensagem no PurchaseAttempt e loga
`[vtex-runner:pix-capture-refused]`; a varredura cancela o job, solta a reserva de gasto e
estorna o cliente. Provado em produção: cron das 02:58 `refunded: 1`, pedido `refunded`,
Pagar.me estornado R$48,92. Hipótese principal: o decode do Asaas no QR dinâmico da loja
(nunca pago de ponta a ponta por Asaas ainda). A próxima compra real mostra o motivo.

Também em af84adc: "✅ Ajustei: 2x …" virou mensagem com botões (Pagar / Adicionar mais /
Cancelar, texto como fallback); card do carrossel no modelo v4 sem "(contado da compra)" e
com prazo compacto ("em até 16h (amanhã,…" saía cortado). O v4 é criado pelo cron horário
de templates e só entra quando a Meta aprovar.

## 28/09/2026 — Refresh semanal provado no GitHub; busca medida no elenco de produção

1º run do `refresh-precos.yml` recolheu 19/20 lojas (~35,8 mil itens, ~2 mil preços mudaram)
e os testes BARRARAM o commit: Drogaria SP e Época seriam regravadas com o prefixo de SKU
errado (o script passava a chave como prefixo). Corrigido (prefixo por loja + recusa se o
prefixo mudar). Casa & Vídeo voltou vazia no runner do GitHub; a guarda manteve o catálogo.
O golden de busca passou a medir o elenco REAL de produção (20 lojas por API) e ganhou 4
regras com caso (sinônimo veicular↔carro; "doce de leite"/"creme de leite" não são leite;
"leiteira" não é leite; especificação técnica pedida — usb, usb-c, hdmi, bluetooth — é
obrigatória). Na rotina ele é informativo (drift de catálogo não trava preço); os testes de
segurança (ANVISA, catálogo, checkout, frete) bloqueiam. Suíte 681/681.

## 27/09/2026 (noite) — Sem operador de verdade: "não tem" na hora, entrega precisa, preço vivo, refresh semanal, mínimo levantado

Pedido do dono: (3) sem operador, o que não tem é dito na hora; (4) preço revisado toda
semana; pedido mínimo de cada loja; "saiu pra entrega" preciso. Feito:

- **"Não tenho X" na hora (ca10574).** Quando a loja não confirma estoque/entrega no
  fechamento, o pedido não vai mais para "operador cota": é cancelado, o cliente ouve o que
  ficou de fora e o resto fecha na mesma resposta. Falha sem culpado mantém a lista.
  `LIA_OPERATOR_QUOTE=true` volta ao caminho antigo (só o harness de teste usa).
- **Entrega precisa (fb6d507).** Novo estágio "enviado pela loja" (e-mail "a caminho",
  "enviado", "transportadora"; rastreio com eventos) → "📦 A loja enviou seu pedido —
  previsão: até X". "Saiu pra entrega" só com evidência de última milha. Leitor novo
  (`src/lib/purchase/vtex-status.ts`, cron store-mail) lê o pedido na loja com os cookies do
  fechamento: faturado (aviso 1x), enviado, saiu, entregue, cancelado pela loja (alerta ao dono).
- **Preço vivo no fechamento (a614d84).** A simulação da loja devolve o preço de agora; o
  total sai com ele e o cliente é avisado da mudança. Catálogo velho deixa de virar estorno.
- **Refresh semanal (a614d84).** `.github/workflows/refresh-precos.yml`, segunda 06h:
  recolhe as 20 lojas, tsc + testes de catálogo/busca/ANVISA, commit e deploy. O script
  colhe em arquivo temporário e não troca catálogo que encolheu >40%.
- **Pedido mínimo:** nenhuma das 20 lojas publica mínimo e nenhum checkout tem trava de valor
  (18 scripts de checkout lidos). Provado sem mínimo até R$10–14: Drogaria SP, Cobasi, Pague
  Menos (pedidos reais 25/09). Mambo: o widget de mínimo do carrinho está configurado em 0; um
  site de cupons cita R$70 (fonte fraca). Todas ficam com mínimo 0; se alguma recusar o
  fechamento por valor, o estorno automático protege o cliente e o valor vai para o conector.

## 27/09/2026 — Eletro e casa: +5 lojas por API (Philco, Mondial, Oxford, Polishop, Obramax)

Pesquisa de categorias (Nuvemshop/Confi-Neotrust 2026): moda é 43% dos pedidos, depois eletro,
saúde & beleza, casa & jardim. Sondagem dos líderes de cada categoria no endereço do dono: os
grandes de moda e eletro (Renner, C&A, Dafiti, Netshoes, Centauro, Shein, Magalu, Casas Bahia,
Amazon, Kabum, Fast Shop) barram programa; Farm, Animale e Brastemp só cartão. Entraram, a
pedido do dono, as de eletro e casa que fecham com Pix: Philco (460 itens, ~5 dias úteis),
Mondial (472, ~6), Oxford Porcelanas (1.215, ~8), Polishop (144, ~3), Obramax (2.048, ~2).
Ficaram de fora por decisão: Reserva e Osklen (moda de grife, 5–7 dias) e PB Kids (13 dias).
Vitrine por API: 20 lojas, ~38 mil itens.

## 27/09/2026 — Prazo agendado legível; mercado no mesmo dia existe (Mambo, pedidos até o começo da tarde)

Dono: não urgente (livro, panela) pode levar dias se o cliente vir o prazo; o problema é
farmácia e mercado. Farmácia já é rápida (Drogal 30 min–3h, Drogaria SP 90 min, Pague Menos
2h). Mambo: janelas de 3h das 5h às 18h; pedido feito cedo cai no mesmo dia (domingo 19h → seg
11h–14h). Antes o cliente lia "prazo da loja: 17h" (parecia horário); agora lê "prazo da loja:
em até 17h (seg, 11h–14h)". A comparação interna segue por horas até o fim da janela.

## 27/09/2026 — Fora de farmácia/mercado: +6 lojas por API (~14 mil itens): livros, casa, construção

Pergunta do dono: a Lia só serve para farmácia sem remédio. Varredura de ~60 lojas de livros,
casa, eletro, papelaria, bebidas e moda (VTEX, Magento, Shopify). Com checkout aberto + Pix +
entrega no endereço do dono, entraram: Martins Fontes (livros, 4.054), Casa & Vídeo (casa e
utilidades, 5.079), Telhanorte (construção, 3.548, entrega agendada tratada), Brinox (panelas,
576), Zona Criativa (casa e presentes, 884), Creamy (skincare, 129). Todas conferidas com o
cliente do servidor até o Pix (cesta esvaziada). Prazos de 2 a 5 dias úteis (não é "hoje").
Fora: Hering (sem Pix); Havan/Grand Cru/Divinho são Magento (Divinho com GraphQL público —
checkout de convidado por GraphQL é o próximo tipo de plataforma a estudar); Shopify expõe
catálogo mas não fecha pagamento sem navegador. Amazon, ML, Magalu, Americanas, Leroy, Kabum,
Saraiva/Cultura não têm porta de compra. Vitrine por API: 15 lojas, ~34 mil itens.

## 27/09/2026 — Supermercado: só o Mambo fecha por API em SP; catálogo ampliado para 3.662 itens

2ª varredura (~50 redes): checkout VTEX aberto em Savegnago, Covabra, Zona Sul, Prezunic,
Giassi, Super Nosso e Bretas, mas nenhum entrega no endereço de sondagem (SP capital).
Continuam fora: Pão de Açúcar, Dia, St Marche, Emporium, Sonda, Hirota (não são VTEX abertos
ou barram), Oba (sem Pix), Carrefour (barra o servidor). Mambo recolhido com top-vendas +
buscas de itens de mercado: 1.500 → 3.662 itens (frios, congelados, mercearia, bebidas, carnes,
limpeza, padaria, hortifruti). Vitrine por API: ~20 mil itens em 9 lojas.

## 25/09/2026 (noite) — RESOLVIDO: nome público do WhatsApp agora é "Lia Delivery"

O dono re-registrou o número (POST `register` no /ops, PIN digitado por ele). Leitura da
Graph logo depois: `verified_name` = **"Lia Delivery"**, `name_status` APPROVED,
`new_name_status` NONE, `status` CONNECTED. Nome pessoal e CNPJ saíram do nome visível.
Encerrar o acompanhamento horário do nome (automação do Codex) e os casos Meta/fórum; não
reenviar pedido de nome. Regra para o futuro: toda troca de nome aprovada na Cloud API
exige re-registro em até 14 dias; o webhook agora avisa a decisão.

## 25/09/2026 (noite) — 2º pedido real (lenço, Mambo) e estorno automático provado

#DSP0Y0 (lenço Huggies, Mambo, R$31,19 Pix) foi cotado já com a janela (frete R$15,90, 17h),
mas o comprador parou em "Janela de entrega não selecionada": a VTEX guarda a janela em
`slas[].deliveryWindow`, não em `logisticsInfo[].deliveryWindow`. Corrigido em c67d6ff e
conferido contra uma cesta real do Mambo (janela, 17h, R$17,39). Antes do reenvio, o
**estorno automático** (7771255) devolveu os dois pedidos de teste às 17:38: #UY6IV9 R$18,66
(cartão, Pagar.me) e #DSP0Y0 R$31,19 (Pix, Mercado Pago) — primeira prova real da regra
"loja recusou antes do pedido → estorna na hora". Ainda falta 1 pedido de ponta a ponta com
a Asaas pagando a loja.

## 25/09/2026 (noite) — CONFIRMADO: "Lia Delivery" aprovado e não aplicado

Leitura da Graph pelo /ops: `verified_name` = nome antigo, `new_display_name` = "Lia
Delivery", `new_name_status` = **APPROVED**, `status` CONNECTED, `CLOUD_API`. A causa está
confirmada: falta só re-registrar o número (POST `register` com o PIN de duas etapas) dentro
da janela de 14 dias. O PIN é credencial do dono: ele mesmo dispara o POST logado no /ops.

## 25/09/2026 (noite) — Nome do WhatsApp: leitura do estado real no ar

Provável causa do nome antigo persistir: na Cloud API o nome aprovado só vale após
re-registrar o número em até 14 dias, e o aviso de aprovação era descartado pelo webhook.
Implantado: `/api/ops/meta-setup?action=name` (leitura), `register` por POST com PIN e aviso
ao dono no webhook. Estado ainda não lido (precisa sessão do /ops). Detalhe em AGENTS.md.

## 25/09/2026 (noite) — 1º pedido real pelo WhatsApp: Mambo recusou (janela); corrigido

Pedido #UY6IV9 (água de coco Kero Coco, Mambo, R$18,66 no cartão salvo) pago às 17:19; o
comprador do servidor rodou na hora e a loja recusou o `transaction` com `ORD006 A janela de
entrega é obrigatória`. Nada criado nem pago na loja; orçamento liberado; job `needs_review`.
Causa: "Entrega Agendada" do Mambo exige janela (a mais cedo: dia seguinte 7h–10h) que custa
R$3 à parte; a cotação mostrava 2h e R$12,90. Corrigido em 2bb7361 (`effectiveSla` na cotação
e na compra). Este pedido fica em revisão: com a janela, a loja cobraria R$3 acima do teto pago.
Também: botões de dinheiro iam para o telefone do operador → agora dono; opções ordenadas por
mínimo da loja, prazo e produto+frete; aviso "lista expirou" removido. Status do pedido na loja
é legível com os cookies do fechamento (Cobasi `invoiced`, Pague Menos `payment-approved`, com
data prevista) — base para avisar "a caminho" sem depender de e-mail.

## 25/09/2026 (noite) — LIGADO: compra automática ativa em produção nas 9 lojas

Kill-switches removidos, `LIA_AUTO_PURCHASE_STORES` com as 9 lojas, contas de compra ativas
(`pix_out`), deploy a664e80. Logs de produção: `/api/cron/purchase-runner` `enabled: true`
a cada 2 min (fila vazia); `/api/cron/store-mail` 200 listando e classificando. O leitor deu
401 UNAUTHENTICATED com token válido até trocar para `fetch` com `cache: "no-store"` e
`Headers` explícito: o fetch remendado do Next na Vercel derrubava o cabeçalho de
autorização. Falta o primeiro pedido real de cliente pelo WhatsApp (dono) para provar a
cadeia inteira em produção.

## 25/09/2026 — Remodelagem concluída no código e em produção; ligar depende de 2 cliques do dono

Tudo do modelo "a Lia compra sozinha" está em `main` e deployado (8544ff3): comprador por API
em 9 lojas, leitor de e-mails, crons, /ops com habilitação em um clique, registry opt-in,
trava de 24h, desconto de Pix, seller na hora. Suíte 672/672, lint limpo. Kill-switches ainda
LIGADOS na Vercel: nada compra até o dono (1) habilitar as lojas no /ops e (2) remover as 3
envs de pausa e gravar `LIA_AUTO_PURCHASE_STORES` com as 9 lojas; depois redeploy e um pedido
real por loja nova. Caminhos que ainda caem em humano listados em AGENTS.md (25/09).

## 25/09/2026 — Vitrine sem operador: 9 lojas por API (~19.000 itens); ML em espera

Decisão do dono (25/09, à tarde): tudo que não fecha sem humano sai; somar toda loja que
funcione. Feito hoje:

- **Comprador por API** cobre agora **9 lojas**: Drogaria SP (4.682 itens), Drogal (6.463),
  Pague Menos (1.551), Cobasi (998), Swift (968), Kopenhagen (248), Ri Happy (1.196), Mambo
  (1.500: supermercado, hortifruti, bebidas) e Época Cosméticos (459). Todas sondadas a seco
  no endereço do dono com o cliente novo do servidor (seller resolvido na hora, PJ, geo,
  SLA no prazo, Pix; cesta esvaziada). Três já provadas com pedido real e Pix pago.
- **Desligadas por padrão no registry (opt-in por env):** Carrefour, Petz, Boticário, Droga
  Raia, Oba, Divvino, Imigrantes, Giuliana Flores, Decathlon, Kalunga, Cacau Show, Natural da
  Terra. Motivos no `src/lib/stores/index.ts`. Mercado Livre inalterado (decisão pendente).
- Varredura de ~80 varejistas: também abertos, mas fora por prazo/aderência: Tok&Stok (7 dias),
  Polishop, Hering, C&A, Lojas Rede, Drogarias Pacheco (RJ). Hortifruti/Mundo Verde não
  entregam no endereço; Sonda/Livup bloqueiam catálogo.
- Comprador: desconto de Pix (Kopenhagen/Ri Happy) via `discountCents`; `transaction` manda
  `value` = pagamento e `referenceValue` = cesta; trava de 24h para pedido pago antigo.
- Suíte: arquivos em série (paralelismo no mesmo banco causava flakes); elenco dos evals e do
  golden fixado explicitamente; comprador do servidor desligado no harness.

Pendente do dono: `git push origin main` (classificador barrou o último push do Claude),
rodar `scripts/ops-enable-vtex-accounts.mts --db` (agora cria as 9 contas), e então o Claude
desliga os kill-switches. Depois: um pedido real do dono pelo WhatsApp em cada loja nova.

## 25/09/2026 — Deploy do comprador no servidor em produção (Ready); ligar fica com o dono

`git push origin main` feito (9eabfc2, 5834db3); produção Ready em 59 s com a migration
`StoreMailSeen`. Kill-switches (`LIA_AUTO_PURCHASE_OFF`, `LIA_PURCHASE_SUBMIT_OFF`,
`LIA_PIX_OUT_OFF`) continuam ligados, então o deploy é seguro. O classificador da sessão
barrou o Claude de gravar envs na Vercel e de ler contas em produção; os passos que faltam
(envs do Gmail vindas do Chaves, CNPJ, allowlist, contas no /ops, saldo Asaas, desligar os
switches, redeploy) estão no checklist de PENDENCIAS 25/09 e foram passados ao dono no chat.

## 25/09/2026 — Comprador VTEX no servidor: código pronto e testado (falta ligar)

Em resposta à decisão de religar a compra automática, o fluxo inteiro passou a existir no
servidor, sem Mac: pedido pago → job → checkout VTEX por HTTP (cesta com os SKUs do catálogo,
perfil PJ com o CNPJ, endereço do cliente com coordenadas do CEP, entrega mais barata dentro
do prazo prometido, Pix) → conferência e teto de sempre (`stageCheckout`/`beginPurchase`) →
`transaction` → vault → callback 428 com o EMV → `capturePix` → Asaas paga → compra registrada
com o número da loja (`orderGroup-01`) e cliente avisado. Cron a cada 2 min + disparo na hora
do pagamento. Leitor de e-mails das lojas no servidor (cron 3 min) confirma pagamento/
faturamento/entrega sem humano; tabela `StoreMailSeen` evita repetição. Recebedor novo: o
código Pix fica guardado e o toque "Pagar e memorizar" paga sozinho. Recusa da loja antes do
pedido (reCAPTCHA/documento) libera o orçamento e vai para revisão; falha depois do pedido é
`outcome_unknown`. Testes com uma loja VTEX de mentira feita das respostas reais de hoje:
53/53 focados, suíte completa 668/669 (o 1 é interação de dados do `order-monitor`, passa
sozinho). Build local ok. Checklist para ligar em PENDENCIAS 25/09.

## 25/09/2026 — Decisão: religar a compra automática; meta é zero operador

O dono decidiu religar a compra automática nas três lojas provadas hoje e reorientar o negócio
para operação sem operador: loja que não fecha por API sai; Mercado Livre é a exceção a tentar
manter pelo comprador por navegador já existente (E8). Trabalho iniciado: adaptador VTEX no
servidor dentro do job de compra existente. Registro completo em `AGENTS.md` (25/09) e lista de
trabalho em `PENDENCIAS.md`.

## 25/09/2026 — 3 de 3: Cobasi e Pague Menos também fecharam por API (Pix emitido e pago)

Na sequência da Drogaria SP, o mesmo script (`vtex-api-probe.mts --buy`, convidado, CNPJ do MEI
como pessoa jurídica) fechou:

- **Cobasi** 11:40 — pedido `v147466794cbs`, sachê Whiskas R$2,90 + "Cobasi Já" 4h R$9,90 =
  R$12,80. Sem CAPTCHA; gateway 201; callback 428 com `vtex.pix-payment`; Pix Itaú (União Pet
  Participações), validade ~55 min. Dono pagou.
- **Pague Menos** 11:43 (dono rodou o comando; o classificador de permissões barrou o Claude
  nessa execução) — pedido `1664230196474`, hastes Topz R$3,99 + Expressa 2h R$6,90 = R$10,89.
  **Sem CAPTCHA no `transaction`**, ao contrário do que a UI mostrou em 10/09: o "Não sou um
  robô" era da tela, não do fechamento por API. Pix Itaú (Farmácia Pague Menos), validade 10 min.
  Dono pagou.
- Detalhe de cobertura: na Pague Menos, dois algodões (Cremer 25g, Apolo 50g) voltaram "não pode
  ser entregue para as coordenadas"; o item define a entrega, não só o CEP. Na Cobasi o SLA
  padrão vem "Econômica4" (7 dias úteis); é preciso escolher "Cobasi Já" explicitamente.

Confirmação por e-mail: Drogaria SP às 11:33:17; Cobasi e Pague Menos pendentes na hora deste
registro (o e-mail de convidado vai para `contato+probe@` → caixa operacional).

**Resultado do gate de 24/09: as três lojas VTEX abertas fecham por API sem operador e sem
navegador, com o EMV do Pix vindo no `gatewayCallback`.** A decisão de religar a compra
automática nessas três lojas é do dono (decisão datada), com Asaas pagando o Pix.

## 25/09/2026 — PROVADO: pedido criado por API na Drogaria SP, sem CAPTCHA, Pix emitido e pago

Teste autorizado em 24/09 executado hoje. Três rodadas reais, todas por HTTP puro do Mac
(`scripts/vtex-api-probe.mts --buy`, perfil de convidado, CNPJ do MEI em variável de ambiente):

1. 11:17 — `transaction` 400 `ORD007`: o script mandava o CNPJ como `documentType: "cpf"`.
   Sem pedido, sem cobrança. Corrigido: 14 dígitos vira pessoa jurídica (`isCorporate`,
   `corporateDocument`), como a VTEX documenta.
2. 11:22 (dono) — **`transaction` 200, pedido `v79834803dgsp-01` criado sem CAPTCHA**, mas o
   envio do Pix ao `receiverUri` (`/split/{og}/payments`) devolveu 500 e o `gatewayCallback`
   `CHK0223`. Pedido ficou sem pagamento; a loja cancela sozinha.
3. 11:31 (Claude) — lendo o `checkout.min.js` v6.152.3 da própria loja: o navegador NÃO usa o
   `receiverUri`; copia `paymentData.payments[]` da cesta com `merchantSellerPayments`, anexa
   `transaction`, `currencyCode`, `installments*`, e posta em `api.vtexvault.com/api/payments/
   transactions/{tid}/payments?orderId&redirect=false&callbackUrl&deviceInfo&an`. Resultado:
   gateway **201**, `gatewayCallback` **428** com `paymentAuthorizationAppCollection`
   (`vtex.pix-payment`) e o **copia-e-cola no `appPayload`** (Adyen, dinâmico, vence em 10 min).
   **Pedido `v79835708dgsp-01`, Sabonete Dove 90g R$5,39 + SUPER EXPRESSA 90 min R$8,90 =
   R$14,29. Dono pagou o Pix às 11:33.** **Loja confirmou às 11:33:17**: e-mail "Pagamento foi
aprovado" de `pedidos@drogariasaopaulo.com.br` para `contato+probe@liadelivery.com.br`, que o
ImprovMX entrega em `joseph.dayan@beityaacov.com.br` (a mesma caixa operacional que o comprador lê).
Dados de entrega corretos. Ressalva: `listStoreMessages("drogariasp")` do comprador não achou
esse e-mail (regra de assunto/remetente em `mailbox-policy.ts` precisa reconhecer "Pagamento foi
aprovado").

Conclusão: para esta loja, **o fechamento por API sem operador e sem navegador está provado até
o Pix**. O gate documentado em 23/09 (reCAPTCHA no `transaction`, Payment App headless) não
barrou: o EMV vem no callback. Ficam abertos: confirmação/entrega do pedido, repetir em Cobasi e
Pague Menos, e a leitura posterior do pedido (a leitura pública exige os cookies
`CheckoutDataAccess`/`Vtex_CHKO_Auth` do fechamento; o script passou a gravá-los no JSON).

## 24/09/2026 — Parecer do Claude sobre o Muse: descartar; teste de fechamento VTEX autorizado

Sessão nova no projeto Lia (Fable 5.1, esforço extra) revisou
[docs/muse-lia-viabilidade-conversa-2026-09-24.md](docs/muse-lia-viabilidade-conversa-2026-09-24.md)
e o relatório de alternativas, com checagem das fontes primárias na data. Parecer completo na
§11 do próprio doc. Resumo: a Meta Model API é preview público **só para desenvolvedores nos
EUA** (blog de lançamento; página `unavailable?reason=geo` existe), a API de computer use dá
apenas screenshot e clique por pixel sem navegador, cofre ou carteira, e o Link Agent Wallet é
só para contas Link dos EUA. Trocar de modelo não ataca o que barrou Browserbase (anti-bot no
login do Carrefour) nem o CAPTCHA/CVV da Pague Menos. **Veredito: descartar Muse Spark; não
qualificar Skyvern, Browser Use, Agentcard ou Stark agora.**

O dono acatou e autorizou o passo mais barato: **fechar um pedido real por API na Drogaria
São Paulo** com `scripts/vtex-api-probe.mts --buy` (R$15–20, Pix pago pelo dono, documento do
comprador só na variável de ambiente, nunca no chat nem no repo). Rodada seca de 24/09 à noite
confirmou a loja aberta: convidado sem login, SUPER EXPRESSA R$8,90 em 3h, NORMAL R$6,90 em 2
dias, Pix aceito, cesta esvaziada. Resultado do fechamento fica registrado em entrada própria.

## 24/09/2026 — Alternativas ao Muse analisadas, sem implementação

Após o dono lembrar o fracasso com Browserbase, o histórico foi revisto: as alternativas
não têm superioridade operacional comprovada. A lista curta compara interfaces disponíveis;
não valida acesso às lojas. Prioridade refinada: provar solução da barreira específica
antes de recomendar troca de fornecedor.

Pesquisa ampliada em [docs/alternativas-compra-agentes-2026-09-24.md](docs/alternativas-compra-agentes-2026-09-24.md).
Lista curta: Skyvern/Browser Use como executores; Kernel + Agentcard como hipótese de
carteira com aprovação no celular. Existe documentação de tokenização Mercado Pago
nessa última combinação, sem comprovação de compra BR nas lojas da Lia. Rye padrão
limitado aos EUA e com restrições incompatíveis com cesta/frete do piloto. Comparação
inclui TinyFish, VTEX + Pix, pagamentos regionais, parceria com loja e custos públicos.
VTEX tem maior evidência nossa, mas ainda falta concluir o pedido. Nenhum provedor
novo testado com conta/cartão, nenhum runtime ou deploy alterado. Claude segue pendente;
o dono pediu continuar a análise por Codex após o bloqueio do Mac.

## 24/09/2026 — Análise Muse concluída; consulta ao Claude aguarda desbloqueio do Mac

Registrada a conversa completa por assuntos e sequência, fontes, análise de viabilidade,
arquitetura proposta, economia ilustrativa e experimento em
[docs/muse-lia-viabilidade-conversa-2026-09-24.md](docs/muse-lia-viabilidade-conversa-2026-09-24.md).
Muse Spark tem computer use documentado, mas exige ambiente próprio; API do navegador
pronto do aplicativo não foi encontrada. Acesso da conta brasileira, checkout local e
economia permanecem não validados. Pesquisa não reativa compra automática.
O dono pediu segunda opinião no Claude (Fable 5.1/Extra, nova sessão no projeto Lia).
Computer use encontrou Mac bloqueado e o desbloqueio foi solicitado; envio ainda pendente.

## 23/09/2026 — API de compra sem operador: testada ao vivo, aberta em 3 lojas até o Pix

O dono perguntou se existe API de loja que faça o fluxo inteiro sem operador. Pesquisa:
não há API oficial de compra pelo comprador no Brasil (ML, Magalu, iFood, Rappi, Carrefour
só têm API de vendedor; ACP/UCP/Shopify não chegaram ao BR). O que funciona é a API pública
de checkout da VTEX, testada por HTTP puro, sem navegador: **Drogaria São Paulo, Cobasi e
Pague Menos** aceitaram do servidor busca → cesta → perfil de convidado sem login → endereço
→ entrega com preço/prazo (Drogaria SP 90 min R$8,90; Cobasi 16 h R$9,90; Pague Menos 2 h
R$6,90) → Pix escolhido, sem CAPTCHA. Carrefour (503) e Petz (403) barram servidor; Oba só
cartão. Falta o fechamento real (`transaction`), que cria pedido e é onde a VTEX documenta
reCAPTCHA (cartão) e Payment App (leitura do Pix). Script `scripts/vtex-api-probe.mts`
(seco por padrão; `--buy` exige confirmação + documento). Não muda a decisão de 15/09.
Detalhe: [docs/api-compra-lojas-2026-09-23.md](docs/api-compra-lojas-2026-09-23.md).

## 23/09/2026 — Financeiro por pedido pronto localmente (falta deploy)

P&L automático por pedido em `/ops/financeiro` (só o dono): cliente pagou, taxa do Mercado
Pago lida do próprio MP (backfill no cron pros pagamentos antigos), custo real da loja que o
operador digita ao confirmar a compra, frete, margem e "sobrou"; resumo por mês e CSV pra
planilha. Tudo que ainda não foi confirmado aparece com ≈ (taxa, comprovante, pedido pago sem
compra, estorno pendente). Gate local: `tsc` e lint limpos, `test:local` focado verde (pnl,
razão, reconciliação, concierge, operador, login, pricing), tela conferida no preview com banco
local. Depende de deploy (migration nova). Detalhe em AGENTS; passos em PENDENCIAS.

## 17/09/2026 — Carlos contratado e treinado; falta acertar os telefones e publicar

Operador contratado: **Carlos José Bratz** (+55 27 99774-2494), vindo do 99Freelas. Combinado
por WhatsApp em 16/09: R$ 400 fixos ao fim do período mensal (5–15 pedidos é estimativa, não
teto; sem adicional por pedido; crescimento grande se renegocia antes), pedido concluído em
até 2h entre 9h e 20h, **inclusive fins de semana**. Teste pago de R$ 30 aprovado (ele conferiu
ração Pedigree 900 g numa loja real e devolveu o resumo no formato pedido) e treinamento
escrito confirmado. O dono pediu que, nos pedidos reais, o resumo traga também o link exato do
produto. Primeiro pedido real será supervisionado, com autorização escrita antes de finalizar.

Checagem de prontidão feita hoje. Corrigido e commitado: `OPS_TEST_TOKEN` criado em Production
(só existia em Preview, por isso os links do Carlos eram de deploy de preview); `.env.example`
com as quatro envs novas e sem os dois defaults que contradiziam a decisão; painel entregando
ao operador o que ele precisa para comprar e nada além (lista copiada com valor e loja,
endereço copiado com destinatário e telefone, atalho de WhatsApp do cliente só para o dono,
papel sem piscar interface de dono, destinatário editável). 644/644 em `test:local`, build ok.

Pendente e **urgente**: conferir se `LIA_OWNER_PHONE` recebeu o número do Carlos em vez do
número do dono (ver PENDENCIAS), acertar os dois telefones e publicar os commits.

## 16/09/2026 — Site conferido no ar; rodapé pronto pra Instagram/LinkedIn; marketing decidido

Conferência ao vivo: `liadelivery.com.br` 200, `/ops` 200, botão do WhatsApp aponta pro
número oficial (`5511978444813`), e o deployment de produção em execução é o CLI das 19:36
(actor codex), já com o código do operador humano. Os 9 commits locais de 15/09 estavam só
no Mac: enviados ao GitHub neste commit (o deploy por git da Vercel republica o mesmo código).
Gate: `test:local` 641/641, `tsc` e lint limpos.

Landing: o rodapé passa a mostrar links de Instagram e LinkedIn quando
`NEXT_PUBLIC_LIA_INSTAGRAM_URL` / `NEXT_PUBLIC_LIA_LINKEDIN_URL` existirem (sem env, nada
aparece). As contas ainda não existem: o dono cria as duas (Instagram profissional ligado à
Página do portfólio Meta "Lia"; LinkedIn como página de empresa), depois grava as duas envs
na Vercel e redeploya.

Decisão de marketing (dono, 16/09): canal principal de aquisição é anúncio Meta
**click-to-WhatsApp** (objetivo Mensagens, Advantage+, bairros de SP, orçamento pequeno), que
cai direto no número da Lia. Instagram e LinkedIn existem por credibilidade, com presença
mínima: criativo = gravação de tela de conversas reais anonimizadas (serve de Reel, de post
e de anúncio); LinkedIn só texto do fundador, sem ferramenta. Sem contratar ninguém pra isso.

## 15/09/2026 — Operador humano implementado (falta deploy)

Código pronto e commitado (`31e6a21`, `f999032`): kill-switch da compra automática valendo
antes do job nascer, `/ops` com dois papéis (`OPS_OPERATOR_TOKEN`), alertas separados entre
dono e operador (`LIA_OWNER_PHONE`), promessa honesta fora de `LIA_OPERATOR_HOURS` e runbook
reescrito para o contratado. Detalhe técnico em AGENTS.

Estado de produção: as três envs de kill-switch estão gravadas na Vercel mas **ainda não
valem** — só entram no próximo deploy. Até lá o deployment em execução mantém a compra
automática habilitada para a Cobasi. O comprador local (launchd) foi parado e desabilitado
neste Mac, então nada executa checkout no momento.

Ainda não existe operador contratado: `OPS_OPERATOR_TOKEN` e `LIA_OWNER_PHONE` não estão
configurados, e sem eles tudo se comporta como antes (um papel só, um telefone só).

## 15/09/2026 — Decisão operacional: operador humano substitui compra automática

Foi decidido contratar um operador humano para cotar, comprar e acompanhar os pedidos da
Lia. A compra automática deixa de ser o caminho operacional: não ativar novas lojas, não
ampliar `LIA_AUTO_PURCHASE_STORES`, não executar checkout automático pelo comprador local e
não reativar a tarefa horária do ChatGPT. Pedidos devem seguir pela fila/manual do `/ops` e
serem executados por uma pessoa, com as confirmações e exceções registradas.

Recrutamento: vaga publicada no 99Freelas, projeto 784519. Workana não foi publicado porque
a conta não foi reconhecida na sessão disponível. Esta entrada é documental; flags, deploy e
contas de produção ainda não foram alterados nesta atualização.

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

## 15/09/2026 — Primeiro pedido real de cliente na Cobasi: 11 tentativas, 9 defeitos corrigidos, parou no reCAPTCHA visível

Pedido #5GUY4Z (dono como cliente, lata Whiskas 290 g, R$21,50 pago por Pix; custo na loja
R$19,29). Cada tentativa parou num defeito que só o pedido real revelava, todos corrigidos e
commitados na hora: (1) serviço launchd sem a chave da IA do endereço; (2) endereço do pedido
sem bairro/cidade/UF (servidor completa com a localidade do CEP); (3) entrega comparada por
texto exato da promessa (agora prazo ≤ prometido, mais barata); (4) carrinho da loja deixado
pela tentativa anterior (esvaziado à mão; regra do comprador de não mexer continua);
(5) compra real ia ao cartão salvo (meio de pagamento agora vem da conta do /ops);
(6) grafia oficial do CEP na loja ("Sousa" × "Souza"; aceita via base de CEP da própria
loja); (7) clique "Ir para revisão" coberto por carregamento (45 s + networkidle);
(8) servidor: endereço completado e prazo menor rejeitados na conferência (aceitos);
(9) trava de homologação/captura do Pix liam a receita crua do config (mesclada).
Na 10ª e 11ª o comprador clicou "Concluir pedido" de verdade e o **reCAPTCHA da Cobasi
abriu o desafio de imagens** ("selecione as faixas de pedestres") — nenhum pedido criado,
carrinho esvaziado, nada pago. Regra do projeto: nunca resolver CAPTCHA. Próximo passo
(a implementar): detectar o desafio na hora (iframe bframe visível) e entregar ao dono por
WhatsApp — a janela do comprador é headed no Mac dele, ele resolve o desafio como humano e
o fluxo segue; sem resposta em N min, fila manual. O E3 passou uma vez sem desafio; a
sequência de 11 tentativas no mesmo perfil provavelmente elevou o risco. Mercado Livre:
login humano só vale na janela do comprador (cookies do Chrome normal são cifrados com outra
chave), e a janela do comprador tomou "limite de tentativas" de novo — parado; alternativa
técnica: comprador usar a chave de cookies do sistema para o perfil do ML.

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

## 15/09/2026 — Cobasi LIGADA de ponta a ponta: E6 pago, provedor Asaas, allowlist, serviço local

E6 fechado após o dono habilitar a validação de saque via webhook no Asaas: R$1 pago
(`DONE`, endToEnd E195405502026091500572ZC6XO0OHXJ) e aprovado no Mercado Pago em segundos,
sem token de ação crítica — o suporte do Asaas não precisou ser acionado. Dono gravou
`LIA_PIX_OUT_PROVIDER=asaas` e `LIA_AUTO_PURCHASE_STORES=cobasi` na Vercel (redeploy Ready) e
salvou a conta Cobasi no /ops (e-mail operacional, login por código, pix_out, pronta,
habilitada). Comprador instalado como serviço launchd no Mac do dono
(`purchase-worker:install-service`, pid ativo, logs em ~/Library/Logs/lia/); a checagem de
loja executável e o aviso de inicialização passaram a usar a receita mesclada
(padrão + config), senão a Cobasi aparecia como "não configurada". `claimNextPurchaseJob`
agora marca `lastSeenAt` das contas atendidas a cada consulta (sinal de vida no /ops).
Fluxo vivo: pedido pago com item Cobasi ≤ R$500 → job → comprador (login por código,
carrinho da tela, Concluir pedido, captura do Pix) → servidor confere e paga pelo Asaas →
webhook aprova → conciliação → e-mails da loja (faturado, código de recebimento → cliente).
Pendências: saldo no Asaas (dono), primeiro pedido real de cliente supervisionado, E8 do
Mercado Livre (janela do Chrome do perfil precisa estar fechada), Swift fora por cobertura.

## 15/09/2026 — Webhook de validação de saque do Asaas; código de recebimento da Cobasi vai ao cliente

**Asaas.** O R$1 do E6 foi autorizado pelo dono só horas depois e acabou recusado pela
instituição de destino (a cobrança do Mercado Pago expira em 60 min); saldo segue no Asaas.
Caminho definitivo, em vez do token SMS/app por operação: **Validação de saque via Webhook**
(Integrações → Segurança). Rota `POST /api/asaas/withdrawal-validation` (header
`asaas-access-token` = `ASAAS_WEBHOOK_TOKEN`, gerado e gravado na Vercel): aprova SÓ
`PIX_QR_CODE` com `PixPayout` em curso de mesmo valor (e id) nas últimas 2 h, ou o E6 de R$1
com descrição "Lia E6"; recusa transferências, boletos, recargas, estornos e qualquer valor
sem correspondência. Falta o dono habilitar no painel (URL, e-mail, token) e pedir ao
suporte do Asaas para dispensar o token de ação crítica na API. Depois: repetir o E6.
**Cobasi, pedido v146373290cbs-01 entregue em 14/09 (1 dia útil).** E-mails reais:
`Cobasi <…@ct.vtex.com.br>` (pagamento aprovado, faturado, "produtos encaminhados para a
transportadora" — sem mapeamento de etapa, de propósito) e `Cobasi <noreply@cobasi.com.br>`
"Código de segurança para recebimento do seu pedido": "seu pedido já está a caminho … 6065 …
Informe apenas após receber", **sem número do pedido**. Novo `kind: delivery_code` no
classificador (assunto literal + regex do código), `reportMail`: só entrega ao cliente quando
há exatamente UM pedido da loja em andamento (7 dias) — vira "saiu pra entrega" com a linha
"🔐 Código de recebimento: *6065*"; ambíguo/nenhum → aviso ao operador; o código nunca vai
para as notas. Remetente `ct.vtex.com.br` + nome "Cobasi" nas regras. Suíte 598/598.

## 14/09/2026 — Asaas aberto e aprovado; E6 (R$1) parado em AWAITING_CRITICAL_ACTION_AUTHORIZATION

Conta Asaas PJ (MEI) criada e aprovada pelo dono; chave de API gravada por ele na Vercel
(`ASAAS_API_KEY`, sensível) e `ASAAS_ENV=production`. Como as credenciais de produção são
sensíveis (não saem da Vercel), o E6 roda no servidor: `POST /api/purchase-worker/pix-out-test`
(token do comprador) cria uma cobrança Pix de R$1 no Mercado Pago da Lia, decodifica e paga
pelo adaptador Asaas; `GET ?payoutId&pixId` consulta os dois lados sem pagar de novo.
Resultados reais: o Mercado Pago emite copia-e-cola por chave (parser: estático, txid) —
a regra "só dinâmica" continua valendo só para a loja; `decode` do Asaas OK (recebedor
67.742.955 Joseph Carlos Dayan, R$1,00, tipo static); 1ª tentativa recusada por saldo
(dono depositou); 2ª: `pay` aceito em 0,9 s (id 3135e78f…), mas fica em
**AWAITING_CRITICAL_ACTION_AUTHORIZATION** — o Asaas exige autorização do dono para
transferência via API (risco previsto no plano). Providências do dono: autorizar o R$1 e
desligar a exigência para a API (Integrações → Segurança / Minha Conta → Segurança →
Ações críticas). Só depois: `LIA_PIX_OUT_PROVIDER=asaas` + `LIA_AUTO_PURCHASE_STORES=cobasi`.
Conta Cobasi cadastrada no /ops pelo dono (pix_out, pronta). `status()` do adaptador agora
devolve o status bruto em `reason`. Suíte 597/597.

## 14/09/2026 — E3 Cobasi concluído: pedido real v146373290cbs-01 (R$10,70), clique automático, Pix capturado, pago pelo dono

Comando novo `npm run purchase-worker:e3 -- cobasi` (só com `LIA_E3_CONFIRM=sim` e o dono
aprovando o comando no app): mesmo caminho da sondagem até a Revisão, um clique em
"Concluir pedido" (13/09 22:56, sem desafio do reCAPTCHA invisível), copia-e-cola capturado
na própria tela (modal "Pagar com Pix", 60 min, QR **dinâmico do Itaú sem valor embutido**,
recebedor "UNIAO PET PARTICIPACOES S"), impresso só na saída (nunca em disco). O dono pagou
no app do banco; "Minhas compras" da conta mostra **Pagamento aprovado, #v146373290cbs-01,
R$ 10,70, 13/09 23:00**, entrega Econômica em até 1 dia útil no endereço do dono.
Aprendizados codificados: (1) a tela após o clique NÃO mostra o número — `receipt()` da
Cobasi lê a primeira linha de `/minha-conta/pedidos` (número + valor, criada há < 6 h);
(2) numeração `v…cbs-01` no classificador de e-mail; (3) `submitSelector`
(`button:has-text("Concluir pedido")`) no `config.json` privado; lojas com `checkoutFlow`
dispensam seletores de comprovante. Regra do servidor conferida: valor de QR dinâmico vem
do `decode` do banco (`decoded.amountCents ?? emv.amountCents`), então a Cobasi passa.
Falta para a Cobasi comprar sozinha de ponta a ponta: banco (Asaas, decidido pelo dono em
14/09; conta é do dono — abrir conta é ação que o assistente não executa), chave
`ASAAS_API_KEY` na Vercel, E6 com R$1, `LIA_PIX_OUT_PROVIDER=asaas`, conta Cobasi no /ops
(pix_out, pronta) e `LIA_AUTO_PURCHASE_STORES=cobasi`. E-mail de confirmação da Cobasi ainda
não tinha chegado à caixa às 23:05; observar remetente/assunto quando chegar (rastreio).

## 14/09/2026 — E2 Cobasi fechado ao vivo: comprador chega à Revisão com Pix, sem desafio

Com o dono em modo manual de permissões, o checkout próprio da Cobasi foi mapeado e
codificado (`checkoutFlow: "cobasi"` em `scripts/retail-buyer/browser.ts`): carrinho →
"Fazer pedido" → Identificação (pré-preenchida da conta) → "Ir para entrega" (endereço do
dono, Econômica R$7,90) → "Ir para pagamento" → opção Pix (clique no cartão da opção; a
loja só grava o meio no orderForm depois) → "Ir para revisão" → `/checkout/review`:
"Forma de pagamento Pix", botão final único **"Concluir pedido"**. Máquina de estados por
URL (o checkout lembra a última etapa), sem `waitForURL` (a página nunca dispara "load").
Relatório da sondagem: `prepared`, `pixSelected`, `challengeVisible=false`,
`captchaBadge=true` (reCAPTCHA invisível, só age no clique final), `finalizeButtons=1`,
`finalizeEnabled=true`, total R$10,70, `cartCleared=true`. O código Pix só aparece
**depois** de "Concluir pedido" (pedido criado na loja) — como o plano previa.
Falta para ligar a Cobasi: E3 (um pedido real: prova o clique final sob reCAPTCHA
invisível, a página do Pix e o comprovante para `receipt`), `submitSelector`
(`button:has-text("Concluir pedido")`) + `receipt` no `config.json`, E5/E6 (banco) para
`LIA_PIX_OUT_PROVIDER`. Gates: verify, verify-ui, lint, tsc, suíte 597/597.

## 14/09/2026 — E2 ao vivo: Cobasi chega ao carrinho com Pix e entrega; Swift não entrega no CEP do dono

Contas da Lia criadas pelo dono na Swift e na Cobasi (e-mail da caixa de E0). Sondagens
reais, sem pedido, carrinhos esvaziados ao final:
- **Swift:** login por código automático OK (sessão persiste no perfil), item entra, Pix
  disponível. Entrega: `cannotBeDelivered` para 01233-020 mesmo com geocoordenadas e com os
  vendedores regionais (`swiftbr5180freicaneca`, `swiftbr5299francodarocha`); a simulação
  entrega em 01311-000 (Paulista), 04543-010 (Vila Olímpia) e 05407-002 (Pinheiros), com
  "Receba em 1 dia útil" R$15,90 ou "Entrega agendada" R$17,90. Cobertura da loja, não bug.
  Para fechar E2 na Swift falta um endereço real do dono coberto pela loja.
- **Cobasi:** login por "Chave de acesso" mapeado e codificado (`auth: cobasi_email_code`:
  /login → solicitar-chave-de-acesso → 6 caixas → Confirmar); remetente `no reply
  <noreply@vtexcommerce.com.br>` (regra `senders`); código lido em ~10 s. Três defeitos do
  comprador corrigidos ao vivo: `selectPix` reenviava o `paymentData` inteiro (400), o
  esvaziar usava `/items` com quantidade 0 (CHK0023; agora `/items/update`), e a tela da
  Cobasi usa o orderForm do `localStorage.cartID`, não o do cookie (`cartIdStorageKey`;
  sem isso a API montava um carrinho invisível). Estado alcançado: carrinho da tela com o
  item, CEP, "Econômica R$7,90 em 1 dia útil" selecionada, total R$10,70, botão "Fazer
  pedido", sem CAPTCHA. As telas seguintes (pedido → pagamento → Pix) ainda não foram
  mapeadas: o classificador de permissões bloqueou o script que avançaria pelo checkout
  real; precisa de liberação do dono ou de um mapeamento manual das telas.
- Erros HTTP do comprador agora trazem rota e corpo (sem dado pessoal); relatório de
  sondagem grava `cartClearError`. `verify`/`verify-ui`/lint/suíte 597 verdes.

## 14/09/2026 — E2 Swift ao vivo: leitor de e-mail corrigido (2 defeitos), conta da Lia não existe na loja

Reprodução observável do login por código no perfil da Swift, com a caixa de E0 (a mesma
que o dono confirmou como caixa das lojas). Achados, todos conferidos ao vivo:
1. A chave de acesso chega em ~5 s, mas de `Loja Online Swift <noreply@vtexcommerce.com.br>`,
   não de `swift.com.br`. Regra nova nas duas camadas (`scripts/retail-buyer/mailbox.ts` e
   `src/lib/mailbox-policy.ts`): `senders` = domínio de plataforma compartilhada aceito
   **só** com o nome de exibição exato da loja; outro nome no mesmo domínio é recusado.
2. O texto "Sua chave de acesso **é** 773684" não casava com o padrão principal (o "é" vira
   "e" e é letra); o fallback via vários números de 4 dígitos no rodapé (0800, 2892) e,
   por segurança, devolvia nada. Padrão ganhou o conector verbal; teste com o texto real.
3. Com o código válido a Swift redireciona para `/register` (cadastro: nome, CPF, telefone,
   senha): **não existe conta da Lia na Swift com esse e-mail**. O comprador tratava isso
   como login feito e falhava depois ("loja não confirmou a conta"); agora o erro é explícito.
   O cadastro é do dono (CPF/senha), pelo `purchase-worker:setup -- swift`. Cobasi
   provavelmente está na mesma situação (o "cadastro" de 07/09 enviou código).
Testes: leitor 5/5, suíte 597/597, `purchase-worker:verify` ok. Nenhum pedido, item ou
pagamento criado; carrinhos vazios. Sondagens E2 seguem pendentes até o cadastro.

## 13/09/2026 — tokens do comprador conferidos; E2 Swift parou no e-mail da conta

Tokens locais testados contra a produção (corpo vazio, sem efeito): o de compra já batia;
o de rastreio divergia (401) e foi rotacionado com autorização do dono — valor novo na
Vercel (`LIA_TRACKING_WORKER_TOKEN`) e no Chaves (`Lia Tracking Worker`), redeploy feito,
os dois agora respondem 400 (autenticados, corpo inválido) e `/ops` 200. Endereço
operacional de sondagem gravado no bloco `probe` do `config.json` privado; `mercadolivre`
cadastrado nas lojas do comprador. Sondagem E2 da Swift rodou duas vezes sem criar pedido:
o comprador pediu a chave do "Acesso Rápido" para a caixa autorizada em E0, e nenhum e-mail
da Swift chegou em 90 s. Busca somente leitura na caixa (inclusive spam, sem limite de data)
não encontrou NENHUMA mensagem de `swift.com.br` ou `cobasi.com.br`, embora as sondagens de
07/09 tenham recebido códigos "no e-mail operacional". Conclusão: a caixa autorizada em E0
não é a caixa das contas Swift/Cobasi. Decisão pendente do dono: autorizar a caixa certa
(refazer `mailbox-authorize` nela) ou migrar as contas das lojas para a caixa autorizada.
Mercado Livre segue bloqueado por limite de tentativas (aguardar, uma tentativa só).

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

## 11/09/2026 — Deploy zero publicado (398217b), tudo desligado

Push de `main` (27 commits, fases 0–7) disparou o build de produção na Vercel
(`shopping-agent-sxbi3pr1v`, Ready em 1 min). `migrate-on-build` aplicou
`20260911120000_purchase_receivers_actions` e `20260911150000_pix_payout`; as três de
06–07/09 já constavam em `_prisma_migrations` (aplicadas em 07–08/09). Conferido direto no
banco: 23/23 migrations, tabelas `OpsAction`, `PurchaseReceiver`, `PixPayout` presentes,
sem drift. Smoke: `liadelivery.com.br/ops` 200, webhook do WhatsApp 403 com token errado
(esperado), zero logs de erro no deploy novo. Nenhuma env nova existe em produção, logo
`LIA_AUTO_PURCHASE_STORES` vazio (compra automática off, ML idem), `LIA_PIX_OUT_PROVIDER`
vazio (Pix de saída off) e botões do dono ligados só quando houver ação (não há). A env
`PURCHASE_AUTOMATION_MODE` ainda está na Vercel, mas nada mais a lê — pode ser apagada.
Próximo: gates do dono (E0, E8) e só então `LIA_AUTO_PURCHASE_STORES=mercadolivre`.

## 11/09/2026 — Fase 7 (operação) e fechamento do plano (597/597)

Serviço `launchd` do comprador (`purchase-worker:install-service`, caffeinate, KeepAlive,
logs em `~/Library/Logs/lia/`), runbook do operador reescrito para o fluxo novo, caminho
legado da tarefa horária do ChatGPT removido (rota `claim`, rotas `[id]/complete|fail`,
`purchase-worker-client.mts`, `validatePurchaseCompletion`, `PURCHASE_AUTOMATION_MODE`).
Resumo consolidado e ordem para ligar no topo do AGENTS.md. Nada publicado; 5 migrations
pendentes de deploy; gates E0–E11 continuam abertos e são o próximo passo do dono.

## 11/09/2026 — Fases 3, 4 e 5 implementadas localmente (597/597), desligadas por padrão

**Fase 3 — Pix da loja pago pela Lia (VTEX).** `src/lib/pix-emv.ts` (parser BR Code + CRC16,
puro), `src/lib/payments/pix-out/` (interface neutra; adaptadores `asaas` e `mock`; Efí
fica para depois da resposta escrita de E5, porque exige mTLS e aditivo), modelo
`PixPayout` (um por job; EMV nunca gravado, só hash) — migration
`20260911150000_pix_payout`. Fluxo: o comprador clica em finalizar com Pix selecionado,
captura o copia-e-cola (resposta do conector ou modal) e chama `pix_captured`; o servidor
confere CRC, valor exato, cobrança dinâmica e recebedor na allowlist da loja
(`PurchaseReceiver`); recebedor novo → botão **Pagar e memorizar / Recusar** ao dono;
aprovado → UMA chamada bancária; timeout → `outcome_unknown` + aviso, nunca segunda
chamada; recusa → botão **Refazer / Estornar** (Refazer libera a reserva e volta à fila).
Cron concilia pagamentos pendentes e, após `LIA_PIX_STORE_CONFIRM_MIN` (30) sem a loja
confirmar, manda **Confirmar / Estornar**. Kill-switches: `LIA_PIX_OUT_OFF=true` e
`LIA_PURCHASE_SUBMIT_OFF=true`; provedor por `LIA_PIX_OUT_PROVIDER` (vazio = desligado;
`mock` proibido em produção).
**Fase 4 — e-mail → etapa.** `src/lib/mailbox-policy.ts` classifica e-mails transacionais
(remetente da loja, assunto explícito, número obrigatório); o comprador local lista a
caixa a cada 2 min e manda só o veredito (`report_mail`); "saiu"/"entregue" viram
`DeliveryEvent` (fonte `mailbox_reader`, mesmas guardas do leitor de página);
"criado/pago" fecham o Pix da loja (`store_confirmed`). Os formatos reais das lojas ainda
não foram observados: as frases são explícitas e conservadoras.
**Fase 5 — exceções por um toque.** Além do ML: recebedor novo, Pix recusado, loja em
silêncio, acima do teto/loja sem liberação (**Autorizar / Estornar** no lugar do texto
solto), e alerta de comprador sem sinal (`LIA_BUYER_SILENT_MIN`, 1×/hora).

## 11/09/2026 — Fase 2 (Mercado Livre degrau C) implementada localmente (587/587)

Comprador local ganhou receita do ML (`scripts/retail-buyer/mercadolivre.ts`, DOM com
seletores configuráveis, nunca clica em comprar): monta o carrinho na conta da Lia, tira a
evidência (`payment: ml_balance`) e chama `owner_confirm`. O servidor
(`requestOwnerConfirm`) confere pagamento/cesta/conta, aplica o teto pelo canal
`owner_confirm`, reserva `PurchaseSpend`, cria `OpsAction ml_cart_ready` e manda ao dono
os botões assinados **Comprei / Não deu** (`op1.<id>.<escolha>.<hmac>`, HMAC com
`OPS_TOKEN`; sem Meta ou sem token cai em texto + link do painel). "Comprei" → pede o
número do pedido; a próxima mensagem numérica do operador registra a compra
(`recordDeliveryEvent bought`) e avisa o cliente; "Não deu" → revisão sem liberar a reserva.
Espelho no `/ops` (`owner_bought`/`owner_declined`) consome a mesma ação. Webhook roteia
`op1.…` do telefone do operador antes do cérebro. Estorno bloqueado enquanto o carrinho está
com o dono. Sondagem: `npm run purchase-worker:probe -- mercadolivre <URL do anúncio>`.
Pendente do dono: desligar a tarefa horária do ChatGPT quando o degrau C estiver em produção.

## 11/09/2026 — Fases 0 e 1 do plano de compra implementadas (local, 583/583)

Fase 0: leitor de e-mail por loja (`registerStoreMail`), `selectPix`/`selectSavedCard`/
`probeReport` no `VtexBuyer`, comando `npm run purchase-worker:probe -- LOJA [SKU]` (gate
E2: para antes de finalizar, nunca resolve desafio; exige bloco `probe` no config privado).
Fase 1: `customerName` passa a ser gravado no pedido (perfil do WhatsApp; pergunta só
quando falta E a cesta é de loja com compra automática; intent "é pra outra pessoa");
evidência de checkout com `payment` discriminado (`pix_store` | `ml_balance` |
`card_saved`) no lugar do literal de cartão; allowlist aceita Mercado Livre só pelo canal
`owner_confirm` (nunca clique automático); `PURCHASE_EXTRA_DOMAINS` (ML → Mercado Pago);
job `manual_queue` para pedido pago sem execução automática (banner no /ops, estorno
automático em 48 h via `LIA_AUTO_REFUND_MANUAL_HOURS`); botão "definir destinatário" e
seletor "como a Lia paga nessa loja" no painel; migration aditiva
`20260911120000_purchase_receivers_actions` (PurchaseReceiver, OpsAction,
PurchaseSpend.status, PurchaseAccount.authKind/paymentKind, PurchaseJob.ownerConfirmedAt);
rota `/api/purchase-worker/claim` e `purchase-worker-client` marcados como deprecados.
Nada publicado; 4 migrations pendentes de deploy (3 de 06–07/09 + esta).

## 10/09/2026 — plano de compra viável entregue (proposta)

O dono pediu "pensar, só pensar" num jeito realmente viável de executar a compra na loja.
Plano em [docs/plano-compra-viavel-2026-09-10.md](docs/plano-compra-viavel-2026-09-10.md):
Pix da loja pago por API bancária no lugar de cartão salvo; caixa de e-mail operacional
legível por máquina (código de login + rastreio); conta própria por loja no Chrome local
como serviço; exceções por um toque no WhatsApp do operador; gates de R$0–75 antes de
qualquer código (sondagem de Ri Happy, Drogaria SP, Cobasi e Swift com Pix; 1 pedido real;
Pix-out de R$1 a terceiro). Placar real de hoje: 0 de 4 lojas passaram o gate autônomo,
2 por motivo resolvível (código por e-mail). Estimativa de código após os gates: ~13 dias.
Nenhum código, conta, compra ou deploy. Aguarda as decisões da seção 5 do plano.

## 09/09/2026 — Pague Menos testada em compra real; recompra exige CVV

Pedido real `#1660399032770` concluído com autorização explícita, total R$24,39. A conta manteve os dados cadastrais, o cartão ficou salvo e aparece mascarado na recompra. A primeira compra exigiu verificação manual de robô. O segundo checkout chegou diretamente a entrega/pagamento, mas o cartão salvo exige novamente o código de segurança; nenhuma segunda compra foi concluída. Isso impede operação totalmente autônoma sem intervenção e o CAPTCHA recorrente ainda não foi medido. Pague Menos permanece fora da lista automática e sem seletores de finalização, recibo e rastreio homologados. Estado em [configuração das lojas](docs/configuracao-lojas-2026-09-07.md).

## 08/09/2026 — dados e senha fornecidos; acesso ainda não confirmado

Dono forneceu nome/e-mail, CPF, celular e senha para os sites. Drogaria São Paulo preenchida integralmente, mas cadastro, login e envio de código não confirmaram sucesso. Não pedir senha nem autorização para gerar outra: usar a fornecida, sem transcrever em arquivos. Chaves não foi utilizado. Pague Menos em tentativa como alternativa. Nenhum cartão salvo, conta habilitada ou compra. Estado em [configuração das lojas](docs/configuracao-lojas-2026-09-07.md).

## 08/09/2026 — autorização permanente de compra até R$ 500

Dono: “sim isso sim. eu atorizo ate 500 reais. queroo mais automatico que der mesmo se isso significar menos lojas.” Autorizada compra sem aprovação individual. Interpretação conservadora comunicada: teto R$500 por pedido e R$500 total por dia de São Paulo, frete incluso; não interpretar como orçamento diário ilimitado. Priorizar poucas lojas com checkout real validado; interromper expansão de cadastros até concluir a primeira. Não exige loja parceira. Autorização não significa conta/cartão prontos.

Implementado localmente: `purchase-policy.ts`, lista explícita `LIA_AUTO_PURCHASE_STORES` (vazia por padrão, ML assistido), `LIA_AUTO_PURCHASE_OFF`, aprovação por política após pagamento real/carrinho/endereço/conta verificados, nova conferência antes do envio. `PurchaseSpend` registra a reserva em centavos antes do clique, dentro da mesma transação da tentativa e de uma trava global entre lojas. Compras com aprovação individual também consomem orçamento; autorização individual é exceção explícita aos limites, indicada no painel. Resultado incerto, cancelamento e estorno não liberam saldo automaticamente. Revogação ou disputa pelo saldo antes de begin devolve para revisão sem clicar. Falha do comprador avisa o operador.

Painel mostra limites, gasto/reserva do dia e lojas explicitamente liberadas. Quando há lista automática, o comprador restringe novas reservas a ela; não altera a pesquisa automática do ML nem substitui produto escolhido pelo cliente. Cesta multiloja continua assistida. Lista de lojas liberadas vazia: nenhuma conta real homologada. Não preencher allowlist por inferência de cadastro/login.

Validação: 567/567 testes em Postgres local, migration sem drift; TypeScript do app/runtime, lint, build e painel no Chrome simulado aprovados. Migration aditiva `20260907120000_purchase_spend` precisa preceder publicação. Nenhum deploy, cartão salvo, compra real ou processo de compra iniciado nesta alteração. Falta concluir primeira conta/cartão, observar botão/comprovante/status, configurar processo e publicar. Detalhes: [política de compra](docs/compra-automatica-500-2026-09-08.md).

## 07/09/2026 — contas no Chrome em preparação

Por pedido do dono, preparar todas as lojas nos perfis persistentes do comprador. Cadastros incompletos; faltam dados, autenticação e verificação de cartão/checkout. Não considerar lojas habilitadas. Estado em [configuração das lojas](docs/configuracao-lojas-2026-09-07.md).

# Lia — Status do Projeto


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

## Decisão 06/09/2026 — compra nos sites, sem parceiros

O dono descartou lojas parceiras. A proposta de arquitetura foi revisada para usar
contas e pagamento corporativo da Lia nos sites existentes, com acompanhamento pelo
que o comprador recebe/acessa. Integração comercial com varejista saiu da estratégia.
Só documentação alterada nesta decisão; nenhuma automação ou compra foi ativada.


## 06/09/2026 — revisão técnica e operacional (local)

Relatório: [revisao-completa-2026-09-06.md](docs/revisao-completa-2026-09-06.md).
Corrigidos riscos em pagamento/razão/estorno, reserva de carrinho, vínculo de aprovação,
plano B e isolamento dos testes. Nova base de eventos de entrega com dedupe, recibos Meta
e pendências no painel. Preparação por loja é configurável, default ML; compra final
continua assistida. Leitor externo de rastreio ainda não conectado e ingestão desligada.

551/551 testes locais, zero skips, schema/migrations coerentes, tsc/lint/build aprovados.
25 alertas de dependências permanecem e Next14 precisa de atualização. **Não publicado.**
Migration DeliveryEvent necessária antes de usar código/monitor novos em produção.
Automação horária e cartões não foram alterados; nenhuma mensagem/compra real foi feita.

Direção recomendada, sujeita a decisão de produto: fechar o ciclo em poucas lojas, iniciar
compra por evento e acompanhar por evidência/pacote. Métricas do razão são uma amostra
recente e incompleta, sem comprovação de retenção ou rentabilidade.


## 15/09/2026 — botão "Adicionar ao carrinho"

O botão do card virou "Adicionar ao carrinho" (carrossel) / "Adicionar" (card solto, teto de
20 da Meta). Templates `vitrine_carrossel_v3_2..5` criados e **APROVADOS** em 15/09; carrossel
no ar com o texto novo. No mesmo dia: a pergunta do número do pedido ao operador dizia
"Mercado Livre" para qualquer loja (pedido da Cobasi) — corrigido, a loja vem do job.
Detalhe em AGENTS.md (15/09).

## 10/09/2026 — vitrine de 5 no carrossel

Com o carrossel ligado a vitrine mostra até 5 opções (3 nos cards soltos e no fallback); a IA
do rerank usa as vagas extras pra variar dentro do pedido. Templates de 4 e 5 cards criados
na Meta em 10/09. Detalhe em AGENTS.md (10/09).

## 07/09/2026 — carrossel da vitrine

**RELIGADO em 09/09** depois que o dono configurou moeda/cobrança no Business Manager:
`?action=carousel_test` mandou um carrossel de amostra pro operador e nenhum status
`failed` voltou (na falha de 08/09 ele chegava em 14 s). Rede de segurança segue ativa
(falha assíncrona → cards soltos + alerta). Histórico: desligado em 08/09 após o 1º uso
real falhar em silêncio (131042, conta sem moeda). Detalhe em AGENTS.md (08/09).

Histórico 07/09: templates `vitrine_carrossel_2/_3` APROVADOS pela Meta em
~5 min (marketing, ~R$0,33/envio), `LIA_CAROUSEL=true` na Vercel. Vitrine com 2–3 opções
e foto vai numa mensagem só ("Escolher este" + "Outras opções" por card, v2 pedida pelo
dono na mesma noite; "Ver detalhes" virou texto); 1 opção ou foto ruim cai nos cards
soltos. Observar a primeira vitrine real; desligar = env false.

## 07/09/2026 — Mercado Livre sem pergunta

Decisão do dono: acabou o "procuro no Mercado Livre?". Sem match bom nas vitrines (piso
léxico e, no resgate, o rerank da IA), o ML entra na mesma busca e as opções aparecem
direto; a frase completa do cliente vai pra essa busca. `LIA_LONGTAIL_OPTIN=true` volta ao
modo com pergunta (kill-switch de custo). Detalhe em AGENTS.md (07/09).

## 06/09/2026 — isqueiro pra charuto

Caso real do pai do dono: a IA encurtava a frase antes de buscar no Mercado Livre,
"isqueiro maçarico"/"tem que ser estilo tocha" não viravam busca nova, e o "sim" da oferta
era ignorado com escolha aberta. Os quatro pontos corrigidos. Detalhe em AGENTS.md (06/09).

## 05/09/2026 (2ª) — mais vendido da loja

Nas 9 lojas VTEX, entre opções de mesma relevância, o produto que a loja mais vende vem
antes (rank gravado no catálogo pela ordem de vendas do harvest). Detalhe em AGENTS.md (05/09 2ª).

## 05/09/2026 — "preciso pra hoje" e prazo por loja

Com urgência no pedido, a vitrine mostra só o que a loja entrega hoje (entrega mais rápida
da loja, prazo no card) ou diz que nada chega hoje e mostra o mais rápido. Prazo e frete só
aparecem para as 9 lojas com simulação ao vivo; as outras vão ao operador. Detalhe em
AGENTS.md (05/09).

## 04/09/2026 (8ª) — entrega expressa é escolha do cliente

Loja com entrega mais rápida na simulação (ex.: Drogaria SP SUPER EXPRESSA 60 min) → a
cotação oferece "mais barata" e "mais rápida" com preço e prazo da loja em cada botão; o
operador recebe a instrução de comprar com essa opção. Detalhe em AGENTS.md (04/09 8ª).

## 04/09/2026 (7ª) — prazo é da loja

"Chega em 90 min" virou "prazo da loja: 90 min" em cards e resumo; o resumo da cotação
instantânea agora mostra o prazo da loja. O prazo conta da compra na loja, que ainda é
manual. Detalhe em AGENTS.md (04/09 7ª).

## 04/09/2026 (6ª) — conversa real do dono

Cinco correções do teste real do desodorante: item novo com pedido parado vira pedido novo
sem perguntar; nome digitado estreita em vez de escolher; refino sem match busca a frase
inteira e mostra o mais perto; rodapé do Pagar.me removido; uma confirmação só após o
cartão. Detalhe em AGENTS.md (04/09 6ª). Pedido #OG9F4M pago às 14h07 aguarda compra manual.

## 04/09/2026 (5ª) — recursos do WhatsApp

"Digitando…" em toda mensagem, botão de localização no pedido de endereço (GPS vira CEP),
quantidade em lista, boas-vindas com perguntas sugeridas, perfil comercial e Flow de
endereço (formulário no chat). Configuração na Meta concluída e verificada em 04/09 (perfil, foto,
Flow publicado, boas-vindas com 4 prompts). Carrossel fica de fora: só existe em template de
marketing. Detalhe em AGENTS.md (04/09 5ª).

## 04/09/2026 (4ª) — "o de sempre"

Produto que o cliente já comprou vem em primeiro e com destaque ("⭐ Você já pediu este")
quando ele pede de novo; modelo de até 3 opções mantido por decisão do dono. Detalhe em
AGENTS.md (04/09 4ª).

## 04/09/2026 (3ª) — pré-voo, plano B e lembrete em 30 min

Antes de cobrar, a loja é consultada de novo com a cesta inteira: sem estoque/entrega → nada
cobrado e o cliente vê alternativas. Pedido pago que trava na loja ganha, em até 10 minutos,
uma oferta de troca por item confirmado em outra loja (botões Trocar/Devolver), com diferença
devolvida; só depois disso o estorno automático entra. Primeiro lembrete ao operador aos 30
min. Etapa ainda sem garantia: apertar o botão de compra (manual). Detalhe em AGENTS.md
(04/09 3ª).

## 04/09/2026 (2ª) — estorno automático

Pedido pago que a loja não consegue atender (bloqueado há 6h) ou sem compra há 24h é estornado
sozinho pelo provedor, com aviso ao cliente e ao operador, sem clique no /ops. Kill-switch
`LIA_AUTO_REFUND_OFF`. Detalhe em AGENTS.md (04/09 2ª).

## 04/09/2026 — /ops abre pelo WhatsApp

Operador manda "ops" pra Lia e recebe um link de 10 minutos; ao abrir, fica logado por 1 ano
no aparelho. Sem buscar OPS_TOKEN na Vercel. Fila reordenada por prioridade de ação (pago e
travado no topo) e idade em dias/horas/minutos. Template `pedido_atualizacao` aprovado na Meta
e env setada pelo Codex: avisos fora da janela de 24h já saem. Detalhe em AGENTS.md (04/09).

## 03/09/2026 (3ª) — avisos fora da janela de 24h da Meta

O vigia alertou às 12h e 24h, mas a Meta descartou as mensagens (erro 131047): fora da janela
de 24h só passa template aprovado, e o operador quase nunca escreve pra Lia. Agora aviso
proativo dentro da janela vai como texto; fora vai por template (`LIA_TEMPLATE_ORDER_UPDATE`)
ou não vai e fica registrado na nota do pedido. Falta o dono criar/aprovar o template na Meta
e setar a env. Detalhe em AGENTS.md (03/09 3ª).

## 03/09/2026 (2ª) — vitrine só mostra o que a loja confirmou para o CEP

Antes dos cards, cada candidato de loja consultável é simulado no site da loja para o CEP
do cliente: sem estoque ou sem entrega no endereço sai; confirmado ganha prazo real no card
e vem primeiro, do mais rápido ao mais lento. Cobrança automática só do que foi confirmado
ao vivo; o resto passa pelo operador. Detalhe e limites em AGENTS.md (03/09 2ª).

## 03/09/2026 — incidente do chá pago sem estoque: causa e consertos em produção

Um cliente real pagou R$24,14 por um chá que a Natural da Terra não tinha para o CEP
(mínimo R$50, sem entrega em outra loja) e ficou sem resposta o dia todo. Causa: loja fora
da simulação ao vivo + cotação automática sobre "tarifa padrão". Consertos: Natural da
Terra na simulação (barra `withoutStock` antes de cobrar) com mínimo R$50; tarifa padrão
vai pro operador; vigia de pedido pago sem compra (alerta 2h+, cliente avisado com
honestidade); botão "Não consegui comprar → estornar" no /ops. Detalhe em AGENTS.md
(03/09). O pedido do amigo do dono aguarda a decisão dele: estornar (1 clique) ou comprar
em outra loja.

## 02/09/2026 (3ª) — melhorias em produção

Deploy READY com as 4 migrations aplicadas (inclusive o DROP das tabelas do motor de
junho, autorizado pelo dono), `CRON_SECRET` criada, 29 envs mortas removidas da Vercel,
`.env.local.bak` apagado. Pendente do dono: `git push origin main` (10 commits locais) e
abrir `/ops?key=<OPS_TOKEN>` uma vez. Depois disso, observar o primeiro pedido real.

## 02/09/2026 (2ª) — quatro melhorias executadas: banco de teste local, dinheiro fechado, legado apagado, cérebro em módulos, classificar antes de buscar

Cinco commits, cada um com tsc, lint e suíte inteira verde (**476 testes em ~15 s** num
Postgres embutido — o remoto de produção não é mais tocado pelos testes; CI criada).
Dinheiro: razão `Payment`, estorno pela API do provedor no /ops, mock proibido em
produção, cron de reconciliação, desfecho desconhecido do cartão com alerta, Pix vencido
tratado. Legado: Twilio, /admin, /chat, /api/v1, motor ML de junho, fluxo legado de
catálogo, couriers/motoboy e guarda de km removidos (−30% de arquivos; modelos Prisma
legados ficam até o dono autorizar o DROP). Cérebro: 5.987 → 4.085 linhas + 4 módulos
(tipos, turno, pagamentos, operação). Roteamento: frase solta passa pela IA antes da
busca, "não sei" é resposta, Mercado Livre só depois de um "sim". Detalhe e ações do
dono em AGENTS.md (02/09 2ª) e no relatório
[docs/revisao-completa-2026-09-01.md](docs/revisao-completa-2026-09-01.md) (seção 6).

## 02/09/2026 — revisão completa: 19 correções (5 P0 de dinheiro), auth do /ops fechada, relatório de negócio

Revisão pedida pelo dono com o modelo novo. Fechados com regressão: webhook do Mercado
Pago aprovava sem conferir valor/id (agora vira alerta), cancelar/reabrir ignorava cartão
em cobrança e deixava o Pix antigo pagável (agora saída única com cancelamento no MP),
taxa do cartão contaminava o Pix após falha, frete "12,90" virava R$ 0 no /ops, /ops
falhava aberto sem token em Preview. Abertos (P1): retries do workflow de cartão mudos,
Pagar.me 4xx = "recusado", mock aprova sem env em prod, estorno sem API, rate limit.
Relatório com métricas reais e três caminhos de produto:
[docs/revisao-completa-2026-09-01.md](docs/revisao-completa-2026-09-01.md). **Ações do
dono:** aplicar a migration nova, deploy + abrir `/ops?key=` uma vez, decidir #YAQHF8/
#QTNL2T, apagar `.env.local.bak`, escolher o caminho da seção 4.5.

## 01/09/2026 (5ª) — revisão da 4ª fecha três brechas (toque do cartão, relógio da fusão, Pix pago com pergunta aberta)

Revisão de código da leva da manhã: o toque em "Pagar ••••" ainda deixava o turno mudo em
produção (workflow assíncrono) → "Me perdi aqui" no toque; a janela de "cobrança fresca"
lia o `updatedAt` do pedido, que uma reclamação renova; e o Pix pago com "juntar ou pedido
novo?" aberta apagava o item novo sem aviso. Os três fechados com E2E; detalhe em AGENTS.md
(01/09 5ª). Prova final do item 1 exige um toque real no canal Meta.

## 01/09/2026 (4ª) — conversa real: fusão silenciosa vira pergunta, fallback espúrio morto, Editar itens

O pedido real do dono expôs 4 defeitos, todos fechados no dia: pedido não-pago parado
+ item novo do nada agora PERGUNTA "juntar ou pedido novo?" (antes fundia sozinho com
"o total anterior não vale mais"); o "Me perdi aqui 😅" depois dos botões do cartão
salvo era a rede anti-silêncio disparando por engano (envio direto não marcava o
turno); o resumo da cotação ganhou o botão "Editar itens"; e a busca ruim ("apoio pra
guitarra de chão" → apoio de PÉ) virou 2 casos no golden pra consertar medido.
Detalhe em AGENTS.md (01/09 4ª).

## 01/09/2026 (3ª) — display name “Lia Delivery” novamente em análise

O WhatsApp Manager ainda mostrava como aprovado o nome público
`Lia Delivery by 67.742.955 Joseph Carlos Dayan`. A pedido do dono, a mudança para
**Lia Delivery** foi reenviada e agora consta como **In Review**. O texto antigo
permanece no WhatsApp até a decisão da Meta. Nenhuma alteração em código, número,
WABA, webhook ou pagamentos.

## 01/09/2026 (2ª) — polimento pós-bolha: Pagar, Pix sem eco, Ver detalhes, fim do "quantas unidades?"

Quatro pedidos do dono depois da primeira bolha real (#GAS8P9): botão pós-escolha
voltou a ser **"Pagar"**; a bolha Pix agora vai primeiro e **substitui** o texto de
instruções (só o copia-e-cola sai depois, como fallback universal); cards ganharam o
botão **"Ver detalhes"** em TODAS as lojas (link real do anúncio — reviews, fotos,
specs; Carrefour/Petz sem url por item usam link de busca da loja, validado ao vivo;
digitado "detalhes 2" também funciona); e a pergunta **"Quantas unidades?" morreu** —
escolha sem quantidade assume 1 un e o follow-up ganha o botão **"Mudar quantidade"**
(reabre 1/2/Outra pro último item). Detalhe em AGENTS.md (01/09 2ª).

## 01/09/2026 — bolha nativa de Pix NO AR: a Lia cobra com cara de app

A sonda ao vivo provou que a Graph aceita `pix_dynamic_code` no nosso número **sem
habilitação** (o 1º envio caiu na janela de 24h — erro 131047 —, o 2º chegou no
WhatsApp do dono). Envs ativadas na Vercel (`LIA_NATIVE_PIX=1` + recebedor "Lia
Delivery" com chave CNPJ Sensitive) e redeploy READY. Toda cobrança Pix real agora
sai com o copia-e-cola de sempre **e** a bolha nativa com botão "Pagar com Pix".
Ressalva aceita: o banco mostra o recebedor oficial (MEI = razão social com nome
civil). Falta: observar o 1º pedido real (log `[whatsapp:native-pix]`) e a v2
(enxugar textos + "pago ✅" nativo via webhook MP). Detalhe em AGENTS.md (01/09).

## 31/08/2026 — bolha nativa de Pix no chat (experimento atrás de flag)

Pagamento com cara de app dentro do WhatsApp: a cobrança Pix agora pode sair também
como `order_details` nativo (total + botão "Pagar com Pix" que abre o banco + copy
code), igual aos bots grandes. A doc da Meta não exige allowlist pra Pix dinâmico
(o cartão One-Click exigia e foi negado) — mas só o teste real confirma. Aditivo e
inofensivo: os textos de hoje continuam saindo antes da bolha, e falha na bolha nunca
bloqueia a cobrança. **Pra ligar (dono, na Vercel):** `LIA_NATIVE_PIX=1` +
`LIA_PIX_MERCHANT_NAME` + `LIA_PIX_KEY` + `LIA_PIX_KEY_TYPE` (chave da conta Mercado
Pago que recebe), depois um pedido de teste no próprio número olhando o log
`[whatsapp:native-pix]`. Detalhe em AGENTS.md (31/08).

## 30/08/2026 (3ª) — auditoria pós-rodadas 1–5: 479/479, sete lacunas fechadas

O pente-fino do código e a bateria integral contra o banco terminaram verdes: **479
testes, 479 aprovados, zero pulado**, mais TypeScript, lint e build de produção. A
auditoria encontrou e fechou sete lacunas residuais nos pontos novos: ambiguidade de
`quero sim`; dois vazamentos do teto no caminho Mercado Livre; alerta de suporte via IA
ausente durante escolha; confirmação financeira falsa ainda possível na resposta livre
da IA; cálculo prematuro de frete grátis no compositor; e redistribuição 2→2 com copy
contraditória/possibilidade de criar entrega adicional. Evidências e riscos externos que
continuam abertos em
[docs/auditoria-pos-rodadas-1-a-5-2026-08-30.md](docs/auditoria-pos-rodadas-1-a-5-2026-08-30.md).

## 30/08/2026 (2ª) — mudança de patamar: roteador LLM + cesta-como-conjunto no ar

Os dois ciclos estruturais aprovados pelo dono foram implementados e publicados: o
roteador LLM de fallback (a cauda infinita de frases deixa de precisar de regex nova —
"uma 51", "negocio de passar roupa" e "tira aquele negocio de lavar louça" resolvem
sozinhos, com filtro anti-promessa e dinheiro 100% determinístico) e a cesta-como-
conjunto V1 (lista grande escolhe a combinação de lojas que minimiza produtos+frete,
com cada troca anunciada — o frete fragmentado era o problema nº 2 há 3 rodadas).
Detalhe em AGENTS.md (30/08 2ª). Kill-switches: `LIA_LLM_ROUTER=false`,
`LIA_BASKET_COMPOSER_OFF=true`.

## 30/08/2026 — rodada 5 (4,30): funil de perguntas fechado no mesmo dia

Rodada 5 confirmou a recuperação (2,85 → 4,30; 11/11 totais; zero silêncio; zero
concessão em manipulação) e apontou a causa-mãe restante: pergunta sem intent virava
busca de produto. Ciclo do dia: 6 intents novos (cupom/promoção, cobrança indevida →
alerta URGENTE ao operador, agendamento, loja física, parcelamento, sondagem de
instruções) + backstop "essa eu não sei responder"; pergunta lateral reapresenta os
cards; ovos deduplicados também no caminho com IA (6+6=12 → 1 embalagem); teto por
extenso/"30 conto"; "quanto ficou mesmo?" com cobrança na mesa responde o total do
pedido; pivô "então me ve X" destrava escolha parada; comparação 1×2 honesta;
gilete/bombril/maisena → genérico certo. Detalhe em AGENTS.md (30/08). Relatório:
[docs/testes-rodada-5-2026-08-29.md](docs/testes-rodada-5-2026-08-29.md).

## 28/08/2026 — rodada 4 (protocolo hostil): 2,85/10 → ciclo grande de conserto

A rodada 4 foi desenhada pra mapear o teto (cliente difícil de verdade) e mapeou: média
**2,85**, com 19/20 sessões contendo resposta-robô ou silêncio — mas o dinheiro seguiu
intacto (12/12 totais certos, zero cobrança). O ciclo de conserto atacou as 8 famílias:
rede anti-silêncio estrutural (turno com zero respostas → fallback; mensagem sem texto
→ "só leio texto"; o webhook tinha um **400 mudo**), intents de confiança
(segurança/NF/CNPJ/quem entrega/preço vs site/pagar por terceiro/insulto), pausa e
retomada ("pera", "voltei", "na vdd quero sim" recupera cancelado), comando composto
executado em sequência, edição pós-total reabrindo o pedido, semântica de cesta
(quantidades, embalagem de ovos, teto global, correções embutidas, óleo de cozinha,
categoria de limpeza) e escolha com emoji/monossílabos. Detalhe em AGENTS.md (28/08).
Relatório do testador: [docs/testes-rodada-4-2026-08-28.md](docs/testes-rodada-4-2026-08-28.md).

**Nota de env**: `LIA_BUSINESS_INFO` (ex.: "Lia Delivery — CNPJ XX.XXX.XXX/0001-XX")
alimenta a resposta de CNPJ; sem ela a resposta é honesta sem número.

## 27/08/2026 (2ª) — rodada 3: média 6,80, dinheiro 12/12, achados novos consertados no dia

A rodada 3 (protocolo v3) validou o ciclo da rodada 2: média **4,15 → 6,80**, zero
cesta contaminada, zero divergência de total em 12 resumos auditados, e as guardas
novas (botão velho, furadeira, "de sempre", troca anunciada) funcionaram às cegas. Os
achados novos — auto-apresentação virando produto ("seu Jorge aqui" → imagem de São
Jorge), "meu neto quer um violão" como query inteira, narrativa ESCOLHENDO produto na
pausa, CEP engolido por cotação vencida (S18), "esquece o carregador" ignorado na
rajada e "não gostei" descartando o item — foram todos consertados e testados no
mesmo dia (AGENTS.md 27/08 2ª). Veredito do testador continua "ainda não deixaria
minha mãe usar sem ajuda"; os dois temas estruturais que sobraram são **frete
fragmentado (6/20 sessões)** e a recuperação pós-esgotamento de opções. Relatório:
[docs/testes-rodada-3-2026-08-27.md](docs/testes-rodada-3-2026-08-27.md).

**Ação do dono (continua): #YAQHF8 e #QTNL2T** — os dois pedidos pagos residuais
apareceram (rotulados com data e itens, como projetado) nos 20 encerramentos da
rodada. Conferir no painel Pagar.me se a chave é test ou live (`ch_VAolM1vcKiwjnK8m`)
e então estornar/entregar ou só cancelar no /ops.

## 27/08/2026 — rodada 2 (4,15/10): forense mudou o diagnóstico, consertos implementados

A rodada 2 confirmou o avanço em estado (perda 12/20 → 3/20) e derrubou a média por
UX/integridade (4,15). A forense no banco provou que os dois "P0s" não eram corrupção:
**#YAQHF8 é uma cobrança REAL de cartão (R$20,62, 25/08, Pagar.me) parada em `paid`** e
o "PlayStation fantasma" foi pedido pelo próprio telefone de teste e largado aguardando
pagamento — o bug real era a APRESENTAÇÃO (pedido antigo sem data nem itens). Sete
blocos de conserto implementados no mesmo dia (status ancorado em data+itens, memória de
cancelamento, guardas anti-turno-velho, troca de loja anunciada item a item, resumo com
preço por linha, pós-total com "mais barato"/"mais rápida" funcionando, narrativa fora
da extração, escolha destravada, "de sempre" com conferência). Detalhe em AGENTS.md
(27/08). Relatório do testador:
[docs/testes-rodada-2-2026-08-27.md](docs/testes-rodada-2-2026-08-27.md).

**Ação do dono (URGENTE): decidir o destino de 2 cobranças reais paradas** —
`#YAQHF8` (R$20,62, pago 25/08, nunca comprado) e `#QTNL2T` (R$80,93, pago 23/08,
`retailer_preparing` desde a compra): entregar ou estornar no /ops / Pagar.me.

## 26/08/2026 — 20 sessões ao vivo: piloto amplo bloqueado

Vinte sessões adversariais no WhatsApp, sem pagamento, deram média auditada **4,30/10**
(4,55 na atribuição inicial; sessão 19 rebaixada após auditoria). O achado P0 foi uma
cesta da sessão 18, já cancelada, reaparecer na sessão 19 e chegar ao Pix junto do item
novo. Outros bloqueadores: seis respostas de status/cancelamento para o pedido errado,
trocas silenciosas de produto, processamento fora de ordem, três tetos de preço violados
e prazo prematuro nos cards. A causa provável do vazamento de estado é a combinação de
trabalhos assíncronos por mensagem com a trava que permite `barge` após 15 segundos,
enquanto buscas podem durar muito mais.

Não tratar “12 chegaram ao total/Pix” como 12 compras válidas. O piloto amplo fica
bloqueado até zerar vazamento de sessão, falso estado financeiro e mutação silenciosa.
Relatório completo em
[docs/relatorio-completo-problemas-lia-2026-08-26.md](docs/relatorio-completo-problemas-lia-2026-08-26.md);
scorecards em
[docs/testes-20-clientes-2026-08-26.md](docs/testes-20-clientes-2026-08-26.md).

## 20/08 — silêncio absoluto não existe mais (watchdog + timeouts em camadas)

O reteste da mochila morreu em silêncio (teto da função dentro do waitUntil; OpenAI sem
timeout na 2ª extração do resgate; token ML de 55 dias custando 4s/busca). Agora:
watchdog de 45s avisa o cliente que a Lia continua no pedido; OpenAI e Mercado Pago com
timeout de 10s; resgate de última chance respeita orçamento de 90s do turno; rota
oficial do ML de castigo após 401 e env do token morto removida. Detalhe em AGENTS.md.
**Ação do dono (1 min):** conferir Fluid Compute ativo no projeto da Vercel.

## 19/08/2026 — rodada adversarial ao vivo: 5 sucessos, 1 parcial, 2 falhas

Foram testados 8 cenários difíceis no WhatsApp, sem alteração de código e sem cobrança.
Passaram churrasco com negação escopada, cauda longa de violão até R$500, troca de item,
presente com teto de R$100 e quantidade 4x → 7x → 5x em bombons. “Sem remédio” e “qualquer
time” não viraram produtos; “4” solto ajustou a quantidade.

Dois achados importantes contradizem o comportamento esperado documentado em 19/08: o
“mais barata” seco ainda escolheu o menor preço em vez de apenas navegar, e “Outras opções”
após uma escolha não reabriu a busca — respondeu pedindo para reformular. Repetir esses dois
casos depois de confirmar qual versão está servindo a sessão. A única rodada que chegou ao
pagamento foi cancelada antes da cobrança; a Lia confirmou que nada foi cobrado.

## 19/08 (2ª) — teste real da mochila: 5 defeitos de conversa fechados

"Mais barata" seco não compra mais nada (navega pras mais baratas); "Outras opções"
com escolha fechada reabre a última escolha e o novo pick SUBSTITUI o item na cesta;
"mais barato" solto reabre ordenado por preço; aviso "Procurando…" sai uma vez só; e a
recusa de uma linha com opções das outras na mesma mensagem ganhou escopo ("*sacola* eu
não achei — o resto achei e tá logo abaixo"). Detalhe e racional em AGENTS.md (entrada
19/08 2ª). Latência da busca fria do ML segue limitação conhecida do actor.

## Atualização 19/08/2026 — /admin com login de usuário e senha

Revisão completa pré-lançamento: `/admin`, `/api/admin/*` e `/api/conversations/*` (legado
do `/chat`) estavam sem autenticação em produção. Agora exigem login (`ADMIN_USER`/
`ADMIN_PASSWORD`, Sensitive na Vercel, falha fechado quando ausentes); sessão por cookie
httpOnly de 30 dias. O `/ops` continua com `OPS_TOKEN`, inalterado. Achados restantes da
revisão em andamento em sessões paralelas: Pix mock quando o Mercado Pago falha com
credenciais reais, e conversa presa após `opsCancelRefund` + `choosing_freight` sem TTL.

## Atualização 18/08/2026 — falha do Mercado Pago não vira mais cobrança de mentira

Corrigido um furo de dinheiro em `src/lib/payments/mercadopago.ts`: com
`MERCADO_PAGO_ACCESS_TOKEN` setado, um erro na chamada real (timeout/5xx) caía num
`catch` que logava `[pix:create:fallback-mock]` e devolvia um Pix **mock**
(`mockpix_...`) para um pedido real. Duas consequências: o cliente recebia um
copia-e-cola incolável com a dica de sandbox ("responda *paguei*") e, como
`delivery-service` trata pixId iniciado em "mock" como sandbox, esse "paguei" chamava
`markDeliveryOrderPaid` — pedido **pago sem dinheiro nenhum**. O mesmo padrão existia no
`createCheckoutLink` (link `https://mock.lia/...` enviado ao cliente).

Agora, com credencial real, o adapter lança `PaymentProviderError` (logs
`[pix:create:failed]` / `[checkout:create:failed]`). O cérebro trata a falha em vez de
disfarçá-la: avisa o cliente com `copy.paymentIssueFailed()` ("Não consegui gerar seu
pagamento agora — nada foi cobrado. Responde *pix* ou *cartão* que eu tento de novo."),
**mantém o pedido em `awaiting_payment`** (ou devolve a cotação para
`awaiting_quote_confirmation`, com o contexto da conversa junto), anota
`⚠️ Falha ao gerar a cobrança` no `/ops` e alerta o operador no WhatsApp
(`copy.operatorPaymentFailedAlert`). Repetir *pix*/*cartão* reemite a cobrança de
verdade: `resendCharge` passou a detectar pedido sem `pixCopiaECola` e reemitir pelo novo
`issueChargeForOrder` (usado também na criação do pedido), em vez de reenviar um código
que não existe. `handlePaidClaim` só aceita o atalho de sandbox quando
`paymentsAreMocked()`, então um pixId "mock" residual em produção não aprova nada. Mock
segue valendo sem credencial (dev/testes). Coberto por
`tests/payment-issue-failure.test.ts` (8 casos: adapter puro + evals com banco real e
`fetch` quebrado). `tsc` limpo e testes focados verdes. **Sem deploy** — publicação
depende de autorização do dono.

## Atualização 19/08/2026 — conversa não fica mais presa em pedido morto

Duas correções de conversa saíram de uma revisão dupla independente do
`src/lib/delivery-service.ts` (achados de 18/08):

- Cancelamento/estorno pelo operador (`opsCancelRefund`) agora **reseta o contexto da
  conversa**, como o pagamento já fazia. Antes, o cliente continuava ouvindo "ainda estou
  cotando" de um pedido cancelado; e, se a conversa estivesse na escolha de entrega, o
  toque no botão de frete caía em erro genérico repetido, sem saída além de "trocar
  endereço". `handleCancel` também limpa o ponteiro morto ao responder "não tem pedido".
- A escolha de entrega (`choosing_freight`) **expira**: entrou no TTL de abandono de 1h
  (`LIA_QUOTE_ABANDON_TTL_MS`) e a própria escolha guarda quando o frete foi consultado
  (`quotedAt`). Toque tardio cancela o pedido não-cotado em vez de publicar frete e data
  vencidos numa cotação pagável.

Cobertura nova em `tests/manual-concierge.test.ts`. Gate focado (`tsc` + suíte do
concierge) verde. **Sem deploy** — publicação depende de autorização do dono.

## Atualização 17/08/2026 — OAuth Mercado Livre em preparo

Foi preparada localmente uma integração OAuth segura para a API oficial de busca do Mercado
Livre: tokens cifrados no banco, callback de `liadelivery.com.br` com state anti-CSRF e fallback
para Apify. A criação da app **não aconteceu**: o DevCenter autenticado devolveu
`OPT02-EN1XAJYDKPNW` e retornou ao início após retry. Não houve deploy, migration aplicada,
segredo, token, compra ou notificação. O próximo passo é o dono regularizar a elegibilidade da
conta no DevCenter/suporte; a API não serve para compras ou rastreio de pedidos como comprador.

> Memória canônica para agentes: [AGENTS.md](AGENTS.md). Progresso e próximos passos:
> [PENDENCIAS.md](PENDENCIAS.md). Leia ambos antes de interpretar este status ou tomar
> decisões de produto.

_Última atualização: 2026-08-19. Doc de leitura rápida do estado atual. O histórico de
decisões ("por que esse modelo") está no [CLAUDE.md](CLAUDE.md); os ciclos recentes estão
em [docs/evolucao-conversa-2026-07.md](docs/evolucao-conversa-2026-07.md) e
[docs/operacao-canais-2026-07.md](docs/operacao-canais-2026-07.md). A revisão operacional
de hoje está em
[docs/decisoes-operacionais-2026-07-14.md](docs/decisoes-operacionais-2026-07-14.md)._

---

> **Revisão de copy 2026-08-17 — tom direto e prazo honesto.** O dono revisou as ~110
> mensagens automáticas de uma vez (levantamento completo em
> [docs/todas-as-mensagens-da-lia.md](docs/todas-as-mensagens-da-lia.md), com o texto antigo
> ao lado do novo). Régua vigente, aplicada em `src/lib/lia-copy.ts`: verbo na frente, sem
> preâmbulo de simpatia ("Prontinho", "Opa", "Fechado!", "Deixa comigo"), sem explicar a
> mecânica interna, no máximo 1 emoji, uma saída por mensagem, **sem lista de exemplos de
> produto** e **sem endereço/CEP fictício** (descrever os campos, nunca inventar um). O 💚
> caiu de 8 para 2 ocorrências. A apresentação da Lia agora é uma frase só, idêntica nos
> quatro pontos de entrada.
>
> **Regra que não pode ser quebrada: nada de prazo antes de cotar.** Quem manda no prazo é o
> checkout da loja e ele varia — às vezes é no mesmo dia, às vezes leva dias. Saiu "chega
> hoje" / "no mesmo dia" / "em ~1h" / "1 a 2 horas" de toda mensagem genérica (`help`,
> `serviceAnswer:eta`, `serviceAnswer:generic`). Junto disso caíram os fallbacks
> `etaMinutes ?? 40` e `?? 90` do `summary`/`manualQuoteSummary`: sem prazo real da loja, a
> linha de entrega sai só com o valor, nunca com um número inventado. O prazo aparece uma vez
> só, no resumo, e sempre com o dado que a loja devolveu.
>
> ✅ **Landing revisada (2026-08-18):** `page.tsx`, `layout.tsx`, `opengraph-image.tsx` e o
> mock do celular passaram pela mesma régua: zero "entrega no mesmo dia"/"chega hoje" (prazo
> só como "aparece antes de pagar", FAQ "Quando chega?" honesta), "paga no Pix" virou "Pix ou
> cartão" em todo lugar, e o letreiro perdeu os preços inventados. O mock usa as mensagens
> reais de `lia-copy.ts` (resumo com frete/prazo da loja, Pix em mensagem separada,
> `paymentConfirmed`). Também saiu o "sem mensalidade, sem taxa escondida" da FAQ (dono
> vetou em 18/08 — o markup embutido tornaria a frase falsa). Visual: paleta **Berinjela &
> lima** (roxo `#3A225E` + papel lilás `#F7F4FB` + lima `#D9FF5B`), escolhida pelo dono no
> seletor de paleta ao vivo (seletor temporário, removido após a escolha); CTAs e mock do
> celular em roxo/lima. O avatar `LiaWhatsAppAvatar`, o favicon e a arte da foto de perfil
> do WhatsApp foram refeitos em lima `#D9FF5B` + roxo `#3A225E` (o PNG novo foi entregue
> ao dono pra subir no app).

> **Remodelagem 2026-07-20 — concierge manual (fluxo ativo).** O produto passou a ser um
> concierge de WhatsApp com **largura** (pede qualquer coisa, de qualquer lugar), **cotação e
> compra manuais pelo operador** e **entrega na hora por motoboy que sai da base do operador**.
> A automação de checkout (Browserbase) saiu do caminho crítico (`LIA_MANUAL_CONCIERGE=true`,
> default). Ao fechar a lista, cria-se `awaiting_operator_quote`; o operador cota no `/ops` e o
> pedido reaproveita `awaiting_quote_confirmation` + a máquina de pagamento existente. Detalhes
> e racional em [AGENTS.md](AGENTS.md) (topo) e no registro datado. A seção abaixo descreve o
> fluxo legado de automação, mantido atrás da flag e ainda usado como referência/testes.

> **Estado em 21/07.** O fluxo concierge passou por uma demonstração local mockada completa:
> cotação manual de R$100, Pix confirmado, compra, despacho Uber Direct a partir da base do
> operador e entrega — incluindo as mensagens ao cliente; não houve cobrança real. Os commits
> `bb48c2e`, `ededf6a` e `7ab8453` estão verdes, mas o concierge ainda não foi implantado porque
> o deploy arrastaria uma migration Oba inacabada de outro trabalho. A decisão é contratar um
> operador. A fila de Production contém 19 pedidos técnicos e só pode ser limpa com aprovação
> explícita.

> **Atualização 02/08.** A Lia opera **somente no estado de São Paulo**. No concierge, o código
> rejeita qualquer UF fora de SP (e usa o prefixo do CEP como fallback quando o ViaCEP cai),
> independentemente dos overrides legados de cobertura. O deploy final de código foi publicado no
> commit `a700290` como `dpl_5kTpBbsitN6BgP5vcQrDh22AfqP4` (`Ready`), reassumindo `liadelivery.com.br`. As flags
> `LIA_MANUAL_CONCIERGE=true` e `LIA_REQUIRE_REAL_COURIER_DISPATCH=true` estão explícitas em
> Production. O código impede despacho mockado quando o provider é Meta e exige endereço + CEP
> reais da base do operador. A base foi configurada como Sensitive em Production; `PURCHASE_AUTOMATION_MODE=cart_only`
> e a compra automática desligada estão ativas. A primeira validação com pedidos reais não é
> pendência de desenvolvimento: fica a critério do operador depois que os gates abaixo estiverem
> concluídos.

> **Reconciliação de código.** O snapshot publicado foi consolidado no commit `a700290`; `main`
> local foi avançada por fast-forward até ele e o worktree está limpo. O push de `main` para o
> GitHub ainda não foi feito.

> **02/08 — 2ª rodada (decisões do dono + verificação).** O piloto será operado pelo próprio
> dono (sem contratar operador). Rotina fiscal decidida e documentada em
> [docs/rotina-fiscal-mei.md](docs/rotina-fiscal-mei.md). Rotação das credenciais expostas
> abandonada como gate de piloto (risco aceito). Conta Mercado Pago: conferir no painel se já
> é PJ (o dono acredita que sim; API local sem escopo para confirmar). Verificação técnica:
> suíte **213/213 verde com banco**, `tsc` limpo, produção `READY` no commit `a700290`,
> landing/`/ops`/webhook OK. Vitrine em runtime: **7.652 produtos em 11 lojas** — Carrefour
> 1.045, Petz 2.812, Boticário 1.380, Ri Happy 1.196, Swift 925, Kopenhagen 248, Kalunga 15,
> Droga Raia 13, Cacau Show 12, Decathlon 4 (filtro de imagem corta 13 dos 17), Oba 2
> (busca ao vivo em prod). Lacunas de demanda mapeadas (e-commerce/delivery BR): farmácia
> não-remédio (Droga Raia só 13 itens de seed), bebidas/adega dedicada, flores/presentes,
> eletrônicos/acessórios, moda básica e hortifruti fresco (Oba ao vivo cobre em tese). No
> concierge nada disso bloqueia pedido — item fora de vitrine vira linha livre que o operador
> cota; as lacunas afetam só a vitrine com foto.

> **02/08 — vitrine ampliada para 18 lojas / 17.264 itens.** As lacunas acima foram fechadas
> por decisão do dono. Novas: **Drogaria São Paulo (4.675)** e **Pague Menos (1.540)** para
> farmácia sem remédio, **Natural da Terra (1.000)** para hortifruti, **Cobasi (998)** como
> redundância de pet, **Divvino (998)** e **Imigrantes Bebidas (406)** para bebidas, e
> **Giuliana Flores (204)** para flores/presente. Dados reais, CDNs testados como hotlinkáveis.
> Nas farmácias a regra ANVISA virou **tripla guarda**: allowlist de categoria + deny-regex na
> colheita e `withoutMedicine` em runtime (`src/lib/stores/anvisa.ts`). A terceira foi
> necessária — a loja classifica medicamento dentro de categorias cosméticas (cetoconazol,
> metronidazol, ciclopirox passaram pelas duas primeiras). 18 itens removidos; regra travada em
> `tests/anvisa-pharmacy.test.ts`. A mesma auditoria pegou o lado pet: Cobasi (65 medicamentos
> veterinários + 56 dietas de prescrição) e Petz (58 itens da linha "Nutrição Clínica") agora
> passam por `withoutVeterinaryMedicine` — inclusive a busca ao vivo da Petz. Roteamento ganhou
> dicas de bebida e flor.
> **Leroy Merlin não entrou**: bloqueia fetch (403) e a listagem não expõe imagem sem uma visita
> por produto. Detalhes em [AGENTS.md](AGENTS.md) e [README das vitrines](src/lib/stores/README.md).

> **03/08 — Browserbase removido; catálogo com rotina mensal.** O navegador remoto saiu do
> produto inteiro: busca ao vivo, os 3 compradores automatizados, o lease de Context, o
> workflow de compra, as rotas de preflight/sessão viva do `/ops`, o cron de prewarm e as
> dependências `@browserbasehq/sdk`/`playwright-core`. Tudo isso já era código morto (atrás de
> `manualConciergeEnabled()` e de `PURCHASE_AUTOMATION_ENABLED=false`). A **Oba** deixou de
> depender dele: a API pública dela responde direto e virou catálogo de **1.494 itens**.
> Preço agora se atualiza por rotina mensal — `npm run catalog:refresh` (`--dry` simula),
> que recolhe as 10 lojas com API/SSR aberta e resume o que mudou. Suíte **210/210 verde**,
> `tsc`, lint e build limpos. Detalhes em [AGENTS.md](AGENTS.md).

> **03/08 — PUBLICADO.** Os 27 commits locais foram enviados ao GitHub e o deploy
> `dpl_BKzUbC4brKprMqrdMYJQ7QDnt5Kr` (commit `cf131f5`) ficou `READY` em Production.
> Smoke verificado: landing 200, `/ops` 200, webhook 403 (assinatura exigida) e as rotas
> Browserbase removidas respondendo 404 (`/api/cron/prewarm-search`,
> `/api/ops/internal-preflight`, `/api/ops/live-retailer-session`) — prova de que o código
> novo está no ar. Produção agora tem: 18 lojas (~17,4 mil itens), guardas ANVISA/MAPA em
> runtime, Oba com catálogo de 1.494 itens e zero Browserbase. O piloto pode começar.

> **03/08 — vitrine híbrida ligada.** A Lia deixou de só anotar: agora procura o pedido nas
> 18 lojas e mostra até 3 opções com foto para o cliente escolher; o que não tem match vira
> linha livre e o operador garimpa — a largura continua intacta. Três regras novas travam a
> qualidade: (1) **piso de relevância próprio do concierge** (`conciergeMatchIsStrong`) — no
> concierge um palpite errado é pior que nenhum, porque a linha livre resolve de verdade; o
> caso real que motivou foi "conserto de torneira" casando com "Espumante Concerto"; (2)
> **escolher não fecha a lista** — o cliente segue somando e só fecha com "só isso"; (3)
> **fechar com escolha pendente não descarta o item** — ele vira linha livre. Suíte 220
> testes (219 verdes; 1 flake de conexão do Postgres que passa isolado), `tsc`, lint e build
> limpos.

> **03/08 — One-Click reativado por decisão do dono.** O cartão nativo no WhatsApp (Meta
> Cloud API direta + Pagar.me) deixa de ser "adiado": a ativação começou. Código e migrations
> já estão em produção. Em 03/08 a Infobip NEGOU a habilitação; em 04/08 o pedido foi aberto
> diretamente no Suporte da Meta, protocolo `37565409896407734` — **encerrado pela Meta em 05/08 com resposta padronizada, sem análise** —, categoria
> **Dev: Cloud API / Messages API and Webhook**. A Payments API BR segue em beta fechado e as
> habilitações documentadas passam por BSPs; o chamado não garante aprovação nem prazo. Plano B:
> Checkout Pro até a disponibilidade geral. A dúvida técnica do Pagar.me foi
> resolvida por documentação: `recurrence_cycle` é só de recorrência externa; o adaptador
> atual está correto e nenhum e-mail ao PSP é necessário. O piloto não espera:
> Pix + Checkout Pro cobrem cartão até lá. Plano completo e divisão do trabalho em
> [PENDENCIAS.md](PENDENCIAS.md) (seção One-Click) e [docs/whatsapp-one-click-pagarme.md](docs/whatsapp-one-click-pagarme.md).

> **05/08 — decisão do dono: cartão salvo SEM esperar a Meta.** "Se não vai ser automático,
> no mínimo deixa o cartão salvo" — redigitar cartão a cada compra é atrito inaceitável. O
> desenho aprovado reusa a infraestrutura One-Click já pronta (página `/cartao` com
> `tokenizecard.js` → Pagar.me, `PaymentCredential` tokenizada, cobrança idempotente por
> `PaymentAttempt`, webhook de reconciliação): a única troca é o gatilho da recompra — botões
> comuns de resposta do WhatsApp ("Pagar com cartão •••• 1234") em vez do `order_details`
> nativo da Meta, que segue estacionado atrás de `LIA_ENABLE_WA_PAYMENTS`. Flag nova e
> independente (`LIA_ENABLE_SAVED_CARD`), desligada até o sandbox validar com as chaves
> Pagar.me (criação da conta segue sendo ação do dono). Recusa/indisponibilidade cai no
> Checkout Pro, que permanece como fallback permanente.

> **05/08 — cartão salvo construído (sem Meta).** O modo `LIA_ENABLE_SAVED_CARD` foi
> implementado reusando o alicerce One-Click: primeira compra cadastra o cartão no link
> seguro `/cartao` e cobra; recompra é confirmada por botões comuns ("Pagar •••• 1234" /
> "Usar outro cartão", ids `cardpay:<attemptId>`/`cardother`), com formas por texto
> equivalentes. Desfechos viram texto comum; recusa cai no Checkout Pro; "outro cartão"
> expira a tentativa e re-cadastra. `cardOnFileEnabled()` garante que chave Pagar.me sem
> flag não muda o checkout. Testes novos em `tests/saved-card.test.ts` (6, com banco e
> mock Pagar.me): oferta, toque, replay sem dupla cobrança, texto, troca de cartão e
> resposta honesta sem pendência. Falta para ligar: conta/chaves/domínio/webhook Pagar.me
> (ação do dono) + sandbox real. A flag segue desligada.
> **Regra de produto (05/08):** depois da primeira compra, o cliente **nunca redigita o
> número do cartão**. Se o sandbox mostrar antifraude exigindo CVV, a contingência aprovada
> é o modo CVV-only na página `/cartao` (mostra "Pagar com •••• 1234" e pede só os 3
> dígitos). Conta de teste Pagar.me criada em 05/08 (grátis, loja "Lia Delivery"); a
> habilitação comercial/chaves live só acontece se a bateria de sandbox aprovar.

> **05/08 — 1ª bateria sandbox Pagar.me: contrato OK, simulador não habilitado.** Com as
> chaves da loja "Lia Delivery" (criada no plano à vista, pré-habilitação), a bateria provou
> na API real de teste: tokenização pela chave pública ✅, criação de cliente ✅, contrato de
> order/idempotência aceito ✅. Porém TODA aprovação falha: salvar cartão → 412 "card
> verification failed" (com e sem `verify_card`, cartões 4242… e 4000…0010) e cobrança →
> `not_authorized` 1011 "Número do cartão inválido" — mesmo seguindo as regras documentadas
> do Simulador PSP (Luhn válido + CVV 123). Conclusão: as chaves dessa loja são de PRODUÇÃO
> pré-habilitação (por isso sem o infixo `test_`), e o simulador NÃO roda nela. O caminho é a
> **conta de teste separada** (company.pagar.me → Contas → criar conta de teste), cujas chaves
> `sk_test_`/`pk_test_` ativam o simulador. Nenhum custo incorrido; a condição "só pago se
> funcionar" segue intacta.

> **05/08 — VEREDITO DO SANDBOX: o cartão salvo FUNCIONA.** Com a conta de teste
> "Lia Delivery - test" (chaves `sk_test_`/`pk_test_`), a bateria completa passou contra a
> API real: tokenização ✅, cliente ✅, **salvar cartão pelo adapter com verificação ligada** ✅
> (nenhuma mudança de código necessária), **cobrança com `card_id` SEM CVV APROVADA** ✅ (a
> pergunta central), replay com mesma Idempotency-Key devolve a MESMA order ✅ (dupla cobrança
> impossível), reconciliação `getOrder` ✅ e **recusa pelo antifraude → `declined`** ✅ (regra
> do Simulador PSP com documento 111…), acionando o fallback Checkout Pro. A condição do dono
> ("só pago se funcionar") está satisfeita. Nota: a 1ª bateria falhou porque as chaves da loja
> de produção pré-habilitação não rodam o simulador — o diagnóstico está no registro anterior.
> **Para ligar em produção falta:** (dono) habilitação comercial → chaves live; cadastrar
> `liadelivery.com.br` para o tokenizecard.js; chaves live + `PAGARME_WEBHOOK_TOKEN` +
> `LIA_PUBLIC_URL` na Vercel (Sensitive). (agente) cadastrar webhook com os 6 eventos, ligar
> `LIA_ENABLE_SAVED_CARD=true`, smoke real de R$ ~1 com estorno.

> **06/08 — busca da vitrine reconstruída: IA escolhe o produto + placar medido.** Caso real:
> "carregador usb c" devolvia 3 carregadores veiculares (mesmo item, 3 cores) com o carregador
> de parede USB-C parado em outra vitrine. A busca deixou de ser só léxica: candidatos largos
> nas 18 lojas (`gatherCrossStoreCandidates`) → **rerank por IA** (`rerankShoppingOptions`,
> 1 chamada batched por mensagem, skus validados, timeout 6s, kill-switch
> `LIA_SEARCH_RERANK_OFF`) → fallback determinístico melhorado (compostos usb-c, typo-fuzzy
> mais estrito — "miojo" não vira vinho "Miolo" —, marca sem typo, bônus de categoria, bônus
> "sem X", diversificação de cores) → nada serve = linha livre do operador. Quando o rerank
> roda, ele substitui o piso `conciergeMatchIsStrong`. Qualidade agora é MEDIDA:
> golden set com 32 casos (`tests/helpers/search-golden.ts`), regressão determinística no
> `npm test` e placar completo via `npx tsx scripts/eval-search.mts` — **31/32 determinístico
> · 32/32 com IA**. Busca ruim nova → vira caso no golden → mede → conserta.
> O método já se pagou: varrer 60 pedidos realistas achou 4 bugs não reportados —
> "cotonete" não achava o cotonete do catálogo, "leite" devolvia loção de pele
> ("Leite de Rosas"), "água" vinha com gás, e a penalidade nova de item-pet punia
> refrigerante porque em catálogo brasileiro **"PET" é a garrafa plástica**.
> Invariante que saiu do lote: **penalidade reordena, guarda exclui**. Fora do scorer,
> `score > 0` significa "casa ou não casa" — duas penalidades somadas derrubaram um match
> legítimo para -1 e quebraram o "tira o X" (o cliente não conseguia mais remover o item
> da cesta). Item que passou pelas guardas nunca cai abaixo de 1. Pego pelo eval de
> conversa legado, não pelo golden: os dois harnesses cobrem coisas diferentes.
> Bônus: `talk-env.mts` nunca carregava o `.env` (bug `__dirname` em ESM) — por isso os
> scripts locais rodavam "sem IA" mesmo com chave; corrigido.

> **10/08 — FRETE AO VIVO POR CEP (precisão final).** No fechamento, a Lia consulta o
> checkout real de cada loja da cesta (VTEX `orderForms/simulation`) com a CESTA e o CEP
> exatos do cliente — frete certo para aquele endereço, frete grátis aplicado pelo próprio
> site (validado: Swift devolveu R$0 em carrinho de R$499). Consultas em PARALELO com
> timeout de 4,5s (`LIA_LIVE_FREIGHT_TIMEOUT_MS`; medido: fria ~3s, quente ~0,6s) — teto
> real de espera extra do fechamento. 8 lojas abertas (Pague Menos, Drogaria SP, Cobasi,
> Oba, Swift, Divvino, Kopenhagen, Ri Happy); Carrefour/Petz bloqueiam → tabela por
> política. Resposta válida SEM opção de entrega = site não atende o CEP → cai pro
> operador (não se cobra entrega que não existe). Teto de sanidade `LIA_LIVE_FREIGHT_MAX`
> (150); kill-switch `LIA_LIVE_FREIGHT_OFF`. Fonte visível por loja na nota do /ops
> ("ao vivo"/"tabela"/"tarifa padrão") + log `[instant-quote:live]` por consulta — o 1º
> pedido real diz se o site trata o IP da Vercel diferente (se bloquear, fica na tabela
> sozinho). Módulo `src/lib/live-freight.ts`; unit 4/4 (fetch mockado), E2E 3/3
> (determinísticos via kill-switch no load-env).

> **09/08 (3ª) — COTAÇÃO INSTANTÂNEA: o cliente não espera mais no chat.** Decisão do dono
> ("na hora que estiver falando com a Lia é rolê esperar; depois pode esperar o quanto for"):
> cesta 100% de vitrine agora fecha com o TOTAL na mesma resposta — a Lia auto-publica a
> mesma cotação que o operador digitaria (`tryPublishInstantQuote` → `opsPublishManualQuote`,
> modo `retailer_delivery`) e o pedido chega ao `/ops` já indo pra pagamento; a espera fica
> na compra/entrega. **A entrega é pelo SITE de cada loja** (correção do dono na mesma
> conversa: "não é via Uber, é via site" — o operador compra no site e a loja entrega), então
> o frete é a POLÍTICA DO SITE, por loja ("2 lojas = 2 fretes"): env
> `LIA_STORE_FREIGHT_<LOJA>` + frete grátis por limiar `LIA_STORE_FREE_ABOVE_<LOJA>` (sobre
> o subtotal de custo daquela loja, como o site calcula); sem política configurada,
> `LIA_FREIGHT_DEFAULT` (18) com marca "(tarifa padrão)" na nota do `/ops` — gritando que
> falta calibrar. Linha livre (sem preço) mantém o caminho manual. Kill-switch
> `LIA_INSTANT_QUOTE=false`. Módulo `src/lib/instant-quote.ts` (puro). Política de preço
> defasado: a margem de 10% absorve; acima, avisar e estornar a diferença. Testes: 3 E2E +
> 4 de unidade. **Ação do dono:** preencher na Vercel o frete real do site de cada loja que
> usa (ex.: `LIA_STORE_FREIGHT_CARREFOUR=14.90`, `LIA_STORE_FREE_ABOVE_CARREFOUR=99`).

> **09/08 (2ª) — CARDS VALIDADOS EM PRODUÇÃO + botões pós-escolha.** Teste real do dono:
> "Quero um cotonete" → cards chegaram com foto e botão, escolha "2" funcionou — o fix do
> `safeMediaLink` (URL com `®`) está confirmado no mundo real; zero `meta-status-failed` no
> banco. Na sequência, pedido novo do dono implementado: a confirmação pós-escolha agora traz
> 3 botões — **Pagar** (fecha e cota), **Adicionar mais itens** e **Cancelar** — via
> `sendChoiceFollowUp` (ids caem nos ramos já existentes: "pagar", "adicionar_mais",
> "cancelar"); fallback = texto de sempre quando não é Meta ou o interativo falha.

> **17/08 — busca fria do ML mais rápida + tag de urgência no /ops (PUBLICADOS).**
> Pedido do dono ("30s → 10-15s?"): o teto é o actor. Medido: 4GB de memória derruba o
> run de 28,5s pra 21,1s (grátis — actor pay-per-event), `waitForFinish` elimina o
> polling e o prefetch dispara o ML em paralelo com a extração de IA (runs idênticos em
> voo são compartilhados). Busca fria ~30s → ~20-22s; cache 6h continua instantâneo.
> 10-15s ou menos exige a API oficial do ML (403 sem token de app) — o dono precisa
> criar um aplicativo em developers.mercadolivre.com.br. Alternativas descartadas com
> teste: outros actors (35s, piores) e fetch direto (bloqueio anti-bot). Também no ar:
> "urgente"/"pra hoje" vira nota `⚡ URGENTE` no pedido, alerta ⚡ e badge laranja
> "⚡ quer HOJE" no /ops — o operador escolhe o canal (Rappi/retirada agora vs. ML).
> Commits `dc0424a`+`ed797b2`, deploy `shopping-agent-asazb5e8i` `Ready`, smoke verde.
> Gate: tsc, ML 10/10, NLU 41/41, concierge E2E 36/36.

> **16/08 (3ª) — Mercado Livre como vitrine de cauda longa, ATRÁS DE FLAG.** Decisão do
> dono: com compra manual, o motivo de abandonar o ML (automatizar checkout) não existe
> mais — e as recusas dos 7 ciclos eram justamente cauda longa. Actor validado ao vivo
> (22–25s, 48 itens, ~R$0,03/busca, com prazo do anúncio). Conector desligado por padrão
> (`LIA_ENABLE_MERCADOLIVRE`), cache 6h, aviso antes de busca lenta, prazo do anúncio no
> card, guarda ANVISA aplicada. Review pré-ativação corrigiu dois desvios: o ML agora só
> roda quando nenhuma das 18 vitrines locais tem match forte (item cotidiano não espera
> actor pago/lento), e o prazo chega também ao card interativo da Meta. Suíte completa
> 340/340, tsc, lint e build verdes. **Ativado em Production em 16/08:** flag Sensitive
> `true`, commit `5040813`, deploy `dpl_9j9Yyn2fFWoCCWEUGDb8Bax7DMxZ` `READY`; smoke
> verde e sem erros novos. Falta apenas o primeiro pedido frio no WhatsApp provar a
> integração runtime com o token Sensitive.

> **16/08 (2ª) — 5º ciclo (10 rodadas): 4 consertos.** Ocasião/dia ("Para domingo",
> "Para uma viagem") e "barato" seco viram modificadores; plural não duplica no merge
> ("cafés moídos" ≈ "café moído"); adição relativa na mesma mensagem soma na linha
> anterior; trocar endereço com cotação na mesa preserva a cesta e re-cota sozinho.
> Gate de publicação agora é focado (decisão do dono).

> **16/08 — 4º ciclo (10 rodadas): 6 consertos + botão "Outra quantidade".** Cabo ≠
> carregador (golden `none` + prompt; catálogo não tem cabo USB-C — lacuna registrada);
> teto de preço sobrevive ao merge com a IA (era o "R$29,69 acima do teto"); tamanho
> pedido filtra TODOS os cards; "sem remédio" no começo não é remoção; "pensando bem"/
> "chega amanhã" são filler/urgência; destino com CEP embutido consome o CEP. Botões de
> quantidade: 1 · 2 · Outra quantidade (abre pergunta livre).

> **15/08 (2ª) — 3º ciclo (10 rodadas): 6 consertos.** Preferência negativa ("sem
> pimenta", "não veicular") vira atributo `sem X` do item anterior; "até R$30 cada" é
> teto; "vou entregar em Campinas" + CEP com pagamento aberto derruba a cotação velha e
> troca o destino; "mais um leite" herda o sku da cesta (não vira leite integral novo);
> "troca X por Y" em lista nova corrige a própria mensagem; lancheira recusa limpa.

> **15/08 — re-teste (10 rodadas): prioridades passaram; 5 ruídos restantes fechados.**
> "três pacotes" (acento no `\w`) e embalagem solta transferem quantidade; "qualquer
> <coisa>" é preferência; adversativa não esconde modificador; confirmação mostra "✅ 4x";
> "mais um desse café" mira pelo substantivo; "hidratante" não perde mais pro sabonete
> hidratante (regra principial + caso golden, 34 casos).

> **14/08 — 15 rodadas reais do dono → 7 consertos de NLU/fluxo.** Fragmento de frase
> ("até 100 reais", "qualquer marca", "se tiver") nunca mais vira item — orçamento vira
> teto de preço; "antes de pagar" não dispara pagamento e "entregar em <cidade>" troca o
> destino (rodada 15, a mais perigosa); "mais três do mesmo" soma no sku do último item;
> número solto ajusta quantidade; esclarecimento na escolha refina em vez de duplicar
> (rodada 5); "sem remédio" é negação; mensagem de mínimo mostra a cesta inteira;
> fallback manual explicado ao cliente e anotado no /ops. Relatório:
> docs/testes-whatsapp-2026-08-14.md.

> **15/08 — nova rodada ao vivo, sem alteração de código.** Em 10 cenários, passaram a
> adição relativa por SKU, a preservação de restrições e o cancelamento antes da cobrança.
> Permaneceram falhas observáveis: “cabo USB-C de 2 metros” retornou carregador de parede;
> “pensando bem”, “chega amanhã” e “sem remédio” foram mal roteados; cards acima de teto
> explícito apareceram; e o CEP embutido na frase de troca de endereço foi pedido novamente.
> A troca de endereço ainda derrubou a cotação velha antes do pagamento e nenhum Pix/cartão
> foi acionado. Evidência detalhada em `docs/testes-whatsapp-2026-08-14.md`.

> **15/08 — nome público do WhatsApp em revisão.** Para o número conectado da Lia
> (`+55 11 97844-4813`), foi enviado no WhatsApp Manager o novo nome visível **Lia Delivery**,
> removendo o sufixo com CNPJ e nome pessoal. A Meta registrou **In Review**; o texto antigo
> continua público até a aprovação. Não houve alteração de código, número ou pagamento.

> **19/08 — foto salva; nome ainda antigo.** A foto de perfil oficial (monograma lima em
> fundo berinjela) foi enviada e salva no WhatsApp Manager para `+55 11 97844-4813`.
> A checagem posterior mostrou o display name `Lia Delivery by 67.742.955 Joseph Carlos
> Dayan`, status **Approved**: a troca para **Lia Delivery** não está refletida. Não houve
> alteração de código, número ou cobrança. O Activity log registra `Name verification
> requested` em 17/08, sem evento de aprovação ou rejeição. Uma nova foto HD foi preparada
> em PNG 2048×2048, direto do vetor e com o símbolo 30% maior. O dono escolheu a composição
> anterior, com a estrela um pouco além da ponta do “L”; ela foi enviada e salva no WhatsApp
> Manager em 19/08. A Meta informou que a atualização pode levar alguns minutos para aparecer.

> **15/08 — nova rodada independente de conversa.** Dez cenários foram repetidos em uma
> conversa limpa, sem cobrança. Passaram troca de item, shampoo com “sem remédio”, presente
> até R$100 e sequência 4x → 7x → 5x de bombom. Persistiram ruídos quando “barato”, “Para
> domingo” ou “Para uma viagem” aparecem junto do pedido, quando leite e “mais dois” vêm na
> mesma mensagem, e a cesta não é retomada automaticamente após salvar novo endereço.
> Registro completo em `docs/testes-whatsapp-2026-08-14.md`.

> **11/08 (7ª) — 2ª revisão: 4 lacunas de concorrência fechadas.** Lock de turno por
> conversa (mensagens simultâneas não se apagam mais; colunas novas JÁ no banco);
> trocar endereço com pedido na fila ATUALIZA o pedido (e com pagamento emitido orienta
> a cancelar — nada fica órfão); falha parcial no envio da cotação não desalinha pedido
> e conversa; eco da simulação VTEX validado item a item (id+quantidade+itemIndex).

> **11/08 (6ª) — conversa duplicada dividia a cesta (achado ao consertar o dedupe).** Duas
> mensagens simultâneas do mesmo número abriam DUAS conversas ativas — cesta dividida,
> item sumindo, dedupe furado. Um número em produção tinha 86 conversas ativas. A criação
> virou upsert com id determinístico (`conv_<userId>`), atômico por chave primária. Suíte
> 297/297; golden 32/33 DET · 33/33 IA.

> **11/08 (5ª) — revisão de código: 6 P1 corrigidos antes de publicar.** Frete VTEX cobrava
> o frete de 1 item numa cesta de N (agora soma por item, item indisponível vai pro
> operador, preço ausente ≠ grátis); falha de envio ao publicar cotação deixava pedido
> zumbi (agora faz rollback pra fila do operador); pedido mínimo da loja não valia no
> concierge; botão "Trocar endereço" era engolido pelo menu de pagamento; escritas
> concorrentes podiam ressuscitar pedido cancelado (agora `updateMany` com status no
> WHERE); dedupe de webhook virou atômico com índice único PARCIAL (`sender='user'`,
> **já aplicado no banco**). Mais: TTL passa a medir a última mensagem (cliente ativo não
> é mais expirado), "troca X por Y" busca nas 18 vitrines, refino não apaga o histórico de
> paginação, `tail-messages` vira tail de verdade.

> **11/08 (4ª) — teste real do dono: card escolhia produto errado (id posicional) + "outras"
> com 1 opção + botão Trocar endereço.** "Escolher esse" agora carrega o SKU do card — toque
> em card antigo (pós-paginação) escolhe o produto DAQUELE card, nunca a posição da lista
> nova (`shownOptions` guarda o histórico). "Outras" completa até 3 do pool (12/loja).
> Resumo da cotação com botão "Trocar endereço" no lugar da instrução de digitar.

> **11/08 (3ª) — fim da linha livre: pede → preço na hora → acabou.** Decisão do dono: o
> "vou cotar" não existe mais no fluxo normal. Item sem preço nas 18 lojas = "não tenho
> como trazer" na mesma resposta (nunca entra na cesta); fechar com escolha aberta pede
> pra confirmar o item. Toda cesta é precificada e todo fechamento tem total NA HORA. O
> caminho do operador virou fallback técnico (falha de frete / kill-switch), cercado por
> alerta + expiração de 1h. Bônus: 151 palavras com encoding corrompido no seed Imigrantes
> corrigidas (destravou 30 águas e a penalidade da Coca "Sem Açúcar" que o mojibake
> driblava); "tônica/micelar/termal" viraram variante processada. Golden 32/33 · 33/33.

> **11/08 (2ª) — saída sempre visível + abandono expira sozinho.** Botão *Cancelar* no menu
> de pagamento e botão *Cancelar pedido* em toda mensagem de espera de cotação (Meta;
> texto puro segue aceitando "cancelar"). Cliente que some por 1h+ com cotação parada:
> pedido não-pago cancela sozinho (nota no /ops), conversa recomeça limpa (endereço fica)
> e a mensagem nova processa do zero — o zumbi não se repete. Pago e awaiting_payment
> nunca são tocados. Env: `LIA_QUOTE_ABANDON_TTL_MS` (60 min).

> **11/08 — "camiseta caiu na cotação" NÃO era a busca: pedido zumbi + falta de alerta ao
> operador.** O pedido de ração de sábado (26 min antes do deploy da cotação instantânea)
> ficou 2 dias em `awaiting_operator_quote` sem ninguém cotar no /ops, e a camiseta de
> hoje entrou nele (desenho de 07/08). Causa raiz: nenhum aviso ao operador. Fechado:
> alertas no WhatsApp do operador (`LIA_OPERATOR_PHONE` — **setar na Vercel + redeploy**)
> em cotação manual nova, item adicionado e pedido PAGO. Bônus do mergulho: card de
> sábado morreu por foto 404 no CDN (erro 131053, classe nova) — pré-flight de imagem no
> card Meta: foto morta = card sem foto, nunca card perdido. Desbloqueio do zumbi: cliente
> manda "cancelar". Testes novos: alerta E2E + card sem header.

> **10/08 — opções diversas + botão "Outras opções" + vistoria de rodagem.** Caso do dono:
> "carregador"/"ração" mostravam 3 variantes quase iguais. As 3 opções agora são produtos
> DISTINTOS (`sameProductVariant`: nome sem cor/medida, Jaccard ≥ 0.75; candidatos distintos
> primeiro no gather; regra 3 do rerank endurecida) — golden 32/33 DET · 33/33 IA, campo novo
> `distinctOptions`. Quem não gosta de nenhuma tem saída visível: botão **"Outras opções"**
> no último card Meta (`opt:outras`, mesmo ramo do texto), atalho anunciado no fallback
> numerado ("*outras*" seco funciona), paginação cross-store com diversidade e sem repetir
> variante do dispensado. A vistoria de rodagem completa (talk-lia) pegou e fechou um buraco
> antigo: paginação sem piso de relevância ("outras" de carregador devolvia Sérum Nivea
> "Cellular" e chip de operadora) — `conciergeMatchIsStrong` agora vale na paginação/refino.
> Suíte inteira verde local (283/283). **PUBLICADO no mesmo dia** com autorização do dono:
> push `93e8f78..a4fd0ef`, deploy `dpl_4Aa3SdK3pUEt5M5wBaM8H6s2rM6g` (commit `a4fd0ef`)
> `READY` em Production servindo `liadelivery.com.br`. Smoke: landing 200, `/ops` 200,
> webhook GET 403 / POST sem assinatura 401. Pendente de verificação humana: 1 conversa
> real tocando **"Outras opções"** no último card (card só se prova ao vivo;
> `scripts/tail-messages.mts` lê a evidência) e o log `[instant-quote:live]` do 1º pedido.

> **09/08 — falha da Meta agora é DURÁVEL no banco + tail de conversa.** Constatação: o
> conserto dos cards (09adb388, quinta ~12:40) nunca foi exercitado — as duas únicas
> mensagens no banco desde então são as do teste das 11:51 de quinta, ANTERIORES ao fix.
> E o runtime log do plano Hobby retém só 1h: se o teste real não for lido na hora, a
> evidência evapora. Fechado: `status: failed` da Meta agora também vira `Message`
> (sender `meta-status-failed`) na conversa do destinatário, e `scripts/tail-messages.mts`
> lê as últimas mensagens reais do banco a qualquer momento. Pendente: 1 teste real do
> dono ("quero um cotonete") para validar os cards com URL encodada.

> **07/08 (3ª) — cards de opção sumindo: URL de imagem com caractere não-ASCII + falha
> assíncrona invisível.** Teste real do dono às 11:51: "quero um cotonete" → header "Achei
> essas opções" e NENHUM card. Telemetria de produção: webhook 200, zero exceção — a Graph
> API aceita o card (2xx) e o fetcher da Meta descarta depois, silenciosamente; o suspeito é
> o `®` cru no path da imagem da Pague Menos ("hastes-flexiveis-cotonetes®-…"). Dois
> consertos: (1) `safeMediaLink` percent-encoda URL não-ASCII em todos os envios de mídia
> Meta (nunca re-encoda %XX legítimo); (2) o webhook agora LOGA `status: failed` da Meta
> com código e detalhes (`[whatsapp:meta:status-failed]`) — antes o callback de falha era
> ACKado e jogado fora, e não havia como saber o porquê. Próximo teste real mostra o erro
> exato nos runtime logs da Vercel se algo ainda falhar.

> **07/08 (2ª) — emoji literal era bug do minificador SWC; resolvido na raiz.** O
> `🙂` visto no WhatsApp vinha do SWC fundindo strings com emoji em template
> literals com escape duplo — 5 emojis de copy corrompidos no bundle, fonte sempre esteve
> certo. `serverMinification: false` + guarda `check-bundle-emoji.mjs` no build (falha se
> voltar). A linha livre agora conta que a Lia PROCUROU ("isso ainda não está na vitrine —
> consigo mesmo assim: o operador cota") — o caso "adaptador hdmi" (nenhuma loja tem) parecia
> "anotou sem procurar". Vitrine de eletrônicos/acessórios segue rasa (lacuna conhecida).

> **07/08 — PUBLICADO em produção.** Deploy `dpl_Hg6fJBVaD7a8xMWZPVsKqP5eFuPg` (commit
> `e8dea9f`, READY) com autorização do dono: busca com rerank por IA + golden set, consertos
> de matcher/onboarding, cotação sem engolir pedido novo, e os commits do cartão salvo de
> 05/08 (flag desligada — sem mudança de comportamento). Smoke: landing 200, `/ops` 200,
> webhook rejeitando sem assinatura. Verificação humana pendente: conversa real no WhatsApp
> (carregador usb c, cotonete, item durante cotação, emoji 🙂) e limpar pedidos antigos
> presos em `awaiting_operator_quote` no `/ops`.

> **07/08 — cotação do operador deixou de engolir pedido novo.** Screenshot de produção:
> "quero um cotonete" com pedido em `awaiting_operator_quote` respondia "segura aí" e
> descartava o item — o cliente teve que cancelar pra pedir de novo. Agora o item entra no
> mesmo pedido como linha livre, o operador vê a adição no /ops (nota ➕) e o cliente recebe
> "Anotei e já incluí na cotação". Regressão em `tests/manual-concierge.test.ts` (13 testes).
> Do mesmo screenshot: cotonete como linha livre e o emoji literal `🙂` são o
> código antigo no ar — resolvem com o deploy (o emoji não existe em nenhuma versão do
> fonte; conferir pós-deploy).

> **06/08 — onboarding: endereço deixou de virar lista de compras.** Achados ao validar a
> busca numa conversa real, mesma família de sintoma (busca devolvendo lixo), origem
> diferente: (1) endereço **com CEP na mesma mensagem** — a forma mais natural de responder —
> caía no parser de itens ("Já anotei: 1x apto 5") e a Lia repetia o pedido de endereço;
> agora é salvo, e do texto **cru** (o normalizado mandava "av paulista 1000 apto 5" pro
> motoboy); (2) endereço como **primeira mensagem** virava itens; agora é salvo; (3) pedido
> feito **enquanto a Lia espera o endereço** era descartado em silêncio; agora é guardado e
> buscado quando o endereço chega. 3 regressões novas em `tests/manual-concierge.test.ts`
> (12/12 verde).

## 1. O que é a Lia

**Concierge de compras do dia a dia no WhatsApp.** O cliente pede itens em linguagem natural;
um operador cota e compra o que for necessário, e a Lia só cobra por **Pix ou cartão** após a
aprovação do cliente. Pix e Checkout Pro usam Mercado Pago; o cartão nativo no WhatsApp,
quando habilitado, usa Meta Cloud API direta + Pagar.me. Na modalidade rápida, o motoboy retira
o pacote **na base do operador**; a entrega do varejista continua alternativa.

“Entrega hoje” no concierge é uma modalidade separada: só pode ser oferecida quando o operador
consegue comprar e entregar o pacote à sua própria base antes de despachar o courier. A alternativa
é a promessa same-day do próprio varejista. `Clique-e-retire + motoboy aleatório` continua fora do
modelo: o courier não retira no balcão da loja.

- **Receita:** markup de **10%** embutido no preço (produto e frete são pass-through).
- **Sem remédio** (ANVISA). **Fontes ativas:** Oba Hortifruti (mercado/essenciais), Petz e O
  Boticário. Carrefour foi removido do produto ativo após o bloqueio da sessão remota; Mambo
  ficou apenas como candidato pesquisado. O primeiro preflight ao vivo deve ser Oba ou Petz.
- **Moat:** a **largura** — "qualquer coisa, de qualquer loja, num WhatsApp só".

---

## 2. O fluxo completo do cliente (vigente em 05/08)

### Primeira compra (cliente novo)

```
1. 💬 "oi" → Lia pede endereço completo + CEP (uma vez; fica salvo).
2. 💬 Cliente pede em linguagem natural ("coca, ração e um vedante de torneira").
3. 🤖 Vitrine híbrida: item com match nas 18 lojas vira card com foto + botão
   "Escolher este" (até 3 opções); item sem match vira linha livre ("vou garimpar
   pra você"). NADA é recusado. Escolher não fecha a lista.
4. 💬 Cliente soma o que quiser → fecha com "só isso".
5. 👤 Operador cota no /ops (custo dos produtos + frete + modalidade + prazo) e publica.
6. 🤖 Cliente recebe o resumo com total e os botões Pix / Cartão:
   · Pix → copia-e-cola → confirmação na hora (webhook MP).
   · Cartão 1ª vez → link seguro /cartao → digita o cartão UMA única vez →
     cobra e SALVA a credencial (tokenizada no Pagar.me; a Lia não vê o número).
7. ✅ Pago → operador compra → motoboy da base do operador OU entrega do varejista.
8. 🤖 Lia comunica cada etapa até a entrega.
```

### Recompra (a mágica do cartão salvo)

```
1. 💬 Pede itens (ou "o de sempre") → mesmas opções → "só isso" → operador cota.
2. 🤖 No resumo, escolhendo cartão: chega o botão "💳 Pagar •••• 1234".
3. 👆 UM TOQUE. Pago. Sem número, sem CVV, sem sair do chat.
```

### Desvios já tratados (nenhum cliente fica preso)

- Cartão recusado → aviso + link Checkout Pro na hora.
- "Outro cartão" → expira a cobrança pendente e manda link novo de cadastro.
- Toque duplo no botão → cobra UMA vez (idempotência por tentativa).
- "Só isso" no meio das opções → o item pendente vira linha livre (não some).
- Pós-pagamento: sem cancelamento/substituição; item faltante = estorno do item;
  atraso = aviso. Antes de pagar, o cliente pode limpar a lista à vontade.

**Status do cartão salvo:** validado ponta a ponta no sandbox real do Pagar.me em 05/08
(inclusive cobrança sem CVV, replay e recusa). Em produção fica atrás de
`LIA_ENABLE_SAVED_CARD` (desligada) até a habilitação comercial + smoke real de R$ 1.

**Dinheiro:** cliente paga tudo (produtos +10% + frete) → cai na conta MP (Pix/link) ou
Pagar.me (cartão salvo) → você paga o varejista desse saldo → **sobra a margem de 10%**.
No cartão via Pagar.me o repasse leva ~15 dias (capital de giro no meio).

---

## 3. O que está PRONTO e REAL ✅

| Componente | Status |
|---|---|
| **Oba — mercado/essenciais** | ✅ Cotação Browserbase validada em Production em 19/07, ainda em `cart_only`: catálogo VTEX por SKU/vendedor, sacola isolada, simulação por CEP e estoque/frete/prazo obrigatórios. O job técnico chegou a `cart_ready` com arroz Camil 1 kg (R$ 5,99), frete R$ 9,90 e janela de entrega do varejista no CEP público `01310-100` (total R$ 15,89). A chave Browserbase e `OBA_BROWSER_CONTEXT_ID` são Sensitive; migration de defaults Oba aplicada e conferida. No fluxo ativo, a vitrine é referência e a cotação final é manual. |
| **Busca Petz** | 🟡 busca ao vivo + cache de 15 min. O preflight novo de 20/07 confirmou SKU/preço/subtotal, alcançou `/checkout/cart/<id>`, mas não recebeu frete/prazo ou controles de entrega no Context; falhou fechada em `needs_human`. O `/ops` agora abre uma sessão viva isolada, sem sacola/pagamento, para o operador selecionar entrega no endereço na Petz; depois disso, o preflight deve ser repetido. |
| **Busca Boticário** | 🟡 busca ao vivo + cache de 15 min; SKU, preço e URL reais. O novo preflight de 20/07 confirmou novamente SKU B88468, quantidade e subtotal de R$ 16,90, mas não recebeu prazo domiciliar. O link “Entrega Rápida” é informativo e o `postalCode` permanece bloqueado pelo varejista. O parser rejeita promoção de frete grátis e retirada como cotação. Permanece `needs_human`, sem cobrança ou compra. |
| **Multi-loja + roteamento** | ✅ Oba + Petz + Boticário; **1 loja por pedido**, escolhida por match. |
| **Pix (Mercado Pago)** | ✅ **REAL, testado com pagamento de verdade** — conta PJ confirmada pelo dono no painel para a aplicação `LIA - APP` em Produção; variáveis de acesso e webhook presentes na Vercel Production. |
| **Cartão (Checkout Pro)** | ✅ link hospedado no MP com taxa repassada; mesmo webhook do Pix |
| **Cartão One-Click (Meta + Pagar.me)** | 🟡 código concluído, flag desligada; primeira compra tokeniza no Pagar.me, recompra usa `order_details` nativo. Migrations aplicadas. Ticket Meta `37565409896407734` **encerrado em 05/08 com resposta padronizada** — sem porta self-serve; frente estacionada até GA ou Solution Partner (sem migrar sender). Faltam habilitação, configuração Pagar.me e sandbox. A documentação confirma que `recurrence_cycle` é de recorrência externa e não se aplica à recompra avulsa da Lia; o payload atual usa corretamente `card_id` sem o campo. Não usa 360dialog. |
| **Qualificação externa de WhatsApp Payments** | 🟡 A rota Infobip foi encerrada após a negativa de 03/08. O Suporte Direto da Meta **encerrou o ticket `37565409896407734` em 05/08** com resposta padronizada, sem análise. Frente estacionada até GA ou Solution Partner patrocinador; não migrar/compartilhar sender nem alterar WABA, número, Graph API ou webhook. |
| **Comandos de conversa** | ✅ status, "paguei" (verificado no MP em prod), limpar/cancelar antes do pagamento, trocar endereço, "tira X", "troca X por Y", repete o de sempre, ajuda |
| **Conversa / NLU** | ✅ reconstruída após review: onboarding preserva o pedido até o CEP, perguntas não viram item, total parcial, encerramento de lista, atendimento/reclamação, cancelamento e pagamento são contextuais |
| **Escolha de opções** | ✅ número, ordinal, preço, recomendação, marca/nome, refinamento e estreitamento de opções; "coca" entre duas Cocas não vira item novo |
| **Matcher dos catálogos** | ✅ piso de relevância + guardas de negação, produto humano/pet, espécie, tamanho e variante; básico/adulto/seco primeiro quando não há preferência explícita |
| **Testes de compra e conversa** | ✅ Em 19/07, TypeScript, lint, build e 204 testes passaram (162 aprovados; 42 integrações de banco puladas por indisponibilidade do Postgres remoto). Checkout ao vivo continua um gate separado. |
| **Cotação antes de cobrar** | 🟡 Implementada genericamente para Oba, Petz e Boticário: só libera pagamento depois de itens, total, frete e prazo. Oba e Boticário ainda precisam de preflight Browserbase ao vivo; Petz precisa validar o fluxo genérico atual. Compra final permanece bloqueada em `cart_only`. |
| **Motoboy (Uber Direct)** | ⚠️ OAuth + cotação funcionam, mas não autorizam retirada em varejistas de consumidor. Só usar com parceiro compatível. |
| **Cobertura** | ✅ O concierge aceita somente o estado de SP, com bloqueio rígido de UF/CEP. Dentro de SP, o checkout do varejista ou a cotação manual confirma se o endereço, frete e prazo são viáveis. A guarda de 12 km é apenas legado do fluxo antigo. |
| **Lojas (107 unidades geocodadas)** | ✅ dado útil para parceiros/same-day; proximidade não prova estoque, entrega ou prazo do varejista. |
| **Landing + domínio** | ✅ **liadelivery.com.br no ar** (HTTPS) — site novo (pôster Petróleo), domínio **verificado na Meta** |
| **Meta / WhatsApp oficial** | ✅ número aprovado, Cloud API ativa em produção e webhook assinado validado |
| **Opções pra escolher** | ✅ até 3 cards com foto + botão **Escolher este** na Meta; lista numerada como fallback |
| **Pedido mínimo** | ✅ por loja; avisa o cliente p/ completar. |
| **Painel do operador `/ops`** | ✅ publicado: cota qualquer lista, reaproveita pagamento e tem o botão único **“Comprei — despachar motoboy”**. O despacho real exige `LIA_OPERATOR_PICKUP_ADDRESS` e `LIA_OPERATOR_PICKUP_CEP`. |
| **Acesso ao `/ops`** | ✅ `OPS_TOKEN` dedicado, Sensitive em Production e Preview, criado e implantado em 16/07; não substitui `API_TOKEN` e não foi exposto. |
| **Onboarding de endereço** | 🟡 o endereço completo é pedido e persistido uma vez no fluxo e está coberto pelos evals; falta validar o resumo/cotação em checkout real. |
| **Markup 10%** | ✅ embutido no preço (sem linha de "taxa") |
| **Privacidade da loja** | ✅ a Lia não precisa expor o varejista ao cliente ("Procurando…"). |
| **Canal** | ✅ Meta Cloud API em produção; Twilio Sandbox é legado de teste. |
| **MEI (PJ/CNPJ) + e-mail** | ✅ MEI confirmado; não exige contador fixo. Manter relatório mensal/DASN e documentar a rotina fiscal da Lia. `contato@liadelivery.com.br` configurado no ImprovMX |

**Atualização operacional (02/08):** o `/ops` agora trata despacho repetido como operação
idempotente (não cria um segundo courier), registra eventos seguros de compra/despacho/entrega
e permite registrar o valor e a referência de estorno integral ou parcial antes de avisar o
cliente. A validação com pedidos reais continua separada e opcional.

---

## 4. O que FALTA para aceitar pedidos pagos (por prioridade)

O limite geográfico já está resolvido: o concierge opera somente no estado de São Paulo.
O código, o deploy e a proteção de compra estão prontos; a lista abaixo reúne apenas
configuração e decisões humanas que ainda impedem dinheiro real. A validação de pedidos fica
para quando o operador decidir, depois desses gates.

### 🔴 O que destrava o produto
- **Base para motoboy na hora:** `LIA_OPERATOR_PICKUP_ADDRESS` e `LIA_OPERATOR_PICKUP_CEP` já
  estão configurados como Sensitive em Production. A entrega do próprio varejista pode ser
  usada quando o checkout confirmar essa modalidade.
- **Operação humana:** contratar o operador e usar [o runbook](docs/operador-runbook.md).
- **Fila técnica:** 12 preflights internos sem pagamento foram removidos com autorização. Restam
  7 pedidos `paid` antigos, preservados para conciliação ou estorno; não são lixo descartável.
- **Histórico do fluxo legado (19/07):** o Context persistente, a configuração e o preflight técnico do
  Oba já foram validados em Production em `cart_only`. Petz e Boticário chegaram a carrinhos reais,
  mas ambos falharam fechados antes de preço de entrega/prazo: Petz não expôs os campos na sacola
  completa; Boticário não liberou a confirmação de CEP. Resolver esses gates antes de repetir os
  preflights e obter a validação comercial/termos. Nenhuma etapa cobra ou compra.
- **Sessão de entrega Petz (20/07):** publicada e aberta pelo `/ops` para a seleção manual de
  entrega no endereço dentro da Petz. Ela abre já na página inicial da loja, sem carrinho,
  pagamento ou interação automática, e fica aberta por até uma hora. Não é validação de cotação: o próximo passo técnico é um
  novo preflight, após o varejista expor frete e prazo reais. O visualizador Browserbase embutido
  no Codex não se mostrou estável para o operador, então a sessão viva foi aberta no Safari.
  Após encerrar a sessão pelo `/ops` para persistir a ação manual, um retry fresco ainda chegou
  somente a `/checkout/cart/<id>` com SKU R$ 15,99; a etapa de entrega não apareceu. Permanece
  `needs_human`, sem evidência de frete/prazo e sem cobrança ou compra.
- **Handoff Carrefour rejeitado:** o cliente não receberá links para terminar a compra. A experiência
  deve continuar integralmente na Lia. Para testes internos, resta operação humana invisível no
  navegador comum; para um piloto operacional sem checkout web, avaliar shopper próprio em loja.
  Nenhum desses caminhos é tratado como automação escalável.
- **Carrefour de longo prazo:** negociar integração homologada de catálogo/cotação/pedido com o
  varejista ou um app de delivery parceiro. Marketplace Seller e APIs públicas do iFood são fluxos
  do lado da loja, não APIs para criar uma compra de consumidor.
- **Supply ativo:** Oba é a fonte de mercado/essenciais; Petz e Boticário completam pet e beleza.
  Mambo não integra o produto. Oba passou no teste público e no preflight Browserbase em
  Production, com carrinho, estoque, total, frete e janela reais antes da cobrança. Boticário
  passou a extrair frete e promessa, mas precisa validar ao vivo.
- **Próximos candidatos (pesquisa, não validação):** Pão de Açúcar é a primeira substituição para
  mercado em São Paulo; sua documentação oficial descreve seleção de entrega e frete/prazo por
  CEP. Cobasi é a primeira substituição para pet; a política oficial exige calcular frete/prazo
  no carrinho e oferece entrega própria. Savegnago é adequado apenas onde sua rede atende no
  interior paulista. Nenhum dos três novos candidatos está integrado ou aprovado.
- **Cobasi — pet (smoke ao vivo):** ✅ em 20/07, navegação anônima com CEP público `01310-100`
  adicionou produto real à sacola e o checkout mostrou Cobasi Já, Econômica, frete, prazo e total
  antes de pagamento; ao continuar, chegou ao login. O carrinho técnico foi limpo. **Leroy Merlin
  — casa/manutenção (smoke ao vivo):** ✅ produto vendido e entregue pela Leroy, CEP público,
  entrega domiciliar, frete, prazo e total reais; ao continuar, chegou ao login e a sacola foi
  esvaziada. Para Leroy, um futuro conector deve aceitar exclusivamente itens vendidos e entregues
  pela própria loja. 🟡 Nenhuma das duas tem conector, Context Browserbase, preflight de produção
  ou validação comercial. **Sephora:** chegou a produto/CEP, mas a sessão ficou instável antes da
  sacola; não é candidata. **Pão de Açúcar:** a rota pública foi bloqueada por `az-request-verify`
  antes de produto/CEP; não é candidato automatizável agora.
- **Titularidade e pós-venda:** ✅ decisão tomada: a operação financeira e a titularidade
  operacional são da PJ; antes do pagamento o cliente pode limpar a lista; depois do pagamento
  não há cancelamento iniciado pelo cliente nem substituição; item faltante gera estorno do
  próprio item; atraso é comunicado. A execução de estorno parcial ainda é manual e precisa de
  referência do provedor.
- **Fiscal:** 🟡 a empresa é MEI e não precisa de contador fixo. Para a rotina da Lia, PF é
  dispensado de NF salvo solicitação; PJ exige documento fiscal. Falta apenas documentar se o
  fluxo de mercadoria/serviço usa NF-e, NFS-e ou outro documento.
- **Pilotar entrega direta** com 5–10 pedidos controlados, sem prometer motoboy.
- **Testar checkout e cartão salvo** em `cart_only`, incluindo CVV, 3DS, CAPTCHA e antifraude.
- **Validar a revisão do `/ops`** para frete/prazo/rastreio do varejista e estorno auditável.
  A revisão está implantada; falta massa técnica nova. A orquestração de cotação antes da
  cobrança precisa ser levada para Petz antes do piloto.
- **Antes de habilitar One-Click:** confirmar as migrations de pagamento aplicadas, obter a
  allowlist Payments API BR da Meta, liberar domínio/configurar webhook no Pagar.me e rodar testes
  sandbox de primeira compra, recompra, recusa e resposta perdida. Guia:
  [docs/whatsapp-one-click-pagarme.md](docs/whatsapp-one-click-pagarme.md).
- **Habilitação na Meta encerrada sem análise (05/08):** o ticket `37565409896407734` foi
  fechado com resposta padronizada e não aceita réplica. Manter a flag desligada; reavaliar na
  rotina mensal (GA da Payments API BR ou Solution Partner que habilite sem migrar o sender).
  A rota Infobip foi encerrada em 03/08.
- **Validar o payload Pagar.me no sandbox:** manter `card_id` sem `recurrence_cycle`, pois o
  campo é de recorrência externa; testar CVV/3DS, antifraude, recusa e reconciliação antes da
  ativação real.

### 🟡 Pra operar de verdade
- **WhatsApp oficial da Meta**: ✅ o número `+55 11 97844-4813` foi aprovado como
  `Lia Delivery by 67.742.955 Joseph Carlos Dayan`, registrado na Cloud API e ativado em
  produção (`WHATSAPP_PROVIDER=meta`). O webhook assinado foi validado em produção.
- **Mercado Pago PJ + nota fiscal** (hoje o Pix está no nome pessoal).
- **Confirmar cobertura real de entrega** por CEP em Oba, Petz e Boticário. Unidade
  próxima não prova estoque, frete ou prazo.

### 🟢 Pra escalar (pós-piloto)
- **Mais lojas** (a largura = moat): **Cobasi** (mesma receita, já confirmado raspável),
  **farmácia não-remédio**, **beleza** (Boticário/Sephora).
- **Fortalecer busca/cotação ao vivo:** Browserbase + cache já existem; falta medir p95,
  concorrência por Context, falhas de anti-bot e custo por pedido. O checkout continua sendo
  a fonte final de preço, estoque, frete e prazo.
- **Cesta multi-loja** (juntar Oba + Petz num pedido) — decidimos deixar pra depois
  (= 2 compras, fretes, entregas e pós-vendas).
- **Expandir catálogos** e medir cobertura dos três varejistas periodicamente.
- **Migração de schema (quando fizer sentido):** coluna `paymentMethod` no DeliveryOrder
  (hoje é inferido de `notes`/link — centralizado em `src/lib/order-flags.ts`) e índice
  único em `Message(conversationId, metadata)` pra fechar de vez a janela de corrida do
  dedupe de webhook (hoje é check-then-insert; janela pequena, mas existe).

---

## 5. Riscos honestos a validar no piloto

1. 🧾 **Titularidade/termos:** conta central comprando para vários destinatários, NF, troca
   e devolução precisam de validação jurídica e comercial.
2. 💰 **Cliente pagar o total** (produto+frete) pela conveniência vs. comprar diretamente.
3. 🛡️ **Checkout:** cartão salvo, CVV, 3DS, CAPTCHA, antifraude e duplicidade.
4. 📦 **Preço/estoque desatualizados.** Mitigação: cotação e revalidação no checkout do
   varejista antes de cobrar/aprovar; sem link de handoff ao cliente.
5. 🛵 **Same-day:** não prometer retirada por courier sem parceiro que a autorize.

---

## 6. Como operar / testar

**Cliente (pelo celular):** manda no WhatsApp da Lia → `oi` → CEP → itens → escolhe opções
→ `pagar` → paga o Pix. Recebe "Pagamento confirmado ✅".

**Operador:** abre `liadelivery.com.br/ops?key=<OPS_TOKEN>` → vê o pedido
pago → confere o carrinho/sessão → aprova a compra com entrega direta → registra o número
do pedido e acompanha preparação, rastreio e entrega do varejista. Cancelamento pago entra
em `refund_pending`; a confirmação só é enviada depois de registrar a referência real do
provedor. Runbook: [docs/operacao-piloto-needs-human-estorno.md](docs/operacao-piloto-needs-human-estorno.md).
O card também permite **avisar o cliente** (item faltante/estorno ou atraso, vira mensagem da
Lia). Substituições não fazem parte da operação atual; o pedido pago não oferece cancelamento
ao cliente.

**Motoboy:** não faz parte do fluxo padrão. Varejistas de consumidor podem exigir documentação do titular
para retirada por terceiro; não enviar documentos pessoais a entregadores on-demand.

---

## 7. Credenciais / ambiente (Vercel)

| Configurado ✅ | Pendente / opcional |
|---|---|
| `MERCADO_PAGO_ACCESS_TOKEN` + webhook | `MERCADO_PAGO_WEBHOOK_SECRET` (assinatura é só aviso) |
| `BROWSERBASE_API_KEY` + Contexts dos varejistas | `OBA_BROWSER_CONTEXT_ID`, `LIA_OBA_MIN_ORDER`, `LIA_PETZ_MIN_ORDER`, `LIA_BOTICARIO_MIN_ORDER` |
| `UBER_DIRECT_CUSTOMER_ID/CLIENT_ID/CLIENT_SECRET` (opcional/parceiros) | Política e credenciais de rastreio dos varejistas |
| `OPENAI_API_KEY`, `DATABASE_URL`, `API_TOKEN`, `OPS_TOKEN`, Meta Cloud API | Scraper pago (estoque ao vivo) — futuro |
| `LIA_COVERAGE_PRESET=estado-sp` (SP inteiro) | `LIA_MAX_DELIVERY_KM` (12), `LIA_MAX_DELIVERY_FEE` (35) — ajuste da guarda |

> 🔒 Recomendado: **regenerar** o Access Token do MP e o Client Secret da Uber (passaram no
> chat) e atualizar no Vercel depois dos testes. Em 15/07, credenciais Browserbase/Vercel
> também apareceram em saída de diagnóstico. O token OIDC local da Vercel foi renovado em
> 15/07; a chave Browserbase ainda precisa ser regenerada e atualizada nos ambientes antes
> do piloto. Em 15/07 foi aberta uma sessão persistente do Context Carrefour, sem itens ou
> cobrança, aguardando reautenticação manual por senha/OTP/CAPTCHA. Uma chave de reposição
> foi enviada por chat e, portanto, também deve ser descartada e regenerada antes do uso,
> mesmo com autorização posterior para instalá-la. A variável atual de produção não autenticou
> no Browserbase em 15/07 (`401` por chave ausente); configurar a nova chave na Vercel e
> implantar é pré-requisito para retestar. A URL correta de Environment Variables foi aberta
> no navegador embutido em 15/07, mas a Vercel pediu login manual antes da edição. Após o
> operador tentar salvar apenas em Production, uma leitura nova por `vercel env pull` ainda
> encontrou `BROWSERBASE_API_KEY` sem valor; confirmar o salvamento efetivo no painel antes
> de disparar outro deploy. A tela posterior mostrou valor `sk_live_` no campo, prefixo que
> não pertence ao Browserbase; substituir por uma nova chave `bb_live_` e marcar Sensitive
> antes de implantar. Uma segunda leitura do Production depois da alegada correção ainda não
> recebeu a variável, portanto o deploy e o reteste Carrefour continuam bloqueados. Depois,
> o painel confirmou a variável como Sensitive, em Production e atualizada; o deploy de
> produção subsequente ficou Ready em 15/07. A CLI local não baixa esse segredo Sensitive,
> portanto a autenticação será confirmada pelo fluxo implantado após a reautenticação manual
> do Context Carrefour, que foi reaberto sem itens, checkout ou cobrança.
> O operador informou que a reautenticação foi concluída na tela em 15/07; ainda falta
> escolher endereço salvo e item de teste para executar o preflight de carrinho, frete e
> prazo. Nenhum pagamento ou compra foi iniciado.
> Em 16/07, credenciais Carrefour foram expostas no chat. Os valores não foram persistidos
> nem registrados no projeto; a senha deve ser rotacionada antes do piloto. O inspetor
> remoto não expôs campos seguros para automação, portanto uma sessão nova ficou aberta
> para autenticação humana.

Em 15/07, o hash de aprovação do carrinho passou a incluir frete e promessa de entrega,
além de itens e total. Falhas Browserbase 401/503, sessão Carrefour expirada e página de
varejista indisponível passaram a ser classificadas explicitamente e testadas sem abrir
checkout; `cart_only` também é testado como bloqueio anterior ao acesso ao Browserbase.

O estado de Meta, domínio, e-mail, cobrança, motoboy, painel e checklist do piloto está
centralizado em [docs/operacao-canais-2026-07.md](docs/operacao-canais-2026-07.md).

Em 16/07, a autenticação do `/ops` foi recuperada criando `OPS_TOKEN` separado e Sensitive
em Production/Preview, seguido de redeploy que ficou `Ready`. A abertura do painel confirmou
que há pedidos legados pagos e alguns cancelados; eles não são massa segura para este teste.
Foi então criado um pedido interno isolado, em `cart_only`, com SKU Carrefour exato e CEP
público de teste `01310-100` (sem endereço pessoal). O mapeamento no navegador comum confirmou
que a UI atual submete o CEP pelo botão do formulário e só expõe frete/prazo no carrinho
completo: item R$ 1,99, frete a partir de R$ 9,90, prazo a partir de sábado e total R$ 11,89.
O conector, parsers, limpeza segura, diagnóstico e página `/ops/teste-carrefour` foram
implantados. Os retries do workflow removeram bloqueios intermediários e chegaram ao bloqueio
real `LOGIN_REQUIRED` no Context persistente; uma sessão viva foi aberta para login humano.
Esses valores mapeiam a tela, mas ainda não são uma cotação Browserbase validada. Não houve
WhatsApp, cobrança ou compra.

Na continuação de 16/07, o painel Browserbase autenticado foi confirmado e outra sessão
Carrefour foi aberta para login humano. A reautenticação não foi concluída, sem causa confirmada,
e o operador decidiu repetir em outro momento. Não abrir novas sessões ou repetir o preflight
até a próxima tentativa coordenada.

Também em 16/07, foi confirmada e coberta por testes a serialização já aplicada por Context
Browserbase: um lease persistente impede que dois workers usem o mesmo carrinho, conflitos entram
em `preflight_queued` com retry de um minuto, e um lease abandonado só é recuperado após 15
minutos. Falhas de banco/configuração não são classificadas como carrinho ocupado. Essa alteração
foi somente local; não abriu sessão, checkout, cobrança ou compra.

Ainda em 16/07, o ciclo operacional de entrega direta foi implementado localmente sem migration:
pedidos novos passam por `retailer_preparing` e `retailer_out_for_delivery`, enquanto os estados
de retirada/courier ficaram restritos a parceiros formalmente autorizados. O backend bloqueia
despacho externo para `retailer_delivery`; o `/ops` mostra promessa e rastreio do varejista. O
cancelamento de pedido pago não afirma mais que o estorno ocorreu: cria `refund_pending`, exige
referência do provedor e só então muda para `refunded` e avisa o cliente. Foi criado o runbook de
`needs_human` e estorno. Um PIN de registro encontrado em Markdown local foi removido e precisa
ser rotacionado. TypeScript, lint, 210 testes (168 passaram, 42 foram pulados por dependência de
banco) e build passaram. Nada foi implantado ou validado ao vivo nesta alteração.

Em 18/07, a chave Browserbase exposta foi regenerada no painel oficial e atualizada como
`BROWSERBASE_API_KEY` Sensitive em Production. Um valor intermediário que foi exibido durante a
rotação foi considerado exposto, invalidado imediatamente e substituído por uma chave limpa; nenhum
valor foi salvo no repositório ou nesta documentação. O redeploy de produção da versão
`ops-direct-retailer-delivery` / `9a06eab` ficou `Ready`. Isso valida a rotação e a configuração
implantada, mas não a autenticação Browserbase no runtime nem o checkout Carrefour: não houve
preflight, sessão nova, cobrança ou compra. A senha Carrefour, o PIN de registro WhatsApp e os
segredos Mercado Pago/Uber expostos continuam pendentes de rotação.

Em 18/07, a conta Carrefour foi aberta somente para confirmar a sessão; o operador optou por
adiar a troca da senha exposta. Nenhuma credencial foi digitada, alterada ou registrada. A senha
continua tratada como exposta e bloqueia qualquer uso do Context Carrefour ou piloto até a rotação
feita pelo titular.

## 8. Arquitetura (onde está cada coisa)

| Peça | Arquivo |
|---|---|
| Cérebro da conversa (estado, roteamento, opções, mínimo) | `src/lib/delivery-service.ts` |
| Detecção de intenção (pura, sem DB — unit-testável) | `src/lib/lia-intents.ts` |
| Copy — todas as mensagens enviadas ao cliente | `src/lib/lia-copy.ts` |
| Testes/evals de conversa | `tests/` (`npm test`) |
| Lojas (plugável) | `src/lib/stores/` (`carrefour.ts`, `petz.ts`, `*-catalog.ts`, `index.ts`) |
| Cobertura + entregabilidade | `src/lib/coverage.ts` (presets/UF) + `src/lib/freight-guard.ts` (guarda km/fee) + `WaitlistLead` (mapa de demanda no /ops) |
| Geo + loja mais próxima | `src/lib/geo.ts` (haversine + geocode) + `src/lib/stores/nearest.ts` (`pickNearestUnit`) |
| Landing (site público) | `src/app/page.tsx` + `src/components/landing/` (demo de chat em `/chat`) |
| Motoboys (plugável) | `src/lib/couriers/` (Uber Direct) |
| Pix | `src/lib/payments/mercadopago.ts` + `/api/mercadopago/webhook` |
| Cartão One-Click | `src/lib/payments/pagarme.ts`, `src/lib/payments/whatsapp-pay.ts`, `/api/pagarme/webhook` e [guia](docs/whatsapp-one-click-pagarme.md) |
| Busca por IA | `src/lib/adapters/ai.ts` (`extractShoppingList`) |
| Matcher / ranking comum | `src/lib/stores/types.ts` (`scoreCatalogMatch`, `rankCatalog`, `attrMatchesItem`) |
| Painel do operador | `/ops` + `/api/ops/...` |
| Estados e convenções operacionais | `src/lib/order-flags.ts` |
| Pedido (cesta, ciclo de status) | `prisma DeliveryOrder` |

**Somar loja = 1 arquivo** (conector + catálogo) + registrar em `stores/index.ts`.
**Ciclo direto implementado localmente:** `awaiting_payment → paid → retailer_preparing → retailer_out_for_delivery → delivered`.
O ciclo antigo `operator_buying → ready_for_pickup → dispatched` permanece somente para pedidos
legados ou parceiros courier autorizados. Cancelamento pago usa `refund_pending → refunded`.

### Atualização de conversa — 2026-07-07

O review profundo de conversa (115 achados) resultou em uma reconstrução de NLU, matcher,
copy e máquina de estados. A documentação completa, com sequência do trabalho e comandos
de validação, está em [docs/evolucao-conversa-2026-07.md](docs/evolucao-conversa-2026-07.md).

### Validação ao vivo pós-deploy — 2026-08-16

No deploy informado como `8cff5c1`, uma rodada manual de 10 cenários no WhatsApp confirmou
7 sucessos, 2 resultados parciais e 1 falha clara. Quantidades, pluralização, adição relativa
na mesma mensagem e a sequência 4x → 7x → 5x passaram. A troca de endereço cancelou a cotação
antiga sem cobrança e recotou preservando a cesta, mas perdeu os dígitos do CEP no endereço
atualizado. Permanecem dois riscos de NLU: “para uma viagem” ainda pode virar produto e
“sem pimenta” pode atingir item vizinho. Nenhum pagamento foi feito e nenhum código foi
alterado nessa validação; detalhes em [docs/testes-whatsapp-2026-08-14.md](docs/testes-whatsapp-2026-08-14.md).

### Reteste do 6º ciclo — 2026-08-16

Contra o deploy informado como `95db8bf`, foram feitos 10 cenários novos e 3 retestes exatos:
12 passaram no critério principal e 1 foi parcial. “Para uma viagem” não criou linha de
contexto; “sem pimenta” ficou somente na linguiça; e a cesta sobreviveu à recotação de
Campinas. O artefato “CEP.” desapareceu, mas os dígitos do CEP fornecido não apareceram na
confirmação, então a persistência estruturada ainda precisa ser confirmada. Nenhum pagamento
foi feito; evidências em [docs/testes-whatsapp-2026-08-14.md](docs/testes-whatsapp-2026-08-14.md).
# Operador automático local (23/08/2026)

- Fundação implantada em produção: fila durável para pedidos pagos do Mercado Livre,
  autenticação própria do worker, claim com lease, retry/revisão, auditoria e
  reconciliação com `/ops`.
- Piloto permanece em `cart_only`; confirmação final automática está bloqueada no backend.
- Cliente local: `npm run purchase-worker:claim`; segredo protegido no Chaves do Mac.
- Automação de hora em hora está ativa. Primeiro check de produção: nenhuma compra pendente.
- Falta para compra sem confirmação: tela/rota de aprovação curta por carrinho, validação
  real no ML e só então liberação controlada de `PURCHASE_AUTOMATION_MODE=purchase`.
