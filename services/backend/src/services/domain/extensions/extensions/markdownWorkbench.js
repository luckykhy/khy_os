/**
 * markdownWorkbench.js — 「谁提供 Markdown 工作台」的**单一解析点**。
 *
 * 背景（[DESIGN-ARCH-069] §1.3 第四条：核里不允许出现拓展 id 的硬编码分支）：
 * 此前同一个拓展在核里有**三份互不认识的定位逻辑**——
 *   - cli/handlers/md.js         三段式解析，正确，但困在 L2 的 cli 子层里；
 *   - cli/handlers/docs.js       自己拼 `tools/khyos-markdown`，迁移后**指向空气**，
 *                                `khy docs browse` 因此静默失效（fail-soft 掩盖了它）；
 *   - services/{aiManagementKhyosWs,mdEditorRegister}.js
 *                                `require('../../../../cli/handlers/md')` —— 服务层反向依赖 cli 层。
 * 三份的共同病根是「核点名了一个拓展」：只要核里写着 khy-markdown，就会有第二处、第三处
 * 各自去猜它在磁盘的哪一层，而其中任何一处都可能像 docs.js 那样在下一次移动中烂掉。
 *
 * 本模块只做一件事：把「点名拓展」换成「点名**服务**」。核说它要一个
 * `markdown-workbench`，不说它要 khy-markdown。谁来满足由 manifest 的 `provides`
 * 声明（见 §3.4），于是拓展可以改名、可以被第三方实现替换、可以装在任何一个根下，
 * 核一行都不用改。
 *
 * 解析顺序（可信度降序，全程不抛，落空返回 null 由调用方给提示）：
 *   ① KHY_MD_TOOLS_DIR 显式覆盖 —— 保留历史变量名，既有部署与测试不受迁移影响。
 *   ② provides 契约发现 —— extensionRoots.findProvider() 扫全部根。**这是正路**。
 *   ③ id 兜底 —— 老 manifest 还没写 provides 时按 id 命中，仅为迁移期存在。
 *   ④ 相对路径兜底 —— **仅当契约模块本身不可用时**（被裁剪的模块化构建）。
 *     契约在位却说「没有」，那就是真的没有 —— 禁用与删除必须能压住兜底，否则 §4.1 失效。
 *
 * ③④ 是 fail-soft 冗余，不是真源；③ 在 provides 普及后可删。
 *
 * @module services/extensions/markdownWorkbench
 * @pattern Facade, Strategy
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** 服务名：核唯一该知道的字符串。 */
const SERVICE = 'markdown-workbench';
/** 入口探针：声明了服务却没带着桥接器的目录不算数，否则同名空目录就能骗过解析。 */
const ENTRY_PROBE = 'khyos-md-bridge.js';
/** 迁移期兜底用的 id。**不是**分派依据——只在 manifest 尚未声明 provides 时兜底。 */
const LEGACY_ID = 'khy-markdown';

function hasEntry(dir) {
  try {
    return !!dir && fs.statSync(path.join(dir, ENTRY_PROBE)).isFile();
  } catch (_) {
    return false;
  }
}

/**
 * 定位 Markdown 工作台拓展目录。
 * @returns {string|null} 绝对路径；未安装 / 已删目录 / 已禁用 → null
 */
function resolveDir() {
  // ① 显式覆盖
  const envDir = process.env.KHY_MD_TOOLS_DIR;
  if (hasEntry(envDir)) {
    return envDir;
  }

  // ② provides 契约发现（正路）
  let roots = null;
  try {
    roots = require('./extensionRoots');
    const hit = roots.findProvider(SERVICE, { probe: ENTRY_PROBE });
    if (hit && hit.dir) {
      return hit.dir;
    }
  } catch (_) {
    /* 契约模块缺失/异常 → 往下兜底 */
  }

  // ③ id 兜底（迁移期）
  if (roots) {
    try {
      for (const ext of roots.discover()) {
        if (ext.id === LEGACY_ID && hasEntry(ext.dir)) {
          return ext.dir;
        }
      }
    } catch (_) {
      /* 继续 ④ */
    }
  }

  // ④ 相对路径兜底 —— **仅当契约模块不可用时**。
  //
  // 这个前置条件不是优化，是正确性：若无条件执行，它会绕过契约的**全部**判决
  // —— 拓展被显式禁用、目录被删、仓库根被门控关闭，三种情形下契约都已给出
  // 「不可见」，而一条硬目录探测会把它捧回来，使 [DESIGN-ARCH-069] §4.1 第二条
  // 「目录不在 → 拓展不存在」失效。契约模块在位时，它的结论就是终局结论。
  if (roots) {
    return null;
  }
  const fallbacks = [
    path.resolve(__dirname, '..', '..', '..', '..', '..', 'extensions', LEGACY_ID),
    path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'extensions', LEGACY_ID),
  ];
  for (const c of fallbacks) {
    if (hasEntry(c)) {
      return c;
    }
  }
  return null;
}

/**
 * 加载桥接器模块。定位与加载分开：调用方多半两件都要，但失败原因必须可区分
 * （「没装这个拓展」和「装了但入口坏了」是两种事，混在一起报会让人去查错的地方）。
 * @returns {{dir: string, bridge: object}|null}
 */
function loadBridge() {
  const dir = resolveDir();
  if (!dir) {
    return null;
  }
  return { dir, bridge: require(path.join(dir, ENTRY_PROBE)) };
}

module.exports = { resolveDir, loadBridge, SERVICE, ENTRY_PROBE };
