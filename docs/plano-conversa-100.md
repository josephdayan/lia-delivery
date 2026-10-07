# Plano: 100% de conversas limpas e objetivo cumprido (07/10/2026)

Meta do dono: 100% de conversas limpas e 100% de objetivo cumprido no placar de conversas.
Ponto de partida (juiz luna, `evals/results/conversations-2026-10-07-luna-total2.json`): **50% limpas, 65% objetivo**.

## Diagnóstico das 20 conversas que falharam

| Causa | Cenários | O que é |
|---|---|---|
| **A. Régua errada** | c10, c23, c24, c28, c38, c40 | cenário pede algo impossível ou ambíguo (bola de tênis que nenhuma loja entrega no CEP; orçamento de R$ 100 é do produto ou do total?), ou o juiz não sabe o que a Lia faz por trás (avisar o dono, lista de espera) |
| **B. Promessa e texto** | c08, c12, c13, c18, c30, c31, c35, c38 | "me pede **qualquer coisa** que eu compro"; "não achei em nenhuma loja" logo depois de "não vendo remédio"; atendente/CNPJ prometidos sem prazo; mesma resposta repetida |
| **C. Memória da conversa** | c02, c05, c06, c07, c09, c24 | o pedido feito antes do cadastro some ("o que você precisa?"); "mais 3" apaga o 1º; "troca pelo de R$ 34" ignorado; retry perde a restrição ("coco 1 L", "tubo com 4") |
| **D. Busca** | c05, c06, c20, c39, c40 | atributo pedido não confere ("sem açúcar", "5 kg", "de soja"); "outras" ainda traz óleo lubrificante; produto existe mas não aparece |

A raiz comum de B e C: o cérebro (`delivery-service.ts`, 6.900 linhas + 2.200 de regex em `lia-intents.ts`) decide
por **frase**. Cada rodada acha frases novas ("acho que o 1 taakku", "pode tentar em outra loja"). Conserto por frase
não converge para 100%.

## Fase 0 — Régua confiável (sem isso, 100% não quer dizer nada)
1. **Cenário com objetivo alcançável e sem ambiguidade**: para cada um, confirmar ao vivo no CEP de teste que o produto
   existe e entrega (senão o esperado vira "dizer que não tem"); orçamento declarado como TOTAL com frete.
2. **Juiz com a ficha da Lia**: o juiz recebe os fatos do que o sistema faz fora da conversa (avisa o dono no
   WhatsApp, lista de espera por região, MEI) para não chamar de mentira o que é verdade.
3. **Calibração**: rotulo à mão (eu, conferindo uma a uma) 40 transcrições; o juiz precisa concordar ≥ 95% antes de
   valer como régua.
4. **3 execuções por cenário** (o cliente simulado varia): só conta como limpo se passar nas 3.
5. **100 cenários, separados em treino (60) e prova (40)**: conserto olhando só o treino; a prova mede se o
   conserto é geral ou decorado.

## Fase 1 — Consertos por classe (rápidos, ~1 dia)
- **Textos honestos**: saudação sem "qualquer coisa"; remédio = só "não vendo remédio" (sem "não achei/outra marca");
  atendente e reclamação com prazo concreto e sem repetir; CNPJ/nome do Pix com `LIA_BUSINESS_INFO` (dono preenche).
- **Modo atendimento**: depois de chamar o dono, a Lia para de vender, confirma uma vez e só volta quando o cliente
  pedir produto.
- **Orçamento = total**: "até R$ 100" filtra produto + frete; se nada cabe, diz isso e oferece a opção mais próxima.
- **Embalagem diferente da pedida** (12 ovos → caixa de 20): pergunta antes de pôr na cesta.

## Fase 2 — Trocar o "cérebro por frase" por "IA decide, código garante" (a mudança que leva a 100%)
A luna lê a mensagem + o estado da conversa (cesta, opções na tela, pedido em aberto, último "não achei") e escolhe
**uma ação de uma lista fechada**: buscar, escolher opção N, mudar quantidade, tirar item, refinar busca com
restrição, responder pergunta (de uma ficha de fatos), chamar o dono, fechar total, pagar, cancelar.
O código executa a ação e guarda o dinheiro (quem cobra, quanto, quando) — a IA nunca mexe em valor.
- Elimina a classe inteira "frase que o regex não conhece" (C) e a maior parte de B.
- Liga por variável (`LIA_DIALOGUE_LLM`), mede no placar contra o cérebro atual, cenário a cenário.
- O que é determinístico e funciona hoje (cadastro, CEP, cobrança, pós-pagamento) continua igual.

## Fase 3 — Busca que confere o pedido
- A IA extrai do pedido os **atributos obrigatórios** (sem açúcar, 5 kg, de soja, com 4 bolas) e cada opção só entra
  se o atributo aparece no nome/descrição; sem nenhuma, "não achei X com Y" + a mais próxima, avisando a diferença.
- "outras"/refino passam pelo mesmo filtro (hoje já passam pela IA, mas sem os atributos).

## Marcos
| Marco | Quando | Meta no placar (prova, 3 execuções) |
|---|---|---|
| Fase 0 pronta | 1º | régua calibrada; nova linha de base |
| Fase 1 | +1 dia | ≥ 75% limpas |
| Fase 2 + 3 | +1–2 semanas | ≥ 95% limpas, 100% objetivo |
| 100% | depois | 100% em treino e prova, 2 dias seguidos; zero defeito de dinheiro |

Honestidade: 100% vale para o conjunto de cenários medido. Cliente real sempre inventa algo novo — por isso a prova
separada, e todo caso real novo vira cenário.
