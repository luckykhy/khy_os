#!/usr/bin/env node
'use strict';

/**
 * archDebtScan.js — khyos 架构债静态分析器（自定义规则，零外部依赖）
 *
 * 治理报告见 docs/03_DESIGN_设计/[DESIGN-ARCH-020] 架构债治理报告.md。
 *
 * 为什么自研而非 SonarQube/ESLint：本仓奉行「零外部依赖、确定性、可在 CI 离线跑」纪律
 * （同 `khy metadata check`）。本分析器只用 Node 内置模块，扫描三类**架构级**债务：
 *
 *   R1 分层倒置（Layering inversion）：`src/services/**` 反向 require `src/cli/**`。
 *      约定方向是 cli → services；服务层回指 CLI 层是依赖倒置。
 *   R2 巨石文件（God-file）：单文件行数超阈值（默认 2500），混杂过多职责。
 *   R3 循环依赖（Circular require）：相对 require 构成的有向图里的强连通分量(>1)。
 *
 * 只读分析子命令（DESIGN-ARCH-021，不参与默认 CI 退码门禁）：
 *   R4 抽取漂移（Duplication drift）：re-export 助手模块符号，却仍内部调本地同名旧副本。
 *   巨型环切点（Giant-SCC leverage）：逐条 services→cli 反向边的破环杠杆 + 贪心批量顺序。
 *
 * 用法：
 *   node scripts/archDebtScan.js              # 人类可读报告；新增债务(超基线)→ 退出码 1
 *   node scripts/archDebtScan.js --json       # 机器可读 JSON
 *   node scripts/archDebtScan.js --update-baseline   # 把当前违规写入基线(承认现状)
 *   node scripts/archDebtScan.js --drift [--json]    # R4 抽取漂移分析（只读，退码 0）
 *   node scripts/archDebtScan.js --scc   [--json]    # 巨型环切点杠杆分析（只读，退码 0）
 *   node scripts/archDebtScan.js --god-report [--json] # 上帝组件拆分待办（只读，退码 0）
 *
 * 防呆：本工具**只读**扫描，绝不改业务代码。基线机制让 CI 只拦**新增**债务，不因存量
 * 历史债误杀（增量治理，非一刀切）。任何解析异常都跳过该文件而非崩溃。
 */

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(BACKEND_ROOT, 'src');
const BASELINE_FILE = path.join(__dirname, 'arch-debt-baseline.json');

// ── 可调阈值（env 覆盖，零硬编码红线）────────────────────────────────────────
const GOD_FILE_LOC = intEnv('KHY_ARCH_GOD_FILE_LOC', 2500);

function intEnv(name, def) {
  const n = parseInt(String(process.env[name] || ''), 10);
  return Number.isInteger(n) && n > 0 ? n : def;
}

function ratioEnv(name, def) {
  const n = parseFloat(String(process.env[name] || ''));
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : def;
}

// ── 文件遍历 ────────────────────────────────────────────────────────────────
/** 递归收集 dir 下所有 .js 文件（跳过 node_modules / 隐藏目录）。 */
function listJsFiles(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJsFiles(full));
    else if (ent.isFile() && ent.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(BACKEND_ROOT, file).split(path.sep).join('/');
}

/** 提取一个文件里所有 require('...') 的字面量参数 + 行号。 */
function extractRequires(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = text.split('\n');
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i])) !== null) {
      out.push({ spec: m[1], line: i + 1 });
    }
  }
  return out;
}

// ── R1 分层倒置：services → cli ──────────────────────────────────────────────
function scanLayering(srcDir = SRC_DIR) {
  const servicesDir = path.join(srcDir, 'services');
  const files = listJsFiles(servicesDir);
  const violations = [];
  for (const file of files) {
    for (const { spec, line } of extractRequires(file)) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      const relResolved = path.relative(srcDir, resolved).split(path.sep).join('/');
      // 命中 cli/ 即倒置（services 不应回指 cli）
      if (relResolved === 'cli' || relResolved.startsWith('cli/')) {
        violations.push({ file: rel(file), line, target: spec, rule: 'R1-layering' });
      }
    }
  }
  violations.sort((a, b) => (a.file + a.line).localeCompare(b.file + b.line));
  return violations;
}

// ── R2 巨石文件 ─────────────────────────────────────────────────────────────
function scanGodFiles(srcDir = SRC_DIR, threshold = GOD_FILE_LOC) {
  const files = listJsFiles(srcDir);
  const out = [];
  for (const file of files) {
    let loc;
    try { loc = fs.readFileSync(file, 'utf8').split('\n').length; } catch { continue; }
    if (loc > threshold) out.push({ file: rel(file), loc, rule: 'R2-god-file' });
  }
  out.sort((a, b) => b.loc - a.loc);
  return out;
}

// ── God-file 拆分待办（只读，给单人维护者一份可执行的拆分清单）─────────────────
/**
 * 对每个 god file 计算「拆分杠杆」：当前行数、超出上限多少、要拆成几个文件才落到
 * 上限内、以及文件里现成的拆分缝（顶层 function/class 定义数、作者自己画的分节横幅
 * 注释数）。纯读取，零副作用——这是 R2 的「现状承认」到「逐步消解」之间缺的那张
 * 待办表：CI 用基线挡新增，本报告告诉维护者既存的该先拆哪一个、按什么缝拆。
 *
 * @param {string} srcDir
 * @param {number} threshold  god-file 行数上限
 * @returns {Array<{file,loc,overBy,suggestedFiles,topLevelFns,classes,exports,sectionBanners}>}
 */
function scanGodReport(srcDir = SRC_DIR, threshold = GOD_FILE_LOC) {
  const out = [];
  for (const g of scanGodFiles(srcDir, threshold)) {
    const abs = path.join(BACKEND_ROOT, g.file);
    let raw;
    try { raw = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    // 结构层：剥注释、保留字符串，避免把注释/字符串里的 "function"/"class" 误计。
    const struct = _blankNonCode(raw, { blankStrings: false });

    const countMatches = (re) => {
      let n = 0;
      while (re.exec(struct) !== null) n++;
      return n;
    };
    // 顶层定义（行首，无缩进）= 最干净的按职责拆分缝。
    const topLevelFns = countMatches(/^function\s+[A-Za-z_$][\w$]*\s*\(/gm);
    const classes = countMatches(/^class\s+[A-Za-z_$][\w$]*/gm);

    // 导出的对外符号数（module.exports = { ... } 里的键）——拆分后须保持的契约面。
    let exportsCount = 0;
    const me = /module\.exports\s*=\s*\{([^}]*)\}/m.exec(struct);
    if (me) exportsCount = me[1].split(',').map((s) => s.trim()).filter(Boolean).length;

    // 作者自己画的分节横幅注释（// ── … / // === …）= 现成的物理拆分边界。
    const sectionBanners = (raw.match(/^\s*\/\/\s*[─=]{2,}/gm) || []).length;

    out.push({
      file: g.file,
      loc: g.loc,
      overBy: g.loc - threshold,
      threshold,
      suggestedFiles: Math.ceil(g.loc / threshold),
      topLevelFns,
      classes,
      exports: exportsCount,
      sectionBanners,
    });
  }
  // 按超出量降序：超得最多的最该先拆。
  out.sort((a, b) => b.overBy - a.overBy);
  return out;
}

// ── R3 循环依赖（相对 require 构成的有向图 → Tarjan SCC）────────────────────
/** 把 require 的相对 spec 解析为图中的规范文件路径（追加 .js / /index.js）。 */
function resolveModule(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, base + '.js', path.join(base, 'index.js')];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null; // 解析不到（可能是目录无 index 或非 js）→ 不入图
}

function buildRequireGraph(srcDir = SRC_DIR) {
  const files = listJsFiles(srcDir);
  const graph = new Map(); // file → Set<file>
  for (const file of files) graph.set(file, new Set());
  for (const file of files) {
    for (const { spec } of extractRequires(file)) {
      if (!spec.startsWith('.')) continue;
      const target = resolveModule(file, spec);
      if (target && graph.has(target) && target !== file) {
        graph.get(file).add(target);
      }
    }
  }
  return graph;
}

/**
 * Tarjan 强连通分量**核心**：返回**全部**分量（含单点），每个分量是**绝对路径**节点
 * 数组，按算法发现序排列。供 `findCycles`（过滤 size>1 + rel 映射）与 `analyzeGiantScc`
 * （需绝对节点身份以便重算）共用，避免重复实现 Tarjan。显式栈迭代，避免深图爆栈。
 */
function _sccComponents(graph) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const idx = new Map();
  const low = new Map();
  const comps = [];

  const nodes = [...graph.keys()];
  const iterativeStrongConnect = (root) => {
    const work = [{ node: root, i: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const { node } = frame;
      if (frame.i === 0) {
        idx.set(node, index);
        low.set(node, index);
        index++;
        stack.push(node);
        onStack.add(node);
      }
      const succ = graph.has(node) ? [...graph.get(node)] : [];
      if (frame.i < succ.length) {
        const w = succ[frame.i];
        frame.i++;
        if (!idx.has(w)) {
          work.push({ node: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(node, Math.min(low.get(node), idx.get(w)));
        }
      } else {
        if (low.get(node) === idx.get(node)) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            comp.push(w);
          } while (w !== node);
          comps.push(comp);
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].node;
          low.set(parent, Math.min(low.get(parent), low.get(node)));
        }
      }
    }
  };

  for (const n of nodes) if (!idx.has(n)) iterativeStrongConnect(n);
  return comps;
}

/** Tarjan 强连通分量；返回 size>1 的 SCC（= 循环依赖簇），rel 路径并排序。 */
function findCycles(graph) {
  return _sccComponents(graph)
    .filter((comp) => comp.length > 1)
    .map((comp) => comp.map(rel).sort());
}

function scanCycles(srcDir = SRC_DIR) {
  const cycles = findCycles(buildRequireGraph(srcDir));
  return cycles
    .map((members) => ({ members, rule: 'R3-cycle' }))
    .sort((a, b) => a.members.join().localeCompare(b.members.join()));
}

// ── R4 抽取漂移（Duplication drift）：re-export 助手符号却仍调本地同名旧副本 ──────

/**
 * 把源码里的注释（始终）与字符串/模板内容（`blankStrings` 时）替换为等长空白，保留换行
 * 以维持行号与字符偏移 1:1。两种用途共用同一扫描器：
 *   - `blankStrings: false`（默认 false 经 opts 指定）：仅剥注释、**保留字符串** → 用于抽取
 *     `require('./x')` 的 spec、`K: helper.member` 导出映射、`function NAME(` 定义；
 *   - `blankStrings: true`：注释**与**字符串内容都置空 → 用于「函数调用 NAME(」检测，避免
 *     命中注释或字符串字面量里的伪调用。
 * 确定性、零依赖的轻量词法扫描（非完整解析器，足够本规则用；模板插值 `${}` 按字符串保守处理）。
 */
function _blankNonCode(text, opts = {}) {
  const blankStrings = opts.blankStrings !== false; // 默认置空字符串（调用检测语义）
  const out = [];
  let state = 'code'; // code | line | block | sq | dq | tpl
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out.push('  '); i++; continue; }
      if (c === '/' && n === '*') { state = 'block'; out.push('  '); i++; continue; }
      if (c === "'") { state = 'sq'; out.push(c); continue; }
      if (c === '"') { state = 'dq'; out.push(c); continue; }
      if (c === '`') { state = 'tpl'; out.push(c); continue; }
      out.push(c); continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out.push('\n'); } else out.push(' ');
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out.push('  '); i++; }
      else out.push(c === '\n' ? '\n' : ' ');
      continue;
    }
    // 字符串/模板内部：处理转义、识别结束定界符；内容按 blankStrings 决定原样或置空
    if (c === '\\') {
      out.push(blankStrings ? ' ' : c);
      if (n !== undefined) { out.push(blankStrings ? (n === '\n' ? '\n' : ' ') : n); i++; }
      continue;
    }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code'; out.push(c); continue;
    }
    out.push(blankStrings ? (c === '\n' ? '\n' : ' ') : c);
  }
  return out.join('');
}

/**
 * 检出「半截抽取」漂移：一个文件**同时**满足三项证据 → 导出与生产行为分叉：
 *   (1) `module.exports` 把符号 K 映射到**助手模块成员**（`K: helperVar.member`，
 *       helperVar 来自 `const helperVar = require('./relative')`）—— 证明已抽出；
 *   (2) 文件内仍定义了**同名本地函数** `function K(` 或 `function _K(` —— 旧副本还在；
 *   (3) 该本地函数被**裸名内部调用**（`K(`／`_K(`，非 `.K(` 属性访问、非定义行）——
 *       生产代码实际走本地副本，而导出/测试走助手模块。
 * 三证据齐备才记一条（零误报）。纯只读文本分析，零依赖、确定性。
 *
 * 回归基准：`services/toolUseLoop.js` re-export `_parseToolCalls`/`_buildToolResultMessage`
 * 到助手模块，却仍在内部调用本地旧副本（DESIGN-ARCH-020 §R4）。
 */
function scanDriftR4(srcDir = SRC_DIR) {
  const files = listJsFiles(srcDir);
  const out = [];
  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    // 结构层：剥注释、保留字符串 → 抽 require/export/fn（require spec 必须可见）。
    const struct = _blankNonCode(raw, { blankStrings: false });
    // 调用层：注释与字符串均置空 → 仅检真实的 name( 调用（不误命中字面量）。
    const code = _blankNonCode(raw, { blankStrings: true });

    // (a) helper 模块本地变量名：const/let/var X = require('./rel')（仅相对引入）
    const helperVars = new Set();
    const reqRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let rm;
    while ((rm = reqRe.exec(struct)) !== null) helperVars.add(rm[1]);
    if (helperVars.size === 0) continue;

    // (b) re-export 映射：K: helperVar.member（K 为导出符号名）
    const reExported = [];
    const expRe = /([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g;
    let em;
    while ((em = expRe.exec(struct)) !== null) {
      const [, key, obj, member] = em;
      if (helperVars.has(obj)) reExported.push({ key, via: `${obj}.${member}` });
    }
    if (reExported.length === 0) continue;

    // (c) 本地函数定义集合：function NAME(
    const localFns = new Set();
    const fnRe = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    let fm;
    while ((fm = fnRe.exec(struct)) !== null) localFns.add(fm[1]);
    if (localFns.size === 0) continue;

    const seen = new Set();
    for (const { key, via } of reExported) {
      if (seen.has(key)) continue;
      // 候选本地同名：K 本身、去前导下划线、补前导下划线
      const stripped = key.replace(/^_/, '');
      const cands = [key, stripped, '_' + stripped];
      for (const name of cands) {
        if (!localFns.has(name)) continue;
        // 内部裸名调用：name( 且前置非 '.'（排属性访问）、非定义行 function name(
        const callRe = new RegExp(`(^|[^.\\w$])${name}\\s*\\(`, 'g');
        let cm;
        const callLines = [];
        while ((cm = callRe.exec(code)) !== null) {
          const at = cm.index + cm[1].length;
          const before = code.slice(Math.max(0, at - 10), at);
          if (/function\s+$/.test(before)) continue; // 跳过定义处
          callLines.push(code.slice(0, at).split('\n').length);
        }
        if (callLines.length === 0) continue;
        out.push({
          file: rel(file),
          symbol: key,
          localImpl: name,
          reExportVia: via,
          callLines: callLines.slice(0, 12),
          callCount: callLines.length,
          rule: 'R4-drift',
        });
        seen.add(key);
        break;
      }
    }
  }
  out.sort((a, b) => (a.file + '|' + a.symbol).localeCompare(b.file + '|' + b.symbol));
  return out;
}

// ── 巨型环切点分析（read-only 杠杆量化，DESIGN-ARCH-021）─────────────────────

/** 图中最大强连通分量的节点数（含单点上限）。 */
function _giantSizeOf(graph) {
  let max = 0;
  for (const comp of _sccComponents(graph)) if (comp.length > max) max = comp.length;
  return max;
}

/**
 * 对最大强连通分量做「切点杠杆」量化：逐条候选反向边（services→cli，且两端都在巨型
 * SCC 内）临时从图中移除，重算 SCC，记录巨型分量节点数的下降量（leverage）。再贪心地
 * 反复挑当前杠杆最大的边移除，直到巨型环瓦解或单边再无正收益，给出**批量破环顺序**。
 * 纯只读图算法：只在内存中增删边集并即时还原，绝不执行/import 任何业务模块，无写盘副作用。
 */
function analyzeGiantScc(srcDir = SRC_DIR) {
  const graph = buildRequireGraph(srcDir);
  // 分类与展示都用 **srcDir 相对** 标签（同 scanLayering 的 cli/ 判定），真实运行时
  // srcDir=SRC_DIR → 'services/...'、'cli/...'；合成 fixture 同样可判定，可测试。
  const label = (file) => path.relative(srcDir, file).split(path.sep).join('/');
  let giant = [];
  for (const comp of _sccComponents(graph)) if (comp.length > giant.length) giant = comp;
  const giantSize = giant.length;
  if (giantSize < 2) return { giantSize, edgeCount: 0, edges: [], greedy: [], dissolvedAfter: null };

  const giantSet = new Set(giant);
  // 候选反向边：services/** → cli/**，两端都在巨型 SCC 内
  const candidates = [];
  for (const u of giant) {
    if (!/^services\//.test(label(u))) continue;
    for (const v of graph.get(u)) {
      if (!giantSet.has(v)) continue;
      const lv = label(v);
      if (lv === 'cli' || lv.startsWith('cli/')) candidates.push([u, v]);
    }
  }

  // 单边杠杆：移除单条边后巨型分量缩小多少（移除→量测→还原）
  const single = candidates.map(([u, v]) => {
    const had = graph.get(u).delete(v);
    const after = _giantSizeOf(graph);
    if (had) graph.get(u).add(v);
    return { from: label(u), to: label(v), leverage: giantSize - after, giantAfter: after };
  });
  single.sort((a, b) =>
    b.leverage - a.leverage || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // 贪心批量破环：在工作副本上反复移除当前杠杆最大的边，直到巨型环 <2 或无正收益
  const working = new Map();
  for (const [k, set] of graph) working.set(k, new Set(set));
  let remaining = candidates.slice();
  let curGiant = giantSize;
  let dissolvedAfter = null;
  const greedy = [];
  while (remaining.length) {
    let best = null;
    for (const [u, v] of remaining) {
      working.get(u).delete(v);
      const after = _giantSizeOf(working);
      working.get(u).add(v);
      const key = label(u) + '->' + label(v);
      const lev = curGiant - after;
      if (!best || lev > best.lev || (lev === best.lev && key < best.key)) {
        best = { u, v, lev, after, key };
      }
    }
    if (!best || best.lev <= 0) break; // 单边收益耗尽 → 剩余需联合移除（见设计稿批次）
    working.get(best.u).delete(best.v);
    curGiant = best.after;
    greedy.push({ from: label(best.u), to: label(best.v), leverage: best.lev, giantAfter: best.after });
    remaining = remaining.filter(([u, v]) => !(u === best.u && v === best.v));
    if (curGiant < 2) { dissolvedAfter = greedy.length; break; }
  }

  return { giantSize, edgeCount: candidates.length, edges: single, greedy, dissolvedAfter };
}

// ── 汇总 + 基线对比 ─────────────────────────────────────────────────────────
function scanAll(srcDir = SRC_DIR) {
  return {
    layering: scanLayering(srcDir),
    godFiles: scanGodFiles(srcDir),
    cycles: scanCycles(srcDir),
  };
}

function loadBaseline(file = BASELINE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { layering: [], godFiles: [], cycles: [] }; }
}

/** 稳定指纹，用于「新增 vs 基线」对比。 */
function fingerprint(kind, item) {
  if (kind === 'layering') return `${item.file}|${item.target}`; // 行号易抖动，不计入
  if (kind === 'godFiles') return item.file;
  if (kind === 'cycles') return item.members.join('+');
  return JSON.stringify(item);
}

/** 返回 current 里不在 baseline 的新增项（按指纹）。 */
function diffNew(kind, current, baseline) {
  const seen = new Set((baseline[kind] || []).map((b) => fingerprint(kind, b)));
  return current.filter((c) => !seen.has(fingerprint(kind, c)));
}

function computeNew(result, baseline) {
  return {
    layering: diffNew('layering', result.layering, baseline),
    godFiles: diffNew('godFiles', result.godFiles, baseline),
    cycles: diffNewCycles(result, baseline),
  };
}

/**
 * 环维度的「新增」判定 —— 比裸 diffNew 更聪明：剔除「零新增成员的 drift」。
 *
 * 背景：解环 campaign 的常态结局是既存巨型 SCC 被**拆分/收缩**成更小的成环片段。
 * 这些片段的成员全部 ∈ 基线某环（drift 且 added=0），指纹却因成员集变化而不同，
 * 故裸 `diffNew('cycles')` 会把一次**成功的降债**误报成「N 个全新环」而拦死 CI，
 * 恰好惩罚维护者的正确拆分。这里复用 `analyzeCycleDrift`（与 diffNew 同序遍历同一
 * 「非基线指纹」子集）做并行分类：仅当某环是真正的 new，或虽 drift 但**引入了新成员**
 * （added>0，即既存环又缠进了新模块）时，才算回归并拦截。零新增的纯收缩 drift 放行。
 * 纯函数、无副作用。
 */
function diffNewCycles(result, baseline) {
  const candidates = diffNew('cycles', result.cycles, baseline);
  const drift = analyzeCycleDrift(result, baseline); // 同序、同子集（见 analyzeCycleDrift）
  return candidates.filter((c, i) => {
    const d = drift[i];
    if (!d) return true; // 分类缺失 → 保守判为回归
    if (d.kind === 'new') return true; // 真正的新独立环
    return (d.added || []).length > 0; // drift 但缠进新成员才算回归；纯收缩放行
  });
}

/**
 * 把「指纹已变的新环」细分为 'drift'（与基线某环过半重叠＝既存 SCC 漂移/增长）
 * 与 'new'（与任何基线环零/低重叠＝真正新独立环）。
 *
 * 动机：环指纹是全体成员 `members.join('+')`，故既存巨型 SCC 哪怕只累积 1 个成员，
 * 整环都会被 `computeNew` 判成「新增」——把 74→82 的成员漂移误报成「全新 82 节点环」，
 * 误导单人维护者以为亲手引入了一个庞大新环。本函数按成员集重叠还原真相：drift 给出
 * 增/删的具体模块（长期结构债累积，需解环 campaign），new 才是应立即解开的新缠绕。
 * 纯函数、无副作用。
 *
 * @param {object} result   scanAll() 结果
 * @param {object} baseline loadBaseline() 结果
 * @param {object} [opts]   overlapThreshold：判为 drift 的最小重叠占比（默认 0.5）
 * @returns {Array<{kind:'drift'|'new', curSize:number, baseSize:number, added:string[], removed:string[]}>}
 */
function analyzeCycleDrift(result, baseline, {
  overlapThreshold = 0.5,
  containmentThreshold = ratioEnv('KHY_ARCH_CYCLE_CONTAINMENT_RATIO', 0.5),
} = {}) {
  const curCycles = result.cycles || [];
  const baseCycles = baseline.cycles || [];
  const baseFps = new Set(baseCycles.map((c) => fingerprint('cycles', c)));
  const out = [];
  for (const c of curCycles) {
    if (baseFps.has(fingerprint('cycles', c))) continue; // 指纹未变 = 非新增，跳过
    const cm = new Set(c.members || []);
    let best = null;
    let bestOverlap = 0;
    for (const b of baseCycles) {
      const overlap = (b.members || []).filter((m) => cm.has(m)).length;
      if (overlap > bestOverlap) { bestOverlap = overlap; best = b; }
    }
    const baseSize = best ? (best.members || []).length : 0;
    const curSize = (c.members || []).length;
    const ratio = baseSize ? bestOverlap / baseSize : 0;
    // 解环 campaign 的常态结局是把既存巨型 SCC **拆分/缩小**成更小的片段——其中仍成环的片段
    // 绝大多数成员仍来自基线既存环。判定「这是已承认债在收缩重组，还是真正新引入的独立环」，
    // 正确的度量是**当前环里有多少比例来自基线**（bestOverlap/curSize，containment），而非
    // overlap/baseSize——后者随解耦推进 curSize 下降而必然走低，会把成功的降债反误报成新环、
    // 恰好惩罚维护者的正确拆分（增量13 实测：37 节点片段中 36 个 ∈ 基线，仅 1 个既存 accretion，
    // 占基线比 36/74=0.49 跌破阈值，但 containment 36/37=0.97 显属既存债收缩）。故按 containment
    // 判 drift：当前环主体由基线成员构成（≥containmentThreshold，默认 0.5）即归 drift。真正的新环
    // 含极少/零基线成员，containment 低，仍走 new，新环检出力一字未减。完全包含（=1.0）是其特例。
    const containment = curSize ? bestOverlap / curSize : 0;
    if (best && (ratio >= overlapThreshold || containment >= containmentThreshold)) {
      const bm = new Set(best.members || []);
      const added = (c.members || []).filter((m) => !bm.has(m));
      const removed = (best.members || []).filter((m) => !cm.has(m));
      out.push({ kind: 'drift', curSize, baseSize, added, removed });
    } else {
      out.push({ kind: 'new', curSize: (c.members || []).length, baseSize: 0, added: c.members || [], removed: [] });
    }
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function formatReport(result, neu) {
  const L = [];
  L.push('khyos 架构债扫描 (archDebtScan)');
  L.push('='.repeat(48));
  L.push(`R1 分层倒置 services→cli : ${result.layering.length} 处`);
  L.push(`R2 巨石文件 (>${GOD_FILE_LOC} 行) : ${result.godFiles.length} 个`);
  L.push(`R3 循环依赖簇            : ${result.cycles.length} 个`);
  L.push('');
  if (result.godFiles.length) {
    L.push('— 巨石文件 (按行数降序) —');
    for (const g of result.godFiles) L.push(`  ${String(g.loc).padStart(6)}  ${g.file}`);
    L.push('');
  }
  if (result.cycles.length) {
    L.push('— 循环依赖 —');
    for (const c of result.cycles) L.push(`  ${c.members.join('  ⇄  ')}`);
    L.push('');
  }
  if (result.layering.length) {
    L.push('— 分层倒置 (services 反向依赖 cli) —');
    for (const v of result.layering) L.push(`  ${v.file}:${v.line} → ${v.target}`);
    L.push('');
  }
  const newCount = neu.layering.length + neu.godFiles.length + neu.cycles.length;
  if (newCount > 0) {
    L.push(`⚠️  超出基线的【新增】架构债: ${newCount} 项 — CI 门禁失败`);
    for (const v of neu.layering) L.push(`  + [R1] ${v.file}:${v.line} → ${v.target}`);
    for (const g of neu.godFiles) L.push(`  + [R2] ${g.file} (${g.loc} 行)`);
    for (const c of neu.cycles) L.push(`  + [R3] ${c.members.join(' ⇄ ')}`);
  } else {
    L.push('✅ 无超出基线的新增架构债。');
  }
  return L.join('\n');
}

/** R4 抽取漂移人类可读报告。 */
function formatDriftReport(items) {
  const L = [];
  L.push('khyos R4 抽取漂移扫描 (scanDriftR4)');
  L.push('='.repeat(48));
  L.push(`半截抽取漂移点: ${items.length} 处（re-export 助手符号，却仍调本地旧副本）`);
  L.push('');
  for (const it of items) {
    L.push(`  ${it.file}`);
    L.push(`    符号 ${it.symbol}：导出走 ${it.reExportVia}，但本地 ${it.localImpl}() 被内部调用 ${it.callCount} 次`);
    L.push(`    本地调用行: ${it.callLines.join(', ')}${it.callCount > it.callLines.length ? ' …' : ''}`);
  }
  if (!items.length) L.push('✅ 未发现 re-export 与本地副本分叉。');
  return L.join('\n');
}

/** 巨型环切点分析人类可读报告。 */
function formatSccReport(scc) {
  const L = [];
  L.push('khyos 巨型环切点分析 (analyzeGiantScc)');
  L.push('='.repeat(48));
  L.push(`最大强连通分量: ${scc.giantSize} 节点`);
  L.push(`候选反向边 services→cli (环内): ${scc.edgeCount || 0} 条`);
  L.push('');
  if (scc.edges.length) {
    L.push('— 单边杠杆 (移除后巨型环缩小的节点数，降序) —');
    for (const e of scc.edges) {
      L.push(`  ${String(e.leverage).padStart(4)}  ${e.from} → ${e.to}  (巨型环 ${scc.giantSize}→${e.giantAfter})`);
    }
    L.push('');
  }
  L.push('— 贪心批量破环顺序 —');
  if (scc.greedy.length) {
    let i = 1;
    for (const g of scc.greedy) {
      L.push(`  ${i++}. 移除 ${g.from} → ${g.to}  → 巨型环降至 ${g.giantAfter} (−${g.leverage})`);
    }
    L.push(scc.dissolvedAfter
      ? `  巨型环在移除 ${scc.dissolvedAfter} 条边后瓦解。`
      : '  单边贪心收益耗尽：剩余节点需联合移除（见 DESIGN-ARCH-021 批次设计）。');
  } else {
    L.push('  无正收益单边：巨型环为强耦合块，须联合移除多条反向边（见设计稿）。');
  }
  return L.join('\n');
}

/** God-file 拆分待办人类可读报告（按超出量降序，最该先拆的在最前）。 */
function formatGodReport(items, threshold = GOD_FILE_LOC) {
  const L = [];
  L.push('khyos 上帝组件拆分待办 (scanGodReport)');
  L.push('='.repeat(56));
  L.push(`单文件行数上限: ${threshold}（KHY_ARCH_GOD_FILE_LOC 可调）`);
  L.push(`超限文件: ${items.length} 个`);
  L.push('');
  if (!items.length) {
    L.push('✅ 没有上帝组件——所有源文件都在上限内。');
    return L.join('\n');
  }
  L.push('排名  行数 / 超出   建议拆成   现成拆分缝（顶层fn · class · 导出 · 分节横幅）');
  L.push('-'.repeat(56));
  let i = 1;
  for (const it of items) {
    L.push(
      `${String(i++).padStart(3)}. ${String(it.loc).padStart(5)} / +${String(it.overBy).padStart(4)}` +
      `   →${String(it.suggestedFiles).padStart(2)} 个文件` +
      `   fn:${it.topLevelFns} · class:${it.classes} · exports:${it.exports} · 横幅:${it.sectionBanners}`,
    );
    L.push(`       ${it.file}`);
  }
  L.push('');
  L.push('拆法：优先沿「分节横幅」把顶层函数按职责搬进聚焦模块（如 *.routes.js /');
  L.push('*.service.js），在原文件 re-export 保契约不变；逐个降到上限内即可清出基线。');
  return L.join('\n');
}

function main(argv = process.argv.slice(2)) {
  // 新增只读子命令：不参与默认 CI 退码门禁，始终退码 0（除解析异常）。
  if (argv.includes('--drift')) {
    const items = scanDriftR4();
    process.stdout.write((argv.includes('--json')
      ? JSON.stringify({ drift: items }, null, 2)
      : formatDriftReport(items)) + '\n');
    return 0;
  }
  if (argv.includes('--scc')) {
    const scc = analyzeGiantScc();
    process.stdout.write((argv.includes('--json')
      ? JSON.stringify({ scc }, null, 2)
      : formatSccReport(scc)) + '\n');
    return 0;
  }
  if (argv.includes('--god-report')) {
    const items = scanGodReport();
    process.stdout.write((argv.includes('--json')
      ? JSON.stringify({ godReport: items }, null, 2)
      : formatGodReport(items)) + '\n');
    return 0;
  }

  const result = scanAll();

  if (argv.includes('--update-baseline')) {
    const baseline = {
      _comment: 'archDebtScan 基线：已承认的存量架构债。CI 只拦截不在此列的新增项。用 --update-baseline 刷新。',
      _generated: 'deterministic (no timestamp)',
      layering: result.layering,
      godFiles: result.godFiles,
      cycles: result.cycles,
    };
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
    process.stdout.write(`基线已更新: ${rel(BASELINE_FILE)}\n`);
    return 0;
  }

  const baseline = loadBaseline();
  const neu = computeNew(result, baseline);

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ result, new: neu }, null, 2) + '\n');
  } else {
    process.stdout.write(formatReport(result, neu) + '\n');
  }

  const newCount = neu.layering.length + neu.godFiles.length + neu.cycles.length;
  return newCount > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  listJsFiles,
  extractRequires,
  scanLayering,
  scanGodFiles,
  scanGodReport,
  buildRequireGraph,
  _sccComponents,
  findCycles,
  scanCycles,
  _blankNonCode,
  scanDriftR4,
  analyzeGiantScc,
  scanAll,
  loadBaseline,
  diffNew,
  diffNewCycles,
  computeNew,
  analyzeCycleDrift,
  fingerprint,
  formatReport,
  formatDriftReport,
  formatSccReport,
  formatGodReport,
  main,
  SRC_DIR,
  BASELINE_FILE,
  GOD_FILE_LOC,
};
