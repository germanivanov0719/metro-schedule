// app.js — логика приложения «Петербургский метрополитен · режим станций».
//
// Источники данных по приоритету свежести: localStorage-кэш, встроенный
// снимок data.json (для офлайна и мгновенного показа) и живой запрос на
// официальный сайт через CORS-прокси. Снимок data.json регулярно обновляется
// GitHub Actions, а парсинг живой страницы делается прямо в браузере.

import { parseSchedule, timeToMinutes } from './parser.js';

// ───────────────────────────── константы ─────────────────────────────
const SOURCE_URL = 'https://metro.spb.ru/rejimrabotystancii.html';
const SITE_URL = 'https://metro.spb.ru';
const CACHE_KEY = 'metro-spb:data';
const THEME_KEY = 'metro-spb:theme';
const XFER_KEY = 'metro-spb:transfer-dismissed';
const SOON_WINDOW = 90;   // мин до последнего поезда, когда показываем отсчёт
const SOON_MARK = 30;     // мин: порог «жёлтого»
const NIGHT_GONE = 120;   // до 02:00 пишем «поезд ушёл», дальше — отсчёт до открытия
const OPEN_SOON = 30;
const FETCH_TIMEOUT = 12000;

const PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
  (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
  (u) => u,
];

// Действующие пересадочные узлы (по списку Петербургского метрополитена).
// Имена станций — точно как в данных расписания.
const INTERCHANGES = [
  ['1:Технологический институт 1', '2:Технологический институт 2'],
  ['1:Владимирская', '4:Достоевская'],
  ['1:Площадь Восстания', '3:Маяковская'],
  ['2:Сенная площадь', '4:Спасская', '5:Садовая'],
  ['2:Невский проспект', '3:Гостиный двор'],
  ['3:Площадь Александра Невского 1', '4:Площадь Александра Невского 2'],
  ['1:Пушкинская', '5:Звенигородская'],
  ['1:Кировский завод', '6:Путиловская'],
];
const XFER_MAP = new Map(); // "lineId:station" -> [{ line, station }]
for (const hub of INTERCHANGES) {
  for (const a of hub) {
    const others = hub.filter((x) => x !== a).map((x) => {
      const i = x.indexOf(':');
      return { line: x.slice(0, i), station: x.slice(i + 1) };
    });
    XFER_MAP.set(a, others);
  }
}

// Базовые государственные праздники РФ (ММ-ДД).
const HOLIDAYS = {
  '01-01': 'Новый год', '01-02': 'Новогодние каникулы', '01-07': 'Рождество Христово',
  '02-23': 'День защитника Отечества', '03-08': 'Международный женский день',
  '05-01': 'Праздник Весны и Труда', '05-09': 'День Победы',
  '06-12': 'День России', '11-04': 'День народного единства', '12-31': 'Канун Нового года',
};
// Праздники, в которые метрополитен традиционно может работать круглосуточно.
const ALLNIGHT = new Set(['12-31', '01-01', '05-09', '06-12']);

// ───────────────────────────── элементы ──────────────────────────────
const el = {
  list: document.getElementById('list'),
  foot: document.getElementById('foot'),
  lineFilter: document.getElementById('lineFilter'),
  search: document.getElementById('search'),
  searchClear: document.getElementById('searchClear'),
  clockTime: document.getElementById('clockTime'),
  clockParity: document.getElementById('clockParity'),
  updStatus: document.getElementById('updStatus'),
  transferMini: document.getElementById('transferMini'),
  toast: document.getElementById('toast'),
  themeColor: document.getElementById('themeColor'),
};

// ───────────────────────────── состояние ─────────────────────────────
let DATA = null;
let activeLine = 'all';
let query = '';
let refreshing = false;
const expanded = new Set();
const stopIndex = new Map();

const TRANSFER_TEXT = 'Пересадка между линиями гарантирована до 00:15. После этого переход может оставаться открытым до прохода последнего поезда, но это уже не гарантируется.';

// ───────────────────────────── утилиты ───────────────────────────────
const norm = (s) => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const pad2 = (n) => String(n).padStart(2, '0');
const nowMinutes = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
const parityOf = (d = new Date()) => (d.getDate() % 2 === 1 ? 'odd' : 'even');
const parityLabel = (p) => (p === 'odd' ? 'нечётный день' : 'чётный день');
const displayName = (s) => s.replace(/\s+[12]$/, '');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inWindow(now, start, end) {
  if (start == null || end == null) return null;
  let e = end;
  if (e < start) e += 1440;
  if (now >= start && now <= e) return true;
  if (now + 1440 >= start && now + 1440 <= e) return true;
  return false;
}

function holidayToday(d = new Date()) {
  const key = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return HOLIDAYS[key] ? { key, name: HOLIDAYS[key], allnight: ALLNIGHT.has(key) } : null;
}
const isWeekend = (d = new Date()) => d.getDay() === 0 || d.getDay() === 6;

function toast(msg) {
  if (!el.toast) return;
  el.toast.textContent = msg;
  el.toast.hidden = false;
  requestAnimationFrame(() => el.toast.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.toast.classList.remove('show');
    setTimeout(() => { el.toast.hidden = true; }, 300);
  }, 3200);
}

// ───────────────────────── логотип «М» ───────────────────────────────
function mMark(color, label, extra = '') {
  return `<span class="mmark ${extra}" style="--c:${color}"><svg viewBox="0 0 1326 1000"><use href="#metroM"/></svg><span class="mmark__n">${esc(label)}</span></span>`;
}

// ───────────────────────────── тема ──────────────────────────────────
const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; } };
const resolvedTheme = (t = currentTheme()) => (t === 'light' || t === 'dark') ? t : (mqDark.matches ? 'dark' : 'light');
function applyTheme(t = currentTheme()) {
  document.documentElement.dataset.theme = t;
  const r = resolvedTheme(t);
  if (el.themeColor) el.themeColor.setAttribute('content', r === 'dark' ? '#06080b' : '#ffffff');
  document.querySelectorAll('.theme__btn').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.themeSet === t)));
}
function setTheme(t) { try { localStorage.setItem(THEME_KEY, t); } catch { /* */ } applyTheme(t); }
mqDark.addEventListener('change', () => { if (currentTheme() === 'system') applyTheme(); });

// ──────────────────────── загрузка данных ─────────────────────────────
async function init() {
  applyTheme();
  bindStaticEvents();
  syncTransferMini();
  tickClock();
  setInterval(tickClock, 10_000);
  setInterval(refreshLiveStatuses, 15_000);
  registerSW();

  // Снимок (data.json) и кэш — берём, что свежее, и показываем сразу.
  const [snapshot, cached] = await Promise.all([loadSnapshot(), Promise.resolve(readCache())]);
  DATA = normalize(freshest(snapshot, cached));
  if (DATA) {
    buildLineFilter();
    render();
    renderFoot();
    updTop();
  }
  await refreshLive(!DATA);
}

async function loadSnapshot() {
  try {
    const res = await fetch('./data.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    const d = await res.json();
    return validate(d) ? d : null;
  } catch { return null; }
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return validate(d) ? d : null;
  } catch { return null; }
}

function tsOf(d) { return d?.meta?.fetchedAt ? Date.parse(d.meta.fetchedAt) : (d?.meta?.generatedAt ? Date.parse(d.meta.generatedAt) : 0); }
function freshest(a, b) {
  if (a && b) return tsOf(b) >= tsOf(a) ? b : a;
  return a || b || null;
}

function validate(d) {
  if (!d || !Array.isArray(d.lines) || d.lines.length < 5) return false;
  return d.lines.reduce((n, l) => n + (l.stops?.length || 0), 0) >= 60;
}

// Идентификаторы линий приводим к строкам — данные могут давать число.
function normalize(d) {
  if (d && Array.isArray(d.lines)) for (const l of d.lines) l.id = String(l.id);
  return d;
}

async function decodeResponse(res) {
  const buf = await res.arrayBuffer();
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  let enc = /1251|cp1251/.test(ctype) ? 'windows-1251' : 'utf-8';
  let text = new TextDecoder(enc).decode(buf);
  if (enc === 'utf-8' && /\uFFFD/.test(text)) {
    const m = text.match(/charset=["']?([\w-]+)/i);
    if (m && /1251/.test(m[1])) { try { text = new TextDecoder('windows-1251').decode(buf); } catch { /* */ } }
  }
  return text;
}

async function fetchWithTimeout(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try { return await fetch(url, { signal: ctl.signal, cache: 'no-store', redirect: 'follow' }); }
  finally { clearTimeout(t); }
}

async function refreshLive(coldStart) {
  if (refreshing) return false;
  refreshing = true; updTop();
  setBusy(coldStart);

  for (const make of PROXIES) {
    try {
      const res = await fetchWithTimeout(make(SOURCE_URL));
      if (!res.ok) continue;
      const html = await decodeResponse(res);
      if (!/ЛИНИЯ/i.test(html) || !/вестибюл/i.test(html.toLowerCase())) continue;
      const parsed = parseSchedule(html);
      if (!validate(parsed)) continue;

      parsed.meta = { ...parsed.meta, fetchedAt: new Date().toISOString(), live: true };
      DATA = normalize(parsed);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(parsed)); } catch { /* квота */ }

      buildLineFilter();
      render();
      renderFoot();
      refreshing = false; updTop();
      setBusy(false);
      if (!coldStart) toast('Расписание обновлено');
      return true;
    } catch { /* следующий прокси */ }
  }

  refreshing = false; updTop();
  setBusy(false);
  if (!DATA) showError();
  else { renderFoot(); if (!coldStart) toast('Нет связи с сайтом — показаны сохранённые данные'); }
  return false;
}

function setBusy(on) { el.list.setAttribute('aria-busy', String(!!on)); }

function showError() {
  el.list.innerHTML = `
    <div class="empty">
      <p>Не удалось загрузить расписание и нет сохранённой копии.</p>
      <p class="empty__hint">Проверьте подключение к интернету.</p>
      <button class="retry" id="retry">Повторить</button>
    </div>`;
  const b = document.getElementById('retry');
  if (b) b.addEventListener('click', () => {
    el.list.innerHTML = '<div class="loader"><span class="loader__spin"></span><span class="loader__text">Загрузка расписания…</span></div>';
    refreshLive(true);
  });
}

// ─────────────────────── верхний статус ───────────────────────────────
function updTop() {
  if (!el.updStatus) return;
  if (refreshing) {
    el.updStatus.innerHTML = '<span class="updstatus__pulse"></span>обновление…';
    return;
  }
  const m = DATA?.meta || {};
  const iso = m.fetchedAt || m.generatedAt;
  if (!iso) { el.updStatus.textContent = ''; return; }
  const tail = m.live ? '' : (m.fetchedAt ? '' : ' · снимок');
  el.updStatus.textContent = `обновлено ${fmtWhen(iso)}${tail}`;
}

// ──────────────────────── фильтр по линиям ────────────────────────────
function buildLineFilter() {
  el.lineFilter.innerHTML = '';
  const all = document.createElement('button');
  all.className = 'chip chip--all'; all.type = 'button'; all.dataset.line = 'all';
  all.textContent = 'Все';
  all.setAttribute('aria-pressed', String(activeLine === 'all'));
  all.addEventListener('click', () => selectLine('all'));
  el.lineFilter.appendChild(all);

  for (const line of DATA.lines) {
    const b = document.createElement('button');
    b.className = 'chip chip--line'; b.type = 'button'; b.dataset.line = line.id;
    b.setAttribute('aria-pressed', String(line.id === activeLine));
    b.setAttribute('aria-label', `Линия ${line.id}`);
    b.innerHTML = mMark(line.color, line.id);
    b.addEventListener('click', () => selectLine(line.id));
    el.lineFilter.appendChild(b);
  }
}

function selectLine(id) {
  activeLine = id;
  el.lineFilter.querySelectorAll('.chip').forEach((c) =>
    c.setAttribute('aria-pressed', String(c.dataset.line === id)));
  render();
}

// ─────────────────────────── отрисовка ────────────────────────────────
function render() {
  if (!DATA) return;
  const now = nowMinutes();
  const par = parityOf();
  const hol = holidayToday();
  const weekendLike = isWeekend() || !!hol;
  const frag = document.createDocumentFragment();

  // Верхняя карточка про пересадки (один раз, до закрытия).
  if (!transferDismissed()) frag.appendChild(transferCard());
  // Праздничный круглосуточный режим.
  if (hol && hol.allnight) frag.appendChild(holidayCard(hol));

  let shown = 0;
  for (const line of DATA.lines) {
    if (activeLine !== 'all' && line.id !== activeLine) continue;
    const stops = line.stops.filter(matches);
    if (!stops.length) continue;
    shown += stops.length;
    frag.appendChild(lineHead(line));
    for (const s of stops) frag.appendChild(stationCard(line, s, now, par, weekendLike));
  }

  el.list.innerHTML = '';
  setBusy(false);
  el.list.appendChild(frag);
  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = query ? 'Ничего не найдено. Попробуйте другое название.' : 'Нет станций для отображения.';
    el.list.appendChild(empty);
  }
}

function matches(stop) {
  if (!query) return true;
  if (norm(stop.station).includes(query)) return true;
  return stop.vestibules.some((v) => norm(v.name).includes(query));
}

// ── карточки-уведомления ──
function transferCard() {
  const d = document.createElement('div');
  d.className = 'notice';
  d.innerHTML = `
    <div class="notice__body">
      <div class="notice__title">Пересадки гарантированы до 00:15</div>
      <p class="notice__text">${esc(TRANSFER_TEXT)}</p>
    </div>
    <button class="notice__x" id="noticeX" aria-label="Закрыть">×</button>`;
  d.querySelector('#noticeX').addEventListener('click', () => {
    try { localStorage.setItem(XFER_KEY, '1'); } catch { /* */ }
    render(); syncTransferMini();
  });
  return d;
}
function transferDismissed() { try { return localStorage.getItem(XFER_KEY) === '1'; } catch { return false; } }

function holidayCard(hol) {
  const d = document.createElement('div');
  d.className = 'notice notice--holiday';
  d.innerHTML = `
    <div class="notice__body">
      <div class="notice__title">${esc(hol.name)}: возможен круглосуточный режим</div>
      <p class="notice__text">В праздничные дни метрополитен может работать всю ночь. Режим работы возможны изменения — уточняйте на <a href="${SITE_URL}" target="_blank" rel="noopener">metro.spb.ru</a>.</p>
    </div>`;
  return d;
}

function lineHead(line) {
  const wrap = document.createElement('div');
  wrap.className = 'line-head';
  const t = line.termini || [];
  wrap.innerHTML = `
    ${mMark(line.color, line.id)}
    <span class="line-head__text">
      <span class="line-head__name">${esc(line.title || line.name)}</span>
      ${t.length >= 2 ? `<span class="line-head__dir">${esc(t[0])} ↔ ${esc(t[t.length - 1])}</span>` : ''}
    </span>`;
  return wrap;
}

function stationCard(line, stop, now, par, weekendLike) {
  const key = `${line.id}:${stop.station}`;
  stopIndex.set(key, { line, stop, weekendLike });
  const isOpen = expanded.has(key);

  const card = document.createElement('article');
  card.className = 'stn' + (stop.closed ? ' stn--closed' : '');
  card.dataset.key = key;
  card.style.setProperty('--line', line.color);

  const xfers = XFER_MAP.get(key) || [];
  const xferHtml = xfers.length ? `<div class="stn__xfers">${xfers.map((x) => {
    const c = (DATA.lines.find((l) => l.id === x.line) || {}).color || 'var(--muted)';
    return `<button class="xfer" data-go="${esc(x.line)}:${esc(x.station)}">${mMark(c, x.line, 'mmark--sm')}<span class="xfer__name">${esc(displayName(x.station))}</span></button>`;
  }).join('')}</div>` : '';

  card.innerHTML = `
    <div class="stn__top">
      <button class="stn__toggle" aria-expanded="${isOpen}">
        <span class="stn__name">${esc(stop.station)}</span>
        <span class="stn__status">${stop.closed ? '<span class="pill pill--shut">закрыта</span>' : statusPill(stop, now)}</span>
        <span class="stn__chev" aria-hidden="true"></span>
      </button>
      ${xferHtml}
    </div>
    <div class="stn__body"${isOpen ? '' : ' hidden'}></div>`;

  const toggle = card.querySelector('.stn__toggle');
  const body = card.querySelector('.stn__body');
  if (isOpen) body.appendChild(stationBody(stop, now, par, weekendLike));

  toggle.addEventListener('click', () => {
    const open = !expanded.has(key);
    if (open) expanded.add(key); else expanded.delete(key);
    toggle.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    if (open) { body.innerHTML = ''; body.appendChild(stationBody(stop, nowMinutes(), parityOf(), weekendLike)); }
  });
  return card;
}

function statusPill(stop, now) {
  let soon = null;
  for (const l of stop.last || []) {
    const t = timeToMinutes(l.value);
    if (t == null) continue;
    let diff = t - now;
    if (diff < -60) diff += 1440;
    if (diff >= -3 && diff <= SOON_WINDOW && (!soon || diff < soon)) soon = diff;
  }
  if (soon != null) {
    const m = Math.round(soon);
    return `<span class="pill pill--soon">${m <= 0 ? 'поезд уходит' : `последний через ${m} мин`}</span>`;
  }
  let open = false, closingSoon = false;
  for (const v of stop.vestibules || []) {
    const o = timeToMinutes(v.open?.[0]);
    const c = timeToMinutes(v.closeIn);
    if (inWindow(now, o, c)) {
      open = true;
      let end = c; if (end < o) end += 1440;
      let n = now; if (n < o) n += 1440;
      if (end - n <= OPEN_SOON) closingSoon = true;
    }
  }
  if (open) return closingSoon ? '<span class="pill pill--soon">скоро закрытие</span>' : '<span class="pill pill--open">вход открыт</span>';
  return '<span class="pill pill--shut">вход закрыт</span>';
}

function stationBody(stop, now, par, weekendLike) {
  const frag = document.createDocumentFragment();
  if (stop.closed) {
    const b = document.createElement('div');
    b.className = 'closed-banner';
    b.textContent = stop.note || 'Станция закрыта';
    frag.appendChild(b);
    return frag;
  }
  if ((stop.first && stop.first.length) || (stop.last && stop.last.length)) {
    frag.appendChild(sectLabel('Поезда'));
    frag.appendChild(trainsBlock(stop, now, par));
  }
  if (stop.vestibules && stop.vestibules.length) {
    frag.appendChild(sectLabel('Вестибюли и выходы'));
    const vb = document.createElement('div');
    vb.className = 'vest';
    for (const v of stop.vestibules) vb.appendChild(vestRow(v, now, weekendLike));
    frag.appendChild(vb);
  }
  return frag;
}

function sectLabel(text) {
  const d = document.createElement('div');
  d.className = 'sect-label';
  d.textContent = text;
  return d;
}

// Контекстный статус по направлению: отсчёт до первого/последнего поезда.
function dirStatus(d, now, par) {
  const firstStr = par === 'odd' ? (d.first?.odd || d.first?.even) : (d.first?.even || d.first?.odd);
  const firstM = timeToMinutes(firstStr);
  const lastM = timeToMinutes(d.last?.value);
  if (firstM == null && lastM == null) return null;

  const closedNight = lastM != null && firstM != null && lastM < firstM && now >= lastM && now < firstM;
  if (closedNight) {
    if (now < NIGHT_GONE) return { lvl: 'gone', text: 'поезд ушёл' };
    const tf = firstM - now;
    return { lvl: tf < SOON_MARK ? 'soon' : 'ok', text: `первый через ${tf} мин` };
  }
  if (lastM != null) {
    const tl = (((lastM - now) % 1440) + 1440) % 1440;
    if (tl <= SOON_WINDOW) return { lvl: tl < SOON_MARK ? 'soon' : 'ok', text: `последний через ${tl} мин` };
    return { lvl: 'ok', text: 'поезда ходят' };
  }
  const tf = (((firstM - now) % 1440) + 1440) % 1440;
  return { lvl: tf < SOON_MARK ? 'soon' : 'ok', text: `первый через ${tf} мин` };
}

function trainsBlock(stop, now, par) {
  const wrap = document.createElement('div');
  wrap.className = 'dirs';

  const dirs = new Map();
  for (const f of stop.first || []) { const d = dirs.get(f.to) || { to: f.to }; d.first = f; dirs.set(f.to, d); }
  for (const l of stop.last || []) { const d = dirs.get(l.to) || { to: l.to }; d.last = l; dirs.set(l.to, d); }

  for (const d of dirs.values()) {
    const cell = document.createElement('div');
    cell.className = 'dir';
    const ds = dirStatus(d, now, par);
    const status = ds ? `<span class="ds ds--${ds.lvl}">${esc(ds.text)}</span>` : '';
    const rows = [`<div class="dir__head"><span class="dir__to">→ ${esc(d.to)}</span>${status}</div>`];

    if (d.first) {
      if (!d.first.even || !d.first.odd || d.first.odd === d.first.even) {
        rows.push(timeRow('первый', `<span class="tt tnum">${esc(d.first.odd || d.first.even || '—')}</span>`));
      } else {
        const oddCls = par === 'odd' ? 'tt--today' : 'tt--off';
        const evenCls = par === 'even' ? 'tt--today' : 'tt--off';
        rows.push(`<div class="dir__row"><span class="dir__lbl">первый</span><span class="dir__vals">
          <span class="tt tnum ${oddCls}">${esc(d.first.odd)}<small>неч</small></span>
          <span class="tt tnum ${evenCls}">${esc(d.first.even)}<small>чёт</small></span></span></div>`);
      }
    }
    if (d.last) rows.push(timeRow('последний', `<span class="tt tnum tt--last">${esc(d.last.value || '—')}</span>`));
    cell.innerHTML = rows.join('');
    wrap.appendChild(cell);
  }
  return wrap;
}

function timeRow(lbl, valHtml) {
  return `<div class="dir__row"><span class="dir__lbl">${esc(lbl)}</span><span class="dir__vals">${valHtml}</span></div>`;
}

function vestRow(v, now, weekendLike) {
  const row = document.createElement('div');
  row.className = 'vt';
  const openTimes = (v.open && v.open.length) ? v.open.join(' / ') : '—';
  const o = timeToMinutes(v.open?.[0]);
  const cIn = timeToMinutes(v.closeIn);
  const weekendClosed = weekendLike && (v.notes || []).some((n) => /выходн|праздни/i.test(n));
  let st = weekendClosed ? false : inWindow(now, o, cIn);
  let dot = 'vt__dot--shut';
  if (st === true) dot = 'vt__dot--open';
  else if (st === null) dot = 'vt__dot--unk';
  const notes = (v.notes || []).map((n) => `<div class="vest__note">${esc(n)}</div>`).join('');

  row.innerHTML = `
    <div class="vt__head"><span class="vt__dot ${dot}"></span><span class="vt__name">${esc(v.name)}</span></div>
    <div class="vt__grid">
      <div><span class="vt__lbl">открытие</span><span class="tnum">${esc(openTimes)}</span></div>
      <div><span class="vt__lbl">закр. вход</span><span class="tnum">${esc(v.closeIn || '—')}</span></div>
      <div><span class="vt__lbl">закр. выход</span><span class="tnum">${esc(v.closeOut || '—')}</span></div>
    </div>${notes}`;
  return row;
}

function refreshLiveStatuses() {
  if (!DATA) return;
  const now = nowMinutes();
  const par = parityOf();
  for (const card of el.list.querySelectorAll('.stn')) {
    const rec = stopIndex.get(card.dataset.key);
    if (!rec || rec.stop.closed) continue;
    const st = card.querySelector('.stn__status');
    if (st) st.innerHTML = statusPill(rec.stop, now);
    const body = card.querySelector('.stn__body');
    if (body && !body.hidden) { body.innerHTML = ''; body.appendChild(stationBody(rec.stop, now, par, rec.weekendLike)); }
  }
}

// ── переход на станцию по пересадке ──
function navigateTo(line, station) {
  const key = `${line}:${station}`;
  activeLine = line;
  el.lineFilter.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.line === line)));
  query = ''; el.search.value = ''; el.searchClear.hidden = true;
  expanded.add(key);
  render();
  requestAnimationFrame(() => {
    for (const card of el.list.querySelectorAll('.stn')) {
      if (card.dataset.key === key) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('flash');
        setTimeout(() => card.classList.remove('flash'), 1400);
        break;
      }
    }
  });
}

// ── свёрнутое напоминание о пересадках ──
function syncTransferMini() {
  if (!el.transferMini) return;
  if (transferDismissed()) {
    el.transferMini.hidden = false;
    el.transferMini.innerHTML = '<span class="tmini__i">i</span><span>Пересадки между линиями гарантированы до 00:15</span>';
  } else {
    el.transferMini.hidden = true;
  }
}

// ───────────────────────────── футер ──────────────────────────────────
function renderFoot() {
  const m = DATA?.meta || {};
  el.foot.innerHTML = `
    <p class="foot__date">${m.scheduleDate ? `Расписание действует ${esc(m.scheduleDate)}. ` : ''}<a href="${SOURCE_URL}" target="_blank" rel="noopener">Официальный источник</a></p>
    <p class="foot__meta">Неофициальное приложение, данные могут отличаться от актуальных.</p>`;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function tickClock() {
  const d = new Date();
  el.clockTime.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  el.clockParity.textContent = parityLabel(parityOf(d));
}

// ─────────────────────────── события ──────────────────────────────────
function bindStaticEvents() {
  el.search.addEventListener('input', () => {
    query = norm(el.search.value);
    el.searchClear.hidden = !el.search.value;
    render();
  });
  el.searchClear.addEventListener('click', () => {
    el.search.value = ''; query = ''; el.searchClear.hidden = true; render(); el.search.focus();
  });
  el.list.addEventListener('click', (e) => {
    const go = e.target.closest?.('[data-go]');
    if (go) { const [l, ...s] = go.dataset.go.split(':'); navigateTo(l, s.join(':')); }
  });
  if (el.transferMini) el.transferMini.addEventListener('click', () => {
    try { localStorage.removeItem(XFER_KEY); } catch { /* */ }
    syncTransferMini();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.querySelectorAll('.theme__btn').forEach((b) =>
    b.addEventListener('click', () => setTheme(b.dataset.themeSet)));
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

init();
