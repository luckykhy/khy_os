#!/usr/bin/env node
/**
 * Changed-file safety checker for low-cost / small-model workflows.
 *
 * Usage:
 *   node scripts/ci/check-change-safety.js --changed
 *   node scripts/ci/check-change-safety.js --changed --strict-warnings
 *   node scripts/ci/check-change-safety.js --changed --promote=sensitive-paths
 *   node scripts/ci/check-change-safety.js <file-or-dir> [more...]
 *   node scripts/ci/check-change-safety.js               # 全量出厂件检查（见下）
 *
 * --strict-warnings 把**所有** warning 视为 error(适合 agent 的单次改动自检)。
 * --promote=<id,id> 只把指定 finding 升为 error(适合 PR 门禁,见下方常量注释)。
 * 可用 id 见 ALL_FINDING_IDS;拼错会以退出码 2 失败,不会静默放过。
 *
 * 出厂件明文密钥（SECURITY-001）：本脚本兼作它的执行器。改动集模式下只看本次
 * 暂存的改动（`--changed` 透传给 `scripts/check_builtin_keys.py`）；**不带
 * `--changed` 且不给目标时**改动集为空、但出厂件检查照跑，此时会连同打包产物
 * （`apps/khy-os-client-app/release/*.apk`）一起扫 —— 这也是验证「APK 里只有
 * 混淆密钥、没有明文」的那条命令。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const { interpreterFor, runnerLabel } = require('../lib/pythonInterpreter');

const cwd = process.cwd();
const repoRoot = path.resolve(__dirname, '..', '..');
const maintainerMapPath = path.join(repoRoot, 'docs', '14_维护者', 'registry', '维护映射表.json');
const args = process.argv.slice(2);
const strictWarnings = args.includes('--strict-warnings');
// --promote=<id,id>:把指定 id 的 warning 单独视为 error。
//
// 为什么需要它:本脚本的 warning 混着两类性质完全不同的发现 ——
//   (a) 单次改动卫生建议:改了 8+ 个文件、新增 3+ 个文件、跨 3+ 个顶层目录。
//       这些阈值是给「低成本模型的一次 pass」设计的护栏,对人类 PR 属正常范围。
//   (b) 必须拦住的事:改动集里出现 .env / *.pem / *.key / credentials.json。
// 用 --strict-warnings 会把两类一起升为阻断,结果是任何触及 8 个以上文件的 PR
// 都被拒;不用它则凭据文件泄漏变成不阻断。--promote 让调用方精确挑选,
// 例如 PR 门禁只用 --promote=sensitive-paths。
// --strict-warnings 的原语义保持不变,老调用方不受影响。
const promotedIds = new Set(
  args
    .filter(arg => arg.startsWith('--promote='))
    .flatMap(arg => arg.slice('--promote='.length).split(','))
    .map(id => id.trim())
    .filter(Boolean)
);
const changedMode = args.includes('--changed');
const rawTargets = args.filter(arg => !arg.startsWith('--'));
const maintainerPathTypeCache = new Map();

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.cache',
  '.tmp',
  'coverage',
  'logs',
]);

const WARN_CHANGED_FILE_COUNT = 8;
const ERROR_CHANGED_FILE_COUNT = 20;
const WARN_NEW_FILE_COUNT = 3;

// 所有 finding 的 id 全集，供 --promote 校验拼写。新增 finding 时同步补一项。
const ALL_FINDING_IDS = new Set([
  'changed-count-error',
  'changed-count',
  'deletions',
  'new-files',
  'sensitive-paths',
  'high-risk-surface',
  'weak-model-banner',
  'many-areas',
  'builtin-key-plaintext',
  'builtin-key-check-failed',
]);

const SENSITIVE_PATH_RE = /(?:^|\/)(?:\.env(?:\..*)?|credentials\.json|secrets?\.(?:ya?ml|json)|.*\.(?:pem|key))$/i;

const HIGH_RISK_PATH_RULES = [
  { re: /^services\/backend\/src\/services\/gateway\//, label: 'backend gateway core' },
  { re: /^services\/(?:backend|ai-backend)\/src\/routes\//, label: 'route layer' },
  { re: /^services\/backend\/src\/constants\/prompts\.js$/, label: 'system prompt core' },
  { re: /(?:^|\/)(?:package\.json|pyproject\.toml|setup\.py)$/, label: 'package/build config' },
  { re: /(?:^|\/)(?:khy_platform\/__init__\.py|(?:backend|npm)\/package\.json)$/, label: 'version sync file' },
];

// ── 弱模型就地护栏横幅存在性(不信任弱模型:防它顺手删掉高危位点的 [AI-弱模型] 标注)──
// 若受监控的高危文件被改动,其 [AI-弱模型] 横幅必须仍在(至少一处)。零假阳性:只在这几个文件、
// 只查横幅是否存在(不校验内容),文件未改动则不检查。横幅文案单一真源见 weakModelGuidance.js。
const WEAK_MODEL_BANNER_MARK = '[AI-弱模型';
const WEAK_MODEL_BANNER_FILES = [
  'services/backend/src/services/toolCalling.js',
  'services/backend/src/services/flagRegistry.js',
  'services/backend/src/services/goalStopGate.js',
  'services/backend/src/services/toolUseLoop.js',
  'services/backend/src/services/weakModelGuidance.js',
  // 5 个高危写/搜索工具:prompt() 带 weakModelToolNote() 注入,横幅提醒弱模型「先 Read 再改 / 参数照
  // schema / 别删注入」。改动即要求横幅仍在,防弱模型顺手删掉就地标注。
  'services/backend/src/tools/FileEditTool/index.js',
  'services/backend/src/tools/FileWriteTool/index.js',
  'services/backend/src/tools/GrepTool/index.js',
  'services/backend/src/tools/MultiEditTool/index.js',
  'services/backend/src/tools/ApplyPatchTool/index.js',
];

const RECOMMENDED_CHECK_RULES = [
  {
    match: file => file === 'services/backend/src/constants/prompts.js' || /^services\/backend\/tests\/prompt.*\.test\.js$/.test(file),
    commands: [
      'node --test services/backend/tests/promptOnDemandSections.test.js',
      'node --test services/backend/tests/promptLearningRules.test.js',
      'npx jest services/backend/tests/gatewayDebugPrompt.test.js --runInBand',
    ],
  },
  {
    match: file => /^services\/backend\/src\/cli\//.test(file) || /^services\/backend\/tests\/cli\//.test(file),
    commands: ['npm run test:maintainer:cli-routing'],
  },
  {
    match: file => /^services\/backend\/src\/services\/gateway\//.test(file) || /^services\/backend\/tests\/gateway\//.test(file),
    commands: ['npm run test:maintainer:gateway', 'khy doctor'],
  },
  {
    match: file => /^(services\/backend\/src\/services\/daemonManager\.js|services\/backend\/src\/services\/gateway\/proxyServer\.js|services\/backend\/src\/utils\/proxyBaseUrl\.js|services\/backend\/src\/constants\/serviceDefaults\.js|services\/backend\/tests\/daemonManager\.runtimePort\.test\.js|services\/backend\/tests\/gatewayManage\.portDrift\.integration\.test\.js|services\/backend\/tests\/services\/proxyBaseUrl\.test\.js|services\/backend\/tests\/services\/serviceDefaults\.test\.js)$/.test(file),
    commands: ['npm run test:maintainer:runtime'],
  },
  {
    match: file => /^(services\/backend\/src\/services\/aiManagementServer\.js|services\/ai-backend\/src\/routes\/aiGatewayAdmin\.js|services\/backend\/tests\/routes\/aiGatewayAdmin\.modelSlots\.test\.js|services\/backend\/tests\/gatewayManage\.apiDisplay\.test\.js)$/.test(file),
    commands: ['npm run test:maintainer:ai-management'],
  },
  {
    match: file => /^(pyproject\.toml|setup\.py|MANIFEST\.in|platform\/khy_platform\/__init__\.py|services\/backend\/package\.json|services\/backend\/tests\/publish\.)/.test(file),
    commands: ['npm run check:manifest-sync', 'npm run test:maintainer:publish', 'bash scripts/release/build-and-audit-pip-purity.sh'],
  },
  {
    match: file => /^apps\/ai-frontend\//.test(file),
    commands: ['npm run build --prefix apps/ai-frontend'],
  },
];

function run(cmd) {
  try {
    return cp.execSync(cmd, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function parseNameStatus(output) {
  return String(output || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t').filter(Boolean);
      const statusToken = String(parts[0] || '').trim();
      const status = statusToken.charAt(0).toUpperCase() || 'M';
      const currentPath = parts.length > 1 ? parts[parts.length - 1] : '';
      return {
        status,
        path: currentPath,
      };
    })
    .filter(entry => !!entry.path);
}

function listChangedEntries() {
  const baseRef = String(process.env.GIT_BASE_REF || '').trim();
  if (baseRef) {
    const out = run(`git diff --name-status --find-renames --diff-filter=ACMRD ${baseRef}...HEAD`);
    if (out) return parseNameStatus(out);
  }

  const staged = run('git diff --name-status --find-renames --cached --diff-filter=ACMRD');
  if (staged) return parseNameStatus(staged);

  const head = run('git diff --name-status --find-renames --diff-filter=ACMRD HEAD');
  if (head) return parseNameStatus(head);

  return [];
}

function shouldIgnore(filePath) {
  const parts = String(filePath || '').split(path.sep);
  return parts.some(part => IGNORE_DIRS.has(part));
}

function collectFilesFromTarget(targetPath, out) {
  const full = path.resolve(cwd, targetPath);
  if (!fs.existsSync(full)) return;
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(full)) {
      collectFilesFromTarget(path.join(targetPath, entry), out);
    }
    return;
  }
  const rel = path.relative(cwd, full).replace(/\\/g, '/');
  if (shouldIgnore(rel)) return;
  out.push({ status: 'M', path: rel });
}

function gatherEntries() {
  if (changedMode) return listChangedEntries();

  const out = [];
  for (const target of rawTargets) collectFilesFromTarget(target, out);
  return out;
}

function uniquePaths(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const normalized = String(entry.path || '').replace(/\\/g, '/');
    if (!normalized || seen.has(normalized) || shouldIgnore(normalized)) continue;
    seen.add(normalized);
    out.push({
      status: entry.status || 'M',
      path: normalized,
    });
  }
  return out;
}

function topLevelBucket(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/');
  const first = normalized.split('/')[0] || normalized;
  if (!first) return 'root';
  if (normalized === 'package.json') return 'root-config';
  return first;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizeRepoPath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function loadMaintainerMapSafe() {
  try {
    if (!fs.existsSync(maintainerMapPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(maintainerMapPath, 'utf8'));
    return Array.isArray(parsed && parsed.areas) ? parsed : null;
  } catch {
    return null;
  }
}

function getMaintainerPathType(relPath) {
  const normalized = normalizeRepoPath(relPath);
  if (!normalized) return 'missing';
  if (maintainerPathTypeCache.has(normalized)) {
    return maintainerPathTypeCache.get(normalized);
  }

  let type = 'missing';
  try {
    const fullPath = path.join(repoRoot, normalized);
    if (fs.existsSync(fullPath)) {
      type = fs.statSync(fullPath).isDirectory() ? 'dir' : 'file';
    }
  } catch {
    type = 'missing';
  }

  maintainerPathTypeCache.set(normalized, type);
  return type;
}

/**
 * 映射表 paths 悬空检测:一条 areaPath 既不是文件也不是目录(磁盘上不存在)。
 *
 * 为什么需要:check-change-safety 的推荐命令来自「改动文件落在哪个 area 的 paths 下」。
 * 若 areaPath 在目录迁移后变成陈旧路径(如 services/src/services/<name>/x.js 整批搬进
 * 同名的 domain/<板块>/ 分组),匹配恒为 false → 整个 area 静默失效,它登记的 verify
 * 命令永不进入「建议跑的验证」,而守卫自身全绿。这是「静默失效」而非「报错」,
 * 恰恰最难发现。故这里把悬空本身当 finding 报出,让改名/迁移后忘了同步映射表的情况
 * 立刻可见(与 maintainerMapDocCoverage.test.js 的 docs[] 引用完整性互补 ——
 * 该测试只管 docs,不管 paths)。
 */
function collectDanglingMaintainerPaths(maintainerMap) {
  const dangling = [];
  for (const area of (maintainerMap && maintainerMap.areas) || []) {
    for (const areaPath of (Array.isArray(area.paths) ? area.paths : [])) {
      const normalized = normalizeRepoPath(areaPath);
      if (!normalized) continue;
      if (getMaintainerPathType(normalized) === 'missing') {
        dangling.push({ area: area.id, path: normalized });
      }
    }
  }
  return dangling;
}

function pathMatchesMaintainerAreaPath(filePath, areaPath) {
  const normalizedFile = normalizeRepoPath(filePath);
  const normalizedAreaPath = normalizeRepoPath(areaPath);
  if (!normalizedFile || !normalizedAreaPath) return false;

  const areaPathType = getMaintainerPathType(normalizedAreaPath);
  if (areaPathType === 'dir') {
    return normalizedFile === normalizedAreaPath || normalizedFile.startsWith(`${normalizedAreaPath}/`);
  }
  if (areaPathType === 'file') {
    return normalizedFile === normalizedAreaPath;
  }

  return normalizedFile === normalizedAreaPath || normalizedFile.startsWith(`${normalizedAreaPath}/`);
}

function buildRecommendedCommands(entries, findings = []) {
  const paths = entries.map(entry => entry.path);
  const commands = new Set();
  const maintainerMatchedPaths = new Set();

  // ⚠ 只在**真有改动路径**时才推荐 check-agent-rules：无目标参数时它按
  // `process.exit(rawTargets.length > 0 ? 1 : 0)` 直接 exit 0 —— 是一条**必然空转**的命令。
  // 而「改动集为空但有 finding」正是全量出厂件检查（release 门）的形态：那时推荐一条空转
  // 命令等于没推荐，还会把读者的注意力从真问题上引开。
  if (paths.length > 0) {
    if (changedMode) {
      commands.add('node scripts/ci/check-agent-rules.js --changed');
    } else {
      commands.add(`node scripts/ci/check-agent-rules.js ${paths.map(shellQuote).join(' ')}`);
    }
  }

  // 形态类 finding 与改动路径无关（全量模式下 paths 为空），必须单独补一条可执行的下一步，
  // 否则「发现了出厂件明文密钥」这件事在推荐块里完全没有出口。
  if (findings.some(finding => String(finding.id).startsWith('builtin-key-'))) {
    commands.add(runnerLabel(BUILTIN_KEYS_SCRIPT));
  }

  if (paths.some(file => /\.(?:js|cjs|mjs|ts|tsx|vue|json|ya?ml)$/i.test(file))) {
    commands.add('npm run check:node-syntax');
  }
  if (paths.some(file => /\.py$/i.test(file))) {
    commands.add('npm run check:python-syntax');
  }

  const maintainerMap = loadMaintainerMapSafe();
  for (const area of (maintainerMap && maintainerMap.areas) || []) {
    const areaPaths = Array.isArray(area.paths) ? area.paths : [];
    const verifyCommands = Array.isArray(area.verify) ? area.verify : [];
    const matchedPaths = paths.filter(file => areaPaths.some(areaPath => pathMatchesMaintainerAreaPath(file, areaPath)));
    if (matchedPaths.length === 0) {
      continue;
    }
    for (const matchedPath of matchedPaths) {
      maintainerMatchedPaths.add(matchedPath);
    }
    for (const command of verifyCommands) {
      if (typeof command === 'string' && command.trim()) {
        commands.add(command.trim());
      }
    }
  }

  const fallbackPaths = paths.filter(file => !maintainerMatchedPaths.has(file));

  if (fallbackPaths.some(file => file === 'services/backend/src/constants/prompts.js' || /^services\/backend\/tests\/prompt.*\.test\.js$/.test(file))) {
    commands.add('node --test services/backend/tests/promptOnDemandSections.test.js');
    commands.add('node --test services/backend/tests/promptLearningRules.test.js');
    commands.add('npx jest services/backend/tests/gatewayDebugPrompt.test.js --runInBand');
  }
  if (fallbackPaths.some(file => /^services\/backend\/src\/cli\//.test(file))) {
    commands.add('npm run test:maintainer:cli-routing');
  }
  if (fallbackPaths.some(file => /^services\/backend\/src\/services\/gateway\//.test(file) || /^services\/backend\/src\/routes\//.test(file))) {
    commands.add('npm run test:maintainer:gateway');
    commands.add('khy doctor');
  }

  for (const rule of RECOMMENDED_CHECK_RULES) {
    if (!fallbackPaths.some(rule.match)) continue;
    for (const command of rule.commands) {
      commands.add(command);
    }
  }

  return [...commands];
}

// ── 出厂件明文密钥（SECURITY-001 的形态判据）─────────────────────────────────
// `built_in_keys.dart` 里的内置密钥是 XOR 混淆的，所以**明文形态**不该出现在出厂
// 链路的任何一环（客户端源树 / 打包产物）。判定委托给 `scripts/check_builtin_keys.py`
// ——它从 Dart 数组解码自动派生候选清单，不需要维护枚举；在这里重写一遍解码逻辑
// 必然与它漂移（旧 `check_keys.ps1` 就是因为硬编码 6 个前缀漏掉第 7 把）。
//
// 为什么挂在 check-change-safety 而不是自己开一条规则：这条约束的语义真源
// （CLAUDE.md §一 R2）本来就归 SECURITY-001，而本脚本正是它的执行器；另起一条
// 会与它同域同 subject（[MGMT-STD-008] §3 单一职责），而 §2.2 允许的两条补救
// （合并 / 拆父子）里，「拆父子」在本仓不可实现 —— `check-gov-rules.js` 的 ID
// 正则是 /^[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3}$/，`SECURITY-001.1` 判非法。
//
// 模式：改动集模式传 `--changed`（只看暂存改动，毫秒级）；全量模式（不带 --changed）
// 才连同打包产物（APK）一起扫 —— APK 是构建产物，提交时刻根本不存在。
const BUILTIN_KEYS_SCRIPT = 'scripts/check_builtin_keys.py';
const BUILTIN_KEYS_TIMEOUT_MS = 120000;

function builtinKeysUnavailable(reason) {
  return {
    id: 'builtin-key-check-failed',
    severity: 'warning',
    message: 'Built-in key plaintext check could not run.',
    detail: `${reason} 复现：${runnerLabel(BUILTIN_KEYS_SCRIPT)}`,
  };
}

function collectBuiltinKeyFindings() {
  const { command, reason } = interpreterFor(BUILTIN_KEYS_SCRIPT);
  if (!command) return [builtinKeysUnavailable(reason)];

  const cliArgs = [path.join(repoRoot, BUILTIN_KEYS_SCRIPT), '--json'];
  if (changedMode) cliArgs.push('--changed');

  let proc;
  try {
    proc = cp.spawnSync(command, cliArgs, {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: BUILTIN_KEYS_TIMEOUT_MS,
    });
  } catch (error) {
    return [builtinKeysUnavailable(`执行器无法启动：${error.message}`)];
  }
  if (proc.error) {
    return [builtinKeysUnavailable(`执行器无法启动：${proc.error.message}`)];
  }
  // 退出码 2 是「用法 / 环境错误」（Dart 文件缺失、解不出任何数组）——
  // 那是判据本身坏了，必须报出来，不能当成「干净」。
  if (proc.status === 2) {
    return [builtinKeysUnavailable(
      `执行器以退出码 2 结束（用法或环境错误）：${String(proc.stderr || '').trim()}`,
    )];
  }

  // `--json` 之后还会追加一行 `Summary: …`（scripts/ 下脚本的既有约定，
  // 与 rules 里 `--json` 后追加 Summary 同一形态）⇒ 直接 JSON.parse 会炸。
  const stdout = String(proc.stdout || '');
  let payload;
  try {
    payload = JSON.parse(stdout.split(/\n(?=Summary:)/)[0]);
  } catch (error) {
    return [builtinKeysUnavailable(`执行器输出不是合法 JSON：${error.message}`)];
  }

  return (payload.findings || []).map(hit => ({
    id: 'builtin-key-plaintext',
    severity: 'error',
    message: `Built-in key appears in plaintext in shipped artifact: [${hit.key}] @ ${hit.where}`,
    detail: '内置密钥只能以 XOR 混淆形态随包分发（SECURITY-001 / CLAUDE.md §一 R2）。'
      + ' 把明文改回混淆数组，或确认该文件本就不该出现在出厂链路上。'
      + ` 复现：${runnerLabel(BUILTIN_KEYS_SCRIPT)}`,
  }));
}

function main() {
  const entries = uniquePaths(gatherEntries());
  const findings = [];

  // 出厂件明文密钥：与改动集无关的形态检查，必须排在下面的早退**之前** ——
  // 否则「本次没改任何文件」时它会静默不执行，而那恰恰是它最该在场的场合之一。
  findings.push(...collectBuiltinKeyFindings());

  if (entries.length === 0 && findings.length === 0) {
    console.log('check-change-safety: no matching changed files.');
    process.exit(0);
  }

  const changedCount = entries.length;
  if (changedCount > ERROR_CHANGED_FILE_COUNT) {
    findings.push({
      id: 'changed-count-error',
      severity: 'error',
      message: `Changed-file count is too large for a low-cost-model pass (${changedCount} files).`,
      detail: `Reduce the blast radius or split the task. Threshold: ${ERROR_CHANGED_FILE_COUNT}.`,
    });
  } else if (changedCount > WARN_CHANGED_FILE_COUNT) {
    findings.push({
      id: 'changed-count',
      severity: 'warning',
      message: `Changed-file count is high for a low-cost-model pass (${changedCount} files).`,
      detail: `Consider splitting the work. Warning threshold: ${WARN_CHANGED_FILE_COUNT}.`,
    });
  }

  const deleted = entries.filter(entry => entry.status === 'D');
  if (deleted.length > 0) {
    findings.push({
      id: 'deletions',
      severity: 'warning',
      message: `Deletion detected in change set (${deleted.length} file(s)).`,
      detail: deleted.map(entry => entry.path).join(', '),
    });
  }

  const added = entries.filter(entry => entry.status === 'A');
  if (added.length > WARN_NEW_FILE_COUNT) {
    findings.push({
      id: 'new-files',
      severity: 'warning',
      message: `Many new files were added (${added.length} file(s)).`,
      detail: `New-file warning threshold: ${WARN_NEW_FILE_COUNT}.`,
    });
  }

  const sensitive = entries.filter(entry => SENSITIVE_PATH_RE.test(entry.path));
  if (sensitive.length > 0) {
    findings.push({
      id: 'sensitive-paths',
      severity: 'warning',
      message: `Sensitive path touched by change set (${sensitive.length} file(s)).`,
      detail: sensitive.map(entry => entry.path).join(', '),
    });
  }

  for (const rule of HIGH_RISK_PATH_RULES) {
    const hits = entries.filter(entry => rule.re.test(entry.path));
    if (hits.length === 0) continue;
    findings.push({
      id: 'high-risk-surface',
      severity: 'warning',
      message: `High-risk surface touched: ${rule.label}.`,
      detail: hits.map(entry => entry.path).join(', '),
    });
  }

  // 弱模型护栏横幅存在性:被改动且未删除的受监控高危文件,其 [AI-弱模型] 横幅必须仍在。
  for (const watched of WEAK_MODEL_BANNER_FILES) {
    const touched = entries.some(entry => entry.path === watched && entry.status !== 'D');
    if (!touched) continue;
    let content = '';
    try {
      content = fs.readFileSync(path.join(repoRoot, watched), 'utf8');
    } catch {
      continue; // 文件读不到(极少见)→ 不误报,跳过。
    }
    if (!content.includes(WEAK_MODEL_BANNER_MARK)) {
      findings.push({
        id: 'weak-model-banner',
        severity: 'error',
        message: `Weak-model guardrail banner missing after edit: ${watched}.`,
        detail: `This high-risk file must keep at least one "${WEAK_MODEL_BANNER_MARK}…]" banner. `
          + 'Restore it (source of truth: services/backend/src/services/weakModelGuidance.js).',
      });
    }
  }

  const buckets = [...new Set(entries.map(entry => topLevelBucket(entry.path)))];
  if (buckets.length > 3) {
    findings.push({
      id: 'many-areas',
      severity: 'warning',
      message: `Change set spans many top-level areas (${buckets.length}).`,
      detail: buckets.join(', '),
    });
  }

  // 映射表 paths 悬空:与改动集无关的「存量体检」——每次跑都报,否则迁移造成的
  // 静默失效会被「这次改了啥」的视角永久漏掉。故放在末尾、独立于 entries。
  const danglingMaintainerPaths = collectDanglingMaintainerPaths(loadMaintainerMapSafe());
  if (danglingMaintainerPaths.length > 0) {
    findings.push({
      id: 'dangling-maintainer-paths',
      severity: 'warning',
      message: `Maintainer map has ${danglingMaintainerPaths.length} dangling path(s); those areas can never match a change set.`,
      detail: `Affected areas: ${[...new Set(danglingMaintainerPaths.map(d => d.area))].join(', ')}. `
        + `First few: ${danglingMaintainerPaths.slice(0, 5).map(d => `${d.area} → ${d.path}`).join('; ')}. `
        + 'Fix by updating paths[] to the real location (source of truth: '
        + 'docs/14_维护者/registry/维护映射表.json).',
    });
  }

  const recommendedCommands = buildRecommendedCommands(entries, findings);

  console.log(`check-change-safety: scanned ${entries.length} changed file(s).`);
  console.log(`files: ${entries.map(entry => `${entry.status}:${entry.path}`).join(', ')}`);

  // 提升后的实际等级：--promote 命中的 id，或 --strict-warnings 下的全部 warning。
  const effectiveSeverity = (finding) => {
    if (finding.severity !== 'warning') return finding.severity;
    if (finding.id && promotedIds.has(finding.id)) return 'error';
    if (strictWarnings) return 'error';
    return 'warning';
  };

  if (findings.length === 0) {
    console.log('result: no safety findings.');
  } else {
    console.log('result:');
    for (const finding of findings) {
      const eff = effectiveSeverity(finding);
      // 被提升的条目标注出来,免得看日志的人对着 [error] 去源码里找不到对应的 severity。
      const mark = eff !== finding.severity ? ` (promoted from ${finding.severity})` : '';
      console.log(` - [${eff}]${mark} ${finding.message}${finding.id ? ` (id: ${finding.id})` : ''}`);
      if (finding.detail) console.log(`   ${finding.detail}`);
    }
  }

  if (recommendedCommands.length > 0) {
    console.log('recommended checks:');
    for (const command of recommendedCommands) {
      console.log(` - ${command}`);
    }
  }

  // 未知的 --promote id 必须报错：写错一个 id 会让本该阻断的检查静默失效，
  // 那正是本仓库 CODEOWNERS 占位符踩过的坑。
  const unknown = [...promotedIds].filter(id => !ALL_FINDING_IDS.has(id));
  if (unknown.length > 0) {
    console.error(`check-change-safety: 未知的 --promote id: ${unknown.join(', ')}`);
    console.error(`  可用 id: ${[...ALL_FINDING_IDS].join(', ')}`);
    process.exit(2);
  }

  if (findings.some(finding => effectiveSeverity(finding) === 'error')) {
    process.exit(1);
  }
}

main();
