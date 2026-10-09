# Lia — projeto, decisões e arquitetura

> Memória canônica vigente: [AGENTS.md](AGENTS.md). Este arquivo também contém histórico;
> em caso de conflito, prevalecem `AGENTS.md` e a decisão mais recente datada.

> **Revisão completa de 01/09/2026** (código, achados abertos, legado, métricas reais e
> caminhos de produto): [docs/revisao-completa-2026-09-01.md](docs/revisao-completa-2026-09-01.md).
> Correções do que está escrito abaixo: o markup é **progressivo** (10% até R$200, 6/4/3%
> acima — `src/lib/pricing.ts`), não flat; Browserbase e busca ao vivo Petz foram
> **removidos** em 03/08; a entrega é do varejista (sem motoboy); as 107 unidades
> geocodadas e as guardas de cobertura/km são legado do modelo de julho.

> **Decisão vigente — 09/10/2026:** pedido com itens de lojas diferentes fecha: um trabalho de compra e um Pix
> de saída por loja, devolução só da parte da loja que falhar, e "juntar numa loja só" é oferta ao cliente.
> Regra em [AGENTS.md](AGENTS.md).

> **Decisão vigente — 25/09/2026:** a Lia compra sozinha por API (9 lojas VTEX, Pix pago pela
> Asaas, sem operador no caminho feliz). Regra canônica e o que ainda cai em humano: topo de
> [AGENTS.md](AGENTS.md). A decisão de 15/09 (operador) está superada.

> **Decisão anterior — 15/09/2026:** contratar um operador humano e suspender a compra
> automática. O fluxo operacional é a fila/manual do `/ops`; os planos do comprador local,
> allowlist automática e tarefa horária ficam históricos até nova decisão.

Lia é uma **concierge de compras do dia a dia no WhatsApp**: o cliente pede itens em
linguagem natural, recebe uma cotação do checkout real, paga por Pix/cartão, e a Lia compra
para o varejista entregar diretamente. Este doc registra **por que** o produto é assim
(a jornada e os becos sem saída) e **como** ele funciona.

> **Atualização vigente — 21/07/2026:** o texto histórico abaixo descreve a estratégia de
> checkout automatizado, que deixou de ser o caminho crítico. O produto ativo é concierge
> manual: cliente pede qualquer coisa no WhatsApp, operador cota e compra, e o courier parte da
> base do operador. O fluxo foi demonstrado localmente sem cobrança; ainda aguarda deploy limpo,
> pois uma migration Oba paralela está inacabada. A operação decidiu contratar um operador.
> Para a regra canônica, leia o topo de [AGENTS.md](AGENTS.md).

> **Decisão de 14/07/2026:** a conclusão histórica `clique-e-retire + qualquer motoboy`
> foi invalidada pelas políticas oficiais da Petz e do Carrefour. “Entrega hoje” exige
> entrega same-day da própria loja ou parceiro formal que autorize courier. O registro
> completo está em
> [docs/decisoes-operacionais-2026-07-14.md](docs/decisoes-operacionais-2026-07-14.md).

---

## 1. A jornada de decisão (por que NÃO os outros caminhos)

Exploramos a fundo (com pesquisa real, fontes citadas) e descartamos, em ordem:

- **"Comprar no Mercado Livre/Rappi por API" (automático):** ❌ não existe API de compra
  do lado do comprador. A API do ML/Rappi é só do vendedor/lojista. Automatizar o
  checkout = robô (botting) → banimento, ilegal, quebra sempre. Beco.
- **Zinc / Rye (rails de "compre em qualquer varejista via API"):** existem e funcionam —
  mas **só EUA/Canadá** (Amazon US/UK/CA, Walmart, Target…). **Nenhum varejista BR/LATAM.**
  E não há "Zinc do Brasil"; construir um é virar uma empresa de automação/operação que
  come o risco. Beco pro Brasil.
- **Dropshipping nacional (Dropify/DSlite):** automatiza a compra, MAS é **centralizado**
  (galpão único, envia pro consumidor por transportadora) → **não dá same-day**. Física:
  same-day exige estoque **local**; dropship é nacional. Não combinam.
- **Farmácia same-day em SP:** ❌ duas paredes. (a) **ANVISA**: vender/entregar remédio é
  exclusivo de farmácia licenciada — até OTC; terceiro não pode revender. Uber Direct ainda
  PROÍBE remédio. (b) **Concorrência**: iFood Turbo (~12 min, R$3,99), Rappi Turbo Farma
  (virou farmácia licenciada, ~10 min), Daki, e as próprias redes (60 min + WhatsApp) já
  dominam. Seríamos mais lentos e mais caros, sem poder vender o item principal.
- **"Conselheiro neutro" (compara e indica, não compra):** sem moat — conselho qualquer
  GPT dá. O cliente quer **operacional** (WhatsApp que FAZ), não conselho.
- **Concorrência da Lia (Brasil):** não existe um "Lia" exato (cross-seller + paga no chat).
  O mais perto é o **WhatsApp da Lu (Magalu)** — faz tudo, mas só no catálogo próprio (jardim
  murado). **Zapia** é cross-seller mas não paga no chat. **Meta** entra com pagamento nativo
  no WhatsApp em 2026.

**Conclusão revisada em 14/07/2026:** o fluxo sem parceria que foi realmente validado é
**checkout automatizado + entrega do próprio varejista + WhatsApp + Mercado Pago**.
`Clique-e-retire + motoboy self-serve` não é base escalável porque Petz e Carrefour exigem
documentos do titular e outras autorizações para retirada por terceiro.

---

## 2. O modelo escolhido (o que a Lia É hoje)

```
Cliente pede no WhatsApp  →  Lia busca o item ao vivo e monta sacola no varejista
  →  checkout calcula preço + frete + prazo  →  Lia mostra total  →  Pix/cartão
  →  revalida a sacola  →  compra controlada  →  varejista entrega  →  Lia acompanha
```

- **Loja-base:** Carrefour (hipermercado = tem tudo: comidinha, higiene, pet, limpeza,
  bebida), usando entrega do varejista. Aberto
  pra somar farmácia (não-remédio), Petz, etc. → o moat é a **largura** ("qualquer coisa, num
  WhatsApp só").
- **Economia:** produto e frete são **pass-through**; sua receita = **markup de 10%** embutido
  no preço (sem linha de "taxa"). Operador vê custo Carrefour / margem / cliente pagou.
- **CEP/endereço:** configurado **uma vez no onboarding**; reusado em todos os pedidos.
- **Catálogo:** **~1094 itens reais** raspados de `mercado.carrefour.com.br` (nome + preço de
  verdade, páginas de categoria dos 9 departamentos) em `src/lib/stores/carrefour-catalog.ts`.
  O `unitPrice` é o **custo real Carrefour** (markup de 10% entra depois). Estático/instantâneo
  (sem scrape no turno). Como recoletei: extensão Claude-no-Chrome paginando `/categoria/<dep>?page=N`
  e lendo o DOM (a API VTEX/legada dá 403/503 mesmo same-origin; só páginas renderizadas passam,
  por isso o actor Apify da comunidade falha — anti-bot Akamai). Pra regenerar: re-raspar as
  categorias e rodar o gerador.
- **Catálogo Boticário:** **1.409 itens reais** (nome + marca + preço + **foto** + **URL real
  do produto**) em `src/lib/stores/boticario-catalog.ts` — perfumaria, maquiagem, corpo & banho,
  cabelos. Vertical de **beleza** (presente / "acabou minha base"), margem alta, sem sobrepor
  mercado/pet. Boticário faz "Entrega Rápida" **e** "Retire em loja" (clique-e-retire). Raspado
  de `boticario.com.br` em 2026-07-01 (SSR: fetch+parse `?page=N`; server-side puro dá 403).
  `productUrl` = deep-link real (o `/ops` abre o item exato). **Fotos (98%, Cloudinary)**
  raspadas do DOM renderizado (navigate+extract síncrono → localStorage, porque a Boticário
  limita fetch em massa) e **forçadas pra JPG** (`f_jpg`) porque a origem é AVIF (WhatsApp
  rejeita); Cloudinary é permissivo → sem re-host (diferente do Akamai da Petz). Lojas = 10
  shoppings reais de SP (confirmar a unidade + política de retirada por terceiro antes do
  piloto). Liga/desliga por `LIA_ENABLE_BOTICARIO`.
- **Busca Petz:** busca ao vivo por Browserbase com cache de 15 minutos e falha fechada em
  produção; só exibe opção com preço e URL reais. O catálogo histórico de **2.822 itens**
  permanece em `src/lib/stores/petz-catalog.ts` como seed/referência,
  raspados de `petz.com.br` (48 subcategorias, 6 deptos; sem remédio/antipulga — ANVISA). Mesmo
  método DOM (Petz também é VTEX+Akamai). **Imagens re-hospedadas** em `/api/petz-image/<id>`
  (tabela `PetzImage`, ~60MB) porque o CDN da Petz é Akamai e barra o Twilio no WhatsApp;
  `LIA_MEDIA_BLOCK_HOSTS` evita imagem quebrada. Ver/buscar tudo em **`/ops/catalogo`** (foto +
  custo/margem). ⚠️ prod: setar `OPS_TOKEN` forte (default cai no `API_TOKEN` fraco).
- **Lojas:** **107 unidades reais geocodadas** de Carrefour, Petz e Boticário em SP. Esse
  dado continua útil para parceiros/same-day, mas não prova cobertura de entrega direta;
  o checkout do varejista é a autoridade por CEP.
- **Pagamento/courier:** **Pix (Mercado Pago) e a integração técnica do Uber Direct estão
  testados**. Uber só pode ser usado com ponto de retirada que autorize formalmente courier.
- **Sem remédio** (ANVISA). Saudações e itens fora do catálogo são tratados sem chutar produto.
- **Entregabilidade em 2 camadas (legado do motoboy).** O cérebro NUNCA aceita um pedido pago
  que a operação não entrega. Duas travas, ambas gravam `WaitlistLead` (dedupe phone+cep, `hits`,
  `reason`) e o `/ops` vira **mapa de demanda** (cidade → nº de pedidos, tag `fora`/`longe`):
  - **Cobertura por cidade** (`src/lib/coverage.ts`, puro+testado): a cidade (ViaCEP; fallback
    prefixo de CEP) está na área? Fora → `copy.outsideCoverage`, lead `outside_coverage`.
    **Presets** (`LIA_COVERAGE_PRESET`): `capital` (default), `grande-sp` (39 municípios da RMSP)
    e `estado-sp` (**SP inteiro por UF** — quem decide entregabilidade é a guarda de frete).
    Sobrepõe campo-a-campo: `LIA_COVERAGE_CITIES` / `_UFS` / `_CEP_PREFIXES` / `_LABEL` / `_OFF`.
  - **Guarda de frete** (`src/lib/freight-guard.ts`, puro+testado): cidade coberta, mas o endereço
    pode estar longe de QUALQUER loja (metrópole é grande). `pickNearestUnit(allUnits(), cep)` dá a
    distância real (haversine); > `LIA_MAX_DELIVERY_KM` (12) → `copy.tooFarForDelivery`, lead `too_far`.
    Guarda secundária de fee real (`LIA_MAX_DELIVERY_FEE` 35, só cotação real) no `quoteBasket`.
    Distância é primária (mock é fake-barato). `LIA_FREIGHT_GUARD_OFF` = kill-switch.
  Para entrega direta, essas travas são apenas filtro comercial; a resposta do checkout
  substitui a distância até loja como autoridade de cobertura, frete e prazo.
- **Geo compartilhado** (`src/lib/geo.ts`): `haversineKm` + `geocode` (BrasilAPI→Nominatim, timeout,
  nunca-lança, cache; `LIA_GEOCODE_TIMEOUT_MS`). `StoreUnit` tem `lat/lng`; `nearestUnit` virou
  `listUnits()` + `pickNearestUnit` (stores/nearest.ts): haversine quando há coords, senão proxy
  numérico de CEP. **107 unidades geocodadas** (2026-07-02): capital (37) + Grande SP (16, incl.
  Alphaville) + interior (54: Campinas, Santos/SV/PG, SJC/Taubaté, Sorocaba, Ribeirão, Piracicaba,
  Bauru*, SJRP, Jundiaí, Franca*, Marília*, Araçatuba*, Prudente, Araraquara, S.Carlos, Limeira,
  Americana/SBO, Indaiatuba, Rio Claro, Mogi Guaçu — *sem hiper Carrefour: pet/beleza atendem,
  mercado recusa educado). Unidades novas = pesquisa web, confiança média: CONFIRMAR aberta +
  clique-e-retire + retirada por terceiro antes do 1º pedido real em cada. Somar unidade = 1 linha
  com lat/lng. Ligar tudo = `LIA_COVERAGE_PRESET=estado-sp` na Vercel (sem deploy).

### Riscos honestos a validar num piloto real
1. **Titularidade e pós-venda:** conta central, nota fiscal, múltiplos destinatários,
   troca/devolução e chargeback.
2. **Checkout e antifraude:** cartão salvo, CVV, 3DS, CAPTCHA e prevenção de duplicidade.
3. O cliente **pagar o total** (produto+frete) pela conveniência vs. comprar diretamente.
4. **Preço/estoque desatualizados.** Desenho da solução: (a) grátis hoje =
   link "ver no Carrefour" por item no `/ops` (operador confere na hora de comprar); (b) auto =
   **1 scrape por pedido PAGO** (background, antes de comprar) — precisa de **serviço de scraping
   com anti-bot** (ScrapingBee/Zyte/Bright Data/Apify-residencial), ~R$0,10/pedido + cache/prewarm.
   Escala melhor que manter N catálogos frescos quando somar lojas.

---

## 3. Arquitetura (código)

Tudo roda em **sandbox/mock** até as credenciais reais entrarem por env (sem mexer no fluxo).

| Peça | Arquivo | O que faz |
|---|---|---|
| Pedido (cesta) | `prisma DeliveryOrder` | itens (Json), loja, entrega, taxas e ciclo de status |
| Lojas (plugável) | `src/lib/stores/` | `StoreConnector` + Carrefour (ao vivo Apify + seed). **Somar loja = 1 arquivo** |
| Couriers (opcional) | `src/lib/couriers/` | `CourierConnector` + Uber Direct; só para parceiros que autorizem retirada |
| Pix + cartão | `src/lib/payments/mercadopago.ts` | createPix (copia-e-cola) + Checkout Pro (link de cartão, taxa da maquininha repassada) + webhook `/api/mercadopago/webhook` (mock até token) |
| Busca por IA | `ai.ts` `extractShoppingList` | limpa o pedido (sinônimos, saudação, remédio, qty); fallback determinístico |
| Intenções (NLU puro) | `src/lib/lia-intents.ts` | `detectIntent`, parser de lista, escolha e refinamento: serviço, status, pagamento, atendimento, reclamação, cancelamento contextual, CEP + itens, total parcial e opções. Sem DB — unit-testado |
| Matcher comum | `src/lib/stores/types.ts` | score/ranking dos três catálogos: piso de relevância, exclusões, guarda humano/pet e espécie, tamanhos e preferência pelo produto básico |
| Copy | `src/lib/lia-copy.ts` | TODAS as mensagens enviadas ao cliente num lugar só (tom/emoji/formatação consistentes) |
| Cérebro | `src/lib/delivery-service.ts` | máquina de conversa (onboarding CEP → cesta → cotação → Pix/cartão → fila) + ciclo do pedido + notificações + dedupe de retry do Twilio por MessageSid |
| Painel do operador | `/ops?key=<OPS_TOKEN>` + `/api/ops/...` | cotação → compra → preparação/rastreio do varejista → entrega; courier somente para parceiro autorizado; estorno pendente e confirmado são etapas distintas |
| Testes/evals | `tests/` | `npm test` = unitários (intents/copy, sem DB) + evals E2E de conversa (DB real + mocks, telefones de teste auto-limpos) |

**Ciclo direto implementado localmente:** `awaiting_payment → paid → retailer_preparing → retailer_out_for_delivery → delivered`. O ciclo legado `operator_buying → ready_for_pickup → dispatched` permanece apenas para parceiro courier autorizado. Cancelamento pago usa `refund_pending → refunded`.

Decisões de comportamento do cérebro (não são bugs):
- **"paguei" só aprova no sandbox/mock.** Com Pix real, a Lia consulta o status no Mercado Pago antes de acreditar; cartão nunca aprova por texto (o webhook decide).
- **"cancelar" é contextual:** cesta em montagem → limpa; aguardando pagamento → cancela o pedido; já pago → grava `⚠️ CLIENTE PEDIU CANCELAMENTO` nas notes (destaque no /ops; estorno é manual); despachado → explica que não dá mais.
- Endereço é trocável a qualquer momento ("trocar endereço" ou mandar um CEP puro).

### Env pra virar real (cada um tem fallback sandbox)
- `APIFY_API_TOKEN` (+ `APIFY_CARREFOUR_ACTOR`, default `gio21~carrefour-br-scraper`) — catálogo real
- `UBER_DIRECT_CUSTOMER_ID` / `UBER_DIRECT_TOKEN` — courier opcional para parceiro compatível
- `MERCADO_PAGO_ACCESS_TOKEN` — Pix real
- `LIA_PRICE_MARKUP` (1.1), `OPS_TOKEN` (acesso ao painel)
- Lado do dono: **MEI** (pra emitir nota / conta Mercado Pago PJ)

> Histórico técnico anterior (busca no Mercado Livre via Apify + cache + cron de prewarm)
> está **dormente** — o caminho do WhatsApp agora é o fluxo de entrega. Ver `src/lib/adapters/suppliers.ts` (reusamos `runApifyActor` dele).

## 4. Reconstrução da conversa (2026-07-07)

O review profundo de conversa (115 achados) levou a um ciclo concentrado de NLU, matcher,
copy e máquina de estados. A Lia agora identifica recusas/encerramento de lista, perguntas
operacionais, atendimento humano, reclamações, reenvio de Pix, troca de pagamento e
cancelamento contextual antes de considerar uma busca de produto. O onboarding preserva o
pedido bruto até o CEP; a escolha aceita preço, marca, recomendação e refinamento; e o
matcher só devolve itens com relevância real, priorizando a variante mais comum quando o
cliente não especifica outra.

O processo completo, a linha do tempo, os casos cobertos e as ferramentas de validação
estão em [docs/evolucao-conversa-2026-07.md](docs/evolucao-conversa-2026-07.md). Os evals
E2E rodam em `npm test`; `npx tsx scripts/talk-lia.mts` permite inspecionar uma conversa
sem enviar mensagem real.

---

## 5. Operação, canais e formalização (2026-07)

O domínio `liadelivery.com.br` está no ar e foi verificado na Meta. O número oficial foi
aprovado, registrado na Cloud API direta e está ativo em produção com webhook assinado.
Twilio Sandbox é apenas legado de teste. O e-mail `contato@liadelivery.com.br` está
configurado no ImprovMX.

Pix real (Mercado Pago), cartão por Checkout Pro, painel `/ops`, MEI/CNPJ e cobertura de SP
sustentam a preparação do piloto, com a ressalva de que Pix está em conta pessoal. A adaptação
do `/ops` para entrega direta e estorno auditável passou localmente em 16/07, mas ainda precisa
de deploy e validação ao vivo. O checklist completo está em
[docs/operacao-canais-2026-07.md](docs/operacao-canais-2026-07.md); o runbook de incidentes está
em [docs/operacao-piloto-needs-human-estorno.md](docs/operacao-piloto-needs-human-estorno.md).

---

## 6. Próximos passos
- Rodar o **piloto controlado de entrega direta** (5–10 pedidos reais).
- Validar titularidade, NF, termos, troca/devolução e conta com múltiplos destinatários.
- Mapear checkout e cartão salvo sem liberar o clique final automático.
- Implantar e validar a adaptação local do `/ops` para preço/frete/prazo/rastreio do varejista.
- Para same-day, buscar parceiro local/merchant que autorize courier.
- Memória/perfil mais rica. Botões tocáveis nas opções já estão ativos no canal Meta
  (cards com foto + **Escolher este**; lista numerada permanece como fallback).

---

## 7. Adendo de pagamentos — 14/07/2026

O cartão sem sair da conversa foi mapeado e implementado como **WhatsApp Payments API BR
(One-Click) pela Cloud API direta da Meta + Pagar.me V5**. O 360dialog não é dependência de
runtime: não envia a mensagem, não recebe o webhook e não processa a cobrança.

- A primeira compra abre uma página de uso único que usa `tokenizecard.js`; a Lia não recebe
  PAN nem CVV e armazena só referências tokenizadas, últimos quatro dígitos e consentimento.
- Nas recompras, a Lia envia `order_details` nativo. O `credential_id` é interno/opaco; o
  `card_id` Pagar.me fica no backend.
- `PaymentAttempt.id` é ao mesmo tempo o `reference_id` Meta e a chave de idempotência
  Pagar.me. Workflows e reconciliação por webhook cobrem toque duplicado e resposta perdida.
- Código, migrations, documentação e testes focados estão prontos; a flag continua desligada.

As migrations já foram aplicadas em produção. Em 04/08/2026, o pedido de allowlist/habilitação
foi aberto no Suporte Direto da Meta, protocolo `37565409896407734`; em 05/08 a Meta o
**encerrou com resposta padronizada** (docs antigas de On-Premises), sem análise e sem aceitar
réplica — não há porta self-serve hoje. O One-Click fica estacionado até a disponibilidade
geral ou um Solution Partner que habilite sem migrar o sender. Para ativar ainda faltam
habilitação da Meta,
domínio/chaves e webhook Pagar.me, depois teste sandbox de primeira compra, recompra, recusa e recuperação.
O guia canônico é [docs/whatsapp-one-click-pagarme.md](docs/whatsapp-one-click-pagarme.md).
