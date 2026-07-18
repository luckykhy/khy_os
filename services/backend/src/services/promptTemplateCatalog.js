'use strict';

// [AI-弱模型·照抄] 本文件是纯叶子:改动照 goalStopGate.js 的 isEnabled 形状(委托 flagRegistry +
//   注册表关时 _off 逐字节回退);接线(aiManagementServer 路由)照 toolUseLoop.js:4276 的 try/catch
//   fail-soft——判定/数据在叶子,IO 在接线处,叶子绝不抛、门关返空。

/**
 * promptTemplateCatalog.js
 *
 * 「网页空态该给用户看哪些起始提示词模板」的**内置多角度目录**(单一真源,纯叶子)。
 *
 * 诉求(goal 2026-07-06「网页中的提示词应该添加多个不同角度的模板」+「大幅提升用户体验」):
 * AIChat 空态原先只硬编码 3 条纯字符串(写代码/总结/概念),角度窄。本目录把模板下沉成**后端可
 * 配置、按角度分类**的数据,前端经 `GET /api/ai/prompts/builtin` 拉取渲染;后端不可达时前端另有
 * 兜底常量,保证永不空白。
 *
 * 纯叶子:无 I/O、无随机、无副作用、确定性、绝不抛。只返回结构化模板数据;HTTP、鉴权等副作用留给
 * 上层(aiManagementServer 路由)。
 *
 * 字段口径与个人提示词库(promptStore / PromptLibrary 的 title/content/category)对齐:这里用
 * `prompt` 承载正文(对应库里的 content),便于「保存到提示词库」时直接复用。
 *
 * 门控 KHY_PROMPT_TEMPLATE_CATALOG(默认开):关闭时 listTemplates/listCategories 返回空,路由据此
 * 返回空目录,前端逐字节回退到自带兜底常量。
 */

// ── env 门控 ─────────────────────────────────────────────────────────
// 委托 flagRegistry 单一声明式真源;注册表自门控(KHY_FLAG_REGISTRY)关时,逐字节回退到本文件
// 私有 _off 手写判定(CANON 4 词 + 归一)。此模式照抄自 goalStopGate.js / weakModelGuidance.js。
const flagRegistry = require('./flagRegistry');
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _off(v) {
  return v !== undefined && _FALSY.has(String(v).trim().toLowerCase());
}

/**
 * 内置模板目录是否启用(默认开,仅显式 0/false/off/no 关闭)。
 * 委托 flagRegistry('KHY_PROMPT_TEMPLATE_CATALOG');注册表关时回退 `!_off(env.KHY_PROMPT_TEMPLATE_CATALOG)`。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    if (flagRegistry.isRegistryEnabled(e)) {
      return flagRegistry.isFlagEnabled('KHY_PROMPT_TEMPLATE_CATALOG', e);
    }
  } catch { /* 注册表异常 → 回退手写判定 */ }
  return !_off(e.KHY_PROMPT_TEMPLATE_CATALOG);
}

// ── 内置多角度模板(单一真源)────────────────────────────────────────────────
// 每条:id(稳定键) / title(短标签,按钮文案) / category(角度分类) / prompt(填入输入框的正文)。
// 覆盖 12 个角度分类,便于弱模型/新用户快速上手不同类型任务。
const BUILTIN_PROMPT_TEMPLATES = Object.freeze([
  // 写作
  Object.freeze({ id: 'write-polish', title: '润色这段文字', category: '写作',
    prompt: '帮我润色下面这段文字，让它更通顺、专业，同时保持原意：\n\n' }),
  Object.freeze({ id: 'write-email', title: '写一封正式邮件', category: '写作',
    prompt: '帮我写一封正式邮件，收件人是【谁】，目的是【要达成什么】，语气礼貌简洁。请先问我缺少的关键信息再动笔。' }),

  // 分析/总结
  Object.freeze({ id: 'summarize-points', title: '提炼要点', category: '分析总结',
    prompt: '帮我总结下面内容的核心要点，用简洁的分点列出，并指出最关键的一条：\n\n' }),
  Object.freeze({ id: 'analyze-proscons', title: '分析利弊', category: '分析总结',
    prompt: '帮我客观分析这件事的利弊和风险，并给出一个有理由的建议：\n\n' }),

  // 翻译
  Object.freeze({ id: 'translate-zh-en', title: '中英互译', category: '翻译',
    prompt: '帮我把下面内容翻译成地道的英文（如果原文是英文则翻成中文），保留专业术语：\n\n' }),

  // 编码
  Object.freeze({ id: 'code-write', title: '写一个脚本', category: '编码',
    prompt: '用 Python 写一个读取 CSV 并做分组统计的脚本，带简单的错误处理和注释。' }),
  Object.freeze({ id: 'code-explain', title: '解释这段代码', category: '编码',
    prompt: '逐段解释下面这段代码在做什么，指出可能的坑或改进点：\n\n' }),

  // 代码审查
  Object.freeze({ id: 'code-review', title: '审查代码隐患', category: '代码审查',
    prompt: '帮我审查下面这段代码，重点看安全隐患、边界条件和错误处理，按严重程度列出问题：\n\n' }),

  // 调试
  Object.freeze({ id: 'debug-error', title: '帮我看报错', category: '调试',
    prompt: '我遇到这个报错，帮我把它翻译成人话，分析可能的原因，并给出排查步骤：\n\n' }),

  // 规划/拆解
  Object.freeze({ id: 'plan-breakdown', title: '拆解成任务清单', category: '规划',
    prompt: '帮我把下面这个需求拆成可执行的任务清单，标出依赖关系和优先级：\n\n' }),

  // 学习/解释
  Object.freeze({ id: 'learn-explain', title: '通俗讲清一个概念', category: '学习',
    prompt: '用通俗的比喻和一个简单例子，讲清楚【在此填入概念，如"梯度下降"】这个概念，假设我是初学者。' }),

  // 数据处理
  Object.freeze({ id: 'data-table', title: '整理成表格', category: '数据处理',
    prompt: '帮我把下面这段杂乱信息整理成结构化的 Markdown 表格：\n\n' }),

  // 图像识别
  Object.freeze({ id: 'vision-read', title: '识别图片内容', category: '图像',
    prompt: '（请附上图片）帮我识别这张图片里的文字/表格/关键信息，整理成可复制的文本。' }),

  // 创意
  Object.freeze({ id: 'creative-ideas', title: '给我一些点子', category: '创意',
    prompt: '围绕【在此填入主题】帮我头脑风暴 10 个有新意的点子，每个配一句话说明。' }),

  // 办公文书
  Object.freeze({ id: 'office-report', title: '写一份小结', category: '办公',
    prompt: '帮我根据下面要点写一份条理清晰的工作小结，分「进展/问题/下一步」三段：\n\n' }),
]);

/**
 * 列出模板(可按分类过滤)。门控关或异常 → 返回空数组(纯叶子安全默认)。
 * @param {object} [opts] { category?: string }
 * @param {object} [env]
 * @returns {Array<{id:string,title:string,category:string,prompt:string}>}
 */
function listTemplates(opts = {}, env) {
  if (!isEnabled(env)) return [];
  const category = opts && opts.category != null ? String(opts.category).trim() : '';
  const rows = BUILTIN_PROMPT_TEMPLATES.map((t) => ({ ...t }));
  if (!category) return rows;
  return rows.filter((t) => t.category === category);
}

/**
 * 列出去重后的分类(保持声明顺序)。门控关 → 返回空数组。
 * @param {object} [env]
 * @returns {string[]}
 */
function listCategories(env) {
  if (!isEnabled(env)) return [];
  const seen = new Set();
  const out = [];
  for (const t of BUILTIN_PROMPT_TEMPLATES) {
    if (!seen.has(t.category)) {
      seen.add(t.category);
      out.push(t.category);
    }
  }
  return out;
}

module.exports = {
  BUILTIN_PROMPT_TEMPLATES,
  isEnabled,
  listTemplates,
  listCategories,
};
