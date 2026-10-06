// Cadastro pelo formulário do WhatsApp (06/10/2026, dono: "precisa pedir CEP, nome e CPF"
// e "pode pedir tudo direto no começo"). No primeiro contato a Lia manda um Flow (formulário
// nativo dentro do chat) com nome completo, CPF, CEP, número e complemento. A resposta chega
// pelo webhook como objeto (nfm_reply.response_json). Este módulo só LÊ e VALIDA; salvar e
// responder fica no cérebro (delivery-service.ts › handleSignupForm). Puro e testado.
import { isValidCpf } from "./medicine";

export type SignupForm = {
  // Nome completo normalizado (maiúsculas certas), ou null sem nome E sobrenome.
  name: string | null;
  // 11 dígitos com dígito verificador válido, ou null.
  cpf: string | null;
  // "01310-100", ou null sem 8 dígitos.
  cep: string | null;
  numero: string | null;
  complemento: string;
};

// A resposta do Flow de cadastro tem `nome` e `cpf`; a do Flow de endereço (número e
// complemento) tem `rua` e nunca `cpf`.
export function isSignupFormReply(payload: Record<string, unknown> | null | undefined): payload is Record<string, unknown> {
  return Boolean(payload && typeof payload === "object" && "cpf" in payload && "nome" in payload);
}

// O histórico da conversa (Message.text) guarda isto no lugar do formulário: o formulário
// traz o CPF, e documento não fica no texto da conversa.
export const SIGNUP_FORM_MESSAGE = "📝 Cadastro enviado pelo formulário";

const onlyDigits = (value: unknown) => String(value ?? "").replace(/\D/g, "");
const squash = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
const PARTICLES = /^(da|de|do|dos|das|e)$/i;

// Campo próprio de "Nome completo": aceita inicial ("João P. Santos") e nome todo em
// maiúsculas, mas exige nome E sobrenome (a nota fiscal do remédio sai nesse nome).
export function normalizeSignupName(raw: unknown): string | null {
  const words = squash(raw)
    .replace(/[^\p{L}\s'.-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.'-]+|[.'-]+$/g, ""))
    .filter(Boolean);
  const real = words.filter((w) => !PARTICLES.test(w));
  if (real.length < 2 || real.length > 10) return null;
  const name = words
    .map((w) => (PARTICLES.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
  return name.length >= 5 && name.length <= 120 ? name : null;
}

// Campo numérico do formulário pode chegar sem o zero à esquerda: o CEP 01310-100 da
// capital viraria 1310100. Todo CEP tem 8 dígitos e nenhum começa com 00, então 7 dígitos
// = um zero comido. CPF pode começar com 0 ou 00; o dígito verificador confere o resto.
export function normalizeSignupCep(raw: unknown): string | null {
  let digits = onlyDigits(raw);
  if (digits.length === 7) digits = `0${digits}`;
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : null;
}

export function normalizeSignupCpf(raw: unknown): string | null {
  let digits = onlyDigits(raw);
  if (digits.length === 9 || digits.length === 10) digits = digits.padStart(11, "0");
  return isValidCpf(digits) ? digits : null;
}

export function parseSignupForm(payload: Record<string, unknown>): SignupForm {
  const numero = squash(payload.numero);
  return {
    name: normalizeSignupName(payload.nome),
    cpf: normalizeSignupCpf(payload.cpf),
    cep: normalizeSignupCep(payload.cep),
    numero: numero || null,
    complemento: squash(payload.complemento)
  };
}

// Endereço de entrega no mesmo formato do resto da Lia (sem o CEP, que vive em `cep`):
// "Avenida Paulista, 1000, apto 5, Bela Vista, São Paulo - SP".
export function buildSignupAddress(parts: {
  street: string;
  numero: string;
  complemento?: string;
  district?: string;
  city?: string;
  uf?: string;
}): string {
  const city = parts.city ? `${parts.city}${parts.uf ? ` - ${parts.uf}` : ""}` : "";
  return [`${parts.street}, ${parts.numero}`, parts.complemento, parts.district, city].filter(Boolean).join(", ");
}
