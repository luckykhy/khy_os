'use strict';
// 「前缀家族」探测：找出可以只靠移动文件（零改名、零改引用）就完成分组的目录。
// 判据：同目录内存在 ≥N 个共享同一 camelCase / kebab 前缀的文件。只读、确定性。
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const MIN_FAMILY = Number((process.argv.find(a => a.startsWith('--min=')) || '--min=6').slice(6));
const TARGETS = process.argv.filter(a => a.startsWith('--dir=')).map(a => a.slice(6));

function familiesIn(dir) {
  let ents;
  try { ents = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch (e) { return null; }
  const files = ents.filter(e => e.isFile()).map(e => e.name);
  const dirs = ents.filter(e => e.isDirectory()).map(e => e.name);
  const groups = new Map();
  for (const f of files) {
    // 取第一个驼峰边界或 '-' / '_' 之前的部分
    const base = f.replace(/\.[^.]+$/, '');
    let prefix = base.split(/[-_]/)[0];
    if (prefix === base) {
      const m = base.match(/^[a-z]+(?=[A-Z])/);
      prefix = m ? m[0] : null;
    }
    if (!prefix || prefix.length < 2) continue;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(f);
  }
  const fams = [...groups.entries()]
    .filter(([, v]) => v.length >= MIN_FAMILY)
    .map(([k, v]) => ({ prefix: k, count: v.length, hasDir: dirs.includes(k), samples: v.slice(0, 3) }))
    .sort((a, b) => b.count - a.count);
  return { files: files.length, dirs: dirs.length, fams };
}

const list = TARGETS.length ? TARGETS : [
  'services/backend/src/services',
  'services/backend/src/utils',
  'services/backend/src/routes',
  'services/backend/src/cli/handlers',
  'services/backend/src/tools',
  'services/backend/tests/services',
];

for (const d of list) {
  const r = familiesIn(d);
  if (!r) { console.log(`--- ${d}  (读取失败)`); continue; }
  const grouped = r.fams.reduce((a, b) => a + b.count, 0);
  console.log(`\n=== ${d}  (${r.files} 文件 + ${r.dirs} 目录; ${r.fams.length} 个家族覆盖 ${grouped} 文件) ===`);
  for (const f of r.fams.slice(0, 18)) {
    console.log(`  ${String(f.count).padStart(4)}  ${f.prefix}${f.hasDir ? '  [已有同名目录!]' : ''}   e.g. ${f.samples.join(', ')}`);
  }
}
