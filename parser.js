/*
 * parser.js — устойчивый разбор страницы «Режим работы станций»
 * Петербургского метрополитена (metro.spb.ru/rejimrabotystancii.html).
 *
 * Работает одинаково в браузере и в Node без внешних зависимостей.
 * Главная точка входа — parseSchedule(html) -> объект расписания.
 *
 * Подход максимально гибкий к мелким изменениям разметки:
 *  1. Разбираем единственную большую таблицу в строки/ячейки (regex-токенайзер,
 *     устойчивый к смене атрибутов и оформления).
 *  2. Делим на блоки-линии по строкам-заголовкам «ЛИНИЯ N».
 *  3. Нормализуем таблицу в сетку, честно разворачивая rowspan/colspan.
 *  4. Роли колонок определяем по ТЕКСТУ заголовков (а не по их позиции),
 *     поэтому добавление/смещение колонок не ломает разбор.
 */

// ─────────────────────────── справочник линий ───────────────────────────
// Официальные цвета и названия линий Петербургского метрополитена.
export const LINE_INFO = {
  1: { color: '#D6083B', name: 'Кировско-Выборгская' },
  2: { color: '#0072BA', name: 'Московско-Петроградская' },
  3: { color: '#009A49', name: 'Невско-Василеостровская' },
  4: { color: '#EA7125', name: 'Правобережная' },
  5: { color: '#702082', name: 'Фрунзенско-Приморская' },
  6: { color: '#B5651D', name: 'Красносельско-Калининская' },
};

// ─────────────────────────── мелкие утилиты ───────────────────────────
const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', laquo: '«', raquo: '»',
  mdash: '—', ndash: '–', deg: '°', hellip: '…', apos: "'", shy: '',
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) =>
      Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : m);
}

// Текст ячейки: <br> → пробел, теги вырезаем, сущности декодируем, пробелы схлопываем.
function cellText(html) {
  return decodeEntities(
    html
      .replace(/<\s*br\s*\/?\s*>/gi, ' ')
      .replace(/<[^>]+>/g, '')
  ).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function attr(attrStr, name) {
  const m = attrStr.match(new RegExp(name + '\\s*=\\s*["\']?(\\d+)', 'i'));
  return m ? parseInt(m[1], 10) : 1;
}

// Похоже ли на время вида 5:42 / 0:11 / 22:00 (допускаем точку и пробелы).
export function isTimeLike(s) {
  return /\b\d{1,2}\s*[:.]\s*\d{2}\b/.test(s || '');
}

// Нормализуем время к виду H:MM → минуты от 0:00, чтобы сравнивать «сейчас».
export function timeToMinutes(s) {
  const m = (s || '').match(/(\d{1,2})\s*[:.]\s*(\d{2})/);
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]);
}

// ─────────────────────── токенизация таблицы ───────────────────────
// Разбиваем HTML таблицы на строки → ячейки {text, raw, colspan, rowspan}.
function tokenizeRows(tableHtml) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRe.exec(tableHtml))) {
    const inner = trMatch[1];
    const cells = [];
    const tdRe = /<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi;
    let tdMatch;
    while ((tdMatch = tdRe.exec(inner))) {
      const attrs = tdMatch[2];
      const raw = tdMatch[3];
      cells.push({
        text: cellText(raw),
        raw,
        colspan: attr(attrs, 'colspan'),
        rowspan: attr(attrs, 'rowspan'),
      });
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

// Берём содержимое нужной таблицы. Целевая — та, где встречаются «ЛИНИЯ» и
// «Вестибюль». Если разметка изменится, берём самую большую таблицу как запасной вариант.
function extractScheduleTable(html) {
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let m, best = null, bestLen = 0, target = null;
  while ((m = tableRe.exec(html))) {
    const body = m[1];
    if (/ЛИНИЯ/i.test(body) && /Вестибюл/i.test(body)) { target = body; break; }
    if (body.length > bestLen) { bestLen = body.length; best = body; }
  }
  return target || best || '';
}

// ─────────────────────── нормализация в сетку ───────────────────────
// Возвращаем grid[r][c] = {text, raw, origin:{r,c}, isOrigin} с развёрнутыми span.
function normalizeGrid(rows) {
  const occ = []; // occ[r][c]
  const ensure = (r) => { while (occ.length <= r) occ.push([]); };
  for (let r = 0; r < rows.length; r++) {
    ensure(r);
    let c = 0;
    for (const cell of rows[r]) {
      while (occ[r][c]) c++;
      const cs = cell.colspan || 1, rs = cell.rowspan || 1;
      for (let dr = 0; dr < rs; dr++) {
        ensure(r + dr);
        for (let dc = 0; dc < cs; dc++) {
          occ[r + dr][c + dc] = {
            text: cell.text, raw: cell.raw,
            origin: { r, c }, isOrigin: dr === 0 && dc === 0,
          };
        }
      }
      c += cs;
    }
  }
  return occ;
}

const at = (grid, r, c) => (grid[r] && grid[r][c]) || { text: '', raw: '', isOrigin: false, origin: { r: -1, c: -1 } };

// Имя конечной станции: убираем мягкий перенос и склейку слов дефисом
// (например «Комендант-ский проспект» → «Комендантский проспект»).
function cleanTerminus(s) {
  return (s || '')
    .replace(/\u00ad/g, '')
    .replace(/([а-яё])\s*-\s*([а-яё])/g, '$1$2')  // только строчная-дефис-строчная = перенос
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────── определение ролей колонок ───────────────────────
function detectColumns(headerGrid) {
  // строка-группа = та, где есть «Первые поезда»
  let groupRow = 0;
  for (let r = 0; r < headerGrid.length; r++) {
    if (headerGrid[r].some((c) => c && /перв/i.test(c.text))) { groupRow = r; break; }
  }
  const width = Math.max(...headerGrid.map((row) => row.length));
  const roles = new Array(width).fill(null);
  for (let c = 0; c < width; c++) {
    const t = at(headerGrid, groupRow, c).text;
    if (/перв/i.test(t)) roles[c] = 'first';
    else if (/послед/i.test(t)) roles[c] = 'last';
    else if (/№/.test(t)) roles[c] = 'num';
    else if (/вестибюл/i.test(t)) roles[c] = 'name';
    else if (/открыт/i.test(t)) roles[c] = 'open';
    else if (/закрыт/i.test(t) && /вход/i.test(t)) roles[c] = 'closeIn';
    else if (/закрыт/i.test(t) && /выход/i.test(t)) roles[c] = 'closeOut';
  }

  const idx = (role) => roles.indexOf(role);
  const cols = {
    num: idx('num'), name: idx('name'), open: idx('open'),
    closeIn: idx('closeIn'), closeOut: idx('closeOut'),
    first: [], last: [],
  };
  for (let c = 0; c < width; c++) {
    if (roles[c] === 'first') cols.first.push(c);
    if (roles[c] === 'last') cols.last.push(c);
  }

  // строка с названиями станций-направлений (под группами) и строка чёт/нечёт
  const termRow = groupRow + 1;
  const parityRow = groupRow + 2;

  const firstDirs = cols.first.map((c) => ({
    col: c,
    terminus: cleanTerminus(at(headerGrid, termRow, c).text),
    parity: at(headerGrid, parityRow, c).text.toLowerCase(),
  }));
  const lastDirs = cols.last.map((c) => ({
    col: c,
    terminus: cleanTerminus(at(headerGrid, termRow, c).text),
  }));

  // список направлений в порядке появления
  const termini = [];
  for (const d of firstDirs) if (d.terminus && !termini.includes(d.terminus)) termini.push(d.terminus);
  for (const d of lastDirs) if (d.terminus && !termini.includes(d.terminus)) termini.push(d.terminus);

  return { cols, firstDirs, lastDirs, termini };
}

// чётность по слову заголовка: «нечет» → odd, «чет» → even
function parityKey(word) {
  if (/нечет/i.test(word)) return 'odd';
  if (/чет/i.test(word)) return 'even';
  return null;
}

// ─────────────────────── имя станции из имени вестибюля ───────────────────────
export function deriveStation(name) {
  const n = (name || '').replace(/\s+/g, ' ').trim();
  const m = n.match(/станци[ияей]+\s+(.+)$/i);
  let s = m ? m[1] : n;
  s = s.replace(/\s*\(.*$/, '').trim();      // убрать «(выход на …)»
  s = s.replace(/^Вестибюль\s*\d*\s*/i, '').trim();
  return s || n;
}

// ─────────────────────── разбор одной линии ───────────────────────
function parseLineBlock(lineId, lineName, blockRows) {
  // делим на заголовок (до первой строки данных) и данные
  let dataStart = blockRows.length;
  for (let i = 0; i < blockRows.length; i++) {
    const first = blockRows[i][0];
    if (first && /^\d+$/.test(first.text.trim())) { dataStart = i; break; }
  }
  const headerRows = blockRows.slice(0, dataStart);
  const headerGrid = normalizeGrid(headerRows);
  const { cols, firstDirs, lastDirs, termini } = detectColumns(headerGrid);

  const grid = normalizeGrid(blockRows);
  const stops = [];
  let stop = null, vest = null;

  const firstAnchor = cols.first[0];

  for (let r = dataStart; r < grid.length; r++) {
    const nameCell = at(grid, r, cols.name);
    const openCell = at(grid, r, cols.open);
    const numCell = at(grid, r, cols.num);
    const openTxt = openCell.text;

    const startsStop = firstAnchor != null && at(grid, r, firstAnchor).isOrigin;

    if (isTimeLike(openTxt)) {
      // обычная строка с временем работы вестибюля
      if (startsStop || !stop) {
        stop = makeStop(grid, r, cols, firstDirs, lastDirs, termini);
        stops.push(stop);
        vest = null;
      }
      if (nameCell.isOrigin || !vest) {
        vest = { name: nameCell.text, open: [], closeIn: openCloseText(at(grid, r, cols.closeIn)), closeOut: openCloseText(at(grid, r, cols.closeOut)), notes: [] };
        stop.vestibules.push(vest);
        if (!stop.station) stop.station = deriveStation(nameCell.text);
      }
      vest.open.push(openTxt);
    } else {
      // строка-примечание (времени нет)
      const isClosedStation = nameCell.isOrigin &&
        nameCell.origin && openCell.origin &&
        (nameCell.origin.r !== openCell.origin.r || nameCell.origin.c !== openCell.origin.c);

      if (isClosedStation) {
        // станция целиком закрыта / спецрежим — отдельная остановка
        stop = { station: deriveStation(nameCell.text), closed: true, note: openTxt, first: [], last: [], vestibules: [] };
        stop.vestibules.push({ name: nameCell.text, open: [], closeIn: '', closeOut: '', notes: [openTxt], closed: true });
        stops.push(stop);
        vest = null;
      } else {
        // примечание к текущему вестибюлю (например «по выходным закрыт»)
        const note = openTxt || nameCell.text;
        if (vest && note) vest.notes.push(note);
        else if (stop && note) (stop.notes ||= []).push(note);
      }
    }
  }

  // финальная чистка: схлопнуть одинаковые open-строки
  for (const s of stops) {
    for (const v of s.vestibules) {
      v.open = dedupe(v.open.map((t) => t.trim()).filter(Boolean));
    }
  }

  return {
    id: lineId,
    name: lineName,
    color: (LINE_INFO[lineId] || {}).color || '#888',
    title: (LINE_INFO[lineId] || {}).name || '',
    termini,
    stops,
  };
}

function openCloseText(cell) {
  const t = (cell.text || '').trim();
  return isTimeLike(t) || /\d/.test(t) ? t : t; // оставляем как есть (может быть «—»)
}

function dedupe(arr) {
  return arr.filter((x, i) => arr.indexOf(x) === i);
}

// Собираем времена первых/последних поездов для остановки из её стартовой строки.
function makeStop(grid, r, cols, firstDirs, lastDirs, termini) {
  const first = termini.map((term) => {
    const slot = { to: term, odd: '', even: '' };
    for (const d of firstDirs) {
      if (d.terminus !== term) continue;
      const val = at(grid, r, d.col).text.trim();
      const pk = parityKey(d.parity);
      if (pk) slot[pk] = val;
      else { slot.odd = slot.odd || val; slot.even = slot.even || val; }
    }
    return slot;
  });
  const last = termini.map((term) => {
    const d = lastDirs.find((x) => x.terminus === term);
    return { to: term, value: d ? at(grid, r, d.col).text.trim() : '' };
  });
  return { station: '', closed: false, note: '', first, last, vestibules: [] };
}

// ─────────────────────── общая мета страницы ───────────────────────
function extractMeta(html) {
  const meta = { scheduleDate: '', generalNotes: [], addressPdf: '' };

  // дата начала действия графика: «с 1 июня 2026 года»
  const dateM = html.match(/с\s+\d{1,2}\s+[а-яё]+\s+\d{4}\s+года/i);
  if (dateM) meta.scheduleDate = dateM[0].trim();

  // примечание про пересадки до 00:15 (и подобные краткие примечания сверху)
  const transM = html.match(/Переход с одной линии[^<]*0[:.]15[^<]*/i);
  if (transM) meta.generalNotes.push(cellText(transM[0]));

  // ссылка на PDF с адресами вестибюлей
  const pdfM = html.match(/href="([^"]*adress_vestibule[^"]*\.pdf)"/i);
  if (pdfM) meta.addressPdf = pdfM[1].replace(/^http:/, 'https:');

  return meta;
}

// ─────────────────────── точка входа ───────────────────────
export function parseSchedule(html) {
  const tableHtml = extractScheduleTable(html);
  const rows = tokenizeRows(tableHtml);

  // делим на блоки-линии по строкам «ЛИНИЯ N»
  const blocks = [];
  let cur = null;
  for (const row of rows) {
    const head = row.find((c) => /ЛИНИЯ\s*\d+/i.test(c.text) || /name=["']?line\d+/i.test(c.raw || ''));
    if (head) {
      const lm = (head.text.match(/ЛИНИЯ\s*(\d+)/i) || (head.raw || '').match(/line(\d+)/i));
      const id = lm ? parseInt(lm[1], 10) : (blocks.length + 1);
      cur = { id, name: head.text || `ЛИНИЯ ${id}`, rows: [] };
      blocks.push(cur);
      continue;
    }
    if (cur) cur.rows.push(row);
  }

  const lines = blocks
    .map((b) => parseLineBlock(b.id, b.name, b.rows))
    .filter((l) => l.stops.length > 0);

  const meta = extractMeta(html);
  meta.source = 'https://metro.spb.ru/rejimrabotystancii.html';

  return { meta, lines };
}

export default { parseSchedule, deriveStation, isTimeLike, timeToMinutes, LINE_INFO };
