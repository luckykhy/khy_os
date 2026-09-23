#!/usr/bin/env node
'use strict';
// RULES-REGISTRY: RUNTIME-007, RUNTIME-008, RUNTIME-009

/**
 * check-agent-feedback.js — 「AI 修改三模态反馈契约」执行器。
 *
 * 语义真源：docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-113] AI修改三模态反馈契约-客户模式.md
 * 规则：RUNTIME-007 修复先复现（看病） / RUNTIME-008 新增先提问（求学） /
 *       RUNTIME-009 删除先报部位（搓澡）。
 *
 * 要解决的问题：本仓库的治理层**很强但几乎全是事后**——改动做完才亮红灯。
 * 客户模式 = 代码库在改动生命周期五个节点上主动开口，而不是最后只给一个红灯：
 *   FIX    → 先复现再开药（没量体温不许开药）
 *   BUILD  → 先提问再动手（说「我不确定」不扣分，装作确定才扣分）
 *   DELETE → 先报部位、给力度、留回滚（客户有喊停权）
 *
 * ── 当前落地阶段：S1「观察者」（PROCESS-006 / [DESIGN-PROCESS-002] §2） ────────
 * S1 的毕业条件是 **≥200 条相关事件且无解释不了的样本**，毕业前**禁止拦截**（PP-1）。
 * 故本执行器当前把全部判定降级为 WARN 并**恒 exit 0**：
 *   - 归因不改变事实，只影响「这条 finding 算谁头上」（见 degradeForStage）；
 *   - 阶段升级（S1→S2→S3）改的是 `STAGE` 常量与登记表里的 `severity`，不改判定逻辑。
 *
 * ── 为什么判定不接受 AI 自称（方案 §4） ────────────────────────────────────
 * 模态判定是**确定性纯函数**，只看客观证据（git 改动集 + 任务语句 + 存证文件）。
 * AI 说「这是修 bug」不算证据；改了哪些文件、删了什么、有没有复现输出才算。
 * 这条纪律的理由是实测的：允许自称会让「谎报已复现」成为最优策略。
 *
 * 契约（scripts/ruleguard/lib/run.js）：
 *   输出方言 `[ERROR|WARN ] <finding> <file>:<line>` + 两空格缩进 message；
 *   有 error → exit 1；仅 warning → exit 0（--strict-warnings 时 exit 1）。
 *   支持 --changed：只扫变更文件，供 commit 档使用。
 *
 * 纪律（与仓库既有守卫一致）：零外部依赖、确定性、可离线跑、只读不改业务。
 *
 * Usage:
 *   node scripts/ci/check-agent-feedback.js --changed
 *   node scripts/ci/check-agent-feedback.js --files="A:a.js,D:b.js" --say="帮我删掉旧模块"
 *   node scripts/ci/check-agent-feedback.js --scenario=fix-no-repro
 *   node scripts/ci/check-agent-feedback.js --changed --evidence=.khy/feedback/<task-id>
 *   node scripts/ci/check-agent-feedback.js --scenario=delete-mass --explain
 *
 * Exit: 0 无 error（S1 恒 0），1 有 error，2 用法错误。
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 落地阶段（PROCESS-006 / [DESIGN-PROCESS-002] §2）。
 * 'S1' = 观察者：只记录，不拦截。升到 'S3' 前必须走完
 * S1（≥200 样本）→ S2（≥50 提示且误报 <10%）→ S3（≥20 真实拦截且豁免 <20%）。
 * 一次只升一阶（PP-6）。
 */
const STAGE = 'S1';

/**
 * 内部严重度**规范形**：只有 'error' / 'warning' 两种小写值。
 *
 * ⚠ 这里踩过一次坑（2026-09-18 实测）：判定处传的是小写 `'error'`，而统计处比对的是
 * 输出方言需要的 `'ERROR'`（`[ERROR] <finding> <file>:<line>` 里必须大写、占 6 字符
 * —— 见 ruleguard 的 `FINDING_LINE = /^\[(ERROR|WARN )\].../`）。两套大小写混用会让
 * `filter(f => f.severity === 'ERROR')` **恒不命中** → error 被静默计成 warning、
 * 门永远 exit 0（看着像 S1 的预期行为，实则判定与统计脱节）。
 * ⇒ **规范形只存小写，输出时再映射成方言标签**（`labelOf`），两者不再混用。
 */
const SEV_ERROR = 'error';
const SEV_WARNING = 'warning';

/** 规范形 → 输出方言标签（ruleguard `FINDING_LINE` 要求 `ERROR`/`WARN ` 定宽 6 字符）。 */
const labelOf = (severity) => (severity === SEV_ERROR ? 'ERROR' : 'WARN ');

/** 是否已到「会拦截」的阶段（S3/S4）。 */
const HARD_STAGE = STAGE === 'S3' || STAGE === 'S4';

/**
 * S1/S2 降级：把 error 压成 warning。**只在未到 S3 时生效**。
 *
 * 为什么不在产生处直接写 warning：findings 要能被 ruleguard 归因到具体规则
 * （`[ERROR] <finding> <file>:<line>` 里的 finding 名是归因键）。若在产生处就写死，
 * 等升到 S3 时要回来改 N 个判定点，且「哪些是硬三条」这条信息会在升级过程中丢失。
 * 故判定保持原级，降级是**门的阶段属性**，一处开关。
 */
function degradeForStage(severity) {
  if (severity !== SEV_ERROR) return severity;
  return HARD_STAGE ? SEV_ERROR : SEV_WARNING;
}

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
}

const changedMode = args.includes('--changed');
const strictWarnings = args.includes('--strict-warnings');
const explain = args.includes('--explain');

// ── 模态判定：确定性纯函数，不接受 AI 自称，只看客观证据（方案 §4） ──────────────
const MODES = ['DELETE', 'FIX', 'BUILD']; // 优先级：破坏不可逆者优先

const STATEMENT_FEATURES = [
  { re: /删|移除|下线|清理|废弃|不再需要|去掉/, mode: 'DELETE', weight: 0.35 },
  { re: /加|新增|支持|实现|引入|做一个|搞一个/, mode: 'BUILD', weight: 0.35 },
  { re: /报错|失败|不生效|崩|闪退|回归|异常|挂掉|卡住/, mode: 'FIX', weight: 0.4 },
];

const ENTRY_HINTS = [
  /^services\/backend\/src\/cli\/handlers\//,
  /^services\/backend\/src\/routes\//,
  /^services\/backend\/src\/tools\/[^/]+\/index\.js$/,
  /^extensions\/[^/]+\/[^/]+\/manifest\.json$/,
];

/** 歧义带半宽：两模态分差小于它即视为「说不清」，必须显式声明主模态。 */
const AMBIGUITY_BAND = 0.15;

function detectMode(changes, statement) {
  const score = { FIX: 0.05, BUILD: 0.05, DELETE: 0 };
  const reasons = [];
  const add = (mode, weight, why) => {
    score[mode] += weight;
    reasons.push(`${mode} +${weight.toFixed(2)} ← ${why}`);
  };

  for (const c of changes) {
    if (c.status === 'D') add('DELETE', 0.45, `删除文件 ${c.path}`);
    if (/deprecated|obsolete|legacy/i.test(c.path)) add('DELETE', 0.3, `路径命中弃用词 ${c.path}`);
    if (c.status === 'A') add('BUILD', 0.35, `新增文件 ${c.path}`);
    if (ENTRY_HINTS.some((re) => re.test(c.path))) add('BUILD', 0.3, `新增顶层入口 ${c.path}`);
    if (/test|spec/i.test(c.path) && c.status === 'M') add('FIX', 0.15, `改动测试 ${c.path}`);
  }

  for (const f of STATEMENT_FEATURES) {
    if (f.re.test(statement)) add(f.mode, f.weight, `任务语句命中 ${f.re.source.slice(0, 18)}…`);
  }

  const ranked = MODES.map((m) => ({ mode: m, score: Number(score[m].toFixed(3)) }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const second = ranked[1];
  const ambiguous = top.score > 0 && second.score > 0 && Math.abs(top.score - second.score) < AMBIGUITY_BAND;

  return {
    mode: top.score > 0 ? top.mode : 'BUILD',
    confidence: top.score,
    secondary: second.score > 0 ? second.mode : null,
    ambiguous,
    ranked,
    reasons,
  };
}

// ── 存证契约（方案 §6） ────────────────────────────────────────────────
// 为什么是「文件」而不是「对话」：对话会滚动、被压缩、被转述失真；
// 文件留在 .khy/feedback/<task-id>/ 里，可被下一个 AI 或人来复核。
const EVIDENCE = {
  FIX: [
    { file: 'complaint.md', label: '主诉（条件 + 现象）' },
    { file: 'repro-before.txt', label: '复现原始输出（体温单）' },
    { file: 'differential.md', label: '≥2 候选病因 + 可证伪预测' },
    { file: 'repro-after.txt', label: '改后同一命令输出（复诊）' },
  ],
  BUILD: [{ file: 'requirement-5q.md', label: '需求五问 + 回答 + 用户原话出处' }],
  DELETE: [{ file: 'scrub-plan.md', label: '部位清单 + 证据 + 力度档' }, { file: 'rollback.txt', label: '可执行回滚命令' }],
};

function readEvidence(dir, file) {
  const abs = path.join(dir, file);
  if (!fs.existsSync(abs)) return null;
  try {
    const text = fs.readFileSync(abs, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

// ── 五问反形式主义：自问自答识别（方案 §3.2） ────────────────────────────
function auditFiveQuestions(text) {
  if (!text) return [];
  const out = [];
  const answers = text.split(/^#+\s*Q\d+/m).slice(1);
  if (answers.length && answers.every((a) => a.replace(/\s/g, '').length < 40)) {
    out.push('五问回答均过短（<40 字）——疑似自问自答敷衍。');
  }
  if (!/source\s*[:：]\s*\S/.test(text)) {
    out.push('缺 `source: <用户原话>` 字段——无法证明答案是客户给的，而非 AI 自答。');
  }
  return out;
}

// ── 删除背书写护（方案 §7.5，沿用仓库既有判据） ──────────────────────────
/**
 * 删除前探：被删文件的 basename 是否出现在 docs/ 的设计文档里。
 *
 * 这是本机制**最有价值**的一条（方案 §11 场景 5）：本仓有 230+ 设计文档，
 * 代码与文档的对应关系**没有机器可读的映射**，一个代码里看着是孤儿的模块，
 * 可能正是某份设计文档的实现载体。实测命中过
 * `services/backend/src/cli/tui/ThreeColumnLayout.js`——它在 App.js:26 是死导入，
 * 但被 docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-079] TUI界面设计规范.md 引用，属「有文档背书」→ 拒绝放行。
 *
 * 口径（沿用「零引用」清理纪律）：basename 去扩展后 **≥6 字符**才可靠，
 * 短名（如 `util.js`）会大量误命中；`.md` 之外的文档格式不计（孪生件是生成的）。
 */
const DOCS_TOKEN_MIN_LEN = 6;

/**
 * 只对**代码文件**做背书写护：删一份 .md 被另一份 .md 的索引提到，
 * 不是「有设计文档背书的代码」，那是索引的职责。放进来会让
 * `docs/**` 的日常增删全部变成 error，误报率远超 [DESIGN-PROCESS-002] §2 的 10% 阈值。
 */
const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue',
  '.py', '.rs', '.go', '.java', '.kt', '.c', '.h', '.asm',
]);

/**
 * 生成产物 / 报告类路径不参与：`.html` 孪生件、诊断报告、归档区里的引用
 * 是「曾经的记录」而非「现行的设计」。本仓 `docs/_报告/历史/`、
 * `docs/_传承/` 等已废弃目录里的提及尤其不是背书。
 */
const NON_DESIGN_DOC_PARTS = [
  '/历史/',
  '/归档/',
  '/_产物/',
  '/00_INDEX_',
  '/18_归档/',
  '/19_资产/',
];

function isCodePath(rel) {
  return CODE_EXT.has(path.extname(rel).toLowerCase());
}

function isDesignDoc(rel) {
  return rel.endsWith('.md') && !NON_DESIGN_DOC_PARTS.some((p) => rel.includes(p));
}

function docsBackedTokens(relPaths) {
  const docsDir = path.join(REPO_ROOT, 'docs');
  if (!fs.existsSync(docsDir)) return [];
  const tokens = new Map();
  for (const rel of relPaths) {
    if (!isCodePath(rel)) continue;
    const base = path.basename(rel).replace(/\.[^.]+$/, '');
    if (base.length >= DOCS_TOKEN_MIN_LEN) tokens.set(base, rel);
  }
  if (!tokens.size) return [];

  const hits = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!tokens.size) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!e.name.endsWith('.md')) continue;
      const docRel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      if (!isDesignDoc(docRel)) continue;
      let text;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      for (const [token, rel] of tokens) {
        if (text.includes(token)) {
          hits.push({ rel, doc: docRel });
          tokens.delete(token);
        }
      }
    }
  };
  walk(docsDir);
  return hits;
}

// ── 客户回话：按模态生成（方案 §3） ────────────────────────────────────
function customerSpeech(det) {
  const L = [];
  if (det.mode === 'FIX') {
    L.push('【客户 · 患者】你还没量体温。');
    L.push('  1. 先复述主诉：谁、在什么条件下、出现了什么现象 —— 不许直接说病因。');
    L.push('  2. 跑复现命令，把**原始输出**存成 repro-before.txt。我要看到它，不要你的转述。');
    L.push('  3. 列 ≥2 个候选病因，每个给一条可证伪预测：`若 <病因>，则 <命令> 应输出 <期望>`。');
    L.push('  4. 只改能证伪病因的那一处。顺手重构 = 我要重新做一遍全套检查。');
    L.push('  5. 复诊：跑同一条复现命令，把改后输出存成 repro-after.txt。');
  } else if (det.mode === 'BUILD') {
    L.push('【客户 · 学生】在你写第一行代码前，先回答我五个问题：');
    L.push('  1. 谁用？（角色）');
    L.push('  2. 什么时候用？（触发时机 → 决定入口走哪个通道）');
    L.push('  3. 现在的替代做法是什么？（证明必要性）');
    L.push('  4. 成功长什么样？（**命令 + 期望输出**，没有它就没有验收）');
    L.push('  5. 不做会怎样？（不做清单）');
    L.push('  然后把答案压成 3 行「我理解你要的是……」，等我点头或纠偏。');
    L.push('  注意：说「我不确定」不扣分；装作确定才扣分。');
  } else {
    L.push('【客户 · 搓澡】先报部位，再定力道。');
    L.push('  1. 部位：打算搓掉的全部文件/导出/路由，逐条给证据（零引用、无文档背书）。');
    L.push('  2. 力道：轻搓（标记 + 留壳）/ 中搓（下线入口 + 迁调用方）/ 重搓（物理删除）—— 选一个，一次提交只做一步。');
    L.push('  3. 试搓：先搓一小块，停下我看。');
    L.push('  4. 喊停权：现在把「喊停 = 执行什么」给我 —— 没有回滚路径我不躺下。');
    L.push('  5. 收尾：搓掉了什么、还剩什么、哪些是故意留的壳。');
  }
  return L;
}

// ── 演示场景（--scenario）：用于自测与文档复现，不参与真实门禁 ────────────────
const SCENARIOS = {
  'fix-no-repro': {
    say: '登录后偶尔报错，帮我修一下',
    files: ['M:services/backend/src/services/authService.js', 'M:services/backend/tests/authService.test.js'],
  },
  'fix-with-repro': {
    say: '登录后偶尔报错，帮我修一下',
    files: ['M:services/backend/src/services/authService.js'],
    evidence: { 'repro-before.txt': '$ khy login --probe\nERR token refresh raced: 2 writers' },
  },
  'build-no-questions': {
    say: '帮我加一个批量导出功能',
    files: [
      'A:services/backend/src/services/exportService.js',
      'A:services/backend/src/routes/export.js',
      'A:services/backend/src/cli/handlers/export.js',
    ],
  },
  'delete-mass': {
    say: '把不用的旧模块清理掉',
    files: Array.from({ length: 12 }, (_, i) => `D:services/backend/src/services/legacy/mod${i}.js`),
  },
  'delete-documented': {
    say: '删掉 intentArbiter，没人用',
    files: ['D:services/backend/src/services/intentArbiter/index.js'],
  },
  mixed: {
    say: '修一下回显 bug，顺便把死代码删了',
    files: ['M:services/backend/src/cli/tui/App.js', 'D:services/backend/src/cli/tui/ThreeColumnLayout.js'],
  },
  // FIX 与 BUILD 近分（差 < 0.15）→ 混合带，必须显式声明主模态
  ambiguous: {
    say: '导出老是报错，帮忙看看怎么修',
    files: ['M:services/backend/src/services/exportService.js', 'A:services/backend/src/utils/retry.js'],
  },
};

// ── 改动集采集 ────────────────────────────────────────────────────────
function collectChanges() {
  if (changedMode) {
    const out = cp.spawnSync('git', ['diff', '--name-status', '--find-renames', '--diff-filter=ACMRD', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    const staged = cp.spawnSync(
      'git',
      ['diff', '--cached', '--name-status', '--find-renames', '--diff-filter=ACMRD'],
      { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true }
    );
    const seen = new Set();
    const rows = [];
    for (const chunk of [out.stdout, staged.stdout]) {
      for (const raw of String(chunk || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || seen.has(line)) continue;
        seen.add(line);
        const p = line.split('\t').filter(Boolean);
        const st = (p[0] || 'M').charAt(0).toUpperCase();
        const rel = (p[p.length - 1] || '').split(path.sep).join('/');
        if (rel) rows.push({ status: st, path: rel });
      }
    }
    return rows;
  }
  const spec = argValue('--files', '');
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      return { status: s.slice(0, i).toUpperCase(), path: s.slice(i + 1) };
    });
}

/**
 * finding 的定位锚点。
 *
 * ruleguard 的抑制机制（`// khy-allow-<规则ID>: <理由>`）与归因都要求 `file:line`。
 * 本执行器的判定是**改动集级**的（「整个改动集像在看病」），没有单一真源行；
 * 但把 file 留空会让抑制完全不可能（run.js 对无 file 的 finding 直接判 active）。
 * 故统一锚到「改动集的第一个文件:1」——语义诚实：定位是近似的，抑制锚点是真的。
 */
function anchorOf(changes) {
  const first = changes.find((c) => c.path) || { path: '(changeset)' };
  return { file: first.path, line: 1 };
}

// ── 主流程 ────────────────────────────────────────────────────────────
function check() {
  const scenario = argValue('--scenario', '');
  if (scenario && !SCENARIOS[scenario]) {
    const err = new Error(`未知 scenario：${scenario}\n可用：${Object.keys(SCENARIOS).join(', ')}`);
    err.usage = true;
    throw err;
  }
  const preset = scenario ? SCENARIOS[scenario] : null;

  let changes = preset
    ? preset.files.map((s) => ({ status: s.slice(0, 1).toUpperCase(), path: s.slice(2) }))
    : collectChanges();
  const statement = argValue('--say', preset ? preset.say : '');

  const evidenceDir = path.resolve(
    REPO_ROOT,
    argValue('--evidence', `.khy/feedback/${scenario || 'adhoc'}`)
  );

  // 预置存证（仅 --scenario 演示用；真实运行绝不写盘）
  if (preset && preset.evidence) {
    try {
      fs.mkdirSync(evidenceDir, { recursive: true });
      for (const [file, text] of Object.entries(preset.evidence)) {
        fs.writeFileSync(path.join(evidenceDir, file), `${text}\n`, 'utf8');
      }
    } catch {
      /* 只读纪律：写不进就不写，判定继续 */
    }
  }

  const findings = [];
  const anchorFile = anchorOf(changes).file;
  const add = (severity, id, message) => {
    findings.push({
      severity: degradeForStage(severity),
      originalSeverity: severity,
      finding: id,
      file: anchorFile,
      line: 1,
      message,
    });
  };

  if (!changes.length) return { changes, statement, det: null, findings, evidenceDir, empty: true };

  const det = detectMode(changes, statement);

  // 混合带必须显式声明主模态（不接受默认猜一个）
  if (det.ambiguous) {
    const declared = readEvidence(evidenceDir, 'mode.json');
    if (!declared) {
      add(
        'warning',
        'mode-undeclared',
        `改动集同时命中 ${det.mode} 与 ${det.secondary}（差 ${Math.abs(
          det.ranked[0].score - det.ranked[1].score
        ).toFixed(2)} < ${AMBIGUITY_BAND}），必须显式声明主模态（写 ${path
          .relative(REPO_ROOT, evidenceDir)
          .split(path.sep)
          .join('/')}/mode.json）。`
      );
    }
  }

  // 存证校验（按命中的每个模态各自校验）
  const activeModes = [det.mode, ...(det.secondary && det.ambiguous ? [det.secondary] : [])];
  for (const mode of activeModes) {
    for (const item of EVIDENCE[mode]) {
      if (readEvidence(evidenceDir, item.file)) continue;
      if (mode === 'FIX' && item.file === 'repro-before.txt') {
        add('error', 'fix-without-repro', `判定为 FIX 但缺 ${item.file}（${item.label}）—— 没量体温不许开药。`);
      } else if (mode === 'DELETE' && item.file === 'rollback.txt') {
        add('error', 'delete-without-rollback', `判定为 DELETE 但缺 ${item.file}（${item.label}）—— 客户有喊停权。`);
      } else if (mode === 'BUILD' && item.file === 'requirement-5q.md') {
        add('warning', 'build-without-questions', `判定为 BUILD 但缺 ${item.file}（${item.label}）—— 先提问再动手。`);
      } else {
        add('warning', `missing-${item.file}`, `缺存证 ${item.file}：${item.label}`);
      }
    }
  }

  // 五问反形式主义
  if (activeModes.includes('BUILD')) {
    for (const msg of auditFiveQuestions(readEvidence(evidenceDir, 'requirement-5q.md'))) {
      add('warning', 'self-answered', msg);
    }
  }

  // 删除：分片 + 文档背书
  const deleted = changes.filter((c) => c.status === 'D');
  if (deleted.length > 0) {
    if (deleted.length > 10) {
      add(
        'warning',
        'delete-needs-sharding',
        `一次删除 ${deleted.length} 个文件（>10）—— 必须分片，每片之间停一次让客户看。`
      );
    }
    for (const hit of docsBackedTokens(deleted.map((c) => c.path))) {
      const f = findings.find((x) => x.finding === 'delete-documented-code' && x.message.startsWith(hit.rel));
      if (f) continue;
      findings.push({
        severity: degradeForStage('error'),
        originalSeverity: 'error',
        finding: 'delete-documented-code',
        file: hit.rel,
        line: 1,
        message: `${hit.rel} 在 docs/ 有设计文档背书（${hit.doc}）—— 拒绝放行：先「救活」或订正文档，不得静默清理。`,
      });
    }
  }

  // FIX 爆炸半径
  if (det.mode === 'FIX') {
    const buckets = new Set(changes.map((c) => c.path.split('/')[0]));
    if (changes.length >= 4 || buckets.size >= 3) {
      add(
        'warning',
        'fix-blast-radius',
        `FIX 处方触及 ${changes.length} 个文件 / ${buckets.size} 个顶层目录 —— 处方应最小化，禁止顺手重构。`
      );
    }
  }

  return { changes, statement, det, findings, evidenceDir, empty: false };
}

function main() {
  let result;
  try {
    result = check();
  } catch (err) {
    if (err && err.usage) {
      process.stdout.write(`check-agent-feedback: ${err.message}\n`);
      return 2;
    }
    // 守卫自身绝不拖垮门禁：异常按「无发现」处理，但明示降级。
    process.stdout.write('[WARN ] mode-undeclared scripts/ci/check-agent-feedback.js:1\n');
    process.stdout.write(`  守卫自身异常，已降级为无发现：${err && err.message}\n`);
    process.stdout.write('Summary: 0 error(s), 0 warning(s).\n');
    return 0;
  }

  const errors = result.findings.filter((f) => f.severity === SEV_ERROR);
  const warnings = result.findings.filter((f) => f.severity !== SEV_ERROR);

  // 显式目标（--scenario / --files）时把判定过程讲清楚；--changed 走静默契约。
  // ⚠ `--changed` 一票否决 verbose：门里的消费者只认 `[ERROR|WARN ] <finding> <file>:<line>`
  // 方言，讲解块即使不匹配正则也是噪声，且会让 S3 的 error 计数与人类可读输出混在一处。
  const verbose =
    !changedMode && (explain || argValue('--scenario', '') !== '' || argValue('--files', '') !== '');

  if (result.empty) {
    if (verbose) process.stdout.write('check-agent-feedback: 改动集为空，客户无话可说。\n');
    process.stdout.write(`Summary: 0 error(s), 0 warning(s).\n`);
    return 0;
  }

  if (verbose && result.det) {
    const det = result.det;
    process.stdout.write(`${'='.repeat(72)}\n`);
    process.stdout.write(
      `check-agent-feedback · 改动集 ${result.changes.length} 项 · 任务语句：${
        result.statement || '（未提供）'
      }\n`
    );
    process.stdout.write(`${'='.repeat(72)}\n`);
    process.stdout.write('\n【模态判定】（客观证据，不接受自称）\n');
    for (const r of det.ranked) {
      if (r.score > 0) process.stdout.write(`  ${r.mode.padEnd(7)} ${r.score.toFixed(2)}\n`);
    }
    process.stdout.write(
      `  主模态 = ${det.mode}${det.ambiguous ? `（混合带，次模态 ${det.secondary}）` : ''}\n`
    );
    const MAX_REASONS = 6;
    for (const why of det.reasons.slice(0, MAX_REASONS)) process.stdout.write(`    · ${why}\n`);
    if (det.reasons.length > MAX_REASONS) {
      process.stdout.write(
        `    · …另有 ${det.reasons.length - MAX_REASONS} 条同类证据（已折叠）\n`
      );
    }
    process.stdout.write('\n【客户回话】\n');
    for (const line of customerSpeech(det)) process.stdout.write(`  ${line}\n`);
    process.stdout.write('\n【判定结果】\n');
  }

  if (!result.findings.length) {
    if (verbose) process.stdout.write('  ✅ 客户满意：存证齐全，可以动手。\n');
  } else {
    for (const f of [...errors, ...warnings]) {
      process.stdout.write(`[${labelOf(f.severity)}] ${f.finding} ${f.file}:${f.line}\n`);
      process.stdout.write(`  ${f.message}\n`);
    }
    if (verbose && STAGE !== 'S3' && STAGE !== 'S4') {
      process.stdout.write(
        `  （本次 ${result.findings.filter((f) => f.originalSeverity === 'error').length} 条原本是 error，` +
          `S1「观察者」阶段按 [DESIGN-PROCESS-002] PP-1 降级为 WARN 且不拦截）\n`
      );
    }
  }

  process.stdout.write(`Summary: ${errors.length} error(s), ${warnings.length} warning(s).\n`);

  // 阶段门：S1/S2 恒放行（PP-3「S1/S2 必须旁路记录，禁止阻断主流程」）。
  if (!HARD_STAGE) return 0;
  if (errors.length) return 1;
  if (strictWarnings && warnings.length) return 1;
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  detectMode,
  auditFiveQuestions,
  docsBackedTokens,
  customerSpeech,
  EVIDENCE,
  SCENARIOS,
  STAGE,
  AMBIGUITY_BAND,
};
