# Divide Fatura

App simples (abre no navegador do celular) para dividir a fatura de um cartão de crédito compartilhado entre duas pessoas, a partir dos **prints do app do Banco do Brasil**. Serve para a fatura aberta, que o banco não deixa exportar.

## Como usar

1. **Prints**: escolha os prints da fatura. Pode mandar todos de uma vez, fora de ordem e com partes repetidas da rolagem; o app junta tudo e remove os repetidos.
   - **Grátis**: a leitura é feita no próprio celular (OCR). Na primeira vez ele baixa uns 15 MB.
   - **Com IA**: usa o Claude, da Anthropic, e erra menos. Precisa de uma chave da API (veja abaixo).
   - Se quiser, digite o total da fatura que aparece no app do banco. O app compara com a soma dos lançamentos e avisa se faltou algum print.
2. **Dividir**: em cada compra, toque em **Pessoa A**, **Pessoa B** ou **Dividir**. Ao dividir, escolha 50/50, 60/40 etc., arraste o controle ou digite o valor de cada um.
   - O app **lembra**: na próxima compra no mesmo lugar (ou na próxima parcela da mesma compra), a divisão já vem preenchida, marcada como `auto`.
   - Estornos descontam de quem ficou com a compra.
   - Pagamentos ("Pagamento Efetuado") não entram nos gastos. Os de "Fatura anterior" já vêm como ignorados. Nos de "Antecipação", marque quem pagou para descontar do que essa pessoa ainda deve.
3. **Resumo**: escolha **Simplificado** (só os totais) ou **Detalhado** (cada lançamento, com a parte de cada um). Depois envie como texto (WhatsApp) ou PDF, ou baixe um `.txt`.

Os dados ficam **só no aparelho** de quem usou, no armazenamento do navegador. Em Configurações dá para exportar e importar um backup, por exemplo para passar as divisões lembradas para o celular da outra pessoa.

## Leitura com IA (opcional)

1. Crie uma chave em <https://console.anthropic.com/settings/keys> e coloque créditos na conta.
2. No app, abra Configurações (a engrenagem) e cole a chave.
3. Na aba Prints, escolha **Com IA**.

A chave fica salva só no navegador do aparelho e é enviada direto para a API da Anthropic. Cada print custa alguns centavos de dólar.

## Publicar no GitHub Pages

O app é só HTML, CSS e JavaScript, sem etapa de build.

1. No GitHub, abra **Settings → Pages**.
2. Em **Build and deployment**, escolha **Deploy from a branch**, selecione a branch e a pasta `/ (root)` e salve.
3. Em um ou dois minutos o app fica em `https://<seu-usuario>.github.io/divide-fatura/`.
4. No celular, abra o endereço e use **Adicionar à tela inicial** para ele virar um ícone de app.

## Desenvolvimento

```bash
npm test      # testes da lógica (leitura, repetidos, divisão, relatórios)
npm start     # servidor local em http://localhost:8080
```

| Arquivo | O que faz |
|---|---|
| `js/core.js` | Lógica pura: lê o texto dos prints, remove repetidos, calcula a divisão e monta os relatórios |
| `js/ocr.js` | Leitura gratuita com Tesseract.js |
| `js/ai.js` | Leitura com Claude (API da Anthropic) |
| `js/pdf.js` | Geração do PDF (jsPDF) |
| `js/app.js` | Tela e armazenamento local |

Importante: **não coloque prints nem dados reais da fatura no repositório**. Os testes usam dados inventados.
