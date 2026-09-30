# Viabilidade: vender a stack da Lia pra pequenas empresas venderem no WhatsApp

Data: 30/09/2026. Pergunta do Joseph: "vale vender esse software pra empresas pequenas
venderem pelo WhatsApp? Qual a forma realista e boa de fazer?"

Contexto: Muse (Meta, 08/09, dentro do WhatsApp, com checkout) e Dots (OpenAI, 29/09)
saíram este mês. Joseph acredita que software puro será absorvido pelos modelos das big
labs. Este doc responde com dados, não com opinião. Fontes no fim.

---

## 0. Resposta curta

**Horizontal ("qualquer lojinha vende pelo WhatsApp"): inviável.** A Meta já dá de graça
no app WhatsApp Business, no Brasil, desde fevereiro/março de 2026, um atendente de IA que
responde, recomenda itens do catálogo e passa pro humano. Catálogo, carrinho, pedido e
chave Pix já eram grátis. Atendentes de IA genéricos custam R$ 99 a R$ 299/mês e há dezenas
(Zaia, Blip Go, SocialHub, Atendente.tech, AtendeZap). É commodity.

**Vertical, com integração e regulação: viável como negócio pequeno de janela, não como
startup de venture.** A farmácia independente é o segmento em que a Lia tem mais bagagem
(ANVISA, isento, CPF, nota) e onde existe canal (redes associativistas e distribuidoras).
Mas já existe um incumbente forte (Pedbot, 3.000+ farmácias, 80 redes, com IA e integração
de ERP). O espaço que sobra é a farmácia independente pequena, fora de rede, que o Pedbot
não atende bem, vendida a R$ 150–300/mês, sem percentual. Comp de desfecho: Anota AI
(restaurantes) levou quatro anos pra 15 mil lojas e foi vendida ao iFood por ~R$ 60 milhões.

**Veredito:** dá pra fazer, com três condições: (1) escolher uma vertical só, (2) vender o
que a Meta não faz (pedido dentro do ERP, estoque real, Pix conciliado, triagem de receita,
motoboy, recorrência de crônicos), e (3) validar com dez donos antes de escrever código.
E aceitar que é negócio de janela: se a crença é "não existe janela", a resposta é não.

---

## 1. O que a Meta já dá de graça (e o que ainda não dá)

| Camada | Status no Brasil (set/2026) | Fonte |
|---|---|---|
| Catálogo, carrinho, pedido, chave Pix no perfil | Grátis no app WhatsApp Business há anos | FAQ WhatsApp |
| **Business AI** (IA que responde, recomenda do catálogo, handoff humano, 24h) | Grátis, no app, desde fev/mar 2026. Só app (aba Ferramentas), catálogo obrigatório, operação simples | MacMagazine, Exame, Mobile Time |
| Business AI fechando pedido com quantidade, endereço, Pix, estoque | **Não faz** (nenhuma fonte descreve). Meta diz que "logo" expande pra grandes empresas | Exame, Mobile Time |
| **Business Agent** na Cloud API | Cobrado por token desde 01/08/2026 (US$ 2 por 1M tokens, ~4–5 centavos de dólar por mensagem) | Mobile Time, Wati |
| **Muse** (consumidor, dentro do WhatsApp, checkout via Stripe Link) | Só EUA. "Muse for Small Business" (29/09) é assistente do dono: conecta Canva, Slack, Intuit, contas de anúncio. Não é atendente de cliente | Meta Newsroom, TechCrunch, CNBC |
| Pagamento nativo pra empresas no WhatsApp | Existe desde 2023 (Pix e cartão via adquirentes) | — |
| APIs não oficiais (Baileys, Evolution, Z-API…) | Meta intensificou bloqueio desde jan/2026; banimento de número | DAS Tecnologia |
| Coexistência (CoEx): mesmo número no app e na Cloud API | Oficial desde 2025 | Underchat, X-Apps |
| Preço da Cloud API | Desde 01/10/2026: R$ 0,035 por mensagem de serviço (resposta sem template); utilidade R$ 0,035; marketing R$ 0,32. Grátis: respostas do Business Agent (cobradas por token) e 72h após clique em anúncio | Mobile Time |
| Onboarding de clientes por um SaaS | Tech Provider + Embedded Signup. Limite inicial: 10 empresas novas por semana; 200 após verificação | Meta Developers, 360dialog |

Leitura: a Meta cobre **atendimento**. Não cobre **operação** (pedido no sistema da loja,
estoque, nota, pagamento conciliado, entrega, regulação). E o cerco às APIs não oficiais
empurra as PMEs pra ferramentas oficiais, o que ajuda quem já está na Cloud API (a Lia).

---

## 2. Mercado e concorrência por segmento

### 2.1 Horizontal (qualquer PME)

- 82% dos MEIs e MPEs vendem pelo WhatsApp (Sebrae, Pulso dos Pequenos Negócios, 8,2 mil
  entrevistados, fev–mar 2026). Mercado enorme, mas é exatamente o que a Meta atende de graça.
- Atendentes de IA no-code: Zaia R$ 249/mês; Blip Go R$ 299/mês; SocialHub R$ 99/mês;
  dezenas de outros. Loja virtual no WhatsApp: ZapLoja R$ 799,90 de setup + R$ 99,90/mês.
- **Veredito: não.** Sem diferencial, sem canal, contra a dona da plataforma.

### 2.2 Restaurantes

- Anota AI: 50 mil+ estabelecimentos hoje; 15 mil quando o iFood comprou (2022, ~R$ 60 mi);
  planos atuais R$ 99,99 / 199,99 / 299,99 por faixa de pedidos, sem comissão.
- **Veredito: fechado.** Dono do segmento é o iFood.

### 2.3 Farmácia independente

Tamanho e dor:
- 93.850 farmácias no país (fev/2026). Independentes fecharam mais do que abriram em 2025
  (saldo −1.096). Faturamento médio da independente: R$ 70–82 mil/mês (jul/2026).
- Entrega já é ~20% das vendas do setor; pedidos à distância cresceram 57,7%; ticket com
  entrega R$ 88,54 (26% acima da média). Ou seja: numa independente média, ~R$ 15 mil/mês
  e ~170 pedidos/mês passam por WhatsApp/telefone/app.
- iFood cobra 12% + 3,2% (plano básico, entrega própria) ou 23% + 3,2% (entrega iFood) mais
  mensalidade. Um canal próprio a R$ 199/mês se paga com ~15 pedidos/mês desviados do iFood.

Regulação (é muro, e agora tem porta):
- Lei 15.357/2026 (20/03/2026) autoriza farmácia licenciada a **contratar canais digitais e
  plataformas** pra logística e entrega. A plataforma não vende nem dispensa; a farmácia e o
  farmacêutico continuam responsáveis. ANVISA abriu regulamentação em ago/2026; até lá vale
  a RDC 44/2009.
- Proibido online: tarja preta, psicotrópicos, antibióticos com retenção. Farmacêutico
  presente na dispensação. Receita digital ICP-Brasil é obrigatória aceitar (QR/SNCR).
- A Lia já tem: isento (MIP) por catálogo colhido, compra no CPF do cliente, nota encaminhada,
  termos. Receita continua sendo fila humana do farmacêutico.

Concorrência:
- **Pedbot** (Funcional Health Tech, desde 2020): 3.000+ farmácias, 80 redes, 4 associações
  (Abrafad, Farmarcas, Febrafar, Fecofar). IA "Mar.ia" que consulta estoque e sugere
  substituição; integração com Trier (live), Inovafarma e Alpha7 (teste), Consys (dev);
  lembrete de uso contínuo; campanhas; API oficial. Casos: +20–40% de faturamento, chamados
  de 100 pra 800/mês. Preço não público (vende por rede).
- **Febrafar + Farmarcas**: app de e-delivery próprio desde 2022 pra 12 mil+ lojas
  associadas (lê estoque ao vivo, raio por loja). Febrafar hoje: 75 redes, 20 mil+ farmácias.
- ERPs de farmácia entrando em IA: Alpha7 lançou uma IA de suporte técnico chamada **"Lia"**
  (colisão de nome na vertical). Trier e Inovafarma promovem e-commerce próprio.
- Genéricos com "farmácia" no site: SellFlux, WSeller, Vannon, Total IP, Grupo Único Contato.

**Veredito: viável no nicho "independente pequena fora de rede", com integração e
regulação como diferencial e canal por associação/distribuidora.** É o segmento onde a Lia
já pagou o custo de aprender e onde a Meta não vai entrar (ANVISA).

### 2.4 Pet shop

- Setor de R$ 81 bi em 2026; pet shops de pequeno e médio porte = 48% (~R$ 39 bi); 300 mil+
  estabelecimentos pet.
- **DelZap** já vende exatamente "IA anota o pedido de ração no WhatsApp, pergunta endereço
  e pagamento, imprime na térmica" por R$ 97/mês (3 meses) e depois R$ 197/mês, 7 dias grátis.
  iFood e Zee.Now fazem entrega pet.
- **Veredito: segundo lugar.** Sem regulação como muro, produto igual já existe a R$ 197.
  Só entra se farmácia travar, e com diferencial de recorrência (assinatura de ração).

### 2.5 Hortifruti, mercadinho, distribuidora de bebidas

- Ferramental fraco (Zapiar, freelancers, ERPs genéricos). Lista bagunçada é o ponto forte
  da NLU da Lia. Sem regulação, ticket menor, dono menos digital, sem canal associativo
  forte, muita concorrência de marketplace (Zé Delivery, iFood Mercado).
- **Veredito: não agora.** Fácil de entrar, difícil de cobrar e de escalar sem canal.

---

## 3. O que a Lia tem e o que falta

Tem (26,7 mil linhas fora catálogos, tudo rodando em produção):
- NLU de lista em português (intents puros + rerank por IA + golden set), cotação, escolha
  com cards e botões na Cloud API, Pix (Mercado Pago / Asaas), cartão, painel `/ops`,
  notificações, P&L por pedido, regras ANVISA (isento), CPF do cliente, nota encaminhada,
  dedupe de webhook, lock de turno, testes E2E.

Falta pra vender a outra empresa:
- **Multi-tenant.** Hoje é um número (`WHATSAPP_PHONE_NUMBER_ID` em env, lido em ~15 pontos
  do adapter), sem modelo `Tenant`, e ~200 chaves de env controlam comportamento. Precisa:
  tabela de loja (número, nome, catálogo, Pix, entrega, horário, token do painel), roteamento
  do webhook por `phone_number_id`, envio pelo número da loja, painel filtrado por loja.
- **Onboarding oficial.** Virar Tech Provider da Meta e usar Embedded Signup + CoEx, pra
  farmácia conectar o número que já usa sem largar o app.
- **Catálogo da loja.** Conector lendo planilha/export do ERP (diário) → depois sync com
  1 ERP (o que aparecer mais nos pilotos: Trier, Inovafarma, Alpha7 ou Vetor).
- **Pix na conta da loja.** Asaas subconta + split (Pix R$ 1,99 fixo) ou chave Pix da loja
  com confirmação manual no piloto. Nota fiscal sai do ERP da farmácia, não da Lia.
- **Receita.** Fila humana do farmacêutico no painel (foto/PDF, validação ICP-Brasil manual).
- **Assinatura e cobrança** (Asaas recorrência), termos B2B, LGPD por loja.
- **Nome.** "Lia" já é uma IA da Alpha7 na vertical de farmácia. Produto B2B precisa de outro
  nome, ou de checagem de marca no INPI antes de vender.

Esforço (com Claude Code, ritmo atual do projeto): versão de piloto (3 lojas, planilha, Pix
da loja, painel por loja) em 2–3 semanas; produto vendável (Embedded Signup, CoEx, 1 ERP,
cobrança) em mais 2–3 meses.

---

## 4. Conta

Custo variável por pedido (Cloud API a partir de 01/10):
- ~12 mensagens de serviço × R$ 0,035 = R$ 0,42
- LLM (NLU + rerank): R$ 0,05–0,15
- Pix: R$ 0 se na chave da loja; R$ 1,99 se Asaas subconta
- Total: R$ 0,50–2,60 por pedido. A 170 pedidos/mês por farmácia: R$ 85–440/mês. **Só fecha
  com Pix na conta da loja** (ou R$ 1,99 repassado). Sem isso, um plano de R$ 199 vira prejuízo.

Preço: R$ 199/mês flat, sem percentual (farmácia não aceita comissão; DelZap R$ 197, Anota
R$ 100–300, Zaia R$ 249). 14 dias grátis.

Escala: 30 farmácias = R$ 6 mil MRR; 100 = R$ 20 mil; 300 = R$ 60 mil. A Anota AI precisou
de time de vendas e quatro anos pra 15 mil. Um fundador só com operador chega a 30–100 em
12 meses **se** tiver canal (rede associativista ou distribuidora vendendo pra associadas).
Sem canal, é venda porta a porta a R$ 199: não fecha a conta do tempo do fundador.

---

## 5. Veredito por segmento

| Segmento | Meta grátis cobre? | Incumbente | Diferencial possível | Canal | Veredito |
|---|---|---|---|---|---|
| Qualquer PME | Sim (Business AI) | Dezenas a R$ 99–299 | Nenhum | Nenhum | Não |
| Restaurante | Parcial | Anota AI (iFood) | Nenhum | Fechado | Não |
| **Farmácia independente** | Não (regulação, ERP, receita) | Pedbot (redes) | Pedido no ERP + Pix + receita + crônicos + isento/CPF | Redes associativistas, distribuidoras | **Sim, nicho** |
| Pet shop | Parcial | DelZap R$ 197 | Recorrência de ração | Fraco | Segundo |
| Hortifruti/mercadinho | Parcial | Fraco | NLU de lista | Nenhum | Não agora |

---

## 6. Forma realista e boa

Princípio: **nenhuma linha de código antes das conversas.** A Lia atual passou meses de
código antes do primeiro pedido real; não repetir.

### Semanas 1–2: descoberta (zero código)

Dez farmácias independentes num raio de 3 km de casa, fora de rede (sem fachada de rede
associativista), com motoboy. Perguntas, sempre as mesmas:
1. Quantos pedidos por dia chegam por WhatsApp e quem responde?
2. Qual sistema de caixa/ERP? Exporta lista de produtos com preço e estoque?
3. Quanto vende pelo iFood e quanto paga de taxa?
4. Como recebe hoje (Pix na chave, maquininha na entrega)?
5. Pagaria R$ 199/mês por um número que anota o pedido sozinho, cobra Pix e manda a lista
   pro motoboy? Testaria de graça por 30 dias?

Go/no-go: **cinco ou mais** com ≥ 5 pedidos/dia no WhatsApp **e** **três ou mais** dizendo
sim ao teste grátis com intenção de pagar. Abaixo disso, parar aqui.

Em paralelo, um contato com uma rede associativista ou distribuidora de SP pra saber se
oferecem tecnologia pra associadas e como o Pedbot entrou (o canal decide a escala).

### Semanas 3–8: piloto com três farmácias (grátis)

- Multi-tenant mínimo: tabela de loja, roteamento por `phone_number_id`, envio pelo número
  da loja, painel filtrado. Número novo por loja no portfólio Meta da Lia (CoEx fica pra
  depois; o dono divulga o número novo e encaminha clientes).
- Catálogo: export do ERP em CSV, importado todo dia (conector de planilha no registro
  `listStores()`).
- Fluxo: cliente manda lista → Lia monta pedido com preço e estoque → endereço → total com
  taxa da loja → Pix na chave da farmácia (confirmação manual no painel pelo balconista) →
  fila do motoboy no painel → status pro cliente. Isento passa; receita cai na fila do
  farmacêutico; controlado é recusado com a copy certa.
- Métricas por loja, semanais: pedidos/dia, ticket, % atendido sem humano, tempo de
  resposta, pedidos perdidos por falta, horas do dono economizadas, pedidos que saíram do
  iFood.
- Ao fim: se **duas de três** farmácias querem pagar R$ 199 (e dizem por quê), segue.

### Meses 3–5: produto vendável

- Tech Provider + Embedded Signup + CoEx (a farmácia conecta o número que já tem).
- Integração com o ERP mais comum entre as três (pedido cai no ERP, baixa de estoque).
- Pix na conta da farmácia por Asaas subconta/split (conciliação automática).
- Cobrança recorrente, termos, LGPD, nome próprio (não "Lia").
- Canal: fechar uma rede/distribuidora que leve pras associadas com desconto; ou os
  três pilotos como referência pra venda direta na região.
- Meta: 30 pagantes em 6 meses. Com isso, decidir: crescer com canal, vender pra ERP/rede
  (comp Anota AI), ou parar.

### O que não fazer

- Atendente genérico "IA responde seu WhatsApp": a Meta dá de graça.
- Competir com Pedbot nas redes: eles têm 80 redes e integração pronta.
- Cobrar percentual do pedido: farmácia não aceita, e o Pix da loja resolve a conciliação.
- API não oficial pra facilitar onboarding: banimento.
- Construir multi-tenant "certo" antes de ter três lojas usando a versão feia.

### Riscos honestos

1. **Meta evoluir o Business AI pra fechar pedido com Pix.** Provável em 12–24 meses. Não mata
   o ERP + receita + motoboy, mas encolhe a percepção de valor. É por isso que é negócio de
   janela: construir pra ser comprado por quem precisa da base (ERP, rede, distribuidora).
2. **Pedbot descer pra independentes** com plano barato. Reação: já estar integrado ao ERP
   e com 30 lojas fiéis na região.
3. **ERPs embutirem WhatsApp com IA** (Alpha7 já tem "Lia" de suporte). Mesma resposta.
4. **Churn de PME** e custo de venda de fundador solo. Mitigação: canal, não porta a porta.
5. **Regulamentação ANVISA de 2026** pode exigir cadastro/obrigações de plataforma. Seguir.

---

## 7. Como isso conversa com a tese "AI + físico"

Este caminho é software com janela. Ele só faz sentido se Joseph aceita que existe janela
de 2–4 anos na cauda regulada, e que o desfecho bom é venda pra quem tem os átomos ou o ERP.
Se a crença é "não existe janela", a conclusão consistente é não fazer isto, e a tese de ser
dono de farmácia (átomos + IA como back office) volta a ser a única que sobra.

Um efeito colateral útil: as dez conversas da semana 1 servem pras duas teses. Elas dizem
se a farmácia de bairro vende mais com uma frente de IA, e dizem quanto custa comprar uma
(donos aposentando, faturamento, margem). É a mesma semana de trabalho.

---

## Fontes

Meta / WhatsApp
- [Introducing Muse (Meta Newsroom, 08/09/2026)](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
- [Meta expands Muse to small businesses (TechCrunch, 29/09/2026)](https://techcrunch.com/2026/09/29/meta-is-expanding-its-ai-agent-muse-to-small-businesses/)
- [Meta launches Muse for Small Business (CNBC, 29/09/2026)](https://www.cnbc.com/2026/09/29/meta-launches-muse-for-small-business-zuckerberg-pushes-enterprise-ai.html)
- [WhatsApp Business ganha IA para PMEs no Brasil (MacMagazine, 25/02/2026)](https://macmagazine.com.br/post/2026/02/25/whatsapp-business-ganha-ia-para-pequenas-medias-empresas-no-brasil/)
- [WhatsApp Business lança IA para PMEs (Exame)](https://exame.com/negocios/whatsapp-business-lanca-ia-para-pmes-atenderem-clientes-24-horas-por-dia/)
- [Business AI da Meta é liberado para PMEs do Brasil (Mobile Time, 03/03/2026)](https://www.mobiletime.com.br/noticias/03/03/2026/business-ai-meta-brasil/)
- [WhatsApp confirma cobrança por respostas de empresas (Mobile Time, 01/07/2026)](https://www.mobiletime.com.br/noticias/01/07/2026/whatsapp-cobra-respostas/)
- [Meta Business Agent token pricing (Wati)](https://www.wati.io/en/blog/meta-whatsapp-ai-token-pricing/)
- [WhatsApp Business AI chegou ao Brasil + bloqueio de APIs não oficiais (DAS)](https://blog.dastecnologia.com/whatsapp-business-ai-brasil-bloqueios-meta-2026.html)
- [Coexistência app + API (Underchat)](https://underchat.com.br/api-oficial-via-coexistencia/)
- [Embedded Signup (Meta Developers)](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/)
- [Tech Provider Program (360dialog)](https://docs.360dialog.com/partner/get-started/tech-provider-program)
- [Tabela de preços WhatsApp API 2026 (Wizebot)](https://wizebot.com.br/blog/tabela-precos-whatsapp-business-api-2026)

OpenAI
- [OpenAI launches Dots (TechCrunch, 29/09/2026)](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/)

Mercado PME e concorrentes
- [Sebrae: 82% dos pequenos negócios vendem pelo WhatsApp (Jornal Opção)](https://www.jornalopcao.com.br/ultimas-noticias/whatsapp-lidera-vendas-on-line-entre-pequenos-negocios-aponta-pesquisa-do-sebrae-816391/)
- [Zaia R$ 249/mês; comparativo (Ferramentas AI)](https://ferramentasai.net/zenvia-vs-zaia-comparativo-2026/)
- [Blip Go R$ 299 (Halk)](https://www.halk.io/blog/pt/quanto-custa-chatbot-ia)
- [ZapLoja preços](https://zaploja.com.br/)
- [iFood compra Anota AI (Startups.com.br)](https://startups.com.br/negocios/exclusivo-ifood-compra-a-anota-ai-para-oferecer-atendimento-pelo-whatsapp/)
- [Anota AI em 2026: planos (AI Hub Brasil)](https://botaihub.com.br/ferramentas/anota-ai/)
- [Taxas do iFood 2026 (Brendi)](https://brendi.com.br/blog/taxas-ifood-2026/)
- [DelZap: IA anota pedido de ração (anúncio)](https://mg.olx.com.br/belo-horizonte-e-regiao/servicos/pet-shop-com-delivery-ia-atende-o-whatsapp-e-anota-o-pedido-de-racao-1526959321)
- [Setor pet R$ 81 bi em 2026 (Panorama PetVet)](https://panoramapetvet.com.br/setor-pet-projeta-r-81-bilhoes-e-avanco-de-435-em-2026/)

Farmácia
- [Pequenas farmácias fecham (Medicina S/A)](https://medicinasa.com.br/pequenas-farmacias-fecham/)
- [Varejo independente tem retração inédita, Febrafar (DComércio)](https://dcomercio.com.br/publicacao/s/varejo-farmaceutico-independente-tem-retracao-inedita-alerta-febrafar)
- [Febrafar: 75 redes, 20 mil farmácias (Abradilan)](https://abradilan.com.br/mercado/febrafar-alcanca-75-redes-e-mais-de-20-mil-farmacias/)
- [Febrafar e Farmarcas lançam e-delivery (Panorama Farmacêutico, 2022)](https://panoramafarmaceutico.com.br/e-delivery-busca-revolucionar-vendas-no-varejo-farmaceutico/)
- [Entregas são 20% das vendas em farmácias (Abrafarma)](https://www.abrafarma.com.br/noticias/entregas-sao-20-das-vendas-em-farmacias)
- [Varejo farmacêutico 1º semestre 2026: ticket e entrega (Medicina S/A)](https://medicinasa.com.br/varejo-farmaceutico-2026/)
- [Quanto ganha um dono de farmácia (InovaFarma)](https://www.inovafarma.com.br/blog/quanto-ganha-um-dono-de-farmacia/)
- [Pedbot integra WhatsApp a sistemas de gestão (Panorama Farmacêutico)](https://panoramafarmaceutico.com.br/pedbot-sistemas-de-gestao-de-farmacias/)
- [Pedbot site (Mar.ia, 3.000+ farmácias)](https://pedbot.net/)
- [Farmácias dobram faturamento no WhatsApp com Pedbot (Guia da Farmácia, 2023)](https://guiadafarmacia.com.br/farmacias-dobram-faturamento-no-whatsapp-com-pedbot/)
- [Alpha7 lança IA "Lia" (Segs)](https://www.segs.com.br/demais/452693-setor-farmaceutico-lidera-avanco-da-ia-no-varejo-e-reforca-uso-estrategico-da-tecnologia-na-gestao)
- [Lei 15.357/2026 e plataformas (Guia da Farmácia)](https://guiadafarmacia.com.br/anvisa-remove-barreiras-para-plataformas-digitais-na-venda-de-medicamentos/)
- [Anvisa inicia regulamentação de apps de delivery (Diário de Pernambuco, ago/2026)](https://www.diariodepernambuco.com.br/brasil/2026/08/11721694-anvisa-inicia-processo-para-regulamentar-uso-de-apps-de-delivery-na-entrega-de-medicamentos.html)
- [Receita pelo WhatsApp: CFM, ANVISA, LGPD (ReceitaZap)](https://receitazap.com.br/blog/receita-whatsapp-legal)

Pagamentos
- [Asaas split e subcontas](https://blog.asaas.com/split-de-pagamento/)
- [Asaas preços 2026 (Runzos)](https://runzos.com/asaas-review-2026/)
