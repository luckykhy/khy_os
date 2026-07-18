'use strict';

/**
 * nlConfigResolver.js — 纯叶子:自然语言 → khyos 能力开关意图解析(单一真源)。
 *
 * 契约:零 IO(只读 process.env 做门控,不碰 fs/网络/子进程)、确定性、绝不抛(fail-soft)、
 * env 门控 KHY_NL_CONFIG 默认开。把「khyos 里用户是最高权限,自然语言即可驱动一切——而不是
 * 把一个开关 (KHY_xxx) 甩给用户、让他自己去文件里改」这条原则代码化:
 *   1) CAPABILITIES 注册表是「能力 → 环境变量开关」的单一真源,新增一项能力只改这张表;
 *   2) resolveConfigIntent 把自然语言(中/英)确定性解析成 {envKey, action, value},零假阳性
 *      (必须同时命中「动作词」+「能力引用」才成立,绝不猜);
 *   3) buildConfigDirective 产出系统提示词指令,命令模型「用户要改就直接用 Configure 工具改掉
 *      并持久化,绝不回复请你设置环境变量 / 请自己去文件里改」。
 *
 * 真正落地写入(.env + process.env)由薄 IO 层 config._writeEnvPatch 完成,本叶子绝不写盘。
 *
 * 全局门控惯例:khyos 所有 KHY_* 开关读法为 `!FALSY.has(v)`,FALSY = {0,false,off,no}。
 * 因此开 = 'true'(任意非 FALSY 值),关 = 'off'(落入 FALSY)。本叶子统一采用这一对值。
 */

const ON_VALUE = 'true';
const OFF_VALUE = 'off';

// ── 门控 ─────────────────────────────────────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env = process.env) {
  const raw = env && env.KHY_NL_CONFIG;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 能力注册表 — 单一真源。每项:
 *   id       稳定标识(用于工具/CLI/确认文案)
 *   envKey   背后的 KHY_* 环境变量开关
 *   summary  一句话中文摘要(给用户看)
 *   aliases  自然语言别名(中/英,匹配用;大小写不敏感)
 * 新增一项 NL 可控能力 = 在此追加一行,无需改任何其它代码。
 */
const CAPABILITIES = [
  {
    id: 'change-watch',
    envKey: 'KHY_CHANGE_WATCH',
    summary: '改动监视(后台常驻侦测其它 AI 改 khy 源码并主动反馈)',
    aliases: ['改动监视', '改动反馈', '修改监视', '改动监控', 'change watch', 'change-watch'],
  },
  {
    id: 'change-watch-verdict',
    envKey: 'KHY_CHANGE_WATCH_VERDICT',
    summary: '改动判定反馈(判其它 AI 改得对不对)',
    aliases: ['改动判定', '判定反馈', '改动对错', 'change verdict', 'change-watch-verdict'],
  },
  {
    id: 'ground-truth',
    envKey: 'KHY_GROUND_TRUTH',
    summary: '地面真值(算术/进制用精确有理数算出,禁模型心算)',
    aliases: ['地面真值', '精确计算', '精确求值', '禁止心算', 'ground truth', 'ground-truth'],
  },
  {
    id: 'deterministic-facts',
    envKey: 'KHY_DETERMINISTIC_FACTS',
    summary: '确定性事实(单位换算/SI 常数/定理走权威值)',
    aliases: ['确定性事实', '单位换算', '权威常数', 'deterministic facts', 'deterministic-facts'],
  },
  {
    id: 'search-necessity',
    envKey: 'KHY_SEARCH_NECESSITY',
    summary: '搜索必要性判断(知识库可答就别联网)',
    aliases: ['搜索必要性', '联网判断', '是否联网', 'search necessity', 'search-necessity'],
  },
  {
    id: 'clarification-cards',
    envKey: 'KHY_CLARIFICATION_CARDS',
    summary: '澄清选项卡(提示词不清时给可切换选项)',
    aliases: ['澄清卡', '选项卡', '澄清选项', 'clarification cards', 'clarification-cards'],
  },
  {
    id: 'streaming-md',
    envKey: 'KHY_STREAMING_MD',
    summary: '流式 Markdown 渲染(逐结构提交,末句完整)',
    aliases: ['流式渲染', '流式 markdown', '流式markdown', 'streaming md', 'streaming markdown', 'streaming-md'],
  },
  {
    id: 'rtk',
    envKey: 'KHY_RTK_MODE',
    summary: '省 token 模式(rtk 代理 dev 命令)',
    aliases: ['省 token', '省token', 'token 节省', 'rtk', '省钱模式'],
  },
  {
    id: '20x',
    envKey: 'KHY_20X_MODE',
    summary: '20 倍模式(满负荷档:effort=max + 扩展思考 + 更高工具迭代/并行子代理上限,对齐 CC Max 20x 体感)',
    aliases: ['20倍模式', '20 倍模式', '20x', '20x mode', '满负荷模式', '满负荷', '顶格模式', 'max throughput', '20倍', '二十倍模式'],
  },
  {
    id: 'code-laziness',
    envKey: 'KHY_CODE_LAZINESS',
    summary: '懒人方法论(写代码按最小代码阶梯:YAGNI/复用/标准库/原生/一行)',
    aliases: ['懒人模式', '懒人方法论', '最小代码', '最简实现', 'ponytail', 'lazy mode', 'code laziness', 'code-laziness'],
  },
  {
    id: 'persistent-goal',
    envKey: 'KHY_GOAL',
    summary: '持久目标(对齐 Claude Code /goal:设定后每轮提醒模型持续朝它推进,直到达成或被清除)',
    aliases: ['持久目标', '目标模式', '设定目标', '目标驱动', '盯住目标', 'persistent goal', 'goal mode', 'persistent-goal'],
  },
  {
    id: 'directive-composer',
    envKey: 'KHY_DIRECTIVE_COMPOSER',
    summary: '指令整合层(把各意图叶子注入的系统提示词指令按类别编排,多套协议同时生效时插入「协调头」串成一套有次序的执行计划,而非一堆等权的指令墙——治「功能堆砌、无法贯通」)',
    aliases: ['指令整合', '指令编排', '整合层', '贯通', '指令协调', '协调头', 'directive composer', 'directive-composer', 'compose directives'],
  },
  {
    id: 'delegation-prompt',
    envKey: 'KHY_DELEGATION_PROMPT',
    summary: '派发提示词教学(教 boss 主代理怎么给员工子代理写派发提示词:目标/已掌握上下文/精确指针/owned 范围与非目标/验收标准/输出契约/自治与升级,外加绝不外包理解、绝不重复已派发的工作;只教怎么写、绝不编造任务事实;关闭则逐字节回退到旧文案)',
    aliases: ['派发提示词', '怎么写提示词', '写提示词', '派单提示词', '子代理提示词', '委派提示词', '提示词教学', 'delegation prompt', 'delegation-prompt', 'write prompts', 'prompt writing'],
  },
  {
    id: 'test-writing',
    envKey: 'KHY_TEST_WRITING',
    summary: '测试编写协议(用户让 khy 给项目写/补测试时,注入怎么写好测试的协议:先对齐项目既有框架与约定、测行为非实现、成体系覆盖正常/边界/错误/不变量、确定性隔离杜绝 flaky、断言要有意义、写完实际运行看证据、绝不为变绿迁就当前可能有 bug 的输出;只教怎么写、绝不编造被测代码事实)',
    aliases: ['写测试', '怎么写测试', '测试编写', '编写测试', '补测试', '加测试', '单元测试', '测试用例', '测试覆盖', '写单测', 'test writing', 'test-writing', 'write tests', 'unit test', 'test coverage'],
  },
  {
    id: 'honest-failure-reason',
    envKey: 'KHY_HONEST_FAILURE',
    summary: '诚实失败原因(出错时给具体真实的原因——网络拒连/DNS/HTTP 5xx/退出码与 stderr——而非用「网络不好」之类的笼统借口掩盖真相;无真因时诚实承认未知,绝不编造)',
    aliases: ['诚实失败', '诚实报错', '真实原因', '具体原因', '别掩盖错误', '不要掩盖真相', 'honest failure', 'honest-failure', 'honest error'],
  },
  {
    id: 'reply-guard',
    envKey: 'KHY_REPLY_GUARD',
    summary: '空回复守卫(模型回复为空时主动丢弃该空回复、不外露占位串,并在有界预算内要求模型重发一条完整的新消息;内容安全/拒答类绝不重发)',
    aliases: ['空回复守卫', '丢弃空回复', '空回复重发', '重发新消息', '重新生成回复', '回复守卫', 'reply guard', 'reply-guard', 'discard empty reply', 'resend reply'],
  },
  {
    id: 'typeset-emphasis',
    envKey: 'KHY_TYPESET_EMPHASIS',
    summary: '输出排版强调层(该加粗的加粗:Markdown 粗体与各级标题都可靠加粗,各级标题形成清晰的大→小视觉层级,便于扫读;关闭则逐字节回退到旧渲染)',
    aliases: ['加粗', '该加粗的加粗', '标题加粗', '强调层', '排版强调', '字体加粗', '输出加粗', '醒目', 'bold', 'emphasis', 'typeset emphasis', 'typeset-emphasis'],
  },
  {
    id: 'typeset-big-headings',
    envKey: 'KHY_TYPESET_BIG_HEADINGS',
    summary: '标题字面放大(调大字体·实验性,默认关:用 DEC 双宽序列把 H1/H2 字形真正放大两倍宽,支持 CJK;仅对支持该序列的终端有效,ink TUI 内为 best-effort)',
    aliases: ['调大字体', '放大标题', '字体调大', '大字体', '标题放大', '放大字号', 'big headings', 'larger font', 'enlarge font', 'typeset-big-headings'],
  },
  {
    id: 'session-insights',
    envKey: 'KHY_INSIGHTS',
    summary: '会话洞见(对齐 Claude Code /insights:回顾会话轮次/最常用工具/话题关键词/耗时)',
    aliases: ['会话洞见', '洞见报告', '会话报告', '会话分析', '会话总结', 'insights', 'session insights', 'session-insights'],
  },
  {
    id: 'vault',
    envKey: 'KHY_VAULT',
    summary: '密钥保险库(对齐 Claude Code:机密本地存放,模型用 {{vault:NAME}} 引用、真值服务端注入绝不进入上下文)',
    aliases: ['密钥保险库', '保险库', '密钥库', '密钥金库', '密钥仓库', 'vault', 'secret vault', 'secrets vault'],
  },
  {
    id: 'memory-recall',
    envKey: 'KHY_MEMORY_RECALL_TOOL',
    summary: '主动记忆召回(对齐 Claude Code:模型可按需调用工具去翻本地记忆库,而不只是被动注入)',
    aliases: ['记忆召回', '主动召回', '召回记忆', '翻记忆', '查记忆', '回忆', 'memory recall', 'recall memory', 'memory-recall'],
  },
  {
    id: 'mesh',
    envKey: 'KHY_MESH',
    summary: '多实例协作网格(对齐 Claude Code:同机多个 khy 实例彼此发现、attach/detach、跨进程互发消息)',
    aliases: ['多实例协作', '实例协作', '协作网格', '多实例网格', '实例网格', 'mesh', 'peer mesh', 'multi-instance', 'multi instance'],
  },
  {
    id: 'push-notify',
    envKey: 'KHY_PUSH_NOTIFY',
    summary: '推送通知(对齐 Claude Code:把消息推到终端之外——手机/桌面,长任务完成或阻塞点主动提醒)',
    aliases: ['推送通知', '推送', '通知推送', '手机通知', '消息推送', 'push', 'push notify', 'push notification', 'notify', 'notification'],
  },
  {
    id: 'push-on-done',
    envKey: 'KHY_PUSH_ON_DONE',
    summary: '完成自动推送(长任务/turn 完成且耗时超阈值时,自动把提醒推到终端之外;opt-in,需先配过推送目标)',
    aliases: ['完成自动推送', '完成推送', '完成后推送', '任务完成推送', '完成提醒推送', '长任务完成推送', 'push on done', 'push-on-done', 'auto push', 'notify on done', 'notify when done'],
  },
  {
    id: 'subagent-text-stream',
    envKey: 'KHY_SUBAGENT_TEXT_STREAM',
    summary: '子 agent 正文流式上浮(对齐 Claude Code:子 agent 实时吐出的正文 token 上浮到父级 agent 树,不只看到它在跑哪个工具,还看到它正在「说什么」)',
    aliases: ['子agent正文', '子代理正文', '子agent流式', '子代理流式', '子任务正文', 'agent正文流', '子agent文本', 'subagent text', 'sub-agent text', 'subagent stream', 'subagent-text-stream', 'agent prose stream'],
  },
  {
    id: 'glm-vision-model',
    envKey: 'KHY_GLM_VISION_MODEL',
    summary: 'GLM 识图模型(文本模型看不了图时透明路由到 GLM-4.6V-Flash 视觉模型识别再返回,并启用显式 RecognizeImage 识图工具;关闭则回退旧视觉链——env-pin/sibling/OCR)。改用哪个视觉模型走原生形「把 KHY_VISION_FALLBACK_MODEL 设为 <模型>」',
    aliases: ['glm识图', 'glm 识图', 'glm视觉', 'glm 视觉', 'glm-4.6v', 'glm4.6v', 'glm-4.6v-flash', '视觉识图模型', 'glm 识图模型', 'glm vision', 'glm-vision', 'glm vision model', 'glm image recognition'],
  },
  {
    id: 'vision-ocr-fallback',
    envKey: 'KHY_VISION_OCR_FALLBACK',
    summary: '识图兜底(模型不支持图像或上游 404 时,用本地 OCR 把图转文本喂给模型,给所有模型装上眼睛)',
    aliases: ['识图兜底', '图像兜底', 'ocr 兜底', 'ocr兜底', 'ocr fallback', '图像ocr', '给模型装眼睛', '装眼睛', '视觉兜底', 'vision ocr', 'vision fallback'],
  },
  {
    id: 'vision-direct-describe',
    envKey: 'KHY_VISION_DIRECT_DESCRIBE',
    summary: '看图直接答(只让描述/分析一张内联图时,不强制 codex 首轮调工具、并告知图已内联→模型直接看图作答,不再幻觉一个不存在的文件去 Read、做一堆多余的事)',
    aliases: ['看图直接答', '描述图片不调工具', '识图不读文件', '别幻觉读文件', '图片直接描述', '不强制工具', '内联图说明', 'vision direct describe', 'vision-direct-describe', 'describe image directly', 'no phantom read'],
  },
  {
    id: 'adapter-native-vision',
    envKey: 'KHY_ADAPTER_NATIVE_VISION',
    summary: '原生识图通道不剥图(某条适配器原生收图、能自行真视觉识别时——如 codex direct 模式→Responses API——保留图片直接交给它识别,不再把图剥成本地 OCR;失败仍由 post-failure OCR 网兜底,绝不毒化会话)',
    aliases: ['原生识图通道', '原生收图', '通道原生视觉', '不剥图', '保留图片识别', 'codex 识图', 'codex视觉', '适配器视觉', 'adapter native vision', 'adapter-native-vision', 'native vision adapter', 'keep image for vision'],
  },
  {
    id: 'image-ocr-no-cascade',
    envKey: 'KHY_IMAGE_OCR_NO_CASCADE',
    summary: 'imageOcr 有界不级联(识别图片时:本地 OCR 优先且有硬总超时;当根本没有可用视觉模型时绝不重入网关逐个适配器试网络——杜绝「一识别图片就网络中断、接下来换哪个模型都一直失败」的逐适配器冷却级联;有文字就直接用本地 OCR,无文字则诚实告知需配置视觉模型,绝不编造图像内容)',
    aliases: ['识图不级联', '图片识别不级联', 'ocr 不级联', 'ocr 有界', '本地ocr优先', '识图有总超时', '换模型都失败修复', '无视觉模型识图', 'image ocr no cascade', 'image-ocr-no-cascade', 'ocr no cascade', 'bounded ocr', 'no vision cascade'],
  },
  {
    id: 'ocr-text-on-netfail',
    envKey: 'KHY_OCR_TEXT_ON_NETFAIL',
    summary: '断网保留已识别文字(非视觉模型已先用本地 OCR 把图片文字提取塞进 prompt,随后调远端模型作答却遇网络/超时失败时,不再把离线已识别的文字白白丢弃,而是把它作为诚实降级内容前置呈现给用户——做到「即便断网/换不到模型,识别图片仍能给出离线 OCR 文本」)',
    aliases: ['断网保留ocr', '网络失败保留文字', '识别文字不丢', '离线ocr兜底', '断网识图兜底', '网络中断保留识别', 'ocr text on netfail', 'ocr-text-on-netfail', 'preserve ocr on network failure', 'keep recognized text offline'],
  },
  {
    id: 'web-inline-image-path',
    envKey: 'KHY_WEB_INLINE_IMAGE_PATH',
    summary: '打字粘图片路径自动识图(web/协作通道里在消息里粘一个本地图片路径就像 REPL 一样自动转成图片附件交给视觉/OCR 路由,而不是把路径当纯文本送进 agentic 循环)',
    aliases: ['打字粘路径识图', '粘路径识图', '消息里粘图片路径', 'web 通道识图', '通道补齐识图', '路径转附件', 'web inline image path', 'web-inline-image-path', 'inline image path', 'paste image path'],
  },
  {
    id: 'tui-inline-image-path',
    envKey: 'KHY_TUI_INLINE_IMAGE_PATH',
    summary: 'TUI 打字粘图片路径自动识图(默认 TUI 界面里在消息里粘一个本地图片路径就像经典 REPL 一样自动转成图片附件交给视觉/OCR 路由,而不是把路径当纯文本送进模型——补齐 TUI 与 REPL 的最后一处识图缺口)',
    aliases: ['tui 识图', 'tui 粘路径识图', 'tui 图片路径', '界面识图', 'tui inline image path', 'tui-inline-image-path', 'tui image path'],
  },
  {
    id: 'tui-native-commands',
    envKey: 'KHY_TUI_NATIVE_COMMANDS',
    summary: 'TUI 原生执行经典命令(默认 TUI 界面里 /scan(病毒扫描)、/hardware(硬件信息)、/checkpoint(检查点)、/intent(意图调试)、/study(学习模式)、/mind(认知图)、/worktree(隔离工作区)、/review(代码审查)、/rollback(检查点回滚·原生选择器)等经典 REPL 才有的命令全部在 TUI 内原生执行——复用与经典 REPL 同一批 service,而不是把字面命令静默当文本发给模型、也不再退回经典模式——补齐 TUI 与 REPL 的 slash 命令缺口,达成两处对齐)',
    aliases: ['tui 原生命令', 'tui 命令补齐', 'tui slash 命令', '界面命令补齐', 'tui native commands', 'tui-native-commands', 'native slash commands', 'tui commands parity'],
  },
  {
    id: 'at-mention-inject',
    envKey: 'KHY_AT_MENTION_INJECT',
    summary: '@文件/@目录内容注入(在消息里写 @path 引用一个文件就把它的内容、引用一个目录就把它的目录树注入给模型,而不是只让模型看到字面 @path;敏感文件 .env/id_rsa/*.key 等一律拦截绝不读入。REPL 与 TUI 两处共用同一单一真源——补齐 TUI 与 REPL 的 @ 引用注入缺口)',
    aliases: ['@文件注入', '@目录注入', 'at 文件注入', 'at引用注入', '@引用注入', '文件引用注入', 'at mention inject', 'at-mention-inject', 'at mention injection', 'file mention inject'],
  },
  {
    id: 'inline-image-ocr-guard',
    envKey: 'KHY_INLINE_IMAGE_OCR_GUARD',
    summary: '禁 DIY-OCR 护栏(消息含本地图片路径但本轮没有任何图片附件时,命令模型绝不自己 shell 出去用 python/tesseract OCR、绝不反复 Read/Bash 该路径,改用 khy 原生视觉/OCR 或如实告知看不到图,杜绝纯文本模型 DIY-OCR 死循环)',
    aliases: ['禁diy ocr', '禁 diy ocr', '禁手动ocr', '禁自己ocr', '图片路径护栏', '别自己ocr', '别死循环ocr', 'diy ocr guard', 'inline image ocr guard', 'inline-image-ocr-guard', 'no diy ocr', 'ocr loop guard'],
  },
  {
    id: 'attachment-failure-policy',
    envKey: 'KHY_ATTACHMENT_FAILURE_POLICY',
    summary: '附件失败策略(读不了的文件不毒化整条通道,大方承认未知格式并给解决方案,一个坏文件不再拖垮后续请求)',
    aliases: ['附件失败策略', '坏文件不毒化', '不毒化通道', '未知格式承认', '附件兜底', '文件读不了兜底', 'attachment failure policy', 'attachment-failure-policy', 'payload failure'],
  },
  {
    id: 'answer-verifier',
    envKey: 'KHY_ANSWER_VERIFIER',
    summary: '确定性复核(不轻信模型自报:用精确运算复核模型写出的算式、与工具日志对账动作声称,被证伪处如实标注)',
    aliases: ['确定性复核', '答复复核', '不轻信模型', '复核模型', '算式复核', '动作对账', '声称对账', 'answer verifier', 'answer-verifier', 'verify answer', 'claim verification'],
  },
  {
    id: 'math-solve',
    envKey: 'KHY_MATH_SOLVE',
    summary: '数学解题协议(给数学题——含图片给题——就分步骤解、精确值、解完回代自检;并对可代入复核的解附机器可核验块,由 khyos 用精确有理数代入复核解是否真满足方程,符号微积分如实标注需人工复核)',
    aliases: ['数学解题', '解数学题', '解方程', '方程组', '微积分', '分步骤解题', '解题步骤', '代入复核', '解题复核', 'math solve', 'math-solve', 'solve math', 'show steps', 'step by step math'],
  },
  {
    id: 'model-tooling-capability',
    envKey: 'KHY_MODEL_TOOLING_CAPABILITY',
    summary: '工具调用能力判定(单一真源:判一个模型有没有原生 function calling;没有就让它走 <tool_call> 文本拦截调用 khy 工具——纯文本模型也能用工具,且"剥离工具"与"教文本语法"永远同步)',
    aliases: ['工具能力判定', '原生工具调用', '文本拦截工具', '文本调工具', '纯文本模型用工具', '工具调用能力', 'model tooling', 'model-tooling-capability', 'native tool use', 'text tool protocol', 'text tool calling'],
  },
  {
    id: 'tool-cap-probe',
    envKey: 'KHY_TOOL_CAP_PROBE',
    summary: '工具调用能力实测探测(不硬编码、实测为准:首次用到未测渠道时惰性后台真发一个极小工具探一探、真实流量回了 native tool_calls 就被动学 native,结果带 TTL 持久化到 ~/.khyos;名字含 flash/lite 但实测能原生调工具的模型自动晋升 native。手动:khy gateway probe-tools <model>)',
    aliases: ['工具能力实测', '实测工具调用', '工具调用探测', '探测工具能力', '工具能力探测', '实测为准', 'tool capability probe', 'tool-cap-probe', 'probe tools', 'probe-tools', 'live tool probe', 'measured tool capability'],
  },
  {
    id: 'stream-stall-abort',
    envKey: 'KHY_STREAM_STALL_ABORT',
    summary: '流卡死即拆流(AI API 连接稳定:上游 SSE 流在 provider 感知阈值 45–90s 内不再吐字,就主动拆掉这条卡死的流→重试/failover 或救回半截内容,而不是一直挂到粗粒度 socket 超时)',
    aliases: ['流卡死拆流', '卡死拆流', '流超时拆流', '连接稳定', '流稳定', '上游流卡死', '流不吐字', 'stream stall', 'stream-stall', 'stall abort', 'stream stall abort', 'connection stability'],
  },
  {
    id: 'repo-discipline',
    envKey: 'KHY_REPO_DISCIPLINE',
    summary: '仓库纪律与风险(提交/推送前确定性体检:扫 diff 里粘进的密钥、大文件/二进制产物、提交信息质量、分支/强推/跳钩子/一把梭暂存纪律,产 clean/caution/block 裁决;同源渲染系统提示词的 Git Safety 红线)',
    aliases: ['仓库纪律', '提交纪律', '版本纪律', '仓库风险', '提交风险', '提交体检', '密钥扫描', '提交前检查', 'repo discipline', 'repo-discipline', 'commit discipline', 'repo risk', 'repo audit'],
  },
  {
    id: 'archive-inspect',
    envKey: 'KHY_ARCHIVE_INSPECT',
    summary: '压缩包识别(同时给图片/文档/压缩包/文字时,把压缩包当第 5 类输入:列出其内含文件清单+预览少量小文本条目喂给模型,不再静默丢弃;只列目录不落盘解压,安全;7z/rar 等暂不支持的格式也会被诚实告知而非忽略)',
    aliases: ['压缩包识别', '压缩包分析', '识别压缩包', '归档识别', 'zip识别', '列压缩包', '压缩包内容', 'archive inspect', 'archive-inspect', 'inspect archive', 'zip listing', 'analyze archive'],
  },
  {
    id: 'nl-action',
    envKey: 'KHY_NL_ACTION',
    summary: '自然语言驱动动作(不只是改开关:把「找/修你自己的 bug」「去 GitHub 学最火的项目」这类动作请求确定性识别出来,命令模型用既有工具/子系统真正去做——自查修复走 Grep/lintCode/editFile+evolutionPolicy 可变性分级+auditFixLoop 复审;平台学习走 forgeSearch 按 star 降序+forgeRecon/gitClone——而不是回复「我做不到/请你手动」)',
    aliases: ['自然语言驱动动作', '自然语言动作', '动作驱动', '自查修复bug', '自查自修', '找自己的bug', '修自己的bug', '去github学习', '开源学习', 'nl action', 'nl-action', 'natural language action', 'self bug fix', 'forge learn'],
  },
  {
    id: 'philosophy-design',
    envKey: 'KHY_PHILOSOPHY_DESIGN',
    summary: '哲学→软件类比落地(当用户给一段人类社会的哲学/思想、想把它应用到软件项目时,命令模型走确定性协议:忠实提炼内核→建显式类比映射表(哲学概念→软件构造:模块/不变量/控制流/权限)→转可执行架构→用既有工具真正实现→诚实区分强类比与牵强,而不是把哲学复述一遍或写一段比喻散文)',
    aliases: ['哲学落地', '哲学设计', '哲学软件', '哲学类比', '思想落地', '用软件实现哲学', '哲学应用到软件', '哲学驱动设计', 'philosophy design', 'philosophy-design', 'philosophy to software', 'apply philosophy', 'design philosophy'],
  },
  {
    id: 'action-contract',
    envKey: 'KHY_ACTION_CONTRACT',
    summary: '动作契约核验(模型无关的可证明不变量层:每个动作带一份类型化契约 Φ_pre⇒Φ_post——可机检的逻辑公式而非自然语言,由一个极小、纯函数、零依赖、fail-closed 的核验器 V 判 V(契约,前后状态)=ok 才放行;裁决经既有审计链锚定可重放、可检篡改。数据绝不当代码执行,绝不 eval/反射)',
    aliases: ['动作契约', '契约核验', '可证明不变量', '不变量层', '核验器', '前置后置条件', 'proof carrying', 'action contract', 'action-contract', 'contract verifier', 'provable invariant', 'pre post condition'],
  },
  {
    id: 'permission-allow-first-highrisk',
    envKey: 'KHY_PERMISSION_ALLOW_FIRST_HIGHRISK',
    summary: '高危授权允许优先（高危/红灯 L2 授权框把「确认执行」放第一个、回车默认即执行，与普通授权框对齐；关闭则回退「拒绝优先」安全护栏，反射性回车=拒绝）',
    aliases: ['高危允许优先', '高危授权允许优先', '高危默认允许', '红灯允许优先', '高危确认优先', '高危回车执行', 'permission allow first high risk', 'permission-allow-first-highrisk', 'high risk allow first', 'allow first high risk'],
  },
  {
    id: 'l2-session-allow',
    envKey: 'KHY_L2_SESSION_ALLOW',
    summary: '高危本会话免审（高危/红灯 L2 授权框提供第三个选项「本会话内总是允许此类」，选后同类高危操作本会话内自动放行、不再逐次询问；仅内存重启清零；关闭即恢复「L2 永不可会话免审」红线铁律、第三项消失）',
    aliases: ['高危会话免审', '高危本会话免审', '红灯会话免审', '本会话总是允许高危', '高危总是允许', '高危免审', 'l2 session allow', 'l2-session-allow', 'high risk session allow', 'always allow high risk session'],
  },
  {
    id: 'pip-failure-policy',
    envKey: 'KHY_PIP_FAILURE_POLICY',
    summary: '自升级失败诊断(khy update 时 pip 因死代理/网络拒连失败,自动绕过代理直连重试一次,并把代理/网络/找不到/权限类失败翻成可执行修复方案,而非吐截断的原始报错)',
    aliases: ['自升级诊断', '更新失败诊断', 'pip 失败诊断', 'pip失败诊断', '更新代理绕过', '代理绕过重试', '升级诊断', 'pip failure', 'pip-failure-policy', 'pip failure policy', 'update diagnosis', 'proxy bypass update'],
  },
];

const _BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));
const _BY_ENVKEY = new Map(CAPABILITIES.map((c) => [c.envKey, c]));

// ── 动作词(开/关),中英 ──────────────────────────────────────────────────────
// 零假阳性:解析成立必须同时命中动作词 + 能力引用。
const _ON_RE = /(开启|打开|启用|启动|开一?下|enable|turn\s+on|switch\s+on|\bon\b)/i;
const _OFF_RE = /(关闭|关掉|禁用|停用|关一?下|别再?|不要再?|disable|turn\s+off|switch\s+off|\boff\b)/i;
const _RAW_ENVKEY_RE = /\bKHY_[A-Z0-9_]{2,}\b/;
// 显式 raw 赋值:KHY_FOO=bar 或 「把 KHY_FOO 设为/设置为 bar」
// 值字符集含 `/` 与 `:`:模型 id 常带 provider 前缀(如 glm/glm-4.6v-flash)、路径/端点亦然;
// 仍要求 KHY_ 前缀 + 赋值动词,不放宽命中条件,故不增假阳性。
const _RAW_ASSIGN_RE = /\b(KHY_[A-Z0-9_]{2,})\s*(?:=|设为|设成|设置为|改为|改成|置为)\s*([A-Za-z0-9._:/-]+)/;

// 去掉代码块与行内 code,避免把示例里的 KHY_xxx/英文 on/off 误判为用户指令。委托单一真源 utils/stripCodeSpans。
const _stripCode = require('../../utils/stripCodeSpans');

// khyos 自注入的系统指令一律以 `[SYSTEM:` 开头(goal kickoff / stop-gate re-drive /
// 变更反馈等)。这些是 khy **给模型**下的指令,绝非用户在要求「开/关某能力」——但它们的散文里
// 常含能力别名(如 goal 文案里的「持久目标」)+ 动作词(「清除/收尾/clear」),会被 _detectAction
// + _matchCapability 凑成一个假的 toggle 意图(实测:goal kickoff → {toggle, persistent-goal, off}),
// 反手命令模型去 Configure(persistent-goal, off) —— 把「关掉目标能力」当头号任务、调用失败、还弹权限,
// goal 模式被自己的 config 子系统反噬。守卫:凡 khy 自注入的 `[SYSTEM:` 指令,一律不做配置意图解析
// (真用户的自然语言配置请求绝不会以 `[SYSTEM:` 开头,故对真实输入逐字节等价)。
const _KHY_INJECTED_SYSTEM_RE = /^\s*\[SYSTEM:/;

function _detectAction(text) {
  // 关优先(「别再开启…」「关掉而不是打开」语义上以关为准的边界场景少见;此处取显式 off 优先)。
  const off = _OFF_RE.test(text);
  const on = _ON_RE.test(text);
  if (off && !on) return 'off';
  if (on && !off) return 'on';
  if (on && off) {
    // 两者都出现:取最后出现者(更贴近最终意图)。
    const offIdx = text.search(_OFF_RE);
    const onIdx = text.search(_ON_RE);
    return offIdx > onIdx ? 'off' : 'on';
  }
  return null;
}

function _matchCapability(text) {
  const lower = text.toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const cap of CAPABILITIES) {
    for (const alias of cap.aliases) {
      const a = String(alias).toLowerCase();
      if (a && lower.includes(a) && a.length > bestLen) {
        best = cap;
        bestLen = a.length;
      }
    }
  }
  return best;
}

// ── 歧义澄清子门(父 KHY_NL_CONFIG,本地惯例,默认开)────────────────────────────
// 「取最长匹配别名」在只有一个赢家时是对的;但当 2+ 个**不同**能力恰好以相同的最长别名同时命中
// 时(如「完成推送通知」→ push-notify 的『推送通知』(4) 与 push-on-done 的『完成推送』(4) 并列),
// 旧的 `a.length > bestLen` 严格大于会按注册表**迭代顺序**任取第一个,静默拍板可能改错能力并写 .env。
// 本子门开时:此类真并列不再猜,而是交出全部并列候选让上层先向用户澄清。关门 → 逐字节回退旧 single-best。
function _isDisambiguateEnabled(env = process.env) {
  const raw = env && env.KHY_NL_CONFIG_DISAMBIGUATE;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// 返回 { best, bestLen, tied }:
//   best    与旧 _matchCapability 逐字节同序的单一赢家(注册表中首个达到全局最长匹配长度的能力)。
//   bestLen 全局最长匹配别名长度(无命中为 0)。
//   tied    以 bestLen 命中的**不同**能力集合(去重到能力粒度);length>=2 即真歧义。
// 逐能力先取「该能力自身命中的最长别名」再比全局,故同一能力的多个别名不会被误当成多义。
function _matchCapabilityCandidates(text) {
  const lower = String(text || '').toLowerCase();
  let best = null;
  let bestLen = 0;
  const capMax = []; // [{ cap, len }],保持注册表顺序
  for (const cap of CAPABILITIES) {
    let capLen = 0;
    for (const alias of cap.aliases) {
      const a = String(alias).toLowerCase();
      if (a && lower.includes(a) && a.length > capLen) capLen = a.length;
    }
    if (capLen > 0) {
      capMax.push({ cap, len: capLen });
      if (capLen > bestLen) { best = cap; bestLen = capLen; } // 严格 > → 首达最长者胜,与旧 _matchCapability 同序
    }
  }
  const tied = capMax.filter((e) => e.len === bestLen).map((e) => e.cap);
  return { best, bestLen, tied };
}

/**
 * 自然语言 → 配置意图。返回:
 *   { kind:'toggle', capabilityId, envKey, action:'on'|'off', value, summary }  已知能力开关
 *   { kind:'raw', envKey, value }                                              显式 raw 赋值
 *   { kind:'ambiguous', action, candidates:[{id,envKey,summary}], summary }    多能力并列命中(需澄清)
 *   null                                                                       未确定(绝不猜)
 * fail-soft:任何异常都返回 null。
 */
function resolveConfigIntent(text, env = process.env) {
  try {
    if (!isEnabled(env)) return null;
    const cleaned = _stripCode(text);
    if (!cleaned.trim()) return null;
    // khy 自注入的 `[SYSTEM:` 指令不是用户的配置请求,绝不解析(否则 goal 文案里的能力别名+动作词
    // 会被凑成假 toggle 意图,反噬 goal 模式)。见上方 _KHY_INJECTED_SYSTEM_RE 注释。
    if (_KHY_INJECTED_SYSTEM_RE.test(cleaned)) return null;

    // 1) 显式 raw 赋值优先(KHY_FOO=bar / 把 KHY_FOO 设为 bar)
    const assign = cleaned.match(_RAW_ASSIGN_RE);
    if (assign) {
      const envKey = assign[1];
      const value = assign[2];
      const known = _BY_ENVKEY.get(envKey);
      return known
        ? { kind: 'toggle', capabilityId: known.id, envKey, action: _FALSY.has(value.toLowerCase()) ? 'off' : 'on', value, summary: known.summary }
        : { kind: 'raw', envKey, value };
    }

    // 2) 动作词 + 能力引用(友好别名 或 裸 KHY_ 键)
    const action = _detectAction(cleaned);
    if (!action) return null;

    // 2a) 多义歧义检测(子门 KHY_NL_CONFIG_DISAMBIGUATE,默认开)——同一最长匹配长度上有 2+ 个不同
    // 能力并列命中时,不猜:交出全部并列候选让上层先澄清(见 _matchCapabilityCandidates 注释)。
    // 只作用于友好别名匹配(best 非空即来自 CAPABILITIES);裸 KHY_ 键/显式赋值天然无歧义,不受影响。
    const { best, tied } = _matchCapabilityCandidates(cleaned);
    if (_isDisambiguateEnabled(env) && tied.length >= 2) {
      return {
        kind: 'ambiguous',
        action,
        candidates: tied.map((c) => ({ id: c.id, envKey: c.envKey, summary: c.summary })),
        summary: `多个能力都匹配到了(${tied.map((c) => c.summary || c.envKey).join(' / ')})`,
      };
    }

    let cap = best;
    if (!cap) {
      const rawKey = cleaned.match(_RAW_ENVKEY_RE);
      if (rawKey) {
        const envKey = rawKey[0];
        cap = _BY_ENVKEY.get(envKey) || { id: null, envKey, summary: envKey };
      }
    }
    if (!cap) return null;

    return {
      kind: 'toggle',
      capabilityId: cap.id,
      envKey: cap.envKey,
      action,
      value: action === 'on' ? ON_VALUE : OFF_VALUE,
      summary: cap.summary,
    };
  } catch {
    return null;
  }
}

/** 意图 → 环境变量补丁(纯函数)。供薄 IO 层喂给 config._writeEnvPatch。 */
function buildEnvPatch(intent) {
  if (!intent || !intent.envKey) return { envMap: {}, unsetKeys: [] };
  const value = intent.value !== undefined && intent.value !== null
    ? String(intent.value)
    : (intent.action === 'off' ? OFF_VALUE : ON_VALUE);
  return { envMap: { [intent.envKey]: value }, unsetKeys: [] };
}

/** 列出全部 NL 可控能力(给工具 list / CLI / 帮助 / 提示词用)。 */
function describeCapabilities() {
  return CAPABILITIES.map((c) => ({
    id: c.id,
    envKey: c.envKey,
    summary: c.summary,
    aliases: c.aliases.slice(),
  }));
}

/** 按 id 或 envKey 或别名解析出能力(工具/CLI 用)。 */
function findCapability(nameOrKey) {
  if (!nameOrKey) return null;
  const s = String(nameOrKey).trim();
  if (_BY_ID.has(s)) return _BY_ID.get(s);
  if (_BY_ENVKEY.has(s)) return _BY_ENVKEY.get(s);
  return _matchCapability(s.toLowerCase());
}

/**
 * 产出系统提示词指令([SYSTEM:] 形式)。两部分:
 *  (A) 原则:用户在 khyos 中是最高权限;用户用自然语言要求改设置/开关行为时,直接调用 Configure
 *      工具改掉并持久化,绝不回复「请你设置环境变量 KHY_xxx」或「请自己去文件里改」。
 *  (B) 若本轮已解析出明确意图,附上具体能力 + 动作,命令模型立即执行后简短确认。
 */
function buildConfigDirective(intent) {
  const lines = [
    '[SYSTEM: 用户授权与自然语言驱动]',
    '在 khyos 中用户是最高权限。当用户用自然语言要求开启/关闭某项能力、更改某项设置或行为时,',
    '直接调用 `Configure` 工具完成更改并持久化(它会写入 .env 并即时生效),然后用一句话确认。',
    '绝不把开关甩回给用户:不要回复「请设置环境变量 KHY_xxx」「请自己去文件里改」「需要你显式声明」这类话——',
    '凡是 khyos 自己能做到的更改,就由你代为完成。',
  ];
  if (intent && intent.kind === 'toggle') {
    const act = intent.action === 'off' ? '关闭' : '开启';
    lines.push(
      `本轮用户意图:${act}能力「${intent.summary || intent.envKey}」(${intent.envKey})。` +
      `请立即调用 Configure 工具执行(capability=${intent.capabilityId || intent.envKey}, state=${intent.action}),然后简短确认。`,
    );
  } else if (intent && intent.kind === 'raw') {
    lines.push(
      `本轮用户意图:把 ${intent.envKey} 设为 ${intent.value}。请立即调用 Configure 工具执行后确认。`,
    );
  } else if (intent && intent.kind === 'ambiguous') {
    // 多能力并列命中:这是「模糊语义」的核心处置——不猜、先澄清。此处显式**覆盖**上面「直接调用
    // Configure」的原则:宁可多问一句,也绝不猜错改错配置。用户明确选定后再执行。
    const act = intent.action === 'off' ? '关闭' : '开启';
    const list = (intent.candidates || [])
      .map((c, i) => `  ${i + 1}. ${c.summary || c.envKey}(${c.envKey})`)
      .join('\n');
    lines.push(
      `本轮用户似乎想${act}某项能力,但表述同时匹配到多个不同能力,无法确定是哪一项:\n${list}\n` +
      `请**先**用一句话向用户澄清「你要${act}的是上面哪一项?(可直接回复编号)」并列出这几个选项。` +
      `在用户明确选定之前,不要调用 Configure、不要擅自改配置——这是模糊语义下的铁律:宁可多问一句,也不要猜错改错。`,
    );
  }
  return lines.join('\n');
}

/** 三段式缝入口:返回 { directive, intent } 或 null(门控关/无意图但仍给原则指令)。 */
function routeConfigIntent(opts = {}) {
  const env = opts.env || process.env;
  if (!isEnabled(env)) return null;
  const intent = resolveConfigIntent(opts.text || '', env);
  // 即便没解析出具体意图,也注入原则指令(让模型永远知道:用户最高权限、别甩开关)。
  return { directive: buildConfigDirective(intent), intent };
}

module.exports = {
  isEnabled,
  CAPABILITIES,
  ON_VALUE,
  OFF_VALUE,
  resolveConfigIntent,
  buildEnvPatch,
  describeCapabilities,
  findCapability,
  buildConfigDirective,
  routeConfigIntent,
};
