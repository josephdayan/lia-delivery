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

// Apresentação (07/10, placar: o juiz chamou "me pede qualquer coisa" de promessa ampla — remédio,
// por exemplo, a Lia não compra). Diz o que ela FAZ, sem prometer o que não faz.
const PITCH = "Me diz o que você precisa — eu procuro nas lojas que entregam aí, mostro o total e compro pra você.";

export function greeting(): string {
  return `Oi! Sou a Lia 💚 ${PITCH}`;
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
    "4. Eu compro na loja e acompanho até chegar 📦",
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
const INTRO = `Oi! Sou a Lia. ${PITCH}`;

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

// ---------- cadastro e endereço em texto (06/10, relatório do testador) ----------

// Itens que vieram junto do endereço: aparecem na confirmação pra o cliente ver que não sumiram.
export function notedItemsLine(notedItems: string[]): string {
  return notedItems.length ? `✅ Anotei:\n${notedItems.map((i) => `• ${i}`).join("\n")}` : "";
}

// CEP recebido e a rua veio do ViaCEP: confirma a rua e pede SÓ o número.
export function askHouseNumber(street: string, district: string | undefined, cep: string | undefined): string {
  return `📍 CEP ${cep ?? ""}: *${street}*${district ? `, ${district}` : ""}.\nPra completar o endereço, falta só o *número* (e o complemento, se tiver).`.replace("CEP : ", "");
}

// Pedido do endereço quando ainda não há CEP nenhum (antes era "Falta o endereço: rua, número
// e complemento", que soava como se o cliente tivesse esquecido algo).
export function askAddressWithCep(): string {
  return "Pra eu te atender, me manda seu *endereço com CEP* — rua, número, bairro e cidade 📍";
}

// Rua citada sem número ("moro na rua augusta perto do metrô").
export function askNumberAndCep(hasCep: boolean): string {
  return hasCep ? "Falta o *número* da casa (e o complemento, se tiver) 📍" : "Falta o *número* e o *CEP* 📍";
}

// "quanto tá o leite ninho?" antes do cadastro (M2): o preço depende da loja que entrega no
// endereço — anota e promete o número logo depois.
export function priceAfterAddress(item: string): string {
  return `O preço de *${item}* muda conforme a loja que entrega no seu endereço — anotei e te mostro assim que tiver o CEP 🙂`;
}

export function dontKnowCep(): string {
  return "Sem problema 🙂 Você acha o CEP pelo nome da rua em *buscacep.correios.com.br*. Depois me manda *rua, número e CEP* juntos.";
}

// Cliente com endereço confirmado mandou um CEP solto (A4): pergunta antes de trocar — o
// endereço salvo continua valendo até ele dizer sim.
export function confirmCepSwap(cep: string, place: { street?: string; district?: string; city?: string }, current: string): string {
  const where = [place.street, place.district, place.city].filter(Boolean).join(", ");
  return [
    `Quer trocar o endereço de entrega para o CEP *${cep}*${where ? ` (${where})` : ""}?`,
    `Responde *sim* pra trocar. Se não, sigo com o de sempre: ${current.replace(/[\s.,;]+$/, "")}.`
  ].join("\n");
}

export function keptAddress(address: string, cep?: string): string {
  const clean = address.replace(/[\s.,;]+$/, "");
  return `Ok, continua o mesmo endereço 📍 ${cep && !clean.includes(cep) ? `${clean} — CEP ${cep}` : clean}`;
}

// CEP de uma cidade, endereço escrito com outra (A5): nada é salvo até o cliente confirmar.
export function cepCityMismatch(cep: string, cepCity: string, typedCity: string): string {
  return `Opa, o CEP *${cep}* é de *${cepCity}*, mas no endereço está *${typedCity}* 🤔\nSe o CEP estiver certo, responde *sim*. Se não, me manda o CEP certo.`;
}

export function askRightCep(): string {
  return "Me manda o *CEP certo* (8 números) junto com rua e número 📍";
}

// Fora da área, o cliente insiste com outra coisa (M9): lembra o motivo e mostra a saída.
export function stillOutsideArea(city: string | undefined, areaLabel: string): string {
  // "os estados de São Paulo e Rio de Janeiro" → "São Paulo ou Rio de Janeiro".
  const where = areaLabel.replace(/^os? estados? de /, "").replace(/ e ([^,]+)$/, " ou $1");
  return `Ainda não entrego ${city ? `em ${city}` : "nessa região"} 😔 Se quiser mandar pra alguém em ${where}, me manda o endereço com CEP de lá.`;
}

// Nome e CPF mandados antes do endereço (M11): guardados, e o endereço continua faltando.
export function identitySavedAskAddress(hasCep: boolean): string {
  return `✅ Anotei seu nome e CPF. ${hasCep ? "Falta o *número* da casa (e o complemento, se tiver) 📍" : "Agora seu *endereço com CEP* — rua, número, bairro e cidade 📍"}`;
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
    "Anotei sua cidade: é assim que eu decido onde chego primeiro. Ainda não tenho data nem previsão pra sua região."
  ].join("\n");
}

// Cidade É atendida, mas o endereço ficou longe demais de qualquer loja parceira hoje.
// Cuidado: NÃO dizer "não atendo sua cidade" (atendo!) — é questão de loja perto ainda.
// ---------- search / basket ----------

export function searching(): string {
  return "🔎 Procurando…";
}

// 07/10 (placar c08/c35): sem "fora isso eu trago de tudo" (promessa ampla) e, se o cliente insiste
// ou pergunta de farmácia parceira, a resposta muda — repetir a mesma frase parecia travado.
export function noMedicine(): string {
  return "Remédio eu não posso vender — por lei, só farmácia pode. De mercado, higiene, pet, beleza e casa eu cuido. O que você precisa?";
}

// Cliente se despede depois da recusa de remédio ("vou procurar uma farmácia, obrigada"): fecha sem
// pedir endereço (07/10, c08).
export function medicineFarewell(): string {
  return "Combinado 💚 Se precisar de mercado, higiene, pet, beleza ou casa, é só me chamar.";
}

export function noMedicineAgain(): string {
  return "Sobre remédio a resposta continua a mesma, mesmo com receita: eu não vendo. Se precisar de mercado, higiene, pet, beleza ou casa, é só me dizer.";
}

// "tem alguma farmácia parceira que venda?" (07/10, c35): resposta direta, sem pedir endereço.
export function pharmacyPartnerAnswer(otcEnabled = false): string {
  return otcEnabled
    ? "Os remédios *sem receita* (dipirona, antigripal, antiácido…) eu compro na farmácia no seu nome; os de receita eu não consigo comprar. Pra esses, a farmácia mais perto de você é o caminho."
    : "Não tenho farmácia parceira que venda remédio por mim e também não consigo indicar uma unidade: remédio eu não vendo — por lei, só a farmácia pode. Pra medicação, a farmácia mais perto de você é o caminho. De mercado, higiene, pet, beleza e casa eu cuido — o que você precisa?";
}

export function medicineSkippedNote(): string {
  return "_Remédio eu não posso vender, então deixei ele de fora._";
}

// ---------- remédio isento no CPF do cliente (29/09, LIA_MEDICINE_MIP) ----------

// Pedido de remédio de receita com MIP ligado: recusa só o de receita e diz o que dá.
// Dono (08/10): quando o pedido nomeia o remédio, a recusa diz QUAL não dá e por quê.
const capName = (n: string) => n.charAt(0).toUpperCase() + n.slice(1);
export function prescriptionRefusal(names?: string | string[]): string {
  const list = (Array.isArray(names) ? names : names ? [names] : []).filter(Boolean).map((n) => `*${capName(n)}*`);
  const head = !list.length
    ? "Remédio de receita eu não consigo comprar."
    : list.length === 1
      ? `${list[0]} é remédio de receita, então esse eu não consigo comprar.`
      : `${list.slice(0, -1).join(", ")} e ${list[list.length - 1]} são remédios de receita, então esses eu não consigo comprar.`;
  return `${head} Remédio *sem receita* (dipirona, antigripal, antiácido…) eu compro na farmácia no seu nome. Me diz o nome do que você precisa.`;
}

export function prescriptionSkippedNote(names?: string[]): string {
  const list = (names ?? []).filter(Boolean).map((n) => `*${capName(n)}*`);
  if (!list.length) return "_Remédio de receita eu não consigo comprar, então deixei ele de fora._";
  if (list.length === 1) return `_${list[0]} precisa de receita, então esse eu não consigo comprar — deixei de fora._`;
  return `_${list.slice(0, -1).join(", ")} e ${list[list.length - 1]} precisam de receita, então esses eu não consigo comprar — deixei de fora._`;
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
// Compra e nota no CPF do cliente (08/10, dono) — LIA_CUSTOMER_INVOICE=false volta à nota no nome da
// Lia. Espelha pricing.ts sem importar (copy é pura).
function customerInvoiceMode(): boolean {
  return process.env.LIA_CUSTOMER_INVOICE !== "false";
}

export function whyCpf(): string {
  const why = customerInvoiceMode()
    ? "É pra eu comprar *no seu nome*: a nota fiscal da loja sai no seu CPF (e farmácia exige pra remédio sem receita)."
    : "É pra eu comprar *no seu nome* quando a loja exige — farmácia (remédio sem receita) e nota fiscal no seu CPF.";
  return `${why} Fica guardado só aqui, não uso pra mais nada (${TERMS_URL}).\n\nSe preferir não passar agora, tudo bem: me diz o que você precisa. Se quiser passar, manda assim: _Maria da Silva 123.456.789-09_`;
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
    ? `🧾 A ${storeLabel} emitiu a nota fiscal no seu nome. Aqui está: ${url}`
    : `🧾 A ${storeLabel} emitiu a nota fiscal no seu nome. Se precisar de uma cópia, é só pedir aqui.`;
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

// Nenhuma opção cumpre tudo o que o cliente pediu: avisa a diferença antes de mostrar o mais
// perto (fase 3 do plano, 07/10). `falta` completa "o mais perto que tenho …" ("é de 500 ml").
export function closestHeader(query: string, falta: string): string {
  return `Não achei *${query}* exatamente. O mais perto que tenho ${falta}:`;
}

// Preferência explícita de preço no pedido ("a mais barata"): a vitrine vem ordenada por preço.
export function cheapestFirstHeader(query: string): string {
  return `Separei as mais baratas de *${query}*, da mais barata pra mais cara:`;
}

// Recusou as opções e pediu algo que ninguém tem: honesto, sem repetir o que ele dispensou.
export function refineNoResultRejected(refined: string): string {
  return `Não achei *${refined}* nas lojas que entregam aí. Não vou te mostrar de novo o que você dispensou. Me diz outra palavra pra eu tentar, responde *pula* pra deixar esse item de fora, ou *outras* pra ver o que mais existe.`;
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
  // Parte do total que não está nos produtos nem no frete (taxa fixa do remédio isento, 29/09; a margem
  // inteira com LIA_PRICING_MODE=service_fee). NUNCA vira linha de "taxa" (dono, 08/10 noite: "não é pra
  // aparecer que tem taxa") — soma na linha da entrega.
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
// Prazo como o CLIENTE lê (09/10, rodada de cliente: "pela própria loja · prazo da loja: em até 9h (hoje, 12h–15h)"
// e "entrega em *em até 9h…*"). Só exibição: a promessa gravada no pedido continua igual (a compra confere por ela).
// "pela própria loja (2 entregas) · prazo da loja: em até 9h (hoje, 12h–15h)" → "2 entregas · hoje, 12h–15h".
export function promiseForCustomer(promise?: string | null): string {
  if (!promise) return "";
  return promise
    .split(" · ")
    .map((part) =>
      part
        .trim()
        .replace(/^(?:entrega )?pela própria loja\s*/i, "")
        .replace(/^prazo da loja:\s*/i, "")
        .replace(/^em até \d+h \((.+)\)$/i, "$1")
        .replace(/^\((\d+ entregas)\)$/i, "$1")
        .trim()
    )
    .filter(Boolean)
    .join(" · ");
}

function deliveryLine(frete: number, deliveryPromise?: string, etaMinutes?: number): string {
  const prazo = (deliveryPromise ? promiseForCustomer(deliveryPromise) : "") || (etaMinutes ? `chega em ~${etaMinutes} min` : null);
  return `Entrega: ${brl(frete)}${prazo ? ` · ${prazo}` : ""}`;
}

export function summary(input: SummaryInput): string {
  const lines = input.items.map((item) => `• ${item.qty}x ${item.name} — ${brl(item.displayLineTotal)}`);
  const out = [
    "🛒 *Seu pedido:*",
    ...lines,
    "",
    `Produtos: ${brl(input.produtos)}`,
    deliveryLine(input.frete + (input.serviceLine ?? 0), input.deliveryPromise, input.etaMinutes),
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
  kind: "ml" | "store" = "ml",
  budgetCap?: number
): string {
  const over = (total: number) => (budgetCap != null && total > budgetCap + 0.005 ? ` · passa do seu limite de ${brl(budgetCap)}` : "");
  // ML: data do anúncio ("chega até sáb."). Loja: SLA dela ("prazo da loja: 60 min").
  const quando = (estimate?: string) =>
    estimate ? (kind === "store" ? estimate : `chega até ${estimate}`) : kind === "store" ? "sem prazo informado" : "sem data publicada";
  return [
    "Tem duas formas de entrega. Qual você prefere?",
    `*1)* Mais barata — total ${brl(barato.total)} · ${quando(barato.estimate)}${over(barato.total)}`,
    `*2)* Mais rápida — total ${brl(rapido.total)} · ${quando(rapido.estimate)}${over(rapido.total)}`,
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
  return `Você tem um pedido de *${brl(total)}* esperando pagamento. Esse item novo é pra *juntar* nele, ou começamos um *pedido novo*?`;
}

// Pix pago enquanto a pergunta "juntar ou pedido novo?" estava aberta: o item novo
// não pode sumir em silêncio — vira pedido novo assim que o cliente mandar de novo.
export function newItemAfterPayment(request: string): string {
  const item = request.trim().slice(0, 60);
  return `E aquele item novo ("${item}") — como este pedido já está pago, ele vira um pedido novo. Me manda de novo que eu busco 🙂`;
}

export function newOrderStarted(shortId: string): string {
  return "Fechado! Cancelei o pedido anterior — nada foi cobrado. Bora pro pedido novo 👇";
}

// Corpo da bolha nativa de Pix (order_details). V2 (01/09): a bolha vai PRIMEIRO e,
// quando a Graph aceita, substitui o texto de instruções — só o copia-e-cola sai
// depois dela (fallback universal pra WhatsApp Web/cliente antigo).
// Bolha nativa do Pix (08/10 noite, dono: "vem o card e de novo a chave; só precisa de um"): quando a
// bolha sai, ela é a ÚNICA mensagem da cobrança — o botão já paga e copia o código. Sem número do pedido.
export function nativePixBody(): string {
  return "Toca no botão abaixo pra pagar com Pix — ele abre seu banco ou copia o código. Assim que cair, te aviso por aqui ⚡";
}

export function nativePixItemName(): string {
  return "Pedido Lia";
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
  return "✅ Pagamento confirmado. Agora faço a compra na loja e te aviso aqui assim que ela confirmar o pedido.";
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

// renewed (06/10): "o pix expirou" com Pix gera cobrança NOVA no mesmo método — dizia
// "Troquei pra Pix" sem ter trocado nada.
export function paymentSwitched(method: "pix" | "card", total: number, renewed = false, announced = false): string {
  // Aviso da troca já saiu logo antes (09/10): só o total e o código/link, sem repetir "troquei".
  if (announced) {
    return method === "pix" ? `Total *${brl(total)}* no Pix, sem taxa. Segue o código 👇` : `Total *${brl(total)}* no cartão, com a taxa da maquininha. Segue o link 👇`;
  }
  if (renewed) {
    return method === "pix"
      ? `Gerei um Pix novo — total *${brl(total)}*. O anterior não vale mais. Segue o código 👇`
      : `Gerei um link novo — total *${brl(total)}*. O anterior não vale mais 👇`;
  }
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

// Número do pedido NUNCA vai pro cliente (dono, 08/10 noite: "a pessoa não precisa saber o número do
// pedido, isso é nosso") — o pedido é ancorado pela data e pelos itens; o `#id` fica no /ops e nos avisos
// do dono. `shortId` continua no input pra quem chama não mudar.
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
  const id = meta ? `Seu pedido (${meta})` : "Seu pedido";
  switch (input.status) {
    case "awaiting_operator_quote":
      return `${id} com o total sendo fechado. Mando com a entrega pra você aprovar — nada é cobrado antes.`;
    case "awaiting_supplier_validation":
    case "payment_issuing":
      return `${id} em confirmação na loja. Te aviso quando o carrinho estiver pronto.`;
    case "awaiting_quote_confirmation":
      // 06/10: caía no default "em andamento" com nenhuma cobrança gerada.
      return `${id} com o total na mesa — a cobrança ainda não foi gerada. Responde *pix* ou *cartão* que eu mando o pagamento.`;
    case "awaiting_payment":
      return `${id} aguardando pagamento. Responde *pagar* que eu mando o código de novo.`;
    case "paid":
      return `${id} pago — estou fazendo a compra na loja. Te aviso assim que ela confirmar.`;
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

// {{1}} do template de aviso fora da janela de 24h ("…atualização sobre o seu pedido {{1}}: {{2}}"): o
// número do pedido não vai pro cliente (dono, 08/10 noite) — vai o primeiro item ("de Chocolate X").
export function orderTemplateLabel(items: unknown): string {
  const list = Array.isArray(items) ? (items as { name?: unknown }[]).filter((i) => i && typeof i.name === "string" && i.name.trim()) : [];
  if (!list.length) return "na Lia";
  const first = String(list[0].name).split("\n")[0].trim().slice(0, 40).trim();
  return list.length > 1 ? `de ${first} e mais ${list.length - 1}` : `de ${first}`;
}

// 2ª vez que o cliente pergunta de um pedido que não existe neste número (07/10).
export function noOrdersEscalated(inside = true): string {
  return `Não achei nenhum pedido neste número de WhatsApp. Se você pediu por outro número ou já tem um código do pedido, me manda aqui — já avisei o responsável pra conferir e ele te responde nesta conversa, ${attendanceWhen(inside)}.`;
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

// Desistência de pedido PAGO com confirmação (06/10): "cancela", "cancela tudo", "desisti",
// "quero meu dinheiro de volta" davam quatro respostas diferentes — uma estornava na hora.
// Agora todas perguntam antes e só o "sim" estorna.
export function withdrawConfirmAsk(input: { shortId: string; itemsPreview?: string; total: number; card?: boolean }): string {
  const meta = input.itemsPreview ? ` (${input.itemsPreview})` : "";
  return [
    `Confirma o cancelamento do pedido${meta}?`,
    `O valor de *${brl(input.total)}* volta pelo mesmo meio que você pagou (${input.card ? "cartão" : "Pix"}) — o banco leva até 7 dias úteis pra mostrar.`,
    "",
    "Responde *sim* pra cancelar ou *não* pra manter o pedido."
  ].join("\n");
}

export function withdrawKept(shortId: string): string {
  return "Combinado, o pedido segue normal 👍";
}

// "quero meu dinheiro de volta" depois de um pedido cancelado SEM pagamento (06/10): a
// resposta prometia estorno de item faltando, com nada cobrado.
export function refundNotPaidYet(shortId: string): string {
  return "Esse pedido ainda não foi pago — nada foi cobrado. Se não quiser mais, responde *cancelar*.";
}

export function refundNothingCharged(shortId: string): string {
  return "Esse pedido foi cancelado antes do pagamento — nada foi cobrado, então não tem valor pra devolver.";
}

export function nothingToCancel(paidActive?: { shortId: string; dateLabel?: string; itemsPreview?: string }): string {
  if (paidActive) {
    const meta = [paidActive.dateLabel, paidActive.itemsPreview].filter(Boolean).join(" — ");
    return `Não tem compra em aberto pra cancelar. Seu pedido${meta ? ` (${meta})` : ""} está pago e em andamento — esse segue normal; qualquer coisa nele, é só me falar.`;
  }
  return "Não tem nada em aberto pra cancelar. Me diz o que você precisa que eu monto a lista.";
}

// "cadê meu pedido?" logo depois de um cancelamento fala PRIMEIRO do cancelado; se
// existir um pedido pago antigo, ele entra como segunda linha, com data e conteúdo.
export function alsoActiveOrder(input: { shortId: string; dateLabel?: string; itemsPreview?: string }): string {
  const meta = [input.dateLabel, input.itemsPreview].filter(Boolean).join(" — ");
  return `Além desse, seu pedido${meta ? ` (${meta})` : ""} está pago e em andamento — esse segue normal.`;
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
    "• Eu compro no site oficial de lojas grandes (Drogaria São Paulo, Pague Menos, Cobasi, Mambo e outras) e a própria loja entrega.",
    "• A Lia Delivery é uma empresa registrada (MEI, com CNPJ) — o Pix vai pra ela, e o banco mostra o nome do responsável.",
    "Qualquer dúvida antes de pagar, é só perguntar — sem pressa."
  ].join("\n");
}

// Serviço que a Lia não faz (06/10): "chama um uber" recebia "não achei, me diz outra marca".
export function outOfScopeServiceAnswer(): string {
  return "Isso eu não faço 😅 Eu compro *produtos* em lojas online (mercado, farmácia, pet, beleza, casa, brinquedo) e a loja entrega aí. Precisa de algum produto?";
}
// Produto que a Lia não vende por natureza (07/10, c77: "vcs vendem carro 0km?" ouvia "não achei em nenhuma
// loja, me diz outra marca"): resposta honesta, sem pedir endereço nem prometer busca.
export function outOfScopeProductAnswer(): string {
  return "Isso eu não consigo comprar 😅 Eu trabalho com mercado, farmácia (sem remédio), casa, pet, beleza, eletrônicos e presentes — e a loja entrega aí. Precisa de algo dessas áreas?";
}
// Pedido vago (06/10): "algo gostoso pra comer" virava busca da frase.
export function vagueRequestAnswer(): string {
  return "Me diz o que você está com vontade que eu acho 🙂 Por exemplo: _lasanha congelada_, _pizza congelada_, _chocolate_, _sorvete_, _salgadinho_ — ou o nome de um produto.";
}

// ---------- recomendação (08/10, plano-recomendacoes) ----------
// O pedido entendido, só com o que a copy usa (sem importar o módulo da recomendação).
export type RecommendCopyReq = { form: "need" | "product_judged"; need?: string; product?: string; symptom?: string; recipient?: string; criteria: readonly string[]; constraints?: readonly string[] };

const trimRec = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const capFirst = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const isGiftNeed = (req: RecommendCopyReq) => /\bpresente/i.test(req.need ?? "");
const isSweetNeed = (req: RecommendCopyReq) => /\bdoce/i.test(req.need ?? "");
const isHungerNeed = (req: RecommendCopyReq) => /^(?:muita\s+)?fome$|\bmatar a fome\b/i.test(trimRec(req.need));
// "mãe" → "sua mãe"; "minha namorada" → "sua namorada"; "cachorro" → "seu cachorro".
function recipientPhrase(recipient: string): string {
  const r = trimRec(recipient).replace(/^(?:minha|meu|minhas|meus|a|o)\s+/i, "");
  if (!r) return "";
  if (/^(?:criança|crianca|bebê|bebe|amig[oa] secret[oa])/i.test(r)) return `${/^amig/i.test(r) ? "o" : "a"} ${r}`;
  const feminine = /(?:a|ã|ãe|mae|mãe|avó|avo|tia|irmã|irma|esposa|namorada|filha|sogra|madrinha|chefe)$/i.test(r) && !/^(?:pai|avô|cachorro|gato)$/i.test(r);
  return `${feminine ? "sua" : "seu"} ${r}`;
}

// Rótulo legível da necessidade: vira o `query` da escolha ("algo doce", "pra dor de barriga",
// "chocolate bom", "presente pra sua mãe").
export function recommendLabel(req: RecommendCopyReq): string {
  if (req.symptom) return `pra ${trimRec(req.symptom)}`;
  if (req.form === "product_judged") {
    const product = trimRec(req.product) || "produto";
    if (req.criteria.includes("cheap")) return `${product} em conta`;
    if (req.criteria.includes("healthy")) return `${product} saudável`;
    return `${product} bom`;
  }
  if (isGiftNeed(req) && req.recipient) return `presente pra ${recipientPhrase(req.recipient)}`;
  if (isHungerNeed(req)) return "matar a fome";
  return trimRec(req.need) || "uma ideia";
}

// Abertura dos cards. Nunca promete rapidez: o prazo real está em cada card.
export function recommendIntro(req: RecommendCopyReq): string {
  if (req.symptom) return `Pra ${trimRec(req.symptom)}, o que eu tenho *sem receita*:`;
  if (req.form === "product_judged") {
    const product = capFirst(trimRec(req.product) || "produto");
    if (req.criteria.includes("cheap")) return `${product} em conta? Separei estes 👇`;
    return `${product} bom? Separei estes 👇`;
  }
  if (isGiftNeed(req)) return req.recipient ? `Pra ${recipientPhrase(req.recipient)}, separei estas ideias 🎁` : "Separei estas ideias de presente 🎁";
  if (isSweetNeed(req)) return "Pra matar a vontade de doce, olha o que achei 🍫";
  if (isHungerNeed(req)) return "Pra matar a fome, olha o que achei 👇";
  if (/^churrasco\b/i.test(trimRec(req.need))) return `Pro ${trimRec(req.need)}:`;
  return `Pra *${trimRec(req.need) || "isso"}*, olha o que achei 👇`;
}

// Urgência sem entrega na hora (rodada de qualidade 08/10, corpus difícil): o melhor prazo REAL, honesto.
export function recommendFastestNote(minutes: number): string {
  const label = minutes < 24 * 60 ? `${Math.max(1, Math.round(minutes / 60))}h` : minutes < 48 * 60 ? "1 dia" : `${Math.round(minutes / (24 * 60))} dias`;
  return `Entrega na hora eu não tenho aí — o mais rápido que achei chega em *${label}*.`;
}

// Item da lista "Já anotei:" do onboarding (o pedido de recomendação inteiro, até o CEP).
export function recommendNoted(req: RecommendCopyReq): string {
  const label = recommendLabel(req);
  return label.startsWith("pra ") || label === "matar a fome" ? `uma recomendação ${label === "matar a fome" ? "pra matar a fome" : label}` : `uma recomendação de ${label}`;
}

// Nenhum card com entrega no CEP. Nunca "não achei doce": diz o que procurou e pede um produto.
export function recommendNone(req: RecommendCopyReq, emptyShelfLabels: string[] = []): string {
  if (req.symptom) {
    return `Não achei remédio *sem receita* pra ${trimRec(req.symptom)} com entrega aí 😕 Se você souber o nome do remédio, me diz que eu procuro. Se não melhorar, procure um médico ou farmacêutico.`;
  }
  // Alergia (q6, 08/10): o nome do produto não prova ausência de traços — sem item com "sem X" escrito, a Lia diz isso.
  const allergen = (req.constraints ?? []).map((c) => c.toLowerCase()).find((c) => /\b(amendoim|amendoins|castanhas?|nozes|amendoas?|camar[aã]o|frutos do mar|ovos?|soja)\b/.test(c));
  if (allergen) {
    const what = trimRec(allergen).replace(/^(sem|nada de|alergia a|alergia ao)\s+/i, "").replace(/\s*\(.*$/, "");
    return `Com alergia a *${what}* eu só mostro o que traz *sem ${what}* escrito no nome, e não achei isso aí agora 😕 Se você me disser um produto que já conhece, eu procuro — e confira sempre o rótulo antes de comer.`;
  }
  // "Algo gelado" (q9, r24): sem nada gelado que cumpra o pedido, a Lia diz isso, em vez de mostrar fruta e suco morno.
  if (/\bgelad/i.test(req.need ?? "")) {
    const restriction = trimRec((req.constraints ?? [])[0]);
    return `Não achei nada *gelado*${restriction ? ` ${restriction}` : ""} com entrega aí agora 😕 Se você me disser um produto que já conhece, eu procuro.`;
  }
  const labels = emptyShelfLabels.map((l) => l.replace(/\s*\(.*?\)\s*/g, " ").trim().toLowerCase()).filter(Boolean).slice(0, 3);
  const what = labels.length ? labels.join(", ").replace(/, ([^,]*)$/, " e $1") : recommendLabel(req);
  return `Hoje não achei ${labels.length ? what : `*${what}*`} com entrega aí 😕 Me diz um produto que eu procuro.`;
}

// Antes dos cards de remédio isento (regra do dono, 08/10).
export function recommendMedicineCare(): string {
  return "São remédios *isentos de receita*. Leia a bula; se não melhorar em 1–2 dias ou piorar, procure um médico.";
}

// Sinal de alerta: não recomenda. Tom por tipo (revisão de segurança 08/10):
//   - emergência (dor no peito, falta de ar, sangue…): abre pelo SAMU 192 / pronto-socorro, sem oferta de compra;
//   - contexto (bebê, criança, gestante, idoso, comorbidade, há dias…): médico/pediatra/farmacêutico, e a Lia
//     compra o isento se o cliente nomear o que o profissional indicou;
//   - pet doente (tables.PET_SICK_REASON): veterinário; remédio de gente pra pet nunca — sem SAMU.
// Sem `kind`, o tipo sai do motivo (a lista de emergência espelha tables.EMERGENCY_FLAGS).
export type RedFlagCopyKind = "emergency" | "context" | "pet";
const EMERGENCY_REASONS = new Set(["dor no peito", "falta de ar", "desmaio ou convulsão", "sangue", "confusão mental", "alergia grave ou inchaço", "suor frio"]);
export function recommendRedFlag(reason: string, kind?: "emergency" | "context" | "pet"): string {
  const why = trimRec(reason) || "esse sinal";
  const type: RedFlagCopyKind = /^pet doente/i.test(why) || kind === "pet" ? "pet" : kind ?? (EMERGENCY_REASONS.has(why) ? "emergency" : "context");
  if (type === "pet") {
    return "Pra bichinho doente o certo é o *veterinário* 🐾 Remédio de gente pra pet eu não indico — pode fazer mal a ele. Se o veterinário já receitou algo, me manda o nome que eu procuro.";
  }
  if (type === "emergency") {
    return `Com *${why}*, procure atendimento *agora*: ligue *192 (SAMU)* ou vá ao pronto-socorro mais perto. Não é caso de remédio por conta própria 🙏`;
  }
  const who = /beb[eê]|crian[cç]a/i.test(why) ? "o *pediatra*" : "um *médico* ou *farmacêutico*";
  return `Com *${why}*, o certo é falar com ${who} antes de tomar qualquer coisa — eu não indico remédio nesse caso. Se um profissional já indicou um remédio *sem receita*, me diz o nome que eu compro. Se piorar, procure atendimento.`;
}

// "outras" depois de mostrar todas as ideias que tinham entrega.
export function recommendMoreNone(): string {
  return "Essas eram as ideias que eu tinha com entrega aí. Me diz um produto que eu procuro 🙂 Ou responde o número de uma das opções.";
}

// ---- memória do cliente (08/10, recomendação fase 2) ----

const joinPt = (list: string[]) => list.filter(Boolean).join(", ").replace(/, ([^,]*)$/, " e $1");

// Cliente disse algo sobre si ("sou intolerante a lactose", "tenho um cachorro grande") e a mensagem era só isso.
export function preferenceSaved(saved: string[]): string {
  return `Anotado: ${joinPt(saved.map((s) => `*${s}*`))} 👍 Vou lembrar nas próximas recomendações.`;
}

// "esquece minhas preferências" / "não sou mais vegano".
export function preferencesForgotten(removed: string[]): string {
  if (!removed.length) return "Pronto, não tenho nada anotado sobre você 👍";
  return `Pronto, esqueci ${joinPt(removed.map((s) => `*${s}*`))} 👍`;
}

// Linha antes dos cards quando a restrição lembrada tirou alguma opção.
export function recommendMemoryNote(restrictions: string[]): string {
  return `Lembrei: ${joinPt(restrictions.map((s) => `*${s}*`))} — já deixei de fora o que não serve 👍`;
}

// Motivo do card que subiu pela marca que o cliente costuma comprar.
export function usualBrandWhy(): string {
  return "a marca que você costuma levar";
}

// ---- complemento no fechamento (08/10, recomendação fase 4) ----

// `why` = a frase da tabela ("Quem leva carvão costuma levar pão de alho 🧄").
export function complementOffer(name: string, price: number, why: string): string {
  return `${why.trim()} Quer adicionar o *${name}* por ${brl(price)}? Responde *sim* ou *não*.`;
}

export function complementAdded(name: string): string {
  return `✅ Adicionei *${name}*.`;
}

// "quem é vc?", "vc é robô?" (06/10): a apresentação genérica não dizia nem "sou a Lia".
export function identityAnswer(): string {
  return "Sou a Lia, assistente virtual da *Lia Delivery* 🤖 Eu procuro o que você precisa em lojas oficiais, mostro o total com frete e prazo, e compro pra você depois que você paga. Se preferir falar com uma pessoa, é só dizer *atendente*.";
}

// "meu filho que vai pagar, manda pra ele?" — honesto: a cobrança sai aqui, mas o
// código Pix pode ser encaminhado pra quem for pagar.
export function thirdPartyPayAnswer(): string {
  return "A cobrança sai aqui na nossa conversa, mas o código Pix é copia-e-cola: você pode encaminhar a mensagem pra quem for pagar, e a pessoa paga direto no banco dela 🙂 Quer que eu gere o Pix?";
}

// Nota fiscal / CNPJ. Os dados da empresa vêm da env LIA_BUSINESS_INFO (ex.:
// "Lia Delivery — CNPJ 12.345.678/0001-90"); sem env, resposta honesta sem número.
export function fiscalAnswer(topic: "nf" | "cnpj", businessInfo?: string, inside = true, otcOnCpf = false): string {
  if (topic === "nf") {
    // Modelo service_fee (08/10): a loja emite no nome e CPF do cliente (quem não cadastrou CPF
    // recebe no nome da Lia). Modelo markup: no nome da Lia; o trecho do remédio só com MIP ligado
    // (07/10, c13: o juiz chamou de promessa falsa).
    if (customerInvoiceMode()) {
      return "A nota fiscal é emitida pela própria loja, pelo preço dos produtos, *no seu nome e CPF* — por isso peço o CPF no cadastro. Sem CPF cadastrado, ela sai no nome da Lia Delivery. Quando a loja emite, eu te mando aqui.";
    }
    return `A nota fiscal é emitida pela própria loja, no valor dos produtos. Ela sai no nome da *Lia Delivery*, que faz a compra pra você${otcOnCpf ? " (remédio sem receita sai no seu CPF)" : ""}. Se precisar de uma cópia, me avisa que o responsável te envia.`;
  }
  return businessInfo
    ? `Claro: ${businessInfo}. E a nota fiscal dos produtos sai da própria loja onde eu compro.`
    : `A Lia Delivery é uma empresa registrada (MEI). Pedi agora pro responsável te mandar o CNPJ e o nome que aparece no Pix — ele te responde aqui mesmo, ${attendanceWhen(inside)}. A nota fiscal dos produtos sai da própria loja onde eu compro.`;
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
// Item vendido POR PESO (06/10, A3): o catálogo diz "Banana Nanica Kg", mas 1 unidade do
// carrinho são ~180 g. O nome mostrado diz o peso da unidade — "10x Pão Francês Kg" era lido
// como 10 kg.
export function weightLabel(kg: number): string {
  if (kg >= 1) return `${String(Math.round(kg * 10) / 10).replace(".", ",")} kg`;
  return `${Math.round(kg * 1000)} g`;
}
export function soldByWeightName(name: string, kg: number): string {
  const base = name.replace(/\s*[-–(]?\s*\bkg\b\.?\)?\s*$/i, "").trim();
  return `${base} (unidade ~${weightLabel(kg)})`;
}
export function weightConversionNote(askedKg: number, unitKg: number, units: number): string {
  return `_Vendido por unidade de ~${weightLabel(unitKg)}: coloquei ${units} ${units === 1 ? "unidade" : "unidades"} (~${weightLabel(units * unitKg)}) pro seu pedido de ${weightLabel(askedKg)}. O peso final é o que a loja pesar. Pra mudar, é só dizer o número de unidades._`;
}

// Embalagem que NÃO fecha com o número pedido (07/10, c28): pergunta antes de pôr na cesta.
export function packMismatchAsk(name: string, requested: number, packSize: number, packs: number): string {
  const total = packs * packSize;
  return `Essa opção (*${name}*) vem com *${packSize} unidades* por embalagem e você pediu *${requested}*. ${packs === 1 ? "Levo 1 embalagem" : `Levo ${packs} embalagens`} (${total} un) mesmo assim? Responde *sim*, ou *outras* pra ver outras opções.`;
}

export function packMismatchDeclined(): string {
  return "Sem problema — escolhe outra opção:";
}

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

// Mensagem solta com a cobrança aberta (06/10): o Pix continua valendo — antes ele era cancelado.
export function awaitingPaymentAck(total: number): string {
  return `Fico no aguardo 👍 Seu pagamento de *${brl(total)}* continua valendo — assim que cair, eu confirmo aqui. Pra somar um item, escreve _adiciona_ e o nome dele.`;
}
export function paymentLinkTrouble(): string {
  return "Se o link não abrir, eu mando um *Pix copia-e-cola* no lugar: responde *pix*. Seu pedido continua guardado.";
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
// Orçamento = TOTAL com entrega (07/10, c23/c24).
export function overBudgetFit(cap: number, total: number, cheapestFitTotal?: number): string {
  const over = Math.round((total - cap) * 100) / 100;
  const hint = cheapestFitTotal != null ? ` (com a entrega ficam em torno de ${brl(cheapestFitTotal)} ou menos)` : "";
  return `Com a entrega o total ficou em *${brl(total)}* — passou do seu limite de *${brl(cap)}* por ${brl(over)}. Estas opções cabem no limite${hint} 👇`;
}

export function overBudgetNone(cap: number, total: number, name: string, cheapestTotal?: number): string {
  const over = Math.round((total - cap) * 100) / 100;
  const cheaper = cheapestTotal != null && cheapestTotal < total - 0.009 ? ` A mais barata que achei ficaria em torno de ${brl(cheapestTotal)}.` : "";
  return `Com a entrega o total ficou em *${brl(total)}* — passou do seu limite de *${brl(cap)}* por ${brl(over)}, e nenhuma das opções que achei cabe.${cheaper} Quer seguir com *${name}* assim mesmo? Responde *pode* — ou me diz outro produto ou um limite novo.`;
}

// Teto dito depois de já ter o item na cesta: a Lia confere no total e só então avisa se não cabe.
export function budgetNoted(cap: number): string {
  return `Anotado: *${brl(cap)}* no total, já com a entrega. Se passar eu te aviso e mostro o que cabe. Quer mais alguma coisa? Quando fechar, diz *"só isso"*.`;
}

// Opções que sobraram depois do teto dito com as opções na mesa.
export function budgetNarrowedChoices(query: string, cap: number, total: boolean): string {
  return total ? `Estas de *${query}* cabem em ${brl(cap)} com a entrega 👇` : `Estas de *${query}* saem por até ${brl(cap)} 👇`;
}

export function overBudgetDeclined(): string {
  return "Sem problema, tirei da lista. Me diz outro produto ou um limite novo que eu procuro de novo.";
}

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
// Prazo por loja (09/10, dono: "devia mostrar o prazo direto"): "🚚 Prazo: *Mambo* — 1 dia útil".
export type EtaRow = { store: string; when: string };
export function etaLine(rows: EtaRow[]): string {
  return `🚚 Prazo: ${rows.map((r) => `*${r.store}* — ${promiseForCustomer(r.when)}`).join(" · ")} _(contado da compra)_`;
}
// "3h", "1 dia útil" → "em *3h*"; "hoje", "hoje, 12h–15h", "amanhã" → "*hoje, 12h–15h*".
function whenPhrase(when: string): string {
  const w = promiseForCustomer(when);
  return /^\d/.test(w) ? `em *${w}*` : `*${w}*`;
}

// "Quanto tempo demora?" com a lista montada (09/10): o prazo direto, com o caminho pro total.
export function basketEtaAnswer(rows: EtaRow[]): string {
  const body = rows.length === 1
    ? `A *${rows[0].store}* entrega ${whenPhrase(rows[0].when)} pro seu endereço, contado da compra.`
    : `Pro seu endereço: ${rows.map((r) => `*${r.store}* ${whenPhrase(r.when)}`).join(", ")} — contado da compra.`;
  return `${body}\nDiz *pagar* que eu mando o total com a entrega.`;
}

export function partialTotal(items: CopyBasketItem[], produtos: number, pendingCount: number, eta: EtaRow[] = []): string {
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
  return ["🛒 *Até agora:*", ...lines, "", `Produtos: ${brl(produtos)}`, ...(eta.length ? [etaLine(eta)] : []), tail].join("\n");
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

// ---------- Flow da lista e faltantes (07/10, Etapas 2 e 3) ----------
// Cada linha da lista termina em UM status; o MESMO texto aparece na mensagem antes do botão,
// no bloco "Não encontrei" do Flow (plain) e no resumo depois de confirmar.
export type MissStatus = "closest" | "not_found" | "unbuyable";
export type MissEntry = { status: MissStatus; label: string; qty?: number; falta?: string };

export const MISS_CLOSING = "Me manda outro nome ou marca pra qualquer um desses que eu procuro de novo.";

const stripMarks = (text: string) => text.replace(/[*_]/g, "");

export function missLine(m: MissEntry, plain = false): string {
  const label = `${shortNotFoundLabel(m.label)}${m.qty && m.qty > 1 ? ` (${m.qty}x)` : ""}`;
  const line =
    m.status === "closest"
      ? `🔎 *${label}* — o mais perto que achei ${m.falta ?? "é diferente do pedido"}; escolha uma opção ou *Não quero*`
      : m.status === "unbuyable"
        ? `🚫 *${label}* — nenhuma loja entrega no seu endereço agora`
        : `❌ *${label}* — não achei em nenhuma loja`;
  return plain ? stripMarks(line) : line;
}

// Linhas de status + o fecho (só quando há algo a procurar de novo).
export function missesBlock(misses: MissEntry[], plain = false): string {
  if (!misses.length) return "";
  const lines = misses.map((m) => missLine(m, plain));
  if (misses.some((m) => m.status !== "closest")) lines.push(plain ? stripMarks(MISS_CLOSING) : MISS_CLOSING);
  return lines.join("\n");
}

const FLOW_BODY_MAX = 1000;

// Texto da mensagem de Flow (corpo ≤ 1024): cesta sugerida + o que faltou + o que fazer. Lista
// longa encolhe: as primeiras linhas ficam e o resto vira "…e mais N".
export function listFlowIntro(input: {
  items: { qty: number; name: string; total: number; when?: string }[];
  misses: MissEntry[];
  notes?: string[];
  stale?: boolean;
  reopen?: boolean;
  overflowCount?: number;
}): string {
  const head = input.stale
    ? "Essa lista mudou depois que te mandei; segue a atualizada:"
    : input.reopen
      ? "Sua lista do jeito que está agora:"
      : "Montei sua lista com a minha sugestão:";
  const tail = [
    input.overflowCount ? `_Só as 15 primeiras linhas cabem no formulário; as outras ${input.overflowCount} ficaram pela minha sugestão (dá pra trocar por texto)._` : "",
    input.reopen
      ? "Pra trocar ou tirar algum item, toque em *Escolher minha lista*. Pra *adicionar* um item novo, é só me mandar o nome aqui."
      : "Pra trocar ou tirar algum item, toque em *Escolher minha lista*. Se já está bom, é só *Pagar*."
  ].filter(Boolean);
  const extras = [...(input.notes ?? []), input.misses.length ? missesBlock(input.misses) : ""].filter(Boolean);
  const render = (count: number) => {
    const shown = input.items.slice(0, count).map((i) => `• ${i.qty}x ${i.name} — ${brl(i.total)}${i.when ? ` · _${i.when}_` : ""}`);
    const rest = input.items.length - count;
    if (rest > 0) shown.push(`• …e mais ${rest} ${rest === 1 ? "item" : "itens"}`);
    return [head, ...shown, ...(extras.length ? ["", ...extras] : []), "", ...tail].join("\n");
  };
  let count = input.items.length;
  let body = render(count);
  while (body.length > FLOW_BODY_MAX && count > 1) {
    count -= 1;
    body = render(count);
  }
  return body.length > FLOW_BODY_MAX ? `${body.slice(0, FLOW_BODY_MAX - 1)}…` : body;
}

// Texto dos botões Pagar / Adicionar mais / Mudar minha lista depois do formulário (dono, 07/10).
export function listFlowFollowUp(): string {
  return "Para fechar o pedido:";
}

// "Nenhuma — ver outras" sem nenhuma outra opção além das que a tela mostrou.
export function listFlowNoOtherOptions(queries: string[]): string {
  const labels = queries.map((q) => `*${shortNotFoundLabel(q)}*`).join(", ");
  return queries.length === 1
    ? `De ${labels} não tenho outras opções além das que te mostrei; ficou fora da lista. Se quiser uma delas, é só me dizer o nome.`
    : `De ${labels} não tenho outras opções além das que te mostrei; ficaram fora da lista. Se quiser alguma delas, é só me dizer o nome.`;
}

export function listFlowClosed(): string {
  return "Essa lista já foi fechada, então não mexi em nada. Pra ajustar, me diz o que trocar (ex.: _troca X por Y_) ou me manda o nome do item que quer adicionar.";
}

// Resumo depois do formulário: itens, o que ficou de fora, faltantes de novo e o total parcial.
// Quantidades mudadas de uma vez (09/10): aqui a lista com as quantidades É o que o cliente quer conferir.
export function basketQtyUpdated(items: { qty: number; name: string; total: number; when?: string }[], produtos: number): string {
  return [
    "✅ Quantidades atualizadas:",
    ...items.map((i) => `• ${i.qty}x ${i.name} — ${brl(i.total)}${i.when ? ` · _${i.when}_` : ""}`),
    "",
    `Produtos: ${brl(produtos)} _(a entrega entra no total)_`
  ].join("\n");
}

export function listFlowDone(input: {
  items: { qty: number; name: string; total: number; when?: string }[];
  leftOut: string[];
  misses: MissEntry[];
  produtos: number;
  // Vagas marcadas "Nenhuma — ver outras": as opções novas vêm logo abaixo.
  moreFor?: string[];
  eta?: EtaRow[];
}): string {
  // Uma linha só (dono, 09/10): os itens já estão no formulário e na 1ª mensagem — repetir a lista depois de
  // escolher era ruído. Fica o que muda a decisão: quantos itens, quanto e o prazo de cada loja.
  const moreFor = input.moreFor ?? [];
  const lines: string[] = [];
  if (input.items.length) {
    const n = input.items.length;
    lines.push(`✅ Lista salva: ${n} ${n === 1 ? "item" : "itens"} · ${brl(input.produtos)} _(a entrega entra no total)_`);
    const whens = [...new Set(input.items.map((i) => i.when).filter((w): w is string => Boolean(w)))];
    if (whens.length) lines.push(`🚚 ${whens.join("; ")}`);
    else if (input.eta?.length) lines.push(etaLine(input.eta));
  } else {
    lines.push(moreFor.length ? "_Por enquanto nenhum item na lista._" : "_Nenhum item ficou na lista._");
  }
  if (input.leftOut.length) lines.push("", `Ficou de fora (sem opção escolhida): ${input.leftOut.map((l) => `*${shortNotFoundLabel(l)}*`).join(", ")}.`);
  if (input.misses.length) lines.push("", missesBlock(input.misses));
  if (moreFor.length) lines.push("", `Agora as outras opções de ${moreFor.map((l) => `*${shortNotFoundLabel(l)}*`).join(", ")} 👇`);
  return lines.join("\n");
}

// Procurou de novo a faltante pedida e achou: o item entra como avulso.
export function missFound(query: string): string {
  return `Achei *${shortNotFoundLabel(query)}* 👇`;
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

// Uma loja por pedido (08/10 noite): a lista estava em várias lojas e a Lia juntou tudo numa só. Nunca
// silencioso — o que mudou, com preço, e a diferença no total.
export function basketConsolidated(store: string, pairs: SwapPair[], delta: number): string {
  const diff = delta > 0.009 ? ` (${brl(delta)} a mais nos produtos, numa entrega só)` : delta < -0.009 ? ` (${brl(Math.abs(delta))} a menos)` : "";
  return [`Juntei tudo na *${store}* pra vir num pedido só${diff}:`, ...swapPairLines(pairs)].join("\n");
}

// "Quando chega?" com a lista montada (08/10 noite): o prazo é da loja e sai no total — a Lia fecha agora.
export function etaComesWithTotal(): string {
  return "O prazo é o da loja pro seu endereço — ele vem junto com o total. Fechei pra você ver:";
}

export function etaAfterChoice(known: EtaRow[] = []): string {
  const so = known.length ? `Do que já está na lista: ${known.map((r) => `*${r.store}* ${whenPhrase(r.when)}`).join(", ")}. ` : "";
  return `${so}O prazo de cada opção está no card — escolhe essa aqui que eu fecho o total com a entrega:`;
}

export function minimumSwapDone(pairs?: SwapPair[]): string {
  if (!pairs?.length) return "Troquei de loja — sem pedido mínimo. Fechando seu total:";
  return ["Troquei de loja — sem pedido mínimo:", ...swapPairLines(pairs), "Fechando seu total:"].join("\n");
}

// Juízo do "não achei" (rodada 3, 07/10): a IA só classifica; o texto é sempre este.
// `fora` = categoria que a Lia não compra (sofá, geladeira, carro); `exigente` = o cliente fixou
// marca/versão/uso — sugerir "outra marca ou versão" ignorava o que ele disse (c01, c11, c97).
export type MissInfo = { fora?: "moveis_grandes" | "eletrodomestico_grande" | "veiculo" | "imovel" | "nenhum"; exigente?: boolean };

const OUT_KIND_PHRASE: Record<string, string> = {
  moveis_grandes: "móveis grandes (sofá, cama, guarda-roupa…)",
  eletrodomestico_grande: "eletrodomésticos grandes (geladeira, fogão, máquina de lavar…)",
  veiculo: "veículos",
  imovel: "imóveis"
};
const OUT_AREAS = "Eu trabalho com mercado, farmácia (sem remédio), casa, pet, beleza, eletrônicos e presentes — e a loja entrega aí.";

function isOutKind(info?: MissInfo): boolean {
  return Boolean(info?.fora && info.fora !== "nenhum" && OUT_KIND_PHRASE[info.fora]);
}

// Produto de uma categoria que a Lia não compra: recusa clara, sem prometer busca nem pedir "outra marca".
export function outOfCatalogItem(item: string, info: MissInfo): string {
  const label = shortNotFoundLabel(item);
  return `*${label}* eu não consigo comprar: ${OUT_KIND_PHRASE[info.fora ?? "moveis_grandes"]} não estão entre os produtos que eu compro. ${OUT_AREAS} Precisa de algo dessas áreas?`;
}

// Cliente fixou marca/versão/uso e nenhuma loja tem: diz isso sem empurrar outra marca.
export function exactItemNotFound(item: string): string {
  return `*${shortNotFoundLabel(item)}* eu não achei em nenhuma loja que entrega aí. Se precisar de outra coisa, é só me pedir.`;
}

// Já refizemos a busca e continua sem nada (07/10): resposta honesta com saída, nunca o mesmo
// "não achei" em laço.
export function missStillNone(query: string, info?: MissInfo): string {
  if (isOutKind(info)) return outOfCatalogItem(query, info!);
  const label = shortNotFoundLabel(query);
  if (info?.exigente) return `Conferi de novo todas as lojas que entregam aí e continuo sem *${label}*. Se precisar de outra coisa, é só me pedir.`;
  return `Procurei de novo e continuo sem nenhuma opção de *${label}* nas lojas que entregam aí. Se quiser, me diz um produto parecido ou outro item que eu busco agora.`;
}

export function itemsNotAvailable(items: string[], info?: MissInfo[]): string {
  const labels = items.map(shortNotFoundLabel);
  if (labels.length === 1) {
    if (isOutKind(info?.[0])) return outOfCatalogItem(items[0], info![0]);
    if (info?.[0]?.exigente) return exactItemNotFound(items[0]);
    return `*${labels[0]}* eu não achei em nenhuma loja agora. Me diz outra marca ou versão que eu tento de novo.`;
  }
  const outIdx = items.map((_, i) => i).filter((i) => isOutKind(info?.[i]));
  if (outIdx.length) {
    const kinds = [...new Set(outIdx.map((i) => OUT_KIND_PHRASE[info![i].fora!]))].join(" e ");
    const lines = [`Não consigo comprar ${outIdx.map((i) => `*${labels[i]}*`).join(", ")}: ${kinds} não estão entre os produtos que eu compro. ${OUT_AREAS}`];
    const restIdx = items.map((_, i) => i).filter((i) => !outIdx.includes(i));
    if (restIdx.length) lines.push("", itemsNotAvailable(restIdx.map((i) => items[i]), restIdx.map((i) => info![i])));
    return lines.join("\n");
  }
  const allExact = Boolean(info) && labels.every((_, i) => info![i]?.exigente);
  return [
    "Esses eu não achei em nenhuma loja agora:",
    ...labels.map((i) => `• ${i}`),
    "",
    allExact ? "Se precisar de outra coisa, é só me pedir." : "Me diz outras marcas ou versões que eu tento de novo."
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
  return `Saiu o total do seu outro pedido${dateLabel ? ` (${dateLabel})` : ""} — esse é separado do que a gente está vendo agora:`;
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
  // Pedido com remédio isento (29/09): o remédio vai pelo preço da farmácia (comprado no nome/CPF do
  // cliente) e a taxa fixa da Lia soma na linha da entrega — nunca aparece como "taxa" (08/10 noite).
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
    deliveryLine(input.frete + (input.serviceLine ?? 0), input.deliveryPromise, input.etaMinutes),
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
  topic: "area" | "fee" | "eta" | "payment" | "generic" | "stores" | "price_compare" | "service_fee" | "pix_receiver" | "total_preview",
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
    case "service_fee":
      // Taxa da Lia nunca aparece (dono, 08/10 noite): não existe linha de taxa; o serviço vai no preço.
      return "Não tem taxa separada: o meu serviço já vem *embutido no preço de cada item* (por isso pode ficar um pouco acima do site da loja). No cartão entra a taxa do cartão; no Pix, não. E você sempre vê o total antes de pagar.";
    case "pix_receiver":
      return pixReceiverAnswer();
    case "total_preview":
      return "Você vê o total *antes de pagar*: quando fechar a lista (diz *só isso*), eu mando o resumo com produtos, entrega e prazo — só depois peço o Pix ou o cartão. Nada é cobrado antes.";
    case "stores":
      return storesAnswer([]);
    case "price_compare":
      return priceCompareAnswer(Boolean(ctx?.hasBasket));
    default:
      return "Eu procuro o que você pedir nas lojas que entregam no seu endereço, mostro o total e o prazo antes, e você paga por Pix ou cartão aqui no chat. Eu compro pra você depois que pagar. O que você precisa?";
  }
}

// Frete ao vivo por loja (06/10): o valor já é conhecido nas opções — dizer o número.
export function feeByStore(fees: { storeLabel: string; fee: number }[]): string {
  const list = fees.map((f) => `*${f.storeLabel}*: ${f.fee > 0 ? brl(f.fee) : "grátis"}`).join(" · ");
  return `Frete até o seu endereço — ${list}. É cobrado uma vez por loja; o total exato aparece antes de você pagar.`;
}

// Quem recebe o Pix (06/10): a IA dizia "a própria loja" — falso. A Lia é MEI: o banco de
// quem paga mostra o nome do titular do CNPJ. Dados da empresa em LIA_BUSINESS_INFO.
export function pixReceiverAnswer(businessInfo = process.env.LIA_BUSINESS_INFO?.trim()): string {
  return [
    "O Pix vai pra *Lia Delivery*, não pra loja: eu recebo, compro na loja e pago a loja na hora.",
    "A Lia é uma empresa MEI, então o seu banco mostra o *nome do responsável* pelo CNPJ — é normal.",
    businessInfo ? `Dados da empresa: ${businessInfo}.` : "",
    "Se a compra não sair, o valor volta inteiro pra você."
  ].filter(Boolean).join(" ");
}

// "qual a loja?"/"de onde vc compra?" (06/10, Clara e Claire): a resposta da IA era vaga
// ("lojas oficiais parceiras"). Com opções na tela, diz a loja de cada uma.
const STORES_GENERAL = "Eu compro em várias lojas online — mercado, farmácia, pet, beleza e casa — e mostro só as que entregam no seu endereço.";
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
// "Responde mais barato" só faz sentido com opções na mesa; sem produto era beco (placar c14).
export function priceCompareAnswer(withOptions = true): string {
  const base = "Comparo, sim: procuro o produto em várias lojas ao mesmo tempo e te mostro as opções com o preço de cada uma";
  return withOptions
    ? `${base}. Quer ver as mais baratas? Responde *mais barato*.`
    : `${base}. Me diz o que você quer (pode escrever "o mais barato") que eu mostro agora.`;
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

// ---------- antes de existir cobrança / depois do pagamento (06/10) ----------

// "paguei"/"já paguei"/"manda o pix de novo" antes de gerar a cobrança: respondia "em
// andamento" ou "você ainda não tem pedidos". O cliente achava que estava tudo certo.
export function chargeNotIssuedChooseFreight(): string {
  return "Ainda não gerei a cobrança — nada foi pago nem cobrado. Primeiro escolhe a entrega 👇 depois eu mando o Pix ou o cartão.";
}

export function chargeNotIssuedChoosePayment(): string {
  return "Ainda não gerei a cobrança — nada foi pago nem cobrado. Escolhe *Pix* ou *cartão* que eu mando o pagamento 👇";
}

// Tela "Mais barata / Mais rápida" (06/10): "pix", "o frete tá caro", "chega que horas?"
// respondiam "Não peguei qual você quer".
export function freightBeforePayment(): string {
  return "Antes do pagamento, escolhe a entrega: responde *1* (mais barata) ou *2* (mais rápida). Em seguida eu mando o total pra pagar.";
}

export function freightFeeExplain(): string {
  return "O frete é o que a própria loja cobra até o seu endereço. A opção *1* é a mais barata 👇";
}

export function freightEtaHeader(): string {
  return "O prazo depende da entrega que você escolher — está em cada opção 👇";
}

// "qual a chave pix?" com o código na mão (06/10): a IA dizia que o Pix "aparece no total".
export function pixKeyExplain(): string {
  return "Não tem chave pra digitar: é *Pix copia e cola*. O código é a mensagem que mandei — copia ela inteira e cola no app do banco, na opção *Pix copia e cola*.";
}

export function pixKeyNoCharge(): string {
  return "Não tem chave pra digitar: quando você fechar o pedido, eu mando um código *Pix copia e cola* pra colar no app do banco.";
}

export function unsupportedPayment(): string {
  return "Aqui é só *Pix* ou *cartão de crédito*, tudo pelo chat — dinheiro, vale-refeição, boleto ou pagamento na entrega eu não consigo aceitar.";
}

// "ok"/"blz" logo depois do Pix (06/10): "Imagina! Qualquer coisa é só chamar" soava como
// despedida no meio do pagamento.

// Loja e prazo DO PEDIDO (06/10): "quando chega?" com pedido pago devolvia só o status.
export function orderDeliveryInfo(input: { stores: string[]; promise?: string }): string {
  const stores = input.stores.length ? input.stores.map((s) => `*${s}*`).join(" e ") : "";
  const promise = promiseForCustomer(input.promise);
  if (stores && promise) return `🚚 Loja ${stores} · ${promise}`;
  if (stores) return `🚚 Loja ${stores}`;
  return promise ? `🚚 ${promise.charAt(0).toUpperCase()}${promise.slice(1)}` : "";
}

export function orderStoreAnswer(shortId: string, stores: string[]): string {
  return `Seu pedido é da loja ${stores.map((s) => `*${s}*`).join(" e ")}.`;
}

export function savedAddressAnswer(address: string, cep?: string): string {
  return `📍 Seu endereço de entrega: ${withCep(address, cep)}`;
}

export function orderAddressAnswer(shortId: string, address: string): string {
  return `📍 Seu pedido vai para: ${address}`;
}

// Troca de endereço DEPOIS de pagar (06/10): dizia "Endereço atualizado" e o pedido pago
// seguia para o endereço antigo, sem aviso.
export function paidOrderAddressKept(shortId: string, address: string): string {
  return `Seu pedido já está pago e vai para *${address}* — esse eu não consigo mudar por aqui. O endereço novo vale para os próximos pedidos.`;
}

// ---------- modo atendimento (07/10, placar c13/c30/c31) ----------
// Depois de avisar o dono, a Lia confirma UMA vez com o prazo honesto e, nas mensagens seguintes que
// não são pedido de produto, responde curto e DIFERENTE da anterior (repetir o mesmo texto parecia
// travado). O prazo é o horário em que o dono responde; fora dele, "a partir das 9h".
function attendanceWhen(inside: boolean): string {
  return inside ? "das 9h às 20h" : "a partir das 9h";
}

export function humanHandoff(inside = true): string {
  return `Avisei o responsável — ele te responde aqui mesmo, ${attendanceWhen(inside)}. Enquanto isso, pode escrever o que precisa que a mensagem chega. Se for sobre um pedido, responde *status* que eu já adianto.`;
}

// Confirmação curta das mensagens seguintes. `n` = quantas já foram dadas; a variação sempre
// difere da anterior (ciclo de 4) e a primeira começa com "Já avisei o responsável".
export function attendanceAck(n: number, inside = true): string {
  const when = attendanceWhen(inside);
  const variants = [
    `Já avisei o responsável — ele responde aqui, ${when}. Se quiser adiantar, deixa os detalhes por escrito que ele já vê tudo.`,
    `Anotado 🙂 Pode ficar tranquilo(a): ele responde nesta conversa, ${when}.`,
    `Sigo por aqui. Se precisar de alguma compra, é só me dizer o produto; o resto fica com o responsável, que te responde ${when}.`,
    `Está com ele — não precisa mandar de novo. A resposta vem aqui, ${when}.`
  ];
  return variants[((n % variants.length) + variants.length) % variants.length];
}

// Sem pedido, sem promessa de estorno (06/10: "meu nome está errado" virava reclamação com
// "se faltou item, estorno"). Com pedido, a promessa de 17/08 fica.
export function complaintAck(hasOrder = true, inside = true): string {
  const when = attendanceWhen(inside);
  return hasOrder
    ? `Sinto muito 😕 Já avisei o responsável, ele te responde aqui, ${when}. Se faltou item, estorno o valor dele; me conta o que aconteceu (o que faltou, veio errado ou atrasou) que eu deixo anotado no pedido.`
    : `Sinto muito 😕 Já avisei o responsável, ele te responde aqui, ${when}. Me conta o que aconteceu que eu deixo anotado.`;
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
  // 06/10: com o total na mesa ou a escolha da entrega aberta, o "oi" esquecia o pedido.
  if (step === "awaiting_quote_confirmation") return "Oi! Seu pedido está com o total pronto — só falta escolher *Pix* ou *cartão* 👇";
  if (step === "choosing_freight") return "Oi! Seu pedido só falta escolher a entrega 👇";
  if (itemCount > 0)
    return `Oi! Sua cesta tem ${itemCount} ${itemCount === 1 ? "item" : "itens"}. Manda mais algum, ou responde *pagar* pra fechar.`;
  return "Oi! O que você precisa hoje?";
}

// Modo offline (06/10): aviso único para todo cliente enquanto a Lia está desligada.
export function offlineNotice(): string {
  return "Oi! A Lia está fora do ar agora por uma instabilidade nos nossos servidores. Já estamos resolvendo e voltamos em breve. Nada foi cobrado. Te espero de volta!";
}

export function ownerOfflineToggled(on: boolean): string {
  return on
    ? "🔴 Lia OFFLINE. Todo cliente recebe o aviso de instabilidade. Você continua passando normal. Pra religar: *lia online*."
    : "🟢 Lia ONLINE. Clientes voltaram a ser atendidos normalmente.";
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
  return "Cancelei o pedido parado por inatividade — nada foi cobrado. Bora recomeçar.";
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
  return `Recebi um pagamento de ${brl(amount)} de um pedido que não estava mais aguardando esse valor. Vou conferir e te retorno por aqui.`;
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
    ? `Seu pedido travou na loja: o item está sem estoque para o seu endereço. Estou tentando outra loja agora; se não der, devolvo o valor integral e te aviso por aqui.`
    : `Seu pedido está demorando mais que o normal para eu fechar a compra na loja. Continuo nele; se não conseguir, devolvo o valor integral e te aviso por aqui.`;
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

// Ensaio da compra (08/10 noite): a loja não confirmou a entrega prometida, o endereço ou o preço na hora
// de cobrar. Nada foi cobrado; a Lia refaz a cotação NA HORA (a mensagem do novo total vem logo depois) —
// endereço recusado pede o endereço de novo.
export function deliveryNotConfirmed(store: string, promise: string | undefined, kind: "delivery" | "address" | "price" | "checkout" | "items"): string {
  const prazo = promise ? (promise.match(/prazo da loja:\s*([^·]+)/i)?.[1] ?? "").trim() : "";
  if (kind === "address") {
    return `Conferi na *${store}* na hora de cobrar e a loja não aceitou o seu endereço como está. *Nada foi cobrado.* Me manda o endereço completo de novo (rua, número e complemento) que eu refaço.`;
  }
  if (kind === "delivery") {
    return `Conferi na *${store}* na hora de cobrar e a entrega${prazo ? ` de *${prazo}*` : " que eu te mostrei"} não está disponível pro seu endereço agora. *Nada foi cobrado.* Refiz o total com a entrega que a loja confirma pra você:`;
  }
  if (kind === "price") {
    return `Conferi na *${store}* na hora de cobrar e o preço mudou na loja. *Nada foi cobrado.* Refiz o total com o preço de agora:`;
  }
  return `Conferi na *${store}* na hora de cobrar e a loja não fechou o pedido agora. *Nada foi cobrado.* Refiz a cotação:`;
}

// Toda compra é por API (08/10 noite): loja que a Lia não fecha por API nunca é cobrada — o item é
// procurado em outra loja.
export function storeNotPurchasable(store: string, names: string[]): string {
  return `Não consigo fechar *${names.join("*, *")}* na *${store}* agora. *Nada foi cobrado.* Vou procurar em outra loja:`;
}

// Cesta de 2 lojas na hora de cobrar (08/10 noite): a compra automática fecha UMA loja por pedido. Fica a
// loja com a maior parte da cesta; o resto é procurado/fechado em seguida.
export function oneStorePerOrder(keptStore: string, keptNames: string[], movedNames: string[]): string {
  return `Fecho um pedido por loja: primeiro a *${keptStore}* (${keptNames.join(", ")}). *Nada foi cobrado ainda.* *${movedNames.join("*, *")}* fica pra fechar em seguida — vou procurar de novo:`;
}

// 2ª recusa seguida da mesma loja no ensaio (08/10 noite): a loja sai do caminho e a Lia busca o mesmo
// item em outra loja — sem loop e sem cobrar.
export function rehearsalGaveUpStore(names: string[], store: string): string {
  return `A *${store}* não fechou *${names.join("*, *")}* pro seu endereço de novo. *Nada foi cobrado.* Vou procurar em outra loja:`;
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

// ---------- escolher a opção e mexer na cesta (varredura 06/10) ----------

// Toque repetido no MESMO card: não soma calado (06/10 — virava 2x sem aviso).
export function alreadyInBasket(name: string, qty: number): string {
  return `✅ *${name}* já está na cesta${qty > 1 ? ` (${qty}x)` : ""}. Pra mudar a quantidade, manda o número.`;
}

// Número fora da lista ("5" com 3 opções): a pessoa respondeu um número, dizer quantas há.
export function choiceOutOfRange(count: number): string {
  if (count <= 1) return "Aqui só tem *1* opção. Responde *1* pra levar ou *outras* pra ver mais.";
  const nums = Array.from({ length: count }, (_, i) => i + 1);
  return `São só ${count} opções: responde *${nums.slice(0, -1).join("*, *")}* ou *${nums[nums.length - 1]}* — ou *outras* pra ver mais.`;
}

// "quero 2 unidades" com a escolha aberta: guarda a quantidade e pede qual.
export function qtyNotedPickOne(qty: number, query: string): string {
  return `Anotei ${qty} unidades de *${query}*. Agora me diz qual 👇`;
}

// "na verdade quero o 2" depois de escolher: a troca é anunciada.
export function choiceSwitchedOut(oldName: string): string {
  return `Troquei: saiu *${oldName}*.`;
}

export function choiceSameAsBasket(name: string): string {
  return `*${name}* já é o que está na sua cesta 🙂`;
}

export function switchNothingOpen(): string {
  return "Não tenho uma lista aberta pra trocar agora. Me diz o produto que você quer que eu procuro.";
}

// "voltar" depois de escolher: a lista volta e o item escolhido fica até ele escolher outro.
export function backToChoice(query: string, keptName?: string): string {
  return keptName
    ? `Voltei pras opções de *${query}* — *${keptName}* continua na cesta até você escolher outra:`
    : `Voltei pras opções de *${query}*:`;
}

export function backNothingOpen(): string {
  return "Não tem lista aberta pra voltar. Me diz o que você quer que eu procuro.";
}

// "qual o mais barato?" é pergunta — responde qual é, não põe na cesta (06/10).
export function cheapestOptionAnswer(n: number, name: string, price: number, cheapest: boolean): string {
  return `O mais ${cheapest ? "barato" : "caro"} é o *${n}*: ${name} — ${brl(price)}. Quer esse? Responde *${n}*.`;
}

// "chega hoje?"/"o 2 chega hoje?" com as opções na tela: os prazos que a loja informou.
export function choiceEtaAnswer(rows: Array<{ n: number; name: string; delivery?: string; today?: boolean }>, askedToday: boolean): string {
  const known = rows.filter((r) => r.delivery);
  if (!known.length) return "O prazo de cada loja sai no total, logo depois que você escolher. Responde o número 👇";
  const lines = rows.map((r) => `*${r.n})* ${r.name} — ${r.delivery ?? "prazo no total"}`);
  let head = "Prazo de cada opção:";
  if (askedToday) {
    const today = rows.filter((r) => r.today);
    head =
      rows.length === 1
        ? today.length ? "Chega hoje sim 🙂" : "Hoje não — o prazo dessa é:"
        : today.length
          ? `Chega hoje: ${today.map((r) => `*${r.n}*`).join(", ")}.`
          : "Nenhuma dessas chega hoje. Os prazos:";
  }
  return [head, ...lines].join("\n");
}

// "oi" no meio da escolha: lembra a lista que está esperando (06/10).
export function greetingMidChoice(query: string): string {
  return `Oi! 🙂 Ainda tô com as opções de *${query}* esperando — é só responder o número:`;
}

// "o da Mambo" na escolha: estreita para as opções daquela loja.
export function storeNarrowed(label: string): string {
  return `Da *${label}* eu tenho:`;
}

export function storeAllSame(label: string): string {
  return `Todas essas são da *${label}* 🙂`;
}

export function storeNoneOnTable(label: string): string {
  return `Nenhuma das opções na tela é da *${label}*. As de agora são essas:`;
}

// "o mesmo da última vez" na escolha.
export function previousPurchaseFound(): string {
  return "Esse é o que você já comprou com a gente:";
}

export function previousPurchaseNotHere(): string {
  return "Não achei nenhuma dessas nas suas compras anteriores. Escolhe uma das opções 👇";
}
