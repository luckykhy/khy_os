'use strict';

/**
 * verify-install.js — 已装副本完整性自检 CLI + 完整性清单生成器
 *
 * 用法：
 *   node scripts/verify-install.js           # 探测已装 bundle → 判断运行时关键文件是否齐全
 *   npm run verify-install                    # 同上（经 npm 别名）
 *   node scripts/verify-install.js --json     # 机器可读输出（probes + verdict）
 *   node scripts/verify-install.js --gen-doc  # 重新生成 OPS-MAN-069 完整性清单
 *
 * 设计：判断逻辑全在纯叶子 scripts/lib/installIntegrity.js（零 IO、可离线全测）；
 * 本文件只做两件事——(1) fail-soft 定位已装 bundle 根并 stat 每条关键路径，
 * (2) 呈现 / 落盘。任何探针失败都退化为「缺失」保守处理，绝不让自检本身崩。
 *
 * 为谁而写：构建机即将报废，pip(`khy-os`)/npm(`@khy-os/khy-os`) 的完整性校验
 * 原本只在构建机上跑。这个 CLI 把「产物完整」从构建机搬到**每一台幸存者的机器**，
 * 让开发者 / 使用者 / 维护者能离线自证「我装进来的东西没缺没坏」。
 */

const fs = require('fs');
const path = require('path');
const {
  assessInstallIntegrity,
  CRITICAL_BUNDLE_PATHS,
} = require('../lib/installIntegrity');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-069] 已装副本完整性自检清单.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

// ── 探测层（IO，全部 fail-soft）───────────────────────────────────────────────

/**
 * 定位已装 bundle 根：依次探 pip 布局、npm 布局、开发树。
 * 用 services/backend/package.json 作为「这是真 bundle 根」的锚点。
 * 全部探不到 → null（CLI 会据此报「无法定位 bundle」）。绝不抛。
 */
function resolveBundleRoot() {
  const candidates = [
    path.join(ROOT, 'platform', 'khy_os', 'bundled'), // pip 源树 / 已装 wheel 内亦是此结构
    path.join(ROOT, 'packaging', 'npm', 'bundled'), // npm 源树
    ROOT, // 开发树：关键路径直接挂在仓库根下
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'services', 'backend', 'package.json'))) return c;
    } catch {
      /* fail-soft，继续下一个 */
    }
  }
  return null;
}

/** 对每条关键路径 stat 是否存在。bundleRoot 为 null 时全部记 false。绝不抛。 */
function probeInstalledBundle(bundleRoot) {
  const probes = {};
  for (const rel of CRITICAL_BUNDLE_PATHS) {
    let exists = false;
    if (bundleRoot) {
      try {
        exists = fs.existsSync(path.join(bundleRoot, rel));
      } catch {
        exists = false;
      }
    }
    probes[rel] = exists;
  }
  return probes;
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

/** 定位 + 探测 + 判断 + 彩色打印。返回退出码（0=完整，1=不完整）。不抛。 */
function runVerifyInstall(opts = {}) {
  const bundleRoot = resolveBundleRoot();
  const probes = probeInstalledBundle(bundleRoot);
  const verdict = assessInstallIntegrity(probes, { bundleResolved: bundleRoot !== null });
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ bundleRoot, probes, verdict }, null, 2) + '\n'
    );
    return verdict.intact ? 0 : 1;
  }
  const head = verdict.intact
    ? `${C.green}${C.bold}✔ ${verdict.summary}${C.reset}`
    : `${C.red}${C.bold}✘ ${verdict.summary}${C.reset}`;
  let out = `${C.bold}Khy-OS 已装副本完整性自检${C.reset}\n`;
  out += `${C.dim}渠道：pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}（仅有的两条离机渠道）${C.reset}\n`;
  out += `${C.dim}bundle 根：${bundleRoot ? path.relative(ROOT, bundleRoot) || '.' : '未定位'}${C.reset}\n\n`;
  out += head + '\n\n';
  if (verdict.missing.length) {
    out += `${C.red}${C.bold}缺失的运行时关键文件${C.reset}\n`;
    for (const m of verdict.missing) {
      out += `  ${C.red}• ${m.path}${C.reset}\n`;
      out += `    ${C.dim}${m.reason}${C.reset}\n`;
    }
    out += `\n  ${C.yellow}修法：${verdict.missing[0].fix}${C.reset}\n\n`;
  } else if (verdict.intact) {
    out += `${C.dim}  已核对 ${verdict.present.length} 项运行时关键文件，全部就位。${C.reset}\n\n`;
  }
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-069] 已装副本完整性自检清单.md${C.reset}\n`;
  process.stdout.write(out);
  return verdict.intact ? 0 : 1;
}

// ── 文档生成（完整性清单，与关键路径表同源，防手改漂移）──────────────────────

/** 由 CRITICAL_BUNDLE_PATHS + 渠道常量确定性生成清单 markdown。纯函数，不做 IO。 */
function buildDoc() {
  const { _PATH_HINTS } = require('../lib/installIntegrity');
  const lines = [];
  lines.push('# [OPS-MAN-069] 已装副本完整性自检清单');
  lines.push('');
  lines.push('> 本文件由 `scripts/verify-install.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 关键路径改在 `scripts/lib/installIntegrity.js` 的 `CRITICAL_BUNDLE_PATHS`，再重新生成。');
  lines.push('');
  lines.push('## 这份清单是干什么的');
  lines.push('');
  lines.push('前面几件送别礼检查「周遭」（环境、版本、依赖）；这一件检查**装进来的东西本身**：');
  lines.push('你从 pip / npm 装好之后，运行时关键文件是不是齐的？下载有没有被截断？某个文件');
  lines.push('有没有没被打进 bundle？在**任意新机器上、离线**跑一句就知道：');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/verify-install.js      # 或 npm run verify-install');
  lines.push('```');
  lines.push('');
  lines.push('## 为什么必须搬到你的机器上跑');
  lines.push('');
  lines.push('发布侧本就有完整性校验（`scripts/release/pip_packaging_rules.py` 的');
  lines.push('`REQUIRED_WHEEL_PATHS`、npm 的 `REQUIRED_PATHS`），但那是在**构建机**上、对');
  lines.push('**刚构建的产物**跑的。构建机一旦报废，另一台机器上的「装了一半 / 下载截断 /');
  lines.push('文件缺失」就无人可查。本自检把这份保证搬到**每一台幸存者的机器**，可离线运行。');
  lines.push('');
  lines.push('本清单的关键路径逐条源自 `REQUIRED_WHEEL_PATHS`（发布门权威清单，来自真实生产');
  lines.push('事故——ai-backend 鉴权中间件曾掉出打包，令每条代理/网关路由 500）。两处由测试');
  lines.push('`scripts/tests/installIntegrity.test.js` 的反漂移断言强制一致，杜绝各说各话。');
  lines.push('');
  lines.push('## 它检查这些运行时关键文件（缺任一 = khy 可能起不来）');
  lines.push('');
  lines.push('| 关键路径（相对 bundle 根） | 缺失意味着 |');
  lines.push('|------|------|');
  for (const p of CRITICAL_BUNDLE_PATHS) {
    const reason = (_PATH_HINTS[p] || '关键文件缺失。').replace(/\|/g, '\\|');
    lines.push(`| \`${p}\` | ${reason} |`);
  }
  lines.push('');
  lines.push('## 结果怎么读');
  lines.push('');
  lines.push('- **完整**：关键文件全在，已装副本可用——放心跑 khy。');
  lines.push('- **不完整**：列出缺了哪些文件。统一修法是重装官方包补齐：');
  lines.push('  ```bash');
  lines.push(`  pip install --force-reinstall ${PIP_PKG_NAME}`);
  lines.push(`  npm install -g ${NPM_PKG_NAME}`);
  lines.push('  ```');
  lines.push('- **无法定位 bundle**：包没装好或严重不完整，按上面重装。');
  lines.push('');
  lines.push('## 与其它自检的分工');
  lines.push('');
  lines.push('- `restore-check`（OPS-MAN-068）：查**环境**能否还原（Node/npm/tar/版本同步）。');
  lines.push('- `verify-install`（本清单）：查**已装副本本身**是否完整无损。');
  lines.push('- 两者互补：环境齐了但文件缺了，或文件全了但环境缺了，都还原不成。');
  lines.push('');
  lines.push('## 红线（继承项目章程）');
  lines.push('');
  lines.push('- 真 key/token 永不进包、不落盘；占位 key 一眼假。');
  lines.push(`- pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本号必须一致。`);
  lines.push('- 本清单不教任何 commit/push/rm/curl/publish 类危险动作。');
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出完整性清单 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const code = runVerifyInstall({ json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  resolveBundleRoot,
  probeInstalledBundle,
  runVerifyInstall,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
