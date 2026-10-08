# Template de aviso fora da janela de 24h — passo a passo

_Escrito em 03/09/2026 para quem vai executar (pessoa ou agente de IA) sem conhecer o projeto._

## Por que isso existe

O WhatsApp só entrega mensagem livre (texto normal) até **24 horas depois da última mensagem
que a pessoa mandou** para o número da Lia. Depois disso, a Meta aceita o envio (HTTP 200) mas
descarta a mensagem com o erro `131047 Re-engagement message`. Fora dessa janela, a única
mensagem que chega é um **template aprovado pela Meta**.

A Lia usa isso para avisos proativos: "seu pedido travou na loja", "devolvi o valor", alerta
ao operador. O código já está pronto; ele só precisa saber o **nome** do template aprovado,
que é lido da variável de ambiente `LIA_TEMPLATE_ORDER_UPDATE` na Vercel. Enquanto essa
variável estiver vazia, o aviso fora da janela **não é enviado** e fica registrado na nota do
pedido para ser feito por outro canal.

## Como o código usa o template

Ele envia o template com **dois** parâmetros de corpo, nesta ordem:

| Parâmetro | Conteúdo | Exemplo |
|---|---|---|
| `{{1}}` | código curto do pedido, ou a palavra `operador` no alerta interno | `A1B2C3` |
| `{{2}}` | o texto do aviso, em uma linha só | `Sua compra travou na loja. Estou tentando outra; se não der, devolvo o valor integral.` |

Idioma esperado: **Português (Brasil)**, código `pt_BR`. Se o template for criado em outro
idioma, é preciso setar também `LIA_TEMPLATE_LANG` com o código correspondente.

## Passo 1 — Entrar no WhatsApp Manager

1. Abrir `https://business.facebook.com/wa/manage/message-templates/` logado na conta Meta
   do dono (a mesma que administra o número oficial da Lia).
2. No seletor do topo, escolher a **conta do WhatsApp Business "Lia"** (WABA do número
   oficial). O template pertence à conta, não ao número.

## Passo 2 — Criar o template

Clicar em **Criar modelo** (Create template) e preencher exatamente assim:

- **Categoria:** Utilidade (Utility). É a categoria de atualização de pedido/serviço.
- **Nome:** `pedido_atualizacao` — só minúsculas, números e underscore; sem espaço, acento
  ou hífen. Tem de ser **idêntico** ao valor que vai na env.
- **Idioma:** Português (Brasil).

## Passo 3 — Conteúdo

- **Cabeçalho:** nenhum.
- **Corpo:** colar este texto, sem alterar:

  ```
  Olá! Aqui é a Lia, com uma atualização sobre o seu pedido {{1}}: {{2}} Se precisar de algo, é só responder esta mensagem.
  ```

- **Rodapé:** nenhum.
- **Botões:** nenhum.

Regras da Meta que esse texto respeita e que **não podem ser quebradas** ao editar:
- O corpo **não pode começar nem terminar com uma variável** (por isso há texto antes de
  `{{1}}` e depois de `{{2}}`).
- As variáveis têm de ser sequenciais: `{{1}}` e depois `{{2}}`.
- Não pode ter variável demais em relação ao tamanho do texto.
- Sem `#`, `$` ou `%` dentro das chaves.

## Passo 4 — Amostras (samples)

A Meta exige um exemplo para cada variável antes de enviar para análise. Usar:

- `{{1}}`: `A1B2C3`
- `{{2}}`: `Sua compra está confirmada e a loja já está preparando a entrega.`

## Passo 5 — Enviar para análise e esperar

Clicar em **Enviar** (Submit). O status fica **Pendente**; a aprovação costuma sair em
minutos e leva no máximo 24 horas. Recarregar a página de templates até aparecer
**Aprovado**.

Se vier **Rejeitado**, abrir o motivo:
- "dangling parameter" ou "começa/termina com variável" → o texto foi alterado; voltar ao
  corpo do Passo 3.
- "muitas variáveis" → o texto ficou curto demais; usar o corpo do Passo 3 na íntegra.
- Reclassificado para **Marketing** → aceitar (funciona igual, custa mais por mensagem) ou
  editar o texto tirando qualquer palavra promocional e reenviar como Utilidade.

## Passo 6 — Ligar na Vercel

1. Abrir `https://vercel.com/josephdayans-projects/lia-delivery/settings/environment-variables`.
2. **Add New**: Key `LIA_TEMPLATE_ORDER_UPDATE`, Value `pedido_atualizacao`,
   ambiente **Production** (marcar Preview também, se quiser testar em preview). Salvar.
3. Só se o idioma escolhido **não** foi Português (Brasil): adicionar `LIA_TEMPLATE_LANG` com o
   código do idioma (ex.: `pt_PT`).
4. **Redeploy obrigatório:** variável nova só entra em deploy novo. Em **Deployments**, no
   deploy de produção mais recente, menu `⋯` → **Redeploy** → confirmar. Esperar ficar
   **Ready**.

## Passo 7 — Como saber que funcionou

- Nos logs de runtime da Vercel, o erro `[whatsapp:meta:status-failed] ... 131047` para de
  aparecer nos avisos proativos.
- A nota do pedido no `/ops` deixa de ganhar a linha
  "⚠️ Aviso ao cliente NÃO enviado: fora da janela de 24h".
- Quem recebe vê a mensagem já montada: "Olá! Aqui é a Lia, com uma atualização sobre o seu
  pedido A1B2C3: <texto do aviso> Se precisar de algo, é só responder esta mensagem."

## O que NÃO fazer

- Não mudar o nome do template depois de aprovado sem atualizar a env (o envio falha com
  "template não encontrado").
- Não colocar quebra de linha dentro do valor das variáveis; o código já achata o texto.
- Não criar o template em outra conta WhatsApp Business: precisa ser a da Lia.
