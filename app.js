// app.js — логика приложения «Метро СПб · режим станций».
//
// Данные НЕ хранятся на сервере: при запуске приложение всегда пытается
// скачать официальную страницу расписания и распарсить её прямо в браузере
// тем же parser.js. Успешный результат кэшируется в localStorage и
// используется при следующих запусках и при проблемах с сетью.

import { parseSchedule, timeToMinutes } from './parser.js';

// ───────────────────────────── константы ─────────────────────────────
const SOURCE_URL = 'https://metro.spb.ru/rejimrabotystancii.html';
const CACHE_KEY = 'metro-spb:data';
const THEME_KEY = 'metro-spb:theme';
const SOON_WINDOW = 90; // мин: за сколько до последнего поезда показывать отсчёт
const OPEN_SOON = 30;   // мин: «скоро закрытие входа»
const FETCH_TIMEOUT = 12000;

// CORS-прокси (бесплатные, без токенов). Пробуем по очереди.
const PROXIES = [
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
  (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
  (u) => u, // прямой запрос — на случай, если когда-нибудь появится CORS
  (u) => `https://functions.yandexcloud.net/d4ef7klnnbct2qi474q6`,
];

// ───────────────────────────── элементы ──────────────────────────────
const el = {
  list: document.getElementById('list'),
  foot: document.getElementById('foot'),
  lineFilter: document.getElementById('lineFilter'),
  search: document.getElementById('search'),
  searchClear: document.getElementById('searchClear'),
  clockTime: document.getElementById('clockTime'),
  clockParity: document.getElementById('clockParity'),
  toast: document.getElementById('toast'),
  themeColor: document.getElementById('themeColor'),
};

// ───────────────────────────── состояние ─────────────────────────────
let DATA = null;
let activeLine = 'all';
let query = '';
let refreshing = false;
const expanded = new Set();
const stopIndex = new Map(); // key -> { line, stop }

// ───────────────────────────── утилиты ───────────────────────────────
const norm = (s) => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const pad2 = (n) => String(n).padStart(2, '0');
const nowMinutes = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
const parityOf = (d = new Date()) => (d.getDate() % 2 === 1 ? 'odd' : 'even');
const parityLabel = (p) => (p === 'odd' ? 'нечётный день' : 'чётный день');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Окно [start, end] с переходом через полночь. null — данных нет.
function inWindow(now, start, end) {
  if (start == null || end == null) return null;
  let e = end;
  if (e < start) e += 1440;
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

// ───────────────────────────── тема ──────────────────────────────────
const mqDark = window.matchMedia('(prefers-color-scheme: dark)');

function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}
function resolvedTheme(t = currentTheme()) {
  if (t === 'light' || t === 'dark') return t;
  return mqDark.matches ? 'dark' : 'light';
}
function applyTheme(t = currentTheme()) {
  document.documentElement.dataset.theme = t;
  const r = resolvedTheme(t);
  if (el.themeColor) el.themeColor.setAttribute('content', r === 'dark' ? '#0c0f14' : '#ffffff');
  document.querySelectorAll('.theme__btn').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.themeSet === t)));
}
function setTheme(t) {
  try { localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
  applyTheme(t);
}
mqDark.addEventListener('change', () => { if (currentTheme() === 'system') applyTheme(); });

// ──────────────────────── загрузка данных ─────────────────────────────
async function init() {
  applyTheme();
  bindStaticEvents();
  tickClock();
  setInterval(tickClock, 10_000);
  setInterval(refreshLiveStatuses, 15_000);
  registerSW();

  // 1) Показываем кэш сразу, если он есть.
  const cached = readCache();
  if (cached) {
    DATA = cached;
    buildLineFilter();
    render();
    renderFoot();
  }

  // 2) Всегда пытаемся обновить с официального сайта.
  await refreshLive(!cached);
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return validate(d) ? d : null;
  } catch { return null; }
}

function validate(d) {
  if (!d || !Array.isArray(d.lines) || d.lines.length < 5) return false;
  const stops = d.lines.reduce((n, l) => n + (l.stops?.length || 0), 0);
  return stops >= 60;
}

// Декодируем ответ с учётом возможной кодировки (на сайте — UTF-8,
// но подстрахуемся на случай windows-1251).
async function decodeResponse(res) {
  const buf = await res.arrayBuffer();
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  let enc = 'utf-8';
  if (/1251|windows-cp|cp1251/.test(ctype)) enc = 'windows-1251';
  let text = new TextDecoder(enc).decode(buf);
  // Если получили «битые» символы — пробуем 1251.
  if (enc === 'utf-8' && /\uFFFD/.test(text)) {
    const meta = text.match(/charset=["']?([\w-]+)/i);
    if (meta && /1251/.test(meta[1])) {
      try { text = new TextDecoder('windows-1251').decode(buf); } catch { /* ignore */ }
    }
  }
  return text;
}

async function fetchWithTimeout(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, { signal: ctl.signal, cache: 'no-store', redirect: 'follow' });
  } finally { clearTimeout(t); }
}

async function refreshLive(coldStart) {
  if (refreshing) return false;
  refreshing = true;
  setRefreshingUI(true);

  for (const make of PROXIES) {
    try {
      const res = await fetchWithTimeout(make(SOURCE_URL));
      if (!res.ok) continue;
      const html = await decodeResponse(res);
      if (!/ЛИНИЯ/i.test(html) || !/вестибюл/i.test(html.toLowerCase())) continue;
      const parsed = parseSchedule(html);
      if (!validate(parsed)) continue;

      parsed.meta = { ...parsed.meta, fetchedAt: new Date().toISOString(), live: true };
      DATA = parsed;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(parsed)); } catch { /* квота */ }

      buildLineFilter();
      render();
      renderFoot();
      if (!coldStart) toast('Расписание обновлено');
      refreshing = false;
      setRefreshingUI(false);
      return true;
    } catch { /* следующий прокси */ }
  }

  refreshing = false;
  setRefreshingUI(false);

  // Не удалось обновить.
  if (!DATA) {
    showError();
  } else {
    renderFoot();
    if (!coldStart) toast('Не удалось обновить — показаны сохранённые данные');
  }
  return false;
}

function setRefreshingUI(on) {
  el.list.setAttribute('aria-busy', String(on && !DATA));
  document.documentElement.classList.toggle('is-refreshing', on);
}

function showError() {
  el.list.innerHTML = `
    <div class="empty">
      <p>Не удалось загрузить расписание и нет сохранённой копии.</p>
      <p class="empty__hint">Проверьте подключение к интернету.</p>
      <button class="retry" id="retry">Повторить</button>
    </div>`;
  const btn = document.getElementById('retry');
  if (btn) btn.addEventListener('click', () => {
    el.list.innerHTML = '<div class="loader"><span class="loader__spin"></span><span class="loader__text">Загрузка расписания…</span></div>';
    refreshLive(true);
  });
}

// ──────────────────────── фильтр по линиям ────────────────────────────
function buildLineFilter() {
  el.lineFilter.innerHTML = '';
  el.lineFilter.appendChild(chip('all', 'Все', null));
  for (const line of DATA.lines) el.lineFilter.appendChild(chip(line.id, line.id, line.color));
}

function chip(id, label, color) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.type = 'button';
  b.dataset.line = id;
  b.setAttribute('aria-pressed', String(id === activeLine));
  if (color) {
    const m = document.createElement('span');
    m.className = 'chip__m';
    m.style.color = color;
    m.innerHTML = '<svg viewBox="0 0 24 24"><use href="#metroM"/></svg>';
    b.appendChild(m);
  }
  b.appendChild(document.createTextNode(label));
  b.addEventListener('click', () => {
    activeLine = id;
    el.lineFilter.querySelectorAll('.chip').forEach((c) =>
      c.setAttribute('aria-pressed', String(c.dataset.line === id)));
    render();
  });
  return b;
}

// ─────────────────────────── отрисовка ────────────────────────────────
function render() {
  if (!DATA) return;
  const now = nowMinutes();
  const par = parityOf();
  const frag = document.createDocumentFragment();
  stopIndex.clear();
  let shown = 0;

  for (const line of DATA.lines) {
    if (activeLine !== 'all' && line.id !== activeLine) continue;
    const stops = line.stops.filter(matches);
    if (!stops.length) continue;
    shown += stops.length;

    frag.appendChild(lineHead(line));
    for (const s of stops) frag.appendChild(stationCard(line, s, now, par));
  }

  el.list.innerHTML = '';
  el.list.setAttribute('aria-busy', 'false');
  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = query
      ? 'Ничего не найдено. Попробуйте другое название.'
      : 'Нет станций для отображения.';
    el.list.appendChild(empty);
  } else {
    el.list.appendChild(frag);
  }
}

function matches(stop) {
  if (!query) return true;
  if (norm(stop.station).includes(query)) return true;
  return stop.vestibules.some((v) => norm(v.name).includes(query));
}

function mMark(color, label) {
  return `<span class="mmark" style="--c:${color}"><svg viewBox="0 0 24 24"><use href="#metroM"/></svg><span class="mmark__n">${esc(label)}</span></span>`;
}

function lineHead(line) {
  const wrap = document.createElement('div');
  wrap.className = 'line-head';
  const t = line.termini || [];
  wrap.innerHTML = `
    ${mMark(line.color, line.id)}
    <span class="line-head__text">
      <span class="line-head__name">${esc(line.title || line.name)}</span>
      ${t.length ? `<span class="line-head__dir">${esc(t[0])} — ${esc(t[t.length - 1])}</span>` : ''}
    </span>`;
  return wrap;
}

function stationCard(line, stop, now, par) {
  const key = `${line.id}:${stop.station}`;
  stopIndex.set(key, { line, stop });
  const isOpen = expanded.has(key);

  const card = document.createElement('article');
  card.className = 'stn' + (stop.closed ? ' stn--closed' : '');
  card.dataset.key = key;
  card.style.setProperty('--line', line.color);

  const head = document.createElement('button');
  head.className = 'stn__head';
  head.type = 'button';
  head.setAttribute('aria-expanded', String(isOpen));
  head.innerHTML = `
    ${mMark(line.color, line.id)}
    <span class="stn__name">${esc(stop.station)}</span>
    <span class="stn__status">${stop.closed ? '<span class="pill pill--shut">закрыта</span>' : statusPill(stop, now)}</span>
    <span class="stn__chev" aria-hidden="true"></span>`;

  const body = document.createElement('div');
  body.className = 'stn__body';
  body.hidden = !isOpen;
  body.appendChild(stationBody(stop, now, par));

  // Тоггл читает АКТУАЛЬНОЕ состояние при каждом клике (без устаревших замыканий).
  head.addEventListener('click', () => {
    const open = !expanded.has(key);
    if (open) expanded.add(key); else expanded.delete(key);
    head.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    if (open) {
      body.innerHTML = '';
      body.appendChild(stationBody(stop, nowMinutes(), parityOf()));
    }
  });

  card.appendChild(head);
  card.appendChild(body);
  return card;
}

function statusPill(stop, now) {
  let soon = null;
  for (const l of stop.last || []) {
    const t = timeToMinutes(l.value);
    if (t == null) continue;
    let diff = t - now;
    if (diff < -60) diff += 1440;
    if (diff >= -3 && diff <= SOON_WINDOW && (!soon || diff < soon.diff)) soon = { diff };
  }
  if (soon) {
    const m = Math.round(soon.diff);
    return `<span class="pill pill--soon">${m <= 0 ? 'поезд уходит' : `последний через ${m} мин`}</span>`;
  }
  let anyOpen = false, closingSoon = false;
  for (const v of stop.vestibules || []) {
    const o = timeToMinutes(v.open?.[0]);
    const c = timeToMinutes(v.closeIn);
    if (inWindow(now, o, c)) {
      anyOpen = true;
      let end = c; if (end < o) end += 1440;
      let n = now; if (n < o) n += 1440;
      if (end - n <= OPEN_SOON) closingSoon = true;
    }
  }
  if (anyOpen) return closingSoon
    ? '<span class="pill pill--soon">скоро закрытие</span>'
    : '<span class="pill pill--open">вход открыт</span>';
  return '<span class="pill pill--shut">вход закрыт</span>';
}

function stationBody(stop, now, par) {
  const frag = document.createDocumentFragment();
  if (stop.closed) {
    const b = document.createElement('div');
    b.className = 'closed-banner';
    b.textContent = stop.note || 'Станция закрыта';
    frag.appendChild(b);
    return frag;
  }
  if ((stop.first && stop.first.length) || (stop.last && stop.last.length)) {
    frag.appendChild(trainsBlock(stop, now, par));
  }
  if (stop.vestibules && stop.vestibules.length) {
    const vb = document.createElement('div');
    vb.className = 'vest';
    for (const v of stop.vestibules) vb.appendChild(vestRow(v, now));
    frag.appendChild(vb);
  }
  return frag;
}

function trainsBlock(stop, now, par) {
  const wrap = document.createElement('div');
  wrap.className = 'dirs';

  const dirs = new Map();
  for (const f of stop.first || []) {
    const d = dirs.get(f.to) || { to: f.to }; d.first = f; dirs.set(f.to, d);
  }
  for (const l of stop.last || []) {
    const d = dirs.get(l.to) || { to: l.to }; d.last = l; dirs.set(l.to, d);
  }

  for (const d of dirs.values()) {
    const cell = document.createElement('div');
    cell.className = 'dir';
    const parts = [`<div class="dir__to">${esc(d.to)}</div>`];

    if (d.first) {
      if (d.first.odd === d.first.even || !d.first.even || !d.first.odd) {
        const v = d.first.odd || d.first.even || '—';
        parts.push(`<div class="dir__row"><span class="dir__lbl">первый</span><span class="tt tnum">${esc(v)}</span></div>`);
      } else {
        const oddCls = par === 'odd' ? 'tt--today' : 'tt--off';
        const evenCls = par === 'even' ? 'tt--today' : 'tt--off';
        parts.push(`<div class="dir__row"><span class="dir__lbl">первый</span>
          <span class="tt tnum ${oddCls}">${esc(d.first.odd)}<small>неч</small></span>
          <span class="tt tnum ${evenCls}">${esc(d.first.even)}<small>чёт</small></span></div>`);
      }
    }
    if (d.last) {
      const t = timeToMinutes(d.last.value);
      let badge = '';
      if (t != null) {
        let diff = t - now;
        if (diff < -60) diff += 1440;
        if (diff >= -3 && diff <= SOON_WINDOW) {
          badge = diff <= 0
            ? '<span class="dir__cd dir__cd--now">уходит</span>'
            : `<span class="dir__cd">через ${Math.round(diff)} мин</span>`;
        }
      }
      parts.push(`<div class="dir__row"><span class="dir__lbl">последний</span><span class="tt tnum tt--last">${esc(d.last.value || '—')}</span>${badge}</div>`);
    }
    cell.innerHTML = parts.join('');
    wrap.appendChild(cell);
  }
  return wrap;
}

function vestRow(v, now) {
  const row = document.createElement('div');
  row.className = 'vt';
  const openTimes = (v.open && v.open.length) ? v.open.join(' / ') : '—';
  const o = timeToMinutes(v.open?.[0]);
  const cIn = timeToMinutes(v.closeIn);
  const st = inWindow(now, o, cIn);
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

// Точечное обновление «живых» статусов без полной перерисовки.
function refreshLiveStatuses() {
  if (!DATA) return;
  const now = nowMinutes();
  const par = parityOf();
  for (const card of el.list.querySelectorAll('.stn')) {
    const rec = stopIndex.get(card.dataset.key);
    if (!rec || rec.stop.closed) continue;
    const statusEl = card.querySelector('.stn__status');
    if (statusEl) statusEl.innerHTML = statusPill(rec.stop, now);
    const body = card.querySelector('.stn__body');
    if (body && !body.hidden) {
      body.innerHTML = '';
      body.appendChild(stationBody(rec.stop, now, par));
    }
  }
}

// ───────────────────────────── футер ──────────────────────────────────
function renderFoot() {
  const m = DATA?.meta || {};
  let when = '';
  if (refreshing) when = 'обновление…';
  else if (m.fetchedAt) when = `обновлено ${fmtWhen(m.fetchedAt)}${m.live ? '' : ' (из кэша)'}`;
  const notes = (m.generalNotes || []).map((n) => `<p>${esc(n)}</p>`).join('');

  el.foot.innerHTML = `
    ${m.scheduleDate ? `<p class="foot__date">Расписание действует ${esc(m.scheduleDate)}.</p>` : ''}
    ${notes}
    <p class="foot__links">
      <a href="${SOURCE_URL}" target="_blank" rel="noopener">Официальный источник</a>
      ${m.addressPdf ? ` · <a href="${esc(m.addressPdf)}" target="_blank" rel="noopener">Адреса вестибюлей (PDF)</a>` : ''}
    </p>
    <p class="foot__meta">${when ? esc(when) + '. ' : ''}Неофициальное приложение, данные могут отличаться от актуальных.</p>`;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ───────────────────────────── часы ───────────────────────────────────
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
    el.search.value = '';
    query = '';
    el.searchClear.hidden = true;
    render();
    el.search.focus();
  });
  document.querySelectorAll('.theme__btn').forEach((b) =>
    b.addEventListener('click', () => setTheme(b.dataset.themeSet)));
}

// ──────────────────────── service worker ──────────────────────────────
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* не критично */ });
  });
}

// ─────────────────────────── запуск ───────────────────────────────────
init();
