# Outras formas de comprar sem operador — pesquisa de 28/09/2026

Contexto: das 20 lojas VTEX com compra por API, 11 passam no Pix e 9 recusam (ORD062 no
`transaction` ou CHK0223 no `gatewayCallback`). O dono pediu para pesquisar outros caminhos.

## O que existe e o que serve para a Lia

| Caminho | O que é | Serve hoje? |
|---|---|---|
| **VTEX por HTTP** (atual) | checkout público da loja, Pix da loja pago pelo Asaas | Sim, 11 lojas provadas até o Pix, 1 paga de verdade (Mambo) |
| **Wake Commerce Storefront API** (ex-Linx/Tray Corp; Magalu, Riachuelo, Nike, Kalunga, Mundo Verde, Balaroti) | GraphQL com checkout e Pix (`pixQrCode`) | Só com token `TCS-Access-Token` da loja: caminho de PARCERIA, não de comprador anônimo |
| **Magento GraphQL** (Divinho e afins) | checkout de convidado por mutation | Provável, não provado; já está nas pendências |
| **WooCommerce Store API** (lojas pequenas) | checkout REST de convidado; Pix depende do plugin (Mercado Pago transparente devolve QR) | Possível loja a loja; cauda longa, sem escala |
| **Nuvemshop / Tray / Loja Integrada** | API só do lojista (pedidos, produtos); checkout é web | Não, sem parceria |
| **Mastercard Agent Pay (Brasil desde início de 2026)** | agente registrado (KYA) paga com token vinculado ao cartão do cliente; Getnet, MagaluPay, Itaú e Santander já operam | Resolve o PAGAMENTO com cartão do cliente, não o checkout da loja; exige registro como agente via parceiro |
| **Visa Intelligent Commerce** | mesmo modelo; piloto no Brasil previsto para fim de 2026 | Ainda não |
| **UCP (Google + Shopify, jan/2026)** | padrão aberto: descoberta, carrinho, checkout e pagamento por agente; lojas Shopify habilitadas por padrão desde 17/06/2026 | Só lojas Shopify/UCP; no Brasil poucas do nosso ramo. Vale um teste com uma loja Shopify BR |
| **ACP (OpenAI + Stripe)** | checkout dentro do ChatGPT; Instant Checkout foi encolhido em 2026 | Não, é do ChatGPT |
| **Zinc / Rye** | "compre em qualquer varejista por API" | Só EUA/Canadá |
| **iFood, Rappi, Mercado Livre, Amazon** | sem API de comprador; robô = banimento | Não |

## Testes feitos em 28/09 (sem criar pedido)

- **Americanas é VTEX e está aberta por API:** cesta, perfil de convidado, entrega no
  endereço de sondagem e Pix aceitos. Falta só o fechamento real (`testa-americanas.sh`,
  dono roda). Se fechar, é a maior loja do elenco (mercado, higiene, casa, eletro).
  1ª tentativa de fechamento: ORD079 "valor mínimo de R$ 30,00 no carrinho" — primeira loja
  com mínimo publicado (vai para o conector). Frete no endereço de sondagem: "Entrega" R$12,90
  (1 dia útil) e **"Entrega 2h" R$19,89** (same-day).
- **Divinho virou VTEX** (não é Magento) e **não oferece Pix** (só cartão): fora.
- **Mundo Verde (VTEX):** o seller é de BH e não entrega em SP: fora.
- **Kalunga (Wake):** frontend próprio com token no servidor; Wake segue sendo parceria.
- **UCP funciona em lojas Shopify brasileiras, sem cadastro.** Sallve, Dailus, Insider e
  Zissou publicam `/.well-known/ucp` com endpoint MCP. A Lia publicou seu perfil de agente em
  `https://liadelivery.com.br/.well-known/ucp-agent.json` (obrigatório: sem ele a loja responde
  `profile_unreachable`). Busca de catálogo e `create_checkout` funcionaram; na Dailus o
  checkout calculou frete real para o endereço de sondagem (R$10,05) e parou só em "Insira um
  CPF/CNPJ válido" (campo de localização Shopify BR; Sallve/Insider param numa extensão de
  checkout). **Pagamento: só Google Pay e cartão via Shopify (`dev.shopify.card`), sem Pix.**
  Para comprar por UCP a Lia precisaria de um cartão da empresa como instrumento. Decisão do dono.

## Leitura

1. Não há atalho: no Brasil, comprar em loja de terceiro sem operador continua sendo
   falar com o checkout de cada plataforma. VTEX é a maior fatia do varejo grande e já
   funciona. Wake e Magento são as próximas plataformas que valem código.
2. Os protocolos de agente (UCP, Agent Pay, Visa) resolvem o pagamento com o cartão do
   cliente e a identidade do agente, não a loja que recusa. Ficam de olho para 2027.
3. Para as 9 lojas VTEX que recusam: testar CPF de comprador (em curso). Se for isso, o
   documento do comprador vira configuração por loja.

Fontes: VTEX Day 2026 (vtex.com/press), ucp.dev e shopify.engineering/UCP,
wakecommerce.readme.io (Storefront API / Payment), Mastercard LAC press (dez/2025),
Bloomberg Línea e E-Commerce Brasil (Agent Pay no Brasil), Let's Money (Visa Intelligent
Commerce Connect), explodingtopics/rye.com (Instant Checkout encolhido), zinc.com.
