// Nome do pedido como a Lia o repete ao cliente (09/10, rodada 1): "Vamos um de cada vez: *sabão em pó omu*,
// depois *detergente ype*" repetia a digitação errada, enquanto os cards já mostravam Omo e Ypê. Usa as
// palavras das próprias opções encontradas (nome + marca) para escrever certo o que o cliente digitou torto:
// acento ("ype" → "Ypê") e erro de uma letra ("omu" → "Omo"). Nunca troca palavra que já existe nas opções.
// Puro e sem DB: o texto do cliente só muda quando uma opção traz a palavra parecida.

function plain(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  // "gatos" × "gato": plural/flexão não é erro de digitação.
  if (i === Math.min(a.length, b.length)) return false;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

const STOP_WORDS = new Set(["sem", "com", "para", "pra", "pro", "por", "uma", "uns", "que", "dos", "das", "nao", "mais", "bem"]);

export function displayQueryName(query: string, options: { name: string; brand?: string }[]): string {
  const vocab = new Map<string, string>(); // forma sem acento → forma do catálogo
  for (const option of options.slice(0, 3)) {
    for (const word of `${option.name} ${option.brand ?? ""}`.split(/[\s/,()-]+/)) {
      const key = plain(word);
      if (key.length >= 3 && !vocab.has(key)) vocab.set(key, word);
    }
  }
  if (!vocab.size) return query;
  const keys = [...vocab.keys()];
  return query
    .split(/(\s+)/)
    .map((token) => {
      const key = plain(token);
      if (key.length < 3 || /\d/.test(key)) return token;
      // Preposição/negação nunca é "erro de digitação" (10/10, rodada 4, B1): "sem cheiro" virava "Ser cheiro" por
      // causa de "Cansei de Ser Gato" no nome da areia.
      if (STOP_WORDS.has(key)) return token;
      const exact = vocab.get(key);
      if (exact) {
        // Mesma palavra: só corrige o acento ("ype" → "Ypê"); "leite" continua "leite".
        // Sigla do catálogo ("AAA", "LED", "FPS") volta em maiúsculas (10/10, rodada 10 g30: "pilha aaa").
        if (/^[A-Z]{2,4}$/.test(exact) && token === token.toLowerCase()) return exact;
        return plain(exact) === key && exact.toLowerCase() !== token.toLowerCase() && /[^\x00-\x7f]/.test(exact) ? exact : token;
      }
      // Palavra pequena demais para chutar (uma letra de diferença em 3 letras é ambíguo): só com candidato único.
      const near = keys.filter((k) => k[0] === key[0] && withinOneEdit(key, k));
      if (near.length !== 1) return token;
      const fixed = vocab.get(near[0])!;
      // Só o gênero/número ("recheada" × "Recheado") não é erro de digitação: o cliente escreveu certo (10/10, rodada 10
      // g30: "bolacha Recheado").
      if (key.slice(0, -1) === near[0].slice(0, -1) && /[aoe]$/.test(key) && /[aoe]$/.test(near[0])) return token;
      if (key.replace(/s$/, "").slice(0, -1) === near[0].replace(/s$/, "").slice(0, -1) && /[aoe]s?$/.test(key)) return token;
      return fixed;
    })
    .join("");
}
