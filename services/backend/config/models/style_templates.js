'use strict';

/**
 * style_templates.js —— 段落目录 + 默认 nudge + 任务关键词表。
 *
 * 为什么是 .js 而不是 .json:
 *   段落正文是多行中文文本,JSON 里只能写成一长串 `\n` 转义,人根本没法维护。
 *   这里仍然是**纯解释执行**的普通 CommonJS 模块 —— 不编译、不打包,存盘即生效。
 *   dynamicPromptAssembler 在文件变化时读取正文,并在禁止 require 的 CommonJS shim 中
 *   重新解释字面量配置;不依赖 require.cache,所以 Jest 与生产环境都能验证零重启热更新。
 *
 * 编辑约定:
 *   - 只允许写字面量(字符串/数字/布尔/数组/对象),不要在这里写逻辑或 require。
 *     写坏了会被 assembler 整体降级为内置兜底目录,不会让请求失败,但你的改动会静默失效。
 *   - variants 三个键对应 style_profile.prompt_preference;缺哪个就回退到 structured。
 *   - priority 越大越"该留";脚手架等级不够时从 priority 低的开始砍。
 *   - minScaffolding:脚手架等级(0-10)低于此值时该段落默认不注入。0 = 永远注入。
 *   - when:交给 utils/styleMatchers.matchWhen 判定,支持 task_type / tier / has_tools /
 *     context_tokens_gt / context_tokens_lt / user_preference / min_capability / max_capability。
 *
 * 体积提醒:每个 section 正文都要进 prompt、要花钱。concise 变体请控制在 1-2 行。
 */

/**
 * providedByStablePrefix:该段落内容已由 promptAssemblyService 的**稳定前缀**注入
 * (跨轮命中 provider 缓存)。这里默认不再重复输出,除非模型画像里显式 boost。
 * 重复注入 12 条编码规范会白烧几百 token,还会稀释真正的差异化内容。
 */
const SECTION_CATALOG = [
  {
    id: 'system_overview',
    title: '工作方式',
    priority: 100,
    minScaffolding: 0,
    variants: {
      concise: '按需调用工具,直接给结论。',
      structured: '流程:①理解现状 → ②最小改动 → ③验证 → ④汇报。每步只报关键结论。',
      detailed:
        '请按以下顺序工作:先读相关代码理解现有结构与调用链,再做最小必要改动,' +
        '然后运行相关测试或语法检查验证,最后汇报「改了什么/怎么验证的/风险在哪」。' +
        '不确定的地方明确说明假设,不要臆测需求。',
    },
  },
  {
    id: 'coding_standards',
    title: '编码规范',
    priority: 95,
    minScaffolding: 0,
    providedByStablePrefix: true,
    variants: {
      concise: '遵循仓库既有风格,最小改动。',
      structured: '遵循仓库既有命名与风格;最小改动;改完必须验证。',
      detailed:
        '遵循仓库既有命名与代码风格,不做无关重构;新增功能优先复用现有工具与模式;' +
        '注释补充上下文而非复述代码。',
    },
  },
  {
    id: 'tool_protocol',
    title: '工具使用',
    priority: 90,
    minScaffolding: 2,
    when: { has_tools: true },
    variants: {
      concise: '可并行的工具调用放在同一轮。',
      structured:
        '工具调用:①相互独立的调用同轮并行发起;②失败时如实保留错误原文;' +
        '③同一原因最多重试 2 次。',
      detailed:
        '工具调用规则:相互独立的调用请在同一轮里并行发起,不要串行等待;' +
        '每次调用前先说明目的;调用失败时如实保留错误原文,不要隐瞒或谎报成功;' +
        '同一原因的失败最多重试 2 次,之后改换思路或向用户说明。',
    },
  },
  {
    id: 'task_decomposition',
    title: '任务拆解',
    priority: 80,
    minScaffolding: 5,
    variants: {
      concise: '先列步骤再动手。',
      structured: '先把任务拆成 3-6 个可验证的小步,列出来,再逐步执行并标注进度。',
      detailed:
        '开始前请先把任务拆成 3-6 个可独立验证的小步,把清单写出来;' +
        '每完成一步简短汇报进度,再进入下一步;发现拆解不对就当场调整并说明原因。',
    },
  },
  {
    id: 'self_check',
    title: '自检',
    priority: 75,
    minScaffolding: 6,
    variants: {
      concise: '交付前自查一遍。',
      structured: '交付前自检:①需求都覆盖了吗 ②改动能跑通吗 ③有没有漏掉的边界。',
      detailed:
        '声明完成之前请自检三件事:需求点是否逐条覆盖;改动是否真的运行/验证过' +
        '(贴出验证方式与结果);是否存在未处理的边界情况或回归风险。' +
        '任何一条不满足,就说明现状而不是宣布完成。',
    },
  },
  {
    id: 'output_format',
    title: '输出格式',
    priority: 70,
    minScaffolding: 3,
    variants: {
      concise: '结论先行。',
      structured: '结论先行,再给要点;代码用完整可运行的代码块。',
      detailed:
        '结论先行,再展开细节;列表优于长段落;代码给出可直接运行的完整代码块并标注语言;' +
        '文件位置用 `路径:行号` 形式引用。',
    },
  },
  {
    id: 'examples',
    title: '示例',
    priority: 60,
    minScaffolding: 7,
    variants: {
      concise: '',
      structured: '不确定格式时,参照仓库里同类文件的写法照做。',
      detailed:
        '不确定该怎么写时,先在仓库里找一个同类文件作为范例,照它的结构与命名照做,' +
        '而不是自创一套写法。',
    },
  },
  {
    id: 'long_context_navigation',
    title: '长上下文导航',
    priority: 85,
    minScaffolding: 0,
    when: { context_tokens_gt: 16000 },
    variants: {
      concise: '上下文很长,先定位再细读。',
      structured: '上下文较长:先用检索定位到具体文件/行,再局部细读,不要通读全文。',
      detailed:
        '当前上下文已经很长。请先用检索(grep/glob)定位到具体文件与行号,再只读需要的片段,' +
        '不要整文件通读;引用早前的信息时复述一遍你依据的原文,避免记错。',
    },
  },
  {
    id: 'safety_reminders',
    title: '破坏性操作',
    priority: 88,
    minScaffolding: 4,
    when: { has_tools: true },
    variants: {
      concise: '破坏性操作先确认。',
      structured: '删除文件、危险 Git 操作、批量修改、装全局依赖 → 先请求用户确认。',
      detailed:
        '以下操作必须先向用户请求确认再执行:删除文件或目录、危险的 Git 操作' +
        '(reset --hard / push --force 等)、跨多文件的批量修改、安装全局依赖、' +
        '以及任何对外发送数据的动作。覆盖或删除前先看一眼目标内容。',
    },
  },
];

/**
 * 按 tool_usage_tendency 给的默认 nudge。模型画像里写了 nudge_preferences 就用它的,
 * 一条都没命中时才落到这里。每条控制在一行以内。
 */
const DEFAULT_NUDGES = {
  aggressive: ['独立的工具调用同轮并行发起。'],
  balanced: ['先确认目标文件,再动手改。'],
  conservative: ['一次只做一件事,做完汇报再继续。', '不确定就先问,不要猜着改。'],
};

/** 脚手架等级 >= 8 时追加的兜底提醒(弱模型)。 */
const HIGH_SCAFFOLD_NUDGES = ['改完必须运行验证,把验证命令和结果贴出来。'];

/**
 * 任务类型关键词表。仅在调用方**没有**显式传 taskType 时用于推断。
 * 命中即计一分,得分最高者胜;全不命中 → 'conversation'。
 * 想支持新任务类型:在这里加一行即可,不需要改代码。
 */
const TASK_KEYWORDS = {
  code: ['实现', '重构', '写个', '函数', '类', '接口', 'bug', 'refactor', 'implement', 'code'],
  debug: ['报错', '排查', '为什么失败', '崩了', 'error', 'traceback', 'stack', 'debug', 'fix'],
  reasoning: ['为什么', '推导', '证明', '权衡', '设计方案', 'why', 'prove', 'reason', 'tradeoff'],
  analysis: ['分析', '对比', '评估', '审查', 'review', 'analyze', 'compare', 'audit'],
  architecture: ['架构', '模块划分', '技术选型', 'architecture', 'design doc'],
  creative: ['写一篇', '文案', '起名', '润色', 'story', 'poem', 'creative'],
  translation: ['翻译', '译成', 'translate'],
  long_context: ['整个项目', '全仓', '通读', 'whole repo', 'entire codebase'],
};

module.exports = {
  DEFAULT_NUDGES,
  HIGH_SCAFFOLD_NUDGES,
  SECTION_CATALOG,
  TASK_KEYWORDS,
};
