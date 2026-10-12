// Gera o PDF do relatório (simplificado ou detalhado) com jsPDF.

import { buildReport, formatBRL, formatDate, formatPct, shares, signed } from './core.js';

const JSPDF_URL = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
const AUTOTABLE_URL = 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Não consegui baixar o gerador de PDF. Confira a internet.'));
    document.head.appendChild(s);
  });
}

let loading = null;
async function ensureJsPdf() {
  loading ??= loadScript(JSPDF_URL).then(() => loadScript(AUTOTABLE_URL));
  await loading;
  return window.jspdf.jsPDF;
}

const COR_A = [37, 99, 235];
const COR_B = [219, 39, 119];
const CINZA = [100, 100, 110];

function label(it) {
  let s = it.desc;
  if (it.parcela) s += ` (parcela ${it.parcela.n}/${it.parcela.m})`;
  if (it.kind === 'estorno') s += ' (estorno)';
  return s;
}

export async function buildPdf(fatura, settings, detailed) {
  const JsPDF = await ensureJsPdf();
  const { A, B, s, groups, titulo, totalInformado } = buildReport(fatura, settings);
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  let y = 18;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(titulo, 14, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...CINZA);
  doc.text(`Divisão entre ${A} e ${B} · ${detailed ? 'detalhado' : 'simplificado'} · gerado em ${new Date().toLocaleDateString('pt-BR')}`, 14, y + 6);
  doc.setTextColor(0);
  y += 16;

  // Quadro de totais
  const box = (x, w, title, value, color, sub) => {
    doc.setDrawColor(...color);
    doc.setLineWidth(0.6);
    doc.roundedRect(x, y, w, sub ? 26 : 20, 2, 2);
    doc.setFontSize(9);
    doc.setTextColor(...color);
    doc.text(title, x + 4, y + 6);
    doc.setFontSize(15);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0);
    doc.text(value, x + 4, y + 14);
    doc.setFont('helvetica', 'normal');
    if (sub) {
      doc.setFontSize(8);
      doc.setTextColor(...CINZA);
      doc.text(sub, x + 4, y + 21, { maxWidth: w - 8 });
      doc.setTextColor(0);
    }
  };
  const bw = (W - 28 - 8) / 3;
  const subA = detailed ? `só dele(a) ${formatBRL(s.aProprio)} + compartilhado ${formatBRL(s.aComp)}` : null;
  const subB = detailed ? `só dele(a) ${formatBRL(s.bProprio)} + compartilhado ${formatBRL(s.bComp)}` : null;
  box(14, bw, 'Total de gastos', formatBRL(s.gastos), CINZA, detailed ? `compras ${formatBRL(s.compras)} - estornos ${formatBRL(s.estornos)}` : null);
  box(14 + bw + 4, bw, A, formatBRL(s.a), COR_A, subA);
  box(14 + 2 * (bw + 4), bw, B, formatBRL(s.b), COR_B, subB);
  y += detailed ? 32 : 26;

  doc.setFontSize(10);
  const note = (text, color = [0, 0, 0]) => {
    doc.setTextColor(...color);
    doc.text(text, 14, y, { maxWidth: W - 28 });
    doc.setTextColor(0);
    y += 6;
  };
  if (s.pagoA || s.pagoB) {
    note(`Já pago antecipado: ${A} ${formatBRL(s.pagoA)} (falta ${formatBRL(s.faltaA)}) · ${B} ${formatBRL(s.pagoB)} (falta ${formatBRL(s.faltaB)})`);
  }
  if (s.nPendente) note(`Atenção: ${s.nPendente} item(ns) ainda sem divisão, somando ${formatBRL(s.pendente)}.`, [180, 83, 9]);
  if (totalInformado != null && totalInformado !== s.gastos) {
    note(`O app do banco mostra ${formatBRL(totalInformado)}; diferença de ${formatBRL(totalInformado - s.gastos)}.`, [180, 83, 9]);
  }

  if (detailed) {
    const table = (title, color, head, rows, foot) => {
      if (!rows.length) return;
      y += 4;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(...color);
      doc.text(title, 14, y);
      doc.setTextColor(0);
      doc.setFont('helvetica', 'normal');
      doc.autoTable({
        startY: y + 2,
        head: [head],
        body: rows,
        foot: foot ? [foot] : undefined,
        theme: 'striped',
        styles: { fontSize: 8.5, cellPadding: 1.6 },
        headStyles: { fillColor: color },
        footStyles: { fillColor: [240, 240, 244], textColor: 0, fontStyle: 'bold' },
        columnStyles: { 0: { cellWidth: 14 } },
        margin: { left: 14, right: 14 },
      });
      y = doc.lastAutoTable.finalY + 4;
    };
    const total = (list) => formatBRL(list.reduce((a, i) => a + signed(i), 0));
    const simpleRows = (list) => list.map((it) => [formatDate(it.date), label(it), formatBRL(signed(it))]);
    table(`Só ${A}`, COR_A, ['Data', 'Descrição', 'Valor'], simpleRows(groups.A), ['', 'Total', total(groups.A)]);
    table(`Só ${B}`, COR_B, ['Data', 'Descrição', 'Valor'], simpleRows(groups.B), ['', 'Total', total(groups.B)]);
    const sumA = groups.S.reduce((acc, it) => acc + shares(it).a, 0);
    const sumB = groups.S.reduce((acc, it) => acc + shares(it).b, 0);
    table('Compartilhados', [124, 58, 237], ['Data', 'Descrição', 'Valor', A, B],
      groups.S.map((it) => {
        const { a, b } = shares(it);
        return [formatDate(it.date), label(it), formatBRL(signed(it)),
          `${formatBRL(a)} (${formatPct(it.split.pctA)})`, `${formatBRL(b)} (${formatPct(100 - it.split.pctA)})`];
      }),
      ['', 'Total', total(groups.S), formatBRL(sumA), formatBRL(sumB)]);
    table('Sem divisão', [180, 83, 9], ['Data', 'Descrição', 'Valor'], simpleRows(groups.P), ['', 'Total', total(groups.P)]);
    table('Pagamentos na fatura (não entram nos gastos)', CINZA, ['Data', 'Tipo', 'Valor', 'Quem'],
      groups.pag.map((it) => [formatDate(it.date), it.subtitle || it.desc, formatBRL(it.cents),
        it.payer === 'A' ? A : it.payer === 'B' ? B : it.payer === 'X' ? 'ignorado' : 'sem dono']));
  }

  const name = `fatura-${fatura.year}-${String(fatura.month).padStart(2, '0')}-${detailed ? 'detalhado' : 'simplificado'}.pdf`;
  return { blob: doc.output('blob'), name };
}
