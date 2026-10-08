// Tabelas CURADAS da recomendação (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md §1.2 e
// §1.6). Conhecimento fixo e revisado onde errar custa caro — sem IA (ou com a IA fora do ar) a
// Lia recomenda só por aqui:
//   - NEED_TABLE: estado ("tô com fome"), vontade ("algo doce"), ocasião ("churrasco") e presente
//     ("presente pra minha mãe") → prateleiras do mapa em ordem do que mais ajuda.
//   - SYMPTOM_TABLE: sintoma → classes de remédio ISENTO de prescrição (lista MIP), o mais indicado
//     primeiro, + cuidado não-remédio. Antibiótico, corticoide oral, tarja vermelha/preta: NUNCA.
//     Tabela a revisar pelo dono e pelo advogado sanitário antes de ligar LIA_RECOMMEND_MEDICINE.
//   - RED_FLAGS: sinais de alerta que bloqueiam a recomendação de remédio (manda procurar
//     médico/farmacêutico; compra só se o cliente nomear o isento).
// Todo `shelfId` aqui existe em shelf-map.ts (tests/recommend-shelf-map.test.ts confere). Os `why`
// são fatos curtos ("alivia cólica e gases"), nunca promessa de cura.
// Funções puras, sem rede e sem banco.
//
// REVISÃO PENDENTE (dono/advogado sanitário) — itens que a revisão adversarial de 08/10 marcou e que
// ficam na tabela até a decisão, sempre atrás da porta do remédio (LIA_MEDICINE_MIP +
// LIA_RECOMMEND_MEDICINE) e dos sinais de alerta:
//   - loperamida (Imosec/Diasec): só na entrada "diarreia" (fora de "dor de barriga" genérica);
//   - aciclovir creme (herpes labial);
//   - melatonina (insônia leve);
//   - cetoconazol creme (aparece no alias da prateleira de antifúngico);
//   - descongestionantes (gripe/nariz entupido): contraindicados para pressão alta — a comorbidade
//     "pressão alta" já vira alerta (RED_FLAGS) e o antigripal leva o aviso no `why`.
// Ressaca (08/10): sem AAS/Engov, sem AINE e sem paracetamol depois de álcool — só hidratação.
import { normalizeText } from "../stores/types";
import { SHELF_MAP } from "./shelf-map";
import type { NeedTableEntry, RecommendCriterion, RedFlagRule, ShelfDomain, ShelfNode, ShelfPick, SymptomTableEntry } from "./types";

// Prateleira comum (sem remédio).
function p(shelfId: string, query: string, why: string): ShelfPick {
  return { shelfId, query, why };
}

// Prateleira de remédio isento: a classe é o sufixo do id ("farmacia.antiespasmodico").
function mip(shelfId: string, query: string, why: string): ShelfPick {
  return { shelfId, query, why, mipClass: shelfId.replace(/^farmacia\./, "") };
}

function need(keys: string[], picks: ShelfPick[], criteria?: RecommendCriterion[]): NeedTableEntry {
  return criteria ? { keys, picks, criteria } : { keys, picks };
}

// Faixas de idade para presente de criança: "menino de 4 anos", "menina 6 anos".
function ages(nouns: string[], from: number, to: number): string[] {
  const out: string[] = [];
  for (const n of nouns) for (let a = from; a <= to; a++) out.push(`${n} de ${a} anos`, `${n} ${a} anos`);
  return out;
}

// ---------------------------------------------------------------------------
// NECESSIDADE → PRATELEIRAS
// ---------------------------------------------------------------------------

const FOME_KEYS = [
  "fome", "com fome", "to com fome", "estou com fome", "morrendo de fome", "to morrendo de fome", "fome agora",
  "bateu a fome", "bateu uma fome", "deu fome", "larica", "to com larica", "bateu a larica", "matar a fome",
  "algo pra comer", "alguma coisa pra comer", "algo para comer", "coisa pra comer", "beliscar", "algo pra beliscar",
  "lanche", "lanchinho", "fazer um lanche", "fome de madrugada"
];

export const NEED_TABLE: NeedTableEntry[] = [
  // ======================= ESTADOS =======================
  need(["fome de doce", "fome doce", "fome algo doce", "fome de algo doce", "larica doce"], [
    p("doces.chocolate", "chocolate", "pronto pra comer na hora"),
    p("doces.biscoito_doce", "biscoito recheado", "pacote pronto pra matar a fome"),
    p("doces.bolo", "bolinho", "bolinho pronto, individual"),
    p("doces.sorvete", "sorvete", "gelado e pronto pra comer")
  ], ["fast"]),
  need(["fome de salgado", "fome salgada", "fome algo salgado", "larica salgada"], [
    p("snacks.salgadinho", "salgadinho", "pronto pra comer na hora"),
    p("lanches.sanduiche", "sanduiche pronto", "lanche pronto, sem preparo"),
    p("snacks.biscoito_salgado", "biscoito salgado", "pacote pronto pra beliscar"),
    p("snacks.amendoim_castanhas", "amendoim", "petisco pronto e que sustenta")
  ], ["fast"]),
  need(FOME_KEYS, [
    p("snacks.salgadinho", "salgadinho", "pronto pra comer na hora"),
    p("doces.chocolate", "chocolate", "pronto pra comer e dá energia rápida"),
    p("lanches.sanduiche", "sanduiche pronto", "lanche pronto, sem preparo"),
    p("doces.biscoito_doce", "biscoito recheado", "pacote pronto pra beliscar"),
    p("frios.iogurte", "iogurte", "leve e pronto pra comer"),
    p("snacks.amendoim_castanhas", "mix de castanhas", "petisco que sustenta")
  ], ["fast"]),
  need(["jantar rapido", "jantar pronto", "algo pra jantar", "almoco rapido", "comida pronta", "refeicao pronta", "nao quero cozinhar",
    "preguica de cozinhar", "sem tempo pra cozinhar", "janta", "jantar"], [
    p("congelados.pratos_prontos", "lasanha congelada", "fica pronto em minutos no micro-ondas"),
    p("congelados.pizza", "pizza congelada", "vai direto ao forno"),
    p("congelados.empanados", "nuggets", "prontos em poucos minutos"),
    p("mercado.macarrao_instantaneo", "macarrao instantaneo", "pronto em 3 minutos"),
    p("lanches.sanduiche", "sanduiche pronto", "lanche pronto, sem preparo")
  ], ["fast"]),
  need(["sede", "com sede", "to com sede", "morrendo de sede", "calor", "to com calor", "muito calor", "que calor", "refrescar",
    "algo refrescante", "algo pra beber", "alguma coisa pra beber", "bebida gelada", "algo pra tomar"], [
    p("bebidas.agua", "agua mineral", "mata a sede de verdade"),
    p("bebidas.refrigerante", "refrigerante lata", "gelado e refrescante"),
    p("bebidas.suco", "suco", "refrescante, de fruta"),
    p("bebidas.agua_coco", "agua de coco", "hidrata e refresca"),
    p("doces.sorvete", "picole", "gelado pra aliviar o calor"),
    p("bebidas.isotonico", "isotonico", "repõe sais no calor")
  ], ["fast"]),
  need(["algo gelado", "coisa gelada", "gelado", "geladinho", "algo bem gelado"], [
    p("doces.sorvete", "sorvete", "gelado e pronto pra comer"),
    p("bebidas.refrigerante", "refrigerante lata", "bebida gelada"),
    p("bebidas.suco", "suco", "refrescante"),
    p("frios.iogurte", "iogurte", "gelado e leve")
  ], ["fast"]),
  need(["frio", "to com frio", "que frio", "dia frio", "friozinho", "algo quente", "coisa quente", "algo pra esquentar", "esquentar",
    "noite fria"], [
    p("mercado.sopa", "sopa", "quentinha e pronta em minutos"),
    p("mercado.cha", "cha", "bebida quente que aquece"),
    p("mercado.achocolatado", "chocolate quente", "chocolate quente pra esquentar"),
    p("mercado.cafe", "cafe", "bebida quente"),
    p("casa.manta_cobertor", "manta", "pra se enrolar no sofá")
  ]),
  need(["sono", "com sono", "to com sono", "cansado", "cansada", "cansaco", "to cansado", "to cansada", "sem energia", "to sem energia",
    "ficar acordado", "virar a noite", "estudar a noite", "preciso acordar", "despertar"], [
    p("mercado.cafe", "cafe", "a cafeína ajuda a despertar"),
    p("bebidas.energetico", "energetico", "cafeína e açúcar pra despertar"),
    p("doces.chocolate", "chocolate", "energia rápida"),
    p("mercado.barra_cereal", "barra de cereal", "lanche rápido que dá energia")
  ], ["fast"]),
  need(["ressaca", "de ressaca", "to de ressaca", "bebi demais", "exagerei na bebida", "bebi muito ontem"], [
    p("bebidas.isotonico", "isotonico", "repõe líquido e sais"),
    p("bebidas.agua_coco", "agua de coco", "hidrata"),
    p("bebidas.agua", "agua mineral", "hidratação"),
    p("mercado.sopa", "sopa", "leve e quente pro estômago")
  ], ["fast"]),
  need(["to doente", "to gripado", "to gripada", "to resfriado", "to resfriada", "comida de doente", "algo pra quem ta doente", "to mal"], [
    p("mercado.sopa", "canja", "leve e quentinha"),
    p("mercado.cha", "cha", "bebida quente que conforta"),
    p("bebidas.suco", "suco de laranja", "líquido e vitamina C"),
    p("hortifruti.frutas", "laranja", "fruta fresca"),
    p("bebidas.isotonico", "isotonico", "ajuda a manter a hidratação")
  ]),

  // ======================= VONTADES =======================
  need(["doce", "algo doce", "coisa doce", "um doce", "docinho", "vontade de doce", "vontade de comer doce", "sobremesa",
    "algo docinho", "adocar a boca", "comer um doce", "pra adocar"], [
    p("doces.chocolate", "chocolate", "o doce mais pedido"),
    p("doces.sorvete", "sorvete", "doce e gelado"),
    p("doces.bolo", "bolo pronto", "pronto pra comer"),
    p("doces.biscoito_doce", "biscoito recheado", "pacote pronto"),
    p("doces.doces", "brigadeiro", "docinho brasileiro: brigadeiro, paçoca, doce de leite")
  ]),
  need(["salgado", "algo salgado", "coisa salgada", "vontade de salgado", "petisco", "petiscar", "tira gosto", "aperitivo",
    "algo pra petiscar"], [
    p("snacks.salgadinho", "salgadinho", "pronto pra comer"),
    p("snacks.amendoim_castanhas", "amendoim", "petisco clássico"),
    p("snacks.biscoito_salgado", "biscoito salgado", "crocante e prático"),
    p("congelados.salgados", "mini salgados", "coxinha e kibe prontos em minutos"),
    p("frios.queijo", "queijo", "pra uma tábua de petiscos")
  ]),
  need(["algo leve", "comida leve", "lanche leve", "saudavel", "algo saudavel", "lanche saudavel", "comer bem", "comer melhor",
    "fit", "algo fit", "to de dieta", "dieta", "natural"], [
    p("hortifruti.frutas", "frutas", "fresca e leve"),
    p("frios.iogurte", "iogurte natural", "leve e com proteína"),
    p("mercado.barra_cereal", "barra de cereal", "lanche prático e leve"),
    p("snacks.amendoim_castanhas", "mix de castanhas", "gorduras boas e saciedade"),
    p("mercado.cereal_matinal", "granola", "fibra e energia")
  ], ["healthy"]),
  need(["algo gostoso", "coisa gostosa", "qualquer coisa gostosa", "me surpreende", "um mimo", "me mimar", "algo especial",
    "me agradar", "um agrado"], [
    p("doces.chocolate", "chocolate", "o mimo mais pedido"),
    p("doces.sorvete", "sorvete", "doce e gelado"),
    p("doces.chocolate_presente", "trufas", "chocolate fino"),
    p("doces.bolo", "bolo pronto", "pronto pra comer"),
    p("snacks.salgadinho", "salgadinho", "pra quem prefere salgado")
  ], ["good"]),
  need(["pos treino", "academia", "treino", "malhar", "proteina", "ganhar massa", "pre treino"], [
    p("farmacia.suplementos", "whey protein", "proteína prática"),
    p("mercado.barra_cereal", "barra de proteina", "lanche com proteína"),
    p("frios.iogurte", "iogurte proteico", "proteína e leve"),
    p("hortifruti.frutas", "banana", "energia rápida e natural"),
    p("bebidas.isotonico", "isotonico", "repõe sais do treino")
  ], ["healthy"]),

  // ======================= OCASIÕES =======================
  need(["churrasco", "churras", "fazer churrasco", "churrasquinho", "churrasco com os amigos", "assar uma carne", "carne pra assar"], [
    p("casa.churrasco", "carvao", "sem carvão não tem churrasco"),
    p("carnes.bovina", "picanha", "o corte mais pedido no churrasco"),
    p("carnes.linguica", "linguica toscana", "clássico da grelha"),
    p("padaria.pao_de_alho", "pao de alho", "acompanhamento da grelha"),
    p("bebidas.cerveja", "cerveja", "a bebida do churrasco"),
    p("bebidas.refrigerante", "refrigerante 2 litros", "pra quem não bebe")
  ]),
  need(["cafe da manha", "cafe da tarde", "desjejum", "breakfast", "cafe da manha especial", "cafe da manha completo"], [
    p("padaria.pao", "pao de forma", "base do café da manhã"),
    p("mercado.cafe", "cafe", "o café em si"),
    p("frios.leite", "leite", "pro café com leite"),
    p("frios.queijo", "queijo", "recheio do pão"),
    p("frios.requeijao_manteiga", "manteiga", "pra passar no pão"),
    p("hortifruti.frutas", "frutas", "fruta fresca")
  ]),
  need(["noite de filme", "ver filme", "assistir filme", "ver um filme", "maratona de serie", "maratonar", "cinema em casa", "filme"], [
    p("snacks.salgadinho", "pipoca de micro-ondas", "o clássico do filme"),
    p("doces.chocolate", "chocolate", "doce pra acompanhar"),
    p("bebidas.refrigerante", "refrigerante", "bebida do cinema"),
    p("doces.balas", "bala de goma", "beliscar durante o filme"),
    p("doces.sorvete", "sorvete pote", "sobremesa do sofá")
  ]),
  need(["festa infantil", "aniversario infantil", "festinha", "festa de crianca", "aniversario de crianca", "aniversario do meu filho",
    "aniversario da minha filha", "festa do meu filho", "festa da minha filha"], [
    p("festa.artigos", "baloes", "balões e vela de aniversário"),
    p("doces.balas", "balas sortidas", "docinhos pra mesa e saquinhos"),
    p("doces.chocolate", "bombom", "doce que criança adora"),
    p("bebidas.refrigerante", "refrigerante 2 litros", "bebida pra festa"),
    p("casa.descartaveis", "copo descartavel", "copos e pratos descartáveis"),
    p("snacks.salgadinho", "salgadinho", "salgado pronto pra mesa")
  ]),
  need(["festa", "festa de aniversario", "minha festa", "receber gente em casa", "fazer uma festa"], [
    p("bebidas.cerveja", "cerveja", "bebida da festa"),
    p("bebidas.refrigerante", "refrigerante 2 litros", "pra quem não bebe"),
    p("snacks.salgadinho", "salgadinho", "petisco pronto"),
    p("congelados.salgados", "mini salgados", "salgadinhos de festa em minutos"),
    p("doces.bolo", "bolo", "o bolo da festa"),
    p("casa.descartaveis", "copo descartavel", "copos e pratos descartáveis")
  ]),
  need(["happy hour", "reuniao com amigos", "juntar os amigos", "receber amigos", "resenha", "encontro com amigos", "assistir o jogo",
    "ver o jogo", "jogo do brasil", "futebol com os amigos", "sextou"], [
    p("bebidas.cerveja", "cerveja", "a bebida da resenha"),
    p("snacks.salgadinho", "salgadinho", "petisco pronto"),
    p("snacks.amendoim_castanhas", "amendoim", "petisco clássico de bar"),
    p("frios.frios", "salame", "pra tábua de frios"),
    p("bebidas.destilados", "caipirinha pronta", "drinks pra variar"),
    p("bebidas.refrigerante", "refrigerante", "pra quem não bebe")
  ]),
  need(["piquenique", "picnic"], [
    p("lanches.sanduiche", "sanduiche natural", "lanche pronto pra levar"),
    p("hortifruti.frutas", "frutas", "fresca e fácil de levar"),
    p("bebidas.suco", "suco de caixinha", "bebida individual"),
    p("doces.bolo", "bolo pronto", "doce pra dividir"),
    p("casa.descartaveis", "copo descartavel", "descartáveis pra levar")
  ]),
  need(["lanche da escola", "lancheira", "lanche escolar", "lanche pro meu filho", "lanche pra escola", "lanche das criancas"], [
    p("frios.iogurte", "iogurte", "prático pra lancheira"),
    p("bebidas.suco", "suco de caixinha", "porção individual"),
    p("hortifruti.frutas", "banana", "fruta fácil de levar"),
    p("doces.biscoito_doce", "biscoito", "lanche que criança gosta"),
    p("mercado.barra_cereal", "barra de cereal", "lanche individual")
  ]),
  need(["limpar a casa", "faxina", "dia de faxina", "limpeza da casa", "limpeza geral", "limpeza pesada", "casa suja"], [
    p("limpeza.multiuso", "limpador multiuso", "limpa quase tudo"),
    p("limpeza.desinfetante", "desinfetante", "desinfeta e perfuma o chão"),
    p("limpeza.esponja_pano", "pano de chao", "pano e esponja da faxina"),
    p("limpeza.vassoura_rodo", "rodo", "vassoura, rodo e balde"),
    p("limpeza.saco_lixo", "saco de lixo", "pra fechar a faxina"),
    p("limpeza.detergente", "detergente", "louça e gordura")
  ]),
  need(["limpar banheiro", "limpeza do banheiro", "banheiro sujo", "lavar o banheiro", "limpar a privada", "vaso sujo"], [
    p("limpeza.desinfetante", "agua sanitaria", "desinfeta vaso e box"),
    p("limpeza.multiuso", "limpador de banheiro", "tira limo e gordura do box"),
    p("limpeza.esponja_pano", "esponja", "pra esfregar"),
    p("limpeza.odorizador", "bloco sanitario", "deixa o vaso perfumado"),
    p("limpeza.papel_higienico", "papel higienico", "repor o básico")
  ]),
  need(["limpar cozinha", "limpeza da cozinha", "lavar louca", "louca suja", "fogao sujo", "cozinha engordurada"], [
    p("limpeza.detergente", "detergente", "lava louça e tira gordura"),
    p("limpeza.esponja_pano", "esponja", "esponja e pano de prato"),
    p("limpeza.multiuso", "desengordurante", "fogão e azulejo"),
    p("limpeza.papel_toalha", "papel toalha", "seca e limpa rápido"),
    p("limpeza.saco_lixo", "saco de lixo", "lixo da cozinha")
  ]),
  need(["lavar roupa", "roupa suja", "lavanderia", "lavar as roupas", "dia de lavar roupa"], [
    p("limpeza.lava_roupas", "sabao liquido", "lava as roupas"),
    p("limpeza.amaciante", "amaciante", "deixa macio e perfumado"),
    p("limpeza.desinfetante", "agua sanitaria", "pra roupa branca")
  ]),
  need(["casa nova", "mudei de casa", "mudanca", "apartamento novo", "me mudei", "primeiro apartamento"], [
    p("limpeza.multiuso", "limpador multiuso", "limpeza antes de arrumar"),
    p("casa.panelas", "jogo de panelas", "o básico da cozinha"),
    p("casa.pratos_travessas", "jogo de pratos", "pratos e tigelas"),
    p("casa.cama", "jogo de lencol", "roupa de cama"),
    p("casa.toalha", "jogo de toalhas", "toalhas de banho"),
    p("casa.iluminacao", "lampada led", "lâmpadas pra casa nova")
  ]),
  need(["praia", "dia de praia", "ir pra praia", "piscina", "dia de piscina", "praia amanha", "praia no fim de semana"], [
    p("beleza.protetor_solar", "protetor solar", "proteção contra queimadura"),
    p("casa.camping_praia", "cadeira de praia", "cadeira, cooler e guarda-sol"),
    p("bebidas.agua", "agua mineral", "hidratação no sol"),
    p("moda.praia", "biquini", "biquíni, maiô e sunga"),
    p("moda.chinelo", "chinelo", "o calçado da praia"),
    p("farmacia.repelente", "repelente", "contra mosquito no fim de tarde")
  ]),
  need(["viagem", "viajar", "vou viajar", "viagem de carro", "road trip", "fazer a mala", "ferias"], [
    p("moda.bolsa_mochila", "mala de viagem", "mala e mochila"),
    p("eletronico.acessorios_celular", "power bank", "bateria extra na estrada"),
    p("beleza.protetor_solar", "protetor solar", "protege no passeio"),
    p("farmacia.repelente", "repelente", "proteção contra mosquito"),
    p("snacks.amendoim_castanhas", "mix de castanhas", "lanche que não estraga na viagem"),
    p("casa.garrafa_termica", "garrafa termica", "água gelada no caminho")
  ]),
  need(["bebe novo", "bebe chegando", "enxoval", "enxoval de bebe", "cha de bebe", "cha de fralda", "nasceu meu filho",
    "nasceu minha filha", "vou ser mae", "vou ser pai"], [
    p("bebe.fralda", "fralda rn", "o item que mais acaba"),
    p("bebe.lenco_umedecido", "lenco umedecido", "troca de fralda"),
    p("farmacia.pomada_assadura", "pomada para assadura", "previne assadura"),
    p("bebe.higiene_bebe", "sabonete infantil", "banho do bebê"),
    p("bebe.mamadeira_chupeta", "mamadeira", "mamadeira e chupeta"),
    p("brinquedo.bebe", "mobile", "primeiro brinquedo")
  ]),
  need(["cachorro novo", "filhote de cachorro", "adotei um cachorro", "peguei um cachorro", "cachorrinho novo", "comprei um cachorro",
    "vou adotar um cachorro"], [
    p("pet.racao_cachorro", "racao filhote", "ração própria pra filhote"),
    p("pet.comedouro", "comedouro", "comedouro e bebedouro"),
    p("pet.cama", "cama para cachorro", "cantinho pra dormir"),
    p("pet.coleira", "coleira", "coleira e guia pro passeio"),
    p("pet.tapete_higienico", "tapete higienico", "pra ensinar o lugar do xixi"),
    p("pet.brinquedo", "mordedor", "brinquedo pra fase dos dentes")
  ], ["good"]),
  need(["gato novo", "filhote de gato", "adotei um gato", "peguei um gato", "gatinho novo", "comprei um gato", "vou adotar um gato"], [
    p("pet.racao_gato", "racao filhote gato", "ração própria pra filhote"),
    p("pet.areia_gato", "areia para gato", "areia e caixinha"),
    p("pet.comedouro", "comedouro", "comedouro e bebedouro"),
    p("pet.brinquedo", "arranhador", "arranhador poupa o sofá"),
    p("pet.cama", "cama para gato", "cantinho pra dormir"),
    p("pet.transporte", "caixa de transporte", "pra levar ao veterinário")
  ], ["good"]),
  need(["mimo pro cachorro", "presente pro cachorro", "agradar o cachorro", "agradar meu cachorro", "petisco pro cachorro"], [
    p("pet.petisco_cachorro", "petisco cachorro", "o mimo preferido"),
    p("pet.brinquedo", "brinquedo para cachorro", "diversão"),
    p("pet.cama", "cama para cachorro", "conforto")
  ]),
  need(["mimo pro gato", "presente pro gato", "agradar o gato", "agradar meu gato", "petisco pro gato"], [
    p("pet.petisco_gato", "petisco gato", "o mimo preferido"),
    p("pet.brinquedo", "brinquedo para gato", "diversão"),
    p("pet.cama", "cama para gato", "conforto")
  ]),
  need(["volta as aulas", "material escolar", "lista de material", "lista de material escolar", "inicio das aulas", "material pra escola"], [
    p("papelaria.material_escolar", "caderno", "cadernos, canetas e lápis"),
    p("papelaria.mochila_lancheira", "mochila escolar", "mochila e lancheira"),
    p("casa.garrafa_termica", "squeeze", "garrafinha pra escola"),
    p("livraria.infantil", "livro infantil", "leitura do ano")
  ]),
  need(["romantico", "noite romantica", "jantar romantico", "dia dos namorados", "encontro", "date", "surpresa romantica",
    "noite a dois"], [
    p("bebidas.vinho", "vinho tinto", "clássico da noite a dois"),
    p("doces.chocolate_presente", "caixa de bombons", "chocolate fino"),
    p("presente.flores", "buque de rosas", "flores entregues"),
    p("bebidas.espumante", "espumante", "pra brindar"),
    p("casa.vela_aromatizador", "vela aromatica", "clima")
  ], ["good"]),
  // "algo pra dormir" (revisão B1, 08/10): era a busca literal "dormir" (pijama); "ansioso"/"estressado"
  // chegam aqui como "relaxar" (detect.ts, revisão C2).
  need(["dormir melhor", "relaxar", "quero relaxar", "noite tranquila", "desestressar", "algo pra dormir", "pra dormir", "ajudar a dormir"], [
    p("mercado.cha", "cha de camomila", "bebida quente e calmante"),
    p("casa.vela_aromatizador", "vela aromatica", "ambiente relaxante"),
    p("casa.cama", "travesseiro", "conforto pra dormir"),
    p("casa.manta_cobertor", "manta", "aconchego")
  ]),
  need(["pele seca", "pele ressecada", "cuidar da pele", "rotina de skincare", "skincare"], [
    p("beleza.hidratante_corporal", "hidratante corporal", "hidrata a pele seca"),
    p("beleza.skincare_facial", "hidratante facial", "cuidado do rosto"),
    p("beleza.protetor_solar", "protetor solar facial", "protege a pele todo dia"),
    p("higiene.sabonete", "sabonete hidratante", "limpa sem ressecar")
  ], ["good"]),
  need(["cabelo cacheado", "cabelo seco", "cabelo danificado", "cuidar do cabelo", "cachos", "cabelo ressecado", "cabelo com frizz"], [
    p("beleza.shampoo", "shampoo cabelo cacheado", "limpeza do cabelo"),
    p("beleza.condicionador", "condicionador", "desembaraça e hidrata"),
    p("beleza.tratamento_capilar", "mascara capilar", "hidratação profunda"),
    p("beleza.tratamento_capilar", "creme de pentear", "define e controla o frizz")
  ], ["good"]),

  // ======================= PRESENTES =======================
  need(["presente pra minha mae", "presente pra mae", "presente pra mamae", "presente mae", "dia das maes", "aniversario da minha mae",
    "mimo pra minha mae", "presente para minha mae", "algo pra minha mae"], [
    p("beleza.perfume_feminino", "perfume feminino", "presente clássico pra mãe"),
    p("doces.chocolate_presente", "caixa de bombons", "chocolate fino de presente"),
    p("presente.flores", "buque de flores", "flores entregues em casa"),
    p("beleza.corpo_banho", "kit corpo e banho", "kit de hidratante e colônia"),
    p("beleza.kit_presente", "kit presente", "kit pronto pra presentear")
  ], ["good"]),
  need(["presente pro meu pai", "presente pro pai", "presente pai", "dia dos pais", "aniversario do meu pai", "presente para meu pai",
    "algo pro meu pai"], [
    p("beleza.perfume_masculino", "perfume masculino", "presente clássico pra pai"),
    p("bebidas.destilados", "whisky", "bebida de presente"),
    p("bebidas.vinho", "vinho tinto", "vinho de presente"),
    p("moda.camisa", "camisa social", "camisa pro dia a dia"),
    p("doces.chocolate_presente", "caixa de bombons", "chocolate fino")
  ], ["good"]),
  need(["presente pra namorada", "presente pra minha namorada", "presente namorada", "aniversario da minha namorada", "presente pra noiva"], [
    p("beleza.perfume_feminino", "perfume feminino", "presente que marca"),
    p("presente.flores", "buque de rosas", "flores entregues"),
    p("doces.chocolate_presente", "caixa de bombons", "chocolate fino"),
    p("brinquedo.pelucia", "urso de pelucia", "presente fofo"),
    p("beleza.corpo_banho", "kit corpo e banho", "kit perfumado")
  ], ["good"]),
  need(["presente pro namorado", "presente pro meu namorado", "presente namorado", "aniversario do meu namorado", "presente pro noivo"], [
    p("beleza.perfume_masculino", "perfume masculino", "presente que marca"),
    p("doces.chocolate_presente", "caixa de bombons", "chocolate fino"),
    p("eletronico.audio", "fone de ouvido bluetooth", "presente útil"),
    p("moda.camiseta", "camiseta", "roupa do dia a dia"),
    p("bebidas.destilados", "whisky", "bebida de presente")
  ], ["good"]),
  need(["presente pra esposa", "presente pra minha esposa", "presente pra minha mulher", "aniversario da minha esposa",
    "aniversario de casamento", "bodas"], [
    p("beleza.perfume_feminino", "perfume feminino", "presente clássico"),
    p("presente.flores", "buque de rosas", "flores entregues"),
    p("doces.chocolate_presente", "caixa de bombons", "chocolate fino"),
    p("bebidas.espumante", "espumante", "pra brindar a data"),
    p("beleza.kit_presente", "kit presente", "kit de beleza pronto")
  ], ["good"]),
  need(["presente pro marido", "presente pro meu marido", "aniversario do meu marido", "presente pro esposo"], [
    p("beleza.perfume_masculino", "perfume masculino", "presente clássico"),
    p("bebidas.destilados", "whisky", "bebida de presente"),
    p("bebidas.vinho", "vinho tinto", "vinho pra dividir"),
    p("doces.chocolate_presente", "caixa de bombons", "chocolate fino"),
    p("moda.camisa", "camisa", "roupa nova")
  ], ["good"]),
  need(["presente pra minha avo", "presente pra avo", "presente pra vovo", "presente pro meu avo", "presente pro vovo", "dia dos avos"], [
    p("presente.flores", "orquidea", "flores entregues em casa"),
    p("doces.chocolate_presente", "caixa de bombons", "chocolate fino"),
    p("casa.manta_cobertor", "manta", "presente aconchegante"),
    p("presente.cesta", "cesta de cafe da manha", "cesta pronta de presente"),
    p("beleza.perfume", "colonia", "perfume suave")
  ], ["good"]),
  need(["presente pra professora", "presente professora", "presente pro professor", "dia dos professores", "lembranca pra professora"], [
    p("doces.chocolate_presente", "caixa de bombons", "lembrança que agrada"),
    p("casa.caneca", "caneca", "lembrança útil"),
    p("presente.flores", "flores", "flores de agradecimento"),
    p("beleza.kit_presente", "kit presente", "kit de beleza pequeno"),
    p("papelaria.material_escolar", "agenda", "agenda ou caderno bonito")
  ]),
  need(["amigo secreto", "amigo oculto", "lembrancinha", "presente barato", "presente simples", "lembranca", "presentinho"], [
    p("doces.chocolate_presente", "caixa de bombons", "agrada quase todo mundo"),
    p("casa.caneca", "caneca", "presente útil e barato"),
    p("beleza.kit_presente", "kit presente", "kit de beleza pronto"),
    p("casa.vela_aromatizador", "vela aromatica", "presente pra casa"),
    p("bebidas.vinho", "vinho", "garrafa pra presentear"),
    p("brinquedo.pelucia", "pelucia", "presente fofo")
  ]),
  need(["presente pra amiga", "presente amiga", "aniversario da minha amiga", "presente pra uma amiga"], [
    p("beleza.perfume_feminino", "body splash", "perfume que agrada"),
    p("doces.chocolate_presente", "caixa de bombons", "chocolate fino"),
    p("presente.flores", "flores", "flores entregues"),
    p("beleza.corpo_banho", "kit corpo e banho", "kit perfumado"),
    p("casa.caneca", "caneca", "lembrança útil")
  ], ["good"]),
  need(["presente pra amigo", "presente amigo", "aniversario do meu amigo", "presente pra um amigo", "presente pro meu amigo"], [
    p("bebidas.destilados", "whisky", "bebida de presente"),
    p("beleza.perfume_masculino", "perfume masculino", "presente clássico"),
    p("bebidas.cerveja", "kit cerveja artesanal", "cervejas especiais"),
    p("doces.chocolate_presente", "caixa de bombons", "chocolate fino"),
    p("casa.caneca", "caneca", "lembrança útil")
  ], ["good"]),
  need(["presente pra bebe", "presente bebe", "presente de 1 ano", "bebe de 1 ano", "crianca de 1 ano", "presente pra recem nascido",
    "primeiro aniversario", "mesversario"], [
    p("brinquedo.bebe", "brinquedo para bebe", "brinquedo próprio pra idade"),
    p("brinquedo.pelucia", "pelucia", "macia e segura"),
    p("livraria.infantil", "livro de pano", "primeiros livros"),
    p("brinquedo.instrumentos_musicais", "brinquedo musical", "som e luz estimulam"),
    p("bebe.higiene_bebe", "kit banho bebe", "kit útil pros pais")
  ], ["good"]),
  need(["presente menino", "presente pra menino", "presente pro meu filho", "presente pro sobrinho", "presente pro meu sobrinho",
    ...ages(["menino", "garoto", "filho", "sobrinho"], 2, 7)], [
    p("brinquedo.carrinho", "carrinho de brinquedo", "carrinhos e pistas fazem sucesso nessa idade"),
    p("brinquedo.lego_blocos", "lego", "blocos de montar"),
    p("brinquedo.boneco", "boneco super heroi", "heróis e personagens"),
    p("brinquedo.ar_livre", "bola", "brincadeira ao ar livre"),
    p("brinquedo.pelucia", "pelucia", "presente fofo")
  ], ["good"]),
  need(["presente menina", "presente pra menina", "presente pra minha filha", "presente pra sobrinha", "presente pra minha sobrinha",
    ...ages(["menina", "garota", "filha", "sobrinha"], 2, 7)], [
    p("brinquedo.boneca", "boneca", "a mais pedida nessa idade"),
    p("brinquedo.faz_de_conta", "cozinha de brinquedo", "faz de conta"),
    p("brinquedo.arte", "massinha de modelar", "massinha e arte"),
    p("brinquedo.pelucia", "pelucia", "presente fofo"),
    p("brinquedo.lego_blocos", "lego", "blocos de montar")
  ], ["good"]),
  need(["presente pre adolescente", "presente pra crianca grande", ...ages(["menino", "menina", "crianca", "filho", "filha", "sobrinho", "sobrinha"], 8, 12)], [
    p("brinquedo.lego_blocos", "lego", "montagem desafiadora"),
    p("brinquedo.jogo_tabuleiro", "jogo de tabuleiro", "diversão em família"),
    p("brinquedo.cartas_colecionaveis", "cartas pokemon", "febre nessa idade"),
    p("livraria.quadrinhos", "manga", "leitura que prende"),
    p("brinquedo.ar_livre", "patinete", "brincadeira ao ar livre")
  ], ["good"]),
  need(["presente pra crianca", "presente crianca", "presente infantil", "presente pras criancas", "dia das criancas", "presente de dia das criancas"], [
    p("brinquedo.lego_blocos", "lego", "agrada várias idades"),
    p("brinquedo.pelucia", "pelucia", "presente fofo"),
    p("brinquedo.jogo_tabuleiro", "jogo de tabuleiro", "diversão em família"),
    p("brinquedo.arte", "massinha de modelar", "criatividade"),
    p("brinquedo.boneca", "boneca", "clássico"),
    p("brinquedo.carrinho", "carrinho de brinquedo", "clássico")
  ], ["good"]),
  need(["cesta de cafe da manha", "cesta de presente", "cafe da manha de presente", "cesta"], [
    p("presente.cesta", "cesta de cafe da manha", "cesta pronta entregue"),
    p("presente.flores", "buque de flores", "flores pra acompanhar"),
    p("doces.chocolate_presente", "caixa de bombons", "chocolate fino"),
    p("bebidas.espumante", "espumante", "pra brindar")
  ], ["good"]),
  need(["presente", "um presente", "presente de aniversario", "aniversario", "presentear", "presente pra alguem", "dar um presente",
    "presente bonito"], [
    p("beleza.perfume", "perfume", "presente que agrada"),
    p("doces.chocolate_presente", "caixa de bombons", "chocolate fino"),
    p("presente.flores", "buque de flores", "flores entregues"),
    p("beleza.kit_presente", "kit presente", "kit pronto pra presentear"),
    p("bebidas.vinho", "vinho", "garrafa pra presentear")
  ], ["good"])
];

// ---------------------------------------------------------------------------
// SINTOMA → REMÉDIO ISENTO (MIP) + CUIDADO
// Só classes isentas de prescrição no Brasil; consultas com princípios ativos e marcas isentas
// separados por " | ". A ordem dos picks é a do mais indicado. Remédio sempre sai com a copy de
// cuidado ("isento de receita; se não melhorar em 1–2 dias ou piorar, procure um médico; leia a bula").
// ---------------------------------------------------------------------------

export const SYMPTOM_TABLE: SymptomTableEntry[] = [
  {
    keys: ["dor de barriga", "dor na barriga", "barriga doendo", "colica intestinal", "colica na barriga", "colica abdominal",
      "dor abdominal", "barriga doi", "to com dor de barriga"],
    // Revisão A6 (08/10): loperamida só com diarreia dita (entrada "diarreia"); dor de barriga genérica
    // fica em antiespasmódico, antigases, probiótico e antiácido.
    picks: [
      mip("farmacia.antiespasmodico", "buscopan | butilescopolamina | buscopan composto", "alivia a cólica abdominal"),
      mip("farmacia.antigases", "simeticona | luftal", "alivia gases e estufamento"),
      mip("farmacia.probiotico", "probiotico | floratil | enterogermina", "ajuda a flora intestinal"),
      mip("farmacia.antiacido", "sal de fruta | eno | estomazil", "alivia o estômago embrulhado")
    ],
    care: [
      p("mercado.cha", "cha de camomila | cha de erva doce", "chá morno conforta a barriga"),
      p("bebidas.agua_coco", "agua de coco", "ajuda a manter a hidratação")
    ]
  },
  {
    keys: ["diarreia", "diarreia forte", "intestino solto", "desarranjo", "caganeira", "dor de barriga com diarreia", "intestino desregulado"],
    picks: [
      mip("farmacia.antidiarreico", "loperamida | Imosec | Diasec", "reduz as idas ao banheiro"),
      mip("farmacia.hidratacao_oral", "soro de reidratacao | hidraplex | floralyte", "repõe líquido e sais perdidos"),
      mip("farmacia.probiotico", "floratil | enterogermina | probiotico", "ajuda a flora intestinal"),
      mip("farmacia.antiespasmodico", "buscopan | butilescopolamina", "alivia a cólica que acompanha")
    ],
    care: [
      p("bebidas.agua_coco", "agua de coco", "hidratação"),
      p("bebidas.isotonico", "isotonico", "repõe sais")
    ]
  },
  {
    keys: ["azia", "queimacao", "queimacao no estomago", "ma digestao", "estomago queimando", "refluxo", "dor no estomago",
      "estomago embrulhado", "comi demais", "empachado", "gastrite"],
    picks: [
      mip("farmacia.antiacido", "sal de fruta | eno | estomazil | gaviscon | mylanta | hidroxido de aluminio", "neutraliza a acidez do estômago"),
      mip("farmacia.hepatoprotetor", "epocler | eparema", "ajuda na má digestão"),
      mip("farmacia.antigases", "simeticona | luftal", "alivia o estufamento")
    ],
    care: [p("mercado.cha", "cha de boldo | cha de camomila", "chá ajuda na digestão")]
  },
  {
    keys: ["gases", "gas", "estufamento", "estufado", "estufada", "barriga inchada", "flatulencia", "barriga estufada"],
    picks: [
      mip("farmacia.antigases", "simeticona | luftal", "alivia gases e estufamento"),
      mip("farmacia.antiespasmodico", "buscopan | butilescopolamina", "alivia a cólica dos gases"),
      mip("farmacia.probiotico", "probiotico | floratil", "ajuda a flora intestinal")
    ],
    care: [p("mercado.cha", "cha de erva doce | cha de camomila", "chá morno alivia o desconforto")]
  },
  {
    keys: ["enjoo", "enjoada", "enjoado", "nausea", "vontade de vomitar", "estomago embrulhado de enjoo", "mal estar no estomago", "nauseas"],
    picks: [
      mip("farmacia.hepatoprotetor", "eparema | epocler", "alivia enjoo da má digestão"),
      mip("farmacia.antiacido", "sal de fruta | eno | estomazil", "alivia o estômago embrulhado")
    ],
    care: [
      p("mercado.cha", "cha de gengibre | cha de camomila", "chá ajuda no enjoo"),
      p("snacks.biscoito_salgado", "biscoito agua e sal", "leve e seco, cai bem no enjoo"),
      p("bebidas.agua_coco", "agua de coco", "hidrata em goles pequenos")
    ]
  },
  {
    keys: ["dor de cabeca", "cabeca doendo", "dor na cabeca", "cefaleia", "to com dor de cabeca", "cabeca latejando"],
    picks: [
      mip("farmacia.analgesico", "dipirona | paracetamol | neosaldina | dorflex", "alivia a dor de cabeça"),
      mip("farmacia.anti_inflamatorio", "ibuprofeno | advil | alivium", "alivia dor e inflamação")
    ],
    care: [p("bebidas.agua", "agua mineral", "desidratação piora a dor de cabeça")]
  },
  {
    keys: ["enxaqueca", "crise de enxaqueca", "enxaqueca forte"],
    picks: [
      mip("farmacia.analgesico", "neosaldina | dipirona | paracetamol | doril enxaqueca", "alivia a dor da enxaqueca"),
      mip("farmacia.anti_inflamatorio", "ibuprofeno | advil", "alivia dor e inflamação")
    ],
    care: [p("bebidas.agua", "agua mineral", "hidratação")]
  },
  {
    keys: ["febre", "to com febre", "febril", "febrao", "corpo quente", "temperatura alta"],
    picks: [
      mip("farmacia.antitermico", "paracetamol | dipirona | ibuprofeno", "baixa a febre"),
      mip("farmacia.analgesico", "dipirona | paracetamol", "alivia o mal-estar")
    ],
    care: [
      p("farmacia.aparelhos_saude", "termometro digital", "acompanhar a temperatura"),
      p("bebidas.isotonico", "isotonico", "ajuda a manter a hidratação")
    ]
  },
  {
    keys: ["dor no corpo", "corpo doendo", "dor muscular", "dor nos musculos", "musculo dolorido", "corpo moido", "dor nas pernas",
      "dor no ombro"],
    picks: [
      mip("farmacia.relaxante_muscular", "dorflex | miorrelax", "relaxa o músculo e alivia a dor"),
      mip("farmacia.analgesico_topico", "salonpas | gelol | cataflam emulgel", "alívio local da dor muscular"),
      mip("farmacia.analgesico", "dipirona | paracetamol", "alivia a dor"),
      mip("farmacia.anti_inflamatorio", "ibuprofeno | advil", "alivia dor e inflamação")
    ]
  },
  {
    keys: ["dor nas costas", "dor na lombar", "dor lombar", "costas doendo", "torcicolo", "dor no pescoco", "travou as costas"],
    picks: [
      mip("farmacia.relaxante_muscular", "dorflex | miorrelax", "relaxa o músculo travado"),
      mip("farmacia.analgesico_topico", "salonpas | gelol | cataflam emulgel", "alívio local nas costas"),
      mip("farmacia.anti_inflamatorio", "ibuprofeno | advil", "alivia dor e inflamação")
    ]
  },
  {
    keys: ["dor de garganta", "garganta doendo", "garganta inflamada", "garganta arranhando", "dor pra engolir", "garganta irritada"],
    picks: [
      mip("farmacia.garganta", "strepsils | neopiridin | ciflogex | flogoral", "alivia a dor de garganta"),
      mip("farmacia.anti_inflamatorio", "ibuprofeno", "alivia dor e inflamação"),
      mip("farmacia.analgesico", "paracetamol | dipirona", "alivia a dor")
    ],
    care: [
      p("mercado.mel_geleia", "mel", "mel acalma a garganta"),
      p("mercado.cha", "cha de gengibre | cha com mel", "bebida morna conforta")
    ]
  },
  {
    keys: ["tosse seca", "tosse sem catarro", "tossindo seco", "tosse irritativa"],
    picks: [
      mip("farmacia.antitussigeno", "dropropizina | vibral | cloperastina", "acalma a tosse seca"),
      mip("farmacia.garganta", "strepsils | pastilha para garganta", "alivia a garganta irritada")
    ],
    care: [p("mercado.mel_geleia", "mel", "mel acalma a garganta")]
  },
  {
    keys: ["tosse com catarro", "catarro", "tosse com secrecao", "peito carregado", "muito catarro"],
    picks: [
      mip("farmacia.expectorante", "acetilcisteina | ambroxol | bromexina | xarope de guaco", "solta o catarro"),
      mip("farmacia.descongestionante", "soro nasal | sorine | vick vaporub", "alivia a congestão")
    ],
    care: [p("mercado.cha", "cha de gengibre | cha com mel", "líquido morno ajuda a soltar o catarro")]
  },
  {
    keys: ["tosse", "to tossindo", "tossindo muito", "xarope pra tosse"],
    picks: [
      mip("farmacia.expectorante", "xarope de guaco | acetilcisteina | ambroxol", "ajuda na tosse com catarro"),
      mip("farmacia.antitussigeno", "dropropizina | vibral", "acalma a tosse seca"),
      mip("farmacia.garganta", "strepsils | pastilha para garganta", "alivia a garganta irritada")
    ],
    care: [p("mercado.mel_geleia", "mel", "mel acalma a garganta")]
  },
  {
    keys: ["gripe", "gripado", "gripada", "resfriado", "resfriada", "constipado", "constipada", "to gripado", "to resfriado",
      "sintomas de gripe", "virose"],
    picks: [
      // Revisão A6 (08/10): antigripal com descongestionante — o aviso vai no motivo; quem diz "pressão
      // alta" cai no alerta antes (RED_FLAGS).
      mip("farmacia.antigripal", "cimegripe | benegrip | resfenol | naldecon", "alivia sintomas da gripe; não indicado para pressão alta"),
      mip("farmacia.antitermico", "paracetamol | dipirona", "baixa a febre e a dor"),
      mip("farmacia.descongestionante", "soro nasal | sorine | rinosoro", "desentope o nariz"),
      mip("farmacia.garganta", "strepsils | pastilha para garganta", "alivia a garganta")
    ],
    care: [
      p("mercado.cha", "cha de limao com mel | cha de gengibre", "líquido quente conforta"),
      p("mercado.sopa", "canja", "comida leve e quente"),
      p("bebidas.suco", "suco de laranja", "líquido e vitamina C")
    ]
  },
  {
    keys: ["nariz entupido", "nariz trancado", "congestao nasal", "nariz congestionado", "sinusite", "nariz escorrendo", "coriza"],
    picks: [
      mip("farmacia.descongestionante", "soro nasal | sorine | rinosoro | vick vaporub", "desentope e limpa o nariz"),
      mip("farmacia.antialergico", "loratadina | desloratadina", "reduz coriza de alergia")
    ],
    care: [p("limpeza.papel_toalha", "lenco de papel", "lenço de papel macio")]
  },
  {
    keys: ["alergia", "crise de alergia", "rinite", "rinite alergica", "espirrando", "espirro", "coceira", "comichao", "pele cocando",
      "olho cocando", "urticaria", "picada de inseto", "picada de mosquito"],
    picks: [
      mip("farmacia.antialergico", "loratadina | desloratadina | fexofenadina | allegra", "alivia espirro, coriza e coceira"),
      mip("farmacia.descongestionante", "soro nasal | sorine", "limpa o nariz")
    ],
    care: [
      p("limpeza.papel_toalha", "lenco de papel", "lenço de papel macio"),
      p("farmacia.repelente", "repelente", "evita novas picadas")
    ]
  },
  {
    keys: ["ressaca", "de ressaca", "to de ressaca", "bebi demais", "exagerei na bebida", "remedio pra ressaca"],
    // Revisão A6 (08/10): Engov tem AAS; analgésico/anti-inflamatório depois de álcool não. Ressaca = só hidratação.
    picks: [mip("farmacia.hidratacao_oral", "soro de reidratacao | hidraplex", "repõe líquido e sais")],
    care: [
      p("bebidas.isotonico", "isotonico", "repõe sais"),
      p("bebidas.agua_coco", "agua de coco", "hidrata"),
      p("bebidas.agua", "agua mineral", "hidratação")
    ]
  },
  {
    keys: ["colica menstrual", "colica de menstruacao", "colica", "to menstruada com colica", "dor de colica", "tpm"],
    picks: [
      mip("farmacia.antiespasmodico", "buscopan composto | butilescopolamina", "alivia a cólica"),
      mip("farmacia.anti_inflamatorio", "ibuprofeno | buscofem", "alivia dor e inflamação da cólica"),
      mip("farmacia.analgesico", "dipirona | paracetamol", "alivia a dor")
    ],
    care: [
      p("mercado.cha", "cha de camomila", "chá morno ajuda a relaxar"),
      p("higiene.absorvente", "absorvente", "absorvente e protetor diário")
    ]
  },
  {
    keys: ["insonia", "insonia leve", "nao consigo dormir", "sem sono", "dificuldade pra dormir", "dormir mal", "ansiedade leve", "agitado pra dormir"],
    picks: [mip("farmacia.calmante_natural", "maracuja | passiflora | melatonina | valeriana | seakalm", "fitoterápico que ajuda a relaxar")],
    care: [p("mercado.cha", "cha de camomila | cha de erva cidreira", "chá calmante antes de dormir")]
  },
  {
    keys: ["assadura", "assadura no bebe", "bebe assado", "bumbum assado", "assadura de fralda"],
    picks: [p("farmacia.pomada_assadura", "hipoglos | bepantol baby | desitin | pomada para assadura", "protege e acalma a pele assada")],
    care: [
      p("bebe.lenco_umedecido", "lenco umedecido sem perfume", "limpeza suave na troca"),
      p("bebe.fralda", "fralda", "trocar com frequência ajuda")
    ]
  },
  {
    keys: ["olho seco", "olho irritado", "olho vermelho", "olhos ardendo", "olho ardendo", "vista cansada", "olhos secos"],
    picks: [mip("farmacia.colirio", "colirio lubrificante | systane | lacrifilm | lacribell", "lubrifica e alivia o olho seco")]
  },
  {
    keys: ["prisao de ventre", "intestino preso", "constipacao", "nao consigo ir ao banheiro", "intestino travado", "sem evacuar"],
    picks: [
      mip("farmacia.laxante", "lactulose | muvinlax | peg lax | tamarine", "ajuda o intestino a funcionar"),
      mip("farmacia.probiotico", "probiotico | floratil", "ajuda a flora intestinal")
    ],
    care: [
      p("hortifruti.frutas", "mamao | ameixa", "frutas com fibra"),
      p("mercado.cereal_matinal", "aveia", "fibra no café da manhã")
    ]
  },
  {
    keys: ["dor de dente", "dente doendo", "dor no dente", "dente inflamado"],
    picks: [mip("farmacia.analgesico", "dipirona | paracetamol", "alivia a dor até a consulta no dentista")]
  },
  {
    keys: ["afta", "aftas", "ferida na boca", "machucado na boca"],
    picks: [mip("farmacia.boca", "omcilon orabase | ad muc | bismu jet | gel para afta", "protege e alivia a afta")],
    care: [p("higiene.bucal", "enxaguante bucal sem alcool", "higiene suave da boca")]
  },
  {
    keys: ["herpes", "herpes labial", "bolha no labio", "ferida no labio"],
    picks: [mip("farmacia.boca", "aciclovir creme | penvir labia", "creme para herpes labial")]
  },
  {
    keys: ["pe de atleta", "micose", "frieira", "micose de unha", "micose na pele", "coceira no pe", "fungo"],
    picks: [mip("farmacia.antifungico", "clotrimazol | miconazol | terbinafina | vodol", "trata a micose")]
  },
  {
    keys: ["queimadura de sol", "queimei no sol", "pele queimada de sol", "torrei no sol", "queimado de sol", "vermelho do sol"],
    picks: [mip("farmacia.analgesico", "paracetamol | dipirona", "alivia a dor da queimadura")],
    care: [
      p("beleza.hidratante_corporal", "gel pos sol | aloe vera", "acalma e hidrata a pele"),
      p("beleza.protetor_solar", "protetor solar", "proteger a pele nos próximos dias"),
      p("bebidas.agua", "agua mineral", "hidratação")
    ]
  },
  {
    keys: ["piolho", "piolhos", "lendea", "cabeca cocando de piolho"],
    picks: [mip("farmacia.piolho", "permetrina | deltametrina | pioletal", "elimina piolhos e lêndeas")]
  },
  {
    keys: ["intolerancia a lactose", "intolerante a lactose", "lactose me faz mal"],
    picks: [mip("farmacia.lactase", "lactase | zerolac | lacday", "ajuda a digerir a lactose")]
  },
  {
    keys: ["machucado", "corte", "cortei o dedo", "ralei o joelho", "arranhao", "ferimento", "queimadura leve", "queimei a mao"],
    picks: [mip("farmacia.antisseptico_cicatrizante", "antisseptico | merthiolate | nebacetin", "limpa e protege o machucado")],
    care: [p("farmacia.curativo", "curativo | band aid", "cobre e protege")]
  }
];

// ---------------------------------------------------------------------------
// SINAIS DE ALERTA (texto normalizado: sem acento, minúsculas, pontuação vira espaço)
// Revisão adversarial (08/10) A2/A3/A4: dois tipos.
//   - EMERGÊNCIA: vale em QUALQUER pedido (não só saúde) e sai antes de tudo, inclusive da IA ("tô com o
//     peito apertado e suando frio" virava sopa/chá). Padrões estreitos de propósito: "sem ar
//     condicionado", o vinho "Sangue de Boi" e "apaguei no sofá" não são emergência.
//   - CONTEXTO: só pesa em pedido de saúde ou quando o plano tem prateleira de remédio (mip): pet
//     doente, bebê/criança, idoso, gestante, comorbidade, há N dias, combinação de sintomas.
// A ordem importa: findRedFlag devolve o PRIMEIRO que casa (emergência antes).
// ---------------------------------------------------------------------------

export const PET_SICK_REASON = "pet doente: só veterinário";

const EMERGENCY_FLAGS: RedFlagRule[] = [
  { kind: "emergency", reason: "dor no peito", pattern: /\b(dor|dores|aperto|pressao|pontada|queimacao) no peito\b|\bpeito (doendo|apertado|apertando|pesado)\b|\bdor no braco esquerdo\b/ },
  { kind: "emergency", reason: "falta de ar", pattern: /\b(falta de ar|dificuldade (para|pra|de) respirar|nao (consigo|consegue|to conseguindo|ta conseguindo) respirar|respirando mal|respiracao curta|chiado no peito|cansaco pra respirar|sufocad[oa]|sufocando)\b|\bsem ar\b(?! condicionado)/ },
  { kind: "emergency", reason: "desmaio ou convulsão", pattern: /\b(desmai\w*|perdi a consciencia|perdeu a consciencia|convuls\w*|ataque epileptico)\b/ },
  { kind: "emergency", reason: "sangue", pattern: /\bsangue\b(?! de boi| bom)|\b(sangrando|sangramento|sangrou|sanguinolent[oa])\b|\bfezes? pretas?\b|\bcoco preto\b|\bvomit\w* (com )?borra\b/ },
  { kind: "emergency", reason: "confusão mental", pattern: /\b(confusao mental|desorientad[oa]|nao fala coisa com coisa|fala enrolada|boca torta|rosto torto|nao reconhece)\b/ },
  { kind: "emergency", reason: "alergia grave ou inchaço", pattern: /\b(inchaco|inchad[oa]s?|inchou|inchando)\b[a-z ]{0,20}\b(rosto|boca|labio|labios|lingua|garganta)\b|\b(rosto|boca|labios?|lingua|garganta) (inchad[oa]s?|inchando|inchou)\b|\b(choque anafilatico|anafilax\w*|alergia grave|garganta fechando|empolad\w* (no corpo todo|inteir\w*))\b/ },
  { kind: "emergency", reason: "suor frio", pattern: /\b(suando frio|suor frio)\b/ }
];

const CONTEXT_FLAGS: RedFlagRule[] = [
  // A3: pet doente nunca recebe remédio humano (nem recomendação de remédio): só veterinário.
  { kind: "context", reason: PET_SICK_REASON, pattern: /\b(?:meu|minha|o|a|do|da|no|na|pro|pra|nosso|nossa|seu|sua)\s+(?:cachorr\w*|cao|cadela|dog|doguinho|catioro|gat[oa]|gatinh[oa]|pet|filhote|passarinho|passaro|calopsita|papagaio|periquito|coelh\w*|hamster|peixinho|tartaruga)\b/ },
  { kind: "context", reason: "dor forte", pattern: /\bdor(es)?\b[a-z ]{0,20}\b(muito forte|forte demais|forte|fortissima|insuportavel|intensa|horrivel|absurda)\b|\b(muita|mta) dor\b|\bpior dor\b|\bnao (aguento|suporto)\b[a-z ]{0,15}\bdor\b/ },
  { kind: "context", reason: "vômito persistente", pattern: /\b(nao para de vomitar|vomitando muito|vomitei (varias|muitas) vezes|vomitando sem parar|desidratad[oa])\b/ },
  { kind: "context", reason: "febre alta", pattern: /\bfebre (muito )?alta\b|\bfebre\b[a-z ]{0,20}\b(39|4[0-2])\b|\b(39|4[0-2])( [0-9])?( graus)? de febre\b|\bfebre (ha|faz) (3|tres|4|quatro|5|cinco|varios) dias\b/ },
  { kind: "context", reason: "há vários dias", pattern: /\b(ha|faz|tem|desde|uns|umas|mais de|por)\b[a-z ]{0,12}\b(\d+|dois|duas|tres|quatro|cinco|seis|sete|varios|varias|muitos|alguns) dias\b|\b(\d+|uma|duas|tres|1|2|3) semanas?\b|\b(ha|faz|tem) (uma )?semana\b|\bdias seguidos\b|\bnao (passa|melhora|para)\b|\bsempre volta\b/ },
  { kind: "context", reason: "gestante ou amamentando", pattern: /\b(gravida|gestante|gestacao|amamentando|amamento|lactante)\b|\b(na|durante a|em) gravidez\b|\bestou de \d+ (semanas|meses) de gravidez\b/ },
  { kind: "context", reason: "bebê ou criança pequena", pattern: /^(?!.*\bassadura).*\b(recem nascido|recem nascida|bebe|bebes|nenem|lactente)\b|\b(\d|1\d|2[0-3]) mes(es)?\b|\b(filh[oa]|crianca|menin[oa]|sobrinh[oa])\b[a-z ]{0,10}\b(1|um) ano\b/ },
  // A4: criança com menos de 12 anos ou sem idade — remédio infantil é com o pediatra.
  { kind: "context", reason: "criança", pattern: /^(?!.*\bassadura).*\b(filh[oa]|filhinh[oa]|crianca|net[oa]|netinh[oa]|menin[oa]|garot[oa]|sobrinh[oa]|entead[oa]|afilhad[oa])s?\b(?!\s+(?:de |com |tem |que tem )?(?:1[2-9]|[2-9]\d)\s+anos)/ },
  // A4: idoso (60+ ou avô/avó).
  { kind: "context", reason: "idoso", pattern: /\b(idos[oa]s?|terceira idade)\b|\b(?:meu|minha|pro|pra|do|da|o|a|nosso|nossa)\s+(?:avo|avos|vovo|vo)\b|\b(?:[6-9]\d|1[01]\d) anos\b/ },
  // A4: comorbidades e remédio de uso contínuo.
  { kind: "context", reason: "pressão alta", pattern: /\b(hipertens\w*|pressao alta|tenho pressao|problema de pressao)\b/ },
  { kind: "context", reason: "diabetes", pattern: /\bdiabet\w*/ },
  { kind: "context", reason: "úlcera ou gastrite", pattern: /\b(ulcera|ulceras|gastrite)\b/ },
  { kind: "context", reason: "uso de anticoagulante", pattern: /\b(anticoagula\w*|marevan|xarelto|varfarina|warfarina|eliquis|clopidogrel)\b/ },
  { kind: "context", reason: "asma", pattern: /\b(asma|asmatic[oa]|bronquite)\b/ },
  { kind: "context", reason: "problema nos rins", pattern: /\b(renal|renais|insuficiencia renal|hemodialise|dialise|problema (?:nos|no|de) rins?)\b/ },
  { kind: "context", reason: "problema no fígado", pattern: /\b(hepat(?:ite|ica|ico)|cirrose|figado)\b/ },
  // A4: combinações de sintoma que pedem médico.
  { kind: "context", reason: "dor na barriga com febre", pattern: /^(?=.*\bfebre\b)(?=.*\b(barriga|abdominal|abdomen)\b)/ },
  { kind: "context", reason: "dor no lado direito da barriga", pattern: /^(?=.*\blado direito\b)(?=.*\b(dor|dores|doendo|doi|barriga|abdominal|abdomen|colica)\b)/ },
  { kind: "context", reason: "febre com pescoço duro", pattern: /^(?=.*\bfebre\b)(?=.*\b(pescoco|nuca)\b[a-z ]{0,10}\b(dur[oa]|rigid[oa]|travad[oa])\b)/ },
  { kind: "context", reason: "dor ao urinar", pattern: /\b(dor|dores|ardencia|ardendo|arde|ardor|queimacao|queimando|queima|doi|doendo)\b[a-z ]{0,12}\b(urinar|xixi|mijar|urina)\b|\b(xixi|urina)\b[a-z ]{0,10}\b(ardendo|doendo|escura)\b/ },
  { kind: "context", reason: "mistura de remédios", pattern: /\bja tomei\b|\b(posso|pode|da pra) (misturar|tomar junto|tomar com|tomar os dois)\b|\bmisturar (com|remedio|remedios)\b|\b(tomando|tomo) (outro|outros|varios) remedios?\b|\btomei [a-z]+ e [a-z]+\b/ },
  { kind: "context", reason: "confusão mental", pattern: /\bconfus[oa]\b/ }
];

export const RED_FLAGS: RedFlagRule[] = [...EMERGENCY_FLAGS, ...CONTEXT_FLAGS];

// ---------------------------------------------------------------------------
// Funções puras
// ---------------------------------------------------------------------------

// Palavras que não decidem o casamento por conjunto de palavras ("presente pra minha mae" casa
// "quero um presente bonito pra mae" pelas palavras presente + mae).
const STOP = new Set(["a", "o", "as", "os", "um", "uma", "de", "do", "da", "dos", "das", "pra", "pro", "pras", "pros", "para", "por",
  "com", "e", "em", "no", "na", "nos", "nas", "meu", "minha", "meus", "minhas", "to", "estou", "ta", "algo", "alguma", "coisa", "que", "se", "me"]);

function norm(text: string): string {
  return normalizeText(text ?? "");
}

function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

// Pontuação: vale mais a chave que casa MAIS palavras de conteúdo ("fome algo doce" vence "to com
// fome" em "to com fome, quero algo doce"); a frase contida ganha um bônus sobre o casamento por
// conjunto de palavras; igualdade vence tudo. Empate → a entrada que vem antes na tabela.
function keyScore(text: string, words: Set<string>, key: string): number {
  if (!key) return 0;
  if (text === key) return 100_000 + key.length;
  const content = key.split(" ").filter((w) => w && !STOP.has(w));
  const weight = Math.max(content.length, 1) * 100 + key.length / 100;
  if (` ${text} `.includes(` ${key} `)) return weight + 50;
  if (content.length >= 2 && content.every((w) => words.has(stem(w)))) return weight;
  return 0;
}

// Chave de sintoma de 1 palavra ambígua (revisão C3, 08/10): "corte de carne pro churrasco" virava
// curativo, "botijão de gás" virava antigases. Só casa se for a mensagem inteira ou com contexto de
// saúde colado ("tô com afta", "algo pra gases", "dor", "remédio").
const AMBIGUOUS_SYMPTOM_KEYS = new Set(["corte", "gas", "afta", "aftas", "fungo", "catarro"]);
const SYMPTOM_CONTEXT_RE = new RegExp(
  "\\b(?:to|tou|estou|ta|esta|tava|fiquei|ando|acordei) com (?:muito |muita |uns |umas |um |uma |essa |esse )?(?:gas|gases|afta|aftas|catarro|fungo|fungos|corte|cortes)\\b" +
    "|\\b(?:remedio|remedinho|dor|dores|doendo|doi|machuc\\w*|sangr\\w*|ferid\\w*|curativo|alivi\\w*|sintomas?|inflamad\\w*|infeccionad\\w*)\\b" +
    "|\\b(?:pra|para|contra) (?:o |a |os |as |essa |esse |minha |meu |um |uma )?(?:corte|cortes|gas|gases|afta|aftas|fungo|fungos|catarro)\\b"
);
export function symptomKeyAllowed(keyNorm: string, textNorm: string): boolean {
  if (!AMBIGUOUS_SYMPTOM_KEYS.has(keyNorm)) return true;
  return textNorm === keyNorm || SYMPTOM_CONTEXT_RE.test(textNorm);
}

function bestEntry<T extends { keys: string[] }>(table: readonly T[], text: string, keyOk?: (key: string, text: string) => boolean): T | null {
  const t = norm(text);
  if (!t) return null;
  const words = new Set(t.split(" ").map(stem));
  let best: T | null = null;
  let bestScore = 0;
  for (const entry of table) {
    let score = 0;
    for (const key of entry.keys) {
      const k = norm(key);
      if (keyOk && !keyOk(k, t)) continue;
      score = Math.max(score, keyScore(t, words, k));
    }
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

/** Necessidade → entrada da NEED_TABLE: igualdade, frase-chave contida, ou todas as palavras da chave. */
export function findNeed(needNorm: string): NeedTableEntry | null {
  return bestEntry(NEED_TABLE, needNorm);
}

/** Sintoma → entrada da SYMPTOM_TABLE (mesmo casamento de findNeed). */
export function findSymptom(textNorm: string): SymptomTableEntry | null {
  return bestEntry(SYMPTOM_TABLE, textNorm, symptomKeyAllowed);
}

/** Primeiro sinal de alerta presente no texto (normalizado aqui de novo, por garantia). */
export function findRedFlag(textNorm: string): RedFlagRule | null {
  const t = norm(textNorm);
  if (!t) return null;
  return RED_FLAGS.find((rule) => rule.pattern.test(t)) ?? null;
}

/** Só os sinais de EMERGÊNCIA (valem em qualquer pedido, saúde ou não). */
export function findEmergencyFlag(textNorm: string): RedFlagRule | null {
  const t = norm(textNorm);
  if (!t) return null;
  return EMERGENCY_FLAGS.find((rule) => rule.pattern.test(t)) ?? null;
}

const BY_ID = new Map<string, ShelfNode>(SHELF_MAP.shelves.map((s) => [s.id, s]));

export function shelfById(id: string): ShelfNode | null {
  return BY_ID.get(id) ?? null;
}

const DOMAIN_ORDER: ShelfDomain[] = ["mercado", "farmacia", "pet", "beleza", "casa", "brinquedo", "eletronico", "moda", "livraria", "presente"];
let promptCache: string | null = null;

/** O mapa em uma página para o prompt: "id | label | query | flags", agrupado por domínio. */
export function shelvesForPrompt(): string {
  if (promptCache !== null) return promptCache;
  const rank = (d: ShelfDomain) => {
    const i = DOMAIN_ORDER.indexOf(d);
    return i < 0 ? DOMAIN_ORDER.length : i;
  };
  const sorted = [...SHELF_MAP.shelves].sort((a, b) => rank(a.domain) - rank(b.domain) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  promptCache = sorted.map((s) => `${s.id} | ${s.label} | ${s.query} | ${(s.flags ?? []).join(",")}`).join("\n");
  return promptCache;
}
