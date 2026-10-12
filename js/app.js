// Tela do Divide Fatura: guarda os dados no aparelho (localStorage) e liga
// a leitura dos prints, a divisão e os relatórios.

import {
  applyRules, formatBRL, formatDate, formatPct, fromAiItems, mergeRecords, newId, nomeFatura,
  parseAmount, parseOcrLines, remember, reportText, ruleKey, shares, signed, sortItems, summarize,
} from './core.js';

const STORE_KEY = 'divideFatura.v1';
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ estado

function defaultState() {
  const now = new Date();
  return {
    settings: { nameA: 'Pessoa A', nameB: 'Pessoa B', defaultPct: 50, apiKey: '' },
    memory: { rules: {}, installments: {} },
    faturas: {},
    current: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      const base = defaultState();
      return { ...base, ...d, settings: { ...base.settings, ...d.settings }, memory: { ...base.memory, ...d.memory } };
    }
  } catch { /* armazenamento indisponível: segue só na memória */ }
  return defaultState();
}

let state = load();
let saveWarned = false;

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    if (!saveWarned) toast('Não consegui salvar neste navegador. Exporte um backup antes de fechar.');
    saveWarned = true;
  }
}

function fatura() {
  const id = state.current;
  if (!state.faturas[id]) {
    const [y, m] = id.split('-').map(Number);
    state.faturas[id] = { id, year: y, month: m, items: [], processed: [], totalInformado: null };
  }
  return state.faturas[id];
}

const ui = { tab: 'prints', filter: 'todos', files: [], editing: null, busy: false, expanded: null };

// ------------------------------------------------------------------ utilidades

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

function fileId(f) {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

function nameOf(who) {
  return who === 'A' ? state.settings.nameA : state.settings.nameB;
}

function parseMoneyInput(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const hasComma = s.includes(',');
  const amt = parseAmount(hasComma ? s : s.includes('.') ? s : `${s},00`);
  return amt ? amt.cents : null;
}

function moneyInputValue(cents) {
  return cents == null ? '' : formatBRL(cents).replace('R$ ', '');
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Aplica as regras aos itens sem divisão e salva.
function commit() {
  const f = fatura();
  f.items = applyRules(f.items, state.memory);
  save();
  render();
}

// ------------------------------------------------------------------ abas

function setTab(tab) {
  ui.tab = tab;
  document.querySelectorAll('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${tab}`; });
  render();
  window.scrollTo({ top: 0 });
}

// ------------------------------------------------------------------ render

function render() {
  const f = fatura();
  const s = summarize(f.items);
  $('#fatura-month').value = state.current;
  const badge = $('#badge-pend');
  badge.hidden = !s.nPendente;
  badge.textContent = s.nPendente;
  $('#f-A').textContent = `Só ${state.settings.nameA}`;
  $('#f-B').textContent = `Só ${state.settings.nameB}`;
  if (ui.tab === 'prints') renderPrints(f, s);
  if (ui.tab === 'dividir') renderDividir(f, s);
  if (ui.tab === 'resumo') renderResumo(f, s);
}

function renderPrints(f, s) {
  const thumbs = $('#thumbs');
  thumbs.innerHTML = ui.files.map((x, i) => `
    <figure class="thumb ${x.status}">
      <img src="${x.url}" alt="Print ${i + 1}">
      <figcaption>${x.status === 'done' ? '✓ lido' : x.status === 'dup' ? 'já lido' : x.status === 'error' ? '⚠ erro' : 'novo'}</figcaption>
      <button class="x" data-rm="${i}" aria-label="Remover">×</button>
    </figure>`).join('');
  const pending = ui.files.filter((x) => x.status === 'new');
  $('#read-box').hidden = !ui.files.length;
  const btn = $('#btn-read');
  btn.textContent = pending.length ? `Ler ${pending.length} print(s)` : 'Todos os prints já foram lidos';
  btn.disabled = !pending.length || ui.busy;
  const mode = document.querySelector('input[name=mode]:checked').value;
  $('#mode-hint').innerHTML = mode === 'ai'
    ? (state.settings.apiKey
      ? 'Usa o Claude (Anthropic). Lê melhor valores e nomes; custa alguns centavos por print.'
      : 'Para usar a IA, coloque a chave da API em <b>Configurações</b> (engrenagem).')
    : 'Lê no próprio aparelho, sem enviar nada. Na primeira vez baixa ~15 MB. Confira os itens marcados.';
  if (document.activeElement !== $('#total-informado')) {
    $('#total-informado').value = moneyInputValue(f.totalInformado);
  }
  const chk = $('#total-check');
  if (f.totalInformado != null && f.items.length) {
    const diff = f.totalInformado - s.gastos;
    chk.innerHTML = diff === 0
      ? '<span class="ok">✓ Bate com a soma dos lançamentos.</span>'
      : `Soma dos lançamentos: <b>${formatBRL(s.gastos)}</b> · diferença <b>${formatBRL(diff)}</b>. Pode faltar print ou ter valor lido errado.`;
  } else {
    chk.textContent = f.items.length ? `Soma dos lançamentos lidos: ${formatBRL(s.gastos)} (${f.items.filter((i) => i.kind !== 'pagamento').length} itens).` : '';
  }
}

function sumbarHtml(s) {
  return `
    <div><small>${esc(state.settings.nameA)}</small><b class="ca">${formatBRL(s.a)}</b></div>
    <div><small>${esc(state.settings.nameB)}</small><b class="cb">${formatBRL(s.b)}</b></div>
    <div><small>Sem divisão</small><b class="${s.nPendente ? 'cw' : ''}">${s.nPendente ? formatBRL(s.pendente) : '—'}</b></div>`;
}

function itemMatchesFilter(it) {
  switch (ui.filter) {
    case 'pend': return it.kind === 'pagamento' ? !it.payer : !it.split;
    case 'A': return it.kind !== 'pagamento' && it.split?.mode === 'A';
    case 'B': return it.kind !== 'pagamento' && it.split?.mode === 'B';
    case 'S': return it.kind !== 'pagamento' && it.split?.mode === 'S';
    case 'pag': return it.kind === 'pagamento';
    default: return true;
  }
}

function renderDividir(f, s) {
  $('#sumbar').innerHTML = sumbarHtml(s);
  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('on', b.dataset.f === ui.filter));
  const pct = state.settings.defaultPct;
  $('#bulk').innerHTML = s.nPendente
    ? `<button class="btn small" data-bulk="S">Todos sem divisão → compartilhado ${pct}/${100 - pct}</button>`
    : '';
  const items = sortItems(f.items).filter(itemMatchesFilter);
  $('#empty').hidden = f.items.length > 0;
  const gastos = items.filter((i) => i.kind !== 'pagamento');
  const pags = items.filter((i) => i.kind === 'pagamento');
  let html = gastos.map(itemHtml).join('');
  if (pags.length) {
    html += `<h3 class="sec">Pagamentos <small>não entram nos gastos; marque quem pagou para descontar</small></h3>`;
    html += pags.map(payHtml).join('');
  }
  $('#list').innerHTML = html;
}

function metaHtml(it) {
  const bits = [];
  bits.push(it.date ? `${it.dateGuess ? '~' : ''}${formatDate(it.date)}` : 'data ?');
  if (it.time) bits.push(it.time);
  if (it.card) bits.push(`final ${it.card}`);
  return bits.join(' · ');
}

function itemHtml(it) {
  const mode = it.split?.mode;
  const tags = [];
  if (it.parcela) tags.push(`<span class="tag">parcela ${it.parcela.n}/${it.parcela.m}</span>`);
  if (it.kind === 'estorno') tags.push('<span class="tag green">estorno</span>');
  if (it.auto) tags.push('<span class="tag" title="Aplicado de uma divisão lembrada">auto</span>');
  if (it.uncertain) tags.push('<span class="tag warn">confira o valor</span>');
  if (it.partial) tags.push('<span class="tag warn">print cortado</span>');
  let splitRow = '';
  if (mode === 'S' && ui.expanded !== it.id) {
    const { a, b } = shares(it);
    splitRow = `
      <button class="split-sum" data-expand>
        <span class="ca">${esc(nameOf('A'))} ${formatBRL(a)}</span> ·
        <span class="cb">${esc(nameOf('B'))} ${formatBRL(b)}</span>
        <small>(${formatPct(it.split.pctA)}/${formatPct(100 - it.split.pctA)}) · ajustar</small>
      </button>`;
  } else if (mode === 'S') {
    const { a, b } = shares(it);
    const chips = [50, 60, 40, 70, 30].map((p) => `<button data-pct="${p}" class="${Math.abs(it.split.pctA - p) < 0.01 ? 'on' : ''}">${p}/${100 - p}</button>`).join('');
    splitRow = `
      <div class="split">
        <div class="chips">${chips}</div>
        <input type="range" min="0" max="100" step="5" value="${Math.round(it.split.pctA)}" data-range aria-label="Percentual de ${esc(nameOf('A'))}">
        <div class="split-vals">
          <label><span class="ca">${esc(nameOf('A'))}</span> R$ <input inputmode="decimal" data-vala value="${moneyInputValue(a)}"> <small>${formatPct(it.split.pctA)}</small></label>
          <label><span class="cb">${esc(nameOf('B'))}</span> R$ <input inputmode="decimal" data-valb value="${moneyInputValue(b)}"> <small>${formatPct(100 - it.split.pctA)}</small></label>
        </div>
      </div>`;
  }
  return `
    <article class="item m-${mode || 'none'}" data-id="${it.id}">
      <div class="item-top">
        <div class="item-desc">
          <b>${esc(it.desc)}</b>
          <small>${metaHtml(it)} ${tags.join(' ')}</small>
        </div>
        <div class="item-val ${it.kind === 'estorno' ? 'neg' : ''}">${formatBRL(signed(it))}</div>
      </div>
      <div class="who">
        <button data-mode="A" class="${mode === 'A' ? 'on a' : ''}">${esc(nameOf('A'))}</button>
        <button data-mode="S" class="${mode === 'S' ? 'on s' : ''}">Dividir</button>
        <button data-mode="B" class="${mode === 'B' ? 'on b' : ''}">${esc(nameOf('B'))}</button>
        <button data-edit class="edit" aria-label="Editar">✎</button>
      </div>
      ${splitRow}
    </article>`;
}

function payHtml(it) {
  const p = it.payer;
  return `
    <article class="item pay ${p ? '' : 'm-none'}" data-id="${it.id}">
      <div class="item-top">
        <div class="item-desc">
          <b>${esc(it.subtitle || it.desc)}</b>
          <small>${metaHtml(it)}${it.uncertain ? ' <span class="tag warn">confira o valor</span>' : ''}</small>
        </div>
        <div class="item-val pos">${formatBRL(it.cents)}</div>
      </div>
      <div class="who">
        <button data-payer="A" class="${p === 'A' ? 'on a' : ''}">${esc(nameOf('A'))} pagou</button>
        <button data-payer="X" class="${p === 'X' ? 'on x' : ''}">Ignorar</button>
        <button data-payer="B" class="${p === 'B' ? 'on b' : ''}">${esc(nameOf('B'))} pagou</button>
        <button data-edit class="edit" aria-label="Editar">✎</button>
      </div>
    </article>`;
}

function renderResumo(f, s) {
  const A = esc(state.settings.nameA);
  const B = esc(state.settings.nameB);
  let html = `
    <div class="total-card"><small>Total de gastos · ${nomeFatura(f.year, f.month)}</small><b>${formatBRL(s.gastos)}</b>
      <small>${formatBRL(s.compras)} em compras${s.estornos ? ` − ${formatBRL(s.estornos)} de estornos` : ''}</small></div>
    <div class="total-row">
      <div class="total-card a"><small>${A}</small><b>${formatBRL(s.a)}</b><small>só dele(a) ${formatBRL(s.aProprio)}<br>compartilhado ${formatBRL(s.aComp)}</small></div>
      <div class="total-card b"><small>${B}</small><b>${formatBRL(s.b)}</b><small>só dele(a) ${formatBRL(s.bProprio)}<br>compartilhado ${formatBRL(s.bComp)}</small></div>
    </div>`;
  if (s.pagoA || s.pagoB) {
    html += `<div class="card"><b>Já pago antecipado</b>
      <p>${A}: ${formatBRL(s.pagoA)} → falta <b>${formatBRL(s.faltaA)}</b></p>
      <p>${B}: ${formatBRL(s.pagoB)} → falta <b>${formatBRL(s.faltaB)}</b></p></div>`;
  }
  $('#totals').innerHTML = html;
  const w = [];
  if (s.nPendente) w.push(`${s.nPendente} lançamento(s) sem divisão (${formatBRL(s.pendente)}). <a href="#" data-goto="pend">Dividir agora</a>`);
  const unc = f.items.filter((i) => i.uncertain).length;
  if (unc) w.push(`${unc} valor(es) marcado(s) para conferir.`);
  if (s.nPagoSemDono) w.push(`${s.nPagoSemDono} pagamento(s) antecipado(s) sem dono (${formatBRL(s.pagoSemDono)}). <a href="#" data-goto="pag">Marcar quem pagou</a>`);
  if (f.totalInformado != null && f.totalInformado !== s.gastos) {
    w.push(`O total no app (${formatBRL(f.totalInformado)}) não bate com a soma (${formatBRL(s.gastos)}).`);
  }
  $('#warnings').innerHTML = w.map((x) => `<div class="warn-box">${x}</div>`).join('');
  $('#preview').textContent = reportText(f, state.settings, detailedReport());
}

function detailedReport() {
  return document.querySelector('input[name=rep]:checked').value === 'd';
}

// ------------------------------------------------------------------ leitura dos prints

function addFiles(list) {
  const f = fatura();
  for (const file of list) {
    if (!file.type.startsWith('image/')) continue;
    const id = fileId(file);
    if (ui.files.some((x) => x.id === id)) continue;
    ui.files.push({ id, file, url: URL.createObjectURL(file), status: f.processed.includes(id) ? 'dup' : 'new' });
  }
  render();
}

async function readPrints() {
  const f = fatura();
  const pending = ui.files.filter((x) => x.status === 'new');
  if (!pending.length || ui.busy) return;
  const mode = document.querySelector('input[name=mode]:checked').value;
  if (mode === 'ai' && !state.settings.apiKey) {
    openSettings();
    toast('Coloque a chave da API para ler com IA.');
    return;
  }
  ui.busy = true;
  render();
  const bar = $('#progress');
  const status = $('#read-status');
  bar.hidden = false;
  const onProgress = ({ stage, done }) => {
    status.textContent = stage;
    bar.firstElementChild.style.width = `${Math.round((done / pending.length) * 100)}%`;
  };
  const ctx = { year: f.year, month: f.month };
  try {
    let records = [];
    let errors = 0;
    if (mode === 'ai') {
      const { aiImages } = await import('./ai.js');
      const res = await aiImages(state.settings.apiKey, pending.map((x) => x.file), ctx, onProgress);
      res.forEach((r, i) => {
        if (r.error) {
          pending[i].status = 'error';
          errors++;
          status.textContent = r.error;
          return;
        }
        records.push(...fromAiItems(r.items, ctx, pending[i].id));
        pending[i].status = 'done';
      });
    } else {
      const { ocrImages } = await import('./ocr.js');
      const res = await ocrImages(pending.map((x) => x.file), onProgress);
      res.forEach((lines, i) => {
        records.push(...parseOcrLines(lines, ctx, pending[i].id));
        pending[i].status = 'done';
      });
    }
    const before = f.items.length;
    const { items, merged } = mergeRecords(f.items, records);
    f.items = items;
    f.processed.push(...pending.filter((x) => x.status === 'done').map((x) => x.id));
    commit();
    const novos = f.items.length - before;
    status.textContent = `${novos} lançamento(s) novo(s), ${merged} repetido(s) ignorado(s)${errors ? `, ${errors} print(s) com erro` : ''}.`;
    if (novos) toast(`${novos} lançamento(s) adicionados. Agora é só dividir!`);
  } catch (err) {
    status.textContent = `Erro: ${err.message}`;
    pending.forEach((x) => { if (x.status === 'done') x.status = 'new'; });
  } finally {
    ui.busy = false;
    bar.hidden = true;
    render();
  }
}

// ------------------------------------------------------------------ edição

function findItem(id) {
  return fatura().items.find((i) => i.id === id);
}

function setSplit(it, split) {
  it.split = split;
  it.auto = false;
  state.memory = remember(state.memory, it);
  commit();
}

function openEdit(it) {
  ui.editing = it ? it.id : null;
  const form = $('#form-edit');
  $('#edit-title').textContent = it ? 'Editar lançamento' : 'Novo lançamento';
  $('#btn-del').hidden = !it;
  form.desc.value = it?.desc || '';
  form.valor.value = it ? moneyInputValue(it.cents) : '';
  form.kind.value = it?.kind || 'compra';
  form.date.value = it?.date || '';
  form.time.value = it?.time || '';
  form.pn.value = it?.parcela?.n || '';
  form.pm.value = it?.parcela?.m || '';
  $('#dlg-edit').showModal();
}

function saveEdit(action) {
  const f = fatura();
  if (action === 'delete' && ui.editing) {
    f.items = f.items.filter((i) => i.id !== ui.editing);
    commit();
    return;
  }
  if (action !== 'save') return;
  const form = $('#form-edit');
  const cents = parseMoneyInput(form.valor.value);
  if (cents == null) { toast('Valor inválido.'); return; }
  const pn = parseInt(form.pn.value, 10);
  const pm = parseInt(form.pm.value, 10);
  const data = {
    desc: form.desc.value.trim(),
    cents: Math.abs(cents),
    kind: form.kind.value,
    date: form.date.value || null,
    dateGuess: false,
    time: form.time.value || null,
    parcela: pn && pm ? { n: pn, m: pm } : null,
    uncertain: false,
    partial: false,
  };
  if (data.kind === 'estorno') data.subtitle = 'Estorno';
  if (ui.editing) {
    Object.assign(findItem(ui.editing), data);
  } else {
    f.items.push({ id: newId(), ...data, card: null, subtitle: data.subtitle || null, sources: [], split: null, auto: false, payer: null });
  }
  commit();
}

// ------------------------------------------------------------------ configurações

function openSettings() {
  const form = $('#form-settings');
  const st = state.settings;
  form.nameA.value = st.nameA;
  form.nameB.value = st.nameB;
  form.defaultPct.value = st.defaultPct;
  form.apiKey.value = st.apiKey;
  renderRules();
  if (!$('#dlg-settings').open) $('#dlg-settings').showModal();
}

function renderRules() {
  const rules = Object.entries(state.memory.rules || {});
  $('#rules').innerHTML = rules.length
    ? rules.sort((a, b) => a[1].desc.localeCompare(b[1].desc)).map(([k, r]) => {
      const who = r.mode === 'A' ? nameOf('A') : r.mode === 'B' ? nameOf('B') : `dividido ${formatPct(r.pctA)}/${formatPct(100 - r.pctA)}`;
      return `<div class="rule"><span><b>${esc(r.desc)}</b> → ${esc(who)}</span><button type="button" data-rule="${esc(k)}" aria-label="Esquecer">×</button></div>`;
    }).join('')
    : '<p class="hint">Nenhuma ainda.</p>';
}

function saveSettings() {
  const form = $('#form-settings');
  const pct = Math.min(100, Math.max(0, parseInt(form.defaultPct.value, 10) || 50));
  state.settings = {
    nameA: form.nameA.value.trim() || 'Pessoa A',
    nameB: form.nameB.value.trim() || 'Pessoa B',
    defaultPct: pct,
    apiKey: form.apiKey.value.trim(),
  };
  save();
  render();
}

function exportBackup() {
  const { apiKey, ...settings } = state.settings;
  const data = { ...state, settings, exportedAt: new Date().toISOString(), app: 'divide-fatura' };
  download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `divide-fatura-backup-${new Date().toISOString().slice(0, 10)}.json`);
}

async function importBackup(file) {
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'divide-fatura' || !d.faturas) throw new Error('arquivo não é um backup do Divide Fatura');
    if (!confirm('Importar o backup? As faturas e divisões lembradas do arquivo vão substituir as deste aparelho (a chave da API é mantida).')) return;
    const apiKey = state.settings.apiKey;
    state = { ...defaultState(), ...d, settings: { ...defaultState().settings, ...d.settings, apiKey } };
    delete state.exportedAt;
    delete state.app;
    save();
    ui.files = [];
    openSettings();
    render();
    toast('Backup importado.');
  } catch (err) {
    toast(`Não deu para importar: ${err.message}`);
  }
}

// ------------------------------------------------------------------ relatórios

async function shareText() {
  const text = reportText(fatura(), state.settings, detailedReport());
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  await copyText();
}

async function copyText() {
  const text = reportText(fatura(), state.settings, detailedReport());
  try {
    await navigator.clipboard.writeText(text);
    toast('Texto copiado. É só colar no WhatsApp.');
  } catch {
    toast('Não consegui copiar; selecione o texto abaixo.');
  }
}

async function makePdf() {
  const { buildPdf } = await import('./pdf.js');
  return buildPdf(fatura(), state.settings, detailedReport());
}

async function sharePdf() {
  try {
    const { blob, name } = await makePdf();
    const file = new File([blob], name, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (err) { if (err.name === 'AbortError') return; }
    }
    download(blob, name);
  } catch (err) {
    toast(err.message);
  }
}

// ------------------------------------------------------------------ eventos

function bind() {
  document.querySelectorAll('[role=tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  $('#fatura-month').addEventListener('change', (e) => {
    if (!e.target.value) return;
    state.current = e.target.value;
    ui.files.forEach((x) => URL.revokeObjectURL(x.url));
    ui.files = [];
    save();
    render();
  });

  $('#files').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
  $('#thumbs').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (!rm) return;
    const [x] = ui.files.splice(Number(rm.dataset.rm), 1);
    URL.revokeObjectURL(x.url);
    render();
  });
  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', render));
  $('#btn-read').addEventListener('click', readPrints);
  $('#total-informado').addEventListener('change', (e) => {
    fatura().totalInformado = parseMoneyInput(e.target.value);
    save();
    render();
  });
  $('#btn-add').addEventListener('click', () => openEdit(null));

  $('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    ui.filter = b.dataset.f;
    render();
  });
  $('#bulk').addEventListener('click', (e) => {
    if (!e.target.closest('[data-bulk]')) return;
    const pct = state.settings.defaultPct;
    for (const it of fatura().items) {
      if (it.kind !== 'pagamento' && !it.split) it.split = { mode: 'S', pctA: pct };
    }
    save();
    render();
  });

  const list = $('#list');
  list.addEventListener('click', (e) => {
    const card = e.target.closest('.item');
    if (!card) return;
    const it = findItem(card.dataset.id);
    if (!it) return;
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.edit !== undefined) { openEdit(it); return; }
    if (b.dataset.expand !== undefined) { ui.expanded = it.id; render(); return; }
    if (b.dataset.payer) {
      it.payer = it.payer === b.dataset.payer ? null : b.dataset.payer;
      save();
      render();
      return;
    }
    if (b.dataset.mode) {
      const m = b.dataset.mode;
      if (it.split?.mode === m && !it.auto) { setSplit(it, null); return; }
      if (m === 'S') ui.expanded = it.id;
      setSplit(it, m === 'S' ? { mode: 'S', pctA: it.split?.mode === 'S' ? it.split.pctA : state.settings.defaultPct } : { mode: m });
      return;
    }
    if (b.dataset.pct) setSplit(it, { mode: 'S', pctA: Number(b.dataset.pct) });
  });
  list.addEventListener('change', (e) => {
    const card = e.target.closest('.item');
    const it = card && findItem(card.dataset.id);
    if (!it) return;
    const total = signed(it);
    if (e.target.matches('[data-range]')) setSplit(it, { mode: 'S', pctA: Number(e.target.value) });
    else if (e.target.matches('[data-vala], [data-valb]')) {
      const v = parseMoneyInput(e.target.value);
      if (v == null || !total) return;
      const a = e.target.matches('[data-vala]') ? v : total - v;
      const pctA = Math.min(100, Math.max(0, (a / total) * 100));
      setSplit(it, { mode: 'S', pctA });
    }
  });
  list.addEventListener('input', (e) => {
    if (!e.target.matches('[data-range]')) return;
    const card = e.target.closest('.item');
    const it = findItem(card.dataset.id);
    const p = Number(e.target.value);
    const a = Math.round((signed(it) * p) / 100);
    card.querySelector('[data-vala]').value = moneyInputValue(a);
    card.querySelector('[data-valb]').value = moneyInputValue(signed(it) - a);
  });

  $('#form-edit').addEventListener('submit', (e) => {
    const action = e.submitter?.value;
    if (action === 'save' && !e.target.checkValidity()) return;
    saveEdit(action);
  });

  $('#btn-settings').addEventListener('click', openSettings);
  $('#form-settings').addEventListener('submit', saveSettings);
  $('#dlg-settings').addEventListener('close', saveSettings);
  $('#rules').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rule]');
    if (!b) return;
    delete state.memory.rules[b.dataset.rule];
    for (const [k, r] of Object.entries(state.memory.installments || {})) {
      if (ruleKey(r.desc) === b.dataset.rule) delete state.memory.installments[k];
    }
    save();
    renderRules();
  });
  $('#btn-export').addEventListener('click', exportBackup);
  $('#import-file').addEventListener('change', (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });
  $('#btn-clear').addEventListener('click', () => {
    const f = fatura();
    if (!confirm(`Apagar todos os lançamentos da fatura de ${nomeFatura(f.year, f.month)}? As divisões lembradas continuam.`)) return;
    delete state.faturas[state.current];
    ui.files = [];
    save();
    $('#dlg-settings').close();
    render();
  });

  document.querySelectorAll('input[name=rep]').forEach((r) => r.addEventListener('change', render));
  $('#btn-share-text').addEventListener('click', shareText);
  $('#btn-copy').addEventListener('click', copyText);
  $('#btn-share-pdf').addEventListener('click', sharePdf);
  $('#btn-pdf').addEventListener('click', async () => {
    try { const { blob, name } = await makePdf(); download(blob, name); } catch (err) { toast(err.message); }
  });
  $('#btn-txt').addEventListener('click', () => {
    const f = fatura();
    const d = detailedReport();
    download(new Blob([reportText(f, state.settings, d)], { type: 'text/plain;charset=utf-8' }),
      `fatura-${f.id}-${d ? 'detalhado' : 'simplificado'}.txt`);
  });
  $('#warnings').addEventListener('click', (e) => {
    const a = e.target.closest('[data-goto]');
    if (!a) return;
    e.preventDefault();
    ui.filter = a.dataset.goto;
    setTab('dividir');
  });
}

bind();
render();
// Primeira vez: pede os nomes.
if (!state.welcomed) {
  state.welcomed = true;
  save();
  openSettings();
}
