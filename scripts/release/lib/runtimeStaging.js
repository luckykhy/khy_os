'use strict';

/**
 * @pattern Builder, Template Method
 *
 * runtimeStaging.js — 把 bundle 组装进分发暂存目录的共用实现(npm 通道 / pip 通道)。
 *
 * 两条通道原来各写了一遍同样的三步：build → `rmSync(bundled)` → `copyFileSync`。
 * 这个顺序有个真实缺陷：**先把上一份 staging 删掉，再去拷**。拷贝失败(盘满、
 * 源文件被杀毒软件锁住、Windows 路径过长)就同时失去两样东西 —— 新的没建成，
 * 旧的已经没了。而 npm 通道的 assemble 挂在 `prepack` 上，`npm publish` 会恰好
 * 在那一刻发现自己既没有新产物也没有旧产物。
 *
 * 所以改成：先在同级 `<bundled>.staging-<pid>` 里把内容摞好、过一遍布局门禁，
 * 全部通过之后才动那个真正的目录 —— 换进去。任何一步失败就原地清掉临时目录，
 * 旧 staging 一个字节都没碰。
 *
 * ── 门禁为什么要在这里跑，而不是只在 CI 里跑 ──────────────────────────────
 * npm 通道的 `audit-purity.js` 禁品清单里**没有** `*.map`：今天一份 66.9 MB 的
 * source map 混进 `bundled/` 是能一路通过 prepack 直到 publish 的。而 `.map`
 * 里带着全部源码 —— 那不只是体积事故。
 *
 * `npm run check:runtime-placement` 能查出来，但它依赖「有人记得跑那条 script」。
 * 产出 staging 的脚本自己检自己，是唯一不依赖任何人记性的位置。
 *
 * 契约：成功返回结构化结果；**失败一律 throw** —— 这是发布路径，一道能被静默
 * 跳过的检查不是检查。
 */

const fs = require('fs');
const path = require('path');

const guard = require('../../lib/runtimePlacementGuard');
// 走盘与 sourceMappingURL 悬空判定复用门禁脚本自己的实现，不在这里抄第二份 ——
// 两处各写一遍就是等着有天只改一处。该文件的 main() 挂在 require.main 判断下，
// require 它不会执行任何东西。
const placement = require('../../ci/check-runtime-placement');

/** 尽力清理，绝不因清理失败掩盖真正的错误。 */
function _rmQuiet(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 组装一个分发 runtime 目录。
 *
 * @param {object} spec
 * @param {string} spec.label 日志前缀，如 'npm:assemble'
 * @param {string} spec.bundledDir 最终目录绝对路径(会被整体替换)
 * @param {Array<{from: string, to: string}>} spec.entries
 *        `from` 绝对路径；`to` 相对 bundledDir 的 posix 路径
 * @param {string} [spec.root] 仅用于把日志里的路径打短
 * @returns {{bundledDir: string, files: string[], checked: number}}
 * @throws 源文件缺失 / 拷贝失败 / 布局门禁不通过 / 换入失败
 */
function assembleRuntime(spec) {
  const label = String((spec && spec.label) || 'assemble');
  const bundledDir = String((spec && spec.bundledDir) || '');
  const entries = Array.isArray(spec && spec.entries) ? spec.entries : [];
  const root = String((spec && spec.root) || '');
  if (!bundledDir) throw new Error(`[${label}] bundledDir 未提供`);
  if (entries.length === 0) throw new Error(`[${label}] 没有要组装的条目`);

  // 先验源，再动目标。上一份 staging 在这一步之前绝不能被碰 —— 源不存在时
  // 正确的结果是「什么都没变」，而不是「旧的删了、新的没有」。
  for (const entry of entries) {
    const from = String((entry && entry.from) || '');
    let stat;
    try {
      stat = fs.statSync(from);
    } catch {
      throw new Error(
        `[${label}] 源文件不存在：${from}\n`
        + '  先跑一次构建(packaging/build/esbuild-modules.js --prod)再组装。'
      );
    }
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(`[${label}] 源文件为空或不是普通文件：${from}`);
    }
  }

  const staging = `${bundledDir}.staging-${process.pid}`;
  _rmQuiet(staging); // 上次崩溃留下的同名残渣

  const written = [];
  try {
    for (const entry of entries) {
      const rel = String(entry.to || '').split('/').join(path.sep);
      if (!rel) throw new Error(`[${label}] 条目缺少目标路径(to)`);
      const dest = path.join(staging, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(entry.from, dest);
      written.push(String(entry.to));
    }

    // ── 布局门禁：换入之前查，不通过就当这次组装没发生 ──
    const files = placement.listFiles(staging);
    const verdict = guard.inspect(files);
    const dangling = placement.danglingMapRefs(staging, files);
    if (verdict.violations.length > 0 || dangling.length > 0) {
      const lines = [`[${label}] 组装出的 runtime 不干净，拒绝换入：`, guard.render(verdict)];
      for (const item of dangling) {
        lines.push(`  ✗ ${item.path} 末尾仍指向 ${item.target}，而该文件不在产物里`);
      }
      throw new Error(lines.join('\n'));
    }

    // ── 换入 ──
    // Windows 上 rename 到已存在的目录会失败，所以先把旧的挪开。换入失败时
    // 把旧的搬回来：宁可保持上一份可用产物，也不要留一个空目录。
    const retired = `${bundledDir}.old-${process.pid}`;
    const hadPrevious = fs.existsSync(bundledDir);
    if (hadPrevious) fs.renameSync(bundledDir, retired);
    try {
      fs.mkdirSync(path.dirname(bundledDir), { recursive: true });
      fs.renameSync(staging, bundledDir);
    } catch (err) {
      if (hadPrevious && !fs.existsSync(bundledDir)) {
        try {
          fs.renameSync(retired, bundledDir);
        } catch {
          /* 回滚也失败：下面的 throw 会带出原始错误，人工介入 */
        }
      }
      throw err;
    }
    if (hadPrevious) _rmQuiet(retired);

    for (const rel of written) {
      const shown = root ? path.relative(root, path.join(bundledDir, rel)) : rel;
      console.log(`[${label}] ${shown.split(path.sep).join('/')}`);
    }
    console.log(`[${label}] 布局门禁通过(${verdict.checked} 条，无调试符号/运行期数据)`);
    return { bundledDir, files, checked: verdict.checked };
  } catch (err) {
    _rmQuiet(staging);
    throw err;
  }
}

module.exports = { assembleRuntime };
