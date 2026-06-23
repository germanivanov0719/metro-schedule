// app.js — логика приложения «Петербургский метрополитен · режим станций».
//
// Данные о расписании берутся (по свежести) из встроенного снимка data.json,
// из localStorage-кэша и из живого запроса к официальному сайту через
// CORS-прокси. HTML официальной страницы парсится прямо в браузере (parser.js).

import { parseSchedule, timeToMinutes } from './parser.js';

/* ════════════════════════ Константы ════════════════════════ */

const SOURCE_URL = 'https://metro.spb.ru/rejimrabotystancii.html';
const SITE_URL = 'https://metro.spb.ru';
const CACHE_KEY = 'metro-spb:data';
const THEME_KEY = 'metro-spb:theme';
const noticeKey = (id) => `metro-spb:notice:${id}`;

const SOON_WINDOW = 90;   // мин до последнего поезда, когда показываем отсчёт
const SOON_MARK = 30;     // мин: порог «менее получаса»
const NIGHT_GONE = 120;   // до 02:00 пишем «поезд ушёл», затем — отсчёт до открытия
const ENTRY_SOON = 60;    // мин: «скоро открытие» входа
const ENTRY_CLOSE_SOON = 30; // мин: «скоро закрытие» — по ПОСЛЕДНЕМУ входу станции
const FETCH_TIMEOUT = 12000;

const PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
  (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
  (u) => u,
];

// Действующие пересадочные узлы (имена станций — точно как в данных).
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
    XFER_MAP.set(a, hub.filter((x) => x !== a).map((x) => {
      const i = x.indexOf(':');
      return { line: x.slice(0, i), station: x.slice(i + 1) };
    }));
  }
}

// Железнодорожные станции, платформы и вокзалы у станций метро
// (по официальной схеме). Парсить нечего — данные стабильны.
const RAIL_MAP = new Map([
  ['1:Девяткино', 'ж/д ст. Девяткино'],
  ['1:Площадь Ленина', 'Финляндский вокзал'],
  ['1:Площадь Восстания', 'Московский вокзал'],
  ['3:Маяковская', 'Московский вокзал'],
  ['1:Пушкинская', 'Витебский вокзал'],
  ['5:Звенигородская', 'Витебский вокзал'],
  ['1:Балтийская', 'Балтийский вокзал'],
  ['4:Ладожская', 'Ладожский вокзал'],
  ['2:Удельная', 'ж/д платформа Удельная'],
  ['5:Старая Деревня', 'ж/д ст. Старая Деревня'],
  ['2:Купчино', 'ж/д ст. Купчино'],
  ['3:Обухово', 'ж/д ст. Обухово'],
  ['3:Рыбацкое', 'ж/д ст. Рыбацкое'],
]);

// Автовокзалы и автостанции у станций метро (по официальной схеме).
const BUS_MAP = new Map([
  ['1:Девяткино', 'Северный автовокзал'],
  ['2:Парнас', 'Автостанция «Парнас»'],
  ['5:Обводный канал', 'Автовокзал «Санкт-Петербург»'],
]);

// Праздники с возможной круглосуточной работой метро.
// start: 'MM-DD' (ночь на следующий день) либо date: 'YYYY-MM-DD' для плавающих.
const ALLNIGHT_EVENTS = [
  { id: 'ny', name: 'Новый год', start: '12-31' },
  { id: 'xmas', name: 'Рождество Христово', start: '01-06' },
  { id: 'cityday', name: 'День города', start: '05-27' },
  { id: 'sails', name: 'Алые паруса', date: '2026-06-27' },
];

const TRANSFER_TEXT = 'Возможность пересадки между линиями гарантируется до 00:15. Фактически переход может оставаться открытым до прохода последнего поезда.';

/* ════════════════════════ Элементы ════════════════════════ */

const el = {
  list: document.getElementById('list'),
  minis: document.getElementById('minis'),
  foot: document.getElementById('foot'),
  topbar: document.getElementById('topbar'),
  lineFilter: document.getElementById('lineFilter'),
  search: document.getElementById('search'),
  searchClear: document.getElementById('searchClear'),
  clockTime: document.getElementById('clockTime'),
  clockParity: document.getElementById('clockParity'),
  updStatus: document.getElementById('updStatus'),
  toast: document.getElementById('toast'),
  tabs: document.getElementById('tabs'),
  stationsBar: document.getElementById('stationsBar'),
  routeBar: document.getElementById('routeBar'),
  routeView: document.getElementById('routeView'),
  routeItin: document.getElementById('routeItin'),
  mapScroll: document.getElementById('mapScroll'),
  pickFrom: document.getElementById('pickFrom'),
  pickTo: document.getElementById('pickTo'),
  fromVal: document.getElementById('fromVal'),
  toVal: document.getElementById('toVal'),
  swapBtn: document.getElementById('swapBtn'),
  routeClear: document.getElementById('routeClear'),
  segTime: document.getElementById('segTime'),
  xferTime: document.getElementById('xferTime'),
  picker: document.getElementById('picker'),
  pickerTitle: document.getElementById('pickerTitle'),
  pickerClose: document.getElementById('pickerClose'),
  pickerSearch: document.getElementById('pickerSearch'),
  pickerList: document.getElementById('pickerList'),
  zoomIn: document.getElementById('zoomIn'),
  zoomOut: document.getElementById('zoomOut'),
  zoomFit: document.getElementById('zoomFit'),
  themeColor: document.getElementById('themeColor'),
};

/* ════════════════════════ Состояние ════════════════════════ */

let DATA = null;
let activeLine = null;   // выбранная линия (всегда конкретная линия)
let query = '';          // строка поиска; пока не пуста — фильтр по линии игнорируется
let openKey = null;      // единственная раскрытая карточка (аккордеон)
let refreshing = false;
const stopIndex = new Map(); // key -> { line, stop, weekendLike }

/* ════════════════════════ Утилиты ════════════════════════ */

const norm = (s) => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const pad2 = (n) => String(n).padStart(2, '0');
const nowMinutes = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
const parityOf = (d = new Date()) => (d.getDate() % 2 === 1 ? 'odd' : 'even');
const parityLabel = (p) => (p === 'odd' ? 'нечётный день' : 'чётный день');
const displayName = (s) => s.replace(/\s+[12]$/, '');
const fwd = (t, now) => t == null ? null : (((t - now) % 1440) + 1440) % 1440; // минут вперёд до t

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Находится ли now внутри окна [start, end] (с переходом через полночь)?
function inWindow(now, start, end) {
  if (start == null || end == null) return null;
  let e = end; if (e < start) e += 1440;
  if (now >= start && now <= e) return true;
  if (now + 1440 >= start && now + 1440 <= e) return true;
  return false;
}

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

/* ════════════════════════ Иконки ════════════════════════ */

// Обёрточному <svg> обязательно нужен собственный viewBox: иначе у него нет
// внутренних пропорций и браузер задаёт ширину по умолчанию (~300px) — отсюда
// «разъезжавшиеся» пилюли и большие поля вокруг буквы «М».
const VB_ICON = '0 0 24 24';
const VB_LOGO = '0 -460000 20000400 16000000'; // выровнен по контуру эмблемы
const svgIco = (id, cls = '') => `<svg class="${cls}" viewBox="${VB_ICON}" aria-hidden="true"><use href="#${id}"/></svg>`;
const svgLogo = (cls = '') => `<svg class="${cls}" viewBox="${VB_LOGO}" aria-hidden="true"><use href="#metroM"/></svg>`;

// Значок линии «Мn»: логотип метро + номер на фоне цвета линии.
function mMark(color, label, extra = '') {
  return `<span class="mmark ${extra}" style="--c:${color}">${svgLogo('mmark__logo')}<span class="mmark__n">${esc(label)}</span></span>`;
}

/* ════════════════════════ Тема ════════════════════════ */

const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; } };
const resolvedTheme = (t = currentTheme()) => (t === 'light' || t === 'dark') ? t : (mqDark.matches ? 'dark' : 'light');
function applyTheme(t = currentTheme()) {
  document.documentElement.dataset.theme = t;
  if (el.themeColor) el.themeColor.setAttribute('content', resolvedTheme(t) === 'dark' ? '#06080b' : '#ffffff');
  document.querySelectorAll('.theme__btn').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.themeSet === t)));
}
function setTheme(t) { try { localStorage.setItem(THEME_KEY, t); } catch { /* */ } applyTheme(t); }
mqDark.addEventListener('change', () => { if (currentTheme() === 'system') applyTheme(); });

/* ════════════════════════ Загрузка данных ════════════════════════ */

async function init() {
  applyTheme();
  bindStaticEvents();
  tickClock();
  setInterval(tickClock, 10_000);
  setInterval(refreshLiveStatuses, 15_000);
  registerSW();

  const [snapshot, cached] = await Promise.all([loadSnapshot(), Promise.resolve(readCache())]);
  DATA = normalize(freshest(snapshot, cached));
  if (DATA) firstRender();
  await refreshLive(!DATA);
}

function firstRender() {
  if (activeLine == null) activeLine = DATA.lines[0]?.id || null;
  buildLineFilter();
  render();
  renderFoot();
  updTop();
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
    const d = raw && JSON.parse(raw);
    return validate(d) ? d : null;
  } catch { return null; }
}
function tsOf(d) { return Date.parse(d?.meta?.fetchedAt || d?.meta?.generatedAt || 0) || 0; }
function freshest(a, b) { return (a && b) ? (tsOf(b) >= tsOf(a) ? b : a) : (a || b || null); }
function validate(d) {
  if (!d || !Array.isArray(d.lines) || d.lines.length < 5) return false;
  return d.lines.reduce((n, l) => n + (l.stops?.length || 0), 0) >= 60;
}
function normalize(d) { // id линий — всегда строки
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
  el.list.setAttribute('aria-busy', String(!!coldStart));

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
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(DATA)); } catch { /* квота */ }

      if (activeLine == null) activeLine = DATA.lines[0]?.id || null;
      buildLineFilter(); render(); renderFoot();
      refreshing = false; updTop();
      el.list.setAttribute('aria-busy', 'false');
      if (!coldStart) toast('Расписание обновлено');
      return true;
    } catch { /* следующий прокси */ }
  }

  refreshing = false; updTop();
  el.list.setAttribute('aria-busy', 'false');
  if (!DATA) showError();
  else if (!coldStart) toast('Нет связи — данные из кэша');
  return false;
}

function showError() {
  el.list.innerHTML = `
    <div class="empty">
      <p>Не удалось загрузить расписание, сохранённой копии нет.</p>
      <p class="empty__hint">Проверьте подключение к интернету.</p>
      <button class="retry" id="retry">Повторить</button>
    </div>`;
  document.getElementById('retry')?.addEventListener('click', () => {
    el.list.innerHTML = '<div class="loader"><span class="loader__spin"></span><span class="loader__text">Загрузка расписания…</span></div>';
    refreshLive(true);
  });
}

/* ════════════════════════ Верхний статус ════════════════════════ */

function updTop() {
  if (!el.updStatus) return;
  if (refreshing) { el.updStatus.innerHTML = '<span class="updstatus__pulse"></span>Обновление…'; return; }
  const m = DATA?.meta || {};
  const iso = m.fetchedAt || m.generatedAt;
  el.updStatus.textContent = iso ? `Обновлено ${fmtWhen(iso)}` : '';
}

/* ════════════════════════ Фильтр линий ════════════════════════ */

function buildLineFilter() {
  el.lineFilter.innerHTML = '';
  for (const line of DATA.lines) {
    const b = document.createElement('button');
    b.className = 'chip'; b.type = 'button'; b.dataset.line = line.id;
    b.style.setProperty('--line', line.color);
    b.setAttribute('aria-label', `Линия ${line.id}`);
    // Пилюля целиком залита цветом линии: логотип + номер.
    b.innerHTML = `${svgLogo('chip__logo')}<span class="chip__n">${esc(line.id)}</span>`;
    b.addEventListener('click', () => selectLine(line.id));
    el.lineFilter.appendChild(b);
  }
  paintChips();
}
// Подсветка активной линии (если не идёт поиск).
function paintChips() {
  el.lineFilter.querySelectorAll('.chip').forEach((c) =>
    c.setAttribute('aria-pressed', String(!query && c.dataset.line === activeLine)));
}
function selectLine(id) {
  if (!DATA) return;
  const ids = DATA.lines.map((l) => l.id);
  if (id === activeLine && !query) return;       // та же линия и не идёт поиск — ничего не делаем
  const dir = ids.indexOf(id) >= ids.indexOf(activeLine) ? 'next' : 'prev';
  activeLine = id;
  if (query) { query = ''; el.search.value = ''; el.searchClear.hidden = true; }
  render();
  animateList(dir);                               // та же анимация, что и при свайпе
}

// Переход на предыдущую/следующую линию (свайпом). dir: 'next' | 'prev'.
// По краям списка линий — без перехода (без зацикливания).
function swipeLine(dir) {
  if (!DATA || !DATA.lines.length) return;
  const ids = DATA.lines.map((l) => l.id);
  let idx = ids.indexOf(activeLine);
  if (idx < 0) idx = 0;
  const next = dir === 'next' ? idx + 1 : idx - 1;
  if (next < 0 || next >= ids.length) return;
  openKey = null;            // не переносим раскрытую карточку на другую линию
  selectLine(ids[next]);     // selectLine сам проигрывает анимацию
  window.scrollTo({ top: 0, behavior: 'auto' });
}

// Короткая «въезжающая» анимация списка при смене линии.
function animateList(dir) {
  const cls = dir === 'next' ? 'list--next' : 'list--prev';
  el.list.classList.remove('list--next', 'list--prev');
  void el.list.offsetWidth;  // перезапуск анимации
  el.list.classList.add(cls);
  setTimeout(() => el.list.classList.remove(cls), 280);
}

/* ════════════════════════ Отрисовка списка ════════════════════════ */

function render() {
  if (!DATA) return;
  const now = nowMinutes();
  const par = parityOf();
  const hol = holidayToday();
  const weekendLike = isWeekend() || !!hol;
  const frag = document.createDocumentFragment();

  // Верхние объявления. Праздничные (круглосуточный режим) остаются сверху
  // даже свёрнутыми — только в компактном виде. Объявление про пересадки
  // при сворачивании уходит вниз (в #minis).
  for (const n of activeNotices()) {
    const collapsed = noticeCollapsed(n.id);
    if (n.kind === 'holiday') frag.appendChild(noticeCard(n, collapsed));
    else if (!collapsed) frag.appendChild(noticeCard(n, false));
  }

  let shown = 0;
  for (const line of DATA.lines) {
    // Во время поиска показываем совпадения по всем линиям; иначе — только активную.
    if (!query && line.id !== activeLine) continue;
    const stops = line.stops.filter(matches);
    if (!stops.length) continue;
    shown += stops.length;
    frag.appendChild(lineHead(line));
    for (const s of stops) frag.appendChild(stationCard(line, s, now, par, weekendLike));
  }

  el.list.innerHTML = '';
  el.list.appendChild(frag);
  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = query ? 'Ничего не найдено. Попробуйте другое название.' : 'Нет станций для отображения.';
    el.list.appendChild(empty);
  }
  paintChips();
  renderMinis();
}

function matches(stop) {
  if (!query) return true;
  if (norm(stop.station).includes(query)) return true;
  return stop.vestibules.some((v) => norm(v.name).includes(query));
}

/* ════════════════════════ Объявления (пересадки, праздники) ════════════════════════ */

const noticeCollapsed = (id) => { try { return localStorage.getItem(noticeKey(id)) === '1'; } catch { return false; } };
const setCollapsed = (id, v) => { try { v ? localStorage.setItem(noticeKey(id), '1') : localStorage.removeItem(noticeKey(id)); } catch { /* */ } };

function holidayToday(d = new Date()) {
  for (const ev of ALLNIGHT_EVENTS) {
    const dt = eventDate(ev, d.getFullYear());
    if (dt && dt.getMonth() === d.getMonth() && dt.getDate() === d.getDate()) return ev;
  }
  return null;
}
const isWeekend = (d = new Date()) => d.getDay() === 0 || d.getDay() === 6;

function eventDate(ev, year) {
  if (ev.date) { const [y, m, d] = ev.date.split('-').map(Number); return new Date(y, m - 1, d); }
  const [m, d] = ev.start.split('-').map(Number); return new Date(year, m - 1, d);
}

// Активные объявления: пересадки (всегда) + праздники в пределах недели до события.
function activeNotices() {
  const list = [{ id: 'transfer', kind: 'transfer', title: 'Пересадки открыты до 00:15', text: TRANSFER_TEXT }];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (const ev of ALLNIGHT_EVENTS) {
    const years = ev.date ? [Number(ev.date.slice(0, 4))] : [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
    for (const y of years) {
      const dt = eventDate(ev, y);
      const diffDays = Math.round((dt - today) / 86_400_000);
      if (diffDays >= -1 && diffDays <= 7) {
        list.push({
          id: `hol:${ev.id}:${y}`, kind: 'holiday', title: `${ev.name}: возможен круглосуточный режим`,
          text: `В ночь праздника метрополитен может работать круглосуточно. Возможны изменения — уточняйте на metro.spb.ru.`,
        });
      }
    }
  }
  return list;
}

function noticeCard(n, collapsed) {
  // Праздничное объявление — разворачивающаяся карточка: вся шапка кликабельна,
  // тело плавно открывается/закрывается, объявление всегда остаётся сверху.
  if (n.kind === 'holiday') {
    const d = document.createElement('div');
    d.className = 'notice notice--holiday notice--acc';
    const bodyHtml = esc(n.text).replace('metro.spb.ru', `<a href="${SITE_URL}" target="_blank" rel="noopener">metro.spb.ru</a>`);
    d.innerHTML = `
      <button class="notice__head" aria-expanded="${!collapsed}">
        <span class="notice__ico">${svgIco('icoClock', 'ico')}</span>
        <span class="notice__title">${esc(n.title)}</span>
        <span class="notice__chev" aria-hidden="true"></span>
      </button>
      <div class="notice__wrap"><div class="notice__in"><p class="notice__text">${bodyHtml}</p></div></div>`;
    const head = d.querySelector('.notice__head');
    const wrap = d.querySelector('.notice__wrap');
    if (!collapsed) wrap.classList.add('open');
    head.addEventListener('click', () => {
      const willOpen = !wrap.classList.contains('open');
      wrap.classList.toggle('open', willOpen);
      head.setAttribute('aria-expanded', String(willOpen));
      setCollapsed(n.id, !willOpen); // запоминаем состояние
    });
    return d;
  }
  // Свёрнутое объявление про пересадки — компактная полоса.
  if (collapsed) {
    const b = document.createElement('button');
    b.className = 'notice notice--mini';
    b.innerHTML = `<span class="tmini__i">i</span>
      <span class="notice__minititle">${esc(n.title)}</span>
      <span class="notice__more" aria-hidden="true"></span>`;
    b.setAttribute('aria-label', `${n.title} — развернуть`);
    b.addEventListener('click', () => { setCollapsed(n.id, false); render(); });
    return b;
  }
  // Полная карточка пересадок с кнопкой «свернуть».
  const d = document.createElement('div');
  d.className = 'notice';
  d.innerHTML = `
    <div class="notice__body">
      <div class="notice__title">${esc(n.title)}</div>
      <p class="notice__text">${esc(n.text)}</p>
    </div>
    <button class="notice__x" aria-label="Свернуть">×</button>`;
  d.querySelector('.notice__x').addEventListener('click', () => { setCollapsed(n.id, true); render(); });
  return d;
}

// Свёрнутые объявления — компактные кнопки внизу (полностью не исчезают).
function renderMinis() {
  el.minis.innerHTML = '';
  for (const n of activeNotices()) {
    // Праздничные объявления остаются сверху даже свёрнутыми — вниз не уходят.
    if (n.kind === 'holiday') continue;
    if (!noticeCollapsed(n.id)) continue;
    const b = document.createElement('button');
    b.className = 'tmini';
    b.innerHTML = `<span class="tmini__i">i</span><span>${esc(n.title)}</span>`;
    b.addEventListener('click', () => { setCollapsed(n.id, false); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    el.minis.appendChild(b);
  }
}

/* ════════════════════════ Заголовок линии ════════════════════════ */

function lineHead(line) {
  const wrap = document.createElement('div');
  wrap.className = 'line-head';
  const t = line.termini || [];
  wrap.innerHTML = `
    ${mMark(line.color, line.id, 'mmark--lg')}
    <span class="line-head__text">
      <span class="line-head__name">${esc(line.title || line.name)}</span>
      ${t.length >= 2 ? `<span class="line-head__dir">${esc(t[0])} ${svgIco('icoArrowLR', 'arr')} ${esc(t[t.length - 1])}</span>` : ''}
    </span>`;
  return wrap;
}

/* ════════════════════════ Карточка станции ════════════════════════ */

function stationCard(line, stop, now, par, weekendLike) {
  const key = `${line.id}:${stop.station}`;
  stopIndex.set(key, { line, stop, weekendLike });
  const isOpen = key === openKey;

  const card = document.createElement('article');
  card.className = 'stn' + (stop.closed ? ' stn--closed' : '');
  card.dataset.key = key;
  card.style.setProperty('--line', line.color);

  // Пересадки, вокзалы и автовокзалы под названием станции.
  const xfers = XFER_MAP.get(key) || [];
  const rail = RAIL_MAP.get(key);
  const bus = BUS_MAP.get(key);
  const xferHtml = xfers.map((x) => {
    const c = (DATA.lines.find((l) => l.id === x.line) || {}).color || 'var(--muted)';
    return `<button class="xfer" data-go="${esc(x.line)}:${esc(x.station)}" style="--line:${c}"><span class="xfer__badge">${svgLogo('xfer__logo')}<span class="xfer__n">${esc(x.line)}</span></span><span class="xfer__dot" aria-hidden="true">·</span><span class="xfer__name">${esc(displayName(x.station))}</span></button>`;
  }).join('');
  const railHtml = rail ? `<span class="conn"><span class="msym conn__ico" aria-hidden="true">train</span>${esc(rail)}</span>` : '';
  const busHtml = bus ? `<span class="conn"><span class="msym conn__ico" aria-hidden="true">directions_bus</span>${esc(bus)}</span>` : '';
  const chipsHtml = (xfers.length || rail || bus)
    ? `<div class="stn__links">${xferHtml}${railHtml}${busHtml}</div>` : '';

  card.innerHTML = `
    <div class="stn__top">
      <button class="stn__toggle" aria-expanded="${isOpen}">
        <span class="stn__name">${esc(stop.station)}</span>
        <span class="stn__status">${stop.closed ? '<span class="pill pill--shut">закрыта</span>' : statusPill(stop, now, weekendLike)}</span>
        <span class="stn__chev" aria-hidden="true"></span>
      </button>
      ${chipsHtml}
    </div>
    <div class="stn__wrap${isOpen ? ' open' : ''}"><div class="stn__body"></div></div>`;

  const body = card.querySelector('.stn__body');
  if (isOpen) { card.classList.add('stn--open'); body.appendChild(stationBody(stop, now, par, weekendLike)); }
  // Вся карточка кликабельна для раскрытия; клики по кнопкам пересадок и ссылкам
  // не сворачивают карточку.
  if (!stop.closed) {
    card.addEventListener('click', (e) => {
      // Пересадки и ссылки — своя логика; клики внутри раскрытого тела не сворачивают.
      if (e.target.closest('.xfer') || e.target.closest('a') || e.target.closest('.stn__wrap')) return;
      toggleCard(key);
    });
  }
  return card;
}

// Аккордеон: открыта максимум одна карточка. Тело раскрывается/сворачивается
// плавно через grid-template-rows (0fr → 1fr).
function toggleCard(key) {
  if (openKey === key) { collapseDom(key); openKey = null; return; }
  if (openKey) collapseDom(openKey);
  openKey = key;
  expandDom(key);
}
const cardByKey = (key) => [...el.list.querySelectorAll('.stn')].find((c) => c.dataset.key === key) || null;
function collapseDom(key) {
  const c = cardByKey(key); if (!c) return;
  c.classList.remove('stn--open');
  c.querySelector('.stn__toggle').setAttribute('aria-expanded', 'false');
  const wrap = c.querySelector('.stn__wrap');
  const b = c.querySelector('.stn__body');
  wrap.classList.remove('open');
  // Контент убираем после анимации (если карточку снова не открыли).
  clearTimeout(c._clr);
  c._clr = setTimeout(() => { if (!wrap.classList.contains('open')) b.innerHTML = ''; }, 300);
}
function expandDom(key) {
  const c = cardByKey(key); if (!c) return;
  const rec = stopIndex.get(key); if (!rec) return;
  clearTimeout(c._clr);
  c.classList.add('stn--open');
  c.querySelector('.stn__toggle').setAttribute('aria-expanded', 'true');
  const wrap = c.querySelector('.stn__wrap');
  const b = c.querySelector('.stn__body');
  b.innerHTML = ''; b.appendChild(stationBody(rec.stop, nowMinutes(), parityOf(), rec.weekendLike));
  requestAnimationFrame(() => wrap.classList.add('open'));
}

// Статус входа на станцию по всем вестибюлям:
//  • «вход открыт»   — открыты все действующие вестибюли;
//  • «вход ограничен» — часть вестибюлей уже закрыта, но станция ещё работает;
//  • «скоро закрытие» — до закрытия ПОСЛЕДНЕГО входа ≤ 30 мин;
//  • «скоро открытие» — до открытия входа ≤ 60 мин;
//  • «вход закрыт»    — открытых вестибюлей нет.
function statusPill(stop, now, weekendLike) {
  let openCount = 0, total = 0, lastClose = -Infinity, nextOpen = Infinity;
  for (const v of stop.vestibules || []) {
    const o = timeToMinutes(v.open?.[0]);
    const c = timeToMinutes(v.closeIn);
    if (o == null || c == null) continue;
    // Вестибюль, закрытый по выходным/праздникам, в этот день не учитываем.
    if (weekendLike && (v.notes || []).some((n) => /выходн|праздни/i.test(n))) continue;
    total++;
    if (inWindow(now, o, c)) { openCount++; lastClose = Math.max(lastClose, fwd(c, now)); }
    else nextOpen = Math.min(nextOpen, fwd(o, now));
  }
  if (total === 0) return '<span class="pill pill--shut">вход закрыт</span>';
  if (openCount > 0) {
    if (lastClose <= ENTRY_CLOSE_SOON) return '<span class="pill pill--soon">скоро закрытие</span>';
    if (openCount < total) return '<span class="pill pill--limited">вход ограничен</span>';
    return '<span class="pill pill--open">вход открыт</span>';
  }
  if (nextOpen <= ENTRY_SOON) return '<span class="pill pill--soon">скоро открытие</span>';
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
  d.className = 'sect-label'; d.textContent = text; return d;
}

// Статус по направлению: отсчёт до первого/последнего поезда + уровень (цвет).
// Последний поезд: ≤1 мин — «поезд уходит», ушёл — «поезд ушёл» (красный);
//   <30 мин — жёлтый, иначе зелёный.
// Первый поезд (станция закрыта): <30 мин — зелёный, иначе жёлтый.
function dirStatus(d, now, par) {
  const firstStr = par === 'odd' ? (d.first?.odd || d.first?.even) : (d.first?.even || d.first?.odd);
  const firstM = timeToMinutes(firstStr);
  const lastM = timeToMinutes(d.last?.value);
  if (firstM == null && lastM == null) return null;

  const closedNight = lastM != null && firstM != null && lastM < firstM && now >= lastM && now < firstM;
  if (closedNight) {
    if (now < NIGHT_GONE) return { lvl: 'gone', text: 'поезд ушёл' };
    const tf = firstM - now;
    return { lvl: tf < SOON_MARK ? 'ok' : 'soon', text: `до первого ${tf} мин` };
  }
  if (lastM != null) {
    const tl = fwd(lastM, now);
    if (tl <= 1) return { lvl: 'gone', text: 'поезд уходит' };
    if (tl <= SOON_WINDOW) return { lvl: tl < SOON_MARK ? 'soon' : 'ok', text: `последний через ${tl} мин` };
    return { lvl: 'ok', text: 'поезда ходят' };
  }
  const tf = fwd(firstM, now);
  return { lvl: tf < SOON_MARK ? 'ok' : 'soon', text: `до первого ${tf} мин` };
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
    const rows = [`<div class="dir__head"><span class="dir__to">${svgIco('icoArrowR', 'arr')} ${esc(d.to)}</span>${status}</div>`];

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
const timeRow = (lbl, valHtml) =>
  `<div class="dir__row"><span class="dir__lbl">${esc(lbl)}</span><span class="dir__vals">${valHtml}</span></div>`;

function vestRow(v, now, weekendLike) {
  const row = document.createElement('div');
  row.className = 'vt';
  const openTimes = (v.open && v.open.length) ? v.open.join(' / ') : '—';
  const o = timeToMinutes(v.open?.[0]);
  const cIn = timeToMinutes(v.closeIn);
  const weekendClosed = weekendLike && (v.notes || []).some((n) => /выходн|праздни/i.test(n));
  const st = weekendClosed ? false : inWindow(now, o, cIn);
  const dot = st === true ? 'vt__dot--open' : (st === null ? 'vt__dot--unk' : 'vt__dot--shut');
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

// Периодическое обновление «живых» статусов без полной перерисовки.
function refreshLiveStatuses() {
  if (!DATA) return;
  const now = nowMinutes(), par = parityOf();
  for (const card of el.list.querySelectorAll('.stn')) {
    const rec = stopIndex.get(card.dataset.key);
    if (!rec || rec.stop.closed) continue;
    const st = card.querySelector('.stn__status');
    if (st) st.innerHTML = statusPill(rec.stop, now, rec.weekendLike);
    const wrap = card.querySelector('.stn__wrap');
    const body = card.querySelector('.stn__body');
    if (wrap && wrap.className.includes('open') && body) { body.innerHTML = ''; body.appendChild(stationBody(rec.stop, now, par, rec.weekendLike)); }
  }
}

/* ════════════════════════ Переход по пересадке ════════════════════════ */

function navigateTo(line, station) {
  const key = `${line}:${station}`;
  activeLine = line;
  query = ''; el.search.value = ''; el.searchClear.hidden = true;
  openKey = key;
  render();
  // Прокручиваем так, чтобы карточка целиком оказалась под «липкой» шапкой.
  requestAnimationFrame(() => {
    const card = cardByKey(key);
    if (!card) return;
    const top = card.getBoundingClientRect().top + window.scrollY - el.topbar.offsetHeight - 10;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1400);
  });
}

/* ════════════════════════ Подвал и часы ════════════════════════ */

function renderFoot() {
  const m = DATA?.meta || {};
  el.foot.innerHTML = `
    <p class="foot__date">${m.scheduleDate ? `Расписание действует ${esc(m.scheduleDate)}. ` : ''}<a href="${SOURCE_URL}" target="_blank" rel="noopener">Официальный источник</a></p>
    <p class="foot__meta">Неофициальное приложение, данные могут отличаться от актуальных.</p>`;
}
function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} в ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function tickClock() {
  const d = new Date();
  el.clockTime.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  el.clockParity.textContent = parityLabel(parityOf(d));
}

/* ════════════════════════ События ════════════════════════ */

function bindStaticEvents() {
  el.search.addEventListener('input', () => {
    query = norm(el.search.value);
    el.searchClear.hidden = !el.search.value;
    render();
  });
  el.searchClear.addEventListener('click', () => {
    el.search.value = ''; query = ''; el.searchClear.hidden = true; render(); el.search.focus();
  });
  // Делегирование клика по кнопке пересадки.
  el.list.addEventListener('click', (e) => {
    const go = e.target.closest?.('[data-go]');
    if (go) { const [l, ...s] = go.dataset.go.split(':'); navigateTo(l, s.join(':')); }
  });
  document.querySelectorAll('.theme__btn').forEach((b) =>
    b.addEventListener('click', () => setTheme(b.dataset.themeSet)));

  bindSwipe();
  bindRoute();
}

// Горизонтальный свайп по списку: влево — следующая линия, вправо — предыдущая.
function bindSwipe() {
  let x0 = 0, y0 = 0, t0 = 0, active = false, lock = null; // lock: 'h' | 'v' | null
  const area = el.list;
  area.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { active = false; return; }
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); active = true; lock = null;
  }, { passive: true });
  // Не пассивный: как только жест опознан как горизонтальный — гасим нативную
  // прокрутку/«оттягивание» страницы, чтобы не было рывка перед сменой линии.
  area.addEventListener('touchmove', (e) => {
    if (!active) return;
    const t = e.touches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    if (lock === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      lock = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
    }
    if (lock === 'h' && e.cancelable) e.preventDefault();
  }, { passive: false });
  area.addEventListener('touchend', (e) => {
    if (!active) return; active = false;
    if (lock !== 'h') return;                    // только горизонтальный жест
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dt = Date.now() - t0;
    if (Math.abs(dx) < 50 || dt > 800) return;   // достаточно длинный и быстрый
    swipeLine(dx < 0 ? 'next' : 'prev');
  }, { passive: true });
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}



/* ════════════════════════ Вкладка «Маршрут»: карта + навигатор ════════════════════════ */

// Координаты станций на схеме (user-units виртуального полотна ~980×1230).
const MAP_POS = { "1:Проспект Ветеранов":[130,1075], "1:Ленинский проспект":[164,1019], "1:Автово":[198,964], "1:Кировский завод":[232,908], "1:Нарвская":[288,845], "1:Балтийская":[344,783], "1:Технологический институт 1":[400,720], "1:Пушкинская":[455,668], "1:Владимирская":[492,612], "1:Площадь Восстания":[522,558], "1:Чернышевская":[541,505], "1:Площадь Ленина":[560,452], "1:Выборгская":[569,401], "1:Лесная":[579,349], "1:Площадь Мужества":[588,298], "1:Политехническая":[597,246], "1:Академическая":[606,195], "1:Гражданский проспект":[616,143], "1:Девяткино":[625,92], "2:Купчино":[360,1095], "2:Звездная":[360,1043], "2:Московская":[360,991], "2:Парк Победы":[360,939], "2:Электросила":[360,886], "2:Московские ворота":[360,834], "2:Фрунзенская":[360,782], "2:Технологический институт 2":[360,730], "2:Сенная площадь":[360,650], "2:Невский проспект":[360,560], "2:Горьковская":[360,502], "2:Петроградская":[360,443], "2:Черная речка":[360,384], "2:Пионерская":[360,326], "2:Удельная":[360,268], "2:Озерки":[360,209], "2:Проспект Просвещения":[360,150], "2:Парнас":[360,92], "3:Беговая":[78,470], "3:Зенит":[135,499], "3:Приморская":[193,529], "3:Василеостровская":[250,558], "3:Гостиный двор":[385,560], "3:Маяковская":[545,560], "3:Площадь Александра Невского 1":[758,642], "3:Елизаровская":[781,704], "3:Ломоносовская":[805,766], "3:Пролетарская":[828,828], "3:Обухово":[852,890], "3:Рыбацкое":[875,952], "4:Улица Дыбенко":[905,415], "4:Проспект Большевиков":[869,478], "4:Ладожская":[832,542], "4:Новочеркасская":[796,605], "4:Площадь Александра Невского 2":[760,668], "4:Лиговский проспект":[620,648], "4:Достоевская":[495,636], "4:Спасская":[402,672], "4:Горный институт":[180,642], "5:Шушары":[748,1148], "5:Дунайская":[709,1086], "5:Проспект Славы":[671,1023], "5:Международная":[632,961], "5:Бухарестская":[594,899], "5:Волковская":[555,837], "5:Обводный канал":[517,774], "5:Звенигородская":[478,712], "5:Садовая":[418,652], "5:Адмиралтейская":[348,580], "5:Спортивная":[300,470], "5:Чкаловская":[262,407], "5:Крестовский остров":[225,344], "5:Старая Деревня":[188,281], "5:Комендантский проспект":[150,218], "6:Юго-Западная":[180,988], "6:Путиловская":[236,934] };
const MAP_VB = [0, 0, 980, 1230];

// Состояние маршрута
let routeBuilt = false;
let fromPlace = null, toPlace = null;
let pickerTarget = 'from';
let mapZoom = 1;

const lineById = (id) => DATA.lines.find((l) => String(l.id) === String(id));
// «Место» = отображаемое имя станции; у пересадок ему соответствуют 2 узла.
function placeNodes() {
  const m = new Map(); // displayName -> [{line, station, key}]
  for (const l of DATA.lines) for (const s of l.stops) {
    const dn = displayName(s.station);
    const arr = m.get(dn) || []; arr.push({ line: l.id, station: s.station, key: `${l.id}:${s.station}` });
    m.set(dn, arr);
  }
  return m;
}
const PLACES = () => placeNodes();

// Граф: рёбра-перегоны (segTime) и пересадки (xferTime).
function buildGraph(segTime, xferTime) {
  const g = new Map(); // key -> [{to, w, kind}]
  const add = (a, b, w, kind) => { (g.get(a) || g.set(a, []).get(a)).push({ to: b, w, kind }); };
  for (const l of DATA.lines) {
    for (let i = 0; i < l.stops.length - 1; i++) {
      const a = `${l.id}:${l.stops[i].station}`, b = `${l.id}:${l.stops[i + 1].station}`;
      add(a, b, segTime, 'ride'); add(b, a, segTime, 'ride');
    }
  }
  for (const hub of INTERCHANGES) {
    for (let i = 0; i < hub.length; i++) for (let j = i + 1; j < hub.length; j++) {
      add(hub[i], hub[j], xferTime, 'xfer'); add(hub[j], hub[i], xferTime, 'xfer');
    }
  }
  return g;
}

// Дейкстра от множества стартовых узлов до множества целевых.
function dijkstra(graph, sources, targets) {
  const dist = new Map(), prev = new Map();
  const pq = []; // простая приоритетная очередь (массив + сортировка вставкой)
  const push = (k, d) => { dist.set(k, d); let i = pq.length; pq.push({ k, d }); while (i > 0 && pq[i - 1].d > pq[i].d) { [pq[i - 1], pq[i]] = [pq[i], pq[i - 1]]; i--; } };
  for (const s of sources) push(s, 0);
  const targetSet = new Set(targets);
  const done = new Set();
  while (pq.length) {
    const { k, d } = pq.shift();
    if (done.has(k)) continue; done.add(k);
    if (d > (dist.get(k) ?? Infinity)) continue;
    if (targetSet.has(k)) return reconstruct(prev, k, d);
    for (const e of graph.get(k) || []) {
      const nd = d + e.w;
      if (nd < (dist.get(e.to) ?? Infinity)) { prev.set(e.to, { from: k, kind: e.kind, w: e.w }); push(e.to, nd); }
    }
  }
  return null;
}
function reconstruct(prev, end, total) {
  const nodes = [end]; const edges = [];
  let cur = end;
  while (prev.has(cur)) { const p = prev.get(cur); edges.unshift({ from: p.from, to: cur, kind: p.kind, w: p.w }); nodes.unshift(p.from); cur = p.from; }
  return { nodes, edges, total };
}

// Построить маршрут между выбранными местами.
function computeRoute() {
  if (!fromPlace || !toPlace || fromPlace === toPlace) { renderItinerary(null); drawRoute(null); return; }
  const seg = clampTime(el.segTime.value), xfer = clampTime(el.xferTime.value);
  const places = PLACES();
  const sources = (places.get(fromPlace) || []).map((n) => n.key);
  const targets = (places.get(toPlace) || []).map((n) => n.key);
  if (!sources.length || !targets.length) return;
  const graph = buildGraph(seg, xfer);
  const res = dijkstra(graph, sources, targets);
  renderItinerary(res ? { ...res, seg, xfer } : null);
  drawRoute(res);
}
const clampTime = (v) => Math.min(20, Math.max(1, parseInt(v, 10) || 3));

/* ── Карта (SVG) ── */

function buildMap() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const parts = [`<svg id="metroMap" viewBox="${MAP_VB.join(' ')}" xmlns="${svgNS}" role="img" aria-label="Схема метро">`];
  // линии (полилинии)
  for (const l of DATA.lines) {
    const pts = l.stops.map((s) => MAP_POS[`${l.id}:${s.station}`]).filter(Boolean);
    if (pts.length < 2) continue;
    const dpath = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
    parts.push(`<path class="ml" data-line="${l.id}" d="${dpath}" fill="none" stroke="${l.color}" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  // пересадочные связки
  for (const hub of INTERCHANGES) {
    for (let i = 0; i < hub.length; i++) for (let j = i + 1; j < hub.length; j++) {
      const a = MAP_POS[hub[i]], b = MAP_POS[hub[j]];
      if (a && b) parts.push(`<line class="mx" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke-width="5" stroke-linecap="round"/>`);
    }
  }
  // слой подсветки маршрута (заполняется в drawRoute)
  parts.push('<g class="route-overlay" id="routeOverlay"></g>');
  // станции (кружки) + хит-зоны
  for (const l of DATA.lines) for (const s of l.stops) {
    const p = MAP_POS[`${l.id}:${s.station}`]; if (!p) continue;
    const dn = displayName(s.station);
    parts.push(`<g class="mst" data-key="${esc(l.id + ':' + s.station)}" data-place="${esc(dn)}">`
      + `<circle class="mst__hit" cx="${p[0]}" cy="${p[1]}" r="15"/>`
      + `<circle class="mst__dot" cx="${p[0]}" cy="${p[1]}" r="5.5" stroke="${l.color}"/>`
      + `</g>`);
  }
  // подписи — только пересадки и конечные (чтобы не было каши)
  for (const lbl of MAP_LABELS()) {
    parts.push(`<text class="mlbl" x="${lbl.x}" y="${lbl.y}" text-anchor="${lbl.anchor}">${esc(lbl.text)}</text>`);
  }
  parts.push('</svg>');
  el.mapScroll.innerHTML = parts.join('');
  // обработчик кликов по станциям
  el.mapScroll.querySelectorAll('.mst').forEach((g) =>
    g.addEventListener('click', () => onMapStation(g.dataset.place)));
  applyZoom();
}

// Подписи: конечные станции каждой линии + пересадочные узлы.
function MAP_LABELS() {
  const out = []; const seen = new Set();
  const put = (key, text, dx = 9, anchor = 'start') => {
    const p = MAP_POS[key]; if (!p) return;
    out.push({ x: p[0] + dx, y: p[1] + 4, text, anchor });
  };
  for (const l of DATA.lines) {
    const first = l.stops[0], last = l.stops[l.stops.length - 1];
    put(`${l.id}:${first.station}`, displayName(first.station));
    put(`${l.id}:${last.station}`, displayName(last.station));
  }
  for (const hub of INTERCHANGES) {
    // одна подпись на узел (по первому элементу), правее
    const k = hub[0]; const dn = displayName(k.slice(k.indexOf(':') + 1));
    if (seen.has(dn)) continue; seen.add(dn);
    put(k, dn, 11);
  }
  return out;
}

function onMapStation(place) {
  if (!fromPlace) { setPlace('from', place); }
  else if (!toPlace) { if (place !== fromPlace) setPlace('to', place); }
  else { setPlace('from', place); setPlace('to', null); }
}
function setPlace(which, place) {
  if (which === 'from') { fromPlace = place; el.fromVal.textContent = place || 'выберите станцию'; el.fromVal.classList.toggle('set', !!place); }
  else { toPlace = place; el.toVal.textContent = place || 'выберите станцию'; el.toVal.classList.toggle('set', !!place); }
  computeRoute();
}

// Подсветить маршрут на карте: цветной оверлей по сегментам + станции.
function drawRoute(res) {
  const svg = el.mapScroll.querySelector('#metroMap'); if (!svg) return;
  const ov = svg.querySelector('#routeOverlay');
  while (ov.firstChild) ov.removeChild(ov.firstChild);
  svg.classList.toggle('has-route', !!res);
  const used = new Set(res ? res.nodes : []);
  const eps = res ? new Set([res.nodes[0], res.nodes[res.nodes.length - 1]]) : new Set();
  svg.querySelectorAll('.mst').forEach((g) => {
    g.classList.toggle('on', used.has(g.dataset.key));
    g.classList.toggle('ep', eps.has(g.dataset.key));
  });
  if (!res) return;
  const ns = 'http://www.w3.org/2000/svg';
  for (const e of res.edges) {
    const a = MAP_POS[e.from], b = MAP_POS[e.to]; if (!a || !b) continue;
    const ln = e.from.slice(0, e.from.indexOf(':'));
    const col = e.kind === 'ride' ? ((lineById(ln) || {}).color || '#888') : 'var(--muted)';
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', a[0]); line.setAttribute('y1', a[1]);
    line.setAttribute('x2', b[0]); line.setAttribute('y2', b[1]);
    line.setAttribute('stroke', col); line.setAttribute('stroke-width', '9');
    line.setAttribute('stroke-linecap', 'round');
    if (e.kind === 'xfer') line.setAttribute('stroke-dasharray', '1 9');
    ov.appendChild(line);
  }
}

/* ── Маршрутный лист ── */

function renderItinerary(res) {
  if (!res) {
    el.routeItin.innerHTML = (fromPlace && toPlace && fromPlace === toPlace)
      ? '<div class="ri-empty">Откуда и куда совпадают.</div>'
      : '<div class="ri-empty">Выберите станции отправления и назначения — на карте или кнопками выше.</div>';
    return;
  }
  // Сгруппировать по линиям (поездки) с учётом пересадок.
  const legs = []; // {line, stations:[names], }
  let cur = null;
  const nodeLine = (k) => k.slice(0, k.indexOf(':'));
  const nodeStation = (k) => k.slice(k.indexOf(':') + 1);
  res.nodes.forEach((k, i) => {
    const ln = nodeLine(k);
    const edge = i > 0 ? res.edges[i - 1] : null;
    if (edge && edge.kind === 'xfer') { cur = null; } // пересадка — новый сегмент
    if (!cur || cur.line !== ln) { cur = { line: ln, stations: [] }; legs.push(cur); }
    cur.stations.push(nodeStation(k));
  });
  let rides = 0, xfers = 0;
  for (const e of res.edges) { if (e.kind === 'ride') rides++; else xfers++; }

  const head = `<div class="ri-sum"><span class="ri-time">${res.total} мин</span>`
    + `<span class="ri-meta">${rides} ${plural(rides, 'перегон', 'перегона', 'перегонов')} · ${xfers} ${plural(xfers, 'пересадка', 'пересадки', 'пересадок')}</span></div>`;

  const steps = [];
  legs.forEach((leg, i) => {
    const l = lineById(leg.line) || {};
    const a = displayName(leg.stations[0]), b = displayName(leg.stations[leg.stations.length - 1]);
    const n = leg.stations.length - 1;
    if (i > 0) steps.push(`<div class="ri-xfer">${svgIco('icoArrowR', 'ri-arr')} Пересадка на ${mMarkInline(l)} <b>${esc(l.title || l.name)}</b></div>`);
    steps.push(`<div class="ri-leg" style="--line:${l.color}">`
      + `<div class="ri-leg__bar"></div>`
      + `<div class="ri-leg__body"><div class="ri-leg__line">${mMarkInline(l)} <span>${esc(l.title || l.name)}</span></div>`
      + `<div class="ri-leg__from">${esc(a)}</div>`
      + `<div class="ri-leg__ride">${n} ${plural(n, 'перегон', 'перегона', 'перегонов')}</div>`
      + `<div class="ri-leg__to">${esc(b)}</div></div></div>`);
  });
  el.routeItin.innerHTML = head + '<div class="ri-steps">' + steps.join('') + '</div>';
}
function mMarkInline(l) {
  return `<span class="ri-badge" style="--c:${l.color}">${svgLogo('ri-badge__logo')}<span>${esc(l.id)}</span></span>`;
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/* ── Зум ── */

function applyZoom() {
  const svg = el.mapScroll.querySelector('#metroMap'); if (!svg) return;
  const w = MAP_VB[2] * mapZoom, h = MAP_VB[3] * mapZoom;
  svg.style.width = w + 'px'; svg.style.height = h + 'px';
}
function setZoom(z) { mapZoom = Math.min(2.4, Math.max(0.5, z)); applyZoom(); }

/* ── Выбор станции (модалка) ── */

function openPicker(which) {
  pickerTarget = which;
  el.pickerTitle.textContent = which === 'from' ? 'Откуда' : 'Куда';
  el.picker.hidden = false;
  el.pickerSearch.value = ''; fillPicker('');
  setTimeout(() => el.pickerSearch.focus(), 30);
}
function closePicker() { el.picker.hidden = true; }
function fillPicker(q) {
  const nq = norm(q);
  const places = [...PLACES().entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'));
  const rows = [];
  for (const [name, nodes] of places) {
    if (nq && !norm(name).includes(nq)) continue;
    const badges = nodes.map((n) => { const l = lineById(n.line) || {}; return `<span class="pk-badge" style="background:${l.color}">${esc(n.line)}</span>`; }).join('');
    rows.push(`<button class="pk-row" data-place="${esc(name)}">${badges}<span class="pk-name">${esc(name)}</span></button>`);
  }
  el.pickerList.innerHTML = rows.join('') || '<div class="pk-empty">Не найдено</div>';
  el.pickerList.querySelectorAll('.pk-row').forEach((r) =>
    r.addEventListener('click', () => { setPlace(pickerTarget, r.dataset.place); closePicker(); }));
}

/* ── Вкладки ── */

function showTab(tab) {
  const route = tab === 'route';
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
  el.stationsBar.hidden = route; el.routeBar.hidden = !route;
  el.list.hidden = route; el.minis.hidden = route; el.foot.hidden = route;
  el.routeView.hidden = !route;
  if (route && !routeBuilt) { buildMap(); routeBuilt = true; setZoom(fitZoom()); }
}
function fitZoom() {
  const cw = el.mapScroll.clientWidth || 360;
  return Math.max(0.6, Math.min(1.4, cw / MAP_VB[2] * 1.55));
}

function bindRoute() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  el.pickFrom.addEventListener('click', () => openPicker('from'));
  el.pickTo.addEventListener('click', () => openPicker('to'));
  el.swapBtn.addEventListener('click', () => { const f = fromPlace, t = toPlace; setPlace('from', t); setPlace('to', f); });
  el.routeClear.addEventListener('click', () => { setPlace('from', null); setPlace('to', null); });
  el.segTime.addEventListener('input', computeRoute);
  el.xferTime.addEventListener('input', computeRoute);
  el.pickerClose.addEventListener('click', closePicker);
  el.picker.addEventListener('click', (e) => { if (e.target === el.picker) closePicker(); });
  el.pickerSearch.addEventListener('input', () => fillPicker(el.pickerSearch.value));
  el.zoomIn.addEventListener('click', () => setZoom(mapZoom * 1.25));
  el.zoomOut.addEventListener('click', () => setZoom(mapZoom / 1.25));
  el.zoomFit.addEventListener('click', () => setZoom(fitZoom()));
}


init();
