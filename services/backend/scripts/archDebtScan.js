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
 * R2b 巨石增长门禁（T-016 可维护性护栏）：基线已承认的巨石文件若比基线**更长** → 违规。
 *   存量债只许减不许增——R2 用「新文件」拦新增，R2b 用「行数比对」拦存量增长。
 *
 * --changed 模式（改动文件体积分级，T-016）：
 *   新增/修改的 src/**.js 超过 800 行 → error（阻断）；超过 500 行 → warning。
 *   已在巨石基线里的文件豁免本分级（它们由 R2b 管增长，不重复拦）。
 *
 * 用法：
 *   node scripts/archDebtScan.js              # 人类可读报告；新增债务(超基线)→ 退出码 1
 *   node scripts/archDebtScan.js --json       # 机器可读 JSON
 *   node scripts/archDebtScan.js --update-baseline   # 把当前违规写入基线(承认现状)
 *   node scripts/archDebtScan.js --drift [--json]    # R4 抽取漂移分析（只读，退码 0）
 *   node scripts/archDebtScan.js --scc   [--json]    # 巨型环切点杠杆分析（只读，退码 0）
 *   node scripts/archDebtScan.js --god-report [--json] # 上帝组件拆分待办（只读，退码 0）
 *   node scripts/archDebtScan.js --baseline-stale [--json] # 基线悬空检测（只读，退码 0）
 *   node scripts/archDebtScan.js --changed [--strict-warnings] # 改动文件体积分级（R2b 同样生效）
 *
 * 防呆：本工具**只读**扫描，绝不改业务代码。基线机制让 CI 只拦**新增**债务，不因存量
 * 历史债误杀（增量治理，非一刀切）。任何解析异常都跳过该文件而非崩溃。
 */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(BACKEND_ROOT, 'src');
const BASELINE_FILE = path.join(__dirname, 'arch-debt-baseline.json');

// ── 可调阈值（env 覆盖，零硬编码红线）────────────────────────────────────────
const GOD_FILE_LOC = intEnv('KHY_ARCH_GOD_FILE_LOC', 2500);
const CHANGED_FILE_LOC_MAX = intEnv('KHY_ARCH_CHANGED_FILE_LOC', 800);
const CHANGED_FILE_WARN_LOC = intEnv('KHY_ARCH_CHANGED_FILE_WARN', 500);

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
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
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

/**
 * 把一个 JS 源文件里的注释区域替换为等长空白（保留换行与列位置）。
 *
 * 为什么必须做：`extractRequires` 是逐行正则，**分不清代码与注释**。
 * 结果是一份「描述某个倒置」的文档注释本身被算成倒置——
 * 实测 `domain/extensions/extensions/markdownWorkbench.js:10`，
 * 它的存在意义正是消除这条倒置，却因为注释里引用了解法而被 R1 报出。
 * 判据错了就要修判据，不该去改注释里的措辞（否则等于让文档为工具让路）。
 *
 * 覆盖：`//` 行注释、`/* … *\/` 块注释、以及字符串里的 `//`（避免把 URL 当注释）。
 * 不做完整词法分析——对「找 require 字面量」这个用途，状态机足够了。
 *
 * @param {string} text
 * @returns {string} 同长度文本，注释区间被空格填掉
 */
function stripComments(text) {
  const out = text.split('');
  let i = 0;
  const n = text.length;
  // state: 0=code 1=line-comment 2=block-comment 3=single-quote 4=double-quote 5=template
  let state = 0;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (state === 0) {
      if (c === '/' && c2 === '/') { state = 1; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 2; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === "'") { state = 3; i += 1; continue; }
      if (c === '"') { state = 4; i += 1; continue; }
      if (c === '`') { state = 5; i += 1; continue; }
      i += 1;
      continue;
    }
    if (state === 1) { // 行注释：吃到换行为止
      if (c === '\n') { state = 0; i += 1; continue; }
      out[i] = ' '; i += 1; continue;
    }
    if (state === 2) { // 块注释
      if (c === '*' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; state = 0; i += 2; continue; }
      if (c !== '\n') out[i] = ' ';
      i += 1; continue;
    }
    // 字符串态：只消处理转义与闭合（不把串内的 require(...) 当调用——
    // 但保留内容不动，因为 require('x') 的字面量本身就在串里，那是语法结构不是注释）
    if (state === 3 || state === 4) {
      const quote = state === 3 ? "'" : '"';
      if (c === '\\') { i += 2; continue; }
      if (c === quote) { state = 0; i += 1; continue; }
      if (c === '\n') { state = 0; i += 1; continue; } // 未闭合的串，容错回代码态
      i += 1; continue;
    }
    if (state === 5) { // 模板串：处理转义与 ${} 内的嵌套
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { state = 0; i += 1; continue; }
      i += 1; continue;
    }
    i += 1;
  }
  return out.join('');
}

/** 提取一个文件里所有 require('...') 的字面量参数 + 行号（忽略注释中的伪调用）。 */
function extractRequires(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  // 行号必须来自原文，所以先按原文切行、逐行判注释态，再在「净文本」行上跑正则。
  const rawLines = text.split('\n');
  const cleanLines = stripComments(text).split('\n');
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const out = [];
  for (let i = 0; i < cleanLines.length; i++) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(cleanLines[i])) !== null) {
      out.push({ spec: m[1], line: i + 1, raw: rawLines[i] });
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
    try {
      loc = fs.readFileSync(file, 'utf8').split('\n').length;
    } catch {
      continue;
    }
    if (loc > threshold) out.push({ file: rel(file), loc, rule: 'R2-god-file' });
  }
  out.sort((a, b) => b.loc - a.loc);
  return out;
}

// ── R2b 巨石增长：基线已承认的巨石不许比基线更长 ─────────────────────────────
/**
 * 存量巨石增长门禁。R2 只拦「新出现的巨石文件」，拦不住「既存巨石继续长」——
 * 基线指纹仅含文件名（diffNew 对 godFiles 按 file 比对），长到 2 万行也无人知晓。
 * 本规则按「当前 loc vs 基线 loc」直接比对补上这个洞：delta>0 即违规。
 * 基线条目缺 loc（旧格式）时跳过——无法比对就诚实不报，绝不猜。
 *
 * @param {{godFiles:Array<{file:string,loc:number}>}} result  scanAll() 结果
 * @param {{godFiles?:Array<{file:string,loc?:number}>}} baseline loadBaseline() 结果
 * @returns {Array<{file,loc,baselineLoc,delta,rule:'R2b-god-growth'}>} 按超出量降序
 */
function scanGodGrowth(result, baseline) {
  const baseLoc = new Map();
  for (const g of baseline.godFiles || []) {
    if (g && typeof g.file === 'string' && Number.isInteger(g.loc)) baseLoc.set(g.file, g.loc);
  }
  const out = [];
  for (const g of result.godFiles || []) {
    const base = baseLoc.get(g.file);
    if (base !== undefined && g.loc > base) {
      out.push({
        file: g.file,
        loc: g.loc,
        baselineLoc: base,
        delta: g.loc - base,
        rule: 'R2b-god-growth',
      });
    }
  }
  out.sort((a, b) => b.delta - a.delta);
  return out;
}

/**
 * 改动文件体积分级（纯函数，供 --changed 模式与单测共用）。
 * 已在巨石基线里的文件豁免（exempt）——它们由 R2b 管增长，此分级不再重复拦，
 * 否则任何对 replSession.js 的改动都会被 800 行红线挡死，拆分工作无法进行。
 *
 * @param {number} loc 当前行数
 * @param {{exempt?:boolean}} [opts]
 * @returns {'exempt'|'error'|'warning'|'ok'}
 */
function classifyChangedLoc(loc, opts = {}) {
  if (opts.exempt) return 'exempt';
  if (loc > CHANGED_FILE_LOC_MAX) return 'error';
  if (loc > CHANGED_FILE_WARN_LOC) return 'warning';
  return 'ok';
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
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
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
    if (me)
      exportsCount = me[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean).length;

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
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* next */
    }
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
      if (c === '/' && n === '/') {
        state = 'line';
        out.push('  ');
        i++;
        continue;
      }
      if (c === '/' && n === '*') {
        state = 'block';
        out.push('  ');
        i++;
        continue;
      }
      if (c === "'") {
        state = 'sq';
        out.push(c);
        continue;
      }
      if (c === '"') {
        state = 'dq';
        out.push(c);
        continue;
      }
      if (c === '`') {
        state = 'tpl';
        out.push(c);
        continue;
      }
      out.push(c);
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out.push('\n');
      } else out.push(' ');
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'code';
        out.push('  ');
        i++;
      } else out.push(c === '\n' ? '\n' : ' ');
      continue;
    }
    // 字符串/模板内部：处理转义、识别结束定界符；内容按 blankStrings 决定原样或置空
    if (c === '\\') {
      out.push(blankStrings ? ' ' : c);
      if (n !== undefined) {
        out.push(blankStrings ? (n === '\n' ? '\n' : ' ') : n);
        i++;
      }
      continue;
    }
    if (
      (state === 'sq' && c === "'") ||
      (state === 'dq' && c === '"') ||
      (state === 'tpl' && c === '`')
    ) {
      state = 'code';
      out.push(c);
      continue;
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
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // 结构层：剥注释、保留字符串 → 抽 require/export/fn（require spec 必须可见）。
    const struct = _blankNonCode(raw, { blankStrings: false });
    // 调用层：注释与字符串均置空 → 仅检真实的 name( 调用（不误命中字面量）。
    const code = _blankNonCode(raw, { blankStrings: true });

    // (a) helper 模块本地变量名：const/let/var X = require('./rel')（仅相对引入）
    const helperVars = new Set();
    const reqRe =
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
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
  if (giantSize < 2)
    return { giantSize, edgeCount: 0, edges: [], greedy: [], dissolvedAfter: null };

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
  single.sort(
    (a, b) => b.leverage - a.leverage || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  );

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
    greedy.push({
      from: label(best.u),
      to: label(best.v),
      leverage: best.lev,
      giantAfter: best.after,
    });
    remaining = remaining.filter(([u, v]) => !(u === best.u && v === best.v));
    if (curGiant < 2) {
      dissolvedAfter = greedy.length;
      break;
    }
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
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { layering: [], godFiles: [], cycles: [] };
  }
}

/**
 * 基线悬空检测（T-016 追加，2026-09-22）—— 基线里指向**已不存在路径**的条目。
 *
 * ## 为什么需要它（一次真实的静默失效）
 *
 * 域迁移（`src/services/foo.js` → `src/services/domain/<域>/…/foo.js`）时，
 * 基线条目的 `file` 字段**不会自动跟着改**。此时：
 *   1. 该文件在扫描结果里的**指纹变了**（`file|target` 里的 file 变了）⇒
 *      基线里那条旧指纹**永不匹配** ⇒ `diffNew` 把它误判为**新增**；
 *   2. 但同时，基线里那条**悬空旧条目**又永远不会被触发，于是「存量债只降不升」
 *      的棘轮在该文件上**完全失效**——存量可以随便涨，基线看不见。
 *
 * 实测（2026-09-22）：基线 `layering` 38 条里 **12 条悬空**，涉及 5 个已迁入
 * `domain/` 的文件；`new.layering` 因此恒为 22（真新增 10 + 迁移造成的假新增 12）。
 * 这正是本扫描器**至今无法接进 CI 门**的根因——接进去就会立刻爆 12 条假红，
 * 而维护者会误以为是「域迁移引入了 12 处新分层倒置」。
 *
 * ⇒ 本节把「基线诚实性」变成**可检测、可回归**的：基线条目指向不存在的文件时
 * 显式报出（而不是静默假红/静默放行）。配合 `--update-baseline` 刷新即可自愈。
 *
 * 纯函数、无副作用、零 IO 之外只做 existsSync。
 *
 * @param {object} baseline loadBaseline() 结果
 * @param {string} [srcRoot] 源码根（默认 BACKEND_ROOT），用于解析基线里的相对路径
 * @returns {Array<{kind:string, file:string, reason:string}>}
 */
function findStaleBaselineEntries(baseline, srcRoot = BACKEND_ROOT) {
  const out = [];
  const kinds = ['layering', 'godFiles'];
  for (const kind of kinds) {
    for (const item of baseline[kind] || []) {
      const rel = item && item.file;
      if (!rel) continue;
      // 基线里的路径相对 BACKEND_ROOT（archDebtScan 的工作根），非相对 src/。
      const abs = path.join(srcRoot, rel);
      if (!fs.existsSync(abs)) {
        out.push({
          kind,
          file: rel,
          reason: '基线条目指向的文件不存在（疑似域迁移/重命名后未刷新基线）',
        });
      }
    }
  }
  return out;
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
    godGrowth: scanGodGrowth(result, baseline),
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
function analyzeCycleDrift(
  result,
  baseline,
  {
    overlapThreshold = 0.5,
    containmentThreshold = ratioEnv('KHY_ARCH_CYCLE_CONTAINMENT_RATIO', 0.5),
  } = {}
) {
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
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = b;
      }
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
      out.push({
        kind: 'new',
        curSize: (c.members || []).length,
        baseSize: 0,
        added: c.members || [],
        removed: [],
      });
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
  const newCount =
    neu.layering.length + neu.godFiles.length + neu.godGrowth.length + neu.cycles.length;
  if (newCount > 0) {
    L.push(`⚠️  超出基线的【新增】架构债: ${newCount} 项 — CI 门禁失败`);
    for (const v of neu.layering) L.push(`  + [R1] ${v.file}:${v.line} → ${v.target}`);
    for (const g of neu.godFiles) L.push(`  + [R2] ${g.file} (${g.loc} 行)`);
    for (const g of neu.godGrowth)
      L.push(
        `  + [R2b] ${g.file} 增长 ${g.delta} 行 (${g.baselineLoc} → ${g.loc}) — 存量巨石只许减不许增`
      );
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
    L.push(
      `    符号 ${it.symbol}：导出走 ${it.reExportVia}，但本地 ${it.localImpl}() 被内部调用 ${it.callCount} 次`
    );
    L.push(
      `    本地调用行: ${it.callLines.join(', ')}${it.callCount > it.callLines.length ? ' …' : ''}`
    );
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
      L.push(
        `  ${String(e.leverage).padStart(4)}  ${e.from} → ${e.to}  (巨型环 ${scc.giantSize}→${e.giantAfter})`
      );
    }
    L.push('');
  }
  L.push('— 贪心批量破环顺序 —');
  if (scc.greedy.length) {
    let i = 1;
    for (const g of scc.greedy) {
      L.push(`  ${i++}. 移除 ${g.from} → ${g.to}  → 巨型环降至 ${g.giantAfter} (−${g.leverage})`);
    }
    L.push(
      scc.dissolvedAfter
        ? `  巨型环在移除 ${scc.dissolvedAfter} 条边后瓦解。`
        : '  单边贪心收益耗尽：剩余节点需联合移除（见 DESIGN-ARCH-021 批次设计）。'
    );
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
        `   fn:${it.topLevelFns} · class:${it.classes} · exports:${it.exports} · 横幅:${it.sectionBanners}`
    );
    L.push(`       ${it.file}`);
  }
  L.push('');
  L.push('拆法：优先沿「分节横幅」把顶层函数按职责搬进聚焦模块（如 *.routes.js /');
  L.push('*.service.js），在原文件 re-export 保契约不变；逐个降到上限内即可清出基线。');
  return L.join('\n');
}

/** --baseline-stale / 默认报告的「基线悬空」节。 */
function formatStaleBaselineReport(items) {
  const L = [];
  L.push('khyos 基线悬空检测 (baseline staleness)');
  L.push('='.repeat(48));
  L.push(`悬空条目: ${items.length} 条`);
  L.push('');
  if (!items.length) {
    L.push('✅ 基线全部指向现存文件——棘轮语义可信。');
    return L.join('\n');
  }
  for (const it of items) {
    L.push(`  ✗ [${it.kind}] ${it.file}`);
  }
  L.push('');
  L.push('⚠ 危害：悬空条目**永不匹配**当前扫描指纹 ⇒ 该文件被误判为「新增」，');
  L.push('  同时它的存量增长不再受棘轮约束（可用「假绿」与「假红」两个方向同时失真）。');
  L.push('  典型诱因：域迁移（src/services/x.js → src/services/domain/<域>/…/x.js）后未刷新基线。');
  L.push('  处置：核对每条确属迁移而非真删除，然后 `--update-baseline` 刷新。');
  return L.join('\n');
}

// ── --changed 模式：改动文件体积分级（T-016 可维护性护栏）─────────────────────
/**
 * 与 check-agent-rules.js 的 listChangedFiles() 同一取数契约：
 * GIT_BASE_REF（CI）→ staged → HEAD，core.quotePath=false 保中文路径可解析。
 * git 完全不可用时返回 **null**（与「无改动」区分）——调用方必须诚实失败，绝不假绿。
 *
 * **[2026-09-22 修复] 显式并入未跟踪文件**：旧取数契约里**没有** `ls-files --others`，
 * 于是新文件（`??`）在本门禁里**完全不可见**——新建一个 2000 行的超大文件，
 * `--changed` 会报「改动文件体积全部达标」。实测 2026-09-22：工作区有 61 个
 * `services/backend/src/**.js` 未跟踪新文件（含 445 行的 `handlers/commit.js`）
 * 全部逃过本门禁。这与「新增/修改的 src/**.js 超过 800 行 → error」的规则语义
 * **直接矛盾**：拦的恰恰该是新增文件。
 *
 * **[2026-09-22 修复·第二处] 路径基准归一**：`git ls-files --others` 按 **cwd**
 * （= `BACKEND_ROOT`）输出**相对 backend 的**路径（`src/cli/x.js`），而 `diff --name-only`
 * 家族按 **仓库根**输出（`services/backend/src/cli/x.js`）。若直接混用，未跟踪文件会
 * 因不满足调用方的 `startsWith('services/backend/')` 而被**静默跳过**——修了取数却仍假绿。
 * 故此处统一把 others 的输出**前缀补成仓库根相对路径**（`R`），与 diff 家族对齐。
 * `--full-name` 在旧版 git 上对 others 不生效，故用显式前缀而非依赖该选项。
 *
 * 注意未跟踪文件**只在「无 staged / 无 HEAD diff」时才需要补**：正常提交流里
 * 新文件会先被 `git add`（进 `--cached`），此时它已在集合里，补一次是幂等去重。
 * 三道取数按优先级短路返回，故把 others 并入**首个非空结果**而非单独一支，
 * 避免改变「GIT_BASE_REF 优先」的既有语义。
 *
 * @returns {string[]|null} **相对仓库根**的改动文件路径列表；无法确定时 null
 */
function listChangedFiles() {
  const git = 'git -c core.quotePath=false';
  const opts = { cwd: BACKEND_ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' };
  const run = (cmd) => {
    try {
      return cp.execSync(cmd, opts).trim();
    } catch {
      return '';
    }
  };
  const split = (out) => out.split('\n').map((s) => s.trim()).filter(Boolean);
  /**
   * BACKEND_ROOT 相对仓库根的路径前缀（如 `services/backend/`），**带尾斜杠**。
   * 用 git 自己算（`ls-files` 的输出基准就是仓库根），不猜目录深度：
   * `git rev-parse --show-prefix` 在子目录里返回该目录相对仓库根的前缀，正是所需。
   * 取不到时（不在 git 工作树、git 不可用）退化为空串 —— 此时 others 的输出
   * 保持原样，宁可漏补前缀也不拼错路径（拼错会产生「不存在的长路径」）。
   */
  const computeRepoPrefix = () => {
    const out = run(`${git} rev-parse --show-prefix`);
    return out ? out.replace(/\\/g, '/') : '';
  };
  const repoPrefix = computeRepoPrefix();
  const toRepoRel = (p) => {
    const norm = p.replace(/\\/g, '/');
    if (!repoPrefix) return norm;
    // git 在 BACKEND_ROOT 下输出的是相对 backend 的路径；若已带前缀则原样返回（幂等）。
    if (norm.startsWith(repoPrefix)) return norm;
    return repoPrefix + norm;
  };
  /** 未跟踪文件（尊重 .gitignore：--exclude-standard 不把被忽略文件当改动）。 */
  const others = () => {
    const out = run(`${git} ls-files --others --exclude-standard`);
    return out ? split(out).map(toRepoRel) : [];
  };
  const baseRef = String(process.env.GIT_BASE_REF || '').trim();
  if (baseRef) {
    const out = run(`${git} diff --name-only --diff-filter=ACMR ${baseRef}...HEAD`);
    if (out) return mergeUnique(split(out), others());
  }
  const staged = run(`${git} diff --name-only --cached --diff-filter=ACMR`);
  if (staged) return mergeUnique(split(staged), others());
  const head = run(`${git} diff --name-only --diff-filter=ACMR HEAD`);
  if (head) return mergeUnique(split(head), others());
  // 工作区完全干净但存在未跟踪文件时，也应如实返回它们（而非 null=无法确定）。
  const untracked = others();
  if (untracked.length) return untracked;
  return null;
}

/** 有序去重合并（保持 first 的顺序，再追加 b 中未出现者）。 */
function mergeUnique(a, b) {
  const seen = new Set(a);
  const out = [...a];
  for (const x of b) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/** --changed 模式人类可读报告。 */
function formatChangedReport({ errors, warnings, exempt, scanned, undetermined }) {
  const L = [];
  L.push('khyos 改动文件体积门禁 (archDebtScan --changed)');
  L.push('='.repeat(48));
  L.push(
    `改动且已扫描的 src/**.js: ${scanned} 个  ` +
      `(error >${CHANGED_FILE_LOC_MAX} 行 / warning >${CHANGED_FILE_WARN_LOC} 行 / 基线巨石豁免)`
  );
  L.push('');
  for (const e of errors) L.push(`  ✗ [error]   ${e.file} (${e.loc} 行) — 新文件/改动文件超过 ${CHANGED_FILE_LOC_MAX} 行上限`);
  for (const w of warnings) L.push(`  ⚠ [warning] ${w.file} (${w.loc} 行) — 超过 ${CHANGED_FILE_WARN_LOC} 行，建议拆分`);
  for (const x of exempt) L.push(`  · [exempt]  ${x.file} (${x.loc} 行) — 已在巨石基线，由 R2b 管增长`);
  L.push('');
  if (errors.length) {
    L.push(`✗ ${errors.length} 个改动文件超过 ${CHANGED_FILE_LOC_MAX} 行 — 门禁失败。`);
    L.push('  请按职责拆为聚焦模块（原文件保留 re-export 薄 facade 保契约不变）。');
  } else if (undetermined) {
    L.push('✗ 无法用 git 确定改动集（git 不可用或空仓库？）——未扫描即不假绿。');
  } else if (warnings.length) {
    L.push(`⚠ ${warnings.length} 个改动文件超过 ${CHANGED_FILE_WARN_LOC} 行（warning 级；--strict-warnings 时阻断）。`);
  } else {
    L.push('✅ 改动文件体积全部达标。');
  }
  return L.join('\n');
}

/**
 * --changed 门禁主流程。返回进程退出码：error>0 或（--strict-warnings 且 warning>0）→ 1。
 * 扫描范围与 R2 一致（services/backend/src/**.js）；基线巨石文件豁免分级。
 */
function runChangedGate(argv = []) {
  const changed = listChangedFiles();
  const undetermined = changed === null;
  const list = changed || [];
  const prefix = 'services/backend/';
  const baseline = loadBaseline();
  const baseGod = new Set((baseline.godFiles || []).map((g) => g.file));
  const errors = [];
  const warnings = [];
  const exempt = [];
  let scanned = 0;
  for (const relPath of list) {
    if (!relPath.startsWith(prefix) || !relPath.endsWith('.js')) continue;
    const relToBackend = relPath.slice(prefix.length);
    if (!relToBackend.startsWith('src/')) continue;
    let loc;
    try {
      loc = fs.readFileSync(path.join(BACKEND_ROOT, relToBackend), 'utf8').split('\n').length;
    } catch {
      continue; // deleted between diff and read → skip honestly
    }
    scanned++;
    const verdict = classifyChangedLoc(loc, { exempt: baseGod.has(relToBackend) });
    const entry = { file: relToBackend, loc, verdict };
    if (verdict === 'error') errors.push(entry);
    else if (verdict === 'warning') warnings.push(entry);
    else if (verdict === 'exempt') exempt.push(entry);
  }
  const strict = argv.includes('--strict-warnings');
  const json = argv.includes('--json');
  const summary = { errors, warnings, exempt, scanned, undetermined };
  process.stdout.write(
    (json ? JSON.stringify(summary, null, 2) : formatChangedReport(summary)) + '\n'
  );
  if (errors.length > 0 || undetermined) return 1;
  if (strict && warnings.length > 0) return 1;
  return 0;
}

function main(argv = process.argv.slice(2)) {
  // 新增只读子命令：不参与默认 CI 退码门禁，始终退码 0（除解析异常）。
  if (argv.includes('--drift')) {
    const items = scanDriftR4();
    process.stdout.write(
      (argv.includes('--json')
        ? JSON.stringify({ drift: items }, null, 2)
        : formatDriftReport(items)) + '\n'
    );
    return 0;
  }
  if (argv.includes('--scc')) {
    const scc = analyzeGiantScc();
    process.stdout.write(
      (argv.includes('--json') ? JSON.stringify({ scc }, null, 2) : formatSccReport(scc)) + '\n'
    );
    return 0;
  }
  if (argv.includes('--god-report')) {
    const items = scanGodReport();
    process.stdout.write(
      (argv.includes('--json')
        ? JSON.stringify({ godReport: items }, null, 2)
        : formatGodReport(items)) + '\n'
    );
    return 0;
  }

  // --baseline-stale：基线悬空检测（只读，退码 0）。用于回答「基线还诚不诚实」。
  // 有悬空条目时**显式报出并给出刷新指引**，不静默假绿、也不阻断（刷新前它必然存在）。
  if (argv.includes('--baseline-stale')) {
    const stale = findStaleBaselineEntries(loadBaseline());
    if (argv.includes('--json')) {
      process.stdout.write(
        JSON.stringify({ baselineStale: stale, count: stale.length }, null, 2) + '\n'
      );
    } else {
      process.stdout.write(formatStaleBaselineReport(stale) + '\n');
    }
    return 0;
  }

  // --changed：改动文件体积分级（有退码门禁，故置于只读子命令之后、默认全量扫描之前）。
  if (argv.includes('--changed')) {
    return runChangedGate(argv);
  }

  const result = scanAll();

  if (argv.includes('--update-baseline')) {
    const baseline = {
      _comment:
        'archDebtScan 基线：已承认的存量架构债。CI 只拦截不在此列的新增项。用 --update-baseline 刷新。',
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
  const stale = findStaleBaselineEntries(baseline);

  if (argv.includes('--json')) {
    process.stdout.write(
      JSON.stringify({ result, new: neu, baselineStale: stale }, null, 2) + '\n'
    );
  } else {
    process.stdout.write(formatReport(result, neu) + '\n');
    if (stale.length) {
      // 人类可读报告里**必须**附带，否则维护者看到的「新增 N 处」会含假新增而不自知。
      process.stdout.write('\n' + formatStaleBaselineReport(stale) + '\n');
    }
  }

  const newCount =
    neu.layering.length + neu.godFiles.length + neu.godGrowth.length + neu.cycles.length;
  // ⚠ 悬空基线**只报不拦**（gate 语义）：它是「基线需要刷新」的信号，不是代码缺陷。
  // 但若基线悬空且同时有新增项，新增计数里可能混有「域迁移造成的假新增」，
  // 故 stderr 明确提示，避免维护者按字面读数归因。
  if (stale.length && newCount > 0) {
    process.stderr.write(
      `⚠ 基线有 ${stale.length} 条悬空条目；上方「新增」计数可能含假新增（域迁移所致）。\n` +
        '  请先跑 `node services/backend/scripts/archDebtScan.js --baseline-stale` 核对，\n' +
        '  再决定是否 `--update-baseline` 刷新基线。\n'
    );
  }
  return newCount > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  listJsFiles,
  extractRequires,
  stripComments,
  scanLayering,
  scanGodFiles,
  scanGodGrowth,
  scanGodReport,
  classifyChangedLoc,
  listChangedFiles,
  runChangedGate,
  buildRequireGraph,
  _sccComponents,
  findCycles,
  scanCycles,
  _blankNonCode,
  scanDriftR4,
  analyzeGiantScc,
  scanAll,
  loadBaseline,
  findStaleBaselineEntries,
  mergeUnique,
  diffNew,
  diffNewCycles,
  computeNew,
  analyzeCycleDrift,
  fingerprint,
  formatReport,
  formatDriftReport,
  formatSccReport,
  formatGodReport,
  formatStaleBaselineReport,
  formatChangedReport,
  main,
  SRC_DIR,
  BASELINE_FILE,
  GOD_FILE_LOC,
  CHANGED_FILE_LOC_MAX,
  CHANGED_FILE_WARN_LOC,
};
