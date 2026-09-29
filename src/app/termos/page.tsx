import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Termos de uso",
  description: "Termos de uso da Lia Delivery."
};

// Seção de remédio isento (29/09): só aparece com LIA_MEDICINE_MIP=true, junto com a
// funcionalidade — nada é anunciado antes de o dono ligar.
const medicineOn = process.env.LIA_MEDICINE_MIP === "true";

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-[#f3f2ed] px-6 py-12 text-[#0b2128] sm:px-10">
      <article className="mx-auto max-w-3xl rounded-lg bg-white p-8 shadow-sm sm:p-12">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-[#0f3d3a]">Lia Delivery</p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">Termos de uso</h1>
        <p className="mt-3 text-sm text-slate-600">Última atualização: {medicineOn ? "29 de setembro de 2026" : "9 de julho de 2026"}</p>

        <div className="mt-10 space-y-8 text-base leading-7 text-slate-700">
          <section>
            <h2 className="text-xl font-semibold text-[#0b2128]">1. Aceitação</h2>
            <p className="mt-2">
              Ao iniciar um atendimento com a Lia Delivery, serviço operado por 67.742.955 JOSEPH CARLOS DAYAN,
              CNPJ 67.742.955/0001-95, você concorda com estes termos e com a Política de privacidade. A empresa
              pode atualizar os termos quando necessário, mantendo a versão vigente nesta página.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[#0b2128]">2. Atendimento e pedidos</h2>
            <p className="mt-2">
              A Lia ajuda a encontrar produtos, montar uma cesta, calcular a entrega e acompanhar o pedido. O pedido
              só é confirmado depois que os itens, o valor e as condições de entrega forem apresentados e o pagamento
              for aprovado.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[#0b2128]">3. Preços, pagamento e entrega</h2>
            <p className="mt-2">
              Preços, disponibilidade, prazo e taxa de entrega podem variar até a confirmação. O pagamento é processado
              por um provedor de pagamento indicado no atendimento. A entrega depende da disponibilidade do fornecedor e
              da área atendida.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[#0b2128]">4. Uso responsável</h2>
            <p className="mt-2">
              Você deve fornecer informações verdadeiras, usar o serviço de forma legal e não tentar comprometer o
              atendimento, os sistemas ou os meios de pagamento. Podemos interromper atendimentos que apresentem risco,
              fraude ou abuso.
            </p>
          </section>

          {medicineOn && (
            <section>
              <h2 className="text-xl font-semibold text-[#0b2128]">5. Remédios sem receita</h2>
              <p className="mt-2">
                A pedido do cliente, a Lia pode comprar medicamentos isentos de prescrição em farmácias e drogarias
                licenciadas. Nesses pedidos a Lia age em nome do cliente: a compra é feita no nome e no CPF que o próprio
                cliente informa no atendimento, e ao informá-los o cliente autoriza esse uso para aquele fim.
              </p>
              <p className="mt-2">
                A venda, a dispensação, a nota fiscal e a entrega são da farmácia, que responde pelo medicamento. A Lia
                não vende medicamento em nome próprio, não o armazena nem o transporta, e não indica tratamento: dúvidas
                sobre o uso devem ser tiradas com o farmacêutico ou o médico, e a bula deve ser lida antes do uso.
              </p>
              <p className="mt-2">
                Medicamentos que exigem receita não são atendidos. O medicamento é cobrado pelo preço da farmácia e a
                taxa de serviço da Lia é mostrada separada, antes do pagamento.
              </p>
            </section>
          )}

          <section>
            <h2 className="text-xl font-semibold text-[#0b2128]">{medicineOn ? "6" : "5"}. Suporte</h2>
            <p className="mt-2">
              Para dúvidas sobre um pedido, cancelamento ou estes termos, envie uma mensagem pelo WhatsApp da Lia no
              número (11) 97844-4813.
            </p>
          </section>
        </div>
      </article>
    </main>
  );
}
