// Leitura gratuita dos prints, feita no próprio aparelho com Tesseract.js.
// Na primeira vez baixa ~15 MB (programa + dicionário em português); depois
// o navegador guarda em cache.

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

let loading = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Não consegui baixar o leitor de imagens. Confira a internet.'));
    document.head.appendChild(s);
  });
}

async function ensureTesseract() {
  if (window.Tesseract) return window.Tesseract;
  loading ??= loadScript(TESSERACT_URL);
  await loading;
  return window.Tesseract;
}

// Lê vários arquivos e devolve, para cada um, as linhas com posição e
// confiança: [{ text, conf, y0, y1 }].
export async function ocrImages(files, onProgress = () => {}) {
  const Tesseract = await ensureTesseract();
  onProgress({ stage: 'Preparando o leitor (só demora na primeira vez)…', done: 0 });
  // Se o download do dicionário falhar, o Tesseract pode nunca responder.
  let failed = null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(failed
      || new Error('O leitor demorou demais para carregar. Confira a internet e tente de novo.')), 180000);
  });
  let worker;
  try {
    worker = await Promise.race([
      Tesseract.createWorker('por', 1, {
        errorHandler: (err) => { failed = new Error(`Falha no leitor de imagens: ${err?.message || err}`); },
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
  const out = [];
  try {
    for (let i = 0; i < files.length; i++) {
      onProgress({ stage: `Lendo print ${i + 1} de ${files.length}…`, done: i });
      const { data } = await worker.recognize(files[i]);
      out.push((data.lines || []).map((l) => ({
        text: l.text.trim(), conf: Math.round(l.confidence), y0: l.bbox.y0, y1: l.bbox.y1,
      })));
    }
  } finally {
    await worker.terminate();
  }
  onProgress({ stage: 'Pronto', done: files.length });
  return out;
}
