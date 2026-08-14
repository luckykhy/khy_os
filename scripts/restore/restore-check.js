'use strict';

/**
 * restore-check.js — 离机还原自检 CLI + 还原清单生成器
 *
 * 用法：
 *   node scripts/restore-check.js            # 探测本机事实 → 判断能否完整还原 khyos
 *   npm run restore-check                     # 同上（经 npm 别名）
 *   node scripts/restore-check.js --json      # 机器可读输出（facts + verdict）
 *   node scripts/restore-check.js --gen-doc   # 重新生成 OPS-MAN-068 还原清单
 *
 * 设计：判断逻辑全在纯叶子 scripts/lib/restoreReadiness.js（零 IO、可离线全测）；
 * 本文件只做两件事——(1) fail-soft 探测本机真实事实，(2) 呈现 / 落盘。
 * 任何探针失败都退化为 null（未知），绝不让自检本身崩。
 *
 * 为谁而写：这台构建机即将过期，pip(`khy-os`)/npm(`@khy-os/khy-os`) 是仅有的两条
 * 离机渠道。开发者 / 使用者 / 维护者在另一台机器装好后跑 `khy restore-check`，
 * 就能一眼看清「能不能还原、还差什么、每一步怎么补」。
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const {
  assessRestoreReadiness,
  _RULES,
} = require('../lib/restoreReadiness');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-068] 离机还原自检清单.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

// ── 探测层（IO，全部 fail-soft，失败即 null=未知）─────────────────────────────

/** 静默跑一条命令拿 stdout；任何失败返回 null。绝不抛。 */
function _tryExec(cmd) {
  try {
    return cp
      .execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 8000 })
      .trim();
  } catch {
    return null;
  }
}

/** node ≥ 20 视为达标。拿不到版本 → null（未知，不误报）。 */
function _probeNode() {
  const v = _tryExec('node --version'); // 形如 v20.11.0
  if (!v) return { nodeOk: null, nodeVersion: null };
  const m = /v?(\d+)\./.exec(v);
  if (!m) return { nodeOk: null, nodeVersion: v };
  return { nodeOk: Number(m[1]) >= 20, nodeVersion: v };
}

/** 某可执行是否存在（跨平台粗探）。失败 → null。 */
function _probeExecutable(bin) {
  const out = _tryExec(process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`);
  return out ? true : null;
}

/** 读一个 package.json 的 version，fail-soft。 */
function _readVersion(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** 读 pyproject.toml 的 version（3.8 兼容的行扫描，不依赖 toml 解析器）。 */
function _readPyprojectVersion(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const m = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(raw);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** 判断 pip/npm/backend 三处版本是否一致。任一读不到 → null（不误报漂移）。 */
function _probeVersionsSynced() {
  const py = _readPyprojectVersion(path.join(ROOT, 'pyproject.toml'));
  const npm = _readVersion(path.join(ROOT, 'packaging', 'npm', 'package.json'));
  const be = _readVersion(path.join(ROOT, 'services', 'backend', 'package.json'));
  const seen = [py, npm, be].filter((v) => typeof v === 'string' && v);
  if (seen.length < 3) return { versionsSynced: null, versions: { py, npm, be } };
  return { versionsSynced: new Set(seen).size === 1, versions: { py, npm, be } };
}

/** bundled 后端源码是否就位；node_modules 是否已 hydrate。dev 树与已装包都适用。 */
function _probeBundle() {
  const candidates = [
    path.join(ROOT, 'platform', 'khy_os', 'bundled', 'services', 'backend'),
    path.join(ROOT, 'packaging', 'npm', 'bundled', 'services', 'backend'),
    path.join(ROOT, 'services', 'backend'),
  ];
  let backendDir = null;
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'package.json'))) { backendDir = c; break; }
    } catch { /* fail-soft */ }
  }
  if (!backendDir) return { bundlePresent: false, nodeModulesPresent: null };
  let hydrated = null;
  try {
    hydrated = fs.existsSync(path.join(backendDir, 'node_modules', 'express'));
  } catch { hydrated = null; }
  return { bundlePresent: true, nodeModulesPresent: hydrated };
}

/** 安装目录是否可写（bootstrap 需落 node_modules/.env）。探测失败 → null。 */
function _probeWritable() {
  try {
    fs.accessSync(ROOT, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 汇总本机事实。整体 try 包裹，任何环节坏了都给出尽力而为的 facts。 */
function probeRestoreFacts() {
  const facts = {
    nodeOk: null, nodeVersion: null, npmOk: null, tarOk: null,
    bundlePresent: null, nodeModulesPresent: null, registryReachable: null,
    versionsSynced: null, channel: null, writableInstall: null,
  };
  try {
    const n = _probeNode();
    facts.nodeOk = n.nodeOk;
    facts.nodeVersion = n.nodeVersion;
    facts.npmOk = _probeExecutable('npm');
    facts.tarOk = _probeExecutable('tar');
    const b = _probeBundle();
    facts.bundlePresent = b.bundlePresent;
    facts.nodeModulesPresent = b.nodeModulesPresent;
    const v = _probeVersionsSynced();
    facts.versionsSynced = v.versionsSynced;
    facts._versions = v.versions;
    facts.writableInstall = _probeWritable();
    // registryReachable / channel 留 null：无害网络探测代价高且易误判，
    // 交由 doctor / 首启真实反馈；未知不误报（见纯叶子保守取舍）。
  } catch {
    /* fail-soft：返回已填的部分 facts */
  }
  return facts;
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

function _fmtItem(item, color) {
  return (
    `  ${color}• ${item.title}${C.reset}\n` +
    `    ${C.dim}修法：${item.fix}${C.reset}\n`
  );
}

/** 探测本机 → 判断 → 彩色打印。返回退出码（0=就绪，1=有拦路项）。不抛。 */
function runRestoreCheck(opts = {}) {
  const facts = probeRestoreFacts();
  const verdict = assessRestoreReadiness(facts);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ facts, verdict }, null, 2) + '\n');
    return verdict.ready ? 0 : 1;
  }
  const head = verdict.ready
    ? `${C.green}${C.bold}✔ ${verdict.summary}${C.reset}`
    : `${C.red}${C.bold}✘ ${verdict.summary}${C.reset}`;
  let out = `${C.bold}Khy-OS 离机还原自检${C.reset}\n`;
  out += `${C.dim}渠道：pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}（仅有的两条离机渠道）${C.reset}\n\n`;
  out += head + '\n';
  if (facts.nodeVersion) out += `${C.dim}  Node: ${facts.nodeVersion}${C.reset}\n`;
  if (facts._versions) {
    out += `${C.dim}  版本: pip=${facts._versions.py} npm=${facts._versions.npm} backend=${facts._versions.be}${C.reset}\n`;
  }
  out += '\n';
  if (verdict.blockers.length) {
    out += `${C.red}${C.bold}拦路项（还原会失败，必须先解决）${C.reset}\n`;
    for (const b of verdict.blockers) out += _fmtItem(b, C.red);
    out += '\n';
  }
  if (verdict.warnings.length) {
    out += `${C.yellow}${C.bold}提醒（能还原但请留意）${C.reset}\n`;
    for (const w of verdict.warnings) out += _fmtItem(w, C.yellow);
    out += '\n';
  }
  out += `${C.dim}详情与人工还原步骤见：docs/07_OPS_运维/[OPS-MAN-068] 离机还原自检清单.md${C.reset}\n`;
  process.stdout.write(out);
  return verdict.ready ? 0 : 1;
}

// ── 文档生成（还原清单，与规则表同源，防手改漂移）────────────────────────────

/** 由 _RULES + 渠道常量确定性生成还原清单 markdown。纯函数，不做 IO。 */
function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-068] 离机还原自检清单');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-check.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 规则改在 `scripts/lib/restoreReadiness.js` 的 `_RULES`，再重新生成。');
  lines.push('');
  lines.push('## 这份清单是干什么的');
  lines.push('');
  lines.push('khyos 只有两条离机渠道，二者缺一不可、互为冗余：');
  lines.push('');
  lines.push(`- **pip**：\`pip install ${PIP_PKG_NAME}\``);
  lines.push(`- **npm**：\`npm install -g ${NPM_PKG_NAME}\``);
  lines.push('');
  lines.push('在**任意新机器**上装好后，跑一句自检就知道能不能完整还原：');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-check.js      # 或 npm run restore-check');
  lines.push('```');
  lines.push('');
  lines.push('它会探测本机事实（Node/npm/tar/bundled/版本同步/目录可写……），');
  lines.push('给出「就绪 / 未就绪」+ 每条拦路项与提醒的**照抄即用修法**。');
  lines.push('');
  lines.push('## 一句话真相：包里有什么、没有什么');
  lines.push('');
  lines.push('- 两条渠道的包都自带 **bundled 后端源码 + 加密全量源码快照**（`khy restore` 可解）。');
  lines.push('- 两条渠道都**不打包 `node_modules`**：后端 44 个依赖在**首次运行时联网** `npm install` 补齐。');
  lines.push('- Node.js 运行时**不打包**：缺失时 khy 首启自动下载便携版（`KHY_AUTO_INSTALL_NODE` 默认开）。');
  lines.push('- 结论：**装好包 + 首次联网跑一次 = 完整还原**。想离线还原，须在有网机器先跑通一次再整目录拷走。');
  lines.push('');
  lines.push('## 自检会检查这些项');
  lines.push('');
  lines.push('| 项 | 级别 | 症状 | 修法 |');
  lines.push('|----|------|------|------|');
  for (const r of _RULES) {
    const level = r.level === 'blocker' ? '拦路' : '提醒';
    const title = r.title.replace(/\|/g, '\\|');
    const fix = r.fix.replace(/\|/g, '\\|');
    lines.push(`| \`${r.id}\` | ${level} | ${title} | ${fix} |`);
  }
  lines.push('');
  lines.push('## 人工还原步骤（照着做）');
  lines.push('');
  lines.push('1. 装任一渠道的包（两条都装更稳）：');
  lines.push('   ```bash');
  lines.push(`   pip install ${PIP_PKG_NAME}`);
  lines.push(`   npm install -g ${NPM_PKG_NAME}`);
  lines.push('   ```');
  lines.push('2. 跑自检，按拦路项逐条修：');
  lines.push('   ```bash');
  lines.push('   node scripts/restore-check.js');
  lines.push('   ```');
  lines.push('3. 首次运行 khy（会联网 hydrate 后端依赖，耗时几分钟，属正常）：');
  lines.push('   ```bash');
  lines.push('   khy doctor');
  lines.push('   ```');
  lines.push('4. 需要还原完整工作树快照时：');
  lines.push('   ```bash');
  lines.push('   khy restore');
  lines.push('   ```');
  lines.push('');
  lines.push('## 红线（继承项目章程）');
  lines.push('');
  lines.push('- 真 key/token 永不进包、不落盘；占位 key 一眼假。');
  lines.push(`- pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本号必须一致（自检的 \`versions-drift\` 项守此线）。`);
  lines.push('- 本清单不教任何 commit/push/rm/curl/publish 类危险动作。');
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(`OK 写出还原清单 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`);
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const code = runRestoreCheck({ json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  probeRestoreFacts,
  runRestoreCheck,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
