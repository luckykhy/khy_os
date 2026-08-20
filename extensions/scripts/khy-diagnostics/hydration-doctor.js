'use strict';

/**
 * hydration-doctor.js — 首启依赖 hydration 深度自检 CLI + 清单生成器
 *
 * 用法：
 *   node scripts/hydration-doctor.js            # 探测本机 → 判断依赖 hydrate 是否健康
 *   npm run hydration-doctor                     # 同上（经 npm 别名）
 *   node scripts/hydration-doctor.js --json      # 机器可读输出（facts + verdict）
 *   node scripts/hydration-doctor.js --gen-doc   # 重新生成 OPS-MAN-070 清单
 *
 * 设计：判断逻辑全在纯叶子 scripts/lib/hydrationHealth.js（零 IO、可离线全测）；
 * 本文件只做两件事——(1) fail-soft 探测本机 node_modules 真实状态，(2) 呈现 / 落盘。
 * 任何探针失败都退化为 null（未知），绝不让自检本身崩。
 *
 * 与 restore-check 分工：restore-check 问「这台机能不能开始还原」（环境前提）；
 * 本 doctor 问「首启 hydrate 出来的依赖到底成没成」（结果核验，含裂脑检测）。
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const {
  assessHydrationHealth,
  _RULES,
  CRITICAL_PACKAGES,
  _PACKAGE_HINTS,
} = require('../../../scripts/lib/hydrationHealth');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-070] 首启依赖hydration自检清单.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';
const BOOTSTRAP_MARKER = '.khy_quant_bootstrapped';
const SEED_MARKER = '.khy_quant_seeded';

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

/** 安全判断路径存在（含 Windows junction/symlink 边缘），失败 → null。 */
function _existsSafe(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return null;
  }
}

/** 定位已装 / dev 树的后端目录（与 restore-check 同序，锚点 package.json）。 */
function _resolveBackendDir() {
  const candidates = [
    path.join(ROOT, 'platform', 'khy_os', 'bundled', 'services', 'backend'),
    path.join(ROOT, 'packaging', 'npm', 'bundled', 'services', 'backend'),
    path.join(ROOT, 'services', 'backend'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'package.json'))) return c;
    } catch { /* fail-soft */ }
  }
  return null;
}

/** node ≥ 20（系统或便携）视为达标。拿不到 → null（不误报）。 */
function _probePortableNode() {
  const v = _tryExec('node --version');
  if (!v) {
    // 系统 node 探不到，看用户级便携 Node 目录是否已落
    const homes = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'khy', 'node'),
      process.env.HOME && path.join(process.env.HOME, '.khyquant', 'node'),
      process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.khyquant', 'node'),
    ].filter(Boolean);
    for (const h of homes) {
      const e = _existsSafe(h);
      if (e === true) return true;
    }
    return null; // 都探不到，未知（首启会自动下）
  }
  const m = /v?(\d+)\./.exec(v);
  if (!m) return null;
  return Number(m[1]) >= 20;
}

/**
 * 探测后端 hydration 真实状态。整体 try 包裹，任何环节坏了都给尽力而为的 facts。
 * 关键：区分「node_modules 不在」与「node_modules 在但半装」，并检出裂脑。
 */
function probeHydrationFacts() {
  const facts = {
    nodeModulesPresent: null, missingPackages: null, sharedLinkOk: null,
    bootstrapMarker: null, seedMarker: null, portableNodeOk: null,
    optionalDegraded: null,
  };
  try {
    const backendDir = _resolveBackendDir();
    if (!backendDir) {
      // 连后端目录都没有：交给 install-integrity/restore-check，本 doctor 只报未知
      facts.portableNodeOk = _probePortableNode();
      return facts;
    }
    const nm = path.join(backendDir, 'node_modules');
    const nmPresent = _existsSafe(nm);
    facts.nodeModulesPresent = nmPresent;

    // markers 落在后端目录
    facts.bootstrapMarker = _existsSafe(path.join(backendDir, BOOTSTRAP_MARKER));
    facts.seedMarker = _existsSafe(path.join(backendDir, SEED_MARKER));

    if (nmPresent === true) {
      // 逐个 stat 关键包目录，收集缺失子集
      const missing = [];
      for (const pkg of CRITICAL_PACKAGES) {
        const pkgPath = path.join(nm, ...pkg.split('/'));
        if (_existsSafe(pkgPath) === false) missing.push(pkg);
      }
      facts.missingPackages = missing;
      // @khy/shared 单独判软链健康（在缺失列表外再确认它可解析）
      const sharedPath = path.join(nm, '@khy', 'shared');
      const sharedExists = _existsSafe(sharedPath);
      if (sharedExists === true) {
        // 软链存在还要能读到其 package.json 才算完好
        facts.sharedLinkOk = _existsSafe(path.join(sharedPath, 'package.json')) === true;
      } else if (sharedExists === false) {
        facts.sharedLinkOk = false;
      }
      // 可选依赖降级：node-llama-cpp 不在即视为降级（不阻塞）
      const llama = _existsSafe(path.join(nm, 'node-llama-cpp'));
      if (llama === false) facts.optionalDegraded = true;
      else if (llama === true) facts.optionalDegraded = false;
    }

    facts.portableNodeOk = _probePortableNode();
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

/** 探测本机 → 判断 → 彩色打印。返回退出码（0=健康，1=有拦路项）。不抛。 */
function runHydrationDoctor(opts = {}) {
  const facts = probeHydrationFacts();
  const verdict = assessHydrationHealth(facts);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ facts, verdict }, null, 2) + '\n');
    return verdict.healthy ? 0 : 1;
  }
  const head = verdict.healthy
    ? `${C.green}${C.bold}✔ ${verdict.summary}${C.reset}`
    : `${C.red}${C.bold}✘ ${verdict.summary}${C.reset}`;
  let out = `${C.bold}Khy-OS 首启依赖 hydration 自检${C.reset}\n`;
  out += `${C.dim}渠道：pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}（依赖首启联网补齐，非打包）${C.reset}\n\n`;
  out += head + '\n';
  if (facts.nodeModulesPresent !== null) {
    out += `${C.dim}  node_modules: ${facts.nodeModulesPresent ? '在' : '缺'}`;
    if (Array.isArray(facts.missingPackages)) {
      out += facts.missingPackages.length
        ? ` · 关键包缺: ${facts.missingPackages.join(', ')}`
        : ` · 关键包齐全(${CRITICAL_PACKAGES.length}/${CRITICAL_PACKAGES.length})`;
    }
    out += `${C.reset}\n`;
  }
  out += '\n';
  if (verdict.blockers.length) {
    out += `${C.red}${C.bold}拦路项（后端起不来，必须先解决）${C.reset}\n`;
    for (const b of verdict.blockers) out += _fmtItem(b, C.red);
    out += '\n';
  }
  if (verdict.warnings.length) {
    out += `${C.yellow}${C.bold}提醒（能跑但请留意）${C.reset}\n`;
    for (const w of verdict.warnings) out += _fmtItem(w, C.yellow);
    out += '\n';
  }
  out += `${C.dim}详情与人工修复步骤见：docs/07_OPS_运维/[OPS-MAN-070] 首启依赖hydration自检清单.md${C.reset}\n`;
  process.stdout.write(out);
  return verdict.healthy ? 0 : 1;
}

// ── 文档生成（清单，与规则表 + 关键包表同源，防手改漂移）──────────────────────

/** 由 _RULES + CRITICAL_PACKAGES 确定性生成清单 markdown。纯函数，不做 IO。 */
function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-070] 首启依赖 hydration 自检清单');
  lines.push('');
  lines.push('> 本文件由 `scripts/hydration-doctor.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 规则改在 `scripts/lib/hydrationHealth.js` 的 `_RULES` / `CRITICAL_PACKAGES`，再重新生成。');
  lines.push('');
  lines.push('## 这份清单是干什么的');
  lines.push('');
  lines.push('khyos 两条离机渠道的包都**不打包 `node_modules`**——后端 44 个依赖在');
  lines.push('**首次运行时联网** `npm install` 补齐（Node 运行时也是首启自动下便携版）。');
  lines.push('这一步是新机还原**最脆弱**的一环：断网、registry 不通、半截下载、');
  lines.push('workspace 软链断裂，都会让「装好了包却起不来」。本 doctor 专查这一步。');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/hydration-doctor.js      # 或 npm run hydration-doctor');
  lines.push('```');
  lines.push('');
  lines.push('## 与其他自检的分工（三层各管一段）');
  lines.push('');
  lines.push('| 自检 | 回答的问题 |');
  lines.push('|------|-----------|');
  lines.push('| `restore-check`（OPS-MAN-068） | 这台机**能不能开始**还原？（Node/npm/tar/版本/目录可写） |');
  lines.push('| `verify-install`（OPS-MAN-069） | 发出来的 **bundle 源码**齐不齐？（关键源码文件完整性） |');
  lines.push('| `hydration-doctor`（本清单） | 首启**hydrate 出来的依赖**到底成没成？（含裂脑检测） |');
  lines.push('');
  lines.push('## 最阴险的一种：裂脑（splitbrain）');
  lines.push('');
  lines.push(`首启成功后会写 marker \`${BOOTSTRAP_MARKER}\`，后续启动**见 marker 即短路**，`);
  lines.push('不再重跑 hydrate。若此后 node_modules 被误删/被清理工具清掉，marker 仍在——');
  lines.push('系统以为「装好了」，实则依赖已空，且**不会自愈**。本 doctor 的 `splitbrain-marker`');
  lines.push('规则专抓这种「marker 说好了但 node_modules 不在」的裂脑，修法是删 marker 让它重跑。');
  lines.push('');
  lines.push('## 关键运行时依赖（缺任一则后端塌陷）');
  lines.push('');
  lines.push('| 包 | 缺失后果 |');
  lines.push('|----|---------|');
  for (const pkg of CRITICAL_PACKAGES) {
    const hint = (_PACKAGE_HINTS[pkg] || '').replace(/\|/g, '\\|');
    lines.push(`| \`${pkg}\` | ${hint} |`);
  }
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
  lines.push('## 人工修复步骤（照着做）');
  lines.push('');
  lines.push('1. 跑自检，看它报哪几条拦路项：');
  lines.push('   ```bash');
  lines.push('   node scripts/hydration-doctor.js');
  lines.push('   ```');
  lines.push('2. 最常见——依赖没装齐或裂脑，联网后重跑首启：');
  lines.push('   ```bash');
  lines.push('   khy doctor');
  lines.push('   ```');
  lines.push(`3. 若报裂脑（marker 说好了但依赖不在），删后端目录的 \`${BOOTSTRAP_MARKER}\` 再重跑 khy。`);
  lines.push('4. 若报 `@khy/shared` 链接断裂，删后端目录的 `package-lock.json` 再重跑 khy（bootstrap 会重建软链）。');
  lines.push('');
  lines.push('## 红线（继承项目章程）');
  lines.push('');
  lines.push('- 真 key/token 永不进包、不落盘；占位 key 一眼假。');
  lines.push(`- pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本号必须一致。`);
  lines.push('- 本清单不教任何 commit/push/rm 危险文件/curl/publish 类危险动作（删 marker/lock 属安全局部操作）。');
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(`OK 写出 hydration 自检清单 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`);
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const code = runHydrationDoctor({ json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  probeHydrationFacts,
  runHydrationDoctor,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
