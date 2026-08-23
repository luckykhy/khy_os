#!/usr/bin/env node
/**
 * ensure-mermaid.mjs — 幂等守卫：保证 docs/_assets/mermaid.min.js 存在。
 *
 * 为什么需要它：那份 3.3 MB 的 bundle 是 build.mjs 的 esbuild 产物，不进 git
 * （见 .gitignore「可再生构建产物」段）。文档站生成器把它当离线资源引入
 * （build_docs_site.js:554），校验器把它列为必备资源（verify_docs_site.js 第 8-9
 * 行），所以 docs:build 之前必须先过这道门。
 *
 * 构建成功后自动清掉自己的 node_modules（实测 127.7 MB，产出物只有 3.3 MB）：
 * 安装树本身没有留存价值。反复改 build.mjs 时用 KHY_KEEP_BUILD_DEPS=1 保留。
 * 只有真跑过构建才清 —— 产物已就绪而直接短路的那条路上一次构建都没跑，
 * 那棵树是开发者自己装的，只提示不删。
 *
 * 用法：
 *   node ensure-mermaid.mjs             # 开发态：构建失败只 warn，exit 0
 *                                       #（docs-site.js:401 会优雅降级，图表区留白）
 *   node ensure-mermaid.mjs --required  # 发布态：构建失败即 exit 1
 *   KHY_KEEP_BUILD_DEPS=1 node ensure-mermaid.mjs  # 保留 node_modules 便于反复构建
 *
 * 重建命令（被清掉之后照此恢复）：
 *   npm run docs:mermaid
 *
 * @pattern Builder
 */
import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const outfile = resolve(root, 'docs', '_assets', 'mermaid.min.js');
const required = process.argv.includes('--required');
const REBUILD_CMD = 'npm run docs:mermaid';

/** 取清理器。取不到就退化成空操作：清理是优化，不是产出。 */
async function loadCleaner() {
  try {
    return (await import('../../lib/buildDepsCleanup.mjs')).cleanBuildDeps;
  } catch (_) {
    return null;
  }
}

/** 产物是否已就绪。存在且非空即可——build.mjs 要么整份写出要么抛错。 */
function isReady() {
  try {
    return statSync(outfile).size > 0;
  } catch (_) {
    return false;
  }
}

/** npm 在 Windows 上是 npm.cmd，必须过 shell；node 自身走 execPath，绝不过 shell
 *  （`C:\Program Files\nodejs\node.exe` 带空格，shell 拼接后会被截成 `C:\Program`）。 */
function runNpm(args) {
  execFileSync('npm', args, { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' });
}
function runNode(args) {
  execFileSync(process.execPath, args, { cwd: here, stdio: 'inherit' });
}

async function main() {
  const clean = await loadCleaner();
  const sweep = (built) => {
    if (!clean) return;
    clean({ dir: here, label: 'ensure-mermaid', rebuildCommand: REBUILD_CMD, built });
  };

  if (isReady()) {
    console.log('[ensure-mermaid] docs/_assets/mermaid.min.js 已就绪 — 跳过构建');
    sweep(false);
    return;
  }
  console.log('[ensure-mermaid] mermaid.min.js 缺失 — 从 scripts/docs/mermaid-embed/ 重建');
  try {
    if (!existsSync(join(here, 'node_modules'))) {
      runNpm([existsSync(join(here, 'package-lock.json')) ? 'ci' : 'install']);
    }
    runNode([join(here, 'build.mjs')]);
  } catch (err) {
    const msg = `[ensure-mermaid] 构建失败：${err && err.message}`;
    if (required) {
      console.error(msg);
      console.error('[ensure-mermaid] --required 模式：离线文档站不能少这份资源。');
      process.exit(1);
    }
    console.warn(msg);
    console.warn('[ensure-mermaid] 开发态放行；生成的文档站图表区域会留白（不报错）。');
    return;
  }
  if (!isReady()) {
    // 产物没出来就保留安装树：下一次要靠它排查，这时候清是帮倒忙。
    if (required) {
      console.error('[ensure-mermaid] 构建结束但产物仍不存在。');
      process.exit(1);
    }
    return;
  }
  sweep(true);
}

main();
