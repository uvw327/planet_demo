/** 极简 markdown 表格列数自检：找出同一表格块内列数不一致的行。 */
import fs from 'node:fs';
const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const countPipes = (line) => {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '|') n++;
  }
  return n;
};
let bad = 0, tables = 0;
let i = 0;
while (i < lines.length) {
  const isSep = (s) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(s) && s.includes('-') && s.includes('|');
  if (lines[i].includes('|') && i + 1 < lines.length && isSep(lines[i + 1]) && lines[i + 1].trim() !== '') {
    const cols = countPipes(lines[i]);
    tables++;
    const start = i + 1;
    let j = i + 2;
    while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
      const c = countPipes(lines[j]);
      if (c !== cols) { console.log(`列数不一致: 行 ${j + 1} 有 ${c} 个 |，表头(行 ${i + 1})有 ${cols} 个`); bad++; }
      j++;
    }
    i = j;
  } else i++;
}
console.log(`表格块数 ${tables}，不一致行数 ${bad}`);
