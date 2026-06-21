import { readFileSync, writeFileSync } from 'node:fs';
import { parseSchedule, isTimeLike } from './parser.js';

const src = process.argv[2] || '/mnt/user-data/uploads/Режим_работы_станции_.html';
const html = readFileSync(src, 'utf8');

const data = parseSchedule(html);
data.meta.generatedAt = new Date().toISOString();

writeFileSync('data.json', JSON.stringify(data, null, 1));

// ── статистика и быстрые проверки ──
let stations = 0, vestibules = 0, closed = 0, withNotes = 0, badOpen = 0;
const sample = [];
for (const line of data.lines) {
  for (const stop of line.stops) {
    stations++;
    for (const v of stop.vestibules) {
      vestibules++;
      if (v.closed) closed++;
      if (v.notes && v.notes.length) withNotes++;
      if (!v.closed && !v.open.some(isTimeLike)) badOpen++;
    }
  }
  sample.push(`Линия ${line.id} (${line.title}) [${line.color}] — ${line.stops.length} остановок; направления: ${line.termini.join(' / ')}`);
}

console.log('=== Линии ===');
sample.forEach((s) => console.log(' ' + s));
console.log('\n=== Итого ===');
console.log(` остановок: ${stations}, вестибюлей: ${vestibules}, закрытых: ${closed}, c примечаниями: ${withNotes}`);
console.log(` строк без времени открытия (не закрытых): ${badOpen}`);
console.log(` дата графика: ${data.meta.scheduleDate}`);
console.log(` общие примечания: ${JSON.stringify(data.meta.generalNotes)}`);
console.log(` PDF адресов: ${data.meta.addressPdf}`);

// показать примеры
console.log('\n=== Пример: Линия 1, первые 2 остановки ===');
console.log(JSON.stringify(data.lines[0].stops.slice(0, 2), null, 1));
console.log('\n=== Пример: остановки с примечаниями ===');
for (const line of data.lines) {
  for (const stop of line.stops) {
    const noted = stop.vestibules.filter((v) => (v.notes && v.notes.length) || v.closed);
    if (noted.length) {
      console.log(` Л${line.id} ${stop.station}: ` +
        noted.map((v) => `${v.closed ? '[ЗАКРЫТА] ' : ''}${(v.notes || []).join('; ')}`).join(' | '));
    }
  }
}
console.log('\n=== Пример: остановки с чёт/нечёт открытием ===');
for (const line of data.lines) {
  for (const stop of line.stops) {
    for (const v of stop.vestibules) {
      if (v.open.length > 1) console.log(` Л${line.id} ${stop.station} / ${v.name}: ${JSON.stringify(v.open)}`);
    }
  }
}
