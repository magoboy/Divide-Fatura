// Testes da lógica pura. Rodar com: npm test
// Os dados abaixo são inventados, no mesmo formato que o OCR devolve.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../js/core.js';

const ctx = { year: 2026, month: 10 };

// Monta linhas como o OCR devolve (altura padrão 31px, 96% de confiança).
function lines(texts) {
  let y = 300;
  return texts.map((t) => {
    const [text, h = 31, conf = 96] = Array.isArray(t) ? t : [t];
    const l = { text, conf, y0: y, y1: y + h };
    y += 70;
    return l;
  });
}

test('parseAmount entende os formatos do app e os erros do OCR', () => {
  assert.deepEqual(c.parseAmount('R$ 1.000,00'), { cents: 100000, uncertain: false });
  assert.deepEqual(c.parseAmount('10000'), { cents: 10000, uncertain: false });
  assert.deepEqual(c.parseAmount('307/16'), { cents: 30716, uncertain: false });
  assert.deepEqual(c.parseAmount('31.53'), { cents: 3153, uncertain: false });
  assert.deepEqual(c.parseAmount('1.00000'), { cents: 100000, uncertain: false });
  assert.equal(c.parseAmount('85,9').uncertain, true);
});

test('parseDateText infere o ano pela fatura', () => {
  assert.equal(c.parseDateText('20 de agosto', ctx), '2026-08-20');
  assert.equal(c.parseDateText('712 de setembro', ctx), '2026-09-12');
  assert.equal(c.parseDateText('05 de dezembro', ctx), '2025-12-05');
  assert.equal(c.parseDateText('30/11/2025', ctx), '2025-11-30');
});

test('parseOcrLines lê compras, parcelas, estornos e pagamentos', () => {
  const recs = c.parseOcrLines(lines([
    ['17:26 Ru ED', 36], '< Faturas', ['SET OUT NOV', 57],
    ['21 de agosto, sexta', 48],
    'Pagamento Efetuado R$ 1.000,00 >', 'Fatura anterior',
    'Padaria Exemplo R$2850 >', 'Final 1234', ['22:04', 29],
    'Loja Teste R$ 14790 >', 'Final 1234 Parcela 1 de 10', ['18:56 Pode antecipar', 39],
    ['18 de setembro, sexta', 48],
    'Hospedagem X R$20,64 >', ['Estorno', 29], 'Final 1234',
    'Mercado Y R$10,00 >', 'Final 1234', ['19:27', 22, 73], // hora cortada
  ]), ctx, 'img1');
  assert.equal(recs.length, 5);
  assert.deepEqual(recs.map((r) => r.kind), ['pagamento', 'compra', 'compra', 'estorno', 'compra']);
  assert.equal(recs[0].subtitle, 'Fatura anterior');
  assert.equal(recs[1].cents, 2850);
  assert.equal(recs[1].time, '22:04');
  assert.equal(recs[1].date, '2026-08-21');
  assert.deepEqual(recs[2].parcela, { n: 1, m: 10 });
  assert.equal(recs[2].cents, 14790);
  assert.equal(recs[3].date, '2026-09-18');
  assert.equal(recs[4].time, null, 'hora de linha cortada é descartada');
});

test('mergeRecords remove repetidos entre prints, mas não dentro do mesmo print', () => {
  const p1 = c.parseOcrLines(lines([
    ['20 de setembro, domingo', 48],
    'Lanchonete Z R$10,00 >', 'Final 1234', ['12:40', 29],
    'Lanchonete Z R$10,00 >', 'Final 1234', ['12:37', 29],
    'Posto W R$80,00 >', 'Final 1234',
  ]), ctx, 'p1');
  const p2 = c.parseOcrLines(lines([
    'Lanchonete Z R$10,00 >', 'Final 1234', ['12:37', 29],
    'Posto W R$80,00 >', 'Final 1234', ['10:41', 29],
    ['19 de setembro, sábado', 48],
    'Uber *trip R$ 10,98 >', 'Final 1234', ['20:09', 29],
  ]), ctx, 'p2');
  const { items, added, merged } = c.mergeRecords([], [...p1, ...p2]);
  assert.equal(added, 4);
  assert.equal(merged, 2);
  const posto = items.find((i) => i.desc === 'Posto W');
  assert.equal(posto.time, '10:41');
  assert.equal(posto.date, '2026-09-20');
  const z = items.filter((i) => i.desc === 'Lanchonete Z');
  assert.equal(z.length, 2);
  assert.ok(z.every((i) => i.date === '2026-09-20'), 'data deduzida para itens acima do 1º cabeçalho');
});

test('mesmo print enviado de novo não duplica nem perde itens', () => {
  const recs = c.parseOcrLines(lines(['Loja R$10,00 >', 'Final 1234', ['10:00', 29]]), ctx, 'a');
  const first = c.mergeRecords([], recs);
  const again = c.mergeRecords(first.items, c.parseOcrLines(lines(['Loja R$10,00 >', 'Final 1234', ['10:00', 29]]), ctx, 'b'));
  assert.equal(again.items.length, 1);
});

test('divisão fecha centavo por centavo e estornos descontam', () => {
  const items = [
    { kind: 'compra', desc: 'A', cents: 1001, split: { mode: 'S', pctA: 50 } },
    { kind: 'compra', desc: 'B', cents: 3000, split: { mode: 'S', pctA: 60 } },
    { kind: 'compra', desc: 'C', cents: 500, split: { mode: 'A' } },
    { kind: 'compra', desc: 'D', cents: 700, split: { mode: 'B' } },
    { kind: 'estorno', desc: 'D', cents: 200, split: { mode: 'B' } },
    { kind: 'compra', desc: 'E', cents: 999, split: null },
    { kind: 'pagamento', desc: 'Pagamento', cents: 1000, payer: 'A' },
    { kind: 'pagamento', desc: 'Pagamento', cents: 5000, payer: 'X' },
  ];
  const s = c.summarize(items);
  assert.equal(s.gastos, 1001 + 3000 + 500 + 700 - 200 + 999);
  assert.equal(s.a + s.b + s.pendente, s.gastos);
  assert.equal(s.a, 501 + 1800 + 500);
  assert.equal(s.b, 500 + 1200 + 500);
  assert.equal(s.nPendente, 1);
  assert.equal(s.pagoA, 1000);
  assert.equal(s.faltaA, s.a - 1000);
});

test('regras lembram a divisão por estabelecimento e por parcela', () => {
  let mem = c.remember({}, { kind: 'compra', desc: 'Mercado X', cents: 100, split: { mode: 'S', pctA: 60 } });
  mem = c.remember(mem, { kind: 'compra', desc: 'Loja P', cents: 5000, date: '2026-07-25', parcela: { n: 2, m: 18 }, split: { mode: 'B' } });
  const out = c.applyRules([
    { kind: 'compra', desc: 'MERCADO  X', cents: 999, split: null },
    { kind: 'compra', desc: 'Loja P', cents: 5000, date: '2026-07-25', parcela: { n: 3, m: 18 }, split: null },
    { kind: 'pagamento', desc: 'Pagamento Efetuado', subtitle: 'Fatura anterior', cents: 1, payer: null },
  ], mem);
  assert.deepEqual(out[0].split, { mode: 'S', pctA: 60 });
  assert.equal(out[0].auto, true);
  assert.equal(out[1].split.mode, 'B');
  assert.equal(out[2].payer, 'X');
});

test('relatórios simplificado e detalhado', () => {
  const fatura = {
    year: 2026, month: 10, totalInformado: null,
    items: [
      { kind: 'compra', desc: 'Mercado', cents: 10000, date: '2026-09-12', split: { mode: 'S', pctA: 50 } },
      { kind: 'compra', desc: 'Farmácia', cents: 2500, date: '2026-09-13', split: { mode: 'B' } },
      { kind: 'compra', desc: 'Curso', cents: 10000, date: '2026-07-25', parcela: { n: 2, m: 18 }, split: { mode: 'A' } },
    ],
  };
  const st = { nameA: 'João', nameB: 'Maria' };
  const simples = c.reportText(fatura, st, false);
  assert.match(simples, /Fatura Outubro\/2026/);
  assert.match(simples, /João: R\$ 150,00/);
  assert.match(simples, /Maria: R\$ 75,00/);
  assert.doesNotMatch(simples, /Mercado/);
  const det = c.reportText(fatura, st, true);
  assert.match(det, /Mercado: R\$ 100,00 → João R\$ 50,00 \(50%\) · Maria R\$ 50,00 \(50%\)/);
  assert.match(det, /parcela 2\/18/);
});
