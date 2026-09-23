#!/usr/bin/env node
'use strict';
// RULES-REGISTRY: RUNTIME-006

/**
 * RUNTIME-006 执行器：网关首选通道不得在配置文件中被硬钉。
 *
 * 为什么需要这条规则（事故史，4 次复发）：
 *   2026-09-14  services/backend/.env 残留 GATEWAY_PREFERRED_ADAPTER=codex + STRICT=true，
 *               而本机 codex 无凭据 → 每次调用硬失败且不回退，表现为「所有 AI 通道均不可用」，
 *               被连续三天误诊为「密钥失效」。
 *   2026-09-17  同一文件换通道名复发（windsurf），且只在注释里写「改为 auto」、值没改。
 *   2026-09-17  第二次修完仍复发：git stash pop 把 .env 的值一起还原了。
 *   2026-09-17  第三次修完再复发（api），且发现 services/.env 也有一份同样的钉选，
 *               以前每次只清了 backend 那份 —— 这是「清不干净」的直接原因。
 *
 * 四次复发的共同形态有两个，本执行器各出一个 finding：
 *   ① gateway-pin-hard      —— 值本身是钉选（adapter 非空且非 auto）且 STRICT 未显式 false。
 *      STRICT 的语义是「未显式 false 即 strict」（与 routeFact.isStrictPinned 逐字一致），
 *      故缺省等同钉死，不能因为没写就放过。
 *   ② gateway-pin-drift     —— 注释里声明了解钉（=auto / =false），实际赋值却与之矛盾。
 *      「只改注释不改值」是上述第 2、3 次复发的直接成因，必须可检出。
 *   gateway-pin-soft        —— 钉选但 STRICT 显式 false（可回退，仅提醒收敛到 khy provider use）。
 *
 * 契约（scripts/ruleguard/lib/run.js）：
 *   输出方言 `[ERROR] <finding> <file>:<line>` + 两空格缩进的 message；
 *   有 error → exit 1；仅 warning → exit 0（--strict-warnings 时 exit 1）。
 *   支持 --changed：只扫变更文件，供 commit 档使用（全仓扫描会超 pre-commit 预算）。
 *
 * 抑制：行内 `# khy-allow-RUNTIME-006: <理由>`（理由必填，与仓库通用抑制口径一致）。
 * 零 IO 失败：任何异常 → 回退为「无发现」，绝不因守卫本身崩掉门禁。
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const ADAPTER_KEY = 'GATEWAY_PREFERRED_ADAPTER';
const STRICT_KEY = 'GATEWAY_PREFERRED_STRICT';
const RULE_ID = 'RUNTIME-006';

const AUTO_VALUES = new Set(['auto', '']);
const FALSE_VALUES = new Set(['false']);

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-electron',
  'build',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  'vendor',
  'third_party',
  // 隔离区（HK-3「只隔离不删除」）：被摘除的文件不该再拉回门禁。
  'housekeeping',
  // `.khyos/` 是本机态 + 临时诊断区（gitignore），其中的 .env 夹具不是生效配置。
  '.khyos',
]);

const args = process.argv.slice(2);
const changedMode = args.includes('--changed');
const strictWarnings = args.includes('--strict-warnings');
const explicitTargets = args.filter((a) => !a.startsWith('--'));

/** 相对仓库根的 POSIX 路径，供 finding 输出。 */
function rel(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

function listChangedFiles() {
  try {
    const out = cp.spawnSync(
      'git',
      ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'],
      { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true }
    );
    const staged = cp.spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    const merged = [];
    for (const chunk of [out.stdout, staged.stdout]) {
      for (const line of String(chunk || '').split(/\r?\n/)) {
        const t = line.trim();
        if (t && !merged.includes(t)) merged.push(t);
      }
    }
    return merged;
  } catch {
    return [];
  }
}

function collectEnvFiles() {
  const found = [];
  if (explicitTargets.length) {
    for (const t of explicitTargets) {
      const abs = path.resolve(REPO_ROOT, t);
      let st = null;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) found.push(...walk(abs));
      else if (isEnvFile(abs)) found.push(abs);
    }
    return found;
  }
  const changed = changedMode ? listChangedFiles() : null;
  if (changed) {
    for (const t of changed) {
      const abs = path.resolve(REPO_ROOT, t);
      if (isEnvFile(abs)) {
        try {
          if (fs.existsSync(abs)) found.push(abs);
        } catch {
          /* ignore */
        }
      }
    }
    return found;
  }
  return walk(REPO_ROOT);
}

function isEnvFile(abs) {
  const base = path.basename(abs);
  return base === '.env' || /^\.env[.-]/i.test(base) || /\.env$/i.test(base);
}

/**
 * 备份文件（.env.bak-*）不生效，但它们是复发的弹药 —— 2026-09-17 的第 3 次复发
 * 就是 `git stash pop` / 直接恢复备份把钉选值带回来的。故不静默放过，
 * 也不判 error（那会逼人删历史文件，违反 LAYOUT-004「只隔离不删除」），
 * 降级为 warning 并说明风险。
 */
function isBackupFile(abs) {
  return /\.bak/i.test(path.basename(abs));
}

function walk(dir) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...walk(path.join(dir, e.name)));
    } else if (e.isFile() && isEnvFile(path.join(dir, e.name))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/**
 * 解析 .env：返回最终生效值（同键后者覆盖前者，与常见 dotenv 加载一致）
 * 与该文件里出现过的全部注释声明。
 */
function parseEnv(text) {
  const values = new Map();
  const comments = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('#')) {
      comments.push({ line: lineNo, text: trimmed.slice(1).trim() });
      if (/khy-allow-RUNTIME-006\s*:\s*\S+/i.test(trimmed)) {
        comments.push({ line: lineNo, suppress: true });
      }
      return;
    }
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) return;
    const key = m[1];
    let value = m[2].trim();
    // 去掉行尾注释（值未被引号包裹时）
    const q = value[0];
    if (q !== '"' && q !== "'") {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    } else if (value.length > 1 && value[value.length - 1] === q) {
      value = value.slice(1, -1);
    }
    values.set(key, { value, line: lineNo });
  });
  return { values, comments };
}

/** 从注释里抽取「解钉意图声明」：`GATEWAY_PREFERRED_ADAPTER=auto` 之类。 */
function commentDeclarations(comments) {
  const decl = new Map();
  for (const c of comments) {
    if (c.suppress) continue;
    const re = /(GATEWAY_PREFERRED_ADAPTER|GATEWAY_PREFERRED_STRICT)\s*=\s*([A-Za-z0-9_.-]*)/g;
    let m;
    while ((m = re.exec(c.text)) !== null) {
      decl.set(m[1], { value: m[2], line: c.line });
    }
  }
  return decl;
}

function hasSuppression(comments) {
  return comments.some((c) => c.suppress === true);
}

function check() {
  const findings = [];
  const files = collectEnvFiles();
  let scanned = 0;

  for (const file of files) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    const { values, comments } = parseEnv(text);
    if (hasSuppression(comments)) continue;

    const adapter = values.get(ADAPTER_KEY);
    const strict = values.get(STRICT_KEY);
    const adapterValue = adapter ? String(adapter.value).trim().toLowerCase() : '';
    const strictValue = strict ? String(strict.value).trim().toLowerCase() : '';

    const pinned = !!adapter && !AUTO_VALUES.has(adapterValue);
    // 未显式 false 即 strict —— 与 routeFact.isStrictPinned 语义一致。
    const strictOn = !FALSE_VALUES.has(strictValue);
    const relPath = rel(file);

    if (pinned) {
      const line = adapter.line;
      if (strictOn) {
        findings.push({
          severity: isBackupFile(file) ? 'WARN ' : 'ERROR',
          finding: 'gateway-pin-hard',
          file: relPath,
          line,
          message:
            `${ADAPTER_KEY}=${adapter.value} 且 ${STRICT_KEY} 未显式 false ` +
            `（当前值 ${strict ? `"${strict.value}"` : '未设置'}）。该组合把每次请求硬钉在单一通道并抑制回退，` +
            `通道判死即表现为「所有 AI 通道均不可用」。改为 ${ADAPTER_KEY}=auto 与 ${STRICT_KEY}=false；` +
            `要固定通道请用 \`khy provider use <key>\`（会同步 STRICT 语义），不要手改本文件。` +
            (isBackupFile(file)
              ? ` 本文件是备份（不生效），但直接恢复会把钉选原样带回 —— 2026-09-17 第 3 次复发即由此而来；` +
                `建议按 LAYOUT-004 隔离到 .khyos/housekeeping/ 而非原地保留。`
              : ''),
        });
      } else {
        findings.push({
          severity: 'WARN ',
          finding: 'gateway-pin-soft',
          file: relPath,
          line,
          message:
            `${ADAPTER_KEY}=${adapter.value} 虽已放行回退，但仍是单点首选；` +
            `建议收敛到 \`khy provider use <key>\` 写入，避免下次改值漏改本文件。`,
        });
      }
    }

    // 注释与值背离：注释声明了解钉（auto / false），实际赋值却不是。
    const decl = commentDeclarations(comments);
    if (pinned && decl.has(ADAPTER_KEY)) {
      const want = String(decl.get(ADAPTER_KEY).value).trim().toLowerCase();
      if (AUTO_VALUES.has(want) && !AUTO_VALUES.has(adapterValue)) {
        findings.push({
          severity: 'WARN ',
          finding: 'gateway-pin-drift',
          file: relPath,
          line: adapter.line,
          message:
            `注释在第 ${decl.get(ADAPTER_KEY).line} 行声明 ${ADAPTER_KEY}=${decl.get(ADAPTER_KEY).value || 'auto'}，` +
            `实际值却是 ${adapter.value}（第 ${adapter.line} 行）。「只改注释不改值」是本规则四次复发的直接成因，` +
            `改注释时必须同时改值。`,
        });
      }
    }
    if (strict && strictOn && decl.has(STRICT_KEY)) {
      const want = String(decl.get(STRICT_KEY).value).trim().toLowerCase();
      if (want === 'false') {
        findings.push({
          severity: 'WARN ',
          finding: 'gateway-pin-drift',
          file: relPath,
          line: strict.line,
          message:
            `注释在第 ${decl.get(STRICT_KEY).line} 行声明 ${STRICT_KEY}=false，实际值却是 "${strict.value}"（第 ${strict.line} 行）。`,
        });
      }
    }
  }

  return { findings, scanned };
}

function main() {
  let result;
  try {
    result = check();
  } catch (err) {
    // 守卫自身绝不拖垮门禁：解析失败按「无发现」处理，但明示降级。
    process.stdout.write(`[WARN ] gateway-pin-drift scripts/ci/check-env-gateway-pin.js:1\n`);
    process.stdout.write(`  守卫自身异常，已降级为无发现：${err && err.message}\n`);
    process.stdout.write(`env-gateway-pin: 0 error / 0 warning (degraded, scanned=0)\n`);
    return 0;
  }
  const { findings, scanned } = result;
  const errors = findings.filter((f) => f.severity === 'ERROR');
  const warnings = findings.filter((f) => f.severity !== 'ERROR');

  for (const f of [...errors, ...warnings]) {
    process.stdout.write(`[${f.severity}] ${f.finding} ${f.file}:${f.line}\n`);
    process.stdout.write(`  ${f.message}\n`);
  }
  process.stdout.write(
    `env-gateway-pin: ${errors.length} error / ${warnings.length} warning (scanned=${scanned})\n`
  );
  if (errors.length) return 1;
  if (strictWarnings && warnings.length) return 1;
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { parseEnv, commentDeclarations, check };
