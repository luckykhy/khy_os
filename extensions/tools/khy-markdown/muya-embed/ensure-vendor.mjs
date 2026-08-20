#!/usr/bin/env node
/**
 * ensure-vendor.mjs — 幂等守卫：保证 ../vendor/ 里有一份可用的 muya 自打包产物。
 *
 * 为什么需要它：vendor/khyos-muya.{js,css} 合计 11 MB，是 build.mjs 的 esbuild
 * 产物，不进 git（见 .gitignore「可再生构建产物」段）。凡是要读这份产物的路径
 * ——npm prepack、发布 payload 组装、前端 predev/prebuild——都先过这道门。
 *
 * 判定「已就绪」：vendor/MANIFEST.json 可解析，且它列出的每个文件都存在、字节数
 * 与清单一致。任何一条不满足就整树重建（build.mjs 自己会先 rmSync 再写）。
 *
 * 用法：
 *   node ensure-vendor.mjs              # 开发态：构建失败只 warn，exit 0
 *                                       #（运行时会优雅降级到内联渲染器）
 *   node ensure-vendor.mjs --required   # 发布态：构建失败即 exit 1
 *
 * @pattern Builder
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = resolve(here, '..', 'vendor');
const required = process.argv.includes('--required');

/** vendor/ 是否已就绪（清单存在，且它列出的每个文件都存在且非空）。纯判定，不抛。
 *
 * 刻意**不**做字节数严格比对：Windows 的 core.autocrlf 会在检出时把 LF 换成
 * CRLF，历史上被跟踪的 khyos-muya.js 磁盘尺寸因此比清单大 4112 字节。产物既然
 * 由 build.mjs 一次性写出（MANIFEST 与两个文件同批生成），存在且非空就足够判定
 * 完整；尺寸不符只作提示，不触发重建。 */
function isReady() {
  try {
    const manifest = JSON.parse(readFileSync(join(vendorDir, 'MANIFEST.json'), 'utf8'));
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) return false;
    return manifest.files.every((f) => {
      const abs = join(vendorDir, f.file);
      return existsSync(abs) && statSync(abs).size > 0;
    });
  } catch (_) {
    return false;
  }
}

/** npm 在 Windows 上是 npm.cmd，必须过 shell；node 自身走 execPath，绝不过 shell
 *  （`C:\Program Files
odejs
ode.exe` 带空格，shell 拼接后会被截成 `C:\Program`）。 */
function runNpm(args) {
  execFileSync('npm', args, { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' });
}
function runNode(args) {
  execFileSync(process.execPath, args, { cwd: here, stdio: 'inherit' });
}

function main() {
  if (isReady()) {
    console.log('[ensure-vendor] vendor/ 已就绪 — 跳过构建');
    return;
  }
  console.log('[ensure-vendor] vendor/ 缺失或不完整 — 从 muya-embed/ 重建');
  try {
    if (!existsSync(join(here, 'node_modules'))) {
      runNpm([existsSync(join(here, 'package-lock.json')) ? 'ci' : 'install']);
    }
    runNode([join(here, 'build.mjs')]);
  } catch (err) {
    const msg = `[ensure-vendor] 构建失败：${err && err.message}`;
    if (required) {
      console.error(msg);
      console.error('[ensure-vendor] --required 模式：产物缺失不可放行。');
      process.exit(1);
    }
    console.warn(msg);
    console.warn('[ensure-vendor] 开发态放行；Markdown 工作台会回退到内联渲染器。');
    return;
  }
  if (!isReady()) {
    const msg = '[ensure-vendor] 构建结束但 vendor/ 仍不完整（MANIFEST 与实际文件不符）。';
    if (required) { console.error(msg); process.exit(1); }
    console.warn(msg);
  }
}

main();
