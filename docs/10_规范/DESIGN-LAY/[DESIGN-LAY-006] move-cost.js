'use strict';
/**
 * move-cost.js — 测量「把一个文件移进子目录」的真实代价。
 *
 * 本仓要求：迁移必须留下 re-export 壳（[DESIGN-LAY-005] §2.1 的兼容别名手法）。
 * 实测证明（2026-09-18）壳**不是免费的**：
 *   ① 入边（别人 require 它）—— 由壳兜住，0 改动；但壳自身 +1 文件
 *   ② 出边（它自己 require 别人）—— **壳救不了**，深度变了就必须逐条改 `../` 级数
 *   ③ 同目录被一起移动的兄弟 —— 它们之间的相对 require（`./x`）若不同批移动会断
 *
 * 本脚本量化 ①②③，为分批策略提供依据。只读、确定性。
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

// 抽取一个 JS 文件里所有相对 require 的字面量
function relRequires(src) {
  const out = [];
  const re = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

// 全仓入边索引：谁 require 了 <relPath>（按解析后的绝对目标匹配）
function buildInboundIndex(scanRoots) {
  const index = new Map(); // absTarget(去扩展名) -> [referrer]
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!/\.(js|cjs|mjs)$/.test(e.name)) continue;
      const src = readFileSafe(abs);
      if (!src) continue;
      for (const r of relRequires(src)) {
        const target = path.resolve(path.dirname(abs), r);
        const key = target.replace(/\.(js|cjs|mjs)$/, '');
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(path.relative(ROOT, abs).split(path.sep).join('/'));
      }
    }
  };
  for (const r of scanRoots) walk(path.join(ROOT, r));
  return index;
}

// 目标能否在 base 目录下解析（试 +''/'.js'/'.json'/'.node' + 目录 index）
function resolvesAt(baseAbs, spec) {
  const t = path.resolve(baseAbs, spec);
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
  if ([t, t + '.js', t + '.json', t + '.node'].some(isFile)) return true;
  if (isDir(t)) return [path.join(t, 'index.js'), path.join(t, 'index.json')].some(isFile);
  return false;
}

// ⚠ 关键：按【目标解析】而非前缀分类，才能得到真实的「须改边数」。
// 见 [DESIGN-LAY-006] §1.3.1 缺陷 ①：`./` 前缀不等于兄弟边 ——
// 在平铺巨目录里，家族成员的 `./x` 多数指向**父目录**的其他文件，必须升一级。
function classifyEdges(fileRel, familyPrefix) {
  const abs = path.join(ROOT, fileRel);
  const src = readFileSafe(abs);
  if (src === null) return null;
  const dirAbs = path.dirname(abs);
  const familyDir = familyPrefix; // 移动后的新目录（相对父目录的同一层级）
  let mustFix = 0;      // 必须改（出边 ../ + 目标落在父目录的 ./ 边）
  let keepAsIs = 0;     // 保持（真兄弟）
  let brokenNow = 0;    // 当前就指空（历史遗留）
  for (const spec of relRequires(src)) {
    if (spec.startsWith('../')) { mustFix += 1; continue; }   // 深度变了，级数必 +1
    if (!spec.startsWith('./')) continue;
    if (!resolvesAt(dirAbs, spec)) { brokenNow += 1; continue; }
    // 该 ./x 指向的是本目录内的文件（真兄弟）还是父目录？
    // 用「名字是否属于本家族前缀」近似判断目标归属：目标名不以家族前缀开头
    // 且能在父目录解析 ⇒ 它是父目录的引用。
    const tail = spec.replace(/^\.\//, '');
    const targetName = tail.split('/')[0];
    const inFamily = targetName.startsWith(familyPrefix);
    if (inFamily) keepAsIs += 1;
    else mustFix += 1;   // 指向父目录（含目录 index），须升一级
  }
  return { file: fileRel, mustFix, keepAsIs, brokenNow };
}

function analyze(fileRel) {
  const abs = path.join(ROOT, fileRel);
  const src = readFileSafe(abs);
  if (src === null) return null;
  const outs = relRequires(src);
  const externalOuts = outs.filter((r) => r.startsWith('../'));
  const siblingOuts = outs.filter((r) => r.startsWith('./'));
  return {
    file: fileRel,
    bytes: Buffer.byteLength(src),
    lines: src.split('\n').length,
    outgoingTotal: outs.length,
    // 移进子目录后**必然**要改的：所有 `../` 级数 +1
    mustFixOutgoing: externalOuts.length,
    // 兄弟引用：若同批不一起移动则要改；同批移动则保持
    siblingRefs: siblingOuts.length,
    sample: externalOuts.slice(0, 4),
  };
}

const args = process.argv.slice(2);
const mode = args.find((a) => a.startsWith('--mode=')) || '--mode=family';
const prefixArg = args.find((a) => a.startsWith('--prefix='));
const dirArg = args.find((a) => a.startsWith('--dir='));
const dir = dirArg ? dirArg.slice(6) : 'services/backend/src/services';
const prefix = prefixArg ? prefixArg.slice(9) : 'tool';

let ents;
try { ents = fs.readdirSync(path.join(ROOT, dir)); } catch (e) { ents = []; }
const files = ents.filter((f) => f.endsWith('.js') && f.startsWith(prefix) && /^[a-z]/.test(f));

console.log(`扫描 ${dir} 下 ${prefix}* 家族：${files.length} 个文件\n`);
console.log('入边索引构建中（只扫 services/ 与 scripts/）…');
const index = buildInboundIndex(['services', 'scripts', 'apps', 'software', 'platform']);
console.log('索引完成\n');

let totalMustFix = 0;
let totalInbound = 0;
let totalSibling = 0;
const rows = [];
for (const f of files) {
  const rel = `${dir}/${f}`;
  const a = analyze(rel);
  if (!a) continue;
  const key = path.join(ROOT, `${dir}/${f.replace(/\.js$/, '')}`);
  const inbound = (index.get(key) || []).length;
  totalMustFix += a.mustFixOutgoing;
  totalInbound += inbound;
  totalSibling += a.siblingRefs;
  rows.push({ ...a, inbound });
}

rows.sort((a, b) => (b.inbound + b.mustFixOutgoing) - (a.inbound + a.mustFixOutgoing));
console.log('入边  出边(须改)  兄弟  行数  文件');
for (const r of rows) {
  console.log(
    String(r.inbound).padStart(5),
    String(r.mustFixOutgoing).padStart(11),
    String(r.siblingRefs).padStart(6),
    String(r.lines).padStart(6),
    ' ', r.file
  );
}
console.log('\n── 汇总 ──');
console.log('文件数：', rows.length);
console.log('入边总数（壳兜住，0 改动）：', totalInbound);
console.log('出边须改总数（壳救不了）：', totalMustFix);
console.log('兄弟引用总数（同批移动则 0 改动）：', totalSibling);
console.log('需手改的 require 行数（不含壳）：', totalMustFix);
console.log('需新增的壳文件数：', rows.length, '（这批文件每个留一个）');
