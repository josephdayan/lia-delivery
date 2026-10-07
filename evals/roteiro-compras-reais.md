# Roteiro de compras reais (para quando o Asaas liberar o Pix de saída)

Quem paga é o dono; o agente nunca movimenta dinheiro. Endereço de entrega: o de casa do dono (config
privado `.retail-buyer/config.json`). Cada compra é de valor baixo (≤ R$ 40 de produto). Pedir no WhatsApp
**como cliente** (número de teste diferente do dono), com a Lia online e a trava do Pix de saída
(`pixOutReadiness`) passando. Marcar cada linha: ✅ ok · ❌ defeito (anotar no PENDENCIAS com o log).

## Antes de começar
- [ ] Crédito na OpenAI (saldo > US$ 10) e `OPENAI_MODEL` na Vercel vazio ou `gpt-6-luna`.
- [ ] `/api/ops/asaas-status`: `bankAccountInfo` APPROVED e `decode.http` 200; saldo Asaas ≥ R$ 150.
- [ ] `LIA_AUTO_PURCHASE_STORES` com as lojas abaixo; `lia online`.

## 1 loja, 1 item (uma por loja — o que cada API de compra faz de verdade)
| # | Loja | Pedido sugerido | Conferir |
|---|---|---|---|
| 1 | Mambo | 1 leite integral 1 L | Pix gerado, loja paga, e-mail/status da loja, entrega |
| 2 | Swift | 1 pacote de arroz 1 kg | idem (Swift só SP) |
| 3 | Drogaria São Paulo | 1 escova de dente | idem; nada de remédio |
| 4 | Pague Menos | 1 creme dental | idem |
| 5 | Drogal | 1 sabonete | idem |
| 6 | Cobasi | 1 petisco de cachorro | idem |
| 7 | Casa & Vídeo | 1 pilha AA | idem |
| 8 | Obramax | 1 fita isolante | idem |
| 9 | Telhanorte | 1 lâmpada LED | idem |
| 10 | Ri Happy | 1 brinquedo barato | idem |
| 11 | Época Cosméticos | 1 esmalte | idem |
| 12 | Kopenhagen | 1 chocolate | idem |

## Casos que o placar não prova (fazer pelo menos um de cada)
- [ ] **2 itens da MESMA loja** (ex.: Mambo leite + arroz): frete cobrado UMA vez (VTEX às vezes devolve o frete em
  cada linha) e total mostrado = total cobrado = Pix da loja.
- [ ] **2 lojas na mesma cesta**: "2 entregas", dois fretes, as duas compras fecham, 2 códigos de rastreio.
- [ ] **Quantidade > 1** (3 coca-colas) e **produto por peso** (banana: "unidade ~180 g").
- [ ] **Cancelar antes de pagar** (cobrança aberta some, nada cobrado) e **depois de pagar, antes da compra**
  (estorno automático; conferir R$ e o aviso ao cliente).
- [ ] **Trocar endereço** com o total na mesa.
- [ ] **"Cadê meu pedido?"** em cada etapa (pago → comprado → a caminho → entregue).
- [ ] **Estoque some entre vitrine e cobrança** (se acontecer): a Lia avisa ANTES de cobrar; estorno por falta de
  estoque depois de cobrar é falha a corrigir.
- [ ] **Remédio**: pedir dipirona → recusa clara; nada na cesta.
- [ ] **Fora de SP/RJ** (CEP de BH): recusa clara.

## O que registrar por compra
Hora do pedido → hora do Pix da loja pago → número do pedido da loja → e-mail da loja → hora da entrega;
total que a Lia mostrou × total debitado no Asaas × valor do pedido na loja; qualquer mensagem estranha da Lia.

## Critério para religar para o público
10 de 12 compras ✅, nenhum defeito de dinheiro (cobrança ≠ total mostrado, compra duplicada, estorno que não
volta) e os dois placares (`scripts/bench-search.mts`, `scripts/bench-conversations.mts`) sem piora.
