// Every customer-facing message Lia sends, in one place. Pure functions over plain
// data (no prisma/adapters) so tone, wording and formatting stay consistent and are
// unit-testable.
//
// Voice (revisão do dono, 17/08/2026 — ver docs/todas-as-mensagens-da-lia.md):
//   1. Verbo na frente, resultado primeiro.
//   2. Sem preâmbulo de simpatia ("Prontinho", "Opa", "Claro!", "Fechado!", "Poxa").
//   3. Sem explicar a mecânica interna (quantas lojas, como o frete é calculado,
//      que a Pagar.me tokeniza o cartão, por que a cotação venceu).
//   4. No máximo 1 emoji, e só onde carrega informação (📍 endereço, 🛵 entrega, ✅ ok).
//   5. Uma saída por mensagem.
//   6. Sem lista de exemplos de produto — a pergunta aberta basta.
//   7. Sem endereço/CEP fictício de exemplo: descrever os campos, não inventar um.
//   8. NUNCA prometer prazo antes de cotar (regra abaixo).
//
// PRAZO — a regra que não pode ser quebrada: quem manda no prazo é o checkout da loja,
// e ele varia (às vezes é no mesmo dia, às vezes leva dias). Nenhuma mensagem genérica
// diz "chega hoje" / "no mesmo dia" / "em ~1h". O prazo aparece uma vez só, no resumo do
// pedido, e SOMENTE com o valor real que a loja devolveu — sem número inventado de
// fallback. Antes disso a Lia diz que MOSTRA o prazo, nunca qual é.

export function brl(value: number): string {
  return `R$ ${Number(value ?? 0).toFixed(2).replace(".", ",")}`;
}

export type CopyBasketItem = { qty: number; name: string; displayLineTotal: number };

// ---------- social ----------

export function greeting(): string {
  return "Oi! Sou a Lia 💚 Me pede qualquer coisa que eu compro e entrego para você.";
}

export function thanks(): string {
  return "Imagina! Qualquer coisa é só chamar 💚";
}

export function help(): string {
  return [
    "Funciona assim:",
    "",
    "1. Você me diz o que precisa",
    "2. Eu mostro o total, o frete e o prazo",
    "3. Você paga por Pix ou cartão",
    "4. Eu compro e acompanho até chegar 🛵",
    "",
    "Também entendo *status*, *trocar endereço*, *tira o item X* e *repete o de sempre*.",
    "",
    "O que você precisa?"
  ].join("\n");
}

export function didNotUnderstand(): string {
  return "Não entendi. Me diz os itens que você quer.";
}

// "quero" / "queria comprar" sem dizer o quê — pergunta aberta, não "não entendi".
export function askWhatYouWant(): string {
  return "Me diz o que você precisa.";
}

// ---------- onboarding / address ----------

// A apresentação é a MESMA da `greeting` (sem o 💚, que fica só na saudação pura), pra
// Lia não se apresentar de três jeitos diferentes dependendo do caminho de entrada.
const INTRO = "Oi! Sou a Lia. Me pede qualquer coisa que eu compro e entrego para você.";

export function welcomeAskCep(notedItems?: string[]): string {
  const note = notedItems?.length ? `\n\nJá anotei:\n${notedItems.map((i) => `• ${i}`).join("\n")}` : "";
  return `${INTRO}${note}\n\nMe manda seu *CEP*? Só peço uma vez. 📍`;
}

export function welcomeAskFullDeliveryAddress(notedItems?: string[]): string {
  const note = notedItems?.length ? `\n\nJá anotei:\n${notedItems.map((i) => `• ${i}`).join("\n")}` : "";
  return `${INTRO}${note}\n\nMe manda seu *endereço completo* com CEP — rua, número, bairro e cidade. Só peço uma vez. 📍`;
}

// ---------- cadastro pelo formulário (06/10, dono: "pode pedir tudo direto no começo") ----------
// Corpo da mensagem que leva o formulário nativo do WhatsApp (botão "Fazer cadastro"). O
// pedido em texto de antes (welcomeAskFullDeliveryAddress) continua sendo o plano B.
export function signupFormBody(notedItems?: string[], intro = true): string {
  const items = notedItems?.length ? notedItems.map((i) => `• ${i}`).join("\n") : "";
  if (!intro) {
    const note = items ? `✅ Anotei:\n${items}\n\n` : "";
    return `${note}Pra eu comprar pra você, falta o cadastro: nome, CPF e endereço. É uma vez só 👇`;
  }
  const note = items ? `\n\nJá anotei:\n${items}` : "";
  return `${INTRO}${note}\n\nAntes, um cadastro rápido: nome, CPF e endereço. É uma vez só 👇`;
}

export function signupSaved(firstName: string | undefined, address: string): string {
  return `✅ Cadastro feito${firstName ? `, ${firstName}` : ""}!\n📍 Entrega em: ${cleanAddressForCopy(address)}\n_Pra mudar depois, é só dizer "trocar endereço"._`;
}

export function signupSavedAskItems(firstName: string | undefined, address: string): string {
  return `${signupSaved(firstName, address)}\n\nO que você precisa?`;
}

// Endereço salvo, mas o nome ou o CPF do formulário não conferiu: pede os dois por texto,
// numa mensagem só. Não trava (cpfOnboarding): se o cliente mandar outra coisa, segue.
export function signupFixCpf(address: string, problem: "cpf" | "name"): string {
  const what = problem === "name" ? "Faltou o *sobrenome*." : "O *CPF* não confere 🤔";
  return `📍 Endereço salvo: ${cleanAddressForCopy(address)}\n\n${what} Me manda seu nome completo e CPF numa mensagem só, assim:\n_Maria da Silva 123.456.789-09_`;
}

export function signupCepInvalid(): string {
  return "O CEP do cadastro não veio completo. Me manda seu *CEP* (8 números)? 📍";
}

// CEP geral (vale pra cidade inteira, sem rua, comum no interior) ou CEP sem consulta.
export function signupNeedStreet(): string {
  return "📍 Anotei o CEP, mas não achei a rua dele. Me manda a *rua e o número* (e o complemento, se tiver).";
}

// Formulário reenviado com um pedido em andamento (teste "cadastro" do dono).
export function signupIdentityOnly(): string {
  return "✅ Nome e CPF salvos. O pedido em andamento continua no mesmo endereço.";
}

// Fallback em texto dos botões 1 / 2 / Outra quantidade — por isso os números ficam:
// o texto tem que espelhar as mesmas opções que o canal com botões oferece.
export function quantityAsk(name: string): string {
  return `Quantas unidades de *${name}*? Responde *1*, *2* ou outro número.`;
}

export function askMoreItems(): string {
  return "Sua cesta está salva. O que mais você quer?";
}

// Re-pedido de endereço (2ª+ vez) — sem repetir a apresentação.
export function locationNotResolved(): string {
  return "Recebi sua localização, mas não consegui achar o CEP dela. Me manda o CEP ou o endereço por texto? 📍";
}

export function askCepAgain(): string {
  return "Falta seu *endereço completo com CEP* — rua, número, complemento, bairro, cidade e CEP 📍";
}

// Itens anotados quando a Lia JÁ se apresentou — confirma curto e pede só o CEP.
export function notedAskCep(notedItems: string[]): string {
  return `✅ Anotei:\n${notedItems.map((i) => `• ${i}`).join("\n")}\n\nFalta seu *CEP* 📍`;
}

// O cliente costuma terminar o endereço com ponto ("… São Paulo - SP.") — sem esta
// limpeza a mensagem saía com pontuação dupla ("SP..", rodada 8 de 14/08).
function cleanAddressForCopy(address: string): string {
  return address.replace(/[\s.,;]+$/, "");
}

export function addressSavedAskItems(address: string): string {
  return `📍 Endereço salvo: ${cleanAddressForCopy(address)}\n_Pra mudar depois, é só dizer "trocar endereço"._\n\nO que você quer?`;
}

// O CEP entra na confirmação quando é conhecido e não está no texto do endereço —
// 7º ciclo (16/08): o cliente corrigiu o CEP no fim do endereço, o fluxo processou
// certo, mas a confirmação não mostrava o número e parecia perdido.
function withCep(address: string, cep?: string): string {
  const clean = cleanAddressForCopy(address);
  if (!cep || clean.includes(cep)) return clean;
  return `${clean} — CEP ${cep}`;
}

export function addressSavedPrefix(address: string, cep?: string): string {
  return `📍 Endereço salvo: ${withCep(address, cep)}`;
}

export function addressUpdated(address: string, cep?: string): string {
  return `📍 Endereço atualizado: ${withCep(address, cep)}`;
}

// Encurtar não pode custar o SUBSTANTIVO: "Falta rua, número e complemento" chega logo
// depois de o cliente mandar um produto em vez do endereço, e sem a palavra "endereço" a
// frase não diz de que assunto ela é (eval manual-concierge, 17/08).
export function askFullDeliveryAddress(): string {
  return "Falta o *endereço*: rua, número e complemento 📍";
}

export function addressSavedAskCep(): string {
  return "📍 Endereço salvo. Falta o *CEP*.";
}

// UMA pergunta, não duas (feedback do dono, 16/08: "por que pede o CEP e depois o
// endereço?"). Os dois são necessários — CEP decide cobertura/frete, o endereço com
// número e complemento é o que o entregador usa — mas cabem na MESMA mensagem, e o
// parser já sabe ler endereço+CEP juntos desde 06/08.
export function askNewCep(): string {
  return "Manda o *endereço novo com CEP* — rua, número, complemento, bairro, cidade e CEP 📍";
}

// Destinatário (11/09): a loja imprime o nome na etiqueta; só perguntamos quando o perfil
// do WhatsApp não tem nome ou quando o cliente diz que é para outra pessoa.
export function askRecipientName(): string {
  return "Qual o *nome de quem vai receber*? Vai na etiqueta da entrega.";
}
export function recipientNameInvalid(): string {
  return "Antes do pagamento preciso só do *nome de quem vai receber* (nome e sobrenome), que vai na etiqueta da loja. Ex.: _Maria Souza_";
}
export function recipientNameSaved(name: string): string {
  return `Entrega em nome de *${name}*.`;
}

export function askCepForQuote(items: string[]): string {
  return `Anotei:\n${items.map((i) => `• ${i}`).join("\n")}\n\nQual seu *CEP*? 📍`;
}

// Esperando CEP e veio referência ("é pertinho da padaria"): re-pede com formato.
export function cepNeededNotLandmark(): string {
  return "Entendi 🙂 mas pra achar certinho eu preciso do *CEP* (8 números, tipo 01310-100). Se não souber, o nome da rua com número também ajuda.";
}

export function cepNotFound(cep: string): string {
  return `Não achei o CEP ${cep}. Confere e manda de novo.`;
}

// Fora da área que a Lia atende hoje: nunca aceita um pedido que não consegue entregar —
// guarda o contato e promete avisar. `areaLabel` vem da config de cobertura (coverage.ts).
// A área CONTINUA aparecendo aqui (e em `tooFarForDelivery` e `serviceAnswer:area`): sem
// dizer até onde a Lia vai, a recusa vira um "não" sem informação nenhuma.
export function outsideCoverage(city: string | undefined, areaLabel: string): string {
  const onde = city ? `em ${city}` : "aí";
  // "o estado de SP" → "no estado de SP"; "os estados de…" → "nos estados de…".
  const where = /^os? /.test(areaLabel) ? `n${areaLabel}` : `em ${areaLabel}`;
  return [
    `Ainda não chego ${onde} — hoje entrego só ${where.replace(/^(nos?|em) (.*)$/, "$1 *$2*")} 😔`,
    "",
    "Anotei seu contato: quando eu chegar na sua região, te chamo."
  ].join("\n");
}

// Cidade É atendida, mas o endereço ficou longe demais de qualquer loja parceira hoje.
// Cuidado: NÃO dizer "não atendo sua cidade" (atendo!) — é questão de loja perto ainda.
// ---------- search / basket ----------

export function searching(): string {
  return "🔎 Procurando…";
}

export function noMedicine(): string {
  return "Remédio eu não posso vender — por lei, só farmácia pode. Fora isso eu trago de tudo. O que mais você precisa?";
}

export function medicineSkippedNote(): string {
  return "_Remédio eu não posso vender, então deixei ele de fora._";
}

// ---------- remédio isento no CPF do cliente (29/09, LIA_MEDICINE_MIP) ----------

// Pedido de remédio de receita com MIP ligado: recusa só o de receita e diz o que dá.
export function prescriptionRefusal(): string {
  return "Remédio de receita eu não consigo comprar. Remédio *sem receita* (dipirona, antigripal, antiácido…) eu compro na farmácia no seu nome. Me diz o nome do que você precisa.";
}

export function prescriptionSkippedNote(): string {
  return "_Remédio de receita eu não consigo comprar, então deixei ele de fora._";
}

// Pedido por sintoma com MIP ligado: a Lia não indica remédio (é papel do farmacêutico).
export function symptomExplainerMip(): string {
  return "Indicar remédio eu não posso — isso é com o farmacêutico. Se você já sabe o nome do remédio *sem receita* que quer, me diz que eu compro na farmácia no seu nome. Enquanto isso, olha o que achei de conforto:";
}

const TERMS_URL = "liadelivery.com.br/termos";

// 05/10 (dono): curto. Pedido uma vez (no cadastro ou no 1º remédio) e guardado.
export function askCpfForMedicine(): string {
  return `Me manda seu *nome completo* e *CPF*, uma vez só, pra eu comprar no seu nome quando precisar (ex.: remédio). Assim:\n_Maria da Silva 123.456.789-09_\n\n_Uso só pra isso (${TERMS_URL})._`;
}

// Cadastro (05/10): logo depois do endereço, uma vez só.
export function askCpfOnboarding(): string {
  return `Última coisa: seu *nome completo* e *CPF*, pra eu comprar no seu nome quando precisar (ex.: remédio). Assim:\n_Maria da Silva 123.456.789-09_`;
}

export function cpfSavedAskItems(): string {
  return "✅ Anotado. O que você precisa?";
}

export function cpfInvalid(): string {
  return "Esse CPF não confere 🤔 Me manda de novo, junto com seu nome completo.";
}

export function askFullNameForCpf(): string {
  return "Anotei o CPF ✅ Agora seu *nome completo*.";
}

// "pra que cpf?" no cadastro (06/10): a IA dava uma resposta diferente a cada vez.
export function whyCpf(): string {
  return `É pra eu comprar *no seu nome* quando a loja exige — farmácia (remédio sem receita) e nota fiscal no seu CPF. Fica guardado só aqui, não uso pra mais nada (${TERMS_URL}).\n\nSe preferir não passar agora, tudo bem: me diz o que você precisa. Se quiser passar, manda assim: _Maria da Silva 123.456.789-09_`;
}

export function cpfSkipped(hasQueued: boolean): string {
  return hasQueued ? "Sem problema, sigo sem o CPF 👍" : "Sem problema, sigo sem o CPF 👍 O que você precisa?";
}

export function askCpfAfterName(): string {
  return "Anotei o nome ✅ Agora o *CPF*.";
}

export function cpfSaved(_masked: string): string {
  return "✅ Anotado.";
}

export function medicineRemovedFromBasket(): string {
  return "Tirei o remédio da cesta 👍 Fechando o resto…";
}

export function medicineInvoiceNotice(shortId: string, storeLabel: string, url?: string): string {
  return url
    ? `🧾 Pedido #${shortId}: a ${storeLabel} emitiu a nota fiscal no seu nome. Aqui está: ${url}`
    : `🧾 Pedido #${shortId}: a ${storeLabel} emitiu a nota fiscal no seu nome. Se precisar de uma cópia, é só pedir aqui.`;
}

// Escolha de pagamento em pedido com remédio: texto puro, sem botão de pagamento do WhatsApp.
export function medicinePaymentChoiceText(pixTotal: number, cardTotal: number): string {
  return `Como você quer pagar?\n• *Pix*: ${brl(pixTotal)}\n• *Cartão*: ${brl(cardTotal)}\n\nResponde *pix* ou *cartão*.`;
}

export function cartCleared(): string {
  return "Carrinho limpo. O que você quer agora?";
}

export function removedItems(names: string, basketEmpty: boolean): string {
  return basketEmpty ? `Tirei ${names}. Sua cesta ficou vazia — o que você quer?` : `Tirei ${names}.`;
}

export function removeNotFound(): string {
  return "Não achei esse item na sua cesta. Me diz o nome como está na lista.";
}

export function swapAskWhat(from: string): string {
  return `Trocar ${from} por qual?`;
}

export function swapRemovedPrefix(from: string): string {
  return `Tirei ${from}.`;
}

export function swappedFor(from: string, to: string): string {
  return `✅ Troquei ${from} por ${to}.`;
}

// "só isso" com a cesta ABAIXO do mínimo da loja: sem loop — explica e dá saída.
export function finishOrderFirst(): string {
  return "Esse pedido ainda não foi fechado. Responde *pagar* que eu mando o código.";
}

export function emptyCartPay(): string {
  return "Sua cesta está vazia. Me diz o que você quer.";
}

export function rejectedAskAgain(): string {
  return "Me diz de outro jeito — marca, tamanho — que eu procuro.";
}

// ---------- choices ----------

export function choicesHeaderToday(query: string): string {
  return `Chega hoje — opções de *${query}*:`;
}

export function noneTodayHeader(query: string): string {
  return `Nada chega hoje para *${query}* nas lojas que consigo confirmar. O mais rápido que tenho:`;
}

// Abertura da vitrine (dono, 05/10: "só põe um olha o que achei e esse emojizinho").
export function choicesHeader(_query: string): string {
  return "Olha o que achei 👇";
}
// Variável {{1}} dos carrosséis v3/v4 (o corpo deles já começa com "Olha o que achei 👇").
export function choicesHeaderLegacy(query: string): string {
  return `Opções de *${query}*:`;
}

export function choiceSequence(queries: string[]): string {
  // Lista longa não vira parágrafo com 11 "e" (28/08 S1): cita os 3 primeiros e conta
  // o resto.
  const rest = queries.slice(1);
  const shown = rest.slice(0, 2).map((q) => `*${q}*`);
  const extra = rest.length - shown.length;
  const tail = extra > 0 ? `${shown.join(", ")} e mais ${extra}` : shown.join(" e ");
  return `Achei os ${queries.length} itens. Vamos um de cada vez: *${queries[0]}*${rest.length ? `, depois ${tail}` : ""}.`;
}

export function nextChoiceHeader(query: string, remaining: number): string {
  const tail = remaining > 1 ? ` — depois faltam ${remaining - 1}` : "";
  return `Agora *${query}*${tail}.`;
}

export function choiceLine(index: number, name: string, displayPrice: number, delivery?: string, repeat?: boolean): string {
  // `delivery` só existe em vitrine que informa o prazo por anúncio (Mercado Livre):
  // é a promessa da PRÓPRIA loja ("chega hoje"), nunca uma estimativa nossa.
  const prazo = delivery ? ` · _${delivery}_` : "";
  // `repeat` (04/09): o cliente já comprou este — destaque na linha.
  const star = repeat ? "⭐ " : "";
  const again = repeat ? " · _você já pediu_" : "";
  return `*${index + 1})* ${star}${name} — ${brl(displayPrice)}${prazo}${again}`;
}

// O comando *qualquer* continua valendo no parser; saiu só do texto, que oferecia
// quatro saídas de uma vez (dono, 17/08: "uma pergunta por mensagem").
export function choicesAsk(count: number): string {
  const nums = Array.from({ length: count }, (_, i) => i + 1);
  return count <= 1
    ? "Responde *1* pra confirmar, *outras* pra ver mais, ou *pula* pra deixar de fora."
    : `Responde *${nums.slice(0, -1).join("*, *")}* ou *${nums[nums.length - 1]}* — ou *outras* pra ver mais, *pula* pra deixar de fora.`;
}

export function choicesText(query: string, options: { name: string; displayPrice: number; delivery?: string; repeat?: boolean }[], header?: string): string {
  return [
    header ?? choicesHeader(query),
    ...options.map((o, i) => choiceLine(i, o.name, o.displayPrice, o.delivery, o.repeat)),
    "",
    choicesAsk(options.length)
  ].join("\n");
}

export function moreChoicesHeader(query: string): string {
  return `Mais opções de *${query}*:`;
}

export function priceSortedHeader(query: string, cheapest: boolean): string {
  return cheapest ? `As mais baratas de *${query}*:` : `As mais caras de *${query}*:`;
}

export function noMoreOptions(query: string): string {
  return `Essas são todas as opções de *${query}* que eu tenho. Responde o número, ou *pula* pra seguir sem esse item.`;
}

// Segundo "outras" com o pool esgotado NÃO repete a mesma frase (rodada 27/08 S4):
// convida a reformular, que é a única saída real.
export function noMoreOptionsAskReword(query: string): string {
  return `De *${query}* eu já mostrei tudo que tenho. Me diz uma marca, tipo ou faixa de preço que eu procuro diferente.`;
}

// Toque num botão de card de uma mensagem antiga: dizer ISSO, em vez do
// genérico "não peguei qual você quer" (rodada 27/08 S1).
export function staleButtonTap(hasCurrentOptions: boolean): string {
  return hasCurrentOptions
    ? "Esse botão é de uma conversa antiga 🙂 As opções de agora são essas:"
    : "Esse botão é de uma conversa antiga 🙂 Me diz o que você precisa que eu busco de novo.";
}

export function refineClosest(attrs: string): string {
  return `Não achei exatamente *${attrs}*. O mais perto que tenho:`;
}

export function refineNoResult(refined: string): string {
  return `Não achei *${refined}*. O que eu tenho é isso:`;
}

// Confirmação da escolha SEMPRE mostra a quantidade quando ela já é conhecida —
// "✅ Caixa de Bombom" depois de pedir "quatro caixas" parecia que o 4 se perdeu
// (re-teste 15/08, rodadas 3, 7 e 9; o estado interno estava certo, o texto não).
export function choiceConfirmed(name: string, qty = 1): string {
  return qty > 1 ? `✅ ${qty}x ${name}` : `✅ ${name}`;
}

// Quantidade não dita = 1 e segue (dono, 01/09): a rodada "quantas unidades?" era uma
// mensagem a mais no caso comum. A dica de ajuste usa o TERMO PEDIDO (curto), não o
// nome completo do produto.
// 05/10 (dono): "é só o check e o nome do produto" — os botões embaixo já dizem o resto
// (Pagar / Adicionar mais / Mudar quantidade).
export function choiceConfirmedAssumedOne(name: string, _query: string): string {
  return `✅ ${name}`;
}

// Botão "Ver detalhes" / "detalhes 2" digitado: link real do anúncio/página, onde o
// cliente vê reviews, fotos e specs. Mensagem de TEXTO puro (link clicável garantido).
export function productDetailsLink(name: string, url: string): string {
  return `🔎 *${name}*\n${url}\nQuando decidir, é só tocar em *Adicionar ao carrinho* no card.`;
}

export function productDetailsList(items: Array<{ name: string; url: string }>): string {
  const lines = items.map((item, index) => `${index + 1}) ${item.name}\n${item.url}`);
  return [`🔎 As páginas dos produtos:`, ...lines, `Quando decidir, é só tocar em *Adicionar ao carrinho* no card.`].join("\n");
}

export function productDetailsUnavailable(): string {
  return "Esse aí é do nosso catálogo interno e não tem página pública — mas me pergunta o que quiser saber dele que eu te respondo.";
}

export function productDetailsWhich(): string {
  return "De qual produto? Me diz o nome (ou o número do card) que eu mando a página.";
}

export function choiceSkipped(query: string): string {
  return `Deixei *${query}* de fora. Se quiser, me diz de outro jeito que eu procuro.`;
}

// Dizia só "Não peguei qual você quer" e deixava o cliente sem próximo passo.
export function choiceNotUnderstood(): string {
  return "Não peguei qual você quer. Responde o número.";
}

export function autoAddedNote(items: string[]): string {
  return `✅ Anotei: ${items.join(", ")}`;
}

export function notFoundNote(items: string[]): string {
  return `_Não achei: ${items.map(shortNotFoundLabel).join(", ")}. Me fala de outro jeito que eu procuro._`;
}

// ---------- quote / summary ----------

export type SummaryInput = {
  items: CopyBasketItem[];
  produtos: number;
  // Taxa da Lia em pedido com remédio isento (29/09), fora de "Produtos".
  serviceLine?: number;
  frete: number;
  etaMinutes?: number;
  deliveryPromise?: string;
  total: number;
  deliveryAddress?: string;
  notFound?: string[];
  pickupCount?: number;
};

// O prazo do resumo é o ÚNICO lugar onde a Lia fala em tempo — e só quando existe dado
// real. Antes havia `?? 40` / `?? 90` de fallback: sem prazo da loja, a Lia escrevia
// "chega em ~40 min" sem base nenhuma (dono, 17/08: "para de mentir q sempre chega no
// mesmo dia pq n eh verdade as vezes"). Sem dado, a linha sai só com o valor.
function deliveryLine(frete: number, deliveryPromise?: string, etaMinutes?: number): string {
  const prazo = deliveryPromise ?? (etaMinutes ? `chega em ~${etaMinutes} min` : null);
  return `Entrega: ${brl(frete)}${prazo ? ` · ${prazo}` : ""}`;
}

export function summary(input: SummaryInput): string {
  const lines = input.items.map((item) => `• ${item.qty}x ${item.name} — ${brl(item.displayLineTotal)}`);
  const out = [
    "🛒 *Seu pedido:*",
    ...lines,
    "",
    `Produtos: ${brl(input.produtos)}`,
    ...(input.serviceLine != null ? [`Taxa de serviço da Lia: ${brl(input.serviceLine)}`] : []),
    deliveryLine(input.frete, input.deliveryPromise, input.etaMinutes),
    `*Total: ${brl(input.total)}*`
  ];
  if (input.notFound?.length) {
    out.push("", notFoundNote(input.notFound));
  }
  if ((input.pickupCount ?? 1) > 1) {
    out.push("", `_Frete de ${input.pickupCount} lojas já somado._`);
  }
  if (input.deliveryAddress) {
    out.push("", `📍 ${input.deliveryAddress}`, '_Pra mudar, diz "trocar endereço"._');
  }
  out.push(
    "",
    "Escolhe abaixo como quer pagar.",
    '_Quer ajustar? "tira o arroz", "troca X por Y", ou manda mais itens._'
  );
  return out.join("\n");
}

export function minimumOrder(input: {
  items: CopyBasketItem[];
  produtos: number;
  displayMin: number;
  falta: number;
  // A parte da cesta que NÃO conta pro mínimo desta loja. Sem mostrar isso, a mensagem
  // parecia um resumo completo e o cliente achava que os outros itens tinham sumido
  // (rodadas 3 e 10 dos testes reais de 14/08).
  storeLabel?: string;
  otherItems?: CopyBasketItem[];
}): string {
  const lines = input.items.map((item) => `• ${item.qty}x ${item.name} — ${brl(item.displayLineTotal)}`);
  const store = input.storeLabel ?? "a loja";
  const out = [
    `🛒 *Itens de ${store}:*`,
    ...lines,
    "",
    `Produtos (${store}): ${brl(input.produtos)}`,
    "",
    `A ${store} tem pedido mínimo de *${brl(input.displayMin)}* — faltam *${brl(input.falta)}*. Manda mais um item de lá que eu fecho.`
  ];
  if (input.otherItems?.length) {
    out.push(
      "",
      "_O resto da sua cesta continua guardado:_",
      ...input.otherItems.map((item) => `• ${item.qty}x ${item.name} — ${brl(item.displayLineTotal)}`)
    );
  }
  return out.join("\n");
}

// Escolha de entrega do MARKETPLACE (pedido do dono, 17/08: "tem q perguntar se ele quer o
// mais rápido e caro ou mais demorado e barato e tem q ter botão"). Aqui o trade-off é
// preço × DATA — o anúncio publica data, não minutos —, e o número que decide é o TOTAL,
// não o frete solto: é o que vai sair da conta do cliente. Os botões vão junto no canal
// Meta; esta lista numerada é o fallback (e o que o cliente lê pra comparar).
export function shippingSpeedChoice(
  barato: { total: number; estimate?: string },
  rapido: { total: number; estimate?: string },
  kind: "ml" | "store" = "ml"
): string {
  // ML: data do anúncio ("chega até sáb."). Loja: SLA dela ("prazo da loja: 60 min").
  const quando = (estimate?: string) =>
    estimate ? (kind === "store" ? estimate : `chega até ${estimate}`) : kind === "store" ? "sem prazo informado" : "sem data publicada";
  return [
    "Tem duas formas de entrega. Qual você prefere?",
    `*1)* Mais barata — ${brl(barato.total)} · ${quando(barato.estimate)}`,
    `*2)* Mais rápida — ${brl(rapido.total)} · ${quando(rapido.estimate)}`,
    "",
    "Toca no botão ou responde *1* ou *2*."
  ].join("\n");
}

// ---------- payment ----------

export function paymentMethod(totalPix: number, totalCard: number): string {
  return [
    "Como prefere pagar?",
    `*1)* Pix — ${brl(totalPix)} _(sem taxa)_`,
    `*2)* Cartão — ${brl(totalCard)} _(com taxa da maquininha)_`,
    "",
    "Responde *pix* ou *cartão*."
  ].join("\n");
}

// O CÓDIGO vai numa mensagem SEPARADA (enviada logo após esta): no WhatsApp o cliente
// copia a mensagem inteira — se tiver prosa junto, o Pix não cola no banco.
export function pixInstructions(total: number, mock: boolean): string {
  return [
    `Total *${brl(total)}* no Pix.`,
    "",
    "O código vem na próxima mensagem — copia ela inteira e cola no *Pix copia e cola* do seu banco 👇",
    "",
    mock ? sandboxHint() : "Assim que cair, eu começo a separar."
  ].join("\n");
}

// Botão "Editar itens" do resumo: manual curto dos comandos de edição que já existem.
export function editItemsHelp(): string {
  return [
    "Pra mexer no pedido é só me falar:",
    '· *tira <item>* — remove',
    '· *troca <item> por <outro>* — substitui',
    '· *2x <item>* — muda a quantidade',
    "· ou manda o nome de um item novo pra adicionar 😉"
  ].join("\n");
}

// Pedido novo × juntar (01/09): pedido não-pago parado + cliente pedindo item novo do
// nada. Antes a Lia fundia os dois sozinha ("O total anterior não vale mais") — agora
// ela PERGUNTA. Juntar/adicionar explícito ou cobrança recém-emitida seguem fundindo.
export function mergeOrNewOrderPrompt(shortId: string, total: number): string {
  return `Você tem o pedido *#${shortId}* (${brl(total)}) esperando pagamento. Esse item novo é pra *juntar* nele, ou começamos um *pedido novo*?`;
}

// Pix pago enquanto a pergunta "juntar ou pedido novo?" estava aberta: o item novo
// não pode sumir em silêncio — vira pedido novo assim que o cliente mandar de novo.
export function newItemAfterPayment(request: string): string {
  const item = request.trim().slice(0, 60);
  return `E aquele item novo ("${item}") — como este pedido já está pago, ele vira um pedido novo. Me manda de novo que eu busco 🙂`;
}

export function newOrderStarted(shortId: string): string {
  return `Fechado! Cancelei o *#${shortId}* — nada foi cobrado. Bora pro pedido novo 👇`;
}

// Corpo da bolha nativa de Pix (order_details). V2 (01/09): a bolha vai PRIMEIRO e,
// quando a Graph aceita, substitui o texto de instruções — só o copia-e-cola sai
// depois dela (fallback universal pra WhatsApp Web/cliente antigo).
export function nativePixBody(orderRef: string): string {
  return `Pedido ${orderRef} — toca em *Pagar com Pix* pra abrir seu banco, ou copia o código da próxima mensagem 👇 Assim que cair, te aviso por aqui ⚡`;
}

export function nativePixItemName(orderRef: string): string {
  return `Pedido Lia ${orderRef}`;
}

export function cardInstructions(total: number, link: string, mock: boolean): string {
  return [
    `Total *${brl(total)}* no cartão _(taxa da maquininha incluída)_.`,
    "",
    "Paga por este link 👇",
    link,
    "",
    mock ? sandboxHint() : "Assim que aprovar, eu começo a separar."
  ].join("\n");
}

// First card only: the fields are tokenized by Pagar.me in the customer's browser.
// Reorders never use this link; they use WhatsApp's native payment confirmation.
export function cardEnrollmentInstructions(total: number, link: string, mock: boolean): string {
  return [
    `Total *${brl(total)}* no cartão _(taxa da maquininha incluída)_.`,
    "",
    "Na primeira compra você cadastra o cartão neste link seguro. Nas próximas, confirma aqui mesmo 👇",
    link,
    "",
    mock ? sandboxHint() : "_Eu não recebo o número nem o CVV do seu cartão._"
  ].join("\n");
}

export function cardPaymentProcessing(): string {
  return "Pagamento em processamento. Te aviso assim que confirmar.";
}

// Body rendered inside Meta's native order_details payment bubble. The card number
// is never sent or stored here; WhatsApp only shows the last four digits we supply.
export function orderDetailsBody(total: number, last4: string): string {
  return `Seu pedido: *${brl(total)}*. Toque em *Revisar e pagar* pra cobrar no cartão final *${last4}*.`;
}

// Fallback em texto quando os botões interativos não estão disponíveis (provider de
// teste). Aceita as formas humanas que o parser entende: "usar cartão" / "outro cartão".
export function savedCardOffer(total: number, last4: string): string {
  return [
    `Pagar *${brl(total)}* no cartão salvo final *${last4}*?`,
    "",
    "Responde *usar cartão*, ou *outro cartão* pra cadastrar outro."
  ].join("\n");
}

export function savedCardCharging(last4: string): string {
  return `Cobrando no cartão final *${last4}*. Te confirmo em instantes.`;
}

export function savedCardNothingPending(): string {
  return "Não tem cobrança em aberto. Responde *pagar* que eu gero uma nova.";
}

export function cardChargeFailed(last4: string): string {
  return `O cartão final *${last4}* não aprovou. Responde *pix*, ou *cartão* que eu mando um link novo.`;
}

export function cardAttemptExpired(): string {
  return "Essa cobrança venceu. Responde *pagar* que eu gero uma nova.";
}

export function paymentConfirmed(): string {
  return "✅ Pagamento confirmado. Já estou separando — te aviso quando sair pra entrega.";
}

// Pix cai às 23h e quem compra é gente: "já estou separando" vira mentira por 10 horas.
// Honesto e sem inventar hora exata — o prazo real continua sendo o da loja.
export function paymentConfirmedOutsideHours(): string {
  return "✅ Pagamento confirmado. As lojas já fecharam por hoje: faço sua compra logo cedo e te aviso por aqui.";
}

export function supplierValidationPending(): string {
  return "Ainda confirmando na loja. Não precisa pagar nada agora — te aviso quando estiver pronto.";
}

export function quoteExpired(): string {
  return "Esse preço venceu. Fecho um novo antes de cobrar qualquer coisa.";
}

export function pixNotSeenYet(): string {
  return "O Pix ainda não caiu aqui. Assim que cair, te aviso na hora. Se passar de 5 min, me chama.";
}

export function cardPending(): string {
  return "Ainda não aprovou. Assim que confirmar, te aviso na hora.";
}

export function alreadyPaid(): string {
  return "✅ Seu pagamento já está confirmado. Pra acompanhar, responde *status*.";
}

// Intro do reenvio — o código em si vai na mensagem seguinte, sozinho (copiável).
export function resendPix(): string {
  return "Segue o código na próxima mensagem — copia ela inteira e cola no *Pix copia e cola* 👇";
}

export function resendCard(link: string): string {
  return ["Seu link de pagamento 👇", link].join("\n");
}

export function paymentSwitched(method: "pix" | "card", total: number): string {
  return method === "pix"
    ? `Troquei pra Pix — total *${brl(total)}*, sem taxa. Segue o código 👇`
    : `Troquei pro cartão — total *${brl(total)}*, com taxa da maquininha. Segue o link 👇`;
}

// Mercado Pago fora do ar com credencial real: NUNCA cai num Pix de mentira. O pedido
// continua aguardando e o cliente tem uma saída clara — repetir a forma de pagamento.
// "nada foi cobrado" é a informação que tira o medo de pagar duas vezes.
export function paymentIssueFailed(): string {
  return "Não consegui gerar seu pagamento agora — nada foi cobrado. Responde *pix* ou *cartão* que eu tento de novo.";
}

export function sandboxHint(): string {
  return "_(sandbox: responda *paguei* pra simular)_";
}

// ---------- order lifecycle ----------

// O "Seu pedido" que abria as 14 variantes saiu: o `#id` em negrito já abre a linha e
// economiza uma linha inteira na tela do celular.
export function orderStatusLine(input: {
  shortId: string;
  status: string;
  trackingUrl?: string | null;
  etaMinutes?: number;
  itemsPreview?: string;
  paid?: boolean;
  // "de ontem" / "de sábado" / "de 23/08" — pedido antigo SEMPRE chega ancorado no
  // tempo e no conteúdo (rodada 27/08: "#YAQHF8 confirmado" sem data nem itens fez o
  // testador achar que o pedido cancelado dele tinha virado pago).
  dateLabel?: string;
}): string {
  const meta = [input.dateLabel, input.itemsPreview].filter(Boolean).join(" — ");
  const id = meta ? `*#${input.shortId}* (${meta})` : `*#${input.shortId}*`;
  switch (input.status) {
    case "awaiting_operator_quote":
      return `${id} com o total sendo fechado. Mando com a entrega pra você aprovar — nada é cobrado antes.`;
    case "awaiting_supplier_validation":
    case "payment_issuing":
      return `${id} em confirmação na loja. Te aviso quando o carrinho estiver pronto.`;
    case "awaiting_payment":
      return `${id} aguardando pagamento. Responde *pagar* que eu mando o código de novo.`;
    case "paid":
      return `${id} confirmado, separando os itens. Te aviso quando sair pra entrega.`;
    // Com link de acompanhamento (o operador cola o do próprio pedido na loja/ML ao marcar
    // a compra), o cliente vê o andamento na FONTE em vez de depender de a gente marcar
    // "saiu pra entrega" — nos pedidos que a loja entrega, o operador não sabe a hora
    // certa disso e o cliente ficava no escuro (dono, 17/08).
    case "retailer_preparing":
      return input.trackingUrl
        ? `${id} comprado, a loja está preparando 📦\nAcompanha: ${input.trackingUrl}`
        : `${id} comprado, a loja está preparando. Te aviso quando sair pra entrega.`;
    // "a caminho" vale para os dois estágios (enviado pela transportadora OU entregador na rua).
    case "retailer_out_for_delivery":
      return `${id} a caminho, enviado pela loja 🚚${input.trackingUrl ? `\nAcompanha: ${input.trackingUrl}` : ""}`;
    case "operator_buying":
      return input.trackingUrl
        ? `${id} comprado e em preparação 📦\nAcompanha: ${input.trackingUrl}`
        : `${id} comprado e em preparação. Te aviso quando sair pra entrega.`;
    case "ready_for_pickup":
      return `${id} pronto pra retirada.`;
    case "dispatched":
      return `${id} saiu pra entrega 🛵${input.trackingUrl ? `\nAcompanha: ${input.trackingUrl}` : ""}`;
    case "delivered":
      return `${id} entregue ✅ Precisando de algo, é só chamar.`;
    case "refund_pending":
      return `${id} cancelado. O estorno ainda está pendente — te aviso quando concluir.`;
    case "refunded":
      return `${id} cancelado e estornado ✅`;
    case "canceled":
      // Estado financeiro REAL, nunca "se pagou" (teste 26/08: 6 sessões ouviram
      // "estorno a caminho" de pedidos que nunca foram pagos).
      return input.paid
        ? `${id} cancelado. O estorno do que você pagou está sendo tratado — te aviso quando concluir.`
        : `${id} cancelado — nada foi cobrado. Quer pedir de novo?`;
    default:
      return `${id} em andamento. Qualquer novidade eu aviso.`;
  }
}

export function noOrdersYet(): string {
  return "Você ainda não tem pedidos. Me diz o que precisa que eu monto o primeiro.";
}

export function canceledUnpaid(): string {
  return "Cancelado. Nada foi cobrado. Quando quiser, é só pedir de novo.";
}

// Motivo do cancelamento (06/10, testadora): opções de tocar, na ordem das chaves de
// CANCEL_REASON_KEYS (lia-intents). Título de linha de lista ≤ 24 caracteres.
export const CANCEL_REASON_OPTIONS = [
  { key: "frete", title: "Frete caro" },
  { key: "preco", title: "Produto caro" },
  { key: "outro_app", title: "Comprei em outro app" },
  { key: "desisti", title: "Desisti da compra" },
  { key: "outro", title: "Outro motivo" }
] as const;

export function cancelReasonAsk(): string {
  return "Se puder, me conta por que cancelou? Isso me ajuda a melhorar.";
}

export function cancelReasonAskText(): string {
  return [cancelReasonAsk(), ...CANCEL_REASON_OPTIONS.map((o, i) => `*${i + 1})* ${o.title}`)].join("\n");
}

export function cancelReasonLabel(key: string): string {
  return CANCEL_REASON_OPTIONS.find((o) => o.key === key)?.title ?? key;
}

export function cancelReasonThanks(): string {
  return "Obrigada, anotei 🙏 Quando quiser, é só pedir de novo.";
}

// Regra de 11/09 (CDC art. 49): antes de a compra na loja sair, o cliente pode desistir e
// o estorno é na hora. Depois que a compra saiu, não dá — item faltando é estornado e
// atraso é avisado. O texto é um só nas três entradas, de propósito.
const NO_CANCEL_AFTER_PURCHASE =
  "A compra já foi feita na loja, então não dá mais pra cancelar. Se faltar item, estorno o valor dele; se atrasar, eu aviso.";

export function cancelRequestedPaid(): string {
  return NO_CANCEL_AFTER_PURCHASE;
}

export function cancelTooLate(): string {
  return NO_CANCEL_AFTER_PURCHASE;
}

// Desistência aceita: o dinheiro volta pelo mesmo meio, sem esperar ninguém.
export function withdrawnRefunded(total: number): string {
  return `Cancelado. Estornei R$ ${total.toFixed(2).replace(".", ",")} pelo mesmo meio que você pagou; o banco leva até 7 dias úteis pra mostrar.`;
}

export function nothingToCancel(paidActive?: { shortId: string; dateLabel?: string; itemsPreview?: string }): string {
  if (paidActive) {
    const meta = [paidActive.dateLabel, paidActive.itemsPreview].filter(Boolean).join(" — ");
    return `Não tem compra em aberto pra cancelar. Seu pedido *#${paidActive.shortId}*${meta ? ` (${meta})` : ""} está pago e em andamento — esse segue normal; qualquer coisa nele, me fala o número.`;
  }
  return "Não tem nada em aberto pra cancelar. Me diz o que você precisa que eu monto a lista.";
}

// "cadê meu pedido?" logo depois de um cancelamento fala PRIMEIRO do cancelado; se
// existir um pedido pago antigo, ele entra como segunda linha, com data e conteúdo.
export function alsoActiveOrder(input: { shortId: string; dateLabel?: string; itemsPreview?: string }): string {
  const meta = [input.dateLabel, input.itemsPreview].filter(Boolean).join(" — ");
  return `Além desse, seu pedido *#${input.shortId}*${meta ? ` (${meta})` : ""} está pago e em andamento — esse segue normal.`;
}

export function noPreviousOrder(): string {
  return "Você ainda não tem um pedido pra repetir. Me diz o que quer que eu monto.";
}

// "o de sempre": a cesta antiga volta pra CONFERÊNCIA, nunca direto pro pagamento —
// retomada automática com dinheiro na mesa precisa de um "sim" (rodada 27/08 S16).
export function repeatOrderConfirm(items: { qty: number; name: string; total: number }[]): string {
  return [
    "Achei sua última compra:",
    ...items.map((i) => `• ${i.qty}x ${i.name} — ${brl(i.total)}`),
    "É isso? Responde *sim* que eu fecho o total — ou me diz o que mudar."
  ].join("\n");
}

// "quero a entrega mais rápida" quando o pedido só tem UMA modalidade: resposta
// honesta, nunca o menu de pagamento (rodada 27/08 S12).
export function onlyOneShippingMode(): string {
  return "Essa entrega só tem uma modalidade — não consigo acelerar esse pedido. Quer fechar assim, ou prefere que eu procure o item em outra loja?";
}

// "mais barato" depois do total, sem escolha reabrível: pede o alvo em vez de repetir
// o menu de pagamento (27/08 S14 — a própria Lia tinha prometido esse comando).
export function cheaperAfterQuoteNeedsItem(): string {
  return "Me diz qual item você quer mais barato que eu procuro outra opção — ou fecha assim respondendo *pix* ou *cartão*.";
}

// ---------- perguntas de confiança/logística (rodada 28/08 — ficavam sem resposta) ----------

// "é seguro? como sei que não é golpe?" — na hora do dinheiro, resposta ESPECÍFICA.
export function trustAnswer(): string {
  return [
    "Pergunta justa 🙂 Funciona assim, na ordem que te protege:",
    "• Você só paga DEPOIS de ver e aprovar o total — nada é cobrado antes.",
    "• O pagamento é por Pix ou cartão com recibo; se algo não vier, o valor do item é estornado.",
    "• Eu compro nas lojas oficiais (Carrefour, Mercado Livre e afins) e a entrega é rastreada.",
    "Qualquer dúvida antes de pagar, é só perguntar — sem pressa."
  ].join("\n");
}

// "meu filho que vai pagar, manda pra ele?" — honesto: a cobrança sai aqui, mas o
// código Pix pode ser encaminhado pra quem for pagar.
export function thirdPartyPayAnswer(): string {
  return "A cobrança sai aqui na nossa conversa, mas o código Pix é copia-e-cola: você pode encaminhar a mensagem pra quem for pagar, e a pessoa paga direto no banco dela 🙂 Quer que eu gere o Pix?";
}

// Nota fiscal / CNPJ. Os dados da empresa vêm da env LIA_BUSINESS_INFO (ex.:
// "Lia Delivery — CNPJ 12.345.678/0001-90"); sem env, resposta honesta sem número.
export function fiscalAnswer(topic: "nf" | "cnpj", businessInfo?: string): string {
  if (topic === "nf") {
    return "Sim — a compra é feita na loja oficial e a nota fiscal sai da própria loja, no valor dos produtos. Te encaminho junto com a confirmação da compra se você quiser.";
  }
  return businessInfo
    ? `Claro: ${businessInfo}. E a nota fiscal dos produtos sai da própria loja onde eu compro.`
    : "Somos um serviço registrado e a nota fiscal dos produtos sai da própria loja onde eu compro. Se quiser os dados completos da empresa, me fala que eu te envio certinho.";
}

// "quem faz a entrega?"
export function whoDeliversAnswer(): string {
  return "A entrega é da própria loja onde eu faço a sua compra (ou do parceiro oficial dela, tipo os correios/transportadora do Mercado Livre). Eu acompanho o pedido até chegar e te aviso de cada etapa 📦";
}

// "no site tá mais barato, tá me cobrando a mais?" — honestidade sobre o serviço.
export function priceDisputeAnswer(): string {
  return [
    "Olho clínico 🙂 É isso mesmo: o preço aqui inclui o meu serviço — eu busco, comparo, compro e acompanho a entrega pra você. Por isso pode ficar um pouco acima do site da loja.",
    "O frete é o da própria loja, sem margem em cima.",
    "Se preferir, respondo *mais barato* que eu procuro uma opção mais em conta — ou você fecha assim."
  ].join("\n");
}

// Xingamento leve: resposta digna, sem briga, e devolve o fluxo.
export function insultAnswer(): string {
  return "Ainda estou aprendendo, é verdade 🙂 Me diz do seu jeito o que você precisa que eu resolvo — e se preferir falar com uma pessoa, é só dizer *atendente*.";
}

// Pedido por SINTOMA ("algo pra dor de cabeça"): explica o limite ANTES das opções.
export function symptomExplainer(): string {
  return "Remédio eu não posso vender — por lei, só farmácia. O que eu consigo trazer são itens de conforto (chá, isotônico, bolsa térmica…) — vou te mostrar o que achei; qualquer coisa, o farmacêutico é o caminho certo pra medicação 💊";
}

// Cigarro/tabaco: recusa explicada, nunca sumir com o item em silêncio (28/08 S19).
export function tobaccoRefusal(): string {
  return "Cigarro e produtos de tabaco eu não vendo — venda a distância é restrita 🚭 O resto da lista eu trago normal.";
}

// "espera aí/já volto": pausa reconhecida, nada muda.
export function holdAck(): string {
  return "Tranquilo, te espero 🙂 Volta quando puder que a gente continua de onde parou.";
}

// "voltei, onde a gente tava?" — cabeçalho do resumo de retomada.
export function resumeHeader(): string {
  return "Bem-vinda de volta! 🙂 A gente estava aqui:";
}

export function resumeNothingOpen(): string {
  return "A gente não tinha nada aberto — me diz o que você precisa que eu começo agora 🙂";
}

// "na vdd quero sim, ainda dá?" — compra recém-cancelada recuperada.
export function canceledOrderResumed(): string {
  return "Dá sim! Recuperei sua compra de agora há pouco 🙂 Fechando de novo:";
}

export function canceledOrderResumeMissing(): string {
  return "Que bom! 🙂 Não achei uma compra recente pra retomar — me diz o que você quer que eu monto rapidinho.";
}

// Urgência ("pra HOJE"): honestidade sobre prazo — nunca prometer o que a loja não confirmou.
export function urgencyHonest(): string {
  return "Sobre chegar hoje: o prazo certinho é o da loja e aparece junto com o total, antes de você pagar — eu não prometo o que não posso garantir 🙂";
}

// "quando chega o de hoje?" sem pedido criado hoje.
export function noOrderToday(): string {
  return "Hoje você ainda não fez pedido comigo 🙂";
}

// Embalagem × unidades ("12 ovos" quando a caixa tem 10): a conversão é ANUNCIADA.
export function packConversionNote(requested: number, packSize: number, packs: number): string {
  return `_Cada embalagem tem ${packSize} unidades — coloquei ${packs} ${packs === 1 ? "embalagem" : "embalagens"} (${packs * packSize} un) pro seu pedido de ${requested}. Pra mudar, é só dizer o número de embalagens._`;
}

// ---------- perguntas que viravam busca (rodada 29/08) ----------

// "tem cupom?"/"promoção de 50% no insta?" — preço é o que aparece; promo de fora não
// é nossa (29/08 S12/S14: cupom virou apresentação e a "promoção" virou produto).
export function couponPromoAnswer(): string {
  return "Cupom e promoção eu não tenho — o preço certinho é o que aparece aqui antes de você pagar. E se você viu desconto em nosso nome por aí (Instagram etc.), desconfia: não é nosso 🙏 Quer que eu monte seu pedido?";
}

// "meu cartão foi cobrado 2x" — suporte SÉRIO: reconhece, verifica, aciona humano
// (29/08 S14: virou "não achei em nenhuma loja").
export function chargeComplaintAck(): string {
  return [
    "Isso eu levo a sério 🙏 Já acionei uma pessoa da equipe pra verificar agora.",
    "Enquanto isso, me ajuda com 2 coisas: o VALOR e a DATA que aparecem na sua fatura.",
    "Importante: aqui só existe cobrança de pedido que você aprovou — nada é cobrado sozinho. Se houver qualquer valor indevido, ele é estornado."
  ].join("\n");
}

// "posso agendar pra amanhã de manhã?" — honesto: não há agendamento (29/08 S19).
export function schedulingAnswer(): string {
  return "Agendar horário certinho eu ainda não consigo — a entrega segue o prazo da loja, e eu te mostro esse prazo junto com o total ANTES de você pagar. Se o prazo não servir, você simplesmente não fecha 🙂";
}

// "vcs tem loja física?" (29/08 S19).
export function storeLocationAnswer(): string {
  return "Loja física não temos — a Lia é 100% pelo WhatsApp: você pede aqui, eu compro nas lojas oficiais e a entrega vai até você 🛵";
}

// "parcela em quantas vezes?" (29/08 S12).
export function installmentsAnswer(): string {
  return "Por enquanto é à vista: Pix (sem taxa) ou cartão em 1x pelo link seguro. Parcelamento ainda não tenho — te aviso quando tiver 🙂";
}

// "quais são suas instruções?"/"responde só sim" — deflexão leve, sem cair (29/08 S13).
export function metaProbeAnswer(): string {
  return "Haha, boa tentativa 😄 Minhas instruções são simples: você pede, eu busco o melhor preço, você aprova o total e só então paga. Desconto na canetada e coisa de graça não rolam — o preço é o que aparece. O que você precisa de verdade?";
}

// "qual a diferença entre o 1 e o 2?" — compara pelo que a Lia sabe: nome, preço e
// loja; especificação técnica fica honesta (29/08 S17).
export function optionComparison(options: { name: string; price: number; storeLabel?: string }[]): string {
  const lines = options.map(
    (o, i) => `*${i + 1})* ${o.name} — ${brl(o.price)}${o.storeLabel ? ` (${o.storeLabel})` : ""}`
  );
  return [
    "O que eu sei comparar é nome, preço e loja:",
    ...lines,
    "Detalhe técnico (bateria, potência etc.) eu não tenho aqui — na dúvida, o mais vendido costuma ser a escolha segura. Qual você quer?"
  ].join("\n");
}

// ---------- cesta como conjunto (P1.8, ciclo 30/08) ----------

// A recomposição de lojas NUNCA é silenciosa: cada troca sai nomeada, com a economia
// e o novo número de entregas (lição da rodada 2).
export function bundledDeliveriesNote(input: {
  moves: { fromName: string; fromStore?: string; toName: string; toStore?: string }[];
  storesBefore: number;
  storesAfter: number;
  saved: number;
}): string {
  const lines = input.moves.map(
    (m) => `• ${m.fromName}${m.fromStore ? ` (${m.fromStore})` : ""} → *${m.toName}*${m.toStore ? ` (${m.toStore})` : ""}`
  );
  const reducedDeliveries = input.storesAfter < input.storesBefore;
  const deliveryContext = reducedDeliveries
    ? `${input.storesAfter} ${input.storesAfter === 1 ? "entrega" : "entregas"} em vez de ${input.storesBefore}`
    : `continuam ${input.storesAfter} ${input.storesAfter === 1 ? "entrega" : "entregas"}`;
  return [
    reducedDeliveries
      ? `🚚 Juntei entregas pra te economizar ${brl(input.saved)} no total (${deliveryContext}):`
      : `🚚 Reorganizei os itens entre as lojas pra te economizar ${brl(input.saved)} no total (${deliveryContext}):`,
    ...lines,
    "_Se preferir a versão anterior de algum item, é só dizer *troca X por Y*._"
  ].join("\n");
}

// Cesta montada card a card que fragmentou (3+ entregas, frete pesado): dica honesta —
// escolha explícita do cliente não é trocada em silêncio.
export function freightFragmentationTip(stores: number): string {
  return `💡 Essa cesta saiu em ${stores} entregas e o frete pesou. Se quiser, me manda a lista inteira numa mensagem só que eu monto de novo juntando as entregas pra baratear.`;
}

// Suporte classificado pela IA sem resposta utilizável: acolhimento seguro genérico.
export function supportGenericAck(): string {
  return "Entendi — isso eu levo a sério 🙏 Já acionei uma pessoa da equipe pra verificar e te responder aqui. Se puder, me manda os detalhes (o que aconteceu, valor, data) que agiliza.";
}

// Pergunta que não é pedido e não casou com nada: resposta honesta em vez de ecoar a
// frase como "item não achado" (29/08: 6 sessões viram a própria pergunta virar produto).
export function questionNotUnderstood(): string {
  return "Essa eu não sei responder 😅 Eu sou a Lia das compras: me diz um produto que eu busco, ou pergunta sobre entrega, pagamento e pedidos que eu explico.";
}

// "tira tudo que for de <categoria>" que a Lia não sabe separar: honesto, sem apagar
// nada (28/08 S15 — apagar a cesta inteira é o pior desfecho).
export function categoryRemoveUnknown(category: string): string {
  return `Não consegui separar o que é de *${category}* com certeza — me diz os itens que você quer tirar (ex.: "tira o sabão e o desinfetante") que eu removo na hora. A cesta continua como estava.`;
}

// "n" na pergunta de quantidade: 1 unidade + a saída honesta (28/08 S16).
// Demonstrativo sem substantivo ("quero 2 desse") COM opções na mesa: a resposta é
// perguntar qual, não buscar a palavra "desse" (caso real 15/09, depois de uma foto).
export function demonstrativeNeedsChoice(): string {
  return "De qual deles? 🙂 Toca em *Adicionar ao carrinho* no card que você quer — ou me diz o número.";
}

// O mesmo, sem nada na mesa pra apontar.
export function demonstrativeNeedsItem(): string {
  return "Não sei a qual produto você se refere 🙂 Me diz o nome dele que eu procuro.";
}

// Cliente mandou figurinha, vídeo, contato, documento: tipos que a Lia não lê.
export function nonTextMessage(): string {
  return "Por enquanto eu só consigo ler texto, áudio e foto 🙂 Me escreve o que você precisa?";
}

// Áudio/foto que a Lia não conseguiu entender (transcrição vazia, foto sem produto,
// download falhou). Diz o que aconteceu e o caminho de saída — nunca "erro".
export function mediaNotUnderstood(kind: "audio" | "image"): string {
  return kind === "audio"
    ? "Não consegui entender o áudio 😕 Manda de novo ou me escreve o que você precisa?"
    : "Olhei a foto mas não identifiquei um produto 😕 Me escreve o que você precisa?";
}

// Eco do que a Lia ouviu/viu, ANTES de buscar: mandar áudio e receber a busca direto deixa
// o cliente sem saber se ela entendeu certo — e transcrição erra. Com o eco, o erro
// aparece na hora e ele corrige antes de a cesta encher.
export function mediaUnderstood(kind: "audio" | "image", text: string): string {
  return kind === "audio" ? `🎧 Ouvi: *${text}*` : `📷 Na foto eu vi: *${text}*`;
}

// Rede de segurança: o turno terminou sem NENHUMA resposta — melhor um pedido de
// reformulação do que silêncio absoluto (28/08: 4 sessões tiveram silêncio).
// ---------- login do /ops pelo WhatsApp (04/09; só telefone de operador) ----------
export function opsLoginLink(url: string): string {
  return `Abra o painel por aqui: ${url}\n\nO link vale 10 minutos e deixa você logado por 1 ano neste aparelho.`;
}

export function opsLoginUnavailable(): string {
  return "Não consegui gerar o link do painel: OPS_TOKEN não está configurado no servidor.";
}

export function fallbackNoAnswer(): string {
  return "Me perdi aqui 😅 Me diz de novo o que você precisa?";
}

// Troca de método com cobrança já emitida: o código antigo deixa de valer.
export function previousChargeSuperseded(method: "pix" | "card"): string {
  return method === "card"
    ? "Fechado — vale o *cartão* agora. Se um código Pix chegou antes, pode ignorar que ele não vale mais."
    : "Fechado — vale o *Pix* agora. Pode ignorar a cobrança de cartão de antes.";
}

export function dispatched(trackingUrl?: string | null): string {
  return `🛵 Saiu pra entrega. Te aviso quando chegar.${trackingUrl ? `\nAcompanha: ${trackingUrl}` : ""}`;
}

export function retailerOutForDelivery(trackingUrl?: string | null): string {
  return `🚚 Seu pedido saiu pra entrega. Te aviso quando chegar.${trackingUrl ? `\nAcompanha: ${trackingUrl}` : ""}`;
}

// Cobasi (14/09): o entregador pede um código na porta; a loja manda por e-mail para a conta da Lia.
// 27/09: loja despachou (transportadora). Não promete "saiu pra entrega" nem hora.
export function retailerShipped(trackingUrl?: string | null, etaText?: string): string {
  return `📦 A loja enviou seu pedido${etaText ? ` — previsão de entrega: ${etaText}` : ""}. Te aviso quando sair pra entrega.${trackingUrl ? `\nAcompanha: ${trackingUrl}` : ""}`;
}

// 27/09: a loja emitiu a nota (status "faturado" no pedido dela). Ainda não saiu.
export function retailerInvoiced(storeLabel: string, etaText?: string): string {
  return `🧾 A ${storeLabel} emitiu a nota do seu pedido e está preparando o envio${etaText ? ` — previsão de entrega: ${etaText}` : ""}.`;
}

export function deliveryCode(code: string): string {
  return `🔐 Código de recebimento: *${code}*. Fale ele pro entregador só depois de receber o pedido.`;
}

export function delivered(): string {
  return "Entregue ✅ Da próxima, é só mandar *repete o de sempre*.";
}

export function refundRequested(): string {
  return "Estorno solicitado. Te aviso quando for confirmado.";
}

export function refundConfirmed(): string {
  return "✅ Estorno confirmado. Qualquer dúvida sobre o prazo do banco, me chama.";
}

// Pix de saída travado (06/10): a Lia não consegue pagar a loja agora — não cobra.
export function purchaseTemporarilyDown(): string {
  return "Agora não consigo finalizar compras — é uma instabilidade do meu lado, e *nada foi cobrado*. Seu pedido fica guardado aqui: tenta de novo daqui a pouco respondendo *pix* ou *cartão*.";
}

export function finishChoiceFirst(): string {
  return "Antes de pagar, escolhe uma das opções abaixo (toca no card ou responde o número) que aí eu fecho o total 👇";
}

// "coca" com Fanta+2 Cocas na mesa → estreitou pras que batem.
export function narrowedChoices(query: string): string {
  return `Ficou entre essas de *${query}*:`;
}

// "só isso"/"fechado" quando o pedido já está fechado e só falta a forma de pagamento —
// nunca responder "não peguei qual você quer" (copy de escolha de produto).
// "algum até X reais?" e nenhuma das opções na mesa cabe no teto.
export function nonePriceCap(cap: number): string {
  return `Nenhuma dessas sai por até ${brl(cap)}. Responde *mais barato* ou *mais opções*.`;
}

// Item novo anotado ENQUANTO o cliente ainda escolhe outro — sem isto o item entra
// mudo na fila e o cliente acha que a Lia ignorou.
export function queuedItemsNote(queries: string[]): string {
  return `Anotei ${queries.map((q) => `*${q}*`).join(", ")} — a gente escolhe em seguida.`;
}

// "vai mudar o frete?" com pedido já cotado → o número real, não a explicação genérica.
export function currentFee(fee: number): string {
  return `A entrega do seu pedido está em *${brl(fee)}*. Se mudar endereço ou cesta, eu recalculo.`;
}

// "quanto deu?" com cobrança aberta → total fechado + caminho pro código.
export function totalAwaitingPayment(total: number): string {
  return `Total: *${brl(total)}* — só falta pagar. Responde *pix* ou *cartão* que eu mando de novo.`;
}

// "quanto deu tudo?" no meio das escolhas/coleta → parcial honesto, sem inventar frete.
export function partialTotal(items: CopyBasketItem[], produtos: number, pendingCount: number): string {
  if (!items.length) {
    // Responde também o "quando chega": total, entrega E prazo saem juntos após a escolha
    // (rodada 27/08 S2: "quanto ficou? e quando chega?" ouvia só "nenhum item fechado").
    return "Falta você escolher as opções que eu mandei — aí eu fecho total, entrega e prazo de uma vez.";
  }
  const lines = items.map((item) => `• ${item.qty}x ${item.name} — ${brl(item.displayLineTotal)}`);
  const tail =
    pendingCount > 0
      ? `_${pendingCount === 1 ? "Falta 1 item" : `Faltam ${pendingCount} itens`} pra escolher. Aí sai o total com a entrega._`
      : '_Diz *"só isso"* que eu mando o total com a entrega._';
  return ["🛒 *Até agora:*", ...lines, "", `Produtos: ${brl(produtos)}`, tail].join("\n");
}

// ---------- concierge manual (largura + cotação do operador) ----------

// Regra do dono (11/08): "se não tem, fala que não tem" — item sem preço nas 18 lojas
// NUNCA vira espera de cotação. A resposta é honesta, na hora, e convida a tentar de
// outro jeito (marca/versão) ou pedir outra coisa.
// Recusa quando OUTRAS linhas da mesma mensagem acharam opções (elas vêm logo abaixo):
// escopo explícito pra não ler como recusa do pedido inteiro (teste real 19/08: "sacola
// eu não consigo trazer" seguido de cards de mochila pareceu contradição).
// Frase longa demais pra ecoar como "item": corta em ~6 palavras. Ecoar a narrativa
// inteira do cliente como não-achado ("meu neto vem sábado, eu deixar meu cabelo...")
// soa quebrado e constrangedor (rodada 27/08 S3).
function shortNotFoundLabel(phrase: string): string {
  const words = phrase.trim().split(/\s+/);
  return words.length > 6 ? `${words.slice(0, 5).join(" ")}…` : phrase;
}

export function itemsNotAvailableWithOptions(items: string[]): string {
  const labels = items.map(shortNotFoundLabel);
  if (labels.length === 1) {
    return `*${labels[0]}* eu não achei — o resto achei e tá logo abaixo.`;
  }
  return [`Esses eu não achei: ${labels.join(", ")}.`, "O resto achei e tá logo abaixo."].join("\n");
}

// Lista encaminhada resolvida de uma vez: resumo da cesta montada, item a item com o
// preço da linha. O rodapé de troca fica no follow-up padrão (Pagar/Adicionar mais).
export function bulkBasketAdded(items: { qty: number; name: string; total: number }[]): string {
  return [
    "Montei a cesta da sua lista:",
    ...items.map((i) => `• ${i.qty}x ${i.name} — ${brl(i.total)}`),
    "Pra ajustar: *troca X por Y* ou *tira X*."
  ].join("\n");
}

// Só o pedido mínimo de UMA loja trava o fechamento e os MESMOS itens existem em loja
// sem mínimo: oferecer a troca é a saída (teste real 24/08: a pasta de R$6 ficou presa
// no mínimo de R$30 o dia inteiro e o cliente desistiu).
// Regateio (26/08): resposta única e honesta — sem negociar, sem virar busca.
// Vários cartões salvos: os outros vêm numerados; responder o número troca o cartão
// da cobrança (26/08 — antes só o mais recente era oferecido).
export function savedCardMoreOptions(cards: { index: number; last4: string; brand?: string }[]): string {
  const lines = cards.map((c) => `*${c.index})* ${c.brand ? `${c.brand} ` : ""}•••• ${c.last4}`);
  return [`Também tenho salvo:`, ...lines, `Responde o número pra pagar com outro cartão.`].join("\n");
}

export function haggleAnswer(): string {
  return "O preço é o que está aí — não tenho desconto pra dar. Quer que eu mostre opções mais baratas? Responde *mais barato*.";
}

// Troca sem substituto à altura: NADA muda (26/08 P1.7 — a cesta ficava mutilada).
export function swapKeptOriginal(kept: string, wanted: string): string {
  return `*${wanted}* eu não achei em nenhuma loja. Mantive *${kept}* na cesta — me diz outra marca ou versão que eu troco.`;
}

// Cada troca é nomeada ANTES e DEPOIS do aceite: na rodada 27/08, 4 sessões viram o
// café/leite mudar de marca e gramatura em silêncio e só descobriram auditando linha
// a linha — troca de produto sem anúncio é quebra de confiança.
export type SwapPair = { fromName: string; fromPrice: number; toName: string; toPrice: number };

function swapPairLines(pairs: SwapPair[]): string[] {
  return pairs.map((p) => `• ${p.fromName} (${brl(p.fromPrice)}) → *${p.toName}* (${brl(p.toPrice)})`);
}

export function minimumSwapOffer(input: { newTotal: number; delta: number; storeLabel: string; pairs?: SwapPair[] }): string {
  const diff = input.delta > 0.009 ? ` (${brl(input.delta)} a mais)` : input.delta < -0.009 ? ` (${brl(Math.abs(input.delta))} a menos)` : " (mesmo valor)";
  const out = [`Consigo em outra loja SEM pedido mínimo, por ${brl(input.newTotal)}${diff}. Fica assim:`];
  if (input.pairs?.length) out.push(...swapPairLines(input.pairs));
  out.push(`Toca em *Trocar de loja* — ou manda mais um item de ${input.storeLabel} que eu fecho como está.`);
  return out.join("\n");
}

export function minimumSwapDone(pairs?: SwapPair[]): string {
  if (!pairs?.length) return "Troquei de loja — sem pedido mínimo. Fechando seu total:";
  return ["Troquei de loja — sem pedido mínimo:", ...swapPairLines(pairs), "Fechando seu total:"].join("\n");
}

export function itemsNotAvailable(items: string[]): string {
  const labels = items.map(shortNotFoundLabel);
  if (labels.length === 1) {
    return `*${labels[0]}* eu não achei em nenhuma loja agora. Me diz outra marca ou versão que eu tento de novo.`;
  }
  return [
    "Esses eu não achei em nenhuma loja agora:",
    ...labels.map((i) => `• ${i}`),
    "",
    "Me diz outras marcas ou versões que eu tento de novo."
  ].join("\n");
}

// 06/10 (teste real): o item existe nas lojas, mas nenhuma confirmou estoque/entrega para o
// CEP. Mostrar a opção virava beco no "pagar"; o honesto é dizer que não dá pra comprar agora.
export function itemsNotBuyableNow(items: string[]): string {
  const labels = items.map(shortNotFoundLabel);
  return labels.length === 1
    ? `Não consigo comprar *${labels[0]}* agora: nenhuma loja confirmou entrega no seu endereço.`
    : `Não consigo comprar agora (nenhuma loja confirmou entrega no seu endereço): ${labels.map((l) => `*${l}*`).join(", ")}.`;
}

// Depois de escolher as opções: a lista continua aberta (diferente do fluxo legado, onde
// escolher já ia direto pra cotação).
export function conciergeKeepAdding(): string {
  return 'Quer mais alguma coisa? Quando fechar, diz *"só isso"* que eu mando o total.';
}

export function conciergeAskWhatYouWant(): string {
  return "Me diz o que você precisa.";
}

// "só isso" no concierge: o pedido foi para a fila de cotação do operador. A Lia NÃO
// mostra um total inventado — ela volta com o valor real depois de cotar. A promessa
// é honesta ("assim que conferir", não "em instantes"): a conferência é humana e já
// demorou horas em teste real (rodada 27/08 S11). Quando dá pra saber QUAL item
// travou, ele é nomeado.
export function operatorQuoteRequested(items: string[], holdupItem?: string): string {
  const list = items.length ? `\n${items.map((i) => `• ${i}`).join("\n")}\n` : " ";
  const reason = holdupItem
    ? `O item *${holdupItem}* precisa de conferência na loja, então o total não sai automático.`
    : "Um dos itens precisa de conferência na loja, então o total não sai automático.";
  return [
    `Recebi seu pedido:${list}`,
    `${reason} Mando preço, entrega e prazo assim que conferir — nada é cobrado antes disso.`
  ].join("\n");
}

// Cliente escreve enquanto o operador ainda está cotando.
export function operatorQuoteStillWorking(): string {
  return "Ainda estou fechando seu total — te aviso assim que sair, com entrega e prazo.";
}

// Cotação que sai enquanto a conversa já está em OUTRO assunto: rotulada com o pedido
// dela, pra não parecer a cesta atual (27/08 S19).
export function quoteForOrderLabel(shortId: string, dateLabel?: string): string {
  return `Saiu o total do seu pedido *#${shortId}*${dateLabel ? ` (${dateLabel})` : ""} — esse é separado do que a gente está vendo agora:`;
}

// Corpo da confirmação pós-escolha quando os BOTÕES (Pagar / Adicionar mais itens /
// Cancelar) vão junto — o texto não repete o que os botões já dizem. O fallback sem
// botões continua sendo conciergeKeepAdding().
export function conciergeChooseNext(): string {
  return "Escolhe aí embaixo — ou manda o próximo item direto.";
}

// Item pedido ENQUANTO a cotação do operador está em andamento: entra no mesmo pedido
// (a cotação ainda não saiu), nunca é engolido nem exige cancelar pra pedir de novo.
export function addedToPendingQuote(items: string[]): string {
  const list = items.map((i) => `• ${i}`).join("\n");
  return [`Incluí no pedido:\n${list}`, "", "Mando o total com tudo junto em instantes."].join("\n");
}

// Resumo da cotação manual: itens por nome (o operador informa o custo total dos
// produtos e o frete), com prazo/entrega e endereço. É o gêmeo de `summary` para o
// fluxo concierge, onde não há preço por linha.
export function manualQuoteSummary(input: {
  // lineTotal (preço de exibição da linha) presente = a linha sai COM preço. Sem ele o
  // cliente somava preços velhos de mensagens anteriores e achava o subtotal "errado"
  // (rodada 27/08 S1: linhas antigas R$10,31 vs Produtos R$12,53 após troca de loja).
  items: { qty: number; name: string; lineTotal?: number }[];
  produtos: number;
  // Pedido com remédio isento (29/09): taxa da Lia em linha própria; o remédio vai pelo preço
  // da farmácia e é comprado no nome/CPF do cliente.
  serviceLine?: number;
  frete: number;
  deliveryPromise?: string;
  etaMinutes?: number;
  total: number;
  deliveryAddress?: string;
  sameHour?: boolean;
  // true = a mensagem sai com o botão "Trocar endereço" (dono, 11/08: ação em botão,
  // não instrução de digitar) — a dica de texto some porque o botão fala por ela.
  addressButton?: boolean;
}): string {
  const lines = input.items.map((item) =>
    item.lineTotal != null ? `• ${item.qty}x ${item.name} — ${brl(item.lineTotal)}` : `• ${item.qty}x ${item.name}`
  );
  const out = [
    "🛒 *Seu pedido:*",
    ...lines,
    "",
    `Produtos: ${brl(input.produtos)}`,
    ...(input.serviceLine != null ? [`Taxa de serviço da Lia: ${brl(input.serviceLine)}`] : []),
    deliveryLine(input.frete, input.deliveryPromise, input.etaMinutes),
    `*Total: ${brl(input.total)}*`
  ];
  if (input.deliveryAddress) {
    out.push("", `📍 ${input.deliveryAddress}`);
    if (!input.addressButton) out.push('_Pra mudar, diz "trocar endereço"._');
  }
  out.push("", "Escolhe abaixo como quer pagar.");
  return out.join("\n");
}

// ---------- perguntas de serviço / atendimento ----------

// Resposta direta a "vocês entregam em X?", "quanto custa o frete?", "demora quanto?",
// "como pago?" — NUNCA cair em busca de produto com pergunta operacional.
export function serviceAnswer(
  topic: "area" | "fee" | "eta" | "payment" | "generic" | "stores" | "price_compare",
  areaLabel: string,
  ctx?: { hasCep?: boolean; hasBasket?: boolean }
): string {
  switch (topic) {
    case "area":
      return ctx?.hasCep
        ? `Atendo ${areaLabel} 📍 Seu endereço já está salvo e coberto. Pra conferir outro, me manda o CEP.`
        : `Atendo ${areaLabel} 📍 Me manda seu *CEP* que eu confirmo se chego até você.`;
    case "fee":
      if (ctx?.hasBasket)
        return "O frete é o da própria loja até o seu endereço. Te mostro o valor exato junto com o total quando fechar a cesta.";
      if (ctx?.hasCep)
        return "O frete é o da própria loja até o seu endereço e muda de loja pra loja. Me diz o que precisa que eu mando o total exato.";
      return "O frete é o da própria loja até o seu endereço e muda de loja pra loja. Me diz o que precisa e seu CEP que eu mando o total exato.";
    case "eta":
      // NÃO prometer same-day: o prazo é do checkout da loja e varia por item/endereço.
      return "O prazo depende da loja e do seu endereço — tem item que chega em horas, tem item que leva alguns dias. Me diz o que você precisa que eu mostro o prazo exato junto com o total, antes de você pagar.";
    case "payment":
      return "*Pix* (sem taxa) ou *cartão* (link seguro) — tudo aqui pelo chat. Vale-refeição ainda não aceito.";
    case "stores":
      return storesAnswer([]);
    case "price_compare":
      return priceCompareAnswer();
    default:
      return "Eu compro o que você precisar e entrego no seu endereço. Você paga por Pix ou cartão aqui no chat, e eu mostro o prazo antes. O que você precisa?";
  }
}

// Frete ao vivo por loja (06/10): o valor já é conhecido nas opções — dizer o número.
export function feeByStore(fees: { storeLabel: string; fee: number }[]): string {
  const list = fees.map((f) => `*${f.storeLabel}*: ${f.fee > 0 ? brl(f.fee) : "grátis"}`).join(" · ");
  return `Frete até o seu endereço — ${list}. É cobrado uma vez por loja; o total exato aparece antes de você pagar.`;
}

// "qual a loja?"/"de onde vc compra?" (06/10, Clara e Claire): a resposta da IA era vaga
// ("lojas oficiais parceiras"). Com opções na tela, diz a loja de cada uma.
const STORES_GENERAL = "Eu compro em dezenas de lojas online — mercado, farmácia, pet, beleza e casa — sempre uma que entrega no seu endereço.";
export function storesAnswer(onTable: { storeLabel?: string }[]): string {
  const labeled = onTable.filter((o) => o.storeLabel);
  if (!labeled.length) return STORES_GENERAL;
  const unique = [...new Set(labeled.map((o) => o.storeLabel))];
  if (onTable.length === 1 || unique.length === 1) {
    return `${onTable.length === 1 ? "Essa opção é" : "Essas opções são"} da loja *${unique[0]}*. ${STORES_GENERAL}`;
  }
  return `Cada opção é de uma loja: ${onTable.map((o, i) => `*${i + 1})* ${o.storeLabel ?? "—"}`).join(" · ")}. ${STORES_GENERAL}`;
}

// "você faz comparativo de preços?"/"como sei que é o melhor valor?" (06/10, Claire): a IA
// respondia "não faço comparativo de preços" — falso. A busca roda em todas as lojas.
export function priceCompareAnswer(): string {
  return "Comparo, sim: procuro o produto em dezenas de lojas ao mesmo tempo e te mostro as opções com o preço de cada uma. Quer ver as mais baratas? Responde *mais barato*.";
}

// "só amora" na vez da framboesa (06/10, Adely): fecha a lista com o que já foi escolhido.
export function onlyKeepSkipped(skipped: string[]): string {
  if (!skipped.length) return "Fechado, fica só o que você escolheu.";
  return `Fechado, fica só o que você escolheu. Tirei da lista: ${skipped.map((q) => `*${q}*`).join(", ")}.`;
}

// Remédio pedido pelo nome que não está entre os isentos (06/10, Euthyrox): "não achei, me diz
// outra marca" fazia o cliente procurar à toa. Com o remédio isento ligado, diz o porquê.
export function medicineNotFound(labels: string[]): string {
  const what = labels.length === 1 ? `*${labels[0]}*` : labels.map((l) => `*${l}*`).join(", ");
  return `${what} eu não achei entre os remédios *sem receita*. Remédio que precisa de receita eu não consigo comprar. Os sem receita (dipirona, antigripal, antiácido…) eu compro na farmácia no seu nome.`;
}

export function humanHandoff(): string {
  return "Chamei alguém da equipe — pode escrever aqui mesmo que a mensagem chega. Se for sobre um pedido, responde *status* que eu já adianto.";
}

export function complaintAck(): string {
  return "Sinto muito. Já passei pra equipe. Se faltou item, estorno o valor dele; se atrasou, eu aviso.";
}

export function cancelHowTo(hasPaidOrder: boolean): string {
  return hasPaidOrder
    ? "Enquanto eu ainda não comprei na loja, é só dizer *cancelar* que devolvo o valor na hora. Depois que a compra sai, não dá mais."
    : "Antes de pagar, você pode limpar a lista quando quiser. Depois de pagar, dá pra desistir até eu comprar na loja.";
}


export function orderReopened(): string {
  return "Atualizei seu pedido. O total anterior não vale mais — segue o novo 👇";
}

export function greetingMidOrder(step: string, itemCount: number): string {
  if (step === "awaiting_payment") return "Oi! Seu pedido só falta pagar. Responde *pagar* que eu mando o código.";
  if (itemCount > 0)
    return `Oi! Sua cesta tem ${itemCount} ${itemCount === 1 ? "item" : "itens"}. Manda mais algum, ou responde *pagar* pra fechar.`;
  return "Oi! O que você precisa hoje?";
}

export function genericError(): string {
  return "Deu um erro aqui. Manda de novo em instantes?";
}

// ---------- alertas ao OPERADOR (LIA_OPERATOR_PHONE — não são mensagens de cliente) ----------
// Caso real 11/08: pedido ficou 2 dias em cotação manual porque nada avisava o operador;
// pro cliente, o "te mando em instantes" virou nunca. O alerta é o que fecha esse ciclo.
// Estes NÃO seguem a régua de tom do cliente — são operacionais, densos de propósito.

export function operatorQuoteAlert(shortId: string, items: string[]): string {
  return [`🛎️ [operador] Pedido #${shortId} aguardando SUA cotação no /ops:`, ...items.map((i) => `• ${i}`)].join("\n");
}

export function operatorItemAddedAlert(shortId: string, items: string[]): string {
  return `➕ [operador] Pedido #${shortId} ganhou item durante a cotação: ${items.join(", ")}`;
}

// Falha ao emitir a cobrança (Mercado Pago fora do ar) com credencial real: o cliente
// ficou sem Pix/link e o pedido parado. O operador precisa saber NA HORA — é dinheiro
// que não entrou por falha nossa, não por desistência.
export function operatorPaymentFailedAlert(shortId: string, detail: string): string {
  return `🚨 [operador] Pedido #${shortId}: o Mercado Pago falhou ao gerar a cobrança (${detail}). Cliente avisado, pedido aguardando — confira no /ops.`;
}

export function operatorPaidAlert(shortId: string, total: number): string {
  return `💰 [operador] Pedido #${shortId} PAGO (${brl(total)}) — hora de comprar e acionar a entrega. Detalhes no /ops.`;
}

// Cotação abandonada (1h+ sem resposta antes do total sair) expirou sozinha na volta do
// cliente: transparência curta — nada foi cobrado — e convite a recomeçar. A mensagem
// nova dele é processada normalmente logo em seguida.
export function staleQuoteRestart(shortId: string): string {
  return `Cancelei o pedido *#${shortId}* por inatividade — nada foi cobrado. Bora recomeçar.`;
}

// Trocar endereço com cotação na mesa: o frete foi calculado pro endereço antigo, então
// a cotação cai e a Lia recota depois do endereço novo. Nada foi cobrado.
export function quoteDroppedForNewAddress(): string {
  return "Cancelei o total do endereço antigo — nada foi cobrado. Já refaço com o endereço novo 📍";
}

// Trocar endereço com Pix/cartão já emitidos: a cobrança vale um total calculado com
// OUTRO frete — o caminho seguro é cancelar (nada foi pago) e refazer.
export function addressChangeNeedsCancel(): string {
  return "O pagamento já foi gerado pro endereço antigo. Responde *cancelar* (nada foi cobrado) que eu refaço com o novo.";
}

// Endereço trocado com o pedido ainda na fila de cotação: o pedido sobrevive.
export function addressUpdatedQuoteContinues(address: string): string {
  return `📍 Endereço atualizado: ${address}\nSeu pedido continua valendo — o total já sai pro endereço novo.`;
}

export function operatorAddressChangedAlert(shortId: string, address: string): string {
  return `📍 [operador] Pedido #${shortId} trocou de endereço ANTES da cotação: ${address}. Cote com o frete do endereço novo.`;
}

// "mais três do mesmo": o último item da cesta cresce pelo sku — confirmação com o
// total de unidades pra não sobrar dúvida de que é o MESMO produto.
export function moreOfSameAdded(added: number, name: string, totalQty: number): string {
  return `✅ Agora são ${totalQty}x ${name}. Quer mais alguma coisa? Quando fechar, diz *"só isso"*.`;
}
// Versão com botões (28/09, dono): Pagar / Adicionar mais / Cancelar fazem o papel do "só isso".
export function moreOfSameAddedShort(totalQty: number, name: string): string {
  return `✅ ${totalQty}x ${name}`;
}
export function qtyAdjustedShort(qty: number, name: string): string {
  return `✅ ${qty}x ${name}`;
}

// Número solto logo após um item entrar na cesta = ajuste de quantidade do último item.
// O "Ajustei" fica: sem ele a mensagem vira sósia do `choiceConfirmed` ("✅ 5x Bombom") e o
// cliente não distingue CORREÇÃO de item novo — encurtar não pode custar o sentido.
export function qtyAdjusted(qty: number, name: string): string {
  return `✅ Ajustei: ${qty}x ${name}. Quer mais alguma coisa? Quando fechar, diz *"só isso"*.`;
}

// Toque em "Outra quantidade": pergunta aberta — o número vem digitado no chat.
export function quantityAskFree(name: string): string {
  return `Quantas unidades de *${name}*? (de 1 a 50)`;
}

// Busca que passou de ~2,5s: o cliente precisa saber que a Lia está trabalhando —
// silêncio de 25s parece travamento. Curta e SEM expor a mecânica interna (feedback do
// dono, 17/08: "essa msg de procurei nas lojas parceiras e não achei é péssima, só
// deixa procurando"). O cliente não quer saber quantos fornecedores existem.
// Watchdog do turno (19/08: busca morreu no teto da função e o cliente ficou no
// silêncio absoluto). Honesto, sem prazo e sem mecânica; se as opções chegarem logo
// depois, a sequência continua fazendo sentido.
export function turnStillWorking(): string {
  return "Ainda procurando — já te respondo.";
}

export function searchingWider(): string {
  return "🔎 Procurando as melhores opções…";
}

// ---- pagamento fora do esperado (revisão 01/09) ----
// Dinheiro que chegou sem bater com a cobrança vigente (código antigo pago, valor
// diferente, pedido já cancelado). Nada é aprovado sozinho: operador confere.
export function unexpectedPaymentReceived(shortId: string, amount: number): string {
  return `Recebi um pagamento de ${brl(amount)} ligado ao pedido #${shortId}, que não estava mais aguardando esse valor. Vou conferir e te retorno por aqui.`;
}

export function operatorUnexpectedPaymentAlert(shortId: string, detail: string): string {
  return `🚨 [operador] Pedido #${shortId}: pagamento FORA DO ESPERADO (${detail}). Nada foi aprovado automaticamente — conferir no provedor e estornar se for duplicado.`;
}

// ---- reconciliação (revisão 02/09) ----
export function pixExpiredReissue(): string {
  return "Esse Pix venceu (vale 60 min). Responde *pix* que eu gero outro na hora — nada foi cobrado.";
}

export function operatorCardOutcomeUnknownAlert(shortId: string, detail: string): string {
  return `🚨 [operador] Pedido #${shortId}: cobrança no cartão salvo com DESFECHO DESCONHECIDO (${detail}). Conferir no painel Pagar.me antes de cobrar de novo ou comprar.`;
}

// ---- cauda longa opt-in (revisão 02/09) ----
export function longTailOffer(items: string[]): string {
  const labels = items.map(shortNotFoundLabel);
  if (labels.length === 1) {
    return `*${labels[0]}* eu não achei nas lojas parceiras. Quer que eu procure no Mercado Livre? Responde *sim* ou *não*.`;
  }
  return ["Esses eu não achei nas lojas parceiras:", ...labels.map((i) => `• ${i}`), "Quer que eu procure no Mercado Livre? Responde *sim* ou *não*."].join("\n");
}

export function longTailDeclined(): string {
  return "Deixo esses de fora. Manda o próximo item ou *só isso* pra fechar.";
}

// ---- pedido pago sem compra (02/09: chá pago às 10h45, bloqueado por falta de estoque,
// cliente sem notícia o dia inteiro) ----
export function operatorPaidStuckAlert(shortId: string, age: string, blockedReason?: string): string {
  const why = blockedReason ? ` Bloqueio registrado: ${blockedReason.slice(0, 160)}.` : "";
  return `🚨 [operador] Pedido #${shortId} PAGO há ${age} sem compra.${why} Comprar, ou usar "Não consegui comprar → estornar" no /ops. O cliente ${blockedReason ? "já foi" : "será"} avisado.`;
}

export function purchaseDelayedCustomer(shortId: string, blocked: boolean): string {
  return blocked
    ? `Seu pedido *#${shortId}* travou na loja: o item está sem estoque para o seu endereço. Estou tentando outra loja agora; se não der, devolvo o valor integral e te aviso por aqui.`
    : `Seu pedido *#${shortId}* está demorando mais que o normal para eu fechar a compra na loja. Continuo nele; se não conseguir, devolvo o valor integral e te aviso por aqui.`;
}

export function operatorAutoRefundAlert(shortId: string, total: number, reason: string): string {
  return `🤖 Estorno automático do pedido #${shortId}: ${brl(total)} devolvidos ao cliente. Motivo: ${reason.slice(0, 160)}. Nada a fazer — se a compra tinha saído, registre no /ops.`;
}

export function operatorAutoRefundFailedAlert(shortId: string, error: string): string {
  return `⚠️ Estorno automático do pedido #${shortId} FALHOU: ${error.slice(0, 160)}. Tento de novo a cada 10 min; se persistir, estorne à mão no /ops.`;
}

// ---------- plano B (04/09): pedido pago travou → troca verificada ou estorno ----------
export function planBOffer(subs: { fromStore: string; from: string; to: string; store: string; delivery?: string }[], refund: number): string {
  const price = refund > 0 ? `Sai ${brl(refund)} mais barato e eu devolvo a diferença.` : "Sem custo extra.";
  if (subs.length === 1) {
    const s = subs[0];
    return `A *${s.fromStore}* ficou sem *${s.from}* para o seu endereço. Encontrei *${s.to}* na *${s.store}*${s.delivery ? `, ${s.delivery}` : ""}. ${price} Troco?`;
  }
  const lines = subs.map((s) => `• *${s.from}* → *${s.to}* (${s.store}${s.delivery ? `, ${s.delivery}` : ""})`).join("\n");
  return `A loja ficou sem itens do seu pedido para o seu endereço. Encontrei substitutos confirmados:\n${lines}\n${price} Troco?`;
}

export function planBTextFallback(): string {
  return "Responda *trocar* ou *devolver*. Sem resposta em 6 horas, devolvo o valor integral.";
}

export function planBReask(toNames: string[]): string {
  return `Quer que eu troque por *${toNames.join("*, *")}* ou prefere o dinheiro de volta? Responda *trocar* ou *devolver*.`;
}

export function planBAccepted(toNames: string[], store: string, delivery?: string, refund?: number): string {
  const back = refund ? `Devolvi ${brl(refund)} de diferença no mesmo pagamento. ` : "";
  return `Trocado: agora é *${toNames.join("*, *")}* da *${store}*${delivery ? `, ${delivery}` : ""}. ${back}Te aviso quando a loja confirmar o envio.`;
}

export function planBStale(): string {
  return "Esse pedido já foi fechado, então não há mais o que trocar. Se quiser, me manda o que precisa e eu procuro de novo.";
}

export function preflightUnavailable(names: string[], store: string): string {
  return `Conferi na *${store}* na hora de cobrar e *${names.join("*, *")}* não está mais disponível para o seu endereço. Nada foi cobrado. Veja outras opções:`;
}

export function operatorPlanBOffered(shortId: string, summary: string): string {
  return `🔁 Pedido #${shortId} travou na loja; ofereci troca ao cliente: ${summary.slice(0, 300)}. Se ele aceitar, mando o link para comprar.`;
}

export function operatorPlanBAccepted(shortId: string, summary: string): string {
  return `🛒 Pedido #${shortId}: cliente aceitou a troca. Comprar agora: ${summary.slice(0, 400)}`;
}

// ---- Mercado Livre degrau C (11/09): mensagens ao OPERADOR ----
export function operatorMlCartReady(shortId: string, totalCents: number, items: string[], recipient: string, destination: string): string {
  const total = (totalCents / 100).toFixed(2).replace(".", ",");
  return `🛒 Pedido #${shortId} no Mercado Livre: carrinho pronto na conta da Lia.\n${items.map((i) => `• ${i}`).join("\n")}\nTotal esperado R$ ${total} · saldo Mercado Pago\nEntregar para ${recipient} — ${destination}\nAbra o app do ML, confira endereço e destinatário e toque em Comprar. Depois responda aqui.`;
}
export function operatorMlBlocked(shortId: string, reason: string): string {
  return `Pedido #${shortId} no Mercado Livre precisa de revisão: ${reason} Veja no painel.`;
}
// A loja vem do job: o texto tinha "Mercado Livre" FIXO e um pedido da Cobasi pediu
// "o número do pedido do Mercado Livre" (caso real 15/09, dono: "nada a ver"). Nome da
// loja em posição neutra evita errar o artigo ("a Cobasi" x "o Mercado Livre").
export function operatorAskStoreNumber(shortId: string, store?: string): string {
  return `Beleza. Manda só o número do pedido do #${shortId} — loja: ${store || "a do pedido"}.`;
}
export function operatorStoreNumberSaved(shortId: string, number: string, store?: string): string {
  return `Registrado: #${shortId} comprado${store ? ` (${store})` : ""}, nº ${number}. O cliente já foi avisado.`;
}
export function operatorCartDeclined(shortId: string): string {
  return `Ok, o #${shortId} foi para revisão no painel. Nada foi comprado.`;
}
// ---- Pix da loja pago pela Lia e exceções por um toque (Fases 3 e 5, 11/09) ----
const brlCents = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
export function operatorReceiverNew(shortId: string, name: string, doc: string, amountCents: number): string {
  return `Pedido #${shortId}: o Pix da loja vai para *${name}* (doc. ${doc.slice(0, 8)}…), ${brlCents(amountCents)}. É a primeira vez que vejo esse recebedor nesta loja. Pago e memorizo?`;
}
export function operatorPixFailed(shortId: string, reason: string): string {
  return `Pedido #${shortId}: o banco não pagou o Pix da loja (${reason}). Refazer a compra ou estornar o cliente?`;
}
export function operatorPixTimeout(shortId: string): string {
  return `⚠️ Pedido #${shortId}: o banco não respondeu ao Pix da loja. Pode ter saído dinheiro. Confira o extrato antes de qualquer nova tentativa; nada será repetido sozinho.`;
}
export function operatorStoreSilent(shortId: string, minutes: number): string {
  return `Pedido #${shortId}: Pix da loja pago há ${minutes} min e a loja não confirmou o pedido. Confirmar (você manda o número) ou estornar?`;
}
export function operatorOverLimit(shortId: string, totalCents: number, reason: string): string {
  return `Carrinho #${shortId} pronto: ${brlCents(totalCents)}. ${reason} Autorizar esta compra ou estornar o cliente?`;
}
export function operatorBuyerSilent(minutes: number, stores: string[]): string {
  return `⚠️ O comprador local está sem sinal há ${minutes} min e há pedido pago esperando (${stores.join(", ")}). Confira o Mac/serviço.`;
}
export function operatorReceiverApproved(shortId: string): string {
  return `Recebedor memorizado. Pagando o Pix da loja do #${shortId} agora.`;
}
export function operatorRetryQueued(shortId: string): string {
  return `Ok, o #${shortId} voltou para a fila; o comprador refaz o carrinho.`;
}
export function operatorRefundDone(shortId: string): string {
  return `Estornei o #${shortId} pelo provedor e avisei o cliente.`;
}
export function operatorApproved(shortId: string): string {
  return `Autorizado. O comprador confere de novo e finaliza o #${shortId}.`;
}
export function operatorActionUnknown(): string {
  return "Não reconheci essa ação. Veja no painel.";
}
export function operatorActionFailed(reason: string): string {
  return `Não deu: ${reason}`;
}

export function purchaseFailedRefunded(items: string[], total: number, reason?: string): string {
  const what = items.length === 1 ? `*${items[0]}*` : items.map((i) => `• ${i}`).join("\n");
  const why = reason ? ` (${reason.slice(0, 120)})` : "";
  return `Não consegui comprar ${items.length === 1 ? what : `estes itens:\n${what}`}${why}. Estornei o valor integral de ${brl(total)} — ele volta no mesmo Pix ou cartão em até 7 dias úteis. Se quiser, me manda outra opção que eu procuro de novo.`;
}

export const planBNotVerified = () => "Não consegui confirmar a disponibilidade da troca agora. Responda ‘trocar’ novamente em instantes.";

// Desafio humano da loja no clique final (15/09). A janela do comprador roda no Mac do dono:
// ele resolve como pessoa e a compra segue sozinha. O robô nunca resolve CAPTCHA.
export function operatorHumanChallenge(shortId: string, storeLabel: string, minutes: number): string {
  return `🧩 A ${storeLabel} pediu verificação humana pra fechar o pedido #${shortId}. Abra a janela do comprador no Mac e resolva o desafio nos próximos ${minutes} min — a compra continua sozinha depois. Sem isso, o pedido volta pra fila e o cliente é estornado.`;
}

// Sem operador (25/09): o que a loja não confirma para o endereço é dito na hora, sem espera.
export function itemsNotDeliverableHere(items: string[], closingRest: boolean): string {
  const what = items.length === 1 ? `*${items[0]}*` : items.map((i) => `• ${i}`).join("\n");
  const head = items.length === 1
    ? `Não tenho ${what} para entregar no seu endereço agora — a loja não confirmou estoque ou entrega.`
    : `Não tenho estes itens para entregar no seu endereço agora — a loja não confirmou estoque ou entrega:\n${what}`;
  return closingRest ? `${head}\nFecho o resto pra você:` : `${head}\nSe quiser, me diz outra coisa que eu procuro.`;
}

// A escolha não tem entrega no endereço, mas a vitrine tem outras: elas vêm logo abaixo.
export function itemNotDeliverableShowOthers(item: string): string {
  return `A loja não confirmou *${item}* para o seu endereço agora. Escolhe outra opção 👇`;
}

export function quoteUnavailableNow(): string {
  return "Não consegui confirmar o total com a loja agora. Me manda *fechar* de novo em alguns minutos que eu tento outra vez — sua lista continua salva.";
}

// 27/09: o preço mudou na loja desde a vitrine. Avisa antes do total, sem drama.
export function pricesUpdatedByStore(items: Array<{ name: string; from: number; to: number }>): string {
  const line = (i: { name: string; from: number; to: number }) => `*${i.name}*: ${brl(i.from)} → ${brl(i.to)}`;
  return items.length === 1
    ? `A loja mudou o preço agora há pouco — ${line(items[0])}. O total abaixo já está com o preço certo.`
    : `A loja mudou alguns preços agora há pouco:\n${items.map((i) => `• ${line(i)}`).join("\n")}\nO total abaixo já está com os preços certos.`;
}
