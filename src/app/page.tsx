import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Sans } from "next/font/google";
import { LiaSymbol, LiaWhatsAppAvatar } from "@/components/lia-brand";
import PhoneMock from "@/components/landing/phone-mock";
import TypingComposer from "@/components/landing/typing-composer";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-display",
  display: "swap"
});

const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
  display: "swap"
});

export const metadata: Metadata = {
  title: "Lia — compras do dia a dia sem sair do WhatsApp",
  description:
    "Pede qualquer coisa numa mensagem: a Lia mostra o total com frete e prazo reais, você paga por Pix ou cartão e ela cuida de tudo até chegar. São Paulo e Rio de Janeiro."
};

const WHATSAPP_NUMBER = process.env.NEXT_PUBLIC_LIA_WHATSAPP_NUMBER ?? "14155238886";

function waLink(text: string) {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

const WA_CTA = waLink("oi Lia! quero fazer um pedido");

/* Redes sociais: links opcionais por env (sem env, o rodapé não mostra nada). */
const SOCIAL_LINKS = [
  { label: "Instagram", href: process.env.NEXT_PUBLIC_LIA_INSTAGRAM_URL },
  { label: "LinkedIn", href: process.env.NEXT_PUBLIC_LIA_LINKEDIN_URL }
].filter((s): s is { label: string; href: string } => Boolean(s.href));

function WhatsAppIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 448 512" aria-hidden="true" className={className} fill="currentColor">
      <path d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L0 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-32.6-16.3-54-29.1-75.5-66-5.7-9.8 5.7-9.1 16.3-30.3 1.8-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 35.2 15.2 49 16.5 66.6 13.9 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z" />
    </svg>
  );
}

function Sparkle({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" aria-hidden="true" className={className} fill="currentColor">
      <path d="M14 2 Q14 14 26 14 Q14 14 14 26 Q14 14 2 14 Q14 14 14 2 Z" />
    </svg>
  );
}

/* ——— marquee: letreiro comprável ——— */
/* Sem preço inventado: no concierge o preço é o da cotação, não uma tabela nossa. */

const MARQUEE_ITEMS: string[] = [
  "arroz 5kg",
  "creme dental",
  "cabo USB-C",
  "ração 15kg",
  "perfume de presente",
  "pilha AA",
  "papel higiênico 12un",
  "café 500g",
  "caderno e caneta",
  "areia de gato",
  "detergente",
  "fralda M",
  "protetor solar",
  "chocolate"
];

function MarqueeGroup({ ariaHidden = false }: { ariaHidden?: boolean }) {
  return (
    <div className="flex items-center" aria-hidden={ariaHidden}>
      {MARQUEE_ITEMS.map((item) => (
        <span key={item} className="flex items-center">
          <a
            href={waLink(`oi Lia! quero ${item}`)}
            target="_blank"
            rel="noopener noreferrer"
            tabIndex={ariaHidden ? -1 : undefined}
            className="px-5 font-display text-[17px] font-bold uppercase leading-none text-white/85 transition-opacity hover:opacity-60"
          >
            {item}
          </a>
          <Sparkle className="h-2.5 w-2.5 shrink-0 text-acento/50" />
        </span>
      ))}
    </div>
  );
}

/* ——— o que pedir: bolhas ——— */

function OrderBubble({ cat, text }: { cat: string; text: string }) {
  return (
    <a
      href={waLink(`oi Lia! ${text}`)}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-fit rounded-2xl rounded-br-[4px] border-[1.5px] border-tinta/15 bg-[#F2FFC4] px-4 py-3 transition-colors hover:border-[#8FAF1B]"
    >
      <span className="mb-1.5 block border-l-[3px] border-[#8FAF1B] pl-2 text-[13px] font-semibold leading-none text-tinta/60">
        {cat}
      </span>
      <span className="block text-[16px] italic leading-snug text-tinta">“{text}”</span>
    </a>
  );
}

/* ——— cupom fiscal ——— */

const ZIG = Array.from({ length: 44 }, (_, i) => `L${i * 10 + 5} 0 L${i * 10 + 10} 10`).join(" ");

function ZigzagEdge({ flip = false }: { flip?: boolean }) {
  return (
    <svg
      viewBox="0 0 440 10"
      preserveAspectRatio="none"
      aria-hidden="true"
      className={`block h-[10px] w-full text-white ${flip ? "rotate-180" : ""}`}
      fill="currentColor"
    >
      <path d={`M0 10 ${ZIG} Z`} />
    </svg>
  );
}

function CupomLine({ item, price }: { item: string; price: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[14px] leading-relaxed text-tinta">
      <span>{item}</span>
      <span className="mb-[3px] flex-1 border-b-2 border-dotted border-tinta/25" aria-hidden="true" />
      <span className="[font-variant-numeric:tabular-nums]">{price}</span>
    </div>
  );
}

/* ——— dados ——— */

const STEPS = [
  {
    n: "1",
    title: "Manda o pedido",
    text: "“arroz, ração e um perfume de presente”. Qualquer coisa, do seu jeito, numa mensagem só — sem app, sem cadastro, sem menu."
  },
  {
    n: "2",
    title: "Vê o total e paga",
    text: "A Lia responde com o total fechado: produtos, frete e prazo reais da loja. Aprovou? Pix copia-e-cola ou cartão, ali mesmo no chat."
  },
  {
    n: "3",
    title: "Recebe em casa",
    text: "A Lia compra pra você e te avisa a cada passo, até a entrega bater na sua porta."
  }
];

const BUBBLES_LEFT = [
  { cat: "Mercado", text: "arroz, feijão, café e sabão em pó" },
  { cat: "Higiene e beleza", text: "creme dental, shampoo e protetor solar" },
  { cat: "Pet", text: "ração pro cachorro e areia de gato" }
];

const BUBBLES_RIGHT = [
  { cat: "Presente", text: "perfume e uma caixa de bombom" },
  { cat: "Papelaria", text: "caderno, caneta e papel sulfite" },
  { cat: "Eletrônico barato", text: "cabo USB-C, pilhas e fone simples" }
];

const FAQ = [
  {
    q: "Onde a Lia entrega?",
    a: "A Lia opera nos estados de São Paulo e Rio de Janeiro: capital, Grande São Paulo e interior paulista, e no Rio a capital e a região metropolitana. Manda seu CEP no WhatsApp que eu confirmo na hora se já chego aí e quais lojas entregam no seu endereço. 📍"
  },
  {
    q: "O que dá pra pedir?",
    a: "Quase tudo que se compra em loja: mercado, higiene e beleza, pet, papelaria, presente, eletrônico… Só não trabalho com remédio (regra da ANVISA). Na dúvida, pede mesmo assim que eu coto."
  },
  {
    q: "Quanto custa?",
    a: "O preço dos produtos mais o frete da loja. O total aparece fechado no chat antes de você pagar."
  },
  {
    q: "Como eu pago?",
    a: "Pix copia-e-cola direto no chat, ou cartão por link seguro do Mercado Pago. Nada é cobrado antes de você aprovar o total."
  },
  {
    q: "Quando chega?",
    a: "Depende da loja e do seu endereço — às vezes no mesmo dia, às vezes em alguns dias. O prazo real aparece junto com o total, antes de você pagar. A Lia não promete prazo que a loja não confirmou."
  },
  {
    q: "E se faltar um item na loja?",
    a: "Antes de pagar, a Lia te avisa e você decide se troca ou tira. Se a loja falhar depois do pagamento, ela devolve o valor daquele item."
  }
];

export default function Home() {
  return (
    <main className={`${bricolage.variable} ${instrument.variable} min-h-screen bg-papel font-body text-tinta`}>
      {/* ——— Header ——— */}
      <header className="sticky top-0 z-50 border-b-2 border-tinta bg-papel">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-5 sm:px-8">
          <a href="#topo" className="flex items-center gap-2.5">
            <LiaSymbol className="h-6 w-6 text-tinta" />
            <span className="leading-none">
              <span className="font-display block text-[21px] font-extrabold leading-none">Lia</span>
              <span className="mt-0.5 flex items-center gap-1 text-[11px] leading-none text-tinta/55">
                <span className="h-1.5 w-1.5 rounded-full bg-[#8FAF1B]" aria-hidden="true" />
                online
              </span>
            </span>
          </a>
          <nav className="hidden items-center gap-8 text-[15px] font-semibold md:flex">
            <a href="#como-funciona" className="decoration-acento decoration-[3px] underline-offset-4 hover:underline">
              como funciona
            </a>
            <a href="#o-que-pedir" className="decoration-acento decoration-[3px] underline-offset-4 hover:underline">
              o que pedir
            </a>
            <a href="#duvidas" className="decoration-acento decoration-[3px] underline-offset-4 hover:underline">
              dúvidas
            </a>
          </nav>
          <a
            href={WA_CTA}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-acento px-4 font-display text-[15px] font-bold text-[#221633] transition-colors hover:bg-[#C9F23F]"
          >
            <WhatsAppIcon className="h-4 w-4" />
            <span className="hidden sm:inline">Chamar no WhatsApp</span>
            <span className="sm:hidden">WhatsApp</span>
          </a>
        </div>
      </header>

      {/* ——— Hero: pôster verde ——— */}
      <section id="topo" className="bg-poster">
        <div className="mx-auto grid max-w-[1200px] items-center gap-x-8 gap-y-10 px-5 pb-12 pt-10 sm:px-8 lg:grid-cols-12 lg:gap-y-7 lg:pb-8 lg:pt-10">
          <div className="lg:col-span-7">
            <h1 className="font-display text-[clamp(38px,9.5vw,50px)] font-extrabold leading-[1.04] tracking-[-0.02em] text-white lg:text-[clamp(44px,4.4vw,64px)]">
              <span className="whitespace-nowrap">Acabou em casa?</span>
              <br />
              <span className="whitespace-nowrap">
                Manda um <span className="text-acento">zap.</span>
              </span>
            </h1>
            <p className="mt-5 max-w-[52ch] text-[17px] leading-relaxed text-white/75 lg:text-[18px]">
              Você pede qualquer coisa numa mensagem, a Lia mostra o total com frete e prazo, e você paga por
              Pix ou cartão{"\u00A0"}— <strong className="font-semibold text-white">tudo <span className="whitespace-nowrap">sem sair do WhatsApp</span></strong>. Ela
              compra pra você e avisa a cada passo, em São Paulo e no Rio de Janeiro.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-5">
              <a
                href={WA_CTA}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-16 items-center gap-3 rounded-2xl bg-acento px-8 font-display text-[18px] font-bold text-[#221633] transition-colors hover:bg-[#C9F23F]"
              >
                <WhatsAppIcon className="h-6 w-6" />
                Chamar a Lia no WhatsApp
              </a>
              <a
                href="#como-funciona"
                className="text-[16px] font-semibold text-white underline decoration-acento decoration-2 underline-offset-4 hover:text-acento"
              >
                ver como funciona ↓
              </a>
            </div>
          </div>
          <div className="lg:col-span-5">
            <PhoneMock />
          </div>
          <p className="border-t border-white/15 pt-4 text-[15px] text-white/55 lg:col-span-12">
            <span className="whitespace-nowrap">São Paulo e Rio de Janeiro</span> ·{" "}
            <span className="whitespace-nowrap">qualquer coisa, numa mensagem só</span> ·{" "}
            <span className="whitespace-nowrap">Pix ou cartão no chat</span>
          </p>
        </div>
      </section>

      {/* ——— Letreiro comprável ——— */}
      <div className="marquee overflow-hidden border-t border-white/10 bg-poster py-4">
        <div className="marquee-track">
          <MarqueeGroup />
          <MarqueeGroup ariaHidden />
        </div>
      </div>

      {/* ——— Como funciona: rota do pedido ——— */}
      <section id="como-funciona" className="scroll-mt-20 py-20 lg:py-24">
        <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
          <h2 className="font-display max-w-[640px] text-[clamp(28px,4.2vw,44px)] font-extrabold leading-[1.05] tracking-[-0.02em]">
            Tudo sem sair do WhatsApp
          </h2>
          <p className="mt-3 max-w-[52ch] text-[17px] text-tinta/65">
            Do pedido ao pagamento, a compra inteira acontece na mesma conversa.
          </p>
          <div className="relative mt-14 lg:mt-16">
            <div className="relative space-y-12 lg:grid lg:grid-cols-3 lg:gap-x-12 lg:space-y-0">
              {STEPS.map((step, i) => (
                <div key={step.n} className={i === 1 ? "lg:translate-y-6" : i === 2 ? "lg:translate-y-12" : ""}>
                  <div className={`font-display text-[72px] font-extralight leading-[0.9] lg:text-[110px] ${i === 0 ? "-ml-1 lg:-ml-2" : ""}`}>{step.n}</div>
                  <h3 className="mt-3 font-display text-[22px] font-bold leading-tight">{step.title}</h3>
                  <p className="mt-2 max-w-[34ch] text-[17px] leading-relaxed text-tinta/70">{step.text}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ——— O que pedir: bolhas de verdade ——— */}
      <section id="o-que-pedir" className="scroll-mt-20 border-t border-tinta/10 py-20 lg:py-24">
        <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
          <h2 className="font-display text-[clamp(28px,4.2vw,44px)] font-extrabold leading-[1.05] tracking-[-0.02em]">
            Pede que a Lia leva
          </h2>
          <p className="mt-3 text-[17px] text-tinta/65">Toca numa lista pra abrir o WhatsApp já escrito.</p>
          <div className="mt-10 grid max-w-[1000px] gap-x-6 gap-y-4 sm:grid-cols-2 lg:gap-x-20">
            <div className="flex flex-col gap-4">
              {BUBBLES_LEFT.map((b) => (
                <OrderBubble key={b.cat} cat={b.cat} text={b.text} />
              ))}
            </div>
            <div className="flex flex-col gap-4 sm:mt-6">
              {BUBBLES_RIGHT.map((b) => (
                <OrderBubble key={b.cat} cat={b.cat} text={b.text} />
              ))}
              <div className="mt-2 flex items-end gap-2">
                <LiaWhatsAppAvatar className="h-7 w-7 shrink-0" />
                <div className="rounded-2xl rounded-bl-[4px] border-[1.5px] border-tinta/10 bg-white px-4 py-3">
                  <span className="text-[16px] leading-snug">pede do seu jeito — se dá pra comprar, eu coto 😉</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ——— Confiança: cupom fiscal ——— */}
      <section className="bg-poster py-16 lg:py-24">
        <div className="mx-auto grid max-w-[1200px] items-center gap-y-12 px-5 sm:px-8 lg:grid-cols-12 lg:gap-x-10">
          <div className="lg:col-span-5">
            <h2 className="font-display text-[clamp(28px,4.2vw,44px)] font-extrabold leading-[1.05] tracking-[-0.02em] text-white">
              Combinado é combinado
            </h2>
            <p className="mt-5 max-w-[44ch] text-[17px] leading-relaxed text-white/70">
              O total aparece no WhatsApp antes de você pagar — e o que a Lia fecha com você, ela cumpre. Preço
              fechado, frete e prazo da loja, pagamento pelo Mercado Pago e aviso a cada passo, até a entrega chegar.
            </p>
          </div>
          <div className="lg:col-span-7 lg:justify-self-center">
            <div className="w-full max-w-[420px] rotate-[1.5deg]">
              <ZigzagEdge />
              <div className="bg-white px-7 py-6">
                <p className="text-center font-display text-[13px] font-bold uppercase leading-none">
                  Lia <Sparkle className="mx-1 inline-block h-2.5 w-2.5 -translate-y-px" /> São Paulo
                </p>
                <p className="mt-1.5 text-center text-[12px] text-tinta/50">pedido de hoje · 16:07</p>
                <div className="my-4 border-t-2 border-dashed border-tinta/20" />
                <div className="space-y-1.5">
                  <CupomLine item="Arroz 5kg" price="27,90" />
                  <CupomLine item="Sabão em pó" price="24,50" />
                  <CupomLine item="Ração 10kg" price="112,90" />
                  <CupomLine item="Entrega" price="12,90" />
                </div>
                <div className="my-4 border-t-2 border-dashed border-tinta/20" />
                <div className="flex items-baseline justify-between font-display text-[16px] font-bold">
                  <span>TOTAL</span>
                  <span className="[font-variant-numeric:tabular-nums]">R$ 178,20</span>
                </div>
                <div className="mt-2 flex items-center justify-between text-[13px] text-tinta/60">
                  <span>pago pelo chat, antes da compra</span>
                  <span className="rounded bg-poster px-2 py-1 text-[11px] font-bold leading-none text-acento">
                    PIX ✓ PAGO
                  </span>
                </div>
                <div className="my-4 border-t-2 border-dashed border-tinta/20" />
                <div className="flex items-baseline justify-between font-display text-[15px] font-extrabold">
                  <span>SURPRESAS</span>
                  <span className="[font-variant-numeric:tabular-nums]">R$ 0,00</span>
                </div>
                <div
                  className="mt-5 h-9 w-full"
                  aria-hidden="true"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(90deg, #221633 0 2px, transparent 2px 4px, #221633 4px 7px, transparent 7px 8px, #221633 8px 9px, transparent 9px 13px)"
                  }}
                />
                <p className="mt-2 text-center text-[11px] text-tinta/45">liadelivery.com.br</p>
              </div>
              <ZigzagEdge flip />
            </div>
          </div>
        </div>
      </section>

      {/* ——— Dúvidas: P./R. abertas ——— */}
      <section id="duvidas" className="scroll-mt-20 pb-14 pt-20">
        <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
          <h2 className="font-display text-[clamp(28px,4.2vw,44px)] font-extrabold leading-[1.05] tracking-[-0.02em]">
            Dúvidas rápidas
          </h2>
          <div className="mt-8 border-y-[1.5px] border-tinta/15 py-2 sm:grid sm:grid-cols-2 sm:gap-x-16">
            {FAQ.map((item) => (
              <div key={item.q} className="grid grid-cols-[26px_1fr] content-start gap-x-3 gap-y-1.5 py-6">
                <span className="font-display text-[19px] font-bold leading-snug text-tinta/35">P.</span>
                <h3 className="font-display text-[19px] font-bold leading-snug">{item.q}</h3>
                <span className="font-display text-[17px] font-bold leading-relaxed text-tinta/35">R.</span>
                <p className="max-w-[52ch] text-[17px] leading-relaxed text-tinta/75">{item.a}</p>
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-4 border-t-[1.5px] border-tinta/15 py-6 sm:col-span-2">
              <h3 className="font-display text-[19px] font-bold leading-snug">Ainda na dúvida? Pergunta pra ela.</h3>
              <a
                href={waLink("oi Lia! tenho uma dúvida")}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-acento px-4 font-display text-[15px] font-bold text-[#221633] transition-colors hover:bg-[#C9F23F]"
              >
                <WhatsAppIcon className="h-4 w-4" />
                Perguntar no WhatsApp
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ——— CTA final + footer: pôster de fechamento ——— */}
      <section className="border-t-2 border-tinta bg-poster pt-20 lg:pt-24">
        <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
          <h2 className="font-display text-[clamp(36px,6vw,60px)] font-extrabold leading-[1.02] tracking-[-0.02em] text-white">
            Manda a <span className="text-acento">lista.</span>
          </h2>
          <p className="mt-4 text-[17px] text-white/70">
            Total fechado antes de pagar, Pix ou cartão no chat, e a Lia cuida do resto.
          </p>
          <div className="mt-8">
            <TypingComposer href={WA_CTA} />
          </div>
          <p className="mt-4 text-[15px] text-white/55">A primeira resposta chega antes de você largar o celular.</p>
          <footer className="mt-20 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 py-8 sm:grid sm:grid-cols-3">
            <span className="flex items-center gap-2">
              <LiaWhatsAppAvatar className="h-6 w-6" />
              <span className="font-display text-[16px] font-bold text-white">Lia</span>
            </span>
            <span className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:justify-self-center">
              <a
                href={WA_CTA}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[14px] font-semibold text-white/70 underline decoration-acento decoration-2 underline-offset-4 hover:text-white"
              >
                falar com a Lia no WhatsApp
              </a>
              {SOCIAL_LINKS.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[14px] font-semibold text-white/70 underline decoration-acento decoration-2 underline-offset-4 hover:text-white"
                >
                  {link.label}
                </a>
              ))}
            </span>
            <span className="text-[14px] text-white/50 sm:justify-self-end">
              © 2026 Lia Delivery · operação de 67.742.955 JOSEPH CARLOS DAYAN · CNPJ 67.742.955/0001-95
            </span>
          </footer>
        </div>
      </section>
    </main>
  );
}
