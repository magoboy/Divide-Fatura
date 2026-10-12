// Leitura dos prints com IA (Claude). Mais precisa que o OCR gratuito,
// mas precisa de uma chave da API da Anthropic, que fica salva só neste
// aparelho. Custo aproximado: alguns centavos de dólar por print.

import { nomeFatura } from './core.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm';
const MODEL = 'claude-opus-5-5';

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['itens'],
  properties: {
    itens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['descricao', 'valor_centavos', 'valor_incerto', 'tipo', 'subtitulo', 'data', 'hora',
          'parcela_atual', 'parcela_total', 'cartao_final', 'cortado'],
        properties: {
          descricao: { type: 'string' },
          valor_centavos: { type: 'integer' },
          valor_incerto: { type: 'boolean' },
          tipo: { type: 'string', enum: ['compra', 'estorno', 'pagamento'] },
          subtitulo: nullable('string'),
          data: nullable('string'),
          hora: nullable('string'),
          parcela_atual: nullable('integer'),
          parcela_total: nullable('integer'),
          cartao_final: nullable('string'),
          cortado: { type: 'boolean' },
        },
      },
    },
  },
};

const SYSTEM = `Você extrai lançamentos de prints da tela de fatura do cartão de crédito do app do Banco do Brasil.

Como a tela é organizada:
- No topo ficam a barra do celular, o título "Faturas" e as abas de meses (SET, OUT, NOV). Ignore tudo isso e o botão "PAGAR FATURA" no rodapé.
- Os lançamentos aparecem agrupados sob cabeçalhos de dia, como "21 de agosto, sexta", do mais recente para o mais antigo.
- Cada lançamento tem: descrição (linha em negrito) e valor à direita; embaixo "Final NNNN" (final do cartão), às vezes "Parcela X de Y", e a hora (HH:MM) ou, na seção "Parcelas de compras anteriores", a data completa da compra original (DD/MM/AAAA).
- "Pagamento Efetuado" é um pagamento (tipo "pagamento"); o subtítulo é "Fatura anterior" ou "Antecipação de pagamento".
- Lançamentos com a palavra "Estorno" embaixo são estornos (tipo "estorno").
- "Pode parcelar" e "Pode antecipar" são só botões; ignore.

Regras de extração:
- Liste TODOS os lançamentos visíveis, na ordem em que aparecem, inclusive os parcialmente cortados nas bordas (marque "cortado": true quando faltar alguma linha dele).
- Dois lançamentos iguais no mesmo print são lançamentos diferentes; liste os dois.
- valor_centavos: valor em centavos, sempre positivo (R$ 1.000,00 = 100000). Se parte do valor estiver encoberta, dê sua melhor leitura e marque valor_incerto: true.
- data: para itens com data completa, use "DD/MM/AAAA" como está escrito. Para os demais, use "DD/MM" do cabeçalho de dia logo acima do item. Se o item está acima do primeiro cabeçalho visível no print, use null.
- hora: "HH:MM" ou null.
- descricao: exatamente como aparece, sem o valor.`;

let sdkPromise = null;

async function loadSdk() {
  sdkPromise ??= import(SDK_URL);
  return (await sdkPromise).default;
}

// Reduz a imagem para o tamanho que o modelo usa (lado maior 1568 px).
export async function fileToJpegBase64(file, maxSide = 1568) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas.toDataURL('image/jpeg', 0.88).split(',')[1];
}

function friendlyError(Anthropic, err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Chave da API inválida. Confira em Configurações.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'A chave não tem permissão para usar este modelo.';
  if (err instanceof Anthropic.RateLimitError) return 'Muitas leituras ao mesmo tempo. Espere um minuto e tente de novo.';
  if (err instanceof Anthropic.BadRequestError) return `A API recusou o pedido: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Sem conexão com a API da Anthropic.';
  if (err instanceof Anthropic.APIError) return `Erro da API (${err.status}): ${err.message}`;
  return err?.message || String(err);
}

async function extractOne(client, Anthropic, file, ctx) {
  const data = await fileToJpegBase64(file);
  let resp;
  try {
    resp = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: `Print da fatura de ${nomeFatura(ctx.year, ctx.month)}. Extraia os lançamentos.` },
        ],
      }],
    });
  } catch (err) {
    throw new Error(friendlyError(Anthropic, err));
  }
  if (resp.stop_reason === 'refusal') throw new Error('A IA não conseguiu ler este print.');
  if (resp.stop_reason === 'max_tokens') throw new Error('A resposta da IA ficou incompleta.');
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text).itens;
}

// Lê os prints (3 por vez) e devolve, para cada um, a lista de itens da IA.
// Um print com erro vira { error } sem derrubar os outros.
export async function aiImages(apiKey, files, ctx, onProgress = () => {}) {
  const Anthropic = await loadSdk();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });
  const results = new Array(files.length);
  let next = 0;
  let done = 0;
  onProgress({ stage: `Enviando ${files.length} print(s) para a IA…`, done: 0 });
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      try {
        results[i] = { items: await extractOne(client, Anthropic, files[i], ctx) };
      } catch (err) {
        results[i] = { error: err.message };
      }
      done++;
      onProgress({ stage: `IA leu ${done} de ${files.length} print(s)…`, done });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return results;
}
