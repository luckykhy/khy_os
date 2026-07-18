'use strict';

/**
 * nlInstallVsConfigGuard.js — 纯叶子:自然语言「配置 khy vs 安装第三方工具」歧义护栏
 * (单一真源)。
 *
 * 背景(真实事故):用户粘贴一段第三方 AI CLI(如 OpenCode)的**安装+配置文档**,文档里
 * 含 `npm install -g opencode-ai`、`opencode -v` 等安装命令,末尾要求「参照这个配置方法在
 * khy 里配置 SenseNova 的 API key」。弱模型读到安装命令后**自作主张**把它理解成「用户要
 * 安装 OpenCode」,建了一份安装待办清单——而用户真实意图是把那份文档里的连接参数
 * (baseURL / apiKey / model)映射到 khy 自身的配置机制。khy 此前对这类粘贴是裸转发,无任何
 * 护栏,故弱模型自由发挥就跑偏了。
 *
 * 本叶子补这一缺口:确定性识别「粘贴含安装命令 + 又说要配置/参照」这一歧义场景,产出一段
 * 系统提示词指令,命令模型:① 不要执行文档里的第三方安装命令、不要生成安装待办;② 把文档
 * 里的连接参数映射到 khy 自己的配置面(SENSENOVA_API_KEY 等环境变量 / `khy gateway model`
 * 命令 / .env),用 Configure 工具落地;③ 若确实无法判断用户是要「配置 khy」还是「真的想
 * 安装那个第三方工具」,先问一句澄清再动手。本叶子只产「该怎么理解 + 怎么做」的指令,绝不
 * 短路 LLM、绝不代替模型执行任何动作。
 *
 * 与既有 NL 解析器的分工(正交):
 *   - nlProviderResolver:抓到**字面 key 值**时把「增/删/列 provider」解析成结构化意图。
 *     但粘贴文档里往往是 `$SENSENOVA_API_KEY` 占位符而非裸 key → 它返回 null → 正是本叶子
 *     要接管的空档。
 *   - 本叶子:不抽字段、不落地,只在「安装命令 + 配置意图」同现的歧义场景注入澄清+映射指令。
 *
 * 契约(CONTRACT):零 IO(只读 process.env 做门控)、确定性(无随机 / 无时钟)、绝不抛
 *   (fail-soft,任何异常 → null)、单一真源(判据 + 指令文案只在此处)、env 门控
 *   KHY_INSTALL_CONFIG_GUARD 默认开(仅 {0,false,off,no} 关;关 → resolve 恒 null,注入点
 *   字节回退到「不注入」的今日行为)。
 *
 * 零假阳性优先:必须**同时**命中 ①安装命令信号 ②配置/参照语言,才成立。故:
 *   - 纯「帮我安装 opencode」(无配置/参照语言)→ 不触发(那是真安装请求,不干预)。
 *   - 纯「配置一下日日新的 key」(无安装命令)→ 不触发(无歧义)。
 *   - 「参照这个方法配置 khy」+ 粘贴含 `npm install -g opencode-ai` → 触发(歧义场景)。
 *
 * 全局门控惯例:KHY_* 读法为 `!FALSY.has(v)`,FALSY = {0,false,off,no}。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_INSTALL_CONFIG_GUARD 默认开,仅 {0,false,off,no} 关。env 由调用方注入。 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_INSTALL_CONFIG_GUARD;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// ── 安装命令信号(第三方包管理器 install 命令,中英)────────────────────────────
// 只认「包管理器 + install/安装动作」的确定形态,避免把「安装到位」等散文误判。
const _INSTALL_CMD_RE = new RegExp(
  [
    'npm\\s+install',
    'npm\\s+i\\b',
    'pnpm\\s+(?:add|install)',
    'yarn\\s+(?:add|global\\s+add)',
    'pip3?\\s+install',
    'pipx\\s+install',
    'brew\\s+install',
    'apt(?:-get)?\\s+install',
    'cargo\\s+install',
    'go\\s+install',
    'gem\\s+install',
    'curl\\s+[^\\n]*\\|\\s*(?:sh|bash)', // curl … | sh 一键装
  ].join('|'),
  'i',
);
// 全局安装旗标(`-g` / `--global`)进一步佐证「装一个 CLI 工具」而非项目依赖。可选增强,不单独成立。
const _GLOBAL_FLAG_RE = /(?:\s-g\b|--global\b)/i;

// ── 配置 / 参照语言(用户意图是「照着这个配 khy」而非「执行这些安装命令」)──────────
const _CONFIG_REF_RE = new RegExp(
  [
    '参照', '参考', '按照', '照(?:着|这|此)', '仿照', '依照',
    '配置', '设置', '设定', '配一?下', '配好',
    '\\bconfig(?:ure)?\\b', '\\bset\\s*up\\b', '\\bsetup\\b', '\\breference\\b',
    '\\bfollow\\s+(?:this|the)\\b', '\\bbased\\s+on\\b',
  ].join('|'),
  'i',
);

// ── khy 自身配置领域引用(有它更确信「配的是 khy」,但非必需——参照语言已足够歧义)─────
// 仅用于让指令更精准地点名(是不是在配 provider / key / 模型),不参与触发判据。
const _KHY_CONFIG_DOMAIN_RE = /(api\s*key|apikey|密钥|秘钥|令牌|\bkey\b|\btoken\b|模型|\bmodel\b|供应商|厂商|provider|渠道|中转|base\s*url|endpoint|端点|接口)/i;

// nullish-安全字符串规整单一真源 utils/cleanText:null/undefined → 空串,其余 String 后 trim。
const _clean = require('../../utils/cleanText');

const _DIRECTIVE = [
  '【配置 khy vs 安装第三方工具 —— 歧义护栏】',
  '用户的消息里粘贴了某个第三方工具的安装+配置文档(含 `npm install` / `pip install` 等安装命令),',
  '但用户明确说的是「参照/按照这个方法配置」。这几乎总是意味着:用户想把文档里的**连接参数**',
  '(baseURL、apiKey、模型名)套用到 **khy 自身**的配置上,而**不是**要你去安装那个第三方工具。',
  '',
  '你必须:',
  '1. 绝不执行文档里的第三方安装命令(不要跑 `npm install -g …`),绝不生成「安装该工具」的待办清单。',
  '2. 把文档里的第三方 provider 配置**翻译**成 khy 自己的配置机制:',
  '   - API key → 对应的环境变量(如 SenseNova/日日新 用 `SENSENOVA_API_KEY`);',
  '   - baseURL/endpoint → khy 已内置默认(SenseNova 默认 `https://token.sensenova.cn/v1`),',
  '     需自定义时用 `SENSENOVA_API_ENDPOINT`;',
  '   - 模型名 → `GATEWAY_PREFERRED_MODEL`(如 `sensenova-6.7-flash-lite`);',
  '   - 首选适配器 → `GATEWAY_PREFERRED_ADAPTER`。',
  '   落地优先用交互命令 `khy gateway model`(选完自动写回 .env 并即时生效),或用 Configure 工具',
  '   直接改 .env,而不是叫用户「自己去文件里改」。',
  '3. 如果你确实无法判断用户到底是要「在 khy 里配置这个 provider」还是「真的想另装那个第三方工具」,',
  '   先用一句话澄清问题问清楚,再动手——不要默认去安装。',
  '',
  '记住:khy 是最终要被配置的对象;那份文档只是「参照样例」,不是「待执行脚本」。',
].join('\n');

/**
 * 自然语言 → 歧义护栏指令。返回:
 *   { directive }  命中歧义场景(安装命令 + 配置/参照语言同现)
 *   null           未命中(绝不猜)
 * fail-soft:任何异常 → null。
 */
function resolve(text, env = process.env) {
  try {
    if (!isEnabled(env)) return null;
    const t = _clean(text);
    // 上限放宽到 4000:粘贴的配置文档通常较长(本场景的核心输入形态)。
    if (!t || t.length > 4000) return null;

    // 零假阳性闸门:必须同时命中「安装命令」+「配置/参照语言」。
    if (!_INSTALL_CMD_RE.test(t)) return null;
    if (!_CONFIG_REF_RE.test(t)) return null;

    return { directive: _DIRECTIVE };
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  resolve,
  // 导出仅供测试断言判据构成,不含运行时副作用。
  _INSTALL_CMD_RE,
  _CONFIG_REF_RE,
  _GLOBAL_FLAG_RE,
  _KHY_CONFIG_DOMAIN_RE,
};
