'use strict';
// 层级可发现性探测：统计各层条目规模、单目录条目数分布。
// 只读、确定性、零外部依赖。产出自 [DESIGN-LAY-006] 现状证据。
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();

function scan(dir) {
  let files = 0, dirs = 0;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
  const kids = [];
  for (const e of ents) {
    if (e.isDirectory()) { dirs++; kids.push(e.name); }
    else files++;
  }
  return { files, dirs, total: files + dirs, kids };
}

const TOP = ['kernel', 'platform', 'services', 'apps', 'software', 'extensions', 'tools', 'scripts', 'packaging', 'docs', 'electron', 'entries', 'deploy', 'patches', 'tests'];

console.log('=== 顶层目录条目数 ===');
const rows = [];
for (const top of TOP) {
  const s = scan(path.join(ROOT, top));
  if (s) rows.push({ dir: top, total: s.total, files: s.files, dirs: s.dirs });
}
rows.sort((a, b) => b.total - a.total);
for (const r of rows) {
  console.log(String(r.total).padStart(6), '条目 =', String(r.files).padStart(5), '文件 +', String(r.dirs).padStart(4), '目录   ', r.dir);
}

// 找出所有「单目录条目数 > 阈值」的热点 —— 查找困难的量化指标
const THRESHOLD = 60;
const hotspots = [];
function walk(dir, depth, maxDepth) {
  if (depth > maxDepth) return;
  const s = scan(dir);
  if (!s) return;
  if (s.total > THRESHOLD) {
    hotspots.push({ dir: dir.slice(ROOT.length + 1), total: s.total, files: s.files, dirs: s.dirs });
  }
  for (const k of s.kids) {
    if (k === 'node_modules' || k === '.git') continue;
    walk(path.join(dir, k), depth + 1, maxDepth);
  }
}
const MAXDEPTH = Number((process.argv.find(a => a.startsWith('--depth=')) || '--depth=6').slice(8));
for (const top of TOP) walk(path.join(ROOT, top), 1, MAXDEPTH);

hotspots.sort((a, b) => b.total - a.total);
console.log('\n=== 单目录条目数 > ' + THRESHOLD + ' 的热点（查找困难区）===');
console.log('条目数  文件数  子目录数  目录');
for (const h of hotspots) {
  console.log(String(h.total).padStart(6), String(h.files).padStart(7), String(h.dirs).padStart(9), '  ', h.dir);
}
console.log('\n热点目录数:', hotspots.length);
