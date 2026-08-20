/**
 * quantApp.js — 「谁提供 khyquant 量化应用」的**单一解析点**。
 *
 * 背景（[DESIGN-ARCH-069] §1.5「入向耦合三档」）：khyquant 是全仓最严重的一处
 * **硬入向**——`services/backend/src` 里有 57 个纯 re-export 壳各自写死
 * `require('../../../../software/khyquant/<模块>')`，其中 19 个路由壳被
 * `server.js` 在启动期直接 require。后果有两条，第二条是致命的：
 *   1. 核里写死了实现的磁盘层数，57 处各写一遍，下一次移动就要改 57 个地方；
 *   2. 删掉 khyquant 目录，那 19 个 require 在**模块加载期**抛 MODULE_NOT_FOUND，
 *      `server.js` 连启动都失败。那不叫「删目录即卸载」，那叫删目录即整机不可用，
 *      正是 §4.1 要禁的。
 *
 * 本模块把 57 处「点名实现位置」收敛成一处「点名**服务**」：核说它要 `quant-app`，
 * 不说它要 software/khyquant 或 extensions/software/khy-quant。谁来满足由 manifest
 * 的 `provides` 声明（§3.4），于是 Phase 1 把目录搬进 extensions/ 时，核**一行都不用改**。
 *
 * 解析顺序（可信度降序，全程不抛，落空返回 null 由调用方按后果决定降级）：
 *   ① provides 契约发现 —— extensionRoots.findProvider() 扫全部根。**这是正路**。
 *   ② 迁移期兜底 —— khyquant 目前仍在 L4 `software/`，不在任何拓展根下，契约发现
 *      必然落空。兜底让 Phase 0 成为**纯重构**（行为逐字节不变），Phase 1 搬完目录
 *      即可删掉这一支。它写的是 L4 路径而不是拓展 id，因此不触 §1.3 第四条。
 *
 * ## 为什么不直接用 providerModule.requireFromProvider
 *
 * 那个通用解析点把「拓展未安装」与「装了但模块加载抛错」都吞成 null。对交付/诊断
 * 路径够用，对这里不够：一个路由模块里的真 bug 会因此从**启动期大声崩**退化成
 * **静默 404**，而 §3.4 明确要求「拓展未安装」和「装了但坏了」不能报同一句话。
 * 所以本模块自己解析：目录/文件不在 → null（未安装那一档）；文件在而 require 抛错
 * → **照抛**（那是真 bug，吞掉它比崩溃更难查）。
 *
 * @module services/extensions/quantApp
 * @pattern Facade, Strategy
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** 服务名：核唯一该知道的字符串。按能力取名，不按实现取名（§3.4）。 */
const SERVICE = 'quant-app';

/**
 * 迁移期兜底目录：khyquant 的 L4 现址。
 * 从 `<repo>/services/backend/src/services/extensions/` 上溯 5 层到仓库根。
 */
const L4_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', 'software', 'khyquant');

/** 目录解析缓存。`undefined` = 尚未解析；`null` = 解析过且没有。 */
let _dirCache;

/**
 * 定位量化应用目录。
 * @returns {string|null} 绝对路径；未安装 / 已删目录 / 已禁用 → null
 */
function resolveDir() {
  if (_dirCache !== undefined) {
    return _dirCache;
  }
  _dirCache = null;

  // ① provides 契约发现（正路）
  try {
    const hit = require('./extensionRoots').findProvider(SERVICE);
    if (hit && hit.dir) {
      _dirCache = hit.dir;
      return _dirCache;
    }
  } catch (_) {
    // 契约模块本身不可用（被裁剪的模块化构建）—— 落到 ②
  }

  // ② 迁移期兜底：仍在 L4
  try {
    if (fs.statSync(L4_DIR).isDirectory()) {
      _dirCache = L4_DIR;
    }
  } catch (_) {
    // 目录不在 —— 保持 null
  }
  return _dirCache;
}

/**
 * 取量化应用里的一个模块。
 *
 * @param {string} rel - 相对应用根的模块路径，如 `'routes/market'` 或 `'models/Trade'`
 * @returns {object|null} require 到的模块；应用未安装 / 该模块不存在 → null。
 *   **模块存在但加载抛错时照抛**，不吞（见模块头「为什么不直接用 requireFromProvider」）。
 */
function loadModule(rel) {
  if (!rel || typeof rel !== 'string') {
    return null;
  }
  const dir = resolveDir();
  if (!dir) {
    return null; // 未安装
  }
  const file = rel.endsWith('.js') ? rel : `${rel}.js`;
  const abs = path.join(dir, file);
  try {
    if (!fs.statSync(abs).isFile()) {
      return null; // 该模块不在这个应用里 —— 同属「未安装」那一档
    }
  } catch (_) {
    return null;
  }
  return require(abs); // 存在即加载；抛错照抛
}

/** 清缓存（仅供测试）。 */
function __resetCache() {
  _dirCache = undefined;
}

module.exports = { SERVICE, loadModule, resolveDir, __resetCache };
