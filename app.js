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
}

// Горизонтальный свайп по списку: влево — следующая линия, вправо — предыдущая.
function bindSwipe() {
  let x0 = 0, y0 = 0, t0 = 0, active = false;
  const area = el.list;
  area.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { active = false; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); active = true;
  }, { passive: true });
  area.addEventListener('touchend', (e) => {
    if (!active) return; active = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
    // Свайп: достаточно длинный, преимущественно горизонтальный и быстрый.
    if (Math.abs(dx) < 55) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.7) return;
    if (dt > 800) return;
    swipeLine(dx < 0 ? 'next' : 'prev');
  }, { passive: true });
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

init();
