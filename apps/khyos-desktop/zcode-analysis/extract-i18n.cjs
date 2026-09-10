// Extract i18n key/value pairs from a minified ZCode IntlProvider chunk.
// Values in this build are backtick-delimited template literals: key:`中文`.
// Usage: node extract-i18n.cjs <IntlProvider.js> [groupPrefix]
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const outPath = process.argv[3] || null;
const group = process.argv[4] || null;

// Match  "key":`value`   (double-quoted key, backtick-delimited value)
const re = /"((?:[^"\\]|\\.)+)":`((?:[^`\\]|\\.)*)`/g;
const map = new Map();
let m;
while ((m = re.exec(src))) {
  const key = JSON.parse(`"${m[1]}"`);
  let val = m[2];
  val = val.replace(/\\`/g, '`').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (!map.has(key)) map.set(key, val);
}

const keys = [...map.keys()].sort();
console.error(`--- ${keys.length} keys extracted ---`);
let selected = keys;
if (group) {
  const top = group.split('.')[0];
  selected = keys.filter((k) => k === group || k.startsWith(group + '.') || k.startsWith(top + '.'));
  console.error(`--- ${selected.length} keys under '${top}' ---`);
}
// Emit two artifacts: JSON-lines (machine-safe) and TSV (human-readable).
// Values may contain newlines, so JSON-escape them in the JSONL form.
const jsonl = selected.map((k) => JSON.stringify({ k, v: map.get(k) }));
const tsv = selected.map((k) => `${k}\t${map.get(k)}`);
if (outPath) {
  fs.writeFileSync(outPath + '.jsonl', jsonl.join('\n') + '\n', 'utf8');
  fs.writeFileSync(outPath + '.tsv', tsv.join('\n') + '\n', 'utf8');
  fs.writeFileSync(outPath + '.json', JSON.stringify(Object.fromEntries(selected.map((k) => [k, map.get(k)])), null, 2), 'utf8');
} else {
  process.stdout.write(jsonl.join('\n') + '\n');
}
