#!/usr/bin/env node
/**
 * check-weak-model-guard.js — SECURITY-003 弱模型改动护栏。
 *
 * 规则真源 docs/10_规范/registry/RULES-REGISTRY.json 的 SECURITY-003：弱档(T2/T3) + red-line
 * 路径 → 拒绝并要求强模型复核；弱档 + sensitive（god 级）→ 放行但须确认。
 *
 * 载体 services/backend/src/services/weakModelChangeGuard.js 的 classifyChangeRisk()
 * 与 assessWeakModelChange() 都是纯函数，所以本检查器做**行为断言**而非文本扫描：
 * RED_LINE_PATTERNS 被删掉一条，文本扫描看不见，行为断言直接跑分类器当场就红。
 *
 * 八条断言：
 *   1. 规则点名的 6 类红线各自都判成 red-line（分类覆盖）
 *   2. 弱档 + red-line → allow=false 且 action=require-strong-review（红线本体）
 *   3. 弱档 + sensitive → allow=true 且 requireConfirm=true（确认而非拒绝）
 *   4. 强档 + red-line 放行、弱档 + 普通文件放行（精度，不得误伤强模型/日常编辑）
 *   5. 判定与权限旁路环境无关（bypass/yolo 不得关掉「按能力档拦人」的护栏）
 *   6. 分类值域封闭 + 入参不全 fail-soft 返 null（registry 声明的降级契约）
 *   7. 护栏被生产代码调用（否则整条规则是死代码）
 *   8. 声明的「拒绝」有生产消费者（拒绝信号无人读取 = 只有提醒，没有拦截）
 *
 * 用法：
 *   node scripts/ci/check-weak-model-guard.js
 *   node scripts/ci/check-weak-model-guard.js --strict-warnings
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RULE_ID = 'SECURITY-003';
const MODULE_REL = 'services/backend/src/services/weakModelChangeGuard.js';
const DENY_ACTION = 'require-strong-review';
const cwd = process.cwd();
const args = process.argv.slice(2);
const strictWarnings = args.includes('--strict-warnings');

const findings = [];
const add = (severity, id, relFile, line, message) =>
  findings.push({ severity, id, file: relFile, line, message });

const moduleAbs = path.join(cwd, MODULE_REL);
const moduleText = fs.existsSync(moduleAbs) ? fs.readFileSync(moduleAbs, 'utf8') : null;

// 锚点行号：给 `// khy-allow-SECURITY-003:` 一个可贴的位置。
const lineOf = (needle) => {
  if (!moduleText) return 1;
  const i = moduleText.indexOf(needle);
  return i === -1 ? 1 : moduleText.slice(0, i).split('\n').length;
};

if (moduleText === null) {
  add('error', 'guard-module-missing', MODULE_REL, 1,
    `载体 ${MODULE_REL} 不存在：SECURITY-003 的单一真源缺失，弱模型改动护栏无从校验。`);
} else {
  const guard = require(path.resolve(cwd, MODULE_REL));

  if (
    typeof guard.classifyChangeRisk !== 'function' ||
    typeof guard.assessWeakModelChange !== 'function'
  ) {
    add('error', 'guard-api-missing', MODULE_REL, lineOf('function classifyChangeRisk'),
      'weakModelChangeGuard 未导出 classifyChangeRisk / assessWeakModelChange：'
      + '调用方无法判定红线风险与弱档裁决，护栏失效。');
  } else {
    // 规则 constraint 点名的 6 类红线，每类取真实存在的仓库路径做样本。
    const RED_LINE_CATEGORIES = {
      '.env': ['.env', '.env.local'],
      '发布·CI': [
        'scripts/release/publish-dual.sh',
        'scripts/ci/check-agent-rules.js',
        '.github/workflows/pr-gate.yml',
      ],
      'flagRegistry SSOT': ['services/backend/src/services/flagRegistry.js'],
      '版本三源': [
        'pyproject.toml',
        'services/backend/package.json',
        'packaging/npm/package.json',
      ],
      '权限核心': [
        'services/backend/src/services/permissionStore.js',
        'services/backend/src/services/criticalGate.js',
      ],
      '.git': ['.git/config'],
    };

    // ── 1. 6 类红线各自都判成 red-line ─────────────────────────────────
    for (const [category, paths] of Object.entries(RED_LINE_CATEGORIES)) {
      for (const rel of paths) {
        const risk = guard.classifyChangeRisk(rel);
        if (risk !== 'red-line') {
          add('error', 'guard-category-uncovered', MODULE_REL, lineOf('const RED_LINE_PATTERNS'),
            `规则点名的红线类别「${category}」样本「${rel}」被判为 ${risk}（应为 red-line）：`
            + '弱模型改这个路径不会被拦，违反 SECURITY-003。');
        }
      }
    }

    // ── 2/3/4. 裁决矩阵 ───────────────────────────────────────────────
    const WEAK_TIERS = ['T2', 'T3'];
    const STRONG_TIERS = ['T0', 'T1'];
    const RED_SAMPLE = 'services/backend/src/services/flagRegistry.js';
    const SENSITIVE_SAMPLES = [
      'services/backend/src/services/aiGateway.js',
      'services/backend/src/services/toolUseLoopCore.js',
      'services/backend/src/services/harness.js',
      'services/backend/src/services/replSession.js',
      'services/backend/src/services/sessionPersistence.js',
    ];
    const NORMAL_SAMPLE = 'README.md';

    for (const tier of WEAK_TIERS) {
      // 弱档 + red-line → 拒绝并要求强模型复核
      const red = guard.assessWeakModelChange({ tier, filePath: RED_SAMPLE, env: {} });
      if (!red || red.allow !== false || red.action !== DENY_ACTION) {
        add('error', 'guard-weak-redline-allowed', MODULE_REL, lineOf('action: \'require-strong-review\''),
          `弱档(${tier})改红线文件「${RED_SAMPLE}」裁决为 ${red ? `allow=${red.allow}, action=${red.action}` : '(null)'}：`
          + `SECURITY-003 要求 allow=false 且 action=${DENY_ACTION}，否则弱模型静默改坏安全关键路径。`);
      }

      // 弱档 + sensitive → 放行但须确认（是确认，不是拒绝）
      for (const rel of SENSITIVE_SAMPLES) {
        const risk = guard.classifyChangeRisk(rel);
        const verdict = guard.assessWeakModelChange({ tier, filePath: rel, env: {} });
        if (risk !== 'sensitive') {
          add('warn', 'guard-sensitive-misclassified', MODULE_REL, lineOf('const SENSITIVE_PATTERNS'),
            `god 级核心「${rel}」被判为 ${risk}（应为 sensitive）：`
            + '弱模型改它会漏掉人工确认环节。');
        } else if (!verdict || verdict.allow !== true || verdict.requireConfirm !== true) {
          add('error', 'guard-sensitive-not-confirmed', MODULE_REL, lineOf('requireConfirm: true'),
            `弱档(${tier})改敏感核心「${rel}」裁决为 ${verdict ? `allow=${verdict.allow}, requireConfirm=${verdict.requireConfirm}` : '(null)'}：`
            + 'SECURITY-003 要求放行但必须 requireConfirm=true。');
        }
      }

      // 弱档 + 普通文件 → 放行且不需要确认（精度：不得让日常编辑全弹窗）
      const normal = guard.assessWeakModelChange({ tier, filePath: NORMAL_SAMPLE, env: {} });
      if (!normal || normal.allow !== true || normal.requireConfirm) {
        add('warn', 'guard-normal-nagged', MODULE_REL, lineOf('reason: \'普通文件放行\''),
          `弱档(${tier})改普通文件「${NORMAL_SAMPLE}」未正常放行：`
          + '精度回归会让弱模型每一次日常编辑都被要求确认。');
      }
    }

    // 强档 + red-line → 不受限（精度：不得误伤强模型）
    for (const tier of STRONG_TIERS) {
      const verdict = guard.assessWeakModelChange({ tier, filePath: RED_SAMPLE, env: {} });
      if (!verdict || verdict.allow !== true) {
        add('warn', 'guard-strong-nagged', MODULE_REL, lineOf('reason: \'strong-model\''),
          `强档(${tier})改红线文件「${RED_SAMPLE}」未被放行：`
          + '精度回归会让 T0/T1 模型也被弱模型护栏拦下。');
      }
    }

    // ── 5. 判定与权限旁路环境无关 ──────────────────────────────────────
    // 护栏是按「谁在改（能力档）」而非「授权模式」裁决的，所以权限旁路不得关掉它；
    // 唯一合法的关闭开关是它自己的 KHY_WEAK_MODEL_EDIT_GUARD。
    const BYPASS_ENVS = [
      { KHY_PERMISSION_MODE: 'bypass' },
      { KHY_PERMISSION_MODE: 'yolo' },
      { KHY_SYSCALL_GATEWAY: 'off' },
      { KHY_PERMISSION_MODE: 'bypass', KHY_SYSCALL_GATEWAY: 'off' },
      { KHY_PERMISSION_MODE: 'yolo', KHY_SYSCALL_GATEWAY: 'off' },
    ];
    const probe = `
      const g = require(${JSON.stringify(path.resolve(cwd, MODULE_REL))});
      const v = g.assessWeakModelChange({ tier: 'T3', filePath: ${JSON.stringify(RED_SAMPLE)}, env: process.env });
      process.stdout.write(v ? ('allow=' + v.allow) : 'NULL');
    `;
    for (const override of BYPASS_ENVS) {
      const env = { ...process.env };
      for (const k of ['KHY_PERMISSION_MODE', 'KHY_SYSCALL_GATEWAY', 'KHY_WEAK_MODEL_EDIT_GUARD']) {
        delete env[k];
      }
      for (const [k, v] of Object.entries(override)) env[k] = v;
      const run = spawnSync(process.execPath, ['-e', probe], { cwd, env, encoding: 'utf8' });
      const label = Object.entries(override).map(([k, v]) => `${k}=${v}`).join(' ');
      if (run.error) {
        add('error', 'guard-env-probe-failed', MODULE_REL, lineOf('function assessWeakModelChange'),
          `旁路环境探针（${label}）执行失败：${run.error.message}。无法证明该环境下护栏仍生效。`);
        continue;
      }
      if (String(run.stdout || '').trim() !== 'allow=false') {
        add('error', 'guard-env-dependent', MODULE_REL, lineOf('function assessWeakModelChange'),
          `旁路环境 ${label} 下弱档改红线裁决为 ${String(run.stdout || '').trim() || '(空)'}（应为 allow=false）：`
          + '权限旁路关掉了能力档护栏，弱模型可在 bypass/yolo 下静默改红线文件。');
      }
    }

    // ── 6. 值域封闭 + fail-soft ────────────────────────────────────────
    const VALID_RISK = new Set(['red-line', 'sensitive', 'normal']);
    for (const rel of [RED_SAMPLE, SENSITIVE_SAMPLES[0], NORMAL_SAMPLE, '', '.', '..', '中文/路径', null]) {
      let risk;
      try {
        risk = guard.classifyChangeRisk(rel);
      } catch (err) {
        add('error', 'guard-classifier-throws', MODULE_REL, lineOf('function classifyChangeRisk'),
          `classifyChangeRisk(${JSON.stringify(rel)}) 抛异常（${err.message}）：`
          + '载体声明「绝不抛」，抛了会让上层调用方整条链路中断。');
        continue;
      }
      if (!VALID_RISK.has(risk)) {
        add('error', 'guard-unknown-risk', MODULE_REL, lineOf('function classifyChangeRisk'),
          `classifyChangeRisk(${JSON.stringify(rel)}) 返回 ${JSON.stringify(risk)}：`
          + '不在 red-line|sensitive|normal 值域内，上层 switch 会静默落到 default。');
      }
    }
    // 只测「入参不全」：filePath 缺才是入参不全；只缺 tier 是合法输入(走 modelTier 自动分档)。
    for (const input of [{ env: {} }, { tier: 'T3', env: {} }]) {
      const verdict = guard.assessWeakModelChange(input);
      if (verdict !== null) {
        add('error', 'guard-no-failsoft', MODULE_REL, lineOf('function assessWeakModelChange'),
          `assessWeakModelChange(${JSON.stringify(input)}) 返回 ${JSON.stringify(verdict)}（应为 null）：`
          + 'registry 声明的降级契约是「入参不全返 null 逐字节回退」，返回裁决会强制介入。');
      }
    }

    // ── 7/8. 接线与拒绝信号的消费者 ────────────────────────────────────
    const consumers = findProductionCallers();
    if (consumers.length === 0) {
      add('error', 'guard-not-wired', MODULE_REL, lineOf('module.exports'),
        '没有任何生产代码调用 weakModelChangeGuard：整条 SECURITY-003 是死代码，'
        + '弱模型改红线时不会有任何拦截或提醒。');
    } else {
      for (const rel of consumers) {
        const text = fs.readFileSync(path.join(cwd, rel), 'utf8');
        const readsDeny = text.includes(DENY_ACTION) || /\.allow\b/.test(text);
        if (!readsDeny) {
          add('warn', 'guard-declared-deny-unconsumed', rel, 1,
            `护栏调用点 ${rel} 只投递提醒文案（humanLine/aiNote），从不读取拒绝信号`
            + `（allow / ${DENY_ACTION}）：SECURITY-003 声明的「拒绝」实际只是事后提醒，`
            + '编辑已发生。要么把规则文本改成「提醒并要求强模型复核」，要么在调用点补硬拦截。');
        }
      }
    }
  }
}

/**
 * 找出引用护栏模块的生产代码文件（排除护栏自身、测试、CI 脚本、构建产物）。
 * @returns {string[]} 相对仓库根、正斜杠路径
 */
function findProductionCallers() {
  // 只认「真的调用」：require 模块 / 调函数。注释与文档里的提及不算接线。
  const refs = [/require\([^)]*weakModelChangeGuard/, /buildWeakModelAdvisory\s*\(/, /assessWeakModelChange\s*\(/];
  const skip = [/node_modules[\\/]/, /[\\/]tests?[\\/]/, /coverage[\\/]/, /scripts[\\/]ci[\\/]/, /^scripts[\\/]/, /gen-rules-cards/, /backfill-fields/];
  const hits = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (/\.js$/.test(ent.name)) {
        const rel = path.relative(cwd, full).split(path.sep).join('/');
        if (rel === MODULE_REL || skip.some((re) => re.test(rel))) continue;
        let text = '';
        try {
          text = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        if (refs.some((re) => re.test(text))) hits.push(rel);
      }
    }
  };
  for (const root of ['services', 'platform', 'apps', 'software']) {
    if (fs.existsSync(path.join(cwd, root))) walk(path.join(cwd, root));
  }
  return hits;
}

findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity === 'warn');

console.log(`check-weak-model-guard: ${RULE_ID} 弱模型改动护栏`);
console.log(`载体: ${MODULE_REL}（行为断言，非文本扫描）`);

for (const f of findings) {
  const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
  console.log(`[${tag}] ${f.id} ${f.file}:${f.line}`);
  console.log(`  ${f.message}`);
}

console.log(`\nSummary: ${errors.length} error(s), ${warns.length} warning(s).`);
process.exitCode = errors.length || (strictWarnings && warns.length) ? 1 : 0;
