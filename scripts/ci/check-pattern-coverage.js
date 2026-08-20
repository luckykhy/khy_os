#!/usr/bin/env node
/**
 * @pattern Visitor, Template Method
 *
 * 设计模式注册表守卫 —— 校验 docs/_设计模式/模式注册表.json 与磁盘的一致性。
 *
 * 三条规则，都是 warning + 基线棘轮（与 check-repo-layout.js 同一套机制）：
 *   pattern-uncovered  本仓跟踪的源文件没有注册表条目
 *   pattern-ghost      注册表条目指向磁盘上已不存在的文件
 *   pattern-invalid    模式名不在 GoF 23 之内（或空列表）
 *
 * **为什么用 git ls-files 而不是 find**：本脚本原先用 find 扫磁盘，于是把
 * tools/deepseek-eyes/.venv 下 3232 个第三方 Python 包、以及 vendor/ 下的构建
 * 产物全算成「本仓待标注的源文件」，把未覆盖数从 2938 灌到 6213，覆盖率显示
 * 11.6%。那 3275 个文件 git 一个都不跟踪。「什么是本仓的代码」只有一个真源，
 * 就是 git，不是文件系统 —— EXCLUDE_DIRS 那种黑名单永远追不上下一个 .venv。
 *
 * 用法:
 *   node scripts/ci/check-pattern-coverage.js
 *   node scripts/ci/check-pattern-coverage.js --list=pattern-ghost
 *   node scripts/ci/check-pattern-coverage.js --update-baseline
 * 退出码: 0 = 通过（含基线内的 warning）, 1 = 超基线, 2 = 用法/环境错
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = process.env.KHY_PATTERN_COVERAGE_ROOT
  // 仅供 scripts/tests/check-pattern-coverage.test.js 指向临时 fixture 仓库使用。
  // 规则逻辑必须能脱离本仓库当时的真实状态被验证，否则「基线一改测试就绿」。
  ? path.resolve(process.env.KHY_PATTERN_COVERAGE_ROOT)
  : path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(repoRoot, 'docs', '_设计模式', '模式注册表.json');
const BASELINE_PATH = path.join(repoRoot, 'scripts', 'ci', 'pattern-coverage-baseline.json');

const args = process.argv.slice(2);
const updateBaseline = args.includes('--update-baseline');
const listIds = new Set(
  args.filter(a => a.startsWith('--list=')).map(a => a.slice('--list='.length)).filter(Boolean)
);

const ALL_23 = [
  'Singleton', 'Factory Method', 'Abstract Factory', 'Builder', 'Prototype',
  'Adapter', 'Bridge', 'Composite', 'Decorator', 'Facade', 'Flyweight', 'Proxy',
  'Chain of Responsibility', 'Command', 'Interpreter', 'Iterator', 'Mediator',
  'Memento', 'Observer', 'State', 'Strategy', 'Template Method', 'Visitor',
];
const GOF = new Set(ALL_23);

const ALL_FINDING_IDS = new Set(['pattern-uncovered', 'pattern-ghost', 'pattern-invalid']);
const BASELINE_IDS = new Set(['pattern-uncovered', 'pattern-ghost', 'pattern-invalid']);

// 参与标注的扩展名（沿用注册表既有约定，不在本轮扩大或收窄）。
const EXTENSIONS = new Set(['js', 'vue', 'ts', 'c', 'h', 'py', 'asm', 'sh', 'ps1', 'mbt', 'css']);

// 跟踪但不参与标注的路径。
//
// vendor/ 与压缩产物不是人写的代码，_source/ 是快照 —— 要求它们标注 GoF 模式没有意义。
//
// 测试文件同样不标注：这不是本轮的新主张，而是既有约定的两处印证 —— 旧脚本的
// EXCLUDE_DIRS 明确排掉了 services/backend/tests 等目录，而注册表 1139 条里只有
// 5 条是测试（0.4%）。改用 git ls-files 后若不把这条排除带上，会把 2057 个后端
// 测试文件算成「欠标注」，等于用扫描范围的变化伪造出一批不存在的债。
const SKIP_RE = [
  /(^|\/)vendor\//,
  /\.min\.(js|css)$/,
  /^_source\//,
  /\.(test|spec)\.[a-z]+$/,
  /(^|\/)(tests?|__tests__)\//,
];

const toPosix = p => p.split(path.sep).join('/');

/** 本仓跟踪的、参与模式标注的源文件。真源是 git，不是文件系统。
 *
 * 边界（有意如此）：未 `git add` 的文件不计入。守卫追的是「进了本仓的代码」，
 * 工作区里的草稿不该被追；文件一旦 add，棘轮立刻看得见它（实测 2705 → 2706 即 error）。
 */
function listSourceFiles() {
  let out;
  try {
    out = execFileSync('git', ['ls-files'], {
      cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    console.error('check-pattern-coverage: git ls-files 失败 —— ' + e.message);
    process.exit(2);
  }
  return out.split('\n').map(s => s.trim()).filter(Boolean)
    .filter(f => EXTENSIONS.has(path.extname(f).slice(1)))
    .filter(f => !SKIP_RE.some(re => re.test(f)))
    .sort();
}

function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const unknown = [...listIds].filter(id => !ALL_FINDING_IDS.has(id));
  if (unknown.length > 0) {
    console.error('check-pattern-coverage: 未知的 --list id: ' + unknown.join(', '));
    console.error('  可用 id: ' + [...ALL_FINDING_IDS].join(', '));
    process.exit(2);
  }

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (e) {
    console.error('check-pattern-coverage: 读不到或解析不了注册表 —— ' + e.message);
    process.exit(2);
  }

  const sourceFiles = listSourceFiles();
  const findings = [];
  const counts = {};

  // ① 未覆盖：跟踪的源文件没有条目
  const uncovered = sourceFiles.filter(f => !registry[f]);
  counts['pattern-uncovered'] = uncovered.length;

  // ② 幽灵：条目指向磁盘上已不存在的文件。这一项原先**完全没检**，
  //    于是注册表可以无限积累谎言而守卫一声不吭。
  const ghosts = Object.keys(registry)
    .filter(f => !fs.existsSync(path.join(repoRoot, f)))
    .sort();
  counts['pattern-ghost'] = ghosts.length;

  // ③ 非法模式名 / 空列表
  const invalid = [];
  const usedPatterns = new Set();
  for (const [file, ps] of Object.entries(registry)) {
    if (!Array.isArray(ps) || ps.length === 0) {
      invalid.push(file + ': 空模式列表');
      continue;
    }
    for (const p of ps) {
      usedPatterns.add(p);
      if (!GOF.has(p)) invalid.push(file + ': "' + p + '"');
    }
  }
  counts['pattern-invalid'] = invalid.length;

  if (uncovered.length > 0) {
    findings.push({
      id: 'pattern-uncovered', severity: 'warning',
      message: uncovered.length + ' 个跟踪源文件没有模式注册表条目',
      detail: '补标注后跑 --update-baseline 下调基线（绝不上调）',
      full: uncovered,
    });
  }
  if (ghosts.length > 0) {
    findings.push({
      id: 'pattern-ghost', severity: 'warning',
      message: ghosts.length + ' 个注册表条目指向已不存在的文件',
      detail: '删掉这些条目 —— 注册表不该记录磁盘上没有的东西',
      full: ghosts,
    });
  }
  if (invalid.length > 0) {
    findings.push({
      id: 'pattern-invalid', severity: 'warning',
      message: invalid.length + ' 处非 GoF 23 的模式名或空列表',
      detail: '只允许 GoF 23: ' + ALL_23.join(', '),
      full: invalid,
    });
  }

  if (updateBaseline) {
    // 保留 baseline json 里 `_` 前缀的说明字段，否则每次下调基线都会把
    // 「只降不升」这条约定的解释顺手删掉（与 check-repo-layout.js 同构）。
    const prev = loadBaseline() || {};
    const next = {};
    for (const [k, v] of Object.entries(prev)) {
      if (k.startsWith('_')) next[k] = v;
    }
    next.updated = new Date().toISOString().slice(0, 10);
    next.counts = {};
    for (const id of BASELINE_IDS) next.counts[id] = counts[id] || 0;
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
    console.log('check-pattern-coverage: 基线已更新 → ' + toPosix(path.relative(repoRoot, BASELINE_PATH)));
    console.log('  ' + JSON.stringify(next.counts));
    return;
  }

  const baseline = loadBaseline();
  const regressions = [];
  for (const id of BASELINE_IDS) {
    const allowed = baseline && baseline.counts && Number.isInteger(baseline.counts[id])
      ? baseline.counts[id] : null;
    if (allowed === null) continue;
    const actual = counts[id] || 0;
    if (actual > allowed) regressions.push({ id, allowed, actual });
  }

  // 基线只降不升：超出即升为 error（这才是棘轮，不然基线只是个数字）。
  const effectiveSeverity = (finding) =>
    regressions.some(r => r.id === finding.id) ? 'error' : finding.severity;

  console.log('check-pattern-coverage: 设计模式注册表守卫（真源 docs/_设计模式/模式注册表.json）');
  console.log('源文件(git 跟踪): ' + sourceFiles.length
    + ' · 注册表条目: ' + Object.keys(registry).length
    + ' · 模式覆盖: ' + usedPatterns.size + '/23');
  console.log('counts: ' + JSON.stringify(counts));
  if (baseline && baseline.counts) {
    console.log('baseline: ' + JSON.stringify(baseline.counts) + ' (updated ' + (baseline.updated || 'n/a') + ')');
  } else {
    console.log('baseline: 缺失 —— 跑 node scripts/ci/check-pattern-coverage.js --update-baseline 建立');
  }

  if (findings.length === 0) {
    console.log('result: 注册表与磁盘一致，全绿。');
  } else {
    console.log('result:');
    for (const finding of findings) {
      const eff = effectiveSeverity(finding);
      const mark = eff !== finding.severity ? ' (promoted from ' + finding.severity + ')' : '';
      console.log(' - [' + eff + ']' + mark + ' ' + finding.message + ' (id: ' + finding.id + ')');
      if (finding.detail) console.log('   ' + finding.detail);
      if (listIds.has(finding.id) && Array.isArray(finding.full)) {
        for (const item of finding.full) console.log('     · ' + item);
      }
    }
  }

  for (const r of regressions) {
    console.error('check-pattern-coverage: ' + r.id + ' 超出基线（基线 ' + r.allowed + '，实测 ' + r.actual + '）—— 只允许下降。');
    console.error('  补掉新增的未标注文件，或在确有正当理由时用 --update-baseline 显式下调/记录。');
  }

  if (findings.some(f => effectiveSeverity(f) === 'error')) {
    process.exit(1);
  }
}

main();
