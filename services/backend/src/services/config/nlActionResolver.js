'use strict';

/**
 * nlActionResolver.js — 纯叶子:自然语言 → khyos「动作意图」解析(单一真源)。
 *
 * 背景(goal「khy 中人类的自然语言要能驱动一切」):khyos 已有
 *   nlConfigResolver —— 把自然语言解析成「配置开关」(开/关某能力)。
 * 但「自然语言驱动一切」不止于改开关,更要能驱动**动作/任务**。本叶子补这一缺口:
 * 把诸如「找你自己的 bug 并修复」「去 GitHub 学最火的项目」这类**动作请求**确定性地
 * 识别出来,产出一段系统提示词指令,命令模型用 khyos **既有的**子系统/工具真正去做,
 * 并带上安全栏与诚实边界 —— 而不是回复「我做不到 / 请你手动操作」。
 *
 * 与 nlConfigResolver 的分工(正交,绝不混淆):
 *   - nlConfigResolver:NL → 配置开关(envKey on/off),落地由 Configure 工具写 .env。
 *   - nlActionResolver(本文件):NL → 动作意图,落地由模型用既有工具(Grep/Read/editFile/
 *     lintCode/forgeSearch/forgeRecon/gitClone…)执行,本叶子只产「该怎么做」的指令。
 *
 * 复用而非重造(指令里指向的全是既有件):
 *   - 自查修复:Grep/Read/lintCode 实地排查 + editFile 修根因 + evolutionPolicy 可变性分级
 *     (immutable 绝不改)+ 任务完成时既有 auditFixLoop 自动复审。
 *   - 平台学习:forgeSearch(默认按 star 降序=最火)+ forgeRecon/forgeCodeSearch/forgeCommits
 *     研读 + gitClone 深读。
 *
 * 契约(CONTRACT):零 IO(只读 process.env 做门控)、确定性(无随机/无时钟)、绝不抛
 *   (fail-soft,任何异常 → null)、单一真源(动作注册表 + 识别判据 + 指令文案只在此处)、
 *   env 门控 KHY_NL_ACTION 默认开(仅 {0,false,off,no} 关;关 → routeActionIntent 恒 null,
 *   注入点字节回退到「不注入任何动作指令」的今日行为)。
 *
 * 零假阳性优先:只有命中某个动作的**明确判据**(动作动词 + 明确对象,自查类还须 self 引用)
 *   才成立;「帮我找我项目里的 bug」(用户自己的项目,非 khy 自身)、「学习一下 promise」
 *   (无平台/无项目)等绝不误触。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

function isEnabled(env = process.env) {
  const raw = env && env.KHY_NL_ACTION;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// ── 识别判据(中/英,大小写不敏感)──────────────────────────────────────────────
// self-bug-fix:必须同时命中 ①self 引用 ②bug 名词 ③查找或修复动词。
const _SELF_RE = /(你自己|它自己|自己的|自身|自我|khy\s*(?:os)?\s*(?:自身|本体|自己)|yourself|your\s+own|itself|self[-\s]?)/i;
const _BUG_RE = /(bug|缺陷|漏洞|错误|毛病|问题代码|defects?|issues?\b)/i;
const _FIND_RE = /(找|查找|查一?下|排查|检查|审查|审计|扫描|揪出|发现|找出|find|scan|audit|hunt|detect|review)/i;
const _FIX_RE = /(修复|修一?下|修掉|改掉|解决|fix|repair|patch|resolve)/i;

// forge-learn:必须命中 ①平台或「开源项目」②学习/参考动词。最火/最新为可选增强。
const _PLATFORM_RE = /(github|gitlab|gitee|开源(?:平台|社区|项目|仓库)?|开源界|码云|forge)/i;
const _LEARN_RE = /(学习|学一?下|参考|借鉴|取经|研读|研究|看看(?:别人|开源)|study|learn|reference|借鉴一?下)/i;
const _PROJECT_RE = /(项目|仓库|repo(?:sitor(?:y|ies))?|工程|代码库|library|框架|framework)/i;
const _HOT_RE = /(最火|最热|热门|流行|最受欢迎|最新|trending|popular|hottest|newest|latest)/i;

/**
 * 动作注册表 —— 单一真源。每项:
 *   id        稳定标识
 *   summary   一句话中文摘要(给状态行/确认用)
 *   match     (text) => boolean  确定性识别判据(零假阳性)
 *   directive [SYSTEM:] 系统提示词指令(命令模型用既有工具真正执行 + 安全栏 + 诚实边界)
 * 新增一类「自然语言可驱动的动作」= 在此追加一项,无需改任何其它代码。
 */
const ACTIONS = [
  {
    id: 'self-bug-fix',
    summary: '查找并修复 khy 自身的 bug',
    match(text) {
      const t = String(text || '');
      return _SELF_RE.test(t) && _BUG_RE.test(t) && (_FIND_RE.test(t) || _FIX_RE.test(t));
    },
    directive: [
      '[SYSTEM: 自然语言驱动 —— 自查并修复自身 bug]',
      '用户要求 khy 查找并修复它**自己(khyos 本体)**的 bug。这是 khy 合法、可执行的能力,',
      '**绝不**回复「我无法修改自己」「请你手动检查」「这超出我的能力」。请用现有工具真正执行:',
      '1. 定位自身源码:khy 的本体源码就是**当前项目仓库**(以 `services/backend/src` 为主的 khyos 源码)。',
      '   用 Grep/Read/lintCode 在其中**实地**排查真实 bug(被吞掉的空 catch、错误边界条件、未处理 null/异常、',
      '   契约违反、回归风险、资源泄漏),**绝不臆造不存在的 bug**。',
      '2. 遵守可变性分级(evolutionPolicy):immutable 区域(内核/打包/CI/SSOT)**绝不**改;guarded 区域改动',
      '   要履行连带义务;evolvable 区域可改。改动前可用 `khy evolve classify <path>` 核对分级。',
      '3. 修根因不打补丁:用 editFile/MultiEdit 做**最小、可解释**的修复;每处说明「这是什么 bug、为什么是 bug、',
      '   怎么修的」。优先纯叶子化判据、门控默认开关即字节回退,符合本仓库工程纪律。',
      '4. 自校验:改完在改动集上跑 `node --check` / 相关测试 / 机器守卫;任务完成时既有 auditFixLoop 会自动复审。',
      '5. 诚实:只报**实证发现**的 bug 与**已验证**的修复;若确实查不到明确 bug,就如实说「未发现明确 bug」并',
      '   说明排查范围,**绝不**为凑数编造或做无意义改动。',
    ].join('\n'),
  },
  {
    id: 'forge-learn',
    summary: '去开源平台学习最新/最火的项目',
    match(text) {
      const t = String(text || '');
      const platformOrOss = _PLATFORM_RE.test(t);
      const learn = _LEARN_RE.test(t);
      // 平台 + 学习动词即成立;或「学习 + 项目 + 热度词」(未点名平台但明确要去开源项目学)。
      return (platformOrOss && learn) || (learn && _PROJECT_RE.test(t) && _HOT_RE.test(t));
    },
    directive: [
      '[SYSTEM: 自然语言驱动 —— 去开源平台学习最新/最火的项目]',
      '用户要求 khy 去 GitHub/GitLab/Gitee 等平台学习当下**最新/最火**的开源项目。这是合法、可执行能力,',
      '**绝不**回复「我无法访问外部」「请你自己去看」。请用现有 `forge` 工具真正执行:',
      '1. 发现:用 `forgeSearch` 工具按用户给的主题搜索 —— 它**默认按 star 数降序**返回,即「最火/最受欢迎」',
      '   的项目优先。若用户没指明方向,请先用一句话请他给出领域/语言(如「Rust CLI」「LLM agent」)再搜。',
      '2. 研读:对挑中的 repo 用 `forgeRecon`(读 README/关键文件/结构)、`forgeCodeSearch`(按关键词搜其代码)、',
      '   `forgeCommits`(看近期演进与提交质量)提炼其设计思路、值得借鉴的模式与坑。',
      '3. 深读时:用 `gitClone` 把仓库拉到本地再用 Read/Grep 细看(克隆 URL **绝不内嵌 token**)。',
      '4. 产出:用中文总结「这个项目解决什么问题、核心设计、**可迁移到 khy 的点**、风险/不适用处」,',
      '   **而不是**整段照抄代码。',
      '5. 诚实:尊重平台速率限制;无网络/无凭据时如实说明,并给可行替代(让用户提供 token 或离线参考)。',
    ].join('\n'),
  },
];

const _BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

// 去掉代码块与行内 code,避免把示例里的关键词误判为用户指令。委托单一真源 utils/stripCodeSpans。
const _stripCode = require('../../utils/stripCodeSpans');

/**
 * 自然语言 → 动作意图。返回 { id, summary, directive } 或 null(未确定,绝不猜)。
 * fail-soft:任何异常 → null。门控关 → null。
 * 命中多动作时按 ACTIONS 顺序取第一个(确定性)。
 */
function resolveActionIntent(text, env = process.env) {
  try {
    if (!isEnabled(env)) return null;
    const cleaned = _stripCode(text);
    if (!cleaned.trim()) return null;
    for (const action of ACTIONS) {
      if (action.match(cleaned)) {
        return { id: action.id, summary: action.summary, directive: action.directive };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 列出全部 NL 可驱动动作(给工具/CLI/帮助/提示词用)。 */
function describeActions() {
  return ACTIONS.map((a) => ({ id: a.id, summary: a.summary }));
}

/** 按 id 取动作(测试/CLI 用)。 */
function findAction(id) {
  if (!id) return null;
  return _BY_ID.get(String(id).trim()) || null;
}

/**
 * 缝入口:解析本轮文本,命中动作 → 返回 { directive, intent };未命中/门控关 → null。
 * 与 nlConfigResolver.routeConfigIntent 不同:动作类**仅在命中时**注入,未命中零注入(零噪声)。
 */
function routeActionIntent(opts = {}) {
  try {
    const env = opts.env || process.env;
    if (!isEnabled(env)) return null;
    const intent = resolveActionIntent(opts.text || '', env);
    if (!intent) return null;
    return { directive: intent.directive, intent };
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  ACTIONS,
  resolveActionIntent,
  describeActions,
  findAction,
  routeActionIntent,
};
