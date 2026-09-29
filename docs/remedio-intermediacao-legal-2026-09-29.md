# Remédio na Lia: existe um jeito legal? — investigação de 29/09/2026

Pergunta do dono: "sou só o código de intermediação entre o cliente e a farmácia; o pacote
chega da farmácia. Tem jeito de fazer isso sendo legal?" Investigação por Claude (Fable 5.1):
fontes públicas + um teste técnico real. Não é parecer jurídico.

## 1. Resposta curta

Sim. Não é loophole: é o modelo do iFood, com uma diferença que o deixa mais limpo que o
iFood — **a Lia não encosta no dinheiro do remédio**. A venda é da farmácia de ponta a
ponta (site dela, CPF do cliente, nota dela, farmacêutico dela, entrega dela); a Lia monta
o carrinho por API, manda o link e ganha **comissão de afiliado** que as próprias redes já
oferecem hoje (Drogaria SP até 7% pela Lomadee; Drogal 4–8% pela Awin). Isso é legal
**hoje**, sem depender da regra nova da ANVISA.

## 2. O que mudou na lei e onde está a linha (estado em 29/09/2026)

- **Lei 15.357, de 20/03/2026** incluiu o §6º no art. 6º da Lei 5.991/73: farmácias e
  drogarias licenciadas "poderão contratar canais eletrônicos e plataformas de comércio
  eletrônico para fins de logística e entrega ao consumidor", cumprida a regulação sanitária.
- **ANVISA, 07–10/08/2026:** revogou as medidas preventivas contra Rappi, iFood, Mercado
  Livre e B2W (RE 3.139 a 3.142/2026). Em 19/08 abriu processo pra regulamentar; consulta
  pública "nas próximas semanas". Em 31/08 esclareceu: **a revogação não autoriza
  automaticamente**; "a aplicabilidade prática ainda depende de regulamentação específica".
- **RDC 44/2009, art. 53** continua em vigor: pedido pela internet "por meio do sítio
  eletrônico do estabelecimento ou da rede".
- **Mercado Livre, 25/09:** começou a vender remédio controlado por farmácias parceiras.
  **28/09: ANVISA notificou** — pediu AFE, licença, farmacêutico, procedimentos, e mandou
  não "hospedar, divulgar ou facilitar" a venda até provar regularidade (prazo 01/10),
  citando que a norma "não prevê intermediação por marketplace". Ou seja: a zona cinzenta
  está sendo fiscalizada agora, nesta semana.
- **Meta / WhatsApp:** remédio isento (MIP) pode ser **divulgado** (ofertas, links, avisos de
  pedido/entrega), mas **catálogo, carrinho e pagamento** do WhatsApp não podem ser usados
  pra MIP nem pra prescrição; farmácia só de prescrição não pode operar no canal.

## 3. Três modelos, do mais arriscado ao mais limpo

| | A. Hoje (mercado/pet) aplicado a remédio | B. Intermediação iFood | C. Carrinho pronto + a farmácia vende |
|---|---|---|---|
| Quem compra na farmácia | Lia, CNPJ do MEI | cliente (CPF), Lia opera | cliente, no site da farmácia |
| Quem recebe o dinheiro | Lia (markup embutido) | Lia (repassa) | farmácia |
| Nota fiscal | pra Lia | pro cliente | pro cliente |
| Base legal hoje | nenhuma (revenda sem licença) | Lei 15.357 sem regra ANVISA; exige contrato com a farmácia; ML notificado ontem | site da própria farmácia (RDC 44 art. 53 cumprido à letra) + contrato de afiliado |
| WhatsApp (Meta) | viola (pagamento no chat) | viola (pagamento no chat) | ok (só link e avisos) |
| Veredito | **nunca** | só depois da regra e com contrato | **pode agora** |

## 4. Modelo C em detalhe

1. Cliente pede "dipirona" no WhatsApp. Lia mostra até 5 opções em **texto + link**, sem
   card de carrinho e sem "Pagar" no chat (regra Meta pra MIP).
2. Lia cria o carrinho na farmácia por API (`orderForm` público VTEX, sem login) e manda o
   link de checkout. **Testado em 29/09 na Drogaria SP:** o link
   `/checkout?orderFormId=<id>#/cart` abriu o carrinho com a dipirona (R$14,99), rodapé com
   CNPJ, AFE e farmacêutica responsável da própria farmácia, e o botão "Fechar pedido".
   Script do teste: pasta temporária desta sessão (`cart-link.mts`); não criou pedido.
3. Cliente fecha lá: CPF, endereço, Pix ou cartão dele. Farmácia vende, emite NF, dispensa
   e entrega. A Lia não compra, não estoca, não revende, não transporta, não recebe.
4. Lia recebe **comissão**: Drogaria SP até 7% (Lomadee, CPA, cookie 30 dias); Drogal
   4–8% (Awin, cookie 30 dias, PPC proibido, antidiabéticos 0%). Pague Menos: sem programa
   de afiliado achado (tem marketplace pra vendedores, não serve).
   Alternativa/complemento: `marketingData.utmSource=lia` no orderForm (a VTEX grava) e
   acordo direto com a rede — a farmácia enxerga os pedidos que a Lia trouxe.
5. O resto da cesta (fralda, shampoo, ração) continua no fluxo normal, pago no chat. Só o
   remédio vai por link. Se o cliente pediu só remédio, a Lia vira um "concierge que
   encaminha", e a receita é a comissão.

### O que precisa mudar no código (dias, não semanas)
- Flag por loja "medicamento por link" + copy própria (sem botão de pagar, aviso de que a
  compra é feita no site da farmácia).
- Filtro ANVISA (`src/lib/stores/anvisa.ts`) vira **lista positiva de MIP** (categoria da
  própria loja + registro), em vez de regex que exclui tudo. Prescrição e tarja preta
  continuam **fora, sempre**: a Lia nunca recebe receita (dado de saúde).
- Gerador de link de carrinho (o teste já mostra o caminho) + link de afiliado por cima
  (deep link Lomadee/Awin apontando pra URL do carrinho; **testar atribuição** depois do
  cadastro, porque cookie de afiliado + carrinho pré-montado é combinação não documentada).
- Sem `marketingData`/afiliado funcionando, a Lia trabalha de graça: gate antes de ligar.

### Riscos que ficam
- **Conversão:** quebra o princípio "paga no chat"; parte dos clientes não termina no site.
  Medir. É o preço de estar do lado certo da linha enquanto o ML apanha.
- **Canais permitidos do afiliado:** Lomadee mostra regras por anunciante só dentro do
  painel; Awin da Drogal não cita WhatsApp/bot (nem permite, nem proíbe). Ler antes de
  divulgar; anunciante pode bloquear conta por canal não autorizado.
- **LGPD:** "cliente X pediu dipirona" é dado de saúde (sensível, art. 11). Não guardar o
  nome do remédio no perfil de longo prazo; guardar só o link/pedido; consentimento simples.
- **Regra ANVISA futura** pode exigir contrato formal também de quem "divulga". Acompanhar a
  consulta pública; o modelo C é o mais fácil de adaptar, porque já não faz nada regulado.
- **Não é parecer.** Uma hora de advogado sanitário com este documento antes de ligar.

## 5. O que NÃO fazer
- Comprar remédio com o CNPJ do MEI e revender (modelo A). Comércio de medicamento sem
  licença: infração sanitária, com risco penal.
- Receber pagamento de remédio no WhatsApp (viola política Meta; risco pro número).
- Receita, controlados, antidiabéticos: fora.
- Modelo B antes da regra da ANVISA e sem contrato com a rede (é onde o ML foi notificado).

## 6. Fontes
- Lei 15.357/2026 (art. 6º §6º da Lei 5.991): https://www.bmalaw.com.br/conteudo/infraestrutura-regulacao-e-assuntos-governamentais/artigos-e-noticias/a-nova-lei-n-153572026-e-seus-impactos-na-comercializacao-de-medicamentos-por-plataformas-digitais · https://www.legisweb.com.br/legislacao/?id=492871
- ANVISA abre processo (19/08): https://www.gov.br/anvisa/pt-br/assuntos/noticias-anvisa/2026/anvisa-abre-processo-para-regular-logistica-e-entrega-de-medicamentos-em-plataformas-de-comercio-eletronico-e-canais-digitais
- ANVISA esclarece (31/08, Sincofarma): https://sincofarmasp.com.br/2026/08/31/anvisa-esclarece-revogacao-de-medidas-contra-plataformas-digitais/
- Revogação RE 3.139–3.142/2026: https://atlaspublico.com.br/noticias/anvisa-revoga-proibicao-de-venda-e-propaganda-de-77910
- ML controlados (24/09): https://www.mobiletime.com.br/noticias/24/09/2026/mercado-livre-medicacao/ · notificação (28/09): https://www.metro1.com.br/noticias/brasil/189035,anvisa-notifica-mercado-livre-por-venda-de-medicamentos-com-receita
- Regras vindouras (Consumidor Moderno): https://consumidormoderno.com.br/medicamentos-marketplaces-anvisa-regras/
- iFood Farmácia: https://institucional.ifood.com.br/clientes/como-usar-o-ifood-farmacia/
- Meta/WhatsApp e MIP: https://bestmediainfo.com/mediainfo/mediainfo-marketing/whatsapp-policy-update-what-alcohol-gambling-and-otc-medicine-brands-need-to-know-6900589 · https://www.interakt.shop/blog/whatsapp-messaging-policy-for-new-industry/
- Afiliados: Drogaria SP/Lomadee https://www.lomadee.com.br/pt-br/marcas/drogaria-sao-paulo · Drogal/Awin https://ui.awin.com/merchant-profile/68224
- RDC 44/2009: https://bvsms.saude.gov.br/bvs/saudelegis/anvisa/2009/rdc0044_17_08_2009.html
