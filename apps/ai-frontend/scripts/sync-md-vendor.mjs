/**
 * sync-md-vendor.mjs — 把 Markdown 工作台的 muya 自打包产物从单一真源
 * (`tools/khyos-markdown/vendor/`) 幂等同步到本前端的 `public/vendor/`,
 * 由 vite 原样拷进 `dist/vendor/`、经 nginx 免鉴权静态托管。
 *
 * 单一真源仍是 tools/khyos-markdown/vendor/;此脚本仅在构建/开发前把产物带过来,
 * 防止两处漂移。幂等:大小+mtime 一致则跳过拷贝;缺源文件不致命(fail-soft,
 * 只 warn 并退出 0——运行时 Markdown.vue 会因 /vendor 404 回退内联渲染器)。
 *
 * @pattern Builder
 */
import { existsSync, mkdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..'); // apps/ai-frontend
const srcDir = resolve(appRoot, '../../tools/khyos-markdown/vendor');
const destDir = resolve(appRoot, 'public/vendor');
const ASSETS = ['khyos-muya.js', 'khyos-muya.css', 'MANIFEST.json'];

function upToDate(src, dest) {
  try {
    if (!existsSync(dest)) return false;
    const a = statSync(src);
    const b = statSync(dest);
    return a.size === b.size && Math.floor(a.mtimeMs) <= Math.floor(b.mtimeMs);
  } catch (_) {
    return false;
  }
}

function main() {
  if (!existsSync(srcDir)) {
    console.warn(`[sync-md-vendor] source missing: ${srcDir} — skip (runtime falls back to inline renderer)`);
    return;
  }
  try {
    mkdirSync(destDir, { recursive: true });
  } catch (_) { /* fail-soft */ }

  let copied = 0;
  let skipped = 0;
  for (const name of ASSETS) {
    const src = join(srcDir, name);
    const dest = join(destDir, name);
    if (!existsSync(src)) {
      console.warn(`[sync-md-vendor] optional asset missing: ${name} — skip`);
      continue;
    }
    if (upToDate(src, dest)) {
      skipped++;
      continue;
    }
    try {
      copyFileSync(src, dest);
      copied++;
    } catch (err) {
      console.warn(`[sync-md-vendor] copy failed for ${name}: ${err && err.message}`);
    }
  }
  console.log(`[sync-md-vendor] done — copied ${copied}, up-to-date ${skipped} → ${destDir}`);
}

main();
