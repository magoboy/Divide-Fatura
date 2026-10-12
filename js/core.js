// Lógica pura do Divide Fatura: leitura do texto dos prints, remoção de
// repetidos, divisão entre as duas pessoas e montagem dos relatórios.
// Não depende do navegador, então roda também nos testes (node --test).

export const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const MES_IDX = Object.fromEntries(MESES.map((m, i) => [m, i + 1]));
MES_IDX['marco'] = 3;

// ---------------------------------------------------------------- formatação

export function formatBRL(cents) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const reais = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const cent = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}R$ ${reais},${cent}`;
}

export function formatDate(iso) {
  if (!iso) return '--/--';
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

export function formatPct(p) {
  const r = Math.round(p * 10) / 10;
  return (Number.isInteger(r) ? String(r) : r.toFixed(1).replace('.', ',')) + '%';
}

export function nomeFatura(year, month) {
  const m = MESES[month - 1];
  return `${m[0].toUpperCase()}${m.slice(1)}/${year}`;
}

// ------------------------------------------------------------------ valores

// Lê um valor como aparece no app ("R$ 1.000,00"). O OCR às vezes perde a
// vírgula ("R$10000") ou troca por "/" ("307/16"); como o BB sempre mostra
// dois decimais, os dois últimos dígitos são os centavos.
export function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/\s+/g, '').replace(/\//g, ',');
  s = s.replace(/[^0-9.,]/g, '');
  if (!/\d/.test(s)) return null;
  let uncertain = false;
  let cents;
  if (s.includes(',')) {
    const i = s.lastIndexOf(',');
    const inteiro = s.slice(0, i).replace(/[.,]/g, '') || '0';
    let dec = s.slice(i + 1).replace(/\D/g, '');
    if (dec.length !== 2) uncertain = true;
    dec = (dec + '00').slice(0, 2);
    cents = parseInt(inteiro, 10) * 100 + parseInt(dec, 10);
  } else if (/^\d+\.\d{2}$/.test(s)) {
    // "31.53": ponto no lugar da vírgula
    cents = parseInt(s.replace('.', ''), 10);
  } else {
    const d = s.replace(/\./g, '');
    if (d.length < 3) uncertain = true;
    cents = parseInt(d, 10);
  }
  if (!Number.isFinite(cents)) return null;
  return { cents, uncertain };
}

// ------------------------------------------------------------------- datas

export function inferYear(month, fatYear, fatMonth) {
  // Lançamentos são sempre anteriores ao vencimento: mês maior que o da
  // fatura só pode ser do ano anterior.
  return month > fatMonth ? fatYear - 1 : fatYear;
}

function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Aceita "20 de agosto", "20/08", "20/08/2026" ou "2026-08-20".
export function parseDateText(text, ctx) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = t.match(/(\d{1,2})\/(\d{1,2})(?!\/)/);
  if (m) return iso(inferYear(+m[2], ctx.year, ctx.month), +m[2], +m[1]);
  m = t.match(/(\d{1,3})\s*de\s*([a-zç]+)/);
  if (m && MES_IDX[m[2]]) {
    let dia = +m[1];
    if (dia > 31) dia = dia % 100; // ruído do OCR antes do número ("712 de")
    if (dia < 1 || dia > 31) return null;
    const mes = MES_IDX[m[2]];
    return iso(inferYear(mes, ctx.year, ctx.month), mes, dia);
  }
  return null;
}

// ------------------------------------------------------- leitura do OCR

const RE_DATE_HEADER = /(\d{1,3})\s+de\s+(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/i;
const RE_ITEM = /^(.*?\S)\s*R\s?[$S]\s*([0-9][0-9.,/ ]*)\s*[>»)\]]*\s*$/;
const RE_TABS = /\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\b.*\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\b/;

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Transforma as linhas que o OCR leu de UM print em lançamentos.
// lines: [{ text, conf, y0, y1 }] na ordem de cima para baixo.
export function parseOcrLines(lines, ctx, img = 0) {
  let body = lines.map((l) => ({ ...l, text: (l.text || '').trim() })).filter((l) => l.text);

  // Ignora o cabeçalho do app (hora, "Faturas", abas de meses).
  const tabsIdx = body.findIndex((l) => RE_TABS.test(l.text));
  if (tabsIdx >= 0) body = body.slice(tabsIdx + 1);

  // Linhas cortadas na borda do print ficam mais baixas que as outras e são
  // mal lidas (ex.: "12:37" virou "19:27"). Descartamos essas, menos o
  // título do item, que ainda é útil para casar com outro print.
  const hFinal = median(body.filter((l) => /^final\s*\d{4}$/i.test(l.text) && l.y1 != null)
    .map((l) => l.y1 - l.y0));
  const ok = (l) => {
    if (l.conf != null && l.conf < 40) return false;
    if (hFinal && l.y1 != null && !RE_ITEM.test(l.text) && (l.y1 - l.y0) < 0.8 * hFinal) return false;
    return true;
  };

  const records = [];
  let curDate = null;
  let seenHeader = false;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    if (!cur.details) cur.partial = true;
    delete cur.details;
    records.push(cur);
    cur = null;
  };

  for (const l of body) {
    if (!ok(l)) continue;
    const t = l.text;
    const dh = t.match(RE_DATE_HEADER);
    if (dh && !RE_ITEM.test(t)) {
      flush();
      curDate = parseDateText(`${dh[1]} de ${dh[2]}`, ctx);
      // Itens acima do primeiro cabeçalho são de um dia posterior a ele,
      // cujo cabeçalho ficou em outro print.
      if (!seenHeader && curDate) {
        for (const r of records) if (!r.date) r.after = curDate;
      }
      seenHeader = true;
      continue;
    }
    if (/parcelas de compras anteriores/i.test(t)) { flush(); curDate = null; continue; }
    if (/pagar fatura/i.test(t)) { flush(); break; }
    const it = t.match(RE_ITEM);
    if (it) {
      flush();
      const amt = parseAmount(it[2]);
      if (!amt) continue;
      const desc = cleanDesc(it[1]);
      cur = {
        img, desc, cents: amt.cents, uncertain: amt.uncertain || (l.conf != null && l.conf < 55),
        kind: /pagamento\s+efetuado/i.test(desc) ? 'pagamento' : 'compra',
        date: curDate, time: null, parcela: null, card: null, subtitle: null,
        partial: false, details: 0,
      };
      continue;
    }
    if (!cur) continue; // resto de um item cortado no topo do print
    let used = false;
    let m = t.match(/final\s*(\d{4})/i);
    if (m) { cur.card = m[1]; used = true; }
    m = t.match(/parcela\s*(\d{1,2})\s*de\s*(\d{1,2})/i);
    if (m) { cur.parcela = { n: +m[1], m: +m[2] }; used = true; }
    m = t.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) { cur.date = iso(+m[3], +m[2], +m[1]); cur.after = null; used = true; }
    m = t.match(/^(\d{2}):(\d{2})\b/);
    if (m && +m[1] < 24 && +m[2] < 60) { cur.time = `${m[1]}:${m[2]}`; used = true; }
    if (/estorno/i.test(t)) { cur.kind = 'estorno'; cur.subtitle = 'Estorno'; used = true; }
    if (/fatura anterior/i.test(t)) { cur.subtitle = 'Fatura anterior'; used = true; }
    if (/antecipa/i.test(t)) {
      if (cur.kind === 'pagamento') cur.subtitle = 'Antecipação de pagamento';
      used = true;
    }
    if (/pode (parcelar|antecipar)/i.test(t)) used = true;
    if (used) cur.details++;
  }
  flush();
  return records;
}

function cleanDesc(s) {
  return s.replace(/\s+/g, ' ').replace(/[|]$/, 'I').trim();
}

// Converte a resposta da IA (ver js/ai.js) para o mesmo formato do OCR.
export function fromAiItems(items, ctx, img = 0) {
  const out = [];
  for (const it of items || []) {
    if (!it || !it.descricao || !Number.isFinite(it.valor_centavos)) continue;
    const kind = ['compra', 'estorno', 'pagamento'].includes(it.tipo) ? it.tipo : 'compra';
    const time = it.hora && /^\d{1,2}:\d{2}$/.test(it.hora) ? it.hora.padStart(5, '0') : null;
    out.push({
      img,
      desc: cleanDesc(String(it.descricao)),
      cents: Math.abs(Math.round(it.valor_centavos)),
      uncertain: !!it.valor_incerto,
      kind,
      date: parseDateText(it.data, ctx),
      time,
      parcela: it.parcela_atual && it.parcela_total ? { n: it.parcela_atual, m: it.parcela_total } : null,
      card: it.cartao_final || null,
      subtitle: it.subtitulo || (kind === 'estorno' ? 'Estorno' : null),
      partial: !!it.cortado,
      fullDate: /\d{4}/.test(it.data || ''),
    });
  }
  // Itens sem data antes do primeiro cabeçalho: são de um dia posterior.
  const first = out.find((r) => r.date && !r.fullDate);
  for (const r of out) {
    if (r === first) break;
    if (!r.date && first) r.after = first.date;
  }
  for (const r of out) delete r.fullDate;
  return out;
}

// --------------------------------------------------- remoção de repetidos

export function normDesc(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

function sameCents(x, y) {
  if (x.cents === y.cents) return true;
  // valor meio escondido ("R$ 85,9"): confere só até os décimos
  if (x.uncertain || y.uncertain) return Math.floor(x.cents / 10) === Math.floor(y.cents / 10);
  return false;
}

// Devolve uma pontuação (>0) se r pode ser o mesmo lançamento que m, ou -1.
function matchScore(m, r) {
  if (m.kind !== r.kind) return -1;
  if (m.sources.includes(r.img)) return -1; // no mesmo print, são lançamentos diferentes
  if (!sameCents(m, r)) return -1;
  let score = 1;
  for (const f of ['time', 'date']) {
    if (f === 'date' && m.dateGuess) continue;
    if (m[f] && r[f]) {
      if (m[f] !== r[f]) return -1;
      score += 2;
    }
  }
  if (m.parcela && r.parcela) {
    if (m.parcela.n !== r.parcela.n || m.parcela.m !== r.parcela.m) return -1;
    score += 1;
  }
  if (m.subtitle && r.subtitle) {
    if (normDesc(m.subtitle) !== normDesc(r.subtitle)) return -1;
    score += 1;
  }
  const sim = similarity(normDesc(m.desc), normDesc(r.desc));
  const timeMatch = m.time && r.time && m.time === r.time;
  if (sim < (timeMatch ? 0.6 : 0.85)) return -1;
  return score + sim;
}

let idCounter = 0;
export function newId() {
  idCounter++;
  return `${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Junta os lançamentos de vários prints (que se sobrepõem na rolagem) aos
// itens que já existiam. Retorna { items, added, merged }.
export function mergeRecords(existing, records) {
  const items = existing.map((i) => ({ ...i, sources: [...(i.sources || [])] }));
  let added = 0;
  let merged = 0;
  // Registros completos primeiro, para os cortados casarem com eles.
  const sorted = [...records].sort((a, b) => Number(a.partial) - Number(b.partial));
  for (const r of sorted) {
    let best = null;
    let bestScore = -1;
    for (const m of items) {
      const s = matchScore(m, r);
      if (s > bestScore) { best = m; bestScore = s; }
    }
    if (best) {
      merged++;
      best.sources.push(r.img);
      if (best.dateGuess && r.date) { best.date = r.date; best.dateGuess = false; }
      for (const f of ['time', 'date', 'parcela', 'card', 'subtitle']) {
        if (!best[f] && r[f]) best[f] = r[f];
      }
      if (best.uncertain && !r.uncertain) { best.cents = r.cents; best.uncertain = false; }
      if (best.partial && !r.partial) { best.partial = false; best.desc = r.desc; }
      if (r.after && (!best.after || r.after > best.after)) best.after = r.after;
    } else {
      added++;
      const { img, ...rest } = r;
      items.push({ id: newId(), ...rest, sources: [img], split: null, auto: false, payer: null });
    }
  }
  return { items: guessDates(items), added, merged };
}

// Itens sem data, mas que sabemos serem posteriores a um dia X, ficam com o
// primeiro dia depois de X que tem lançamentos (é assim que o app lista).
export function guessDates(items) {
  const dias = [...new Set(items.filter((i) => i.date && !i.dateGuess)
    .map((i) => i.date))].sort();
  return items.map((it) => {
    if (it.date && !it.dateGuess) return it;
    if (!it.after) return it;
    const d = dias.find((x) => x > it.after);
    return d ? { ...it, date: d, dateGuess: true } : it;
  });
}

// ------------------------------------------------------------ divisão

// Chave usada para lembrar como dividir compras do mesmo estabelecimento.
export function ruleKey(desc) {
  return normDesc(desc);
}

// Compras parceladas: mesma compra, outra parcela.
export function installmentKey(item) {
  if (!item.parcela || !item.date) return null;
  return `${ruleKey(item.desc)}|${item.date}|${item.cents}|${item.parcela.m}`;
}

export function defaultPayer(item) {
  if (item.kind !== 'pagamento') return null;
  return /fatura anterior/i.test(item.subtitle || '') ? 'X' : null;
}

// Aplica as regras salvas aos itens ainda sem divisão.
export function applyRules(items, memory) {
  const { rules = {}, installments = {} } = memory || {};
  return items.map((it) => {
    if (it.kind === 'pagamento') {
      return it.payer ? it : { ...it, payer: defaultPayer(it) };
    }
    if (it.split) return it;
    const ik = installmentKey(it);
    const rule = (ik && installments[ik]) || rules[ruleKey(it.desc)];
    return rule ? { ...it, split: { mode: rule.mode, pctA: rule.pctA }, auto: true } : it;
  });
}

// Registra a escolha do usuário para reaproveitar depois.
export function remember(memory, item) {
  const mem = { rules: { ...(memory?.rules || {}) }, installments: { ...(memory?.installments || {}) } };
  if (!item.split || item.kind === 'pagamento') return mem;
  const rule = { mode: item.split.mode, pctA: item.split.pctA, desc: item.desc };
  mem.rules[ruleKey(item.desc)] = rule;
  const ik = installmentKey(item);
  if (ik) mem.installments[ik] = rule;
  return mem;
}

export function signed(item) {
  return item.kind === 'estorno' ? -item.cents : item.cents;
}

// Quanto cabe a cada um (em centavos). A soma sempre fecha com o valor.
export function shares(item) {
  const v = signed(item);
  if (!item.split) return { a: 0, b: 0 };
  if (item.split.mode === 'A') return { a: v, b: 0 };
  if (item.split.mode === 'B') return { a: 0, b: v };
  const a = Math.round((v * item.split.pctA) / 100);
  return { a, b: v - a };
}

export function sortItems(items) {
  return [...items].sort((x, y) => {
    const dx = x.date || '';
    const dy = y.date || '';
    if (dx !== dy) return dx < dy ? 1 : -1;
    const tx = x.time || '';
    const ty = y.time || '';
    if (tx !== ty) return tx < ty ? 1 : -1;
    return x.desc.localeCompare(y.desc);
  });
}

export function summarize(items) {
  const s = {
    gastos: 0, compras: 0, estornos: 0,
    a: 0, b: 0, aProprio: 0, bProprio: 0, aComp: 0, bComp: 0, compartilhado: 0,
    pendente: 0, nPendente: 0, pagoA: 0, pagoB: 0, pagoIgnorado: 0, pagoSemDono: 0, nPagoSemDono: 0,
  };
  for (const it of items) {
    if (it.kind === 'pagamento') {
      if (it.payer === 'A') s.pagoA += it.cents;
      else if (it.payer === 'B') s.pagoB += it.cents;
      else if (it.payer === 'X') s.pagoIgnorado += it.cents;
      else { s.pagoSemDono += it.cents; s.nPagoSemDono++; }
      continue;
    }
    const v = signed(it);
    s.gastos += v;
    if (it.kind === 'estorno') s.estornos += it.cents; else s.compras += it.cents;
    if (!it.split) { s.pendente += v; s.nPendente++; continue; }
    const { a, b } = shares(it);
    s.a += a;
    s.b += b;
    if (it.split.mode === 'A') s.aProprio += a;
    else if (it.split.mode === 'B') s.bProprio += b;
    else { s.aComp += a; s.bComp += b; s.compartilhado += v; }
  }
  s.faltaA = s.a - s.pagoA;
  s.faltaB = s.b - s.pagoB;
  return s;
}

// ---------------------------------------------------------- relatórios

function itemLabel(it) {
  const parts = [formatDate(it.date)];
  parts.push(it.desc);
  if (it.parcela) parts.push(`(parcela ${it.parcela.n}/${it.parcela.m})`);
  if (it.kind === 'estorno') parts.push('(estorno)');
  return parts.join(' ');
}

// Estrutura comum ao relatório em texto e em PDF.
export function buildReport(fatura, settings) {
  const A = settings.nameA || 'Pessoa A';
  const B = settings.nameB || 'Pessoa B';
  const items = sortItems(fatura.items);
  const s = summarize(items);
  const gastos = items.filter((i) => i.kind !== 'pagamento');
  const groups = {
    A: gastos.filter((i) => i.split?.mode === 'A'),
    B: gastos.filter((i) => i.split?.mode === 'B'),
    S: gastos.filter((i) => i.split?.mode === 'S'),
    P: gastos.filter((i) => !i.split),
    pag: items.filter((i) => i.kind === 'pagamento'),
  };
  return { A, B, s, groups, titulo: `Fatura ${nomeFatura(fatura.year, fatura.month)}`, totalInformado: fatura.totalInformado };
}

export function reportText(fatura, settings, detailed) {
  const { A, B, s, groups, titulo, totalInformado } = buildReport(fatura, settings);
  const L = [];
  L.push(`💳 *${titulo} — divisão*`);
  L.push('');
  L.push(`Total de gastos: *${formatBRL(s.gastos)}*`);
  if (totalInformado != null && totalInformado !== s.gastos) {
    L.push(`(o app do banco mostra ${formatBRL(totalInformado)}; diferença de ${formatBRL(totalInformado - s.gastos)})`);
  }
  L.push('');
  L.push(`👤 *${A}: ${formatBRL(s.a)}*`);
  if (detailed) L.push(`   só dele(a) ${formatBRL(s.aProprio)} + parte nos compartilhados ${formatBRL(s.aComp)}`);
  L.push(`👤 *${B}: ${formatBRL(s.b)}*`);
  if (detailed) L.push(`   só dele(a) ${formatBRL(s.bProprio)} + parte nos compartilhados ${formatBRL(s.bComp)}`);
  if (s.pagoA || s.pagoB) {
    L.push('');
    L.push('Já pago antecipado:');
    L.push(`   ${A}: ${formatBRL(s.pagoA)} → falta ${formatBRL(s.faltaA)}`);
    L.push(`   ${B}: ${formatBRL(s.pagoB)} → falta ${formatBRL(s.faltaB)}`);
  }
  if (s.nPendente) {
    L.push('');
    L.push(`⚠️ ${s.nPendente} item(ns) ainda sem divisão: ${formatBRL(s.pendente)}`);
  }
  if (!detailed) return L.join('\n');

  const section = (title, list, fmt) => {
    if (!list.length) return;
    const total = list.reduce((acc, i) => acc + signed(i), 0);
    L.push('');
    L.push(`*${title}* (${list.length}) — ${formatBRL(total)}`);
    for (const it of list) L.push(fmt(it));
  };
  section(`Só ${A}`, groups.A, (it) => `• ${itemLabel(it)}: ${formatBRL(signed(it))}`);
  section(`Só ${B}`, groups.B, (it) => `• ${itemLabel(it)}: ${formatBRL(signed(it))}`);
  section('Compartilhados', groups.S, (it) => {
    const { a, b } = shares(it);
    return `• ${itemLabel(it)}: ${formatBRL(signed(it))} → ${A} ${formatBRL(a)} (${formatPct(it.split.pctA)}) · ${B} ${formatBRL(b)} (${formatPct(100 - it.split.pctA)})`;
  });
  section('Sem divisão', groups.P, (it) => `• ${itemLabel(it)}: ${formatBRL(signed(it))}`);
  if (groups.pag.length) {
    L.push('');
    L.push('*Pagamentos na fatura* (não entram nos gastos)');
    for (const it of groups.pag) {
      const who = it.payer === 'A' ? `pago por ${A}` : it.payer === 'B' ? `pago por ${B}` : it.payer === 'X' ? 'ignorado' : 'sem dono';
      L.push(`• ${formatDate(it.date)} ${it.subtitle || it.desc}: ${formatBRL(it.cents)} (${who})`);
    }
  }
  return L.join('\n');
}
