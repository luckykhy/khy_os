'use strict';

/**
 * buildOutputTargets.js — 可再生构建产物的**唯一注册表**（纯常量，零 IO）。
 *
 * 为什么单独成文件：这张表同时有两个消费方 ——
 *   1. `khy clean --build`（services/backend/src/cli/handlers/clean.js）按它删；
 *   2. 只读体积基线（extensions/scripts/khy-diagnostics/storage-baseline.js）按它量。
 * 两边各自维护一份候选路径的后果已经实测过：基线表里漏了 dist/modules 与
 * dist/debug-symbols，又留着早已不存在的 services/backend/dist，于是「体检说没多少，
 * 清理却删出一百多 MB」。一张表两处读，口径才对得上。
 *
 * 登记纪律（与清理命令同源）：
 *   - 只写**逐条登记的相对路径**，不用 glob。`**\/dist` 会把 node_modules 里几十个包
 *     自带的 dist/ 一起端走，这是清理脚本最容易出的事故。
 *   - 每一条必须写得出 `rebuild`。写不出重建命令的不叫产物，叫数据。
 *   - 不出现任何拓展 id：拓展贡献的产物按服务名动态解析，见 clean.js 的
 *     `_extensionBuildTargets()`（[DESIGN-ARCH-069] §1.3 第四条）。
 *
 * @module constants/buildOutputTargets
 */

/** dist 根目录（相对仓库根）。整棵树都是生成物，git 一条都不跟踪。 */
const DIST_ROOT = 'dist';

const REBUILD_MODULE_BUNDLES = 'node packaging/build/esbuild-modules.js --prod';
const REBUILD_DEBUG_SYMBOLS = 'node packaging/build/esbuild-modules.js --prod --debug-symbols';
const REBUILD_RELEASE_PACKAGES = 'bash scripts/release/build-and-audit-pip-purity.sh';

/**
 * dist 的细目分类。**只用于预览呈现**，不参与删除 —— 删除永远只有 dist 根一条，
 * 这样既不会把同一批字节在父项与子项里各算一遍，也不会出现「先删了子目录、
 * 再删父目录时报 ENOENT」的假失败。
 *
 * `match` 只在 dist 的**顶层**条目上判定；命中不了任何一条的归入「其余生成文件」。
 */
const DIST_SUBCATEGORIES = Object.freeze([
  Object.freeze({
    id: 'modules',
    label: '模块 bundle',
    entry: 'modules',
    rebuild: REBUILD_MODULE_BUNDLES,
  }),
  Object.freeze({
    id: 'debug-symbols',
    label: '调试符号（source map 留档）',
    entry: 'debug-symbols',
    rebuild: REBUILD_DEBUG_SYMBOLS,
  }),
  Object.freeze({
    id: 'release',
    label: '发布包（sdist / wheel）',
    match: /\.(?:whl|tar\.gz)$/,
    rebuild: REBUILD_RELEASE_PACKAGES,
  }),
]);

/** 兜底分类：上面三条都不认的 dist 顶层条目。 */
const DIST_RESIDUAL = Object.freeze({
  id: 'other',
  label: '其余生成文件',
  rebuild: REBUILD_MODULE_BUNDLES + '（按需再跑对应发布脚本）',
});

/**
 * 把 dist 的一个**顶层**条目名归类。纯字符串判定，可脱离 fs 单测。
 *
 * @param {string} name dist 下的顶层目录名或文件名
 * @returns {string} DIST_SUBCATEGORIES 里的 id，或 DIST_RESIDUAL.id
 */
function classifyDistEntry(name) {
  const value = String(name == null ? '' : name);
  for (const category of DIST_SUBCATEGORIES) {
    if (category.entry && value === category.entry) {
      return category.id;
    }
    if (category.match && category.match.test(value)) {
      return category.id;
    }
  }
  return DIST_RESIDUAL.id;
}

/**
 * 构建产物注册表。rel 相对仓库根；rebuild 是被删之后照此原样恢复的命令。
 *
 * dist 只登记根一条（细目走 DIST_SUBCATEGORIES 呈现）；其余每一处产物各自单列，
 * 因为它们分属不同构建链，重建命令不同。
 */
const BUILD_OUTPUT_TARGETS = Object.freeze([
  Object.freeze({
    rel: DIST_ROOT,
    why: '发布输出根：模块 bundle、调试符号与 sdist/wheel 全在这棵树里，整棵都是生成物',
    rebuild: REBUILD_MODULE_BUNDLES + '（模块 bundle）；' + REBUILD_RELEASE_PACKAGES + '（sdist / wheel）',
  }),
  Object.freeze({
    rel: 'build',
    why: 'setuptools 的中间目录（bdist / lib）',
    rebuild: 'python -m build',
  }),
  Object.freeze({
    rel: 'platform/khy_platform/bundled',
    why: 'wheel 里的生产 bundle 组装结果',
    rebuild: 'node scripts/release/assemble-pip-runtime.js',
  }),
  Object.freeze({
    rel: 'packaging/npm/bundled',
    why: 'npm 包的生产 bundle 组装结果',
    rebuild: 'npm run assemble --prefix packaging/npm',
  }),
  Object.freeze({
    rel: 'apps/ai-frontend/dist',
    why: 'AI 管理前端的 Vite 产物',
    rebuild: 'npm run build --prefix apps/ai-frontend',
  }),
  Object.freeze({
    rel: 'software/khyquant/frontend/dist',
    why: 'khyquant 前端的 Vite 产物',
    rebuild: 'npm run build --prefix software/khyquant/frontend',
  }),
  Object.freeze({
    rel: 'docs/_assets/mermaid.min.js',
    why: '文档站离线 Mermaid 引擎（README 明写不跟踪、按需重建）',
    rebuild: 'npm run docs:mermaid',
  }),
  Object.freeze({
    rel: 'apps/khy-mobile/android/build',
    why: 'Gradle 顶层构建目录',
    rebuild: 'cd apps/khy-mobile/android 后 gradlew assembleDebug',
  }),
  Object.freeze({
    rel: 'apps/khy-mobile/android/app/build',
    why: 'Gradle app 模块构建目录（含 APK / 中间产物）',
    rebuild: 'cd apps/khy-mobile/android 后 gradlew assembleDebug',
  }),
  Object.freeze({
    rel: 'apps/khy-mobile/android/.gradle',
    why: 'Gradle 本地缓存',
    rebuild: '下一次 gradlew 构建自动重建',
  }),
  Object.freeze({
    rel: 'coverage',
    why: '根级覆盖率报告',
    rebuild: 'npm run quality:pr（覆盖率环节自动生成）',
  }),
  Object.freeze({
    rel: 'services/backend/coverage',
    why: 'jest 覆盖率报告',
    rebuild: 'npm run test:backend -- --coverage',
  }),
  Object.freeze({
    rel: '.nyc_output',
    why: 'c8/nyc 的原始覆盖率数据',
    rebuild: '跑一次带覆盖率的测试即可',
  }),
  Object.freeze({
    rel: '.cache',
    why: '治理脚本的分析缓存（quality-gate、dangling-docs、rename-map 等）',
    rebuild: '下次运行对应检查脚本时自动重建，只是第一次会慢一点',
  }),
]);

module.exports = {
  DIST_ROOT,
  DIST_SUBCATEGORIES,
  DIST_RESIDUAL,
  BUILD_OUTPUT_TARGETS,
  classifyDistEntry,
};
