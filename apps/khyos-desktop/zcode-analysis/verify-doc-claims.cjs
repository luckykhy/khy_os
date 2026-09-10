// Verify the numeric claims made in DESIGN-ARCH-092 against the extracted ground truth.
const fs = require('fs');
const path = require('path');
const dir = __dirname;

const i18n = JSON.parse(fs.readFileSync(path.join(dir, 'i18n-zh.json'), 'utf8'));
const flat = [];
(function walk(o, p) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    const q = p ? `${p}.${k}` : k;
    if (typeof v === 'string') flat.push(q);
    else if (v && typeof v === 'object') walk(v, q);
  }
})(i18n, '');

const namespaces = [...new Set(flat.map((k) => k.split('.')[0]))];
const junk = namespaces.filter((n) => !/^[A-Za-z][A-Za-z0-9]*$/.test(n));
const clean = namespaces.length - junk.length;

const rpc = JSON.parse(fs.readFileSync(path.join(dir, 'rpc-surface.json'), 'utf8'));
const byVia = { invoke: 0, on: 0, send: 0, sendSync: 0 };
for (const e of rpc) byVia[e.via]++;

const css = fs.readFileSync(path.join(dir, 'tokens.txt'), 'utf8');
const varCount = new Set(
  [...css.matchAll(/^\s+(--[a-zA-Z0-9_-]+)\s*:/gm)].map((m) => m[1])
).size;

const doc = fs.readFileSync(
  path.join(dir, '..', 'docs', '[DESIGN-ARCH-092] ZCode 1：1 复刻设计文档.md'),
  'utf8'
);

const checks = [
  ['i18n flat keys = 5070', flat.length, 5070],
  ['i18n raw namespaces = 82', namespaces.length, 82],
  ['i18n junk namespaces = 0 (all clean)', junk.length, 0],
  ['i18n clean namespaces = 82', clean, 82],
  ['rpc methods = 127', rpc.length, 127],
  ['rpc invoke = 68', byVia.invoke, 68],
  ['rpc on = 40', byVia.on, 40],
  ['rpc send = 19', byVia.send, 19],
  ['css distinct custom props = 456', varCount, 456],
];

let fail = 0;
for (const [label, actual, expected] of checks) {
  const ok = actual === expected;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (actual=${actual})`);
}

// Which namespace groups does the doc actually name? Cross-check the §6.2 list.
const section62 = doc.split('## 七、')[0];
const named = new Set([...section62.matchAll(/`([a-zA-Z][a-zA-Z0-9]*)`/g)].map((m) => m[1]));
const missing = clean ? namespaces.filter((n) => !junk.includes(n) && !named.has(n)) : [];

console.log(`\n--- namespaces not named in doc: ${missing.length} ---`);
for (const n of missing) console.log(`      ${n}`);

process.exitCode = fail ? 1 : 0;
