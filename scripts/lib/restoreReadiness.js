'use strict';

/**
 * restoreReadiness.js — Khy-OS 离机还原自检（确定性纯叶子）
 *
 * 送别礼的核心保障：这台构建机即将过期，pip(`khy-os`) 与 npm(`@khy-os/khy-os`)
 * 是仅有的两条离机渠道。开发者 / 使用者 / 维护者在**另一台机器**上装好后，
 * 需要一句话回答「我这台机器能不能完整、简单地还原 khyos？还差什么？怎么补？」。
 *
 * 本文件是那句话的确定性内核：喂进一组「机器事实」（node/npm/tar 是否可用、
 * 版本是否同步、bundled 后端是否就位、网络能否触达 registry……），排序算出
 * 「拦路项(blockers) + 提醒项(warnings) + 每项的具名可执行修法」。
 *
 * 分层：本文件是**纯核心**——零 IO、无时钟、无随机、无网络、同输入恒同输出、
 * 绝不抛（任何异常都退化为安全默认）。探测机器真实事实的 IO 在 CLI
 * scripts/restore-check.js 里、单独隔离且 fail-soft；本文件只做纯计算。
 *
 * 为什么这样分层：还原自检必须能在任意贫瘠环境跑（可能只有 python 或只有
 * node），把「判断」与「探测」拆开，判断内核可被 node:test 完整覆盖、可离线
 * 全绿，探测层各平台各自 fail-soft，坏一个探针不影响整体给出建议。
 *
 * HOW-TO-EXTEND（给下一个维护者 / 小模型）
 *   1. 新增一类还原风险 → 往 _RULES 追加一条 { id, level, when(f), title, fix }。
 *      when(f) 是纯谓词，读 facts 字段返回真=命中；level 决定它进 blockers 还是
 *      warnings；title 是人话症状，fix 是照抄即用的修法（务必安全，不得含
 *      commit/push/rm/curl/publish）。
 *   2. 若要读机器新事实 → 在 CLI 的 probeRestoreFacts 里加 fail-soft 探针，
 *      把结果塞进 facts，再在本文件加规则消费它。本文件永不自己做 IO。
 *   3. 改完跑：node --test scripts/tests/restoreReadiness.test.js（必须绿）。
 */

// 还原严重度：blocker=还原会失败，必须先解决；warning=能还原但有隐患/须留意。
const LEVEL_BLOCKER = 'blocker';
const LEVEL_WARNING = 'warning';

// 修法里绝不允许出现的危险动作（与 1000 条手册同源的红线基因，避免自检建议
// 反过来教弱模型做危险操作）。仅作自检断言用，规则表本身必须天然干净。
const _DANGER_TOKENS = [
  'git commit', 'git push', 'rm ', 'rm -', 'curl ', 'wget ',
  'npm publish', 'twine', 'sudo rm', '> /dev', 'mkfs',
];

/**
 * 事实字段（全部可空；缺失一律按「未知」保守处理，宁可提示也不漏报）：
 *   nodeOk        {boolean|null} node 是否可用且版本达标
 *   nodeVersion   {string|null}
 *   npmOk         {boolean|null} npm 是否可用
 *   tarOk         {boolean|null} 系统 tar 是否可用（khy restore 解包依赖）
 *   bundlePresent {boolean|null} bundled 后端源码是否就位
 *   nodeModulesPresent {boolean|null} bundled 后端 node_modules 是否已 hydrate
 *   registryReachable  {boolean|null} 能否触达 npm registry（首启 hydrate 前提）
 *   versionsSynced {boolean|null} pip/npm/backend 版本是否一致
 *   channel       {string|null} 'pip' | 'npm' | 'both' | null
 *   writableInstall {boolean|null} 安装目录是否可写（bootstrap 需落 node_modules/.env）
 */

// 还原规则表：每条是一个纯谓词 + 具名修法。顺序即展示优先级（越靠前越关键）。
// when(f) 返回真=命中；命中项按 level 分流进 blockers / warnings。
const _RULES = [
  {
    id: 'node-missing',
    level: LEVEL_BLOCKER,
    when: (f) => f.nodeOk === false,
    title: 'Node.js 不可用或版本过低（khyos 后端是 Node 运行时，没有它无法启动）',
    fix: 'khy 会在首启自动下载便携版 Node（KHY_AUTO_INSTALL_NODE 默认开）；若被禁用或下载失败，请手动装 Node ≥ 20 后重跑 khy。',
  },
  {
    id: 'npm-missing',
    level: LEVEL_BLOCKER,
    when: (f) => f.npmOk === false,
    title: 'npm 不可用（首启需 npm 把后端 44 个依赖 hydrate 出来）',
    fix: '安装随 Node 附带的 npm（装 Node ≥ 20 通常自带）；装好后重跑 khy，bootstrap 会自动补齐 node_modules。',
  },
  {
    id: 'bundle-missing',
    level: LEVEL_BLOCKER,
    when: (f) => f.bundlePresent === false,
    title: 'bundled 后端源码缺失（包不完整，还原无从谈起）',
    fix: '重新安装官方包：pip 通道 `pip install --force-reinstall khy-os`，或 npm 通道 `npm install -g @khy-os/khy-os`；两条渠道的包都自带 bundled 源码。',
  },
  {
    id: 'offline-no-modules',
    level: LEVEL_BLOCKER,
    when: (f) =>
      f.nodeModulesPresent === false && f.registryReachable === false,
    title: '离线且后端依赖未 hydrate（两条渠道都不打包 node_modules，首启须联网补齐）',
    fix: '接入能访问 npm registry 的网络后重跑 khy 完成首启 hydrate；确需离线，请在有网机器上先跑通一次，再把整个已 hydrate 的 khyos 目录整体拷到离线机。',
  },
  {
    id: 'versions-drift',
    level: LEVEL_BLOCKER,
    when: (f) => f.versionsSynced === false,
    title: 'pip / npm / backend 版本不一致（双渠道漂移会导致还原到半新半旧的裂脑状态）',
    fix: '统一到同一版本：`khy update` 会按当前渠道同步；或重装官方包让三处版本归一（红线要求 pip khy-os 与 npm @khy-os/khy-os 版本必须相等）。',
  },
  {
    id: 'tar-missing',
    level: LEVEL_WARNING,
    when: (f) => f.tarOk === false,
    title: '系统 tar 不可用（khy restore 解包源码快照依赖它，缺它则整份工作树快照无法展开）',
    fix: '装系统 tar：Linux/macOS 自带；Windows 10 1803+ 自带，老版本 Windows 请装 tar 或用 7-Zip 手动解 _source 快照。',
  },
  {
    id: 'modules-not-hydrated',
    level: LEVEL_WARNING,
    when: (f) =>
      f.nodeModulesPresent === false && f.registryReachable !== false,
    title: '后端依赖尚未 hydrate（首次运行会联网 npm install，属正常，耗时几分钟）',
    fix: '首启会自动补齐；想提前跑通就先执行一次 khy（或 khy doctor），等 node_modules 落好即算还原完成。',
  },
  {
    id: 'install-readonly',
    level: LEVEL_WARNING,
    when: (f) => f.writableInstall === false,
    title: '安装目录不可写（bootstrap 要往包内写 node_modules / .env，只读会让首启失败）',
    fix: '改用用户级安装：`pip install --user khy-os`，或把 npm 全局前缀指向可写目录后重装。',
  },
  {
    id: 'single-channel',
    level: LEVEL_WARNING,
    when: (f) => f.channel === 'pip' || f.channel === 'npm',
    title: '仅装了一条渠道（pip 与 npm 是仅有的两条离机渠道，留一条备用更稳）',
    fix: '可选：另一条渠道也装上做冗余——pip 用户加 `npm install -g @khy-os/khy-os`，npm 用户加 `pip install khy-os`；两者共存由 khy update 渠道感知同步。',
  },
];

/** 断言一条修法文本不含危险动作（内部自检用，规则表天然应干净）。 */
function _fixIsSafe(fix) {
  const s = String(fix || '').toLowerCase();
  return !_DANGER_TOKENS.some((t) => s.includes(t.toLowerCase()));
}

/** 把任意输入规整为布尔/字符串安全 facts；未知字段留 null（保守=提示不漏报）。 */
function _normalizeFacts(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const b = (v) => (v === true ? true : v === false ? false : null);
  return {
    nodeOk: b(f.nodeOk),
    nodeVersion: typeof f.nodeVersion === 'string' ? f.nodeVersion : null,
    npmOk: b(f.npmOk),
    tarOk: b(f.tarOk),
    bundlePresent: b(f.bundlePresent),
    nodeModulesPresent: b(f.nodeModulesPresent),
    registryReachable: b(f.registryReachable),
    versionsSynced: b(f.versionsSynced),
    channel:
      typeof f.channel === 'string' && f.channel ? f.channel : null,
    writableInstall: b(f.writableInstall),
  };
}

/**
 * 评估还原就绪度：喂进机器事实 → 排序算出拦路项 + 提醒项 + 每项具名修法。
 * 纯计算，绝不抛：任何异常退化为「无法判断」的保守空结果。
 *
 * @param {object} facts 见上「事实字段」说明；缺失字段按未知保守处理。
 * @returns {{ready:boolean, blockers:Array, warnings:Array, checked:number, summary:string}}
 */
function assessRestoreReadiness(facts) {
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
    const ready = blockers.length === 0;
    const summary = ready
      ? warnings.length === 0
        ? '就绪：这台机器可以完整还原 khyos。'
        : `基本就绪：无拦路项，另有 ${warnings.length} 条提醒可留意。`
      : `未就绪：有 ${blockers.length} 条拦路项须先解决（另有 ${warnings.length} 条提醒）。`;
    return {
      ready,
      blockers,
      warnings,
      checked: _RULES.length,
      summary,
    };
  } catch {
    return {
      ready: false,
      blockers: [],
      warnings: [],
      checked: 0,
      summary: '无法判断还原就绪度（自检内部异常，已安全降级）。',
    };
  }
}

module.exports = {
  assessRestoreReadiness,
  _RULES,
  _normalizeFacts,
  _fixIsSafe,
  LEVEL_BLOCKER,
  LEVEL_WARNING,
};
