#!/usr/bin/env node
/**
 * check-release-triggers.js — 发布触发链路守卫（规则 PROCESS-005 的执行面）
 *
 * 真源：`docs/10_规范/其它规范/[DESIGN-SEMVER-002] 版本管理与发布触发规范.md` §2.5 R-5
 *
 * 要解决的问题（实测，非推测）
 * ---------------------------
 * 发布时机此前靠人记：workflow 的 `on:` 块是否覆盖了真实默认分支、发布链路的关键
 * step 有没有被悄悄加上 `continue-on-error`、并发开关有没有被改回 `true` ——
 * 这些都是**改一个字符就静默失效、且不会报错**的事实。
 * 本脚本把它们变成可机判的 finding。
 *
 * 纪律（与仓库既有守卫一致）
 * -------------------------
 *   - 零外部依赖（只用 fs / path）；不引 YAML 解析库，用手写扫描（理由见下）
 *   - 确定性、可离线跑、**只读不改业务**
 *   - 不硬编码检查名单：release 档 workflow 从 `on:` 块**含发布语义**派生
 *   - 判定只看客观证据（workflow 文本、git 真源），不接受 AI 自称
 *
 * 为什么手写扫描而不装 YAML 解析器
 * --------------------------------
 * ① 仓库纪律要求 `scripts/ci/*` 零外部依赖（`check-wiring` 的豁免口径同此）；
 * ② 本脚本要判的是**结构事实**（某键是否存在、某值是否为 false、
 *    某 step 是否带 continue-on-error），不是完整 YAML 语义；
 * ③ 早期用正则匹配键值比对 YAML 解析器更**保守**：解析器会把 `on` 解析成
 *    布尔 `true`（YAML 1.1 的 Norway 问题），反而制造坑。
 *
 * 输出契约（必须遵守，否则 ruleguard 的棘轮与抑制都失效）
 * ------------------------------------------------------
 *   stdout 只放 finding，格式为仓库统一约定（`scripts/ruleguard/lib/run.js` 的
 *   `FINDING_LINE`），第二行起两个空格缩进写正文：
 *     [ERROR] <finding-id> <相对路径>:<行号>
 *       <人类可读说明>
 *   诊断信息一律走 **stderr** —— 否则缩进行会被解析器当成上一条 finding 的正文。
 *   `file` 必须是**单个路径且不含空格**；行号必须是**真实行**（0 号行永远匹配不上
 *   `khy-allow-PROCESS-005`，等于把 finding 变成不可豁免）。
 *
 * Usage
 * -----
 *   node scripts/ci/check-release-triggers.js                # 扫描全仓
 *   node scripts/ci/check-release-triggers.js --json         # 机器可读
 *   node scripts/ci/check-release-triggers.js --list-scenarios
 *   node scripts/ci/check-release-triggers.js --scenario=<名>
 *   node scripts/ci/check-release-triggers.js --verbose
 *
 * Exit: 0 clean, 1 findings, 2 usage error（与 scripts/ci/ 其余检查器同契约）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RULE_ID = 'PROCESS-005';
const WORKFLOW_DIR = path.join('.github', 'workflows');
const RELEASE_WORKFLOW = 'dual-channel-release.yml';
const MIRROR_WORKFLOW = 'sync-gitee.yml';

// 发布链路上**必须阻断**的四条硬条件 step（真源 §2.5 第 3 行）。
// 用「step 的 run 里出现的脚本路径片段」识别，而不是 step 的 name ——
// name 是给人看的文案，随时可能改；脚本路径才是行为真源。
const HARD_CONDITION_STEPS = [
  'scripts/ci/check-version-sync.js',
  'scripts/release/changelog-new.js',
  'scripts/release/release-gate.js',
  'scripts/tests/updateIndex.test.js',
];

// bump 落点三源（真源 §2.4「同一次 commit 内齐变」）。
// 刻意只取**用户可见的三处**（Python 包 + npm 包 + 后端包），
// 不从 check-version-sync.js 全量派生：规范 §2.4 说的就是这三源，
// 全量 9 源里有刻意不同步的组（`PROCESS-002` 组间刻意不同）。
const BUMP_SOURCES = [
  'pyproject.toml',
  'packaging/npm/package.json',
  'services/backend/package.json',
];

// 豁免注释：`# release-trigger-exempt: <理由>`（理由必填，空理由不生效且被报出）。
const EXEMPT_RE = /#\s*release-trigger-exempt:\s*(.*)$/;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const findings = [];

function add(severity, file, check, message, line = 1) {
  const normalized = Number.isFinite(line) && line > 0 ? Math.floor(line) : 1;
  findings.push({ rule: RULE_ID, severity, check, file, line: normalized, message });
}

// ── 极简 YAML 结构扫描 ───────────────────────────────────────────────────────
//
// 只理解三件事实：缩进层级、`key:` 行、`- item` 行。够本脚本用，且**可解释**
// （出问题时能一眼看出为什么判红，不像解析器那样要进黑盒）。

/** 把文本切成带缩进与行号的行数组（跳过空行与纯注释行）。 */
function scanLines(text) {
  const out = [];
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.match(/^ */)[0].length;
    out.push({ n: i + 1, indent, text: line.trim(), raw: line });
  }
  return out;
}

/** 找顶层块（缩进 0 的 `<key>:`）的值行区间。返回 {start,end} 或 null。 */
function blockRange(lines, key) {
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].indent === 0 && lines[i].text === `${key}:`) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].indent === 0) { end = i; break; }
  }
  return { start, end };
}

/** 某 step（`- name:` 起始的块）的文本范围。返回 [{from,to,text}]。 */
function stepBlocks(lines) {
  const steps = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^-\s+/.test(lines[i].raw.trim()) && !/^-\s/.test(lines[i].text)) continue;
    if (!/^-\s+(name|uses|run):/.test(lines[i].text)) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^-\s/.test(lines[j].text) && /^-\s+(name|uses|run):/.test(lines[j].text)) { end = j; break; }
    }
    steps.push({ from: lines[i].n, to: end - 1 >= i ? lines[end - 1].n : lines[i].n, startIdx: i, endIdx: end });
  }
  return steps;
}

/** 读取豁免注释（返回带行号的理由；空理由算未豁免）。 */
function readExemptions(text) {
  const grants = [];
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < raw.length; i += 1) {
    const m = raw[i].match(EXEMPT_RE);
    if (!m) continue;
    const reason = String(m[1] || '').trim();
    grants.push({ line: i + 1, reason, ok: reason.length > 0 });
  }
  return grants;
}

/** 豁免是否覆盖某个行号（只看该行**之上最近的**豁免注释）。 */
function isExempt(grants, line) {
  return grants.some((g) => g.ok && g.line <= line && line - g.line <= 12);
}

/** 收集空理由豁免，逐个报出（空理由不生效）。 */
function reportEmptyExemptions(file, text) {
  for (const g of readExemptions(text)) {
    if (!g.ok) {
      add(
        'warning',
        file,
        'release-exempt-empty-reason',
        '`# release-trigger-exempt:` 的理由为空 —— 空理由不生效（与 `khy-allow-<规则ID>` 同语义）。' +
          '请补上「为什么这里可以豁免」，或删掉该注释。',
        g.line,
      );
    }
  }
}

// ── 各项检查 ────────────────────────────────────────────────────────────────

/** 找 workflow 的 `on:` 块，返回其**直接子键**集合与行号。 */
function readTriggers(lines) {
  // YAML 里 `on` 可能被写成 `on:`（真源）。兼容 `'on':` / `"on":`。
  let idx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].indent === 0 && /^['"]?on['"]?:$/.test(lines[i].text)) { idx = i; break; }
  }
  if (idx < 0) return null;
  const keys = [];
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (lines[i].indent === 0) { end = i; break; }
  }
  // ⚠️ 只收**直接子键**（缩进最小的一层）。曾经收全部深度，导致 `push:` 之下的
  //    `tags:` 也被当成顶层触发器 —— 「`tags` 算不算明确触发器」会判错。
  //    实测踩过：`readTriggers` 返回 ['push','tags'] 而非 ['push']。
  let childIndent = -1;
  for (let i = idx + 1; i < end; i += 1) {
    if (childIndent < 0 || lines[i].indent < childIndent) childIndent = lines[i].indent;
  }
  for (let i = idx + 1; i < end; i += 1) {
    if (lines[i].indent !== childIndent) continue;
    const m = lines[i].text.match(/^([A-Za-z_][\w-]*):$/);
    if (m) keys.push({ key: m[1], line: lines[i].n });
  }
  return { idx, end, keys, lineNo: lines[idx].n };
}

/** 检查 1：release 档 workflow 的 `on:` 非空且含明确触发器。 */
function checkReleaseTrigger(file, text) {
  const lines = scanLines(text);
  const on = readTriggers(lines);
  if (!on || on.keys.length === 0) {
    add(
      'error',
      file,
      'release-trigger-missing',
      '发布 workflow 的 `on:` 块为空或缺失 —— 该 workflow 永远不会被触发' +
        '（workflow 不匹配任何事件时**不会报错**，只会静默不跑）。真源 §2.5 第 1 行。',
      on ? on.lineNo : 1,
    );
  }
}

/** 检查 2：镜像 workflow 的 `branches` 覆盖当前默认分支。 */
function checkMirrorBranch(file, text, defaultBranch) {
  const lines = scanLines(text);
  const onRange = blockRange(lines, 'on');
  if (!onRange) {
    add('error', file, 'mirror-trigger-missing', '镜像 workflow 缺少 `on:` 块，永不触发。', 1);
    return;
  }
  // 在 on 块内找 push → branches 列表
  const branches = [];
  let pushIdx = -1;
  for (let i = onRange.start + 1; i < onRange.end; i += 1) {
    if (lines[i].text === 'push:') { pushIdx = i; break; }
  }
  if (pushIdx >= 0) {
    for (let i = pushIdx + 1; i < onRange.end; i += 1) {
      if (lines[i].indent <= lines[pushIdx].indent) break;
      const m = lines[i].text.match(/^-\s*['"]?([^'"]+?)['"]?$/);
      if (m) branches.push({ name: m[1], line: lines[i].n });
      const inline = lines[i].text.match(/^branches:\s*\[(.*)\]$/);
      if (inline) {
        for (const b of inline[1].split(',')) {
          branches.push({ name: b.trim().replace(/^['"]|['"]$/g, ''), line: lines[i].n });
        }
      }
    }
  }
  const hasPushBranches = pushIdx >= 0 && branches.length > 0;
  if (!hasPushBranches) {
    // 允许 workflow_dispatch 单独存在（真源 §2.5 误报回归锁明确要求判绿）
    const onlyDispatch = onRange && !lines.slice(onRange.start + 1, onRange.end)
      .some((l) => l.text === 'push:');
    if (onlyDispatch) return;
    add(
      'error',
      file,
      'mirror-branch-missing',
      '镜像 workflow 的 `push:` 未声明 `branches` —— 默认分支改名后过滤器不匹配，' +
        'workflow 会**静默不再触发**。真源 §2.5 第 2 行。',
      onRange.start + 1,
    );
    return;
  }
  if (!branches.some((b) => b.name === defaultBranch)) {
    add(
      'error',
      file,
      'mirror-branch-drift',
      `镜像 workflow 的 \`branches\` 未覆盖当前默认分支 \`${defaultBranch}\` ` +
        `（实际列出：${branches.map((b) => b.name).join(', ')}）。` +
        '默认分支改名后此处不报错，只会静默不同步。真源 §2.5 第 2 行。',
      branches[0].line,
    );
  }
}

/** 检查 3：发布链路四条硬条件 step 均未设 continue-on-error。
 *
 *  @param {string[]|null} onlySteps
 *    只检查这些 step（`--scenario` 用）。理由：每个反例场景只放**一条** step，
 *    若不做限制，另外三条会各报一条「step 不存在」，把真正的断言淹掉
 *    （实测踩过：`hard-condition-exempt` 报出 4 条，其中 3 条是噪音）。
 *    传 `null` = 检查全部四条（全仓模式）。 */
function checkHardConditionSteps(file, text, onlySteps) {
  const lines = scanLines(text);
  const steps = stepBlocks(lines);
  const grants = readExemptions(text);
  const targets = onlySteps && onlySteps.length ? onlySteps : HARD_CONDITION_STEPS;
  for (const scriptPath of targets) {
    const hit = steps.find((s) => {
      for (let i = s.startIdx; i < s.endIdx; i += 1) {
        if (lines[i].raw.includes(scriptPath)) return true;
      }
      return false;
    });
    if (!hit) {
      // step 不存在是另一类问题（可能是被整体删除）—— 单独报，避免与 continue-on-error 混为一谈
      add(
        'error',
        file,
        'release-hard-condition-missing',
        `发布链路的硬条件 step \`${scriptPath}\` 不存在 —— 该条件已被整体移除，` +
          '发布将不再被它守住。真源 §2.5 第 3 行。',
        1,
      );
      continue;
    }
    // 在该 step 范围内找 continue-on-error: true
    let bad = -1;
    for (let i = hit.startIdx; i < hit.endIdx; i += 1) {
      if (/^continue-on-error:\s*true\s*$/.test(lines[i].text)) { bad = lines[i].n; break; }
    }
    if (bad > 0 && !isExempt(grants, bad)) {
      add(
        'error',
        file,
        'release-hard-condition-exempt',
        `发布链路的硬条件 step \`${scriptPath}\` 被设为 \`continue-on-error: true\` —— ` +
          '条件失败时发布仍会继续，等于该条守卫失效。' +
          '若确需临时豁免，请加 `# release-trigger-exempt: <理由>`（理由必填）。真源 §2.5 第 3 行。',
        bad,
      );
    }
  }
}

/** 检查 4：发布 workflow 的 concurrency 必须 cancel-in-progress: false。 */
function checkConcurrency(file, text) {
  const lines = scanLines(text);
  const range = blockRange(lines, 'concurrency');
  if (!range) {
    add(
      'error',
      file,
      'release-concurrency-missing',
      '发布 workflow 缺少 `concurrency` 块 —— 并发发布会产出「npm 已发、PyPI 未发」' +
        '这类无法回滚的半成品状态。真源 §2.5 第 4 行。',
      1,
    );
    return;
  }
  let found = -1;
  let bad = -1;
  for (let i = range.start + 1; i < range.end; i += 1) {
    const m = lines[i].text.match(/^cancel-in-progress:\s*(true|false)\s*$/);
    if (m) { found = lines[i].n; if (m[1] === 'true') bad = lines[i].n; }
  }
  if (found < 0) {
    add(
      'error',
      file,
      'release-cancel-in-progress-missing',
      '`concurrency` 未显式声明 `cancel-in-progress: false` —— 新发布会取消进行中的发布会。' +
        '真源 §2.5 第 4 行。',
      range.start + 1,
    );
    return;
  }
  if (bad > 0) {
    const grants = readExemptions(text);
    if (!isExempt(grants, bad)) {
      add(
        'error',
        file,
        'release-concurrent-publish',
        '`cancel-in-progress: true` 允许并发发布 —— 中途取消会留下包已部分上传的状态。' +
          '真源 §2.5 第 4 行（并发组名任意，只有这个值有硬要求）。',
        bad,
      );
    }
  }
}

/** 检查 5：`CHANGELOG.md` 顶部有版本段。 */
function checkChangelog() {
  const rel = 'CHANGELOG.md';
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) {
    add('warning', rel, 'changelog-missing', '`CHANGELOG.md` 不存在 —— bump 时无处记录变更。真源 §2.5 第 6 行。', 1);
    return;
  }
  const text = fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const VER_RE = /^##\s*\[?v?\d+\.\d+\.\d+/;
  const idx = lines.findIndex((l) => VER_RE.test(l));
  if (idx < 0) {
    add(
      'warning',
      rel,
      'changelog-no-version-section',
      '`CHANGELOG.md` 顶部没有 `## [x.y.z]` 形式的版本段 —— ' +
        'bump 必须同时留下 CHANGELOG，否则「为什么升版本」不可追溯。真源 §2.5 第 6 行。',
      1,
    );
    return;
  }
  return { line: idx + 1, version: lines[idx].replace(/^##\s*\[?/, '').replace(/\]?.*$/, '') };
}

/** 检查 6：bump 落点三源版本一致（warning —— 真正的「同 commit 齐变」需 git 历史）。 */
function checkBumpSources() {
  const versions = [];
  for (const rel of BUMP_SOURCES) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) {
      add('warning', rel, 'bump-source-missing', `bump 落点三源之一 \`${rel}\` 不存在。`, 1);
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    let v = null;
    if (rel.endsWith('.toml')) {
      const m = text.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
      if (m) v = m[1];
    } else {
      try {
        v = JSON.parse(text).version || null;
      } catch (_) { /* 下面统一报 */ }
    }
    if (!v) {
      add('warning', rel, 'bump-source-unparsable', `无法从 \`${rel}\` 读出 version 字段。`, 1);
      continue;
    }
    versions.push({ rel, v });
  }
  const uniq = [...new Set(versions.map((x) => x.v))];
  if (uniq.length > 1) {
    const detail = versions.map((x) => `${x.rel}=${x.v}`).join('、');
    add(
      'warning',
      versions[0].rel,
      'bump-sources-diverge',
      `bump 落点三源版本不一致（${detail}）—— 真源 §2.4 要求同一次 bump 三源齐变。` +
        '注意：本检查只看**当前值**，「同一次 commit 内齐变」属时序判定，需 git 历史，留给人工评审。',
      1,
    );
  }
  return versions;
}

// ── 反例矩阵（--scenario）──────────────────────────────────────────────────
//
// 每个场景注入一份**虚拟 workflow 文本**，用同一批纯函数跑，证明每条检查既能拦、
// 也能放行。**不含 git 依赖的检查**（bump 三源 / CHANGELOG）不参与场景。
const SCENARIOS = {
  'trigger-missing': {
    desc: 'release workflow 的 `on:` 为空 → 期望 release-trigger-missing',
    workflow: 'name: R\non:\njobs:\n  a:\n    runs-on: ubuntu-latest\n',
  },
  'trigger-present': {
    desc: '`on:` 含 tags 通配 → 期望**放行**（误报回归锁：`tags: [v*]` 是合法写法）',
    workflow: "name: R\non:\n  push:\n    tags:\n      - 'v*'\n",
  },
  'trigger-dispatch-only': {
    desc: '`on:` 只有 workflow_dispatch → 期望**放行**（真源 §2.5 明确要求判绿）',
    workflow: 'name: R\non:\n  workflow_dispatch:\n    inputs:\n      a:\n        required: false\n',
  },
  'mirror-branch-drift': {
    desc: '镜像 workflow 只列 master，默认分支是 main → 期望 mirror-branch-drift',
    workflow: 'name: M\non:\n  push:\n    branches:\n      - master\n',
  },
  'mirror-branch-ok': {
    desc: '镜像 workflow 列 main 与 master → 期望**放行**（迁移期兼容）',
    workflow: 'name: M\non:\n  push:\n    branches:\n      - main\n      - master\n',
  },
  'mirror-branch-dispatch-ok': {
    desc: '镜像 workflow 只有 workflow_dispatch → 期望**放行**',
    workflow: 'name: M\non:\n  workflow_dispatch:\n    inputs:\n      branch:\n        required: false\n',
  },
  'hard-condition-exempt': {
    desc: '硬条件 step 被加 continue-on-error → 期望 release-hard-condition-exempt',
    onlySteps: ['scripts/ci/check-version-sync.js'],
    workflow: "name: R\non:\n  push:\n    tags:\n      - 'v*'\nconcurrency:\n  group: release\n  cancel-in-progress: false\njobs:\n  release:\n    steps:\n      - name: Verify version sync\n        run: node scripts/ci/check-version-sync.js\n        continue-on-error: true\n",
  },
  'hard-condition-ok': {
    desc: '硬条件 step 无 continue-on-error → 期望**放行**',
    onlySteps: ['scripts/ci/check-version-sync.js'],
    workflow: "name: R\non:\n  push:\n    tags:\n      - 'v*'\nconcurrency:\n  group: release\n  cancel-in-progress: false\njobs:\n  release:\n    steps:\n      - name: Verify version sync\n        run: node scripts/ci/check-version-sync.js\n",
  },
  'hard-condition-exempt-ok': {
    desc: '硬条件 step 带**有理由**的豁免注释 → 期望**放行**（豁免机制本身要被证明可用）',
    onlySteps: ['scripts/ci/check-version-sync.js'],
    workflow: "name: R\non:\n  push:\n    tags:\n      - 'v*'\nconcurrency:\n  group: release\n  cancel-in-progress: false\njobs:\n  release:\n    steps:\n      - name: Verify version sync\n        # release-trigger-exempt: 迁移期临时放开，跟踪 issue #123\n        continue-on-error: true\n        run: node scripts/ci/check-version-sync.js\n",
  },
  'hard-condition-exempt-empty': {
    desc: '豁免注释理由为空 → 期望 release-exempt-empty-reason',
    onlySteps: ['scripts/ci/check-version-sync.js'],
    workflow: "name: R\non:\n  push:\n    tags:\n      - 'v*'\nconcurrency:\n  group: release\n  cancel-in-progress: false\njobs:\n  release:\n    steps:\n      - name: Verify version sync\n        # release-trigger-exempt:\n        continue-on-error: true\n        run: node scripts/ci/check-version-sync.js\n",
  },
  'hard-condition-step-deleted': {
    desc: '硬条件 step 被整体删除 → 期望 release-hard-condition-missing',
    onlySteps: ['scripts/ci/check-version-sync.js'],
    workflow: "name: R\non:\n  push:\n    tags:\n      - 'v*'\nconcurrency:\n  group: release\n  cancel-in-progress: false\njobs:\n  release:\n    steps:\n      - name: Something else\n        run: node scripts/release/release-gate.js\n",
  },
  'concurrency-true': {
    desc: 'cancel-in-progress: true → 期望 release-concurrent-publish',
    workflow: "name: R\non:\n  push:\n    tags:\n      - 'v*'\nconcurrency:\n  group: release\n  cancel-in-progress: true\njobs:\n  release:\n    steps:\n      - name: V\n        run: node scripts/ci/check-version-sync.js\n",
  },
  'concurrency-missing': {
    desc: '缺少 concurrency 块 → 期望 release-concurrency-missing',
    workflow: "name: R\non:\n  push:\n    tags:\n      - 'v*'\njobs:\n  release:\n    steps:\n      - name: V\n        run: node scripts/ci/check-version-sync.js\n",
  },
  'concurrency-ok': {
    desc: 'cancel-in-progress: false 且组名任意 → 期望**放行**（真源 §2.5 明确要求判绿）',
    workflow: "name: R\non:\n  push:\n    tags:\n      - 'v*'\nconcurrency:\n  group: whatever-name\n  cancel-in-progress: false\njobs:\n  release:\n    steps:\n      - name: V\n        run: node scripts/ci/check-version-sync.js\n",
  },
};

// ── 场景运行 ────────────────────────────────────────────────────────────────
//
// 每个场景**只跑它自己那条检查** —— 关键设计，实测踩过：
// 早期版本把四条检查都跑一遍，导致每个场景都额外报出「另外三个硬条件 step 不存在」
// （场景文本里只放了一个 step），真实断言被淹在噪音里。
// 场景是「单条检查的反例」，不是「整仓快照」，必须逐条隔离。

/** 场景 → 该场景要跑的那一条检查。 */
function runScenario(name) {
  const sc = SCENARIOS[name];
  const rel = name.startsWith('mirror-') ? MIRROR_WORKFLOW : RELEASE_WORKFLOW;

  if (name.startsWith('trigger-')) {
    checkReleaseTrigger(rel, sc.workflow);
    return;
  }
  if (name.startsWith('mirror-')) {
    checkMirrorBranch(rel, sc.workflow, sc.defaultBranch || 'main');
    return;
  }
  if (name.startsWith('hard-condition-')) {
    checkHardConditionSteps(rel, sc.workflow, sc.onlySteps || null);
    reportEmptyExemptions(rel, sc.workflow);
    return;
  }
  if (name.startsWith('concurrency-')) {
    checkConcurrency(rel, sc.workflow);
    return;
  }
  throw new Error(`场景「${name}」没有绑定检查 —— 新增场景时请同步 runScenario 的分流规则`);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { json: false, verbose: false, scenario: null, listScenarios: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--list-scenarios') opts.listScenarios = true;
    else if (arg.startsWith('--scenario=')) opts.scenario = arg.slice('--scenario='.length);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('-')) {
      console.error(`未知参数：${arg}`);
      opts.help = true;
    }
  }
  return opts;
}

function readDefaultBranch() {
  // 真源优先级：远端 HEAD 符号引用 → 当前分支。两者都不可得时返回 null，
  // 调用方跳过该检查并打印警示（不猜、不硬编码 'main'）。
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000,
    }).trim();
    if (out) return out.replace(/^origin\//, '');
  } catch (_) { /* fallthrough */ }
  try {
    const out = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000,
    }).trim();
    if (out) return out;
  } catch (_) { /* fallthrough */ }
  return null;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log('用法：node scripts/ci/check-release-triggers.js [--json] [--verbose] [--scenario=<名>] [--list-scenarios]');
    console.log(`规则：${RULE_ID}  真源：docs/10_规范/其它规范/[DESIGN-SEMVER-002] 版本管理与发布触发规范.md §2.5`);
    process.exitCode = 2;
    return;
  }

  if (opts.listScenarios) {
    for (const [name, s] of Object.entries(SCENARIOS)) console.log(`${name.padEnd(34)} ${s.desc}`);
    return;
  }

  let mode = 'repo';
  if (opts.scenario) {
    if (!SCENARIOS[opts.scenario]) {
      console.error(`未知场景「${opts.scenario}」，用 --list-scenarios 查看可用场景。`);
      process.exitCode = 2;
      return;
    }
    mode = `scenario:${opts.scenario}`;
    runScenario(opts.scenario);
  } else {
    const wfDir = path.join(REPO_ROOT, WORKFLOW_DIR);
    if (!fs.existsSync(wfDir)) {
      console.error(`✗ 找不到 workflow 目录：${WORKFLOW_DIR}`);
      process.exitCode = 2;
      return;
    }
    const defaultBranch = readDefaultBranch();

    const releaseText = readWorkflowIfExists(RELEASE_WORKFLOW);
    if (releaseText !== null) {
      checkReleaseTrigger(RELEASE_WORKFLOW, releaseText);
      checkHardConditionSteps(RELEASE_WORKFLOW, releaseText);
      checkConcurrency(RELEASE_WORKFLOW, releaseText);
      reportEmptyExemptions(RELEASE_WORKFLOW, releaseText);
    } else {
      add(
        'error',
        RELEASE_WORKFLOW,
        'release-workflow-missing',
        `发布 workflow \`${WORKFLOW_DIR}/${RELEASE_WORKFLOW}\` 不存在 —— 发布链路整体缺失。真源 §2.5。`,
        1,
      );
    }

    const mirrorText = readWorkflowIfExists(MIRROR_WORKFLOW);
    if (mirrorText !== null) {
      if (defaultBranch) {
        checkMirrorBranch(MIRROR_WORKFLOW, mirrorText, defaultBranch);
      } else {
        console.error('⚠ 无法确定默认分支（git 不可用/detached），跳过「镜像分支覆盖」检查。');
      }
      reportEmptyExemptions(MIRROR_WORKFLOW, mirrorText);
    }

    checkChangelog();
    checkBumpSources();
  }

  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ rule: RULE_ID, mode, repoRoot: REPO_ROOT, findings }, null, 2)}\n`,
    );
  } else {
    for (const f of findings) {
      const tag = f.severity === 'error' ? '[ERROR]' : '[WARN ]';
      process.stdout.write(`${tag} ${f.check} ${f.file}:${f.line}\n`);
      process.stdout.write(`  ${f.message}\n`);
    }
    if (!findings.length) process.stdout.write('（无 finding）\n');
    const out = process.stderr;
    out.write(`发布触发链路守卫（${RULE_ID}）  模式=${mode}\n`);
    out.write(`真源：docs/10_规范/其它规范/[DESIGN-SEMVER-002] 版本管理与发布触发规范.md §2.5\n`);
    if (opts.verbose) {
      out.write(`  workflow 目录：${WORKFLOW_DIR}\n`);
      out.write(`  硬条件 step：${HARD_CONDITION_STEPS.join(' / ')}\n`);
      out.write(`  bump 落点三源：${BUMP_SOURCES.join(' / ')}\n`);
    }
  }

  process.stdout.write(`\nSummary: ${errors.length} error(s), ${warnings.length} warning(s).\n`);
  process.exitCode = errors.length || warnings.length ? 1 : 0;
}

/** 读 workflow；不存在返回 null（区分「空文件」与「没这个文件」）。 */
function readWorkflowIfExists(name) {
  const abs = path.join(REPO_ROOT, WORKFLOW_DIR, name);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

module.exports = {
  RULE_ID,
  HARD_CONDITION_STEPS,
  BUMP_SOURCES,
  SCENARIOS,
  checkReleaseTrigger,
  checkMirrorBranch,
  checkHardConditionSteps,
  checkConcurrency,
  scanLines,
  stepBlocks,
  readExemptions,
  isExempt,
  readTriggers,
  blockRange,
  // 仅供单测：返回 findings 数组的**副本**，便于对纯函数做「变异真文件 → 断言判红」。
  // 故意用双下划线前缀标明「非公开 API」：它不参与任何运行时逻辑，
  // 也不该被其它模块 require（findings 是模块级可变状态，跨模块共享会串味）。
  __collectFindingsForTest: () => findings.slice(),
  // 仅供单测：清空 findings（用例间隔离；同样不计入公开 API）。
  __resetFindingsForTest: () => { findings.length = 0; },
};

// ⚠️ 必须判 `require.main`：否则单测 `require()` 本文件时会顺带跑一次全仓扫描，
//    把「导入模块」变成「执行检查」（实测踩过：测试里 import 一次就多出一份 finding）。
if (require.main === module) {
  main();
}
