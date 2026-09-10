// Per-namespace key counts for DESIGN-ARCH-092 §6.2.
const fs = require('fs');
const i18n = JSON.parse(fs.readFileSync(`${__dirname}/i18n-zh.json`, 'utf8'));
const flat = [];
(function walk(o, p) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    const q = p ? `${p}.${k}` : k;
    if (typeof v === 'string') flat.push(q);
    else if (v && typeof v === 'object') walk(v, q);
  }
})(i18n, '');
const counts = {};
for (const k of flat) {
  const ns = k.split('.')[0];
  counts[ns] = (counts[ns] || 0) + 1;
}
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
console.log(`total keys: ${flat.length}  namespaces: ${sorted.length}\n`);
for (const [ns, n] of sorted) console.log(`${String(n).padStart(4)}  ${ns}`);
