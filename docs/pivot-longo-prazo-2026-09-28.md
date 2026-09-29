# Pivot de longo prazo — análise de 28/09/2026

Pergunta do dono: com o Muse (Meta) e agentes generalistas que compram, a Lia como está
perde a vantagem. Existe um pivot mais inteligente no longo prazo?

Análise por Claude (Fable 5.1). Sem decisão tomada; sem código alterado.

## 1. Base de fatos

**Tração real (AGENTS.md, 01/09):** 5 pedidos pagos, ≈R$215, todos do dono/testadores;
zero cliente de fora. Piloto de Meta Ads (R$30/dia) preparado em 18/09 e não ligado.

**Ativo real (28/09):** compra 100% automática provada (#LYAWQ8, Mambo): pedido por API
VTEX, Pix da loja pago pela Asaas, status lido por e-mail, zero toque humano. 11 lojas
passam no Pix (Cobasi, Pague Menos, Drogal, Ri Happy, Drogaria SP, Oxford, Philco, Mambo,
Swift, Brinox, Creamy); 9 desligadas com motivo gravado (ORD062/CHK0223). ~18 mil SKUs,
catálogo semanal, filtro ANVISA, golden set 33/38, estorno automático, P&L por pedido,
número WhatsApp aprovado como "Lia Delivery", MEI/CNPJ, Asaas, Pagar.me.

**Mercado (pesquisa 28/09):**
- Muse: lançado 08/09 só nos EUA, sem data pro Brasil. Pilha de 4 camadas: conectores
  diretos (Walmart, Best Buy, Sephora...), Shopify (todas as lojas por um acordo),
  navegador próprio como fallback ("mais frágil, conflita com regras do site"; Amazon
  bloqueou), carteiras Link/Shop Pay/PayPal. Sem Pix.
- Brasil: nenhum varejista em ACP (OpenAI/Stripe) ou UCP (Google); VTEX anunciou UCP no
  VTEX Day (abril). Lu do Magalu fecha com Pix no WhatsApp no catálogo próprio.
- Iniciador tem MCP de Pix agêntico, mas só para instituição regulada/fintech.
- O índice "awesome-agentic-commerce-latam" nomeia a lacuna: "as plataformas LATAM têm o
  trilho mas não o protocolo; os protocolos precisam de um gateway local até o Pix"; e
  nenhum protocolo de agente emite NF-e.
- Sinal contrário: OpenAI matou o Instant Checkout em 6 meses (vendas ~0; gente compra
  onde já tem conta). Meta proíbe chatbot de uso geral na API do WhatsApp desde 01/2026.

## 2. O que a Lia tem que vale, e o que não vale

Não vale (Meta faz melhor, de graça, dentro do app): conversa, NLU, ranking por IA,
cards, "pedir em linguagem natural".

Vale (ninguém tem no Brasil hoje): um trilho que **compra em varejista brasileiro por
API, paga o Pix da loja, lê o status, estorna e sabe o que quebra loja a loja**. É o
"Zinc do Brasil" que o CLAUDE.md descartou em julho; já foi construído.

## 3. Opções

| # | Pivot | Cliente paga por | A favor | Contra | Veredito |
|---|---|---|---|---|---|
| A | Continuar B2C, nichar (idosos, famílias, "alguém resolve") | conveniência + humano | produto pronto; Muse falha e não tem ninguém | Muse no WhatsApp + Lu; ticket R$50–80 não paga humano; Instant Checkout morreu | negócio pequeno, não "longo prazo" |
| B | **Trilho de compra pra agentes** (API/MCP "compre X nesta loja, entregue aqui, pague Pix, devolva NF") | por pedido / assinatura de dev | é exatamente o ativo; lacuna nomeada no mercado; Muse/ChatGPT/Zapia precisam de conector BR; VTEX nativo não cobre 50 varejistas + Pix + NF + estorno | demanda hoje ≈0 no BR (aposta de timing); revenda por CNPJ = fiscal/CDC; lojas que barram (Carrefour, Petz); Meta fecha com VTEX/Magalu, não com MEI | **direção certa, cliente ainda não existe** |
| C | Lado do varejista: deixar loja VTEX/Nuvemshop/Linx "pronta pra agente" (ACP/UCP/MCP com Pix) | varejista (SaaS/serviço) | onde o dinheiro vai estar em 12–24 meses; ele sabe o que quebra do lado comprador | VTEX/Shopify/Salesforce fazem nativo; é venda B2B pra varejo, motion diferente; protocolo muda todo mês | bom pra consultoria, fraco pra produto |
| D | **B2B: compras recorrentes de pequeno negócio pelo WhatsApp** (restaurante, salão, escritório, condomínio) | taxa por pedido sobre ticket R$300–2000, com NF | mesmo produto e trilho; ticket paga a margem e o humano; Muse mira consumidor; lista recorrente + aprovação + NF é onde "agente + humano" vale | precisa NF de verdade; concorre com Kalunga/atacado; venda ativa | **cunha pagante hoje** |
| E | Reposição automática (Pix Automático como mandato) em pet/farmácia | assinatura | Muse não é proativo | Cobasi/Petz já têm assinatura própria | fraco |

## 4. Recomendação

Direção: **B** (trilho). Cunha pagante enquanto o cliente de B não existe: **D** (B2B).
Os dois usam o mesmo código; a diferença é quem paga e o quanto.

Ordem, 4 semanas, sem nova feature de chat:
1. **Fiscal/jurídico primeiro** (gate dos dois): MEI tem teto de R$81 mil/ano de receita
   bruta; se receita = total do pedido, estoura em meses. Definir intermediação vs revenda,
   NF e CDC com contador. Está aberto em PENDENCIAS há semanas.
2. **D em 10 negócios reais de SP:** oferecer "manda a lista, a Lia compra e manda a NF".
   Medir ticket, frequência, o que pedem que as 11 lojas não cobrem.
3. **B como produto público mínimo:** MCP + docs + demo ("compre X na Cobasi por Pix") e
   pitch para 5 construtores de agente no BR (Zapia, Luzia, agências de bot WhatsApp,
   Trela). Sinal = alguém integra.
4. Piloto de Ads B2C (R$30/dia, 2 semanas) só como dado, não como aposta.

Decisão do dono: ver §5.

## 5. Decisão do dono (28/09/2026, noite)

Descartado por ora. Motivos: as 11 lojas não cobrem a lista de uma empresa (papelaria,
informática, volume) e o modelo é distinto demais do atual. Continua no B2C "pra ver no que
dá". Não repropor sem dado novo (Muse no Brasil, varejista BR em ACP/UCP, empresa pedindo
espontaneamente).
