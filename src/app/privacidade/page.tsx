import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Política de privacidade",
  description: "Política de privacidade da Lia Delivery."
};

// Remédio isento (29/09): CPF e dado de saúde só entram na política com LIA_MEDICINE_MIP=true.
const medicineOn = process.env.LIA_MEDICINE_MIP === "true";

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#f3f2ed] px-6 py-12 text-[#0b2128] sm:px-10">
      <article className="mx-auto max-w-3xl rounded-lg bg-white p-8 shadow-sm sm:p-12">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-[#0f3d3a]">Lia Delivery</p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">Política de privacidade</h1>
        <p className="mt-3 text-sm text-slate-600">Última atualização: {medicineOn ? "29 de setembro de 2026" : "9 de julho de 2026"}</p>

        <div className="mt-10 space-y-8 text-base leading-7 text-slate-700">
          <section>
            <h2 className="text-xl font-semibold text-[#0b2128]">1. Sobre a Lia</h2>
            <p className="mt-2">
              A Lia Delivery é um serviço de compras e entrega operado por 67.742.955 JOSEPH CARLOS DAYAN,
              inscrito no CNPJ sob o nº 67.742.955/0001-95, e atende conversas iniciadas pelo cliente no WhatsApp.
              Esta política explica quais dados são usados para responder às solicitações, montar pedidos, processar
              pagamentos e realizar entregas.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[#0b2128]">2. Dados utilizados</h2>
            <p className="mt-2">
              Podemos receber o número de telefone, nome de perfil, mensagens enviadas pelo cliente, endereço ou CEP
              de entrega, itens do pedido, informações de pagamento necessárias para confirmar a transação e dados
              técnicos básicos do atendimento.
            </p>
            {medicineOn && (
              <p className="mt-2">
                No cadastro, pedimos uma vez o nome completo e o CPF do cliente e os guardamos para as compras
                feitas no nome dele, como as de remédio sem receita. O pedido de um remédio pode revelar informação de
                saúde: ela é usada só para executar a compra e a entrega, nunca para oferta ou perfil de marketing.
              </p>
            )}
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[#0b2128]">3. Como usamos os dados</h2>
            <p className="mt-2">
              Os dados são usados para entender a lista de compras, consultar preços e disponibilidade, calcular a
              entrega, enviar atualizações do pedido, confirmar pagamentos, prevenir fraude, prestar suporte e
              cumprir obrigações legais.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[#0b2128]">4. Compartilhamento</h2>
            <p className="mt-2">
              Compartilhamos somente o necessário para operar o serviço, por exemplo com o WhatsApp/Meta para a
              comunicação, processadores de pagamento para confirmar o Pix, fornecedores para separar os itens e
              empresas de entrega para executar o transporte. Não vendemos dados pessoais.
            </p>
            {medicineOn && (
              <p className="mt-2">
                No pedido de remédio sem receita, o nome completo, o CPF, o endereço e os itens vão para a farmácia que
                vende o medicamento, para a compra em nome do cliente e a emissão da nota fiscal.
              </p>
            )}
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[#0b2128]">5. Armazenamento e segurança</h2>
            <p className="mt-2">
              Mantemos os dados pelo tempo necessário para prestar o serviço, resolver solicitações, cumprir a lei e
              proteger nossos direitos. Adotamos controles técnicos e organizacionais razoáveis, mas nenhum serviço
              conectado à internet é completamente livre de riscos.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[#0b2128]">6. Direitos do titular</h2>
            <p className="mt-2">
              O cliente pode solicitar confirmação de tratamento, acesso, correção, eliminação quando aplicável e
              informações sobre o uso de seus dados. Para exercer esses direitos ou tirar dúvidas, envie uma mensagem
              pelo WhatsApp da Lia, no número (11) 97844-4813.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[#0b2128]">7. Alterações</h2>
            <p className="mt-2">
              Esta política pode ser atualizada para refletir mudanças no serviço ou na legislação. A versão vigente
              estará sempre disponível nesta página.
            </p>
          </section>
        </div>
      </article>
    </main>
  );
}
