// Gera o MAPA DE PRATELEIRAS da recomendação (08/10/2026, plano
// docs/plano-recomendacoes-2026-10-08.md §1.2): colapsa as ~6,8 mil strings de `category` dos
// catálogos reais (src/lib/stores/*-catalog.ts, ~97 mil itens) em ~150–250 nós (ShelfNode) que
// cabem no prompt — "o que a Lia vende" em uma página.
//
//   NODE_USE_ENV_PROXY=1 npx tsx scripts/build-shelf-map.mts            # escreve src/lib/recommend/shelf-map.ts
//   NODE_USE_ENV_PROXY=1 npx tsx scripts/build-shelf-map.mts --dry      # só imprime o resumo
//   NODE_USE_ENV_PROXY=1 npx tsx scripts/build-shelf-map.mts --report   # + categorias que não viraram nó
//
// Como colapsa (determinístico, sem rede, sem IA):
//   1. Cada item NÃO-remédio é casado com a tabela RULES (abaixo, curada e comentada): cada regra
//      é um "substantivo de prateleira" (chocolate, biscoito doce, ração de cachorro…) com regex
//      sobre a categoria normalizada e, opcionalmente, sobre o nome.
//      - Categoria: vence a regra cujo casamento TERMINA mais à direita (a folha da árvore achatada
//        fica no fim: "mercearia massas e molhos molho de tomate" → molho, não macarrão); empate →
//        casamento mais longo → ordem da tabela.
//      - Nome (categoria genérica — "mercearia", "frios", "pet" — ou sem regra): vence o casamento
//        que COMEÇA mais à esquerda (o substantivo vem primeiro: "Biscoito Recheado Chocolate").
//      - Portões de domínio: categoria de pet só cai em nó de pet; "livros" só em livraria; loja
//        especializada só nos domínios dela (Petz/Cobasi = pet, Fila = moda, Telhanorte = casa…).
//   2. Remédio: SÓ item `medicine: "mip"` (listas de isentos *-mip-catalog.ts) vira nó de
//      farmácia isenta (flag `mip`, id `farmacia.<classe>`), por princípio ativo/nome; item com
//      nome de receita (isPrescriptionText) NUNCA entra. Um isento pode cair em mais de uma classe
//      (dipirona = analgésico E antitérmico). Item não-MIP com cara de remédio (isMedicine /
//      isVeterinaryMedicine — as guardas de runtime das vitrines) é descartado.
//   3. Nó com < 8 itens some (ruído). Saída ordenada por id; `stores` = lojas com ≥ 2 itens no nó.
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeText, type CatalogItem } from "../src/lib/stores/types";
import { isMedicine, isVeterinaryMedicine } from "../src/lib/stores/anvisa";
import { isPrescriptionText } from "../src/lib/medicine";
import type { ShelfDomain, ShelfFlag, ShelfMap, ShelfNode } from "../src/lib/recommend/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORES_DIR = path.join(ROOT, "src/lib/stores");
const OUT_FILE = path.join(ROOT, "src/lib/recommend/shelf-map.ts");
const DRY = process.argv.includes("--dry");
const REPORT = process.argv.includes("--report");
const MIN_ITEMS = 8;

// ---------------------------------------------------------------------------
// Portões de domínio por loja. Loja especializada só alimenta os domínios dela: evita que "massa
// de modelar" (Ri Happy) vire macarrão ou "cha e cafe canecas" (Oxford) vire chá. Loja fora
// desta tabela (supermercados, farmácias, Americanas) pode cair em qualquer domínio.
const STORE_DOMAINS: Record<string, ShelfDomain[]> = {
  petz: ["pet"],
  cobasi: ["pet"],
  pbkids: ["brinquedo", "presente", "livraria"],
  rihappy: ["brinquedo", "presente", "livraria"],
  martinsfontes: ["livraria", "brinquedo", "presente"],
  livrariascuritiba: ["livraria", "brinquedo", "presente"],
  fila: ["moda"],
  underarmour: ["moda"],
  osklen: ["moda"],
  aramis: ["moda"],
  capodarte: ["moda"],
  cea: ["moda", "beleza", "casa", "brinquedo"],
  telhanorte: ["casa", "eletronico"],
  obramax: ["casa", "eletronico"],
  oxford: ["casa"],
  tokstok: ["casa"],
  brinox: ["casa"],
  mondial: ["eletronico", "casa"],
  philco: ["eletronico", "casa"],
  motorola: ["eletronico"],
  polishop: ["eletronico", "casa", "beleza"],
  casaevideo: ["casa", "eletronico", "moda", "brinquedo", "beleza", "livraria"],
  zonacriativa: ["casa", "presente", "livraria", "moda", "brinquedo", "eletronico"],
  boticario: ["beleza", "presente"],
  wepink: ["beleza", "presente"],
  epocacosmeticos: ["beleza", "presente"],
  creamy: ["beleza"],
  giulianaflores: ["presente", "casa", "mercado"],
  kopenhagen: ["mercado"],
  divvino: ["mercado"],
  imigrantes: ["mercado"]
};

// Categoria de pet: só nó de pet. "aves" sozinho NÃO entra (é açougue).
const PET_CTX = /\b(cachorros?|caes|cao|gatos?|pet|pets|petshop|pet shop|passaros|aquarios?|roedores?|lagartos|repteis|hamster|calopsitas?)\b/;
const BOOK_CTX = /\blivros?\b/;
// Categoria genérica demais para decidir sozinha (Carrefour: "mercearia", "frios", "pet"…): o
// nome do item decide primeiro; a categoria só se o nome não casar com nada.
const GENERIC_TAIL = /\b(bomboniere|outros|diversos|variados|promocoes|conveniencia alimentos|mercearia)$/;
const GENERIC_CAT = /^(mambo )?(mercearia|bebidas?|frios|padaria|higiene|limpeza|utilidades|pet|bebe|promocoes|outros|internacional|conveniencia|conveniencia alimentos|produtos combos|produtos|alimentos|alimentos e bebidas|mercearia e gastronomia|congelados|hortifruti|presentes|nossas linhas [a-z ]+|mil delicias|casa|saude|saude e bem estar|beleza)$/;

// Departamento (começo da categoria) de loja mista (Americanas, Casa&Vídeo, farmácias): "papelaria
// material escolar corretivo" não é maquiagem; "moveis quarto cama e base" não é base de maquiagem;
// "brinquedos dinossauros" + nome "Tubo…" não é hidráulica.
const DEPARTMENTS: [RegExp, ShelfDomain[]][] = [
  [/^(papelaria|livros e papelaria|material escolar)\b/, ["livraria", "presente"]],
  [/^moveis\b/, ["casa"]],
  [/^(brinquedos|bonecos e bonecas|jogos|baby brinquedos|brindes)\b/, ["brinquedo", "presente", "livraria"]],
  [/^(beleza|perfumaria|perfumes|dermocosmeticos|dermo e beleza|maquiagem|cabelos|cuidados com|cuidados pessoais|maos e unhas|higiene|skincare)\b/, ["beleza", "farmacia", "eletronico"]],
  [/^(cama mesa|cama, mesa|cama e banho|utilidades domesticas|mesa|decoracao|organizacao|casa e decor|casa e organizacao|cozinha|banheiros|servir|pratos|talheres|cha e cafe)\b/, ["casa"]],
  [/^(eletroportateis|eletrodomesticos|informatica|ar e ventilacao|tv|audio|celulares|telefonia|games|pecas)\b/, ["eletronico", "casa"]],
  [/^(ferramentas e construcao|materiais|pisos|tintas|ferragens|hidraulica|eletrica|loucas|metais|iluminacao|jardim|seguranca)\b/, ["casa", "eletronico"]],
  [/^(bebes|mamaes|mamae e bebe|mundo infantil)\b/, ["farmacia", "mercado", "brinquedo", "beleza"]],
  [/^(alimentos|mercearia|bebidas?|bebida alcoolica|bebida nao alcoolica|frios|laticinios|carnes|hortifruti|congelados|padaria|matinais|conveniencia|acougue|adega)\b/, ["mercado", "farmacia"]],
  [/^(esporte e lazer)\b/, ["brinquedo", "casa", "moda"]],
  [/^(moda|calcados?|confeccao|masculino|feminino|infantil roupas|outlet|colecao)\b/, ["moda"]],
  [/^automotivo\b/, []]
];

type Rule = {
  id: string;
  label: string;
  domain: ShelfDomain;
  query: string;
  aliases?: string[];
  flags?: ShelfFlag[];
  // Todas as regex têm que casar a categoria normalizada (sem acento, minúsculas).
  cat?: RegExp | RegExp[];
  notCat?: RegExp;
  // Casa o NOME (normalizado) quando a categoria é genérica ou não casou nenhuma regra.
  name?: RegExp;
  notName?: RegExp;
  // Exigência extra sobre "categoria + nome" (separa uma categoria mista pelo nome).
  needText?: RegExp;
  stores?: string[];
};

// Regra de remédio isento: casa "nome + categoria" normalizados de um item `medicine: "mip"`.
type MipRule = {
  id: string;
  label: string;
  query: string;
  aliases?: string[];
  match: RegExp;
  not?: RegExp;
};

// Formas tópicas/locais: tiram o item das classes orais (adesivo de Salonpas não é "analgésico
// pra dor de cabeça").
const TOPICAL = /\b(adesivos?|gel|pomadas?|spray|emulgel|balsamo|cremes?|patch|aerossol|aerosol|locao|colirio|nasal|vaginal|supositorios?|shampoo|esmalte)\b/;
const GRIPE = /\b(antigripal|gripe|gripal|cimegripe|benegrip|resfenol|naldecon|coristina|decongex|gripinew|apracur|pyrena|stilgrip|gripeol|coryzalia|multigrip|sinutab|resfriado)\b/;
const GARGANTA = /\b(garganta|strepsils|neopiridin|flogoral|ciflogex|benalet|cepacol|amidalin|pastilhas?)\b/;

// ---------------------------------------------------------------------------
// Remédio isento (MIP) → classe terapêutica. Só princípios ativos/marcas isentos no Brasil; os
// itens vêm das prateleiras de isentos das farmácias e ainda passam por isPrescriptionText.
const MIP_RULES: MipRule[] = [
  {
    id: "farmacia.analgesico", label: "Analgésicos (dipirona, paracetamol)", query: "dipirona",
    aliases: ["paracetamol", "dorflex", "neosaldina", "tylenol", "novalgina", "analgesico"],
    match: /\b(dipirona|paracetamol|acido acetilsalicilico|aspirina|novalgina|tylenol|dorflex|neosaldina|doril|sonridor|anador|lisador|torsilax|dorilen|buscofem|analgesic[oa]s?|engov)\b/,
    not: new RegExp(`${TOPICAL.source}|${GRIPE.source}|${GARGANTA.source}|antiespasmodic|hemorroid`)
  },
  {
    id: "farmacia.antitermico", label: "Antitérmicos (febre)", query: "paracetamol",
    aliases: ["dipirona", "ibuprofeno", "antitermico", "remedio para febre"],
    match: /\b(antitermic[oa]s?|dipirona|paracetamol|ibuprofeno|novalgina|tylenol|alivium|advil)\b/,
    not: new RegExp(`${TOPICAL.source}|${GRIPE.source}|${GARGANTA.source}`)
  },
  {
    id: "farmacia.anti_inflamatorio", label: "Anti-inflamatórios isentos (ibuprofeno, naproxeno)", query: "ibuprofeno",
    aliases: ["naproxeno", "advil", "alivium", "flanax", "anti-inflamatorio"],
    match: /\b(ibuprofeno|naproxeno|anti inflamatori[oa]s?|advil|alivium|buscofem|flanax|spidufen|buprovil|naxotec)\b/,
    not: new RegExp(`${TOPICAL.source}|${GARGANTA.source}|hemorroid|${GRIPE.source}`)
  },
  {
    id: "farmacia.relaxante_muscular", label: "Relaxantes musculares isentos (Dorflex, Miorrelax)", query: "dorflex",
    aliases: ["miorrelax", "relaxante muscular", "torsilax"],
    match: /\b(relaxantes? muscular(es)?|dorflex|miorrelax|mioflex|neosaldina muscular|torsilax)\b/,
    not: TOPICAL
  },
  {
    id: "farmacia.analgesico_topico", label: "Dor muscular local (adesivos, géis, pomadas)", query: "salonpas",
    aliases: ["gel anti-inflamatorio", "adesivo para dor", "cataflam emulgel", "bengue", "arnica gel"],
    match: /\b(salonpas|salompas|bengue|gelol|cataflam ?pro|emulgel|arnica|biofenac|andolba|calminex|traumeel|massageol|diclofenaco)\b|\b(adesivos?|gel|pomadas?|spray|aerossol|aerosol|balsamo|patch)\b.*\b(analgesic|anti inflamat|relaxante|dor muscular|antirreumatic)|\b(analgesic|anti inflamat|relaxante|dor muscular|antirreumatic)[a-z]*\b.*\b(adesivos?|gel|pomadas?|spray|aerossol|aerosol|balsamo|patch)\b/,
    not: /\b(garganta|bucal|hemorroid|vaginal|colirio|nasal)\b/
  },
  {
    id: "farmacia.antiacido", label: "Antiácidos (azia e queimação)", query: "sal de fruta",
    aliases: ["eno", "estomazil", "gaviscon", "luftagastro", "antiacido", "leite de magnesia"],
    match: /\b(antiacid[oa]s?|sal de fruta|eno|estomazil|gastrol|luftagastro|magnesia|hidroxido de (aluminio|magnesio)|gaviscon|sonrisal|engov|alka|stomaliv|mylanta|pepsamar|gastrogel|omeprazol|antiulceros[oa]s?|azia)\b/
  },
  {
    id: "farmacia.antiespasmodico", label: "Antiespasmódicos (cólica abdominal)", query: "buscopan",
    aliases: ["butilescopolamina", "escopolamina", "buscopan composto", "antiespasmodico"],
    match: /\b(antiespasmodic[oa]s?|buscopan|butilescopolamina|escopolamina|mirador|doralgina|atroveran|anti colica)\b/
  },
  {
    id: "farmacia.antigases", label: "Antigases (simeticona)", query: "simeticona",
    aliases: ["luftal", "antigases", "gases"],
    match: /\b(antigases|antiflatulent[oa]s?|simeticona|luftal|dimeticona|gastrogel)\b/
  },
  {
    id: "farmacia.antidiarreico", label: "Antidiarreicos (loperamida, Floratil)", query: "loperamida",
    aliases: ["imosec", "diasec", "floratil", "antidiarreico", "remedio para diarreia"],
    match: /\b(antidiarreic[oa]s?|loperamida|imosec|diasec|floratil|saccharomyces|florax|enterogermina)\b/
  },
  {
    id: "farmacia.probiotico", label: "Probióticos (flora intestinal)", query: "probiotico",
    aliases: ["floratil", "enterogermina", "florastor", "simbioflora", "lactobacilos"],
    match: /\b(probiotic[oa]s?|lactobacil[a-z]*|bifid[a-z]*|floratil|enterogermina|florastor|simbioflora|colidis|prohn|bifilac|lactosil flora|florax|probians|probid)\b/
  },
  {
    id: "farmacia.laxante", label: "Laxantes (prisão de ventre)", query: "lactulose",
    aliases: ["laxante", "dulcolax", "muvinlax", "tamarine", "colact", "peg lax"],
    match: /\b(laxantes?|lactulose|bisacodil|dulcolax|peg lax|muvinlax|colact|tamarine|lacto purga|naturetti|picossulfato|leite de magnesia|supositorios? de glicerina)\b/
  },
  {
    id: "farmacia.antiemetico", label: "Enjoo e náusea (Dramin, Meclin)", query: "dramin",
    aliases: ["dimenidrinato", "meclin", "remedio para enjoo"],
    match: /\b(antiemetic[oa]s?|antivertiginos[oa]s?|enjoo|meclin|meclizina|dramin|dimenidrinato)\b/
  },
  {
    id: "farmacia.hepatoprotetor", label: "Fígado e má digestão (Epocler, Eparema)", query: "epocler",
    aliases: ["eparema", "xantinon", "figatil", "boldo", "remedio para ma digestao"],
    match: /\b(hepatoprotetor(es)?|epocler|xantinon|hepatilon|figatil|steaton|silimarina|eparema|forfig|fitoterapic[oa]s? .*figado)\b/
  },
  {
    id: "farmacia.antialergico", label: "Antialérgicos (loratadina, fexofenadina)", query: "loratadina",
    aliases: ["desloratadina", "fexofenadina", "allegra", "dexclorfeniramina", "polaramine", "antialergico"],
    match: /\b(antialergic[oa]s?|loratadina|desloratadina|fexofenadina|dexclorfeniramina|bilastina|cetirizina|levocetirizina|allegra|polaramine|claritin|loratamed|reactine|polarminpro|antipruriginos[oa]s?)\b/,
    not: /\b(colirio|nasal|pomadas?|cremes?|gel|oftalmic[oa]s?|pastilhas?)\b/
  },
  {
    id: "farmacia.descongestionante", label: "Descongestionantes nasais e soro nasal", query: "descongestionante nasal",
    aliases: ["sorine", "rinosoro", "vick vaporub", "soro nasal", "nariz entupido"],
    match: /\b(descongestionantes?|nasal|sorine|rinosoro|neosoro|nafazolina|oximetazolina|afrin|vaporub|maxidrate|rinidon)\b/,
    not: /\b(colirio|oftalmic[oa]s?)\b/
  },
  {
    id: "farmacia.antigripal", label: "Antigripais (gripe e resfriado)", query: "antigripal",
    aliases: ["cimegripe", "benegrip", "resfenol", "naldecon", "coristina d", "remedio para gripe"],
    match: GRIPE
  },
  {
    id: "farmacia.antitussigeno", label: "Xaropes para tosse seca", query: "xarope tosse seca",
    aliases: ["dropropizina", "cloperastina", "antitussigeno"],
    match: /\b(antitussigen[oa]s?|dropropizina|levodropropizina|cloperastina|tosse seca|vibral|notuss|hytos|atossion)\b/
  },
  {
    id: "farmacia.expectorante", label: "Expectorantes (tosse com catarro)", query: "acetilcisteina",
    aliases: ["ambroxol", "bromexina", "xarope expectorante", "guaco", "mucosolvan", "bisolvon"],
    match: /\b(expectorantes?|acetilcisteina|ambroxol|bromexina|carbocisteina|guaifenesina|mucosolvan|fluimucil|bisolvon|guaco|melagriao|broncodilatador(es)?|ambroxmel)\b/
  },
  {
    id: "farmacia.garganta", label: "Dor de garganta (pastilhas e sprays)", query: "pastilha para garganta",
    aliases: ["strepsils", "neopiridin", "flogoral", "ciflogex", "benalet"],
    match: GARGANTA,
    not: /\b(antiacid[oa]s?|gastrol|mastigave(l|is))\b/
  },
  {
    id: "farmacia.hidratacao_oral", label: "Soro de reidratação oral", query: "soro de reidratacao",
    aliases: ["hidraplex", "floralyte", "pedialyte", "hidralyte", "reidratante"],
    match: /\b(reidrat[a-z]*|hidraplex|hidralyte|floralyte|pedialyte|para hidratacao)\b/,
    not: /\b(nasal|gel|colirio)\b/
  },
  {
    id: "farmacia.vitaminas", label: "Vitaminas isentas (vitamina C, D, complexo B)", query: "vitamina c",
    aliases: ["vitamina d", "complexo b", "polivitaminico", "zinco", "redoxon"],
    match: /\b(vitaminas?|polivitaminic[oa]s?|complexo b|vitamin|sany d|addera|depura|cewin|redoxon|centrum|zinco|calcio|omega 3|apevitin|cobavital|estimulantes? de apetite)\b/,
    not: /\b(hidroxido|magnesia|laxante|antiacid[oa]s?)\b/
  },
  {
    id: "farmacia.colirio", label: "Colírios lubrificantes e para olho irritado", query: "colirio lubrificante",
    aliases: ["systane", "optive", "lacrifilm", "colirio", "lagrima artificial"],
    match: /\b(colirios?|oftalmic[oa]s?|lacrima[a-z]*|systane|optive|lacrifilm|hylo|hyabak|cristalin|lacribell|lubrificantes? oculares?)\b/
  },
  {
    id: "farmacia.antifungico", label: "Antifúngicos para pele e unha (micose, frieira)", query: "clotrimazol",
    aliases: ["miconazol", "terbinafina", "cetoconazol creme", "pe de atleta", "micose"],
    match: /\b(antifungic[oa]s?|antimicotic[oa]s?|micoses?|frieira|pe de atleta|clotrimazol|miconazol|terbinafina|cetoconazol|tolnaftato|isoconazol|ciclopirox|loceryl|micolamina|vodol|fungos?)\b/,
    not: /\b(vaginal|vaginais|candidiase|gino|ovulos?)\b/
  },
  {
    id: "farmacia.candidiase", label: "Candidíase (cremes vaginais isentos)", query: "gino canesten",
    aliases: ["creme vaginal", "candidiase"],
    match: /\b(candidiase|vaginal|vaginais|gino canesten|vaginose|albocresil|ovulos? vaginais)\b/
  },
  {
    id: "farmacia.antisseptico_cicatrizante", label: "Antissépticos e cicatrizantes (cortes, queimaduras leves)", query: "antisseptico",
    aliases: ["merthiolate", "nebacetin", "cicatrizante", "povidine", "pomada cicatrizante"],
    match: /\b(antissepti[a-z]*|anti septi[a-z]*|cicatrizantes?|cicatriz[a-z]*|merthiolate|povidine|iodo|clorexidina|nebacetin|cutisanol|kollagenase|dersani|contractubex|furacin|permanganato|rifocina|neomicina|queimaduras?|kuramed)\b/,
    not: /\b(garganta|bucal|pastilhas?|hemorroid[a-z]*|vaginal)\b/
  },
  {
    id: "farmacia.boca", label: "Afta, herpes labial e dor de dente (géis e soluções)", query: "gel para afta",
    aliases: ["omcilon orabase", "ad muc", "penvir labia", "passaja", "herpes labial"],
    match: /\b(afta|aftas|ad muc|bismu jet|omcilon|orabase|gengiv[a-z]*|herpes|labia|penvir|aciclovir|dor de dente|passaja|nene dent|gel bucal|solucao bucal|anestesic[oa]s? bucal)\b/
  },
  {
    id: "farmacia.calmante_natural", label: "Calmantes fitoterápicos e sono leve", query: "maracuja calmante",
    aliases: ["seakalm", "calman", "pasalix", "sintocalmy", "melatonina", "passiflora"],
    match: /\b(calmantes?|seakalm|calman|pasalix|sintocalmy|maracujina|passiflora|valeriana|melatonina|ansiodoron|quietude|serenus|indutores? do sono|sedativ[oa]s?)\b/,
    not: /\b(camomilina|dentes?|dentição)\b/
  },
  {
    id: "farmacia.hematoma_varizes", label: "Hematomas e varizes (Hirudoid, Trombofob)", query: "hirudoid",
    aliases: ["trombofob", "pomada para roxo", "varizes"],
    match: /\b(hirudoid|trombofob|fledoid|topcoid|varizes|hematomas?|heparin[a-z]*|antiedematos[oa]s?|vasoprotetor(es)?)\b/
  },
  {
    id: "farmacia.hemorroida", label: "Hemorroida (pomadas)", query: "pomada para hemorroida",
    aliases: ["proctyl", "proctan", "ultraproct"],
    match: /\b(hemorroid[a-z]*|anti hemorroid[a-z]*|proctyl|proctan|proctfis|hemofiss|ultraproct|vasoconstritor(es)?)\b/
  },
  {
    id: "farmacia.piolho", label: "Piolho e sarna (permetrina)", query: "permetrina",
    aliases: ["deltametrina", "remedio para piolho", "keltrina"],
    match: /\b(piolhos?|lendeas?|permetrina|deltametri[a-z]*|keltrina|antiparasitari[oa]s?|escabiose|sanasar|anti helmintic[oa]s?)\b/
  },
  {
    id: "farmacia.parar_de_fumar", label: "Para parar de fumar (adesivo e goma de nicotina)", query: "adesivo de nicotina",
    aliases: ["nicorette", "niquitin", "goma de nicotina"],
    match: /\b(parar de fumar|nicotina|nicorette|niquitin|fumasil)\b/
  },
  {
    id: "farmacia.lactase", label: "Lactase (intolerância à lactose)", query: "lactase",
    aliases: ["zerolac", "lactosil", "enzima lactase"],
    match: /\b(lactase|zerolac|lacday|lactosil|enzimas?)\b/,
    not: /\bflora\b/
  }
];

// ---------------------------------------------------------------------------
// Tabela de colapso (curada, 08/10). Uma linha = um substantivo de prateleira. As regex são a
// tabela de sinônimos/normalização: tudo que a loja chama de "bomboniere chocolate", "bombons e
// chocolates", "chocolate e bombom" vira `doces.chocolate`.
const RULES: Rule[] = [
  // ======================= PET (só em categoria de pet ou loja de pet) =======================
  { id: "pet.racao_cachorro", label: "Ração para cachorro (seca e úmida)", domain: "pet", query: "racao cachorro", aliases: ["racao para caes", "sache cachorro", "racao umida cachorro"], flags: ["pet"],
    cat: [/\b(cachorros?|caes|cao)\b/, /\b(racao|racoes|alimentos?|alimentacao)\b/], notCat: /acessorios de alimentacao|comedouro/, name: /\b(racao|alimento|sache)\b.*\b(caes|cachorros?|cao|dog)\b/ },
  { id: "pet.racao_gato", label: "Ração e sachê para gato", domain: "pet", query: "racao gato", aliases: ["sache gato", "racao umida gato", "whiskas"], flags: ["pet"],
    cat: [/\b(gatos?)\b/, /\b(racao|racoes|alimentos?|alimentacao)\b/], notCat: /acessorios de alimentacao|comedouro/, name: /\b(racao|alimento|sache)\b.*\b(gatos?|cat)\b/ },
  { id: "pet.petisco_cachorro", label: "Petiscos e ossos para cachorro", domain: "pet", query: "petisco cachorro", aliases: ["bifinho", "osso para cachorro"], flags: ["pet"],
    cat: [/\b(cachorros?|caes|cao)\b/, /\b(petiscos?|ossos?|bifinhos?)\b/], name: /\b(petisco|bifinho|osso)\b.*\b(caes|cachorros?|cao)\b/ },
  { id: "pet.petisco_gato", label: "Petiscos para gato", domain: "pet", query: "petisco gato", aliases: ["churu", "dreamies"], flags: ["pet"],
    cat: [/\bgatos?\b/, /\bpetiscos?\b/], name: /\bpetisco\b.*\bgatos?\b/ },
  { id: "pet.areia_gato", label: "Areia e banheiro para gato", domain: "pet", query: "areia para gato", aliases: ["areia higienica", "granulado sanitario", "caixa de areia"], flags: ["pet"],
    cat: [/\bgatos?\b/, /\b(areias?|banheiros?|granulados?)\b/], name: /\b(areia|granulado) (higienic|sanitari)/ },
  { id: "pet.brinquedo", label: "Brinquedos e arranhadores para pet", domain: "pet", query: "brinquedo para cachorro", aliases: ["arranhador", "brinquedo para gato", "bolinha pet"], flags: ["pet"],
    cat: /\b(brinquedos?|arranhadores?)\b/ },
  { id: "pet.cama", label: "Camas, casinhas e cobertores pet", domain: "pet", query: "cama para cachorro", aliases: ["caminha pet", "casinha cachorro"], flags: ["pet"],
    cat: /\b(camas?|casinhas?|casas?|cobertores?|colchonetes?|almofadas?)\b/ },
  { id: "pet.coleira", label: "Coleiras, guias, peitorais e roupinhas", domain: "pet", query: "coleira", aliases: ["guia", "peitoral"], flags: ["pet"],
    cat: /\b(coleiras?|guias?|peitorais|enforcadores?|plaquinhas?)\b/ },
  { id: "pet.comedouro", label: "Comedouros e bebedouros pet", domain: "pet", query: "comedouro", aliases: ["bebedouro pet", "tigela pet"], flags: ["pet"],
    cat: /\b(comedouros?|bebedouros?|acessorios de alimentacao|fontes?)\b/ },
  { id: "pet.tapete_higienico", label: "Tapete higiênico e fraldas pet", domain: "pet", query: "tapete higienico", aliases: ["fralda pet", "sanitario canino"], flags: ["pet"],
    cat: /\b(tapetes?|fraldas?|sanitarios?|higienicos?)\b/ },
  { id: "pet.higiene", label: "Banho e higiene pet (shampoo, escova)", domain: "pet", query: "shampoo para cachorro", aliases: ["shampoo pet", "lenco umedecido pet", "escova pet"], flags: ["pet"],
    cat: /\b(beleza|limpeza|higiene|shampoos?|banho|tosa|escovas?|perfumes?|colonias?|odores?)\b/ },
  { id: "pet.transporte", label: "Caixas de transporte pet", domain: "pet", query: "caixa de transporte", aliases: ["bolsa de transporte pet"], flags: ["pet"],
    cat: /\btransportes?\b/ },
  { id: "pet.coleira", label: "Roupinhas", domain: "pet", query: "roupa para cachorro", aliases: ["roupinha pet"], flags: ["pet"],
    cat: /\b(roupas?|roupinhas?|moda|fantasias?)\b/ },
  { id: "pet.aquario", label: "Aquário e peixes (ração, filtro, decoração)", domain: "pet", query: "racao para peixe", aliases: ["aquario", "filtro aquario"], flags: ["pet"],
    cat: /\b(aquarios?|aquarismo|peixes)\b/ },
  { id: "pet.passaros", label: "Pássaros, roedores e répteis (alimento, gaiola, acessórios)", domain: "pet", query: "alimento para passaros", aliases: ["gaiola", "alpiste", "calopsita"], flags: ["pet"],
    cat: /\b(passaros|aves|calopsitas?)\b/, stores: ["petz", "cobasi"] },
  { id: "pet.passaros", label: "Roedores", domain: "pet", query: "racao para hamster", aliases: ["hamster", "porquinho da india", "reptil"], flags: ["pet"],
    cat: /\b(roedores?|hamster|coelhos?|lagartos|repteis|tartarugas?)\b/ },

  // ======================= FARMÁCIA — cuidado não-remédio =======================
  { id: "farmacia.pomada_assadura", label: "Pomada para assadura", domain: "farmacia", query: "pomada para assadura", aliases: ["hipoglos", "bepantol baby", "desitin", "creme para assadura"], flags: ["care", "kids"],
    cat: /\bassaduras?\b/, name: /\b(assaduras?|hipoglos|desitin|bepantol baby)\b/ },
  { id: "farmacia.soro_fisiologico", label: "Soro fisiológico", domain: "farmacia", query: "soro fisiologico", aliases: ["cloreto de sodio 0,9%", "soro para nariz"], flags: ["care"],
    cat: /\bsoro fisiologico\b/, name: /\b(soro fisiologico|cloreto de sodio 0 9)\b/ },
  { id: "farmacia.soro_reidratacao", label: "Soro e bebida de reidratação (sem remédio)", domain: "farmacia", query: "soro de reidratacao", aliases: ["floralyte", "pedialyte", "hidratacao oral"], flags: ["care"],
    cat: /\b(reidratac[a-z]*|reidratantes?)\b/, name: /\b(floralyte|pedialyte|hidralyte|hidraplex|reidratac[a-z]*|reidratante)\b/ },
  { id: "farmacia.curativo", label: "Curativos e primeiros socorros", domain: "farmacia", query: "curativo", aliases: ["band-aid", "esparadrapo", "gaze", "atadura"], flags: ["care"],
    cat: /\b(curativos?|primeiros socorros|esparadrapos?|gazes?|ataduras?|micropore|compressas?)\b/, notCat: /\b(seringas?|agulhas?|algodao)\b/, name: /\b(curativos?|band aid|esparadrapo|atadura|gaze)\b/ },
  { id: "farmacia.aparelhos_saude", label: "Termômetros", domain: "farmacia", query: "termometro", aliases: ["termometro digital"], flags: ["care"],
    cat: /\btermometros?\b/, name: /\btermometro\b/ },
  { id: "farmacia.compressa", label: "Bolsas térmicas e compressas", domain: "farmacia", query: "bolsa termica gel", aliases: ["compressa", "bolsa de agua quente"], flags: ["care"],
    cat: /\b(bolsas? de gel|bolsas? de agua quente|compressas? (quentes?|frias?|termicas?|de gel))\b/, name: /\b(bolsa termica (de gel|gel|para dor)|compressa (fria|quente|termica|de gel)|bolsa de agua quente|bolsa de gel)\b/ },
  { id: "farmacia.aparelhos_saude", label: "Termômetros e aparelhos de saúde (pressão, inalador, oxímetro)", domain: "farmacia", query: "medidor de pressao", aliases: ["inalador", "nebulizador", "oximetro"], flags: ["care"],
    cat: /\b(medidores? de pressao|aparelhos? de pressao|nebulizadores?|inaladores?|oximetros?|glicosimetros?|aparelhos? de saude|monitores? de pressao)\b/, name: /\b(medidor de pressao|monitor de pressao|nebulizador|inalador|oximetro)\b/ },
  { id: "farmacia.saude_sexual", label: "Preservativos e lubrificantes íntimos", domain: "farmacia", query: "preservativo", aliases: ["camisinha"],
    cat: /\b(preservativos?|camisinhas?)\b/, name: /\b(preservativo|camisinha)\b/ },
  { id: "farmacia.saude_sexual", label: "Lubrificantes", domain: "farmacia", query: "lubrificante intimo", aliases: ["gel lubrificante"],
    cat: /\b(lubrificantes? intimos?|saude sexual|bem estar sexual)\b/ },
  { id: "farmacia.teste_gravidez", label: "Testes de gravidez e ovulação", domain: "farmacia", query: "teste de gravidez", aliases: ["teste de ovulacao"], flags: ["care"],
    cat: /\btestes? de (gravidez|ovulacao)\b/, name: /\bteste de (gravidez|ovulacao)\b/ },
  { id: "farmacia.fralda_adulto", label: "Fraldas e roupa íntima geriátrica", domain: "farmacia", query: "fralda geriatrica", aliases: ["fralda adulto", "roupa intima descartavel"], flags: ["care"],
    cat: /\b(fraldas? (para )?adult[a-z]*|geriatric[a-z]*|incontinencia|roupa intima descartavel)\b/, name: /\b(fralda (geriatrica|adulto)|roupa intima descartavel|geriatrica)\b/ },
  { id: "farmacia.suplementos", label: "Suplementos (whey, colágeno, vitaminas)", domain: "farmacia", query: "suplemento", aliases: ["whey protein", "colageno", "multivitaminico", "omega 3", "creatina"], flags: ["care"],
    cat: /\b(suplementos?|vitaminas?|polivitaminic[oa]s?|colagenos?|whey|proteinas?|creatina|nutricao esportiva|omega 3|multivitaminic[oa]s?)\b/, notCat: /\b(barras?|barrinhas?)\b/ },
  { id: "farmacia.repelente", label: "Repelentes de insetos (pele)", domain: "farmacia", query: "repelente", aliases: ["off", "exposis", "repelente infantil"], flags: ["care"],
    cat: /\brepelentes?\b/, notCat: /\b(eletric[oa]s?|tomada|inseticidas?)\b/, name: /\brepelente\b/ },
  { id: "farmacia.alcool", label: "Álcool 70 e álcool em gel", domain: "farmacia", query: "alcool em gel", aliases: ["alcool 70", "alcool liquido"], flags: ["care"],
    cat: /\b(alcool|alcool gel|alcool em gel)\b/, notCat: /\b(sem alcool|bebidas?|cervejas?)\b/, notName: /\b(cerveja|limpador|multiuso)\b/, name: /^alcool\b/ },
  { id: "farmacia.mascara_luva", label: "Máscaras e luvas descartáveis", domain: "farmacia", query: "mascara descartavel", aliases: ["luva descartavel"], flags: ["care"],
    cat: /\b(mascaras? descartave(l|is)|mascaras? de protecao|luvas? descartave(l|is)|epi)\b/ },

  // ======================= BEBÊ =======================
  { id: "bebe.fralda", label: "Fraldas infantis", domain: "farmacia", query: "fralda", aliases: ["fralda pampers", "fralda huggies", "fralda descartavel"], flags: ["kids"],
    cat: /\bfraldas?\b/, notCat: /\b(adult[a-z]*|geriatric[a-z]*|pet|caes|tecido|incontinencia|troca de fraldas? lenc[a-z]*)\b/, name: /\bfraldas?\b(?!.*(geriatric|adulto|pet|caes))/ },
  { id: "bebe.lenco_umedecido", label: "Lenços umedecidos", domain: "farmacia", query: "lenco umedecido", aliases: ["toalhinha umedecida"], flags: ["kids"],
    cat: /\blencos? umedecidos?\b/, name: /\blencos? umedecidos?\b/ },
  { id: "bebe.mamadeira_chupeta", label: "Mamadeiras, chupetas e mordedores", domain: "farmacia", query: "mamadeira", aliases: ["chupeta", "mordedor", "bico de mamadeira"], flags: ["kids"],
    cat: /\b(mamadeiras?|chupetas?|bicos?|mordedores?|acessorios para amamentacao|amamentacao)\b/, name: /\b(mamadeira|chupeta|mordedor)\b/ },
  { id: "bebe.formula_infantil", label: "Fórmula e leite infantil", domain: "mercado", query: "formula infantil", aliases: ["leite em po infantil", "nan", "aptamil", "milnutri"], flags: ["kids"],
    cat: /\b(formulas?( infanti[a-z]*| de primeira infancia)?|leites? infanti[a-z]*|nutricao infantil|compostos? lacteos? infanti[a-z]*)\b/, notCat: /\b(maquiagem|cabelo|pet)\b/, name: /\b(formula infantil|leite infantil|composto lacteo infantil)\b/ },
  { id: "bebe.papinha", label: "Papinhas e alimentação infantil", domain: "mercado", query: "papinha", aliases: ["papinha nestle", "alimento infantil"], flags: ["kids", "ready_to_eat"],
    cat: /\b(papinhas?|alimentacao infantil|alimentos infantis|papas?)\b/, name: /\bpapinha\b/ },
  { id: "bebe.higiene_bebe", label: "Banho e higiene do bebê", domain: "farmacia", query: "shampoo infantil", aliases: ["sabonete infantil", "colonia infantil", "hidratante bebe"], flags: ["kids"],
    cat: /\b(mamaes? e bebes? banho|banho infantil|banho do bebe|higiene infantil|higiene do bebe|cuidados com o cabelo infantil|bebes? higiene|higiene oral infantil|mundo infantil [a-z ]*(cabelo|banho|hidrat|colonia|higiene)|cosmeticos? infanti[a-z]*)\b/, name: /\b(shampoo|sabonete|condicionador|colonia|hidratante)\b.*\b(infantil|bebe|baby|kids)\b/ },

  // ======================= BELEZA E HIGIENE =======================
  // Perfume: separa por gênero pelo nome/categoria; o resto fica no nó genérico (gift).
  { id: "beleza.perfume_feminino", label: "Perfumes femininos", domain: "beleza", query: "perfume feminino", aliases: ["colonia feminina", "eau de parfum feminino", "body splash"], flags: ["gift"],
    cat: /\b(perfumes?|^perfumaria$|colonias?|fragrancias?|eau de [a-z]+|body splash|deo colonia)\b/, notCat: /\b(desodorantes?|sabonetes?|shampoo|talco|intim[oa])\b/, needText: /\b(feminin[oa]s?|femme|woman|women|for her|ela|mulher|lady|girl)\b/ },
  { id: "beleza.perfume_masculino", label: "Perfumes masculinos", domain: "beleza", query: "perfume masculino", aliases: ["colonia masculina", "eau de toilette masculino"], flags: ["gift"],
    cat: /\b(perfumes?|^perfumaria$|colonias?|fragrancias?|eau de [a-z]+|deo colonia)\b/, notCat: /\b(desodorantes?|sabonetes?|shampoo|talco|intim[oa])\b/, needText: /\b(masculin[oa]s?|homme|men|man|for him|ele|homem|malbec|quasar|zaad)\b/ },
  { id: "beleza.perfume", label: "Perfumes e colônias", domain: "beleza", query: "perfume", aliases: ["colonia", "deo colonia", "body splash"], flags: ["gift"],
    cat: /\b(perfumes?|^perfumaria$|colonias?|fragrancias?|eau de [a-z]+|body splash)\b/, notCat: /\b(desodorantes?|sabonetes?|shampoo|talco|intim[oa])\b/, name: /\b(perfume|colonia|eau de (parfum|toilette)|body splash|deo parfum)\b/ },
  { id: "beleza.kit_presente", label: "Kits de presente de beleza", domain: "beleza", query: "kit presente", aliases: ["kit perfume", "kit boticario", "estojo presente"], flags: ["gift"],
    cat: /\b(kits?|presentes?|estojos?)\b/, needText: /\b(kits?|presentes?|estojos?|caixa presente)\b/, notCat: /\b(escolar|papelaria|ferramentas?|primeiros socorros|costura|unhas)\b/, name: /\b(kit presente|estojo|kit)\b.*\b(perfum|colonia|hidratante|body|banho|maquiagem|cuidados)/ },
  { id: "beleza.batom", label: "Batons e gloss", domain: "beleza", query: "batom", aliases: ["gloss", "batom liquido", "lip tint"],
    cat: /\b(batom|batons|labial|labios|gloss|lip)\b/, notCat: /\b(protetor labial|hidratante labial|herpes)\b/, name: /^(batom|gloss|lip tint)\b/ },
  { id: "beleza.maquiagem", label: "Olhos", domain: "beleza", query: "mascara de cilios", aliases: ["rimel", "delineador", "sombra", "lapis de olho"],
    cat: /\b(mascaras? de cilios|rimel|delineador(es)?|sombras?|lapis de olho|olhos|cilios|sobrancelhas?)\b/, notCat: /\b(area dos olhos|colirio|cuidados? com os olhos|tratamento)\b/ },
  { id: "beleza.maquiagem_pele", label: "Base, corretivo e pó", domain: "beleza", query: "base liquida", aliases: ["corretivo", "po compacto", "primer"],
    cat: /\b(bases?|corretivos?|pos? compactos?|pos? faciais?|pos? soltos?|primer|bb cream|cc cream|contorno|iluminador(es)?|blush|bronzers?)\b/, notCat: /\b(base de unha|base para unhas?|unhas|fortalecedor|moveis|cama|papelaria|escolar|fita)\b/ },
  { id: "beleza.maquiagem", label: "Maquiagem (olhos, sombra, rímel, pincéis)", domain: "beleza", query: "maquiagem", aliases: ["pincel de maquiagem", "paleta de sombra", "demaquilante"],
    cat: /\b(maquiage[mn][a-z]*|make|pinceis|esponjas? de maquiagem|acessorios de maquiagem)\b/, notCat: /\binfanti[a-z]*\b/, name: /\b(maquiagem|paleta)\b/ },
  { id: "beleza.esmalte", label: "Esmaltes e cuidados com as unhas", domain: "beleza", query: "esmalte", aliases: ["base para unha", "acetona", "lixa de unha", "removedor de esmalte"],
    cat: /\b(esmaltes?|unhas|manicure|acetona|removedor de esmalte)\b/, notCat: /\b(tintas?|pintura|sintetic[oa]s?|antifungic[a-z]*)\b/, name: /^esmalte\b/ },
  { id: "beleza.shampoo", label: "Shampoos", domain: "beleza", query: "shampoo", aliases: ["shampoo anticaspa", "shampoo cabelo cacheado"],
    cat: /\b(shampoos?|xampus?|cabel[a-z]*|capilar)\b/, needText: /\bshampoos?\b/, notCat: /\b(infantil|pet|caes|gatos?|seco)\b/, name: /^shampoo\b/ },
  { id: "beleza.condicionador", label: "Condicionadores", domain: "beleza", query: "condicionador", aliases: ["condicionador cabelo cacheado"],
    cat: /\b(condicionador(es)?|cabel[a-z]*|capilar)\b/, needText: /\bcondicionador(es)?\b/, notCat: /\binfantil\b/, name: /^condicionador\b/ },
  { id: "beleza.tinta_cabelo", label: "Tintas e coloração para cabelo", domain: "beleza", query: "tinta de cabelo", aliases: ["coloracao", "tintura", "descolorante"],
    cat: /\b(tintas? de cabelo|tinturas?|coloracao|coloracoes|descolorantes?|tonalizantes?)\b/, name: /^(tintura|coloracao|tinta para cabelo)\b/ },
  { id: "beleza.tratamento_capilar", label: "Máscaras, cremes e finalizadores de cabelo", domain: "beleza", query: "mascara capilar", aliases: ["creme de pentear", "leave-in", "oleo capilar", "finalizador"],
    cat: /\b(mascaras? (para cabelo|capilar(es)?)|cremes? (para cabelo|de pentear)|tratamentos? capilar(es)?|finalizador(es)?|leave in|oleos? capilar(es)?|ampolas?|^cabelos$|tratamentos? de cabelo|haircare|cuidados com o cabelo|oleos? e serum|cabelos? oleos?)\b/, notCat: /\b(infantil|acessorios para cabelos?|prancha|secador|escovas?|pentes?|tinta|coloracao|piolho|toalhas?|maquinas?)\b/, name: /\b(mascara capilar|creme de pentear|leave in|oleo capilar|finalizador)\b/ },
  { id: "beleza.acessorios_cabelo", label: "Escovas, pentes e acessórios de cabelo", domain: "beleza", query: "escova de cabelo", aliases: ["pente", "elastico de cabelo", "presilha"],
    cat: /\b(acessorios (para|de) cabel[a-z]*|escovas? de cabelo|pentes?|elasticos?|presilhas?|tiaras?|piranhas?)\b/, notCat: /\b(prancha|secador|eletric)\b/ },
  { id: "beleza.protetor_solar", label: "Protetor solar", domain: "beleza", query: "protetor solar", aliases: ["protetor solar facial", "fps 50", "bronzeador"], flags: ["care"],
    cat: /\b(protetor(es)? solar(es)?|protecao solar|solar|fotoprotet[a-z]*|bronzeador(es)?|bronzeamento)\b/, notCat: /\b(energia|painel|lampada|luminaria|carregador)\b/, name: /^(protetor solar|fotoprotetor|bronzeador)\b/ },
  { id: "beleza.pos_sol", label: "Pós-sol e alívio de queimadura solar", domain: "beleza", query: "pos sol", aliases: ["gel pos sol", "aloe vera", "after sun"], flags: ["care"],
    cat: /\b(pos sol|apos sol|after sun)\b/, name: /\b(pos sol|apos sol|after sun|pos praia)\b/ },
  { id: "beleza.skincare_facial", label: "Cuidados com o rosto (limpeza, sérum, hidratante facial)", domain: "beleza", query: "hidratante facial", aliases: ["serum facial", "sabonete facial", "agua micelar", "creme antirrugas", "acne"],
    cat: /\b(rosto|facial|faciais|serum|serums|antissinais|anti idade|anti aging|antiacne|acne|limpeza e tonificacao|skincare|skin care|demaquilantes?|agua micelar|tonicos?|esfoliantes?|area dos olhos|clareadores?|antioxidantes?|tratamento para o rosto|dermocosmeticos? tratamento|dermocosmeticos (gel|creme|serum)|limpeza facial|hidratacao$)\b/, notCat: /\b(protetor|solar|maquiagem|base|cabel[a-z]*|capilar(es)?)\b/, name: /\b(serum|hidratante facial|creme facial|sabonete facial|agua micelar|gel de limpeza facial|tonico facial|creme anti[a-z]*)\b/ },
  // Creamy: só skincare, em "produtos combos".
  { id: "beleza.skincare_facial", label: "Creamy", domain: "beleza", query: "hidratante facial", cat: /\bprodutos\b/, stores: ["creamy"] },
  { id: "beleza.hidratante_corporal", label: "Hidratantes e loções corporais", domain: "beleza", query: "hidratante corporal", aliases: ["locao hidratante", "creme para o corpo", "oleo corporal", "manteiga corporal"], flags: ["care"],
    cat: /\b(hidratantes?|hidratacao corporal|locoes?|locao|cremes? (corporal|para o corpo|para maos|para pes)|oleos? corporal|corpo|maos e pes|cuidados com o corpo|cuidados corporais|tratamento para o corpo|desodorantes? para os pes)\b/, notCat: /\b(facial|rosto|labial|cabelo|capilar|infantil|bebe|pet)\b/, name: /\b(hidratante|locao hidratante|creme hidratante|oleo corporal|body lotion|manteiga corporal)\b/ },
  { id: "beleza.corpo_banho", label: "Corpo e banho de presente (Boticário, WePink)", domain: "beleza", query: "kit corpo e banho", aliases: ["body splash", "hidratante perfumado", "sabonete liquido perfumado"], flags: ["gift"],
    cat: /\b(corpo e banho|corpo|banho|body)\b/, stores: ["boticario", "wepink", "epocacosmeticos", "polishop", "creamy"] },
  { id: "higiene.sabonete", label: "Sabonetes", domain: "beleza", query: "sabonete", aliases: ["sabonete liquido", "sabonete em barra", "sabonete intimo"],
    cat: /\bsabonetes?\b/, notCat: /\b(infantil|bebe|facial|rosto|pet)\b/, name: /^sabonete\b/ },
  { id: "higiene.desodorante", label: "Desodorantes", domain: "beleza", query: "desodorante", aliases: ["desodorante aerosol", "desodorante roll on", "antitranspirante"],
    cat: /\b(desodorantes?|antitranspirantes?)\b/, notCat: /\b(colonias?|pes|intimo)\b/, notName: /\bcolonia\b/, name: /^(desodorante|antitranspirante)\b(?!.*colonia)/ },
  { id: "higiene.escova_dente", label: "Escovas de dente", domain: "beleza", query: "escova de dente", aliases: ["escova dental", "escova eletrica"],
    cat: /\b(escovas? de dentes?|escovas? dentais?|escovas? dental)\b/, notCat: /\binfantil\b/, name: /^escova (de dente|dental)\b/ },
  { id: "higiene.creme_dental", label: "Pasta de dente", domain: "beleza", query: "creme dental", aliases: ["pasta de dente", "colgate", "sensodyne"],
    cat: /\b(pastas? de dentes?|cremes? dentais?|creme dental|gel dental)\b/, name: /^(creme dental|pasta de dente|gel dental)\b/ },
  { id: "higiene.bucal", label: "Enxaguante bucal e fio dental", domain: "beleza", query: "enxaguante bucal", aliases: ["fio dental", "listerine", "antisseptico bucal"],
    cat: /\b(enxaguantes?|antissepticos? bucais?|fios? dentais?|fio dental|higiene bucal|higiene oral|saude bucal|fixador para dentadura|dentaduras?)\b/, notCat: /\binfantil\b/, name: /^(enxaguante|fio dental|antisseptico bucal)\b/ },
  { id: "higiene.absorvente", label: "Absorventes, coletor e higiene íntima", domain: "beleza", query: "absorvente", aliases: ["absorvente noturno", "protetor diario", "coletor menstrual", "absorvente interno"], flags: ["care"],
    cat: /\b(absorventes?|protetor(es)? diarios?|coletor(es)? menstrua[a-z]*|calcinhas? absorventes?)\b/, name: /^(absorvente|protetor diario)\b/ },
  { id: "higiene.absorvente", label: "Íntima", domain: "beleza", query: "sabonete intimo", aliases: ["lenco intimo", "desodorante intimo"],
    cat: /\b(higiene intima|intimos?)\b/, notCat: /\b(absorventes?|preservativos?|lubrificantes?|fraldas?)\b/ },
  { id: "higiene.barbear", label: "Barbear e depilação (aparelho, lâmina, espuma, cera)", domain: "beleza", query: "aparelho de barbear", aliases: ["lamina de barbear", "espuma de barbear", "gillette", "pos barba"],
    cat: /\b(barbear|barba|barbeador(es)? descartave(l|is)|laminas?|pos barba|apos barba|espumas? de barbear)\b/, notCat: /\beletric[oa]s?\b/, name: /\b(aparelho de barbear|lamina de barbear|espuma de barbear|gel de barbear|pos barba)\b/ },
  { id: "higiene.barbear", label: "Depilação", domain: "beleza", query: "cera depilatoria", aliases: ["creme depilatorio", "aparelho depilatorio"],
    cat: /\b(depila[a-z]*|ceras?)\b/, notCat: /\b(eletric[oa]s?|depilador(es)?|carro|automotiv[a-z]*|piso|moveis)\b/, name: /\b(cera depilatoria|creme depilatorio|depilatori)/ },
  { id: "higiene.algodao_cotonete", label: "Algodão e hastes flexíveis", domain: "beleza", query: "algodao", aliases: ["cotonete", "haste flexivel", "disco de algodao"],
    cat: /\b(algodao|algodoes|cotonetes?|hastes? flexive(l|is))\b/, name: /^(algodao|haste flexivel|cotonete)\b/ },
  { id: "casa.vela_aromatizador", label: "Óleos essenciais", domain: "casa", query: "oleo essencial", aliases: ["oleo essencial lavanda", "aromaterapia"],
    cat: /\b(oleos? essencia(l|is)|aromaterapia|aromaterapicos?)\b/ },

  // ======================= MERCADO — doces e lanches =======================
  { id: "mercado.achocolatado", label: "Achocolatados e chocolate em pó", domain: "mercado", query: "achocolatado", aliases: ["nescau", "toddy", "chocolate em po", "chocolate quente"],
    cat: /\b(achocolatados?|chocolates? em po|cacau em po|bebidas? lacteas? achocolat[a-z]*)\b/, name: /^(achocolatado|chocolate em po|cacau em po|chocolate quente)\b|\b(nescau|toddy)\b/ },
  { id: "doces.chocolate_presente", label: "Chocolates finos e caixas de presente (Kopenhagen)", domain: "mercado", query: "caixa de bombons", aliases: ["chocolate para presente", "kopenhagen", "trufas", "caixa de chocolate", "ovo de pascoa"], flags: ["ready_to_eat", "gift"],
    cat: /\b(presentes?|nossas linhas|mil delicias|chocolates?|bombons?|bombom|trufas?|pascoa)\b/, needText: /\b(kopenhagen|caixas?|presentes?|kit|cestas?|latas?|sortid[oa]s|trufas?|ovos? de pascoa|nossas linhas|mil delicias|lingua de gato)\b/, notCat: /\b(biscoit[a-z]*|cookies?|bolos?|sorvetes?|achocolat[a-z]*|cereal)\b/ },
  // Kopenhagen inteira é chocolate fino de presente (categorias "presentes", "nossas linhas", "classicos").
  { id: "doces.chocolate_presente", label: "Kopenhagen", domain: "mercado", query: "caixa de bombons", flags: ["ready_to_eat", "gift"], cat: /[a-z]/, stores: ["kopenhagen"] },
  { id: "doces.chocolate", label: "Chocolates e bombons", domain: "mercado", query: "chocolate", aliases: ["barra de chocolate", "bombom", "chocolate ao leite", "kit kat", "trufa"], flags: ["ready_to_eat", "gift"],
    cat: /\b(chocolates?|bombons?|bombom|tabletes?|trufas?|pascoa)\b/, notCat: /\b(achocolat[a-z]*|em po|confeitaria|coberturas?|biscoit[a-z]*|cookies?|bebidas? lacteas?|sorvetes?)\b/, name: /^(chocolate|bombom|bombons|tablete|barra de chocolate|trufa|kit kat|kitkat|bis|talento|baton|lacta|shot|prestigio|sonho de valsa|ouro branco|chokito|suflair|alpino|twix|snickers|m m s?|ferrero|lindt)\b/ },
  { id: "doces.balas", label: "Balas, chicletes, pastilhas e confeitos", domain: "mercado", query: "bala", aliases: ["chiclete", "pastilha", "jujuba", "pirulito", "halls", "mentos", "fini"], flags: ["ready_to_eat"],
    cat: /\b(balas?|chicletes?|gomas? de mascar|pastilhas?|confeitos?|pirulitos?|jujubas?|gomas?|drops|marshmallows?)\b/, notCat: /\b(garganta|bombons?|chocolates?|biscoit[a-z]*)\b/, name: /^(bala|balas|drops|chiclete|goma de mascar|pastilha|pirulito|jujuba|fini|halls|mentos|trident|tic tac|marshmallow)\b/ },
  { id: "doces.doces", label: "Doces (paçoca, doce de leite, goiabada, brigadeiro, pudim)", domain: "mercado", query: "doce de leite", aliases: ["pacoca", "goiabada", "brigadeiro", "pe de moleque", "cocada", "pudim"], flags: ["ready_to_eat"],
    cat: /\b(doces?|pacocas?|doce de leite|goiabadas?|brigadeiros?|cocadas?|sobremesas?( lacteas?| prontas?)?|pudins? prontos?|mousses?|doces caseiros|doces em pasta)\b/, notCat: /\b(biscoit[a-z]*|chocolates?|bombons?|sorvetes?|confeitaria|po para|em po|gelatina|misturas?|batata doce|milho doce)\b/, name: /^(pacoca|doce de leite|goiabada|brigadeiro|pe de moleque|cocada|pudim|mousse|doce de|bananada|marmelada|quindim)\b/ },
  { id: "doces.sorvete", label: "Sorvetes, picolés e açaí", domain: "mercado", query: "sorvete", aliases: ["picole", "pote de sorvete", "kibon", "gelato"], flags: ["ready_to_eat", "cold"],
    cat: /\b(sorvetes?|picoles?|gelatos?|sorveteria)\b/, notCat: /\b(massa de modelar|casquinhas? para)\b/, name: /^(sorvete|picole|gelato|kibon|magnum|cornetto)\b/ },
  { id: "doces.sorvete", label: "Açaí", domain: "mercado", query: "acai", aliases: ["acai na tigela", "polpa de acai"], flags: ["cold", "ready_to_eat"],
    cat: /\bacai\b/, name: /^acai\b/ },
  { id: "doces.bolo", label: "Bolos, bolinhos e tortas prontas", domain: "mercado", query: "bolo pronto", aliases: ["bolinho", "torta doce", "panetone", "rocambole", "brownie", "waffle"], flags: ["ready_to_eat"],
    cat: /\b(bolos?|bolinhos?|tortas? doces?|tortas?|panetones?|panettones?|natalinos|chocotones?|rocamboles?|brownies?|cupcakes?|donuts?|waffles?|churros|confeitaria pronta)\b/, notCat: /\b(misturas?|massas? para|forma|assadeira|utensilios?|cobertura|fermento|de arroz|carne|frango|bacalhau|salgad[a-z]*)\b/, name: /^(bolo|bolinho|torta|panetone|panettone|chocotone|rocambole|brownie|cupcake|donut|waffle|churros)\b/ },
  { id: "doces.biscoito_doce", label: "Biscoitos doces, recheados e cookies", domain: "mercado", query: "biscoito recheado", aliases: ["bolacha recheada", "cookie", "wafer", "biscoito de chocolate", "oreo", "passatempo"], flags: ["ready_to_eat"],
    cat: /\b(biscoitos? doces?|biscoitos? recheados?|biscoito doce|bolachas? doces?|bolachas? recheadas?|cookies?|wafers?|biscoitos? amanteigados?|rosquinhas?|biscoitos? de polvilho doce|biscoitos? maria|maisena)\b/, name: /^(biscoito|bolacha|cookie|cookies|wafer|rosquinha)\b(?!.*\b(salgad|agua e sal|cream cracker|integral salgado|queijo|polvilho salgado|pet|caes|gatos)\b)/ },
  { id: "snacks.biscoito_salgado", label: "Biscoitos salgados, torradas e crackers", domain: "mercado", query: "biscoito agua e sal", aliases: ["cream cracker", "torrada", "club social", "biscoito de polvilho"], flags: ["ready_to_eat"],
    cat: /\b(biscoitos? salgados?|bolachas? salgadas?|cream crackers?|crackers?|agua e sal|torradas?|biscoitos? de polvilho|polvilho salgado|biscoito salgado)\b/, name: /^(biscoito|bolacha|torrada)\b.*\b(salgad[oa]|agua e sal|cream cracker|crackers?|polvilho|integral|torrada)\b|^torrada\b/ },
  { id: "snacks.salgadinho", label: "Salgadinhos, batata chips e pipoca", domain: "mercado", query: "salgadinho", aliases: ["batata chips", "doritos", "ruffles", "cheetos", "batata palha", "fandangos"], flags: ["ready_to_eat"],
    cat: /\b(salgadinhos?|snacks?|batatas? chips|chips|batata palha|aperitivos? (de milho|extrusados?)|salgadinhos e snacks)\b/, notCat: /\b(pet|caes|gatos?|aperitivos salgados|frutas|legumes|congelad[a-z]*|amendoim|castanhas?|nuts|pipocas?|barras?)\b/, name: /^(salgadinho|batata (chips|frita ondulada|palha)|chips|doritos|ruffles|cheetos|fandangos|elma chips|pringles|torcida|baconzitos)\b/ },
  { id: "snacks.amendoim_castanhas", label: "Amendoim, castanhas e frutas secas", domain: "mercado", query: "amendoim", aliases: ["castanha de caju", "mix de castanhas", "nuts", "uva passa", "frutas secas"], flags: ["ready_to_eat"],
    cat: /\b(amendoins?|castanhas?|nuts|oleaginosas?|frutas? secas?|frutas? desidratadas?|mix de castanhas|sementes? e castanhas|nozes|amendoas?)\b/, notCat: /\b(pasta|leite|bebida|oleo|chocolate|pacoca)\b/, name: /^(amendoim|castanha|mix de castanhas|nozes|amendoas?|pistache|uva passa|damasco seco|tamara)\b/ },
  { id: "snacks.salgadinho", label: "Pipoca", domain: "mercado", query: "pipoca", aliases: ["pipoca de micro-ondas", "milho de pipoca"], flags: ["ready_to_eat"],
    cat: /\bpipocas?\b/, notCat: /\b(pipoqueira|panela|maquina)\b/, name: /^(pipoca|milho (de|para) pipoca)\b/ },
  { id: "mercado.barra_cereal", label: "Barras de cereal e de proteína", domain: "mercado", query: "barra de cereal", aliases: ["barra de proteina", "barrinha", "nutry", "bold"], flags: ["ready_to_eat"],
    cat: /\b(barras? de cereais?|barras? de cereal|barras? proteicas?|barras? de proteina|barrinhas?|barras? de frutas?|barras? de castanhas?|barra proteica|barra de proteina)\b/, name: /^(barra|barrinha) (de cereal|de cereais|de proteina|proteica|de frutas|de castanhas)\b/ },
  { id: "lanches.sanduiche", label: "Lanches e salgados prontos (sanduíche, pão recheado)", domain: "mercado", query: "sanduiche pronto", aliases: ["sanduiche natural", "lanche pronto", "pao recheado", "wrap"], flags: ["ready_to_eat"],
    cat: /\b(sanduiches?|lanches? prontos?|wraps?|prontos? para consumo|prontinhos|rotisseria|salgados? prontos?|lanches? naturais?)\b/, notCat: /\b(sanduicheiras?|grill)\b/, name: /^(sanduiche|wrap|lanche natural|pao recheado|misto quente)\b/ },

  // ======================= MERCADO — mercearia =======================
  { id: "mercado.cafe", label: "Café (pó, grão, cápsula, solúvel)", domain: "mercado", query: "cafe", aliases: ["cafe em po", "capsula de cafe", "cafe soluvel", "cappuccino", "nescafe"],
    cat: /\b(cafes?|capsulas?|cappuccinos?)\b/, needText: /\b(cafes?|capsulas? de cafe|espresso|cappuccino|nescafe|dolce gusto|3 coracoes|pilao|melitta|nespresso|cafe soluvel)\b/, notCat: /\b(cafeteiras?|xicaras?|canecas?|conjuntos?|cafeteria|mesa|utilidades|garrafas?|cha e cafe)\b/, name: /^(cafe|capsula de cafe|cappuccino|nescafe)\b/ },
  { id: "mercado.cha", label: "Chás e infusões (camomila, erva-doce, boldo)", domain: "mercado", query: "cha", aliases: ["cha de camomila", "cha de erva doce", "cha de boldo", "cha mate", "cha verde"], flags: ["care"],
    cat: /\b(chas?|infusoes|infusao|camomila|erva mate|ervas para cha|mate)\b/, notCat: /\b(cha pronto|chas prontos|cha gelado|ice tea|canecas?|xicaras?|conjuntos? de cha|cha e cafe|bules?|chaleiras?|garrafas?|cafeteria|sabonetes?|perfum[a-z]*)\b/, name: /^(cha|erva mate|cha mate|infusao)\b(?!.*\b(pronto|gelado|ice)\b)/ },
  { id: "mercado.cereal_matinal", label: "Cereais matinais, granola e aveia", domain: "mercado", query: "cereal matinal", aliases: ["granola", "aveia", "sucrilhos", "corn flakes", "nescau cereal"],
    cat: /\b(cereais? matina(l|is)|cereal|cereais|granolas?|aveias?|mueslis?|flocos de milho|corn flakes)\b/, notCat: /\b(barras?|barrinhas?|biscoit[a-z]*|infantil farinha)\b/, name: /^(cereal|granola|aveia|sucrilhos|corn flakes|muesli|snow flakes)\b/ },
  { id: "mercado.arroz", label: "Arroz", domain: "mercado", query: "arroz", aliases: ["arroz branco", "arroz integral", "arroz tipo 1"],
    cat: /\barroz\b/, notCat: /\b(biscoit[a-z]*|bolinhos?|doce|pratos?|cereal|farinha|leite|bebida|massa|macarrao|papinha|pet|racao)\b/, name: /^arroz\b/ },
  { id: "mercado.feijao", label: "Feijão e grãos", domain: "mercado", query: "feijao", aliases: ["feijao carioca", "feijao preto", "lentilha", "grao de bico"],
    cat: /\b(feijao|feijoes|graos|leguminosas?|lentilhas?|graos? de bico|grao de bico|ervilhas? secas?)\b/, notCat: /\b(cafe|cafes|em graos? (cafe)?|pratos?|enlatad[a-z]*|conservas?)\b/, name: /^(feijao|lentilha|grao de bico|ervilha seca)\b/ },
  { id: "mercado.macarrao", label: "Macarrão e massas", domain: "mercado", query: "macarrao", aliases: ["espaguete", "penne", "massa", "lasanha (massa)", "nhoque"],
    cat: /\b(macarrao|macarroes|massas?|espaguete|grano duro|massas? com ovos|massas? frescas?|massas? secas?|nhoque|gnocchi|talharim|massas? italianas?|massa grano duro)\b/, notCat: /\b(instantaneos?|lamen|pratos? prontos?|pizzas?|biscoit[a-z]*|modelar|corrida|acrilica|rejuntes?|para bolo|para pastel|para pizza|folhada|massa de|congelad[a-z]*|tapioca|pao)\b/, name: /^(macarrao|espaguete|spaghetti|penne|talharim|fusilli|parafuso|nhoque|gnocchi|massa (com ovos|grano duro|de semola|para lasanha))\b/ },
  { id: "mercado.macarrao_instantaneo", label: "Macarrão instantâneo e lámen", domain: "mercado", query: "macarrao instantaneo", aliases: ["miojo", "lamen", "cup noodles"],
    cat: /\b(macarrao instantaneo|massas? instantaneas?|instantaneos?|lamen|cup noodles)\b/, name: /^(macarrao instantaneo|lamen|miojo|cup noodles|nissin)\b/ },
  { id: "mercado.molho_tomate", label: "Molho de tomate e extrato", domain: "mercado", query: "molho de tomate", aliases: ["extrato de tomate", "polpa de tomate", "passata", "tomate pelado"],
    cat: /\b(molhos? de tomate|extratos? de tomate|polpas? de tomate|atomatados?|passatas?|tomates? pelados?|molhos? prontos?)\b/, name: /^(molho de tomate|extrato de tomate|polpa de tomate|passata|tomate pelado|molho pomarola|pomarola)\b/ },
  { id: "mercado.condimentos", label: "Maionese, ketchup, mostarda e molhos", domain: "mercado", query: "maionese", aliases: ["ketchup", "mostarda", "molho barbecue", "shoyu", "vinagre", "molho de pimenta"],
    cat: /\b(maioneses?|ketchup|catchup|mostardas?|molhos?|shoyu|vinagres?|condimentos?|molhos? especiais|molhos? para salada|azeite de dende)\b/, notCat: /\b(tomate|macarrao|massas? e molhos? (macarrao|massa)|temperos? (e|em) po|pimenta do reino)\b/, name: /^(maionese|ketchup|catchup|mostarda|molho (barbecue|ingles|shoyu|de pimenta|para salada|tare|de alho)|shoyu|vinagre)\b/ },
  { id: "mercado.temperos", label: "Temperos, sal e caldos", domain: "mercado", query: "tempero", aliases: ["sal", "caldo knorr", "sazon", "pimenta do reino", "oregano", "alho"],
    cat: /\b(temperos?|especiarias?|condimentos? secos|sal|sal grosso|caldos?|ervas desidratadas|pimentas? do reino|sazon)\b/, notCat: /\b(temperos? frescos?|hortifruti|molhos?|sal de fruta|batata|biscoit[a-z]*|caldo de cana)\b/, name: /^(tempero|sal (refinado|grosso|marinho|rosa)|sal\b|caldo (knorr|maggi|de)|sazon|pimenta do reino|oregano|colorau|paprica|canela em|cominho|louro)\b/ },
  { id: "mercado.oleo_azeite", label: "Azeite e óleo de cozinha", domain: "mercado", query: "azeite", aliases: ["oleo de soja", "azeite extra virgem", "oleo de girassol"],
    cat: /\b(azeites?|oleos? (de cozinha|vegeta(l|is)|de soja|de girassol|de canola|de milho|comestive(l|is))|oleos e azeites|azeites e oleos|oleo|oleos)\b/, notCat: /\b(essencia(l|is)|corporal|capilar|cabel[a-z]*|motor|lubrificantes?|bebe|banho|peroba|maquinas?|massagem|pele|rosto|facial|barba|automotiv[a-z]*|dende)\b/, name: /^(azeite|oleo de (soja|girassol|canola|milho|coco))\b/ },
  { id: "mercado.acucar_adocante", label: "Açúcar e adoçante", domain: "mercado", query: "acucar", aliases: ["adocante", "acucar refinado", "acucar mascavo", "stevia"],
    cat: /\b(acucares?|acucar|adocantes?)\b/, notCat: /\b(zero acucar|sem acucar|algodao doce)\b/, name: /^(acucar|adocante|stevia|xilitol)\b/ },
  { id: "mercado.farinha", label: "Farinhas, farofa e fermento", domain: "mercado", query: "farinha de trigo", aliases: ["farofa pronta", "fuba", "tapioca", "fermento", "amido de milho", "polvilho"],
    cat: /\b(farinhas?|farofas?|fermentos?|amidos?|fubas?|tapiocas?|polvilhos?|maizena)\b/, notCat: /\b(biscoit[a-z]*|lactea|infantil|papinha)\b/, name: /^(farinha|farofa|fuba|tapioca|fermento|amido de milho|polvilho|maizena)\b/ },
  { id: "mercado.confeitaria", label: "Leite condensado, creme de leite e confeitaria", domain: "mercado", query: "leite condensado", aliases: ["creme de leite", "mistura para bolo", "gelatina", "granulado", "chantilly", "cobertura de chocolate"],
    cat: /\b(confeitaria|leites? condensados?|cremes? de leite|chantilly|granulados?|coberturas?|gelatinas?|pudins?|sobremesas? em po|misturas? para bolos?|massas? para bolos?|gotas de chocolate|confeitos? para bolo|sobremesas e confeitaria|para sobremesa|preparo para bolos( e sobremesas)?|coco ralado)\b/, notCat: /\b(sorvetes?|prontas?|pronto|balas?)\b/, name: /^(leite condensado|creme de leite|mistura (para|de) bolo|gelatina|granulado|chantilly|cobertura|po para pudim)\b/ },
  { id: "mercado.enlatados", label: "Enlatados e conservas (atum, sardinha, milho)", domain: "mercado", query: "atum em lata", aliases: ["sardinha", "milho verde", "ervilha", "palmito", "azeitona"],
    cat: /\b(enlatados?|conservas?|em lata|sardinhas?|atum|milho verde|ervilhas?|palmitos?|azeitonas?|pepinos? em conserva|seleta de legumes|picles)\b/, notCat: /\b(congelad[a-z]*|vegetal|pet|caes|gatos?|racao)\b/, name: /^(atum|sardinha|milho verde|ervilha|palmito|azeitona|seleta de legumes|picles|salsicha em lata)\b/ },
  { id: "mercado.sopa", label: "Sopas e cremes prontos", domain: "mercado", query: "sopa", aliases: ["creme de cebola", "sopa instantanea", "canja", "cup soup"], flags: ["care"],
    cat: /\b(sopas?|cremes? (de|para) sopa|canjas?|sopas? instantaneas?)\b/, notCat: /\b(massas e sopas (massa|macarrao|outras)|pratos?|tigelas?|pratos? de sopa|bowls?)\b/, name: /^(sopa|creme de (cebola|ervilha|legumes|milho|mandioquinha)|canja|cup soup|sopao)\b/ },
  { id: "mercado.mel_geleia", label: "Mel, geleias e pastas doces", domain: "mercado", query: "geleia", aliases: ["mel", "creme de avela", "nutella", "pasta de amendoim"],
    cat: /\b(mel|meis|geleias?|cremes? de avela|pastas? de amendoim|pastas? doces?|doces? para passar|cremes e pastas)\b/, notCat: /\b(sabonetes?|shampoo|hidrat[a-z]*|maquiagem|melancia|melao)\b/, name: /^(mel|geleia|creme de avela|nutella|pasta de amendoim)\b/ },

  // ======================= MERCADO — laticínios, frios, ovos =======================
  { id: "frios.leite", label: "Leite (integral, sem lactose, em pó e vegetal)", domain: "mercado", query: "leite", aliases: ["leite integral", "leite desnatado", "leite sem lactose", "leite em po"], flags: ["fresh"],
    cat: /\b(leites?|leites? longa vida|leites? uht|leite em po)\b/, notCat: /\b(condensados?|coco|fermentad[a-z]*|infanti[a-z]*|vegeta(l|is)|achocolat[a-z]*|maquiagem|corporal|demaquil[a-z]*|hidrat[a-z]*|limpeza|de magnesia|de rosas|creme de leite|doce de leite|iogurtes?|bebidas? lacteas?|formulas?)\b/, name: /^leite (integral|desnatado|semidesnatado|zero lactose|sem lactose|uht|longa vida|em po|tipo a|pasteurizado)\b/ },
  { id: "frios.leite", label: "Vegetais", domain: "mercado", query: "leite vegetal", aliases: ["leite de amendoas", "bebida de aveia", "leite de soja", "leite de coco"],
    cat: /\b(leites? vegeta(l|is)|bebidas? vegeta(l|is)|leites? de (amendoas?|aveia|soja|castanhas?|coco)|bebidas? de (aveia|soja|amendoas?|arroz)|base vegetal)\b/, name: /^(bebida (vegetal|de aveia|de soja|de amendoas|de arroz)|leite (de amendoas|de aveia|de soja|de coco|vegetal))\b/ },
  { id: "frios.iogurte", label: "Iogurtes, petit suisse e leites fermentados", domain: "mercado", query: "iogurte", aliases: ["iogurte grego", "danone", "yakult", "leite fermentado", "danoninho"], flags: ["ready_to_eat", "cold", "fresh"],
    cat: /\b(iogurtes?|leites? fermentad[a-z]*|petit suisse|bebidas? lacteas?|coalhadas?|kefir|skyr)\b/, notCat: /\b(sorvetes?|biscoit[a-z]*|achocolat[a-z]*)\b/, name: /^(iogurte|leite fermentado|petit suisse|bebida lactea|danoninho|yakult|coalhada|skyr|kefir)\b/ },
  { id: "frios.queijo", label: "Queijos", domain: "mercado", query: "queijo", aliases: ["queijo mussarela", "queijo prato", "parmesao", "queijo minas", "queijo coalho"], flags: ["fresh"],
    cat: /\b(queijos?|queijos? especiais|queijos? finos)\b/, notCat: /\b(pao de queijo|biscoit[a-z]*|salgadinhos?|cremes? de queijo|requeijao)\b/, name: /^queijo\b/ },
  { id: "frios.requeijao_manteiga", label: "Manteiga, margarina e requeijão", domain: "mercado", query: "manteiga", aliases: ["margarina", "requeijao", "cream cheese"], flags: ["fresh"],
    cat: /\b(requeijao|requeijoes|manteigas?|margarinas?|cream cheese|cremes? de ricota|cremes? de queijo)\b/, notCat: /\b(corporal|hidrat[a-z]*|manteiga de cacau|karite|biscoit[a-z]*|amendoim)\b/, name: /^(manteiga|margarina|requeijao|cream cheese)\b/ },
  { id: "frios.frios", label: "Frios (presunto, peito de peru, salame)", domain: "mercado", query: "presunto", aliases: ["peito de peru", "mortadela", "salame", "frios fatiados"], flags: ["fresh"],
    cat: /\b(frios|presuntos?|mortadelas?|salames?|peitos? de peru|apresuntados?|embutidos?|fatiados?|frios fatiados)\b/, notCat: /\b(queijos?|congelad[a-z]*|iogurtes?|laticinios?)\b/, name: /^(presunto|peito de peru|mortadela|salame|apresuntado|blanquet|copa|pepperoni|lombo canadense)\b/ },
  { id: "hortifruti.ovos", label: "Ovos", domain: "mercado", query: "ovos", aliases: ["duzia de ovos", "ovos caipira", "ovos brancos"], flags: ["fresh"],
    cat: /\bovos?\b/, notCat: /\b(pascoa|chocolates?|massas?|macarrao|com ovos|brinquedos?|surpresa)\b/, name: /^ovos? (branco|vermelho|caipira|extra|grande|de galinha|organico|jumbo)|^ovos\b/ },

  // ======================= MERCADO — carnes e congelados =======================
  { id: "carnes.bovina", label: "Carne bovina (picanha, alcatra, moída)", domain: "mercado", query: "carne bovina", aliases: ["picanha", "alcatra", "carne moida", "contra file", "costela", "fraldinha"], flags: ["fresh"],
    cat: /\b(bovin[oa]s?|carnes? vermelhas?|picanhas?|alcatras?|contra file|patinho|costelas? bovinas?|cortes bovinos|carnes? moidas?|acougue|carnes? bovinas?)\b/, notCat: /\b(hamburguer|pet|caes|gatos?|racao|enlatad[a-z]*|pratos?)\b/, name: /^(picanha|alcatra|contra file|file mignon|patinho|acem|musculo|fraldinha|maminha|cupim|costela bovina|carne moida|cox[aã]o (mole|duro)|lagarto|miolo de alcatra|bife)\b/ },
  { id: "carnes.frango", label: "Frango (peito, coxa, asa)", domain: "mercado", query: "peito de frango", aliases: ["file de frango", "coxa e sobrecoxa", "asa de frango", "frango inteiro"], flags: ["fresh"],
    cat: /\b(aves|frangos?|peitos? de frango|file de frango|coxas?|sobrecoxas?|asas?|coxinhas? da asa|cortes de frango)\b/, notCat: /\b(empanad[a-z]*|pratos?|pet|caes|gatos?|racao|passaros|hamburguer|salgad[a-z]*|nuggets?)\b/, name: /^(peito de frango|file de (peito de )?frango|coxa|sobrecoxa|asa de frango|frango (inteiro|resfriado|congelado|a passarinho)|coxinha da asa|filezinho sassami|sassami)\b/ },
  { id: "carnes.suina", label: "Carne suína e bacon", domain: "mercado", query: "bacon", aliases: ["lombo", "pernil", "costelinha suina", "panceta"], flags: ["fresh"],
    cat: /\b(suin[oa]s?|porco|lombos?|pernil|bacon|costelinhas?|pancetas?)\b/, notCat: /\b(pratos?|pet|caes|gatos?)\b/, name: /^(bacon|lombo|pernil|costelinha|panceta|bisteca suina|file mignon suino|carne suina)\b/ },
  { id: "carnes.linguica", label: "Linguiças e salsichas", domain: "mercado", query: "linguica", aliases: ["linguica toscana", "calabresa", "salsicha"], flags: ["fresh"],
    cat: /\b(linguicas?|salsichas?|calabresas?|embutidos? frescos?)\b/, notCat: /\b(pratos?|pet|caes|gatos?|enlatad[a-z]*|lata)\b/, notName: /\b(pimenta|tempero)\b/, name: /^(linguica|salsicha|calabresa)\b/ },
  { id: "carnes.peixe", label: "Peixes e frutos do mar", domain: "mercado", query: "file de tilapia", aliases: ["salmao", "camarao", "bacalhau", "peixe"], flags: ["fresh"],
    cat: /\b(peixes?|frutos do mar|pescados?|camaroes?|camarao|salmao|tilapias?|bacalhau|peixaria)\b/, notCat: /\b(em lata|enlatad[a-z]*|conservas?|aquario|racao|pet)\b/, name: /^(file de (tilapia|salmao|merluza|pescada)|salmao|tilapia|camarao|bacalhau|merluza)\b/ },
  { id: "carnes.hamburguer", label: "Hambúrgueres", domain: "mercado", query: "hamburguer", aliases: ["hamburguer bovino", "burger", "hamburguer de picanha"], flags: ["cold"],
    cat: /\b(hamburguer(es)?|hamburgueres|burgers?|burguer)\b/, notCat: /\b(pao|paes|maquina|chapa|grill)\b/, name: /^(hamburguer|hamburger|burger|burguer)\b/ },
  { id: "congelados.empanados", label: "Empanados e nuggets", domain: "mercado", query: "nuggets", aliases: ["empanado de frango", "steak de frango", "chicken crispy"], flags: ["cold"],
    cat: /\b(empanad[a-z]*|nuggets?|steaks?)\b/, name: /^(nuggets?|empanado|steak de frango|chicken)\b/ },
  { id: "congelados.pratos_prontos", label: "Pratos prontos e lasanhas (congelados)", domain: "mercado", query: "lasanha congelada", aliases: ["prato pronto", "marmita congelada", "escondidinho", "refeicao congelada"], flags: ["cold"],
    cat: /\b(pratos? prontos?|pratos? rapidos?|refeicoes?|marmitas?|lasanhas?|escondidinhos?|prato feito|congelados? prontos?)\b/, notCat: /\b(massas? para|marmiteiras?|potes?|pet|sobremesas?)\b/, name: /^(lasanha|escondidinho|prato pronto|marmita|strogonoff|yakisoba|risoto congelado)\b/ },
  { id: "congelados.pizza", label: "Pizzas", domain: "mercado", query: "pizza congelada", aliases: ["pizza", "pizza de calabresa", "pizza de mussarela"], flags: ["cold"],
    cat: /\bpizzas?\b/, notCat: /\b(farinhas?|massas? para|formas?|assadeiras?|cortador|forno|molho)\b/, name: /^pizza\b/ },
  { id: "congelados.pao_de_queijo", label: "Pão de queijo", domain: "mercado", query: "pao de queijo", aliases: ["pao de queijo congelado", "forno de minas"], flags: ["cold"],
    cat: /\bpao de queijo\b/, name: /^(pao de queijo|biscoito de queijo congelado)\b/ },
  { id: "congelados.salgados", label: "Salgados congelados (coxinha, kibe, pastel)", domain: "mercado", query: "coxinha congelada", aliases: ["kibe", "pastel", "esfiha", "mini salgados", "croquete"], flags: ["cold"],
    cat: [/\b(congelad[a-z]*|aperitivos?|lanches?|padaria|prontos?)\b/, /\b(salgad[oa]s|coxinhas?|kibes?|quibes?|esfihas?|pasteis|pastel|croquetes?|risoles|aperitivos)\b/], notCat: /\b(biscoit[a-z]*|snacks?|salgadinhos?|aperitivos? de milho)\b/, name: /^(coxinha|kibe|quibe|esfiha|pastel|croquete|risole|mini salgados?|enroladinho)\b/ },
  { id: "congelados.batata_frita", label: "Batata frita congelada", domain: "mercado", query: "batata congelada", aliases: ["batata pre frita", "batata palito", "batata smile"], flags: ["cold"],
    cat: [/\b(congelad[a-z]*|pre frita)\b/, /\bbatatas?\b/], name: /^batata (pre frita|congelada|palito|smile|rustica)\b/ },
  { id: "hortifruti.legumes", label: "Congelados", domain: "mercado", query: "legumes congelados", aliases: ["brocolis congelado", "seleta congelada", "milho congelado"], flags: ["cold"],
    cat: [/\b(congelad[a-z]*|vegetal)\b/, /\b(vegetais|vegetal|legumes|verduras|brocolis|ervilhas?|milho)\b/], notCat: /\bbatatas?\b/ },
  { id: "padaria.pao", label: "Pães (forma, francês, bisnaguinha)", domain: "mercado", query: "pao de forma", aliases: ["pao frances", "bisnaguinha", "pao integral", "pao de hamburguer", "pao de hot dog"], flags: ["fresh"],
    cat: /\b(paes|pao|pao de forma|paes de forma|bisnaguinhas?|baguetes?|pao frances|paes especiais|padaria paes)\b/, notCat: /\b(pao de queijo|pao de alho|torradas?|bolos?|forma de pao|maquinas?|sanduicheira|recheado)\b/, name: /^(pao (de forma|frances|integral|de hamburguer|de hot dog|sirio|australiano|de leite|bola|italiano|cacetinho|brioche)|bisnaguinha|baguete|pao)\b(?!.*\b(queijo|alho)\b)/ },
  { id: "padaria.pao_de_alho", label: "Pão de alho", domain: "mercado", query: "pao de alho", aliases: ["pao de alho para churrasco"], flags: ["cold"],
    cat: /\bpao de alho\b/, name: /^pao de alho\b/ },

  // ======================= MERCADO — hortifruti =======================
  { id: "hortifruti.frutas", label: "Frutas frescas", domain: "mercado", query: "banana", aliases: ["maca", "laranja", "morango", "uva", "frutas"], flags: ["fresh"],
    cat: /\b(frutas?|frutas? frescas?)\b/, notCat: /\b(secas?|desidratad[a-z]*|suco|sucos|polpas?|sorvetes?|geleias?|cristalizad[a-z]*|em calda|barras?|biscoit[a-z]*|cesta|presente)\b/, name: /^(banana|maca|laranja|limao|morango|uva|mamao|manga|abacaxi|melancia|melao|pera|kiwi|abacate|tangerina|mexerica|ponkan|goiaba|maracuja|caqui|ameixa fresca|pessego|framboesa|mirtilo)\b/ },
  { id: "hortifruti.legumes", label: "Legumes, raízes, cogumelos e vegetais congelados", domain: "mercado", query: "tomate", aliases: ["batata", "cebola", "cenoura", "abobrinha", "mandioca"], flags: ["fresh"],
    cat: /\b(legumes|raizes|tuberculos|legumes frescos|cogumelos?)\b/, notCat: /\b(congelad[a-z]*|conservas?|enlatad[a-z]*|seleta|sopas?)\b/, name: /^(tomate|batata(?! (palha|chips|frita|pre frita|congelada))|cebola|cenoura|abobrinha|abobora|mandioca|aipim|beterraba|chuchu|berinjela|pimentao|pepino|inhame|mandioquinha|batata doce|alho|vagem|quiabo|jilo|milho verde espiga)\b/ },
  { id: "hortifruti.verduras", label: "Verduras, folhas e temperos frescos", domain: "mercado", query: "alface", aliases: ["rucula", "couve", "cheiro verde", "brocolis", "espinafre"], flags: ["fresh"],
    cat: /\b(verduras|folhas|folhosas|hortalicas|temperos? frescos?|ervas frescas|higienizad[a-z]*)\b/, notCat: /\b(congelad[a-z]*|cha|chas)\b/, name: /^(alface|rucula|couve|agriao|espinafre|cheiro verde|salsinha|cebolinha|coentro|manjericao|brocolis|couve flor|repolho|acelga|hortela)\b/ },

  // ======================= MERCADO — bebidas =======================
  { id: "bebidas.agua", label: "Água mineral, tônica e saborizada (com e sem gás)", domain: "mercado", query: "agua mineral", aliases: ["agua com gas", "agua sem gas", "galao de agua"], flags: ["cold"],
    cat: [/\b(bebidas?|nao alcoolicas?|aguas? minera(l|is)|aguas)\b/, /\baguas?\b/], notCat: /\b(coco|sanitaria|micelar|termal|oxigenada|tonica|perfume|colonia|banho|toalha)\b/, name: /^agua mineral\b|^agua (com|sem) gas\b/ },
  { id: "bebidas.agua_coco", label: "Água de coco", domain: "mercado", query: "agua de coco", aliases: ["kero coco", "agua de coco caixinha"], flags: ["cold", "care"],
    cat: /\baguas? de coco\b/, name: /^agua de coco\b/ },
  { id: "bebidas.refrigerante", label: "Refrigerantes", domain: "mercado", query: "refrigerante", aliases: ["coca cola", "guarana", "refrigerante lata", "refrigerante zero", "soda"], flags: ["cold"],
    cat: /\b(refrigerantes?|refris?|sodas?)\b/, notCat: /\b(caustica|bicarbonato)\b/, name: /^(refrigerante|coca cola|guarana antarctica|fanta|sprite|pepsi|soda limonada|schweppes|kuat|sukita|dolly)\b/ },
  { id: "bebidas.suco", label: "Sucos, néctares e chás gelados", domain: "mercado", query: "suco", aliases: ["suco de laranja", "suco de uva", "nectar", "suco de caixinha"], flags: ["cold"],
    cat: /\b(sucos?|nectares?|nectar|refrescos?|sucos? e refrescos?)\b/, notCat: /\b(espremedor|centrifuga|extrator|po para|em po)\b/, name: /^(suco|nectar|bebida mista|refresco)\b/ },
  { id: "bebidas.suco", label: "Chá gelado", domain: "mercado", query: "cha gelado", aliases: ["ice tea", "mate leao", "cha pronto"], flags: ["cold"],
    cat: /\b(chas? prontos?|cha gelado|ice tea|chas? gelados?|mates? prontos?|chas? e mate)\b/, name: /^(cha (pronto|gelado)|ice tea|mate leao|cha mate pronto|chá gelado)\b/ },
  { id: "bebidas.energetico", label: "Energéticos", domain: "mercado", query: "energetico", aliases: ["red bull", "monster", "tnt"], flags: ["cold"],
    cat: /\b(energeticos?|isotonicos?|energetico e isotonico)\b/, needText: /\b(energetic[oa]s?|red bull|monster|tnt|burn|fusion|baly|reign|flying horse)\b/, name: /^(energetico|red bull|monster|tnt energy|baly)\b/ },
  { id: "bebidas.isotonico", label: "Isotônicos e hidroeletrolíticos", domain: "mercado", query: "isotonico", aliases: ["gatorade", "powerade", "bebida hidroeletrolitica"], flags: ["cold", "care"],
    cat: /\b(isotonicos?|hidroeletrolitic[oa]s?|energetico e isotonico|bebidas? esportivas?)\b/, needText: /\b(isotonic[oa]s?|gatorade|powerade|hidroeletrolitic[oa]s?|eletrolit[a-z]*|sports? drink|hidrat[a-z]*)\b/, name: /^(isotonico|gatorade|powerade|bebida hidroeletrolitica)\b/ },
  { id: "bebidas.cerveja", label: "Cervejas", domain: "mercado", query: "cerveja", aliases: ["cerveja lata", "cerveja long neck", "chopp", "cerveja artesanal"], flags: ["cold"],
    cat: /\b(cervejas?|chopps?|chope)\b/, notCat: /\b(copos?|canecas?|tacas?|baldes?|abridor)\b/, name: /^(cerveja|chopp|chope)\b/ },
  { id: "bebidas.vinho", label: "Vinhos (tinto, branco, rosé)", domain: "mercado", query: "vinho tinto", aliases: ["vinho branco", "vinho rose", "vinho seco", "vinho suave"], flags: ["gift"],
    cat: /\b(vinhos?|adega)\b/, notCat: /\b(espumantes?|champagnes?|tacas?|abridor|saca rolhas|adegas? climatizadas?|vinagres?)\b/, name: /^vinho\b/ },
  { id: "bebidas.espumante", label: "Espumantes e champanhes", domain: "mercado", query: "espumante", aliases: ["champagne", "prosecco", "espumante brut", "moscatel"], flags: ["gift", "cold"],
    cat: /\b(espumantes?|champagnes?|champanhes?|proseccos?|cavas?)\b/, notCat: /\btacas?\b/, name: /^(espumante|champagne|champanhe|prosecco)\b/ },
  { id: "bebidas.destilados", label: "Destilados e drinks prontos (whisky, vodka, gin, cachaça, licor, ice)", domain: "mercado", query: "whisky", aliases: ["vodka", "gin", "cachaca", "licor", "rum", "tequila"], flags: ["gift"],
    cat: /\b(destilad[oa]s?|whisk(y|ies|ey)|vodkas?|gins?|cachacas?|runs?|rum|tequilas?|licores?|conhaques?|aperitivos? alcoolicos?|bebidas? alcoolicas?|bebida alcoolica|aguardentes?|saques?)\b/, notCat: /\b(vinhos?|cervejas?|espumantes?|copos?|tacas?)\b/, name: /^(whisky|whiskey|vodka|gin|cachaca|rum|tequila|licor|conhaque|aperol|campari|jagermeister|saque)\b/ },
  { id: "bebidas.destilados", label: "Drinks prontos", domain: "mercado", query: "drink pronto", aliases: ["ice", "skol beats", "caipirinha pronta", "hard seltzer"], flags: ["cold"],
    cat: /\b(drinks?|coqueteis|coquetel|ices?|hard seltzer|bebidas? mistas? alcoolicas?)\b/, notCat: /\b(ice tea|gelo|cream)\b/, name: /^(skol beats|smirnoff ice|ice (cabare|kiss)|drink pronto|caipirinha pronta|hard seltzer)\b/ },
  { id: "bebidas.gelo", label: "Gelo", domain: "mercado", query: "gelo", aliases: ["saco de gelo", "gelo em cubo"], flags: ["cold"],
    cat: /\bgelos?\b/, notCat: /\b(cor|tintas?|forminhas?|formas?|ice tea|garrafas?)\b/, name: /^(gelo|saco de gelo)\b/ },
  { id: "bebidas.agua", label: "Kombucha e tônica", domain: "mercado", query: "kombucha", aliases: ["agua tonica", "agua saborizada", "bebida funcional"], flags: ["cold"],
    cat: /\b(kombuchas?|aguas? tonicas?|tonicas?|aguas? saborizadas?|bebidas? funciona(l|is))\b/, name: /^(kombucha|agua tonica|agua saborizada)\b/ },

  // ======================= CASA — limpeza =======================
  { id: "limpeza.lava_roupas", label: "Sabão para roupa (pó, líquido, barra)", domain: "casa", query: "sabao em po", aliases: ["sabao liquido", "lava roupas", "omo", "tira manchas", "sabao em barra"],
    cat: /\b(lava roupas?|sabao em po|sabao liquido|sabao em barra|sabao|saboes|detergentes? para roupas?|tira manchas|alvejantes?|cuidados com a roupa|lavanderia|roupa sabao)\b/, notCat: /\b(amaciantes?|lava loucas?|lava louca|maquinas?|coco para|automotiv[a-z]*)\b/, name: /^(sabao (em po|liquido|em barra|de coco)|lava roupas|tira manchas|alvejante)\b/ },
  { id: "limpeza.amaciante", label: "Amaciantes", domain: "casa", query: "amaciante", aliases: ["comfort", "downy", "amaciante concentrado"],
    cat: /\bamaciantes?\b/, name: /^amaciante\b/ },
  { id: "limpeza.detergente", label: "Detergente e lava-louças", domain: "casa", query: "detergente", aliases: ["lava loucas", "detergente liquido", "ype"],
    cat: /\b(detergentes?|lava loucas?|lava louca)\b/, notCat: /\b(para roupas?|maquinas?|eletro[a-z]*|lava loucas? (eletric|de bancada|de piso)|automotiv[a-z]*)\b/, name: /^(detergente|lava loucas?)\b/ },
  { id: "limpeza.desinfetante", label: "Água sanitária", domain: "casa", query: "agua sanitaria", aliases: ["cloro", "candida", "qboa"],
    cat: /\b(aguas? sanitarias?|cloros?|candida)\b/, notCat: /\bpiscinas?\b/, name: /^(agua sanitaria|cloro)\b/ },
  { id: "limpeza.desinfetante", label: "Desinfetante, água sanitária e cloro", domain: "casa", query: "desinfetante", aliases: ["pinho sol", "veja desinfetante", "lysoform"],
    cat: /\bdesinfetantes?\b/, name: /^desinfetante\b/ },
  { id: "limpeza.multiuso", label: "Limpadores multiuso, limpa-vidro e banheiro", domain: "casa", query: "limpador multiuso", aliases: ["veja", "limpa vidros", "limpador de banheiro", "desengordurante", "saponaceo"],
    cat: /\b(multiusos?|multi uso|limpadores?|limpa vidros?|limpeza pesada|desengordurantes?|saponaceos?|limpeza (de )?banheiro|limpa pisos?|removedor(es)?|produtos de limpeza|lustra moveis|limpeza geral|limpeza da casa|limpa (aluminio|inox|moveis)|tira limo)\b/, notCat: /\b(pele|facial|rosto|esmalte|maquiagem|pet|automotiv[a-z]*|eletric[oa]s?|aspirador)\b/, name: /^(limpador|multiuso|limpa vidros?|desengordurante|saponaceo|lustra moveis|tira limo|limpa (aluminio|inox|pisos?))\b/ },
  { id: "limpeza.esponja_pano", label: "Esponjas, panos e luvas de limpeza", domain: "casa", query: "esponja", aliases: ["pano de chao", "flanela", "palha de aco", "luva de limpeza", "perfex"],
    cat: /\b(esponjas?|panos?|flanelas?|palhas? de aco|luvas? de limpeza|luvas? (de )?latex|bombril)\b/, notCat: /\b(maquiagem|banho|pratos?|copa|mesa|de prato|pano de prato bordado)\b/, name: /^(esponja|pano (de chao|multiuso|de limpeza|para piso|de microfibra)|flanela|palha de aco|luva de (limpeza|latex)|bombril|perfex)\b/ },
  { id: "limpeza.vassoura_rodo", label: "Vassouras, rodos, mops e baldes", domain: "casa", query: "vassoura", aliases: ["rodo", "mop", "balde", "pa de lixo"],
    cat: /\b(vassouras?|rodos?|mops?|pas de lixo|baldes?|escovas? de limpeza|utensilios de limpeza|acessorios de limpeza|desentupidor(es)?|escovoes?)\b/, notCat: /\b(gelo|champanhe|pipoca)\b/, name: /^(vassoura|rodo|mop|balde|pa de lixo|escovao)\b/ },
  { id: "limpeza.saco_lixo", label: "Sacos de lixo e lixeiras", domain: "casa", query: "saco de lixo", aliases: ["lixeira", "saco de lixo 50 litros"],
    cat: /\b(sacos? (de|para) lixo|lixeiras?|lixo)\b/, name: /^(sacos? (de|para) lixo|lixeira)\b/ },
  { id: "limpeza.papel_higienico", label: "Papel higiênico", domain: "casa", query: "papel higienico", aliases: ["papel higienico folha dupla", "neve"],
    cat: /\bpapel higienico\b/, name: /^papel higienico\b/ },
  { id: "limpeza.papel_toalha", label: "Papel toalha, guardanapo e lenço de papel", domain: "casa", query: "papel toalha", aliases: ["guardanapo", "lenco de papel", "kleenex"],
    cat: /\b(papel toalha|papeis toalha|guardanapos?|lencos? de papel|papeis)\b/, notCat: /\b(higienico|presente|sulfite|escolar|parede|aluminio|manteiga|filme)\b/, name: /^(papel toalha|guardanapo|lenco de papel)\b/ },
  { id: "limpeza.inseticida", label: "Inseticidas e repelente de tomada", domain: "casa", query: "inseticida", aliases: ["repelente eletrico", "raid", "baygon", "mata baratas"],
    cat: /\b(inseticidas?|repelentes? eletric[oa]s?|repelentes? de tomada|raticidas?|mata (moscas|mosquitos|baratas|formigas)|dedetiza[a-z]*|pragas)\b/, name: /^(inseticida|repelente eletrico|raid|baygon|sbp)\b/ },
  { id: "limpeza.odorizador", label: "Odorizadores e bloco sanitário", domain: "casa", query: "odorizador de ambiente", aliases: ["bom ar", "bloco sanitario", "pedra sanitaria", "aromatizador"],
    cat: /\b(odorizador(es)?|aromatizador(es)? de ambiente|bom ar|desodorizador(es)?|purificador(es)? de ar|blocos? sanitarios?|pedras? sanitarias?|sanitarios? (gel|adesivo)|ambientes?)\b/, notCat: /\b(eletric[oa]s?|climatizador|ar condicionado)\b/, name: /^(odorizador|bom ar|bloco sanitario|pedra sanitaria|desodorizador)\b/ },

  // ======================= CASA — utilidades, cama, mesa, banho =======================
  { id: "casa.descartaveis", label: "Descartáveis, papel-alumínio e filme", domain: "casa", query: "papel aluminio", aliases: ["filme pvc", "copo descartavel", "prato descartavel", "papel manteiga", "palito"],
    cat: /\b(descartave(l|is)|papel aluminio|papeis aluminio|filmes? (pvc|plastico)|papel manteiga|sacos? para alimentos|embalagens? descartave(l|is)|palitos?|formas? de aluminio)\b/, notCat: /\b(fraldas?|mascaras?|luvas?|absorvente|lamina|barbear|seringas?)\b/, name: /^(papel aluminio|filme pvc|copo descartavel|prato descartavel|papel manteiga|palito|sacos? (para|de) (freezer|alimentos|congelar))\b/ },
  { id: "casa.panelas", label: "Panelas, frigideiras e assadeiras", domain: "casa", query: "panela", aliases: ["frigideira", "jogo de panelas", "panela de pressao", "cacarola"],
    cat: /\b(panelas?|frigideiras?|cacarolas?|caldeiroes?|caldeirao|woks?|jogos? de panelas|baterias? de cozinha|cacarola|leiteiras?|chaleiras?|panelas de pressao)\b/, notCat: /\b(eletric[oa]s?|arroz eletrica|multicooker)\b/, name: /^(panela|frigideira|cacarola|jogo de panelas|chaleira|leiteira|wok)\b(?!.*eletric)/ },
  { id: "casa.panelas", label: "Assadeiras", domain: "casa", query: "assadeira", aliases: ["forma de bolo", "refratario", "forma de pizza"],
    cat: /\b(assadeiras?|formas? (de|para) (bolo|pizza|pudim|gelo)|refratarios?|travessas? refratarias?|formas?)\b/, notCat: /\b(fisica|formas? de pagamento|aluminio descartave(l|is)|plataformas?)\b/, name: /^(assadeira|forma (de|para) (bolo|pizza|pudim|gelo)|refratario)\b/ },
  { id: "casa.utensilios_cozinha", label: "Utensílios de cozinha", domain: "casa", query: "utensilio de cozinha", aliases: ["espatula", "concha", "abridor", "ralador", "tabua de corte", "peneira"],
    cat: /\b(utensilios?|espatulas?|conchas?|escumadeiras?|abridor(es)?|raladores?|tabuas?|peneiras?|descascador(es)?|pegadores?|abridores?|utilidades domesticas|utensilios de cozinha|acessorios de cozinha|cozinha)\b/, notCat: /\b(limpeza|eletro[a-z]*|moveis|armarios?|pias?|torneiras?|panos?)\b/, name: /^(espatula|concha|escumadeira|abridor|ralador|tabua|peneira|descascador|pegador)\b/ },
  { id: "casa.talheres_facas", label: "Talheres e facas (inclusive de churrasco)", domain: "casa", query: "jogo de talheres", aliases: ["faca de churrasco", "faqueiro", "garfo", "colher", "faca do chef"],
    cat: /\b(talheres?|facas?|faqueiros?|garfos?|colheres?|cutelos?)\b/, notCat: /\b(eletric[oa]s?|amolador)\b/, name: /^(jogo de talheres|faqueiro|faca|garfo|colher|talher)\b/ },
  { id: "casa.pratos_travessas", label: "Pratos, travessas e aparelhos de jantar", domain: "casa", query: "jogo de pratos", aliases: ["aparelho de jantar", "travessa", "bowl", "tigela", "prato raso"],
    cat: /\b(pratos?|aparelhos? de jantar|travessas?|bowls?|tigelas?|saladeiras?|sousplats?|mesa posta|servir|petisqueiras?|boleiras?)\b/, notCat: /\b(descartave(l|is)|pet|caes|gatos?|prontos?|bateria|chuveiro)\b/, name: /^(jogo de pratos|prato|aparelho de jantar|travessa|bowl|tigela|saladeira|sousplat)\b/ },
  { id: "casa.copos_tacas", label: "Copos, taças, xícaras e jarras", domain: "casa", query: "jogo de copos", aliases: ["taca de vinho", "xicara", "jarra", "copo de vidro"],
    cat: /\b(copos?|tacas?|xicaras?|jarras?|conjuntos? de cha|jogos? de xicaras|cafeteria|bar)\b/, notCat: /\b(descartave(l|is)|liquidificador|eletric[oa]s?|barbear|barras?|menstrua[a-z]*|termic[oa]s?)\b/, name: /^(jogo de copos|copo|taca|xicara|jarra|caneca de chopp)\b/ },
  { id: "casa.caneca", label: "Canecas (inclusive temáticas, de presente)", domain: "casa", query: "caneca", aliases: ["caneca personalizada", "caneca geek", "caneca de porcelana"], flags: ["gift"],
    cat: /\bcanecas?\b/, notCat: /\b(chopp|cerveja)\b/, name: /^caneca\b/ },
  { id: "casa.garrafa_termica", label: "Garrafas, squeezes e garrafas térmicas", domain: "casa", query: "garrafa termica", aliases: ["squeeze", "garrafa de agua", "copo termico", "stanley"],
    cat: /\b(garrafas?|cantis|cantil|squeezes?|garrafas? termicas?|copos? termicos?|termicos?|termicas?)\b/, notCat: /\b(lancheiras?|bolsas?|caixas? termicas?|bolsas? termicas?|agua mineral|bebidas?|vinhos?|cerveja)\b/, name: /^(garrafa|squeeze|cantil|copo termico)\b/ },
  { id: "casa.potes", label: "Potes e organização de cozinha", domain: "casa", query: "pote hermetico", aliases: ["pote de vidro", "marmita", "porta mantimentos", "tupperware"],
    cat: /\b(potes?|hermetic[oa]s?|mantimentos|marmitas?|marmiteiras?|vasilhas?|porta (frios|mantimentos|tempero)|organizador(es)? de (cozinha|geladeira))\b/, notCat: /\b(pet|racao|congelad[a-z]*|prontas?)\b/, name: /^(pote|porta mantimentos|marmita|vasilha)\b/ },
  { id: "casa.cama", label: "Roupa de cama e travesseiros (lençol, edredom, colcha)", domain: "casa", query: "jogo de lencol", aliases: ["edredom", "colcha", "lencol", "fronha", "cobre leito"],
    cat: /\b(jogos? de cama|lencol|lencois|edredons?|edredom|colchas?|cobre leitos?|fronhas?|protetor(es)? de colchao|saias? para cama|roupas? de cama|porta travesseiro)\b/, notCat: /\b(pet|caes|gatos?|berco)\b/, name: /^(jogo de (lencol|cama)|lencol|edredom|colcha|cobre leito|fronha)\b/ },
  { id: "casa.cama", label: "Travesseiros", domain: "casa", query: "travesseiro", aliases: ["travesseiro de pluma", "travesseiro ortopedico"],
    cat: /\btravesseiros?\b/, notCat: /\b(capas?|porta travesseiro|fronhas?)\b/, name: /^travesseiro\b/ },
  { id: "casa.manta_cobertor", label: "Mantas e cobertores", domain: "casa", query: "manta", aliases: ["cobertor", "manta de sofa", "manta microfibra"], flags: ["gift"],
    cat: /\b(mantas?|cobertores?|cobertas?|mantas e cobertores)\b/, notCat: /\b(pet|caes|gatos?|asfaltica|impermeabiliza[a-z]*|termica|liquida)\b/, name: /^(manta|cobertor|coberta)\b/ },
  { id: "casa.toalha", label: "Toalhas (banho, rosto, mesa) e panos de prato", domain: "casa", query: "toalha de banho", aliases: ["jogo de toalhas", "toalha de rosto", "roupao"],
    cat: /\b(toalhas? (de banho|de rosto|de piso|de praia)?|roupoes?|roupao|jogos? de toalhas?|banho toalha)\b/, notCat: /\b(papel|toalhas? de mesa|umedecid[a-z]*|pet|caes|gatos?|lavabo papel)\b/, name: /^(toalha (de banho|de rosto|de praia|de piso)|jogo de toalhas|roupao)\b/ },
  { id: "casa.toalha", label: "Mesa", domain: "casa", query: "toalha de mesa", aliases: ["jogo americano", "pano de prato", "guardanapo de tecido"],
    cat: /\b(toalhas? de mesa|jogos? americanos?|panos? de prato|guardanapos? de tecido|caminhos? de mesa|mesa textil)\b/, name: /^(toalha de mesa|jogo americano|pano de prato)\b/ },
  { id: "casa.tapete", label: "Tapetes e passadeiras", domain: "casa", query: "tapete", aliases: ["tapete de sala", "tapete de banheiro", "capacho", "passadeira"],
    cat: /\b(tapetes?|passadeiras?|capachos?)\b/, notCat: /\b(pet|caes|higienic[oa]s?|atividades|yoga|infantil eva|carros?|automotiv[a-z]*)\b/, name: /^(tapete|passadeira|capacho)\b/ },
  { id: "casa.almofada", label: "Almofadas e capas de almofada", domain: "casa", query: "almofada", aliases: ["almofada decorativa", "capa de almofada", "almofada geek"], flags: ["gift"],
    cat: /\balmofadas?\b/, notCat: /\b(pet|caes|gatos?|carimbo|amamentacao)\b/, name: /^(almofada|capa de almofada)\b/ },
  { id: "casa.decoracao", label: "Decoração (quadros, vasos, enfeites, porta-retrato, cortinas)", domain: "casa", query: "decoracao", aliases: ["quadro decorativo", "vaso decorativo", "porta retrato", "enfeite", "espelho"], flags: ["gift"],
    cat: /\b(decor|decoracao|decorativ[oa]s?|quadros?|vasos? decorativ[oa]s?|enfeites?|objetos? decorativ[oa]s?|porta retratos?|espelhos?|relogios? de parede|esculturas?|adornos?|casa e decor|cachepots?)\b/, notCat: /\b(festa|natal|aniversario|banheiro|automotiv[a-z]*|pet|aquario)\b/, name: /^(quadro decorativo|vaso decorativo|porta retrato|enfeite|escultura|espelho)\b/ },
  { id: "casa.vela_aromatizador", label: "Velas, difusores, home spray e óleos essenciais", domain: "casa", query: "vela aromatica", aliases: ["difusor de ambiente", "home spray", "vela perfumada"], flags: ["gift"],
    cat: /\b(velas?|difusor(es)?|home spray|aromatizador(es)?|aromatizacao|fragrancias? para casa|sachets? perfumados?)\b/, notCat: /\b(aniversario|ignicao|filtro|automotiv[a-z]*|carro|festa)\b/, name: /^(vela (aromatica|perfumada)|difusor|home spray|aromatizador)\b/ },
  { id: "casa.iluminacao", label: "Iluminação (lâmpadas, luminárias, abajur)", domain: "casa", query: "lampada led", aliases: ["luminaria", "abajur", "fita led", "lustre", "lanterna"],
    cat: /\b(iluminacao|luminarias?|lampadas?|abajures?|abajur|lustres?|plafons?|fitas? de led|fita led|spots?|refletores?|lanternas?|arandelas?|pendentes?)\b/, notCat: /\b(automotiv[a-z]*|carros?)\b/, name: /^(lampada|luminaria|abajur|lustre|plafon|fita led|refletor|lanterna|arandela)\b/ },
  { id: "casa.moveis", label: "Móveis e colchões (cadeira, mesa, estante, rack, sofá)", domain: "casa", query: "cadeira", aliases: ["mesa", "estante", "rack", "sofa", "poltrona", "banqueta"],
    cat: /\b(moveis|sofas?|poltronas?|cadeiras?|mesas? (de jantar|de centro|de cabeceira|de escritorio|lateral|laterais|de apoio|dobravel|dobraveis)|guarda roupas?|roupeiros?|estantes?|racks?|nichos?|prateleiras?|bancos?|banquetas?|armarios?|comodas?|escrivaninhas?|cabeceiras?|aparadores?|buffets?|paineis|camas?( box)?|beliches?|criados? mudos?|puffs?|pufes?)\b/, notCat: /\b(mesa posta|jogos? de cama|cama mesa e banho|pet|caes|gatos?|cadeiras? (de alimentacao|para auto|infantil)|bancos? de dados|praia|camping|piscina)\b/, name: /^(cadeira|mesa|estante|rack|sofa|poltrona|banqueta|banco|armario|comoda|escrivaninha|aparador|guarda roupa|puff)\b/ },
  { id: "casa.moveis", label: "Colchões", notName: /\bprotetor\b/, domain: "casa", query: "colchao", aliases: ["cama box", "colchao de casal", "colchao de solteiro"],
    cat: /\b(colchoes|colchao|camas? box|box bau)\b/, notCat: /\b(protetor(es)?|inflave(l|is)|pet)\b/, name: /^(colchao|cama box|conjunto box)\b/ },
  { id: "casa.organizacao", label: "Organização e acessórios de banheiro (caixas, cabides, cestos, varal, saboneteira)", domain: "casa", query: "caixa organizadora", aliases: ["cabide", "cesto de roupa", "varal", "sapateira", "organizador"],
    cat: /\b(organiza[a-z]*|cabides?|caixas? organizadoras?|cestos?|varais?|varal|sapateiras?|ganchos?|porta objetos|porta treco|lavanderia)\b/, notCat: /\b(cozinha|geladeira|maquiagem|lixo|lixeiras?|pet|pastas?|escolar|ferramentas?|cestas? (de )?(presente|cafe|basica))\b/, name: /^(caixa organizadora|cabide|cesto|varal|sapateira|organizador)\b/ },
  { id: "casa.organizacao", label: "Banheiro", domain: "casa", query: "kit banheiro", aliases: ["saboneteira", "porta escova", "cortina de box", "tapete de banheiro"],
    cat: /\b(acessorios? (de|para) banheiros?|saboneteiras?|porta escovas?|cortinas? de box|porta papel|kits? (de )?banheiro|banheiro acessorios)\b/, name: /^(saboneteira|porta escova|porta papel|kit banheiro|cortina de box|dispenser)\b/ },
  { id: "casa.decoracao", label: "Cortinas", domain: "casa", query: "cortina", aliases: ["persiana", "varao de cortina", "blackout"],
    cat: /\b(cortinas?|persianas?|varoes?|varao|blackout|rolos? de cortina)\b/, notCat: /\b(box|banheiro|ar)\b/, name: /^(cortina|persiana|varao)\b/ },

  // ======================= CASA — obra e manutenção =======================
  { id: "casa.hidraulica", label: "Chuveiros", domain: "casa", query: "chuveiro eletrico", aliases: ["ducha", "ducha higienica", "resistencia de chuveiro"],
    cat: /\b(chuveiros?|duchas?|resistencias? (de|para) chuveiro)\b/, name: /^(chuveiro|ducha|resistencia (de|para) chuveiro)\b/ },
  { id: "casa.hidraulica", label: "Louças e metais", domain: "casa", query: "torneira", aliases: ["vaso sanitario", "assento sanitario", "cuba", "registro", "misturador"],
    cat: /\b(torneiras?|vasos? sanitarios?|assentos? sanitarios?|cubas?|lavatorios?|registros?|metais|loucas|misturador(es)?|sifoes?|sifao|bacias?|tanques?|pias?|acabamentos? (de|para) (banheiro|registro))\b/, notCat: /\b(pet|bebe|banheira infantil|plastico de cozinha|pratos?|mesa|organizador(es)?|escorredor(es)?|rechauds?|profissional)\b/, name: /^(torneira|vaso sanitario|assento sanitario|cuba|registro|misturador|sifao|tanque)\b/ },
  { id: "casa.hidraulica", label: "Hidráulica e banheiro (chuveiro, torneira, vaso, ralo, conexões)", domain: "casa", query: "ralo", aliases: ["tubo pvc", "conexao", "valvula", "caixa d agua", "mangueira"],
    cat: /\b(hidraulic[oa]s?|tubos?|conexoes|conexao|ralos?|grelhas?|caixas? d agua|valvulas?|engates?|flexive(l|is)|boias?|reparos?|materiais hidraulicos)\b/, notCat: /\b(churrasqueira|churrasco|cabelo|eletric[oa]s?|grelhas? (de|para) churrasco|pasta de dente)\b/, name: /^(ralo|tubo|conexao|valvula|engate|caixa d agua|boia)\b/ },
  { id: "casa.eletrica", label: "Material elétrico (tomadas, interruptores, fios, extensão)", domain: "casa", query: "extensao eletrica", aliases: ["tomada", "interruptor", "filtro de linha", "adaptador de tomada", "fio eletrico", "disjuntor"],
    cat: /\b(eletric[ao]s?|materiais eletricos|tomadas?|interruptores?|disjuntores?|fios?|cabos? eletricos?|extensoes|extensao|filtros? de linha|benjamins?|adaptadores? de tomada|quadros? de distribuicao|campainhas?)\b/, notCat: /\b(chuveiros?|duchas?|eletroportateis|eletrodomesticos|panelas?|escovas?|barbeador(es)?|aquecedores?|ventiladores?|automotiv[a-z]*|carros?|pet|fios? dentais?|fio dental|lampadas?|luminarias?|iluminacao|portoes|telefones?|insetos|raquetes?)\b/, name: /^(extensao|tomada|interruptor|filtro de linha|adaptador de tomada|disjuntor|fio (eletrico|flexivel)|cabo flexivel|benjamin)\b/ },
  { id: "casa.pilhas", label: "Pilhas e baterias", domain: "casa", query: "pilha aa", aliases: ["pilha aaa", "bateria 9v", "pilha recarregavel"],
    cat: /\b(pilhas?|baterias? (de lithium|alcalinas?|recarregave(l|is)|9v)|carregadores? de pilha)\b/, notCat: /\b(cozinha|panelas?|musical|celular)\b/, name: /^(pilha|bateria (9v|alcalina|lithium|cr2032))\b/ },
  { id: "casa.ferramentas", label: "Ferramentas (furadeira, chaves, alicate)", domain: "casa", query: "furadeira", aliases: ["parafusadeira", "jogo de chaves", "alicate", "martelo", "trena", "caixa de ferramentas"],
    cat: /\b(ferramentas?|chaves? (de fenda|philips|allen|combinadas?|de boca|biela)?|furadeiras?|parafusadeiras?|alicates?|martelos?|serras?|trenas?|niveis|esmerilhadeiras?|lixadeiras?|brocas?|serrotes?|estiletes?|tesouras? de poda|marteletes?|ferramentas eletricas)\b/, notCat: /\b(jardim|cozinha|unhas|cabelo|pet)\b/, name: /^(furadeira|parafusadeira|jogo de chaves|chave (de fenda|philips|allen|inglesa)|alicate|martelo|trena|serra|broca|caixa de ferramentas|esmerilhadeira|lixadeira)\b/ },
  { id: "casa.ferragens", label: "Fechaduras, parafusos e ferragens", domain: "casa", query: "fechadura", aliases: ["parafuso", "bucha", "cadeado", "macaneta", "dobradica"],
    cat: /\b(ferragens|fechaduras?|macanetas?|parafusos?|buchas?|pregos?|dobradicas?|cadeados?|puxador(es)?|trincos?|fechos?|correntes?|arruelas?|porcas?)\b/, notCat: /\b(eletric[ao]s?|joias?|colares?|bijuterias?|pecas para)\b/, name: /^(fechadura|parafuso|bucha|cadeado|macaneta|dobradica|puxador|prego)\b/ },
  { id: "casa.tinta", label: "Tintas e pintura (rolo, pincel, massa)", domain: "casa", query: "tinta", aliases: ["tinta acrilica", "rolo de pintura", "pincel", "massa corrida", "spray de tinta"],
    cat: /\b(tintas?|pintura|pinceis|pincel|rolos? (de|para) pintura|massas? corridas?|seladoras?|vernizes?|verniz|esmaltes? sinteticos?|texturas?|solventes?|thinner|lixas?|tintas e acessorios)\b/, notCat: /\b(cabelo|unhas?|maquiagem|tecido infantil|guache|pintura infantil|artes|escolar|impressora|caneta|cozinha)\b/, name: /^(tinta (acrilica|esmalte|spray|latex)|rolo de pintura|pincel|massa corrida|selador|verniz|lixa)\b/ },
  { id: "casa.construcao", label: "Pisos", domain: "casa", query: "porcelanato", aliases: ["piso ceramico", "revestimento", "rejunte", "argamassa", "piso vinilico"],
    cat: /\b(pisos?|revestimentos?|porcelanatos?|ceramicas?|rejuntes?|argamassas?|azulejos?|laminados?|vinilicos?|pastilhas? de vidro|rodapes?|soleiras?)\b/, notCat: /\b(panelas?|loucas? de mesa|pratos?|canecas?|vasos?|limpa pisos?|limpeza|panos?|tapetes?)\b/, name: /^(porcelanato|piso|revestimento|rejunte|argamassa|azulejo|rodape)\b/ },
  { id: "casa.construcao", label: "Construção e reforma (pisos, revestimentos, cimento, portas, janelas)", domain: "casa", query: "cimento", aliases: ["areia", "impermeabilizante", "gesso", "tijolo", "telha"],
    cat: /\b(cimentos?|tijolos?|blocos? de concreto|telhas?|materiais basicos|impermeabiliza[a-z]*|drywall|gesso|cal|concreto|materiais de construcao|madeiras?|vigas?|mantas? asfalticas?|construcao)\b/, notCat: /\b(pet|gatos?|brinquedos?|jogos?)\b/, name: /^(cimento|tijolo|telha|impermeabilizante|gesso|cal hidratada|argamassa)\b/ },
  { id: "casa.construcao", label: "Portas", domain: "casa", query: "porta", aliases: ["janela", "porta de madeira", "esquadria"],
    cat: /\b(portas? (e janelas|de madeira|de aluminio|de correr|de vidro|de entrada|pronta)|portas$|janelas?|esquadrias?|portoes?|batentes?|kits? porta pronta)\b/, notCat: /\b(porta (retrato|objetos|escova|papel|treco|copos?|tempero|mantimentos|travesseiro|joias|chaves|guardanapo|talher|frios|controle|vinhos?|bolo|sabao|shampoo|toalha|garrafa|lapis|caneta|cartao|documento)|portateis|portatil|organizador|caixa|ar condicionado|cortinas?)\b/, name: /^(porta (de madeira|de aluminio|de correr|pivotante|lisa|almofadada|pronta)|janela|portao)\b/ },
  { id: "casa.jardim", label: "Jardim e plantas (vasos, terra, mangueira)", domain: "casa", query: "vaso de planta", aliases: ["terra adubada", "mangueira", "adubo", "planta", "regador"], flags: ["gift"],
    cat: /\b(jardim|jardinagem|plantas?|vasos? (de|para) plantas?|planta vaso|mangueiras?|terras?|adubos?|fertilizantes?|sementes?|regadores?|cachepos?|substratos?|grama)\b/, notCat: /\b(artificia(l|is)|pet|aquario|plantas? (dos|para) pes|planta do pe|sanitarios?|casa jardim (cachorro|gato))\b/, name: /^(vaso (de|para) planta|terra adubada|adubo|mangueira|regador|semente|substrato)\b/ },
  { id: "casa.churrasco", label: "Churrasco (carvão, churrasqueira, espetos)", domain: "casa", query: "carvao", aliases: ["churrasqueira", "espeto", "acendedor", "grelha", "kit churrasco"],
    cat: /\b(churrasqueiras?|churrasco|espetos?|grelhas? (de|para) churrasco|carvao|carvoes|acendedor(es)?|lenhas?|kit churrasco)\b/, notCat: /\b(facas?|talheres?|tabuas?|sabor|tempero|pet|petiscos?|bifinhos?|carnes?|salgadinhos?|linguicas?)\b/, name: /^(carvao|churrasqueira|espeto|acendedor|grelha para churrasco|kit churrasco)\b/ },
  { id: "casa.camping_praia", label: "Praia, camping e lazer (cadeira de praia, cooler, guarda-sol)", domain: "casa", query: "cadeira de praia", aliases: ["guarda sol", "cooler", "caixa termica", "barraca", "bolsa termica"],
    cat: /\b(praia|camping|lazer|piscina inflave(l|is)|coolers?|caixas? termicas?|bolsas? termicas?|guarda sois?|guarda sol|barracas?|cadeiras? de praia)\b/, notCat: /\b(moda|biquinis?|maios?|sungas?|calcados?|toalhas?|pet|chinelos?|protetor|solar|lancheiras?)\b/, name: /^(cadeira de praia|guarda sol|cooler|caixa termica|bolsa termica|barraca)\b/ },

  // ======================= FESTA =======================
  { id: "festa.artigos", label: "Artigos de festa (balões, velas de aniversário, decoração)", domain: "casa", query: "artigos para festa", aliases: ["balao", "vela de aniversario", "bexiga", "kit festa", "lembrancinha"], flags: ["kids", "gift"],
    cat: /\b(festas?|baloes|balao|bexigas?|velas? de aniversario|aniversario|lembrancinhas?|confetes?|descartaveis para festa|artigos? de festa|natal|decoracao de natal|arvores? de natal)\b/, notCat: /\b(fantasias?|roupas?|vestidos?)\b/, name: /^(balao|bexiga|vela de aniversario|kit festa|lembrancinha|enfeite de natal|arvore de natal)\b/ },
  { id: "brinquedo.faz_de_conta", label: "Fantasias", domain: "brinquedo", query: "fantasia infantil", aliases: ["fantasia de super heroi", "fantasia de princesa", "fantasia adulto"], flags: ["kids", "gift"],
    cat: /\bfantasias?\b/, notCat: /\b(pet|caes|gatos?)\b/, name: /^fantasia\b/ },

  // ======================= ELETRÔNICOS E ELETRO =======================
  { id: "eletronico.airfryer", label: "Air fryer e fritadeiras", domain: "eletronico", query: "air fryer", aliases: ["fritadeira eletrica", "fritadeira sem oleo"],
    cat: /\b(air ?fryers?|fritadeiras?)\b/, name: /^(air ?fryer|fritadeira)\b/ },
  { id: "eletronico.liquidificador", label: "Liquidificadores, mixers e batedeiras", domain: "eletronico", query: "liquidificador", aliases: ["mixer", "batedeira", "processador de alimentos", "blender"],
    cat: /\b(liquidificador(es)?|blenders?|mixers?|processador(es)?( de alimentos)?|batedeiras?|multiprocessador(es)?|espremedor(es)?|centrifugas?|extrator(es)? de suco)\b/, name: /^(liquidificador|mixer|batedeira|processador|blender|espremedor|centrifuga)\b/ },
  { id: "eletronico.cafeteira", label: "Cafeteiras e máquinas de café", domain: "eletronico", query: "cafeteira", aliases: ["maquina de cafe", "cafeteira eletrica", "nespresso", "dolce gusto (maquina)"],
    cat: /\b(cafeteiras?|maquinas? de cafe|espresso|chaleiras? eletricas?)\b/, notCat: /\b(capsulas?|cafe em po)\b/, name: /^(cafeteira|maquina de cafe|chaleira eletrica)\b/ },
  { id: "eletronico.cozinha_eletrica", label: "Sanduicheira, grill, forno elétrico e micro-ondas", domain: "eletronico", query: "sanduicheira", aliases: ["grill", "forno eletrico", "micro ondas", "torradeira", "panela eletrica", "pipoqueira"],
    cat: /\b(sanduicheiras?|grills?|torradeiras?|fornos?( eletricos?)?|micro ?ondas|panelas? eletricas?|panelas? de arroz|multicookers?|pipoqueiras?|fogoes|fogao|cooktops?|coifas?|depuradores?|waffle(ira)?s?|eletroportateis)\b/, notCat: /\b(assadeiras?|refratarios?|formas?|liquidificador|cafeteiras?|aspirador|ventilador|ferro|air ?fryer|fritadeira)\b/, name: /^(sanduicheira|grill|torradeira|forno eletrico|micro ?ondas|panela eletrica|panela de arroz|pipoqueira|fogao|cooktop)\b/ },
  { id: "eletronico.eletrodomesticos", label: "Geladeiras, lavadoras e eletrodomésticos grandes", domain: "eletronico", query: "geladeira", aliases: ["maquina de lavar", "freezer", "frigobar", "lava loucas", "adega climatizada"],
    cat: /\b(geladeiras?|refrigeradores?|freezers?|frigobar(es)?|lava loucas|lavadoras?|maquinas? de lavar|secadoras?|lava e seca|adegas? climatizadas?|eletrodomesticos?|purificadores? de agua|bebedouros?)\b/, notCat: /\b(pet|organizador|limpeza|detergente|potes?)\b/, name: /^(geladeira|refrigerador|freezer|frigobar|lavadora|maquina de lavar|secadora|lava loucas|purificador de agua|bebedouro)\b/ },
  { id: "eletronico.aspirador", label: "Aspiradores de pó e robôs", domain: "eletronico", query: "aspirador de po", aliases: ["robo aspirador", "aspirador vertical", "vassoura eletrica"],
    cat: /\b(aspirador(es)?|robos? aspirador(es)?|vassouras? eletricas?|enceradeiras?|lavadoras? de alta pressao|limpeza eletrica)\b/, name: /^(aspirador|robo aspirador|vassoura eletrica|lavadora de alta pressao)\b/ },
  { id: "eletronico.ferro_passar", label: "Ferros de passar e vaporizadores", domain: "eletronico", query: "ferro de passar", aliases: ["vaporizador de roupas", "ferro a vapor"],
    cat: /\b(ferros? de passar|ferros?|vaporizador(es)?|passadeiras? a vapor|tabuas? de passar|aparelhos de passar roupa|passar roupa)\b/, notCat: /\b(cabelo|prancha|ferro fundido|panelas?|ferragens|ferramentas?|vitamina|suplemento)\b/, name: /^(ferro (de passar|a vapor)|vaporizador|tabua de passar)\b/ },
  { id: "eletronico.ventilador_ar", label: "Ventiladores, ar-condicionado e aquecedores", domain: "eletronico", query: "ventilador", aliases: ["ar condicionado", "climatizador", "aquecedor", "circulador de ar"],
    cat: /\b(ventiladores?|ar condicionado|ares condicionados|climatizador(es)?|aquecedor(es)?|circuladores?|ar e ventilacao|desumidificador(es)?|umidificador(es)?|ventilacao)\b/, notCat: /\b(agua|solar|chuveiro|piscina|pet|aquario)\b/, name: /^(ventilador|ar condicionado|climatizador|aquecedor|circulador|umidificador)\b/ },
  { id: "eletronico.cuidados_pessoais", label: "Secador, prancha e barbeador elétrico", domain: "eletronico", query: "secador de cabelo", aliases: ["prancha de cabelo", "chapinha", "barbeador eletrico", "aparador de pelos", "escova secadora"],
    cat: /\b(secador(es)?|pranchas?|chapinhas?|modelador(es)?|maquinas? de cortar cabelo|beleza portatil|escovas? secadoras?|escovas? rotativas?|barbeador(es)? eletric[oa]s?|aparador(es)?|depilador(es)?|cortador(es)? de cabelo|beleza eletric[oa]s?|cuidados pessoais eletric[oa]s?)\b/, notCat: /\b(unhas|maquiagem|esmalte|surf|stand up)\b/, name: /^(secador|prancha|chapinha|modelador|escova (secadora|rotativa)|barbeador|aparador|depilador|cortador de cabelo)\b/ },
  { id: "eletronico.tv", label: "TVs e acessórios de TV", domain: "eletronico", query: "smart tv", aliases: ["televisao", "tv 50 polegadas", "suporte de tv", "tv box"],
    cat: /\b(tvs?|televis[a-z]*|smart tvs?|televisores?|tv e video|suportes? de tv)\b/, notCat: /\b(paineis|rack|moveis|estante)\b/, name: /^(smart tv|tv|televisao|televisor|suporte (de|para) tv)\b/ },
  { id: "eletronico.celular", label: "Celulares, smartphones e smartwatches", domain: "eletronico", query: "celular", aliases: ["smartphone", "moto g", "iphone", "samsung galaxy"],
    cat: /\b(celulares?|smartphones?|telefonia|telefones?)\b/, notCat: /\b(capas?|capinhas?|peliculas?|carregador(es)?|cabos?|acessorios|suportes?|fones?)\b/, name: /^(smartphone|celular|motorola (moto|edge|razr)|moto (g|e|edge)|iphone|samsung galaxy)\b/ },
  { id: "eletronico.acessorios_celular", label: "Carregadores, cabos, capinhas e power banks", domain: "eletronico", query: "carregador de celular", aliases: ["cabo usb", "capinha", "power bank", "pelicula", "suporte de celular"],
    cat: /\b(carregador(es)?|cabos? usb|cabos?|capas? (de|para) celular|capinhas?|peliculas?|power ?banks?|baterias? portateis|acessorios (de|para) celular|acessorios para smartphones?|suportes? (de|para) celular|adaptador(es)?)\b/, notCat: /\b(eletric[ao]s?|materiais eletricos|pilhas?|cabos? (de vassoura|de panela|flexive(l|is))|ferramentas?|pet|tomada)\b/, name: /^(carregador|cabo (usb|tipo c|lightning)|capinha|capa (de|para) celular|pelicula|power ?bank|bateria portatil|suporte (de|para) celular)\b/ },
  { id: "eletronico.audio", label: "Fones", domain: "eletronico", query: "fone de ouvido bluetooth", aliases: ["fone bluetooth", "headphone", "headset", "earbuds"],
    cat: /\b(fones?( de ouvido)?|headphones?|headsets?|earbuds?|audio pessoal)\b/, name: /^(fone|headphone|headset|earbuds?)\b/ },
  { id: "eletronico.audio", label: "Fones de ouvido e caixas de som", domain: "eletronico", query: "caixa de som bluetooth", aliases: ["caixa de som portatil", "soundbar", "jbl", "som"],
    cat: /\b(caixas? de som|caixas? acusticas?|som portatil|soundbars?|alto falantes?|audio|home theater|microsystems?|radios?|vitrolas?|toca discos)\b/, notCat: /\b(fones?|headphones?|audiolivros?|carros?|automotiv[a-z]*)\b/, name: /^(caixa de som|soundbar|radio|vitrola|home theater)\b/ },
  { id: "eletronico.informatica", label: "Informática e casa conectada (notebook, tablet, câmera de segurança)", domain: "eletronico", query: "notebook", aliases: ["tablet", "mouse", "teclado", "monitor", "impressora", "pen drive"],
    cat: /\b(notebooks?|computador(es)?|tablets?|monitores?|informatica|mouses?|teclados?|impressoras?|pen ?drives?|cartoes? de memoria|hds?|ssds?|roteador(es)?|webcams?|perifericos)\b/, notCat: /\b(papelaria|escolar|cartuchos? (de )?tinta)\b/, name: /^(notebook|tablet|ipad|mouse|teclado|monitor|impressora|pen ?drive|cartao de memoria|roteador|webcam)\b/ },
  { id: "eletronico.games", label: "Videogames, consoles e jogos", domain: "eletronico", query: "video game", aliases: ["playstation", "xbox", "nintendo switch", "controle de video game", "jogo de video game"], flags: ["gift"],
    cat: /\b(games?|videogames?|video games?|consoles?|playstation|xbox|nintendo|gamer)\b/, notCat: /\b(cadeiras?|livros?|jogos? de tabuleiro|cartas)\b/, name: /^(console|playstation|xbox|nintendo switch|controle (de|para) (video game|ps5|ps4|xbox)|jogo (para|de) (ps4|ps5|xbox|switch))\b/ },
  { id: "eletronico.celular", label: "Smartwatch", notName: /\b(parede|despertador)\b/, domain: "eletronico", query: "smartwatch", aliases: ["relogio inteligente", "smartband", "relogio"], flags: ["gift"],
    cat: /\b(smartwatch(es)?|relogios? inteligentes?|smartbands?|relogios?|wearables?)\b/, notCat: /\b(parede|despertador(es)? infantil|decor[a-z]*)\b/, name: /^(smartwatch|relogio|smartband)\b/ },
  { id: "eletronico.informatica", label: "Câmeras", domain: "eletronico", query: "camera de seguranca", aliases: ["camera wi-fi", "fechadura digital", "lampada inteligente", "alexa"],
    cat: /\b(cameras? de seguranca|seguranca eletronica|casa inteligente|smart home|cameras? (ip|wi ?fi)|alarmes?|interfones?|videoporteiros?|cameras?|cameras digitais)\b/, notCat: /\b(brinquedos?|infantil)\b/, name: /^(camera (de seguranca|wi ?fi|ip)|fechadura digital|lampada inteligente|echo dot|alexa|videoporteiro|interfone)\b/ },

  // ======================= BRINQUEDOS =======================
  { id: "brinquedo.lego_blocos", label: "LEGO e blocos de montar", domain: "brinquedo", query: "lego", aliases: ["blocos de montar", "lego duplo", "brinquedo de montar"], flags: ["kids", "gift"],
    cat: /\b(lego|blocos? de montar|blocos? de encaixe|brinquedos? de montar|montar e construir|brinquedos? de construcao)\b/, notCat: /\b(concreto|cimento|anotac[a-z]*|notas|adesivos?)\b/, name: /^(lego|blocos de montar)\b/ },
  { id: "brinquedo.boneca", label: "Bonecas e acessórios", domain: "brinquedo", query: "boneca", aliases: ["barbie", "boneca bebe", "casinha de boneca", "baby alive"], flags: ["kids", "gift"],
    cat: /\bbonecas?\b/, notCat: /\b(roupas? de boneca adulto)\b/, name: /^(boneca|barbie|baby alive|casa (de|da) boneca)\b/ },
  { id: "brinquedo.boneco", label: "Bonecos e figuras de ação (heróis, personagens)", domain: "brinquedo", query: "boneco de acao", aliases: ["boneco super heroi", "action figure", "boneco homem aranha", "funko"], flags: ["kids", "gift"],
    cat: /\b(bonecos?|figuras? de acao|action figures?|personagens|herois|super herois|funkos?)\b/, notCat: /\b(bonecas?|pelucias?|cartas)\b/, name: /^(boneco|figura de acao|action figure|funko)\b/ },
  { id: "brinquedo.carrinho", label: "Carrinhos, pistas e controle remoto", domain: "brinquedo", query: "carrinho de brinquedo", aliases: ["hot wheels", "pista de carrinho", "carrinho de controle remoto", "caminhao de brinquedo"], flags: ["kids", "gift"],
    cat: /\b(veiculos? de brinquedo|carrinhos?|hot wheels|pistas?|autoramas?|controle remoto|veiculos?|caminhoes?|trens?|avioes?|drones?)\b/, notCat: /\b(bebe|passeio|compras|mao|feira|carrinho de bebe|supermercado)\b/, name: /^(carrinho|hot wheels|pista|caminhao de brinquedo|veiculo|drone)\b/ },
  { id: "brinquedo.pelucia", label: "Pelúcias", domain: "brinquedo", query: "pelucia", aliases: ["urso de pelucia", "bicho de pelucia", "stitch pelucia"], flags: ["kids", "gift"],
    cat: /\bpelucias?\b/, name: /^(pelucia|urso de pelucia)\b/ },
  { id: "brinquedo.jogo_tabuleiro", label: "Jogos de tabuleiro, cartas e quebra-cabeças", domain: "brinquedo", query: "jogo de tabuleiro", aliases: ["banco imobiliario", "uno", "jogo da memoria", "jogo de cartas", "domino"], flags: ["kids", "gift"],
    cat: /\b(jogos? de tabuleiro|jogos? de estrategia|jogos? de mesa|jogos? de cartas|jogos? de acao|jogos? educativos?|jogos? classicos?|jogos? (de )?raciocinio|passatempos?|jogos?)\b/, notCat: /\b(video ?games?|consoles?|cama|banheiro|lencol|panelas?|talheres?|pratos?|copos?|tacas?|toalhas?|chaves|ferramentas?|pokemon)\b/, name: /^(jogo (de tabuleiro|da memoria|de cartas)|uno|domino|banco imobiliario|xadrez|dama)\b/ },
  { id: "brinquedo.jogo_tabuleiro", label: "Quebra-cabeças", domain: "brinquedo", query: "quebra cabeca", aliases: ["puzzle", "quebra cabeca 1000 pecas"], flags: ["kids", "gift"],
    cat: /\b(quebra cabecas?|puzzles?)\b/, name: /^(quebra cabeca|puzzle)\b/ },
  { id: "brinquedo.cartas_colecionaveis", label: "Cartas colecionáveis (Pokémon) e figurinhas", domain: "brinquedo", query: "cartas pokemon", aliases: ["pokemon tcg", "figurinhas", "booster"], flags: ["kids", "gift"],
    cat: /\b(pokemon|cartas? colecionave(l|is)|figurinhas?|cards?|tcg)\b/, name: /^(cartas? pokemon|pokemon|booster|figurinhas?|album de figurinhas)\b/ },
  { id: "brinquedo.bebe", label: "Brinquedos para bebê (0–2 anos)", domain: "brinquedo", query: "brinquedo para bebe", aliases: ["mordedor", "chocalho", "tapete de atividades", "mobile", "andador"], flags: ["kids", "gift"],
    cat: /\b(brinquedos? (para|de) bebes?|brinquedos? e atividades|primeiros passos|chocalhos?|tapetes? de atividades?|mobiles?|andador(es)?|baby brinquedos|0 a 2|interativos? para bebe)\b/, notCat: /\b(fraldas?|lencos?|mamadeiras?|chupetas?|roupas?|moda|formula|papinhas?)\b/, name: /^(brinquedo (para|de) bebe|chocalho|tapete de atividades|mobile|andador)\b/ },
  { id: "brinquedo.arte", label: "Massinha, arte e atividades (slime, pintura)", domain: "brinquedo", query: "massinha de modelar", aliases: ["play doh", "slime", "kit de pintura", "kit de arte infantil"], flags: ["kids", "gift"],
    cat: /\b(massas? de modelar|massinhas?|artes?|atividades|slime|pintura infantil|kits? de arte|desenho|artesanato|ciencias?|experiencias?|criatividade)\b/, notCat: /\b(livros?|marciais|artes e entretenimento|culinaria)\b/, name: /^(massinha|massa de modelar|play doh|slime|kit de (arte|pintura))\b/ },
  { id: "brinquedo.ar_livre", label: "Bicicletas, patinetes e brinquedos ao ar livre", domain: "brinquedo", query: "bicicleta infantil", aliases: ["patinete", "skate", "bola", "piscina infantil", "triciclo"], flags: ["kids", "gift"],
    cat: /\b(bicicletas?|bikes?|patinetes?|skates?|patins|triciclos?|motocas?|velocipedes?|bolas?|piscinas?|playground|escorregador(es)?|balancos?|ar livre|esportes?|cama elastica|lancadores?|lancador|nerf)\b/, notCat: /\b(moda|roupas?|calcados?|pet|caes|gatos?|tenis|bolas? de banho)\b/, name: /^(bicicleta|patinete|skate|patins|triciclo|bola|piscina|nerf|lancador)\b/ },
  { id: "brinquedo.faz_de_conta", label: "Faz de conta e fantasias (cozinhinha, casinha, maleta)", domain: "brinquedo", query: "brinquedo de cozinha", aliases: ["cozinha de brinquedo", "maleta de medico", "casinha de brinquedo", "kit de beleza infantil"], flags: ["kids", "gift"],
    cat: /\b(faz de conta|cozinhas? infantis?|cozinhinhas?|casinhas?|maletas?|profissoes|imitacao|beleza infantil|brincar de casinha|supermercado de brinquedo|ferramentas? de brinquedo)\b/, name: /^(cozinha (de brinquedo|infantil)|cozinhinha|maleta|casinha|kit (medico|beleza) infantil)\b/ },
  { id: "brinquedo.instrumentos_musicais", label: "Instrumentos musicais e brinquedos musicais", domain: "brinquedo", query: "instrumento musical infantil", aliases: ["teclado infantil", "violao infantil", "microfone infantil"], flags: ["kids", "gift"],
    cat: /\b(instrumentos? musica(l|is)|musicais|musica|teclados? infantis?|violoes?|violao|baterias? infantis?|microfones?)\b/, notCat: /\b(livros?|informatica|computador)\b/, name: /^(teclado infantil|violao|microfone infantil|bateria infantil|instrumento musical)\b/ },

  // ======================= MODA =======================
  { id: "moda.tenis", label: "Tênis", domain: "moda", query: "tenis", aliases: ["tenis de corrida", "tenis casual", "tenis feminino", "tenis masculino"], flags: ["gift"],
    cat: /\b(tenis|corrida|running|calcados? esportivos?|sneakers?|treino calcados)\b/, notCat: /\b(mesa|raquete|bola|meias?|camisetas?|roupas?|bermudas?|shorts?|jaquetas?)\b/, name: /^tenis\b/ },
  { id: "moda.sapato_sandalia", label: "Sapatos, sandálias e botas", domain: "moda", query: "sandalia", aliases: ["sapato", "bota", "scarpin", "sapatilha", "mocassim", "rasteira"], flags: ["gift"],
    cat: /\b(sapatos?|sapatilhas?|scarpins?|mocassins?|botas?|sandalias?|rasteiras?|calcados?|tamancos?|mules?|oxfords?|loafers?|peep toes?|anabelas?|saltos?)\b/, notCat: /\b(tenis|meias?|limpeza|sapateiras?|pet)\b/, name: /^(sapato|sapatilha|scarpin|mocassim|bota|sandalia|rasteira|tamanco|mule|loafer)\b/ },
  { id: "moda.chinelo", label: "Chinelos, slides e pantufas", domain: "moda", query: "chinelo", aliases: ["havaianas", "slide", "chinelo de dedo"],
    cat: /\b(chinelos?|slides?|havaianas|sandalias? de dedo|pantufas?)\b/, name: /^(chinelo|slide|havaianas|pantufa)\b/ },
  { id: "moda.camiseta", label: "Camisetas, regatas, polos e roupa de treino", domain: "moda", query: "camiseta", aliases: ["camiseta basica", "regata", "camisa polo", "t-shirt"], flags: ["gift"],
    cat: /\b(camisetas?|t shirts?|regatas?|polos?|camisas? polo|tops? esportivos?|confeccao camiseta)\b/, notCat: /\b(pet|caes|gatos?)\b/, name: /^(camiseta|t shirt|regata|camisa polo|polo)\b/ },
  { id: "moda.camisa", label: "Camisas sociais e casuais", domain: "moda", query: "camisa social", aliases: ["camisa masculina", "camisa de linho", "camisa xadrez"], flags: ["gift"],
    cat: /\b(camisas?|camisaria)\b/, notCat: /\b(camisas? polo|camisetas?|times?|futebol)\b/, name: /^camisa\b(?! polo)/ },
  { id: "moda.blusa", label: "Blusas e tops femininos", domain: "moda", query: "blusa feminina", aliases: ["blusa", "cropped", "top", "body"], flags: ["gift"],
    cat: /\b(blusas?|blusinhas?|croppeds?|tops?|bodies|bodys?|batas?)\b/, notCat: /\b(moletons?|frio|tricot|esportivos?|biquinis?|pet)\b/, name: /^(blusa|cropped|top|body|bata)\b/ },
  { id: "moda.calca_bermuda", label: "Calças, jeans, bermudas e shorts", domain: "moda", query: "calca jeans", aliases: ["bermuda", "short", "calca de moletom", "jeans", "legging"],
    cat: /\b(calcas?|jeans|bermudas?|shorts?|saias? shorts?|leggings?|jogger|alfaiataria)\b/, notCat: /\b(pet|caes|gatos?|banho|praia|sungas?)\b/, name: /^(calca|bermuda|short|jeans|legging|jogger)\b/ },
  { id: "moda.vestido_saia", label: "Vestidos, saias e macacões", domain: "moda", query: "vestido", aliases: ["saia", "macacao", "vestido longo", "vestido de festa"], flags: ["gift"],
    cat: /\b(vestidos?|saias?|macacoes|macacao|macaquinhos?|conjuntos?)\b/, notCat: /\b(pet|bebe body|saias? (para|de) cama|conjuntos? de (cha|panelas|talheres|potes|facas|copos|jantar|banheiro|ferramentas|chaves))\b/, name: /^(vestido|saia|macacao|macaquinho)\b/ },
  { id: "moda.casaco_moletom", label: "Casacos, jaquetas e moletons", domain: "moda", query: "moletom", aliases: ["jaqueta", "casaco", "blusa de frio", "corta vento", "cardigan"], flags: ["gift"],
    cat: /\b(casacos?|jaquetas?|moletons?|blusas? de frio|blusoes|blusao|cardigans?|tricots?|malhas?|coletes?|corta ventos?|parkas?|sueteres?|sueter|hoodies?|agasalhos?)\b/, notCat: /\b(pet|caes|gatos?|salva vidas)\b/, name: /^(casaco|jaqueta|moletom|blusa de frio|cardigan|tricot|colete|corta vento|sueter|agasalho)\b/ },
  { id: "moda.pijama", label: "Pijamas e roupas de dormir", domain: "moda", query: "pijama", aliases: ["camisola", "pijama infantil", "short doll"], flags: ["gift"],
    cat: /\b(pijamas?|camisolas?|roupas? de dormir|short dolls?|sleepwear|homewear|loungewear)\b/, name: /^(pijama|camisola|short doll)\b/ },
  { id: "moda.roupa_intima", label: "Roupa íntima (cuecas, calcinhas, sutiãs)", domain: "moda", query: "cueca", aliases: ["calcinha", "sutia", "lingerie", "cueca boxer"],
    cat: /\b(cuecas?|calcinhas?|sutias?|lingeries?|moda intima|roupas? intimas?|underwear|boxers?)\b/, notCat: /\b(descartave(l|is)|absorventes?|geriatric[a-z]*|incontinencia)\b/, name: /^(cueca|calcinha|sutia|lingerie)\b/ },
  { id: "moda.meia", label: "Meias", domain: "moda", query: "meia", aliases: ["meia soquete", "meia cano alto", "kit de meias", "meia de compressao"],
    cat: /\b(meias?|soquetes?|meia calca)\b/, notCat: /\b(meia estacao|meia idade)\b/, name: /^(meia|kit (de )?meias?|soquete)\b/ },
  { id: "moda.praia", label: "Moda praia (biquíni, maiô, sunga)", domain: "moda", query: "biquini", aliases: ["maio", "sunga", "saida de praia", "short de banho"], flags: ["gift"],
    cat: /\b(biquinis?|maios?|sungas?|moda praia|praia|saidas? de praia|beachwear|shorts? de banho|swimwear)\b/, notCat: /\b(cadeiras?|guarda sol|toalhas?|bolsas?|chinelos?|barracas?)\b/, name: /^(biquini|maio|sunga|saida de praia)\b/ },
  { id: "moda.camiseta", label: "Fitness", domain: "moda", query: "legging fitness", aliases: ["top fitness", "short de corrida", "camiseta dry fit", "conjunto fitness"],
    cat: /\b(fitness|academia|treino|esportivas?|dry fit|performance|ciclismo|futebol|basquete|yoga|corrida roupas)\b/, notCat: /\b(calcados?|tenis|garrafas?|suplementos?)\b/ },
  { id: "moda.bolsa_mochila", label: "Bolsas, mochilas e carteiras", domain: "moda", query: "bolsa feminina", aliases: ["mochila", "carteira", "necessaire", "pochete", "bolsa transversal"], flags: ["gift"],
    cat: /\b(bolsas?|carteiras?|mochilas?|pochetes?|necessaires?|clutch(es)?|mala|malas|bagagens?|bolsas? transversais?|porta documentos)\b/, notCat: /\b(termicas?|de agua quente|de gel|pet|caes|gatos?|transporte|escolar|lancheiras?|maternidade)\b/, name: /^(bolsa|carteira|mochila|pochete|necessaire|clutch|mala de viagem)\b/ },
  { id: "moda.acessorios", label: "Acessórios (boné, cinto, óculos, bijuteria)", domain: "moda", query: "bone", aliases: ["cinto", "oculos de sol", "bijuteria", "brinco", "colar", "chapeu"], flags: ["gift"],
    cat: /\b(bones?|chapeus?|cintos?|oculos( de sol)?|bijuterias?|joias?|brincos?|colares?|pulseiras?|aneis|anel|acessorios|cachecois|cachecol|lencos?|gorros?|luvas?|viseiras?)\b/, notCat: /\b(celular|cabelo|cozinha|banheiro|maquiagem|carros?|pet|caes|gatos?|limpeza|lencos? umedecidos?|lencos? de papel|natacao|seguranca|ferramentas?)\b/, name: /^(bone|chapeu|cinto|oculos|brinco|colar|pulseira|anel|gorro|cachecol)\b/ },

  // ======================= LIVRARIA E PAPELARIA =======================
  { id: "livraria.infantil", label: "Livros infantis e infantojuvenis", domain: "livraria", query: "livro infantil", aliases: ["livro para crianca", "livro de historia infantil", "livro juvenil"], flags: ["kids", "gift"],
    cat: [BOOK_CTX, /\b(infantil|infantis|infantojuvenil|infanto juvenil|juvenil|criancas?|bebes?)\b/], notCat: /\b(psicologia infantil|educacao infantil|pedagogia)\b/ },
  { id: "livraria.quadrinhos", label: "Quadrinhos, mangás e graphic novels", domain: "livraria", query: "manga", aliases: ["hq", "quadrinhos", "graphic novel", "gibi"], flags: ["gift"],
    cat: [/\b(livros?|papelaria|historias em quadrinhos)\b/, /\b(quadrinhos|mangas?|hqs?|graphic novels?|gibis?|historias em quadrinhos)\b/] },
  { id: "livraria.literatura", label: "Literatura, biografias e passatempos (romance, poesia, colorir)", domain: "livraria", query: "livro de romance", aliases: ["romance", "livro de ficcao", "poesia", "best seller", "suspense"], flags: ["gift"],
    cat: [BOOK_CTX, /\b(romances?|literatura|ficcao|poesias?|contos?|cronicas?|suspense|fantasia|thriller|policial|best sellers?|classicos?|terror)\b/], notCat: /\b(infantil|infantis|infantojuvenil|juvenil|quadrinhos|teoria|critica literaria|direito)\b/ },
  { id: "livraria.autoajuda", label: "Autoajuda, espiritualidade, religião e Bíblias", domain: "livraria", query: "livro de autoajuda", aliases: ["desenvolvimento pessoal", "livro motivacional", "espiritualidade"], flags: ["gift"],
    cat: [BOOK_CTX, /\b(autoajuda|auto ajuda|desenvolvimento pessoal|motivaca[a-z]*|esoterismo|espiritualidade|bem estar)\b/] },
  { id: "livraria.literatura", label: "Biografias e memórias", domain: "livraria", query: "biografia", aliases: ["livro de memorias", "autobiografia"], flags: ["gift"],
    cat: [BOOK_CTX, /\b(biografias?|memorias|autobiografias?)\b/] },
  { id: "livraria.autoajuda", label: "Religião", domain: "livraria", query: "biblia", aliases: ["livro religioso", "teologia", "livro catolico", "livro evangelico"], flags: ["gift"],
    cat: [BOOK_CTX, /\b(religia[a-z]*|religioes|religiosos?|cristianismo|teologia|biblias?|espiritismo|catolicismo|evangelic[oa]s?|judaismo|budismo)\b/] },
  { id: "livraria.nao_ficcao", label: "xLivros de culinária e gastronomia", domain: "livraria", query: "livro de receitas", aliases: ["livro de culinaria", "gastronomia"], flags: ["gift"],
    cat: [BOOK_CTX, /\b(culinaria|gastronomia|receitas|vinhos e bebidas)\b/] },
  { id: "livraria.nao_ficcao", label: "xNegócios, finanças e carreira", domain: "livraria", query: "livro de financas", aliases: ["livro de negocios", "empreendedorismo", "marketing", "investimentos"],
    cat: [BOOK_CTX, /\b(administracao|negocios|economia|financas|marketing|empreendedorismo|carreira|lideranca|gestao|investimentos?|contabilidade)\b/] },
  { id: "livraria.nao_ficcao", label: "xLivros de direito", domain: "livraria", query: "livro de direito", aliases: ["codigo civil", "vade mecum", "direito penal"],
    cat: [BOOK_CTX, /\b(direito|juridic[oa]s?|vade mecum|codigos?)\b/] },
  { id: "livraria.nao_ficcao", label: "Não ficção (história, psicologia, negócios, direito, arte, culinária, idiomas)", domain: "livraria", query: "livro", aliases: ["psicologia", "historia", "sociologia", "politica", "psicanalise"],
    cat: [BOOK_CTX, /\b(filosofia|psicologia|psicanalise|sociologia|historia|geografia|politica|antropologia|ciencias humanas|ciencias sociais|educacao|pedagogia|comunicacao|jornalismo|teoria e critica|linguistica)\b/] },
  { id: "livraria.nao_ficcao", label: "xLivros de arte, arquitetura, design e fotografia", domain: "livraria", query: "livro de arte", aliases: ["arquitetura", "fotografia", "design", "cinema", "musica"], flags: ["gift"],
    cat: [BOOK_CTX, /\b(artes?|arquitetura|urbanismo|design|fotografia|cinema|musica|moda|teatro|danca)\b/] },
  { id: "livraria.nao_ficcao", label: "xCiências, saúde e livros técnicos", domain: "livraria", query: "livro de ciencias", aliases: ["medicina", "engenharia", "informatica", "matematica"],
    cat: [BOOK_CTX, /\b(ciencias?|medicina|saude|enfermagem|engenharia|informatica|tecnologia|matematica|fisica|quimica|biologia|tecnicos?|nutricao|veterinaria|odontologia)\b/], notCat: /\b(humanas|sociais|religia[a-z]*|ficcao)\b/ },
  { id: "livraria.nao_ficcao", label: "xIdiomas e dicionários", domain: "livraria", query: "livro de ingles", aliases: ["dicionario", "livro de espanhol", "idiomas"],
    cat: [BOOK_CTX, /\b(idiomas?|dicionarios?|ingles|espanhol|frances|alemao|italiano|linguas? estrangeiras?)\b/] },
  { id: "livraria.literatura", label: "Passatempos", domain: "livraria", query: "livro de colorir", aliases: ["caca palavras", "sudoku", "palavras cruzadas"],
    cat: [BOOK_CTX, /\b(passatempos?|colorir|jogos e passatempos|caca palavras|sudoku|palavras cruzadas|humor|entretenimento)\b/], notCat: /\b(quadrinhos)\b/ },
  { id: "papelaria.material_escolar", label: "Cadernos e agendas", domain: "livraria", query: "caderno", aliases: ["agenda", "planner", "caderno universitario", "bloco de notas"], flags: ["gift"],
    cat: /\b(cadernos?|agendas?|planners?|blocos? de (anotacoes|notas)|cadernetas?|fichario|sketchbooks?)\b/, name: /^(caderno|agenda|planner|bloco de (notas|anotacoes)|caderneta|fichario|sketchbook)\b/ },
  { id: "papelaria.material_escolar", label: "Escrita", domain: "livraria", query: "caneta", aliases: ["lapis de cor", "marca texto", "canetinha", "lapiseira", "borracha"], flags: ["kids"],
    cat: /\b(canetas?|lapis|lapiseiras?|marcador(es)?|marca textos?|borrachas?|apontador(es)?|estojos?|lapis de cor|giz de cera|canetinhas?|hidrocor|corretivos? (escolar|fita|liquido))\b/, notCat: /\b(olho|sobrancelha|labial|maquiagem|boca|delineador|cabelo|unhas?)\b/, name: /^(caneta|lapis|lapiseira|marca texto|borracha|apontador|estojo|giz de cera|canetinha)\b(?!.*\b(olho|labial|sobrancelha)\b)/ },
  { id: "papelaria.material_escolar", label: "Material escolar e de escritório (cadernos, canetas, lápis de cor, agendas)", domain: "livraria", query: "material escolar", aliases: ["cola", "tesoura sem ponta", "papel sulfite", "regua", "kit escolar"], flags: ["kids"],
    cat: /\b(material escolar|papelaria|papelaria escolar|kits? escolar(es)?|escolar|escritorio|colas?|tesouras?|reguas?|papel sulfite|papeis|pastas?|arquivos?|grampeador(es)?|etiquetas?|post it|clips)\b/, notCat: /\b(mochilas?|lancheiras?|cadernos?|agendas?|canetas?|lapis|embalag[a-z]*|presente|livros?|cabelo|unhas?|jardim|poda)\b/ },
  { id: "papelaria.mochila_lancheira", label: "Mochilas escolares e lancheiras", domain: "livraria", query: "mochila escolar", aliases: ["lancheira termica", "mochila de rodinha", "mochila infantil"], flags: ["kids", "gift"],
    cat: /\b(mochilas?|lancheiras?|lancheiras? termicas?|mochilas? escolar(es)?|mochilas e lancheiras)\b/, notCat: /\b(chaveiros?|necessaires?|garrafas?)\b/, name: /^(mochila|lancheira)\b/ },

  // ======================= PRESENTE =======================
  { id: "presente.flores", label: "Flores e buquês", domain: "presente", query: "buque de flores", aliases: ["rosas", "flores", "orquidea", "arranjo de flores", "cesta com flores"], flags: ["gift", "fresh"],
    cat: /\b(flores|buques?|buque|rosas|orquideas?|arranjos?( de flores)?|girassois|presente flores)\b/, notCat: /\b(artificiais|perfum[a-z]*|estampa|vestido|almofada)\b/, notName: /\b(locao|combo|perfume|colonia|hidratante|sabonete|body|desodorante|oleo|creme|brinquedo|kit|artificia(l|is)|estampa)\b/, name: /^(buque|rosas?|orquidea|arranjo|flores|girassol|cesta (de|com) flores)\b/ },
  { id: "presente.cesta", label: "Cestas de presente e café da manhã", domain: "presente", query: "cesta de cafe da manha", aliases: ["cesta de presente", "cesta de chocolate", "kit presente gourmet"], flags: ["gift"],
    cat: /\b(cestas? (de )?presentes?|cesta presente|cestas? de cafe( da manha)?|cestas? gourmet|kits? gourmet|cestas?)\b/, notCat: /\b(basquete|roupa|lixo|organiza[a-z]*|pet|banheiro|bicicleta)\b/, notName: /\b(basquete|bicicleta)\b/, stores: ["giulianaflores", "americanas", "imigrantes", "santaluzia", "divvino", "kopenhagen", "zonasul", "oba", "naturaldaterra", "carrefour", "mambo", "swift"], name: /^(cesta|kit gourmet)\b/ },
  { id: "presente.embalagem", label: "Embalagens e sacolas de presente", domain: "presente", query: "sacola de presente", aliases: ["papel de presente", "caixa de presente", "fita de presente"], flags: ["gift"],
    cat: /\b(embalagens? (e sacolas? )?para presente|sacolas? (de|para) presente|papel de presente|caixas? de presente|fitas? de cetim|embalagem para presente|embalagens?)\b/, notCat: /\b(descartave(l|is)|alimentos?|freezer|marmitas?)\b/, name: /^(sacola de presente|papel de presente|caixa de presente|saco de presente)\b/ }
];

// ---------------------------------------------------------------------------
type Compiled = Rule & { cats: RegExp[] };
// Nomes de vitrine costumam abrir com a marca ("Omo Lava Roupas", "NIVEA Creme Facial"): a âncora
// "^" das regex de nome vira fronteira de palavra; o desempate por "começa mais à esquerda" mantém
// o substantivo principal.
const COMPILED: Compiled[] = RULES.map((r) => ({
  ...r,
  cats: r.cat ? (Array.isArray(r.cat) ? r.cat : [r.cat]) : [],
  name: r.name ? new RegExp(r.name.source.replace(/\^/g, "\\b")) : undefined
}));

function catMatchEnd(rule: Compiled, cat: string): { end: number; len: number } | null {
  if (!rule.cats.length) return null;
  let end = -1;
  let len = 0;
  for (const re of rule.cats) {
    const g = new RegExp(re.source, "g");
    let m: RegExpExecArray | null;
    let best: { end: number; len: number } | null = null;
    while ((m = g.exec(cat))) {
      const e = m.index + m[0].length;
      if (!best || e > best.end || (e === best.end && m[0].length > best.len)) best = { end: e, len: m[0].length };
      // Casamentos sobrepostos: "banho toalha de piso" tem que ver "toalha de piso", não só "banho toalha".
      g.lastIndex = m.index + 1;
    }
    if (!best) return null;
    if (best.end > end || (best.end === end && best.len > len)) {
      end = best.end;
      len = best.len;
    }
  }
  return { end, len };
}

function allowed(rule: Compiled, store: string, cat: string): boolean {
  if (rule.stores && !rule.stores.includes(store)) return false;
  const doms = STORE_DOMAINS[store];
  if (doms && !doms.includes(rule.domain)) return false;
  const bare = cat.replace(/^mambo /, "");
  for (const [re, ds] of DEPARTMENTS) if (re.test(bare) && !ds.includes(rule.domain)) return false;
  const petCat = PET_CTX.test(cat) || store === "petz" || store === "cobasi";
  if (petCat !== (rule.domain === "pet")) return false;
  const bookCat = BOOK_CTX.test(cat);
  if (bookCat && rule.domain !== "livraria") return false;
  if (!bookCat && rule.id.startsWith("livraria.")) return false;
  return true;
}

function byCategory(store: string, cat: string, name: string): Compiled | null {
  let best: { rule: Compiled; end: number; len: number; idx: number } | null = null;
  COMPILED.forEach((rule, idx) => {
    if (!allowed(rule, store, cat)) return;
    const m = catMatchEnd(rule, cat);
    if (!m) return;
    if (rule.notCat?.test(cat)) return;
    if (rule.notName?.test(name)) return;
    if (rule.needText && !rule.needText.test(`${cat} ${name}`)) return;
    if (!best || m.end > best.end || (m.end === best.end && m.len > best.len)) best = { rule, end: m.end, len: m.len, idx };
  });
  return best ? (best as { rule: Compiled }).rule : null;
}

function byName(store: string, cat: string, name: string): Compiled | null {
  let best: { rule: Compiled; start: number; len: number } | null = null;
  for (const rule of COMPILED) {
    if (!rule.name || !allowed(rule, store, cat)) continue;
    if (rule.notName?.test(name)) continue;
    const m = rule.name.exec(name);
    if (!m) continue;
    if (!best || m.index < best.start || (m.index === best.start && m[0].length > best.len)) best = { rule, start: m.index, len: m[0].length };
  }
  return best ? (best as { rule: Compiled }).rule : null;
}

// ---------------------------------------------------------------------------
type Acc = { count: number; stores: Map<string, number> };

function bump(acc: Map<string, Acc>, id: string, store: string) {
  let a = acc.get(id);
  if (!a) acc.set(id, (a = { count: 0, stores: new Map() }));
  a.count++;
  a.stores.set(store, (a.stores.get(store) ?? 0) + 1);
}

async function loadCatalogs(): Promise<{ store: string; items: CatalogItem[] }[]> {
  const files = readdirSync(STORES_DIR).filter((f) => f.endsWith("-catalog.ts")).sort();
  const out: { store: string; items: CatalogItem[] }[] = [];
  for (const f of files) {
    const mod = (await import(path.join(STORES_DIR, f))) as Record<string, unknown>;
    const items = Object.values(mod).find((v) => Array.isArray(v)) as CatalogItem[] | undefined;
    if (!items) continue;
    // drogariasp-mip-catalog.ts → drogariasp; carrefour-fresh-catalog.ts → carrefour.
    const store = f.replace(/-catalog\.ts$/, "").replace(/-(mip|fresh)$/, "");
    out.push({ store, items });
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const catalogs = await loadCatalogs();
  const acc = new Map<string, Acc>();
  const unmatched = new Map<string, { n: number; stores: Set<string>; sample: string }>();
  const samples = new Map<string, string[]>();
  let total = 0;
  let mipTotal = 0;
  let mipDropped = 0;
  let guarded = 0;

  for (const { store, items } of catalogs) {
    for (const item of items) {
      total++;
      const name = normalizeText(item.name ?? "");
      const cat = normalizeText(item.category ?? "");
      if (item.medicine === "mip") {
        mipTotal++;
        if (isPrescriptionText(`${item.name ?? ""} ${item.category ?? ""}`)) {
          mipDropped++;
          continue;
        }
        // Nome primeiro (a categoria da Drogaria SP junta classes: "remedios analgesicos antitermicos
        // relaxantes muscular" poria dipirona em relaxante); só sem classe pelo nome entra a categoria.
        const byNameOnly = MIP_RULES.filter((rule) => rule.match.test(name) && !rule.not?.test(name));
        const text = `${name} ${cat}`;
        const classes = byNameOnly.length ? byNameOnly : MIP_RULES.filter((rule) => rule.match.test(text) && !rule.not?.test(text));
        for (const rule of classes) {
          bump(acc, rule.id, store);
          if (REPORT) {
            const sm = samples.get(rule.id) ?? [];
            if (sm.length < 40) sm.push(`${store}:${item.name.slice(0, 48)}`);
            samples.set(rule.id, sm);
          }
        }
        continue;
      }
      // Mesmas guardas de runtime das vitrines: remédio fora da porta MIP não vira prateleira.
      if (isMedicine(item) || ((store === "petz" || store === "cobasi" || PET_CTX.test(cat)) && isVeterinaryMedicine(item))) {
        guarded++;
        continue;
      }
      const generic = !cat || GENERIC_CAT.test(cat) || GENERIC_TAIL.test(cat);
      const rule = generic ? byName(store, cat, name) ?? byCategory(store, cat, name) : byCategory(store, cat, name) ?? byName(store, cat, name);
      if (rule) {
        bump(acc, rule.id, store);
        if (REPORT) {
          const sm = samples.get(rule.id) ?? [];
          if (sm.length < 40) sm.push(`${store}:${item.name.slice(0, 48)} [${cat.slice(0, 60)}]`);
          samples.set(rule.id, sm);
        }
      }
      else if (REPORT) {
        const key = `${cat || "(sem categoria)"}`;
        const u = unmatched.get(key) ?? { n: 0, stores: new Set<string>(), sample: item.name };
        u.n++;
        u.stores.add(store);
        unmatched.set(key, u);
      }
    }
  }

  // Várias regras podem alimentar o mesmo nó (sinônimos/merges): o rótulo/consulta vêm da regra de
  // rótulo mais longo (a "principal", que descreve o nó inteiro); aliases e flags são a união.
  type Meta = { label: string; domain: ShelfDomain; query: string; aliases: string[]; flags: ShelfFlag[] };
  const meta = new Map<string, Meta>();
  const all = [...RULES.map((r) => ({ ...r, flags: r.flags ?? [] })), ...MIP_RULES.map((r) => ({ ...r, domain: "farmacia" as ShelfDomain, flags: ["mip"] as ShelfFlag[] }))];
  for (const r of all) {
    const m = meta.get(r.id);
    if (!m) {
      meta.set(r.id, { label: r.label, domain: r.domain, query: r.query, aliases: [...(r.aliases ?? [])], flags: [...r.flags] });
      continue;
    }
    if (m.domain !== r.domain) throw new Error(`domínio divergente em ${r.id}`);
    if (r.label.length > m.label.length) {
      m.aliases = [...(r.aliases ?? []), ...m.aliases];
      m.label = r.label;
      m.query = r.query;
    } else m.aliases.push(...(r.aliases ?? []));
    for (const f of r.flags) if (!m.flags.includes(f)) m.flags.push(f);
  }
  for (const m of meta.values()) m.aliases = [...new Set(m.aliases.filter((a) => normalizeText(a) !== normalizeText(m.query)))].slice(0, 8);

  const shelves: ShelfNode[] = [];
  const dropped: string[] = [];
  for (const [id, a] of acc) {
    const m = meta.get(id)!;
    if (a.count < MIN_ITEMS) {
      dropped.push(`${id} (${a.count})`);
      continue;
    }
    let stores = [...a.stores].filter(([, n]) => n >= 2).map(([s]) => s);
    if (!stores.length) stores = [...a.stores.keys()];
    const node: ShelfNode = {
      id,
      label: m.label,
      domain: m.domain,
      query: m.query,
      ...(m.aliases.length ? { aliases: [...m.aliases] } : {}),
      stores: stores.sort(),
      ...(m.flags.length ? { flags: [...m.flags] } : {}),
      itemCount: a.count
    };
    shelves.push(node);
  }
  shelves.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const ruleIds = new Set([...RULES.map((r) => r.id), ...MIP_RULES.map((r) => r.id)]);
  const neverHit = [...ruleIds].filter((id) => !acc.has(id));

  const assigned = [...acc.values()].reduce((s, a) => s + a.count, 0);
  console.error(`itens: ${total} (MIP ${mipTotal}, MIP de receita descartados ${mipDropped}, guardas ${guarded}) · atribuições ${assigned}`);
  console.error(`nós: ${shelves.length} · descartados (<${MIN_ITEMS}): ${dropped.join(", ") || "nenhum"}`);
  if (neverHit.length) console.error(`regras sem item: ${neverHit.join(", ")}`);
  console.error(`tempo: ${Date.now() - t0} ms`);
  if (REPORT) {
    const rows = [...unmatched.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 150);
    console.error("\n== categorias sem nó (top 150) ==");
    for (const [c, u] of rows) console.error(`${u.n}\t${[...u.stores].join(",")}\t${c}\t${u.sample}`);
    console.error("\n== nós ==");
    for (const s of shelves) {
      const sm = samples.get(s.id) ?? [];
      const pick = [0, 7, 15, 23, 31, 39].map((i) => sm[i]).filter(Boolean);
      console.error(`${s.itemCount}\t${s.id}\t${s.label}\t${s.stores.join(",")}\n      ${pick.join(" | ")}`);
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const map: ShelfMap = { generatedAt: date, shelves };
  const body =
    `// GERADO por scripts/build-shelf-map.mts em ${date} — NÃO editar à mão: ajuste a tabela de\n` +
    `// colapso (RULES/MIP_RULES) no script e rode \`NODE_USE_ENV_PROXY=1 npx tsx scripts/build-shelf-map.mts\`.\n` +
    `// ${shelves.length} prateleiras colapsadas das categorias reais de ${catalogs.length} catálogos (${total} itens).\n` +
    `import type { ShelfMap } from "./types";\n\n` +
    `export const SHELF_MAP: ShelfMap = {\n  generatedAt: ${JSON.stringify(map.generatedAt)},\n  shelves: [\n` +
    map.shelves.map((s) => `    ${JSON.stringify(s)}`).join(",\n") +
    `\n  ]\n};\n`;
  if (!DRY) {
    writeFileSync(OUT_FILE, body);
    console.error(`escrito: ${path.relative(ROOT, OUT_FILE)}`);
  }
}

await main();
