// gen-data.mjs — генерация снимка data.json из официальной страницы.
// Использование:
//   node gen-data.mjs                       # из встроенной сохранённой копии (если есть)
//   node gen-data.mjs path/to/page.html     # из локального файла
//   node gen-data.mjs https://metro.spb.ru/rejimrabotystancii.html   # из сети (для CI)

import { readFileSync, writeFileSync } from 'node:fs';
import { parseSchedule, isTimeLike } from './parser.js';

const DEFAULT_URL = 'https://metro.spb.ru/rejimrabotystancii.html';
const arg = process.argv[2] || '/mnt/user-data/uploads/Режим_работы_станции_.html';

async function readSource(src) {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; metro-spb-snapshot/1.0)' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} при загрузке ${src}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    const enc = /1251|cp1251/.test(ctype) ? 'latin1' : 'utf8'; // 1251 редок, страница в UTF-8
    return buf.toString(enc === 'latin1' ? 'utf8' : 'utf8');
  }
  return readFileSync(src, 'utf8');
}

const html = await readSource(arg);
const data = parseSchedule(html);
data.meta.generatedAt = new Date().toISOString();
data.meta.source = DEFAULT_URL;

if (!data.lines || data.lines.length < 5) {
  console.error('Ошибка: распарсено слишком мало линий — снимок НЕ сохранён.');
  process.exit(1);
}
const total = data.lines.reduce((n, l) => n + l.stops.length, 0);
if (total < 60) {
  console.error(`Ошибка: распарсено мало станций (${total}) — снимок НЕ сохранён.`);
  process.exit(1);
}

writeFileSync('data.json', JSON.stringify(data, null, 1));

let vest = 0, closed = 0;
for (const l of data.lines) for (const s of l.stops) for (const v of s.vestibules) { vest++; if (v.closed) closed++; }
console.log(`Снимок сохранён: ${data.lines.length} линий, ${total} станций, ${vest} вестибюлей, закрытых ${closed}.`);
console.log(`Дата графика: ${data.meta.scheduleDate}; источник: ${arg}`);
