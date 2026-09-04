'use strict';

/**
 * hydrationHealth.js — Khy-OS 首启依赖 hydration 深度自检（确定性纯叶子）
 *
 * 送别礼第六件。前几件已覆盖：还原就绪（restoreReadiness，问「这台机能不能开始
 * 还原」）、已装源码完整性（installIntegrity，问「发出来的 bundle 源码齐不齐」）。
 * 本文件补上**最脆弱的一环**——首次运行时**联网 hydrate** 出来的运行时依赖到底
 * 成没成：后端 44 个 npm 依赖是否真装齐、workspace 链接 `@khy/shared`（file: 依赖，
 * 首启时靠删 lock 重装修复）有没有断、便携 Node 是否落好，以及最阴险的
 * **裂脑（splitbrain）**：hydration marker（`.khy_quant_bootstrapped`）说「装好了」
 * 但 node_modules 事后被删/半装——marker 一旦写下就短路后续 hydrate，裂脑不自愈。
 *
 * restoreReadiness 只 stat 单个 `node_modules/express`（一位信号），既看不出裂脑、
 * 也看不出 `@khy/shared` 软链断裂或便携 Node 缺失。本文件把这些各自成规则，
 * 每条配一句照抄即用的具名修法。
 *
 * 分层：本文件是**纯核心**——零 IO、无时钟、无随机、无网络、同输入恒同输出、
 * 绝不抛（任何异常都退化为安全默认）。探测机器真实事实的 IO 在 CLI
 * scripts/hydration-doctor.js 里、单独隔离且 fail-soft；本文件只做纯计算。
 *
 * 为什么这样分层：hydration 自检要能在贫瘠环境跑，把「判断」与「探测」拆开，
 * 判断内核可被 node:test 完整覆盖、可离线全绿；探测层各平台各自 fail-soft，
 * 坏一个探针不影响整体给出建议。
 *
 * HOW-TO-EXTEND（给下一个维护者 / 小模型）
 *   1. 新增一类 hydration 风险 → 往 _RULES 追加一条 { id, level, when(f), title, fix }。
 *      when(f) 是纯谓词，读 facts 字段返回真=命中；level 决定进 blockers 还是
 *      warnings；title 是人话症状，fix 是照抄即用的修法（务必安全，不得含
 *      commit/push/rm/curl/publish）。
 *   2. 若某关键依赖必须在位 → 加进 CRITICAL_PACKAGES（**必须是 services/backend
 *      package.json 的 dependencies 里真实存在的包**，反漂移测试强制这一点），
 *      再在 CLI 的探针里 stat 它。
 *   3. 若要读机器新事实 → 在 CLI 的 probeHydrationFacts 里加 fail-soft 探针，
 *      把结果塞进 facts，再在本文件加规则消费它。本文件永不自己做 IO。
 *   4. 改完跑：node --test scripts/tests/hydrationHealth.test.js（必须绿）。
 */

// 严重度：blocker=后端起不来，必须先解决；warning=能跑但有隐患/功能降级。
const LEVEL_BLOCKER = 'blocker';
const LEVEL_WARNING = 'warning';

// 修法里绝不允许出现的危险动作（与 1000 条手册同源的红线基因，避免自检建议
// 反过来教弱模型做危险操作）。仅作自检断言用，规则表本身必须天然干净。
const _DANGER_TOKENS = [
  'git commit', 'git push', 'rm -rf /', 'rm -r /', 'curl ', 'wget ',
  'npm publish', 'twine', 'sudo rm', '> /dev', 'mkfs',
];

// 运行时关键依赖：缺任一则后端要么起不来、要么核心功能塌陷。必须是 backend
// package.json 的 dependencies 真实成员（反漂移测试守此线）。刻意只挑「塌陷即
// 致命」的少数几个，而非全部 44 个——精确定位比穷举更有用。
const CRITICAL_PACKAGES = [
  'express',        // HTTP 服务骨架，缺它后端根本不监听
  '@khy/shared',    // workspace file: 依赖，软链断裂 = 大量内部 require 崩
  'better-sqlite3', // 本地库，缺它数据层无法打开
  'ws',             // WebSocket，khyos 管理面/网关实时通道依赖
  'dotenv',         // .env 加载，缺它配置全部读不到
  'sequelize',      // ORM，模型层入口
];

// 每个关键包缺失时的具体后果（供 CLI 呈现与文档生成，人话一句）。
const _PACKAGE_HINTS = {
  'express': 'HTTP 服务骨架缺失——后端不监听任何端口，管理面/网关全部 502。',
  '@khy/shared': 'workspace 共享包软链断裂——大量内部 require 崩（file: 依赖需 lock 条目，删 lock 重装可修）。',
  'better-sqlite3': '本地 SQLite 绑定缺失——数据层打不开，启动即崩。',
  'ws': 'WebSocket 库缺失——管理面/网关的实时通道断。',
  'dotenv': '.env 加载器缺失——所有环境配置读不到，行为回退到裸默认。',
  'sequelize': 'ORM 缺失——模型层入口塌陷，任何 DB 操作报错。',
};

/**
 * 事实字段（全部可空；缺失一律按「未知」保守处理，宁可提示也不漏报）：
 *   nodeModulesPresent {boolean|null} 后端 node_modules 目录是否存在
 *   missingPackages    {string[]|null} CRITICAL_PACKAGES 里探测为缺失的子集
 *   sharedLinkOk       {boolean|null} @khy/shared workspace 链接是否完好
 *   bootstrapMarker    {boolean|null} .khy_quant_bootstrapped marker 是否存在
 *   seedMarker         {boolean|null} .khy_quant_seeded marker 是否存在
 *   portableNodeOk     {boolean|null} 便携 Node 是否已 provisioned（或系统 Node 达标）
 *   optionalDegraded   {boolean|null} 可选依赖（node-llama-cpp 等）是否降级
 */

// hydration 规则表：每条是纯谓词 + 具名修法。顺序即展示优先级（越靠前越关键）。
const _RULES = [
  {
    id: 'no-node-modules',
    level: LEVEL_BLOCKER,
    when: (f) => f.nodeModulesPresent === false,
    title: '后端 node_modules 完全缺失（首启 hydrate 未跑或被清空，后端无法启动）',
    fix: '联网后重跑一次 khy（或 khy doctor）触发首启 hydrate；bootstrap 会在后端目录 `npm install` 补齐 44 个依赖。',
  },
  {
    id: 'splitbrain-marker',
    level: LEVEL_BLOCKER,
    when: (f) =>
      f.bootstrapMarker === true && f.nodeModulesPresent === false,
    title: '裂脑：hydration marker 声称已就绪，但 node_modules 不在（marker 会短路重装，不自愈）',
    fix: '删掉过期 marker 让 bootstrap 重跑：删除后端目录下的 `.khy_quant_bootstrapped` 文件，再跑 khy 触发重新 hydrate。',
  },
  {
    id: 'missing-critical-package',
    level: LEVEL_BLOCKER,
    when: (f) => Array.isArray(f.missingPackages) && f.missingPackages.length > 0,
    title: '关键运行时依赖缺失（node_modules 存在但半装，核心包不在）',
    fix: '在后端目录重跑 `npm install` 补齐缺失包；若仍缺，删 `.khy_quant_bootstrapped` 与 `package-lock.json` 后重跑 khy 全量重装。',
  },
  {
    id: 'shared-link-broken',
    level: LEVEL_BLOCKER,
    when: (f) => f.sharedLinkOk === false,
    title: '@khy/shared workspace 链接断裂（file: 依赖软链失效，大量内部模块 require 失败）',
    fix: '删后端目录的 `package-lock.json` 再重跑 khy——bootstrap 会重装并重建 `@khy/shared` 链接（这正是它对 file: 依赖的既有修复路径）。',
  },
  {
    id: 'portable-node-missing',
    level: LEVEL_WARNING,
    when: (f) => f.portableNodeOk === false,
    title: '便携 Node 未落好且未探到达标的系统 Node（后端是 Node 运行时，须有其一）',
    fix: 'khy 首启会自动下载便携版 Node（KHY_AUTO_INSTALL_NODE 默认开）；若被禁用，装系统 Node ≥ 20 后重跑 khy。',
  },
  {
    id: 'seed-missing',
    level: LEVEL_WARNING,
    when: (f) =>
      f.seedMarker === false && f.nodeModulesPresent === true,
    title: '依赖已就位但数据库 seed 未完成（首启 seed 步骤未跑完，部分默认数据可能缺）',
    fix: '再跑一次 khy（或 khy doctor）让 bootstrap 完成 DB seed；seed 幂等，重跑安全。',
  },
  {
    id: 'optional-degraded',
    level: LEVEL_WARNING,
    when: (f) => f.optionalDegraded === true,
    title: '可选依赖降级（如 node-llama-cpp 未装成，本地推理走 fallback，不影响云端功能）',
    fix: '如需本地推理：在后端目录 `npm install node-llama-cpp --no-audit --no-fund`；装不上属正常，云端通道不受影响，可忽略。',
  },
];

/** 断言一条修法文本不含危险动作（内部自检用，规则表天然应干净）。 */
function _fixIsSafe(fix) {
  const s = String(fix || '').toLowerCase();
  return !_DANGER_TOKENS.some((t) => s.includes(t.toLowerCase()));
}

/** 把任意输入规整为安全 facts；未知字段留 null（保守=提示不漏报）。 */
function _normalizeFacts(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const b = (v) => (v === true ? true : v === false ? false : null);
  let missing = null;
  if (Array.isArray(f.missingPackages)) {
    // 只保留真属于 CRITICAL_PACKAGES 的字符串项，去重、稳定
    const set = new Set(CRITICAL_PACKAGES);
    const seen = new Set();
    missing = [];
    for (const p of f.missingPackages) {
      if (typeof p === 'string' && set.has(p) && !seen.has(p)) {
        seen.add(p);
        missing.push(p);
      }
    }
  }
  return {
    nodeModulesPresent: b(f.nodeModulesPresent),
    missingPackages: missing,
    sharedLinkOk: b(f.sharedLinkOk),
    bootstrapMarker: b(f.bootstrapMarker),
    seedMarker: b(f.seedMarker),
    portableNodeOk: b(f.portableNodeOk),
    optionalDegraded: b(f.optionalDegraded),
  };
}

/**
 * 评估 hydration 健康度：喂进机器事实 → 排序算出拦路项 + 提醒项 + 每项具名修法。
 * 纯计算，绝不抛：任何异常退化为「无法判断」的保守空结果。
 *
 * @param {object} facts 见上「事实字段」说明；缺失字段按未知保守处理。
 * @returns {{healthy:boolean, blockers:Array, warnings:Array, checked:number, summary:string}}
 */
function assessHydrationHealth(facts) {
  try {
    const f = _normalizeFacts(facts);
    const blockers = [];
    const warnings = [];
    for (const rule of _RULES) {
      let hit = false;
      try {
        hit = rule.when(f) === true;
      } catch {
        hit = false; // 谓词自身出错绝不冒泡
      }
      if (!hit) continue;
      const item = {
        id: rule.id,
        level: rule.level,
        title: rule.title,
        fix: rule.fix,
      };
      if (rule.level === LEVEL_BLOCKER) blockers.push(item);
      else warnings.push(item);
    }
    const healthy = blockers.length === 0;
    const summary = healthy
      ? warnings.length === 0
        ? '健康：后端依赖 hydration 完整，可正常启动。'
        : `基本健康：无拦路项，另有 ${warnings.length} 条提醒可留意。`
      : `不健康：有 ${blockers.length} 条拦路项须先解决（另有 ${warnings.length} 条提醒）。`;
    return {
      healthy,
      blockers,
      warnings,
      checked: _RULES.length,
      summary,
    };
  } catch {
    return {
      healthy: false,
      blockers: [],
      warnings: [],
      checked: 0,
      summary: '无法判断 hydration 健康度（自检内部异常，已安全降级）。',
    };
  }
}

module.exports = {
  assessHydrationHealth,
  _RULES,
  _normalizeFacts,
  _fixIsSafe,
  CRITICAL_PACKAGES,
  _PACKAGE_HINTS,
  LEVEL_BLOCKER,
  LEVEL_WARNING,
};
