'use strict';

// [AI-弱模型·照抄] 本文件是纯叶子:改动照 promptTemplateCatalog.js / goalStopGate.js 的 isEnabled 形状
//   (委托 flagRegistry + 注册表关时 _off 逐字节回退);接线(prompts.js _codingProfile /
//   toolUseLoop.js 循环顶部)照 toolUseLoop.js:4276 的 try/catch fail-soft——判定/数据在叶子,
//   IO 在接线处,叶子绝不抛、门关返空。别把匹配逻辑写进接线处、别漏 try/catch。

/**
 * procedureCatalog.js
 *
 * 「小模型该照着做的多套确定性流程(SOP / playbook)」的**单一真源**(纯叶子)。
 *
 * 诉求(goal 2026-07-06「小模型你让它自己发挥很像开盲盒,难以控制;我希望你制作多套流程让
 * 小模型照做,用流程来提高小模型的智慧」):放任弱模型自由发挥不可控——把 khyos 上高频、易翻车
 * 的任务类型固化成**编号步骤的流程**,让模型「照着做」而非「即兴发挥」。用确定性流程顶上有效智力。
 *
 * 与既有件的关系(同「不信任弱模型」族,正交):
 *  - weakModelGuidance —— 「改 khyos 源码时,哪个高危位置放什么护栏 + 照抄哪个范例」(改代码防线)。
 *  - promptTemplateCatalog —— 「网页空态给用户看哪些起始模板」(用户输入起点)。
 *  - 本件 procedureCatalog —— 「模型执行某类任务时,照着哪套编号步骤一步步做」(任务执行流程)。
 *  - 三者共享:纯叶子契约、default-on 门控、被 coding profile / 接线点同源注入。
 *
 * 纯叶子:无 I/O、无随机、无副作用、确定性、绝不抛。只返回结构化流程数据 / 文案 / 匹配裁决;
 * 注入提示词、读用户消息等副作用留给上层(prompts.js profile 注入 / toolUseLoop 循环顶部接线)。
 *
 * 门控 KHY_PROCEDURE_CATALOG(默认开,parent=KHY_WEAK_MODEL_GUIDANCE):父/子任一关 →
 * listProcedures/buildProcedureDirective 返空,matchProcedure 返 null,注入点逐字节回退(不注入)。
 */

// ── env 门控 ─────────────────────────────────────────────────────────
// 委托 flagRegistry 单一声明式真源;注册表自门控(KHY_FLAG_REGISTRY)关时,逐字节回退到本文件
// 私有 _off 手写判定(CANON 4 词 + 归一)。此模式照抄自 promptTemplateCatalog.js / goalStopGate.js。
const flagRegistry = require('./flagRegistry');
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _off(v) {
  return v !== undefined && _FALSY.has(String(v).trim().toLowerCase());
}

/**
 * 流程目录是否启用(默认开,仅显式 0/false/off/no 关闭)。
 * 委托 flagRegistry('KHY_PROCEDURE_CATALOG');注册表关时回退 `!_off(env.KHY_PROCEDURE_CATALOG)`。
 * 注:parent=KHY_WEAK_MODEL_GUIDANCE 的父子优先级由 flagRegistry 内部处理(父关→本门必关)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    if (flagRegistry.isRegistryEnabled(e)) {
      return flagRegistry.isFlagEnabled('KHY_PROCEDURE_CATALOG', e);
    }
  } catch { /* 注册表异常 → 回退手写判定 */ }
  return !_off(e.KHY_PROCEDURE_CATALOG);
}

// ── 多套任务型流程(单一真源)────────────────────────────────────────────────
// 每条:id(稳定键) / taskType(任务类型槽) / title(短标题) / when(触发线索:keywords 关键词 +
//   tools 工具名,供 matchProcedure 打分) / steps(有序祈使步骤,弱模型照做) / pitfalls(该任务
//   最容易踩的坑,直接对照)。步骤刻意具体、可核对——「照着做」比「读原则」对弱模型更可靠。
// 覆盖 khyos 上最高频、最易翻车的 8 类任务(选型依据:本仓已记录的弱模型死循环/翻车现场)。
const PROCEDURES = Object.freeze([
  Object.freeze({
    id: 'configure-model-provider',
    taskType: '配置模型 / API Key',
    title: '配置模型 provider / API Key 流程',
    when: Object.freeze({
      keywords: Object.freeze(['配置', '配好', '设置模型', 'api key', 'apikey', '密钥', '换key', '加key',
        '智谱', 'glm', 'deepseek', 'kimi', '通义', 'agnes', 'sensenova', 'provider', '渠道', '接入模型']),
      tools: Object.freeze(['configureModelProvider', 'ConfigureModelProvider']),
    }),
    steps: Object.freeze([
      '先判断是**内置** provider(glm/deepseek/kimi/通义/agnes/sensenova…)还是**自定义**(自带 endpoint 的第三方)。拿不准就当内置试。',
      '内置 provider:调 configureModelProvider(action="add", provider="<内置名>", apiKey="<key>")。**绝不**带 kind="custom"——内置 key 走 apiKeyPool,不写 custom_providers.json。',
      '自定义 provider 才用 kind="custom",并同时给 poolKey/endpoint/model。',
      '复述你要写入的 provider 名(key 只提尾 4 位,绝不回显完整 key)。',
      '调用后**用 action="list" 回读确认**该 provider 出现在列表里,而不是凭 added:1 就认为成功。',
      '若 list 里没出现或提示占位:**读返回的 note 字段**照它做,不要原样重试同一次调用——内置 key 不进 custom_providers.json 是正常现象。',
      '报告结果:配了哪个 provider、list 是否可见、note 说了什么。glm 配好后会附带免费模型清单与其他免费渠道,一并转达用户。',
    ]),
    pitfalls: Object.freeze([
      'added:1 不等于配置成功——必须 list 回读。',
      '内置 poolKey 千万别当 custom 加(会被内置守卫拒,然后你会陷入重试死循环)。',
      '同一次失败的调用重试第二遍不会有新结果——改看 note、改做法。',
    ]),
  }),
  Object.freeze({
    id: 'safe-code-edit',
    taskType: '改代码',
    title: '安全改代码流程',
    when: Object.freeze({
      keywords: Object.freeze(['改代码', '修改', '编辑', '重构', '修复', '实现', '加功能', '改文件', 'bug', 'fix']),
      tools: Object.freeze(['FileEdit', 'Edit', 'Write', 'MultiEdit', 'ApplyPatch']),
    }),
    steps: Object.freeze([
      '动手前**先 Read 目标文件**;没读过就 Edit/Write 会被拒(且你会在「no match」上打转)。',
      '读周边代码,匹配它的命名、注释密度、惯用法——新代码要像原代码。',
      '做**最小改动**:只改需要改的,不顺手重排、不加无谓抽象。',
      'Edit 的 old_string 从你刚读到的内容**逐字复制**,带足够上下文保证唯一。',
      '改完**不臆测成功**:靠工具是否报错判断,而非「应该好了」。',
      '若新增行为:先在 flagRegistry 注册门控,再写成纯叶子(见「加门控」流程)。',
      '跑相关测试;失败就读报错→改→重跑,循环到绿,再报告真实结果。',
    ]),
    pitfalls: Object.freeze([
      '未 Read 就编辑 / old_string 靠猜 → 死在「no match」。',
      '大改一片、顺手重构 → 引入无关回归。',
    ]),
  }),
  Object.freeze({
    id: 'add-feature-gate',
    taskType: '加开关/门控/纯叶子',
    title: '新增 KHY_* 门控 + 纯叶子流程',
    when: Object.freeze({
      keywords: Object.freeze(['门控', '开关', 'flag', 'feature flag', 'khy_', '纯叶子', 'leaf', '默认开', '灰度']),
      tools: Object.freeze([]),
    }),
    steps: Object.freeze([
      '**先在 flagRegistry.js 的 FLAGS 里注册** KHY_你的名字,形状 `{ mode:"default-on", off:"CANON", default:true }`(有父门控就加 parent)。',
      '未注册的 flag 会被保守当作**开**,你的关闭开关会静默失效——所以注册是第一步,不是最后一步。',
      '把新行为写成纯叶子:零 IO、确定性、绝不抛(坏输入返安全默认)、可单测。照抄 goalStopGate.js 的 isEnabled + decide 形状。',
      '接线只做 IO:require 叶子 → isEnabled 门控 → 取裁决 → 落地,整块 try/catch fail-soft。照抄 toolUseLoop.js:4276-4311。',
      '保证**门关时逐字节回退**旧行为(严格超集:开=旧行为+新增,关=旧行为)。',
      '写 node:test:门开、门关(回退)两个方向都要断言。',
      '跑三守卫:check:leaf-contract、check:change-safety、check:model-hardcoding,必须 0 error。',
    ]),
    pitfalls: Object.freeze([
      '忘了注册 flag → 关不掉,失去 byte-revert 保证。',
      '把判定逻辑塞进接线处、或让叶子抛异常 → 阻断主流程。',
    ]),
  }),
  Object.freeze({
    id: 'debug-failure',
    taskType: '排查报错/失败',
    title: '排查失败与报错流程',
    when: Object.freeze({
      keywords: Object.freeze(['报错', '失败', '错误', '异常', '不工作', '不生效', '崩溃', 'error', '401', '403', '404', '500', 'timeout', '超时']),
      tools: Object.freeze([]),
    }),
    steps: Object.freeze([
      '**读完整报错**,不要只看结论。定位真源到 file:line。',
      '归类:认证(401/403)/ 找不到(404)/ 限流(429)/ 超时 / 网络 / 逻辑。',
      '认证类(401/403、no key)→ 走「配置模型 / API Key」流程,主动问用户是否帮忙配 key,别只甩底层报错。',
      '做**最小复现**:用最小输入触发同一个错。',
      '**一次只改一处**,改完立刻重跑验证;别一口气改多处再一起测。',
      '命令超时(60s idle):不要原样加大 timeout 重试——它被钳制无效;改成有输出/缩范围的命令,或换对的工具。',
      '同一个失败调用别连续重试第二遍(拿不到新信息,还会撞死循环守卫)。',
      '定位到根因后再动手修,并说明根因与验证方式。',
    ]),
    pitfalls: Object.freeze([
      '只报「XX 失败」不给根因、不给出路。',
      '加大 timeout 重试无输出的命令 → 空转到迭代预算耗尽。',
    ]),
  }),
  Object.freeze({
    id: 'deploy-portable',
    taskType: '下载/部署项目·便携版',
    title: '下载部署项目 / 转便携版流程',
    when: Object.freeze({
      keywords: Object.freeze(['下载', '部署', '安装', '便携', '便携版', '绿色版', '免安装', 'portable',
        'deploy', 'install', '装一下', '搭一下', '跑起来', '本地部署', '发布资产', '二进制', 'binary']),
      tools: Object.freeze(['shellCommand', 'ShellCommand', 'WebFetch']),
    }),
    steps: Object.freeze([
      '先判定目标形态:是**预编译二进制/CLI**(Go/Rust 单文件最适合便携)、**需装的应用**(带 installer),还是**源码项目**(需自己 build)。拿不准先看它的 GitHub releases 页有没有对应你系统的产物。',
      '**先探明真实可下载资产,别猜 URL**:用 `gh release list -R <owner>/<repo>` 或 GET `https://api.github.com/repos/<owner>/<repo>/releases/latest` 列出真实资产名——写死一个下载 URL 猜错就是 404(这一步跳过就会翻车)。',
      '识别本机 OS/架构(win/linux/macOS × x64/arm64),从资产里挑**匹配那一个**;挑错架构下载下来也跑不起来。',
      '下载到**本地便携目录**(如 khyos 数据目录下的 `portable/<tool>/`),不要装进系统目录、不要写系统级 PATH/注册表。',
      '**能便携就便携,别跑安装器**:压缩包(zip/tar.gz/7z)直接解压到便携目录即可;只有 installer(.msi/.exe/.dmg)才考虑用它的静默/解包参数把文件抽出来,仍落到便携目录。',
      '写一个启动脚本/shim(把便携目录加入**当前会话**的 PATH,或直接用绝对路径调用),而不是永久改全局环境。',
      '**验证**:用绝对路径或 shim 跑 `<tool> --version` / `<tool> --help`,确认真的能启动;再向用户报告装到了哪、怎么调用。',
    ]),
    pitfalls: Object.freeze([
      '猜死一个下载 URL 而不查发布 API → 资产名/标签一变就 404(还会被误诊成「找不到命令」)。',
      '挑错 OS/架构的资产;或本该解压便携化却去跑安装器、污染系统。',
      '把 404 当成「命令没装」反复重试同一条命令 → 空转到迭代预算耗尽。',
    ]),
  }),
  Object.freeze({
    id: 'web-research',
    taskType: '联网搜索/取网页',
    title: '联网搜索与网页读取流程',
    when: Object.freeze({
      keywords: Object.freeze(['搜索', '搜一下', '查一下', '联网', '最新', '新闻', '网页', '打开链接', '取网页', 'search', '查资料']),
      tools: Object.freeze(['WebSearch', 'WebFetch']),
    }),
    steps: Object.freeze([
      '先把查询词收敛清楚(关键词、时间范围、要什么结论)。',
      '用 WebSearch 多引擎扇出;需要正文再用 WebFetch 抓具体页面。',
      '**交叉验证**:读 2 个以上来源再下结论,别只信第一条。',
      '给出结论时**附来源 URL**,不编造事实与链接。',
      '抓不到 / 被墙:说明情况并给已有信息,不要反复重试同一 URL。',
    ]),
    pitfalls: Object.freeze([
      '单来源直接下结论。',
      '编造 URL 或事实。',
    ]),
  }),
  Object.freeze({
    id: 'vision-task',
    taskType: '识图/视觉',
    title: '图像识别与视觉失败恢复流程',
    when: Object.freeze({
      keywords: Object.freeze(['图片', '图像', '截图', '识别', '识图', '看图', 'ocr', '这张图', '照片', 'vision']),
      tools: Object.freeze(['RecognizeImage', 'ImageOCR']),
    }),
    steps: Object.freeze([
      '判断当前模型是否多模态;不是则透明路由到视觉模型(如 GLM-4.6V-Flash)再返回。',
      '走显式识图能力时用 RecognizeImage 工具,别把图当纯文本硬塞给文本模型。',
      '识别失败先**定性总结**(是认证/无 key/限流/网络还是模型不支持),别原样甩「智谱 401」。',
      '认证/无 key 失败 → 主动问用户「是否帮你配置 GLM 或其他图像识别模型的 API Key」,走配置流程。',
      '实在识别不了 → OCR 兜底提取文字,并说明能给到什么、给不到什么。',
    ]),
    pitfalls: Object.freeze([
      '把锅窄化成「某 provider 失败」,不给出路。',
      '文本模型硬吞图片 → 无意义退回。',
    ]),
  }),
  Object.freeze({
    id: 'release-publish',
    taskType: '发布版本',
    title: '发布 / 出包版本流程(先干跑再真发)',
    when: Object.freeze({
      keywords: Object.freeze(['发布', '发版', 'release', 'publish', '出包', '出版本',
        '上传', 'npm', 'pypi', 'testpypi', '打标签', '干跑', 'dry-run', 'dryrun',
        '彩排', '正式发', '发包']),
      tools: Object.freeze([]),
    }),
    steps: Object.freeze([
      '先对齐版本号:确认要发的版本(如 0.1.163),把所有 package.json / 版本文件同步到同一个号(前后端一致),别只改一处——版本不一致会被 `check:version-sync` 挡下。',
      '**先跑发布门禁彩排,别直接发**:`node scripts/release/release-gate.js`(确定性硬检查全过才 GO;拿不准加 `--tier=all` 完整彩排)。红 = NO-GO,先修到全绿再往下走。',
      '**先干跑(dry-run)再真发**:`bash scripts/release/publish-dual.sh --dry-run`(构建 + `twine check` + `npm publish --dry-run`,一切照做但绝不上传)。核对将要发布的版本号、包内容、文件清单无误。',
      '只有 release-gate 全绿、dry-run 无误、且用户明确要「正式发布」时,才去掉 `--dry-run` 真发——正式发布会 commit/tag(+可选 push)并上传 npm/pypi,**不可逆**。',
      '发布后验证:在干净环境 `pip install` / `npm i` 拉一份新版本,`--version` 对得上真实号,再报告完成。',
    ]),
    pitfalls: Object.freeze([
      '不 dry-run 直接 publish / 过早去掉 `--dry-run`——错版本或夹带文件一旦上传就撤不回。',
      '只改一个 package.json 的版本号,前后端版本不一致(被门禁挡下,或发出去就是坏的)。',
      '没过 release-gate 就发 / 用 `--no-verify` 绕过守卫。',
    ]),
  }),
  Object.freeze({
    id: 'git-commit',
    taskType: '提交代码',
    title: '提交代码流程',
    when: Object.freeze({
      keywords: Object.freeze(['提交', 'commit', '推送', 'push', '暂存', 'git', '发版', 'release']),
      tools: Object.freeze(['gitCommit', 'GitCommit']),
    }),
    steps: Object.freeze([
      '先看分支:若在 main/master,先建分支再提,别直接往主干提。',
      '用 git status / git diff 核对将要提交的改动,确认没有夹带无关文件。',
      '按逻辑分组提交,commit message 说清「做了什么、为什么」。',
      '提交信息结尾加 `Co-Authored-By` 尾注(仓库既有约定)。',
      '**只在用户明确要求时才 push**;不确定就先提交不推送并告知。',
    ]),
    pitfalls: Object.freeze([
      '直接往 main 提 / 未经允许就 push。',
      '一把 add . 夹带无关改动。',
    ]),
  }),
  Object.freeze({
    id: 'verify-and-report',
    taskType: '验证与收尾',
    title: '验证并诚实报告流程',
    when: Object.freeze({
      keywords: Object.freeze(['验证', '测试', '跑一下', '完成了吗', '确认', '收尾', '检查', 'test', 'verify', '守卫']),
      tools: Object.freeze([]),
    }),
    steps: Object.freeze([
      '跑测试并给**真实数字**(多少通过/失败),不要凭感觉说「应该通过」。',
      '若动了门控/纯叶子:验证门关时逐字节回退,并跑三守卫。',
      '如实报告:失败就贴报错说失败;跳过的步骤要说跳过了。',
      '任务确实做完且验证过,才明确说「完成」——不含糊、不谎报。',
      '别用 --no-verify 强推过守卫;守卫红=真问题,先修到自己变绿。',
    ]),
    pitfalls: Object.freeze([
      '没跑测试就宣称完成。',
      '谎报绿 / 用 --no-verify 掩盖问题。',
    ]),
  }),
]);

/**
 * 列出流程(可按 taskType / id 过滤)。门控关或异常 → 返回空数组(纯叶子安全默认)。
 * @param {object} [opts] { id?: string, taskType?: string }
 * @param {object} [env]
 * @returns {Array<object>} 每条含 id/taskType/title/when/steps/pitfalls 的**浅拷贝**
 */
function listProcedures(opts = {}, env) {
  if (!isEnabled(env)) return [];
  const id = opts && opts.id != null ? String(opts.id).trim() : '';
  const taskType = opts && opts.taskType != null ? String(opts.taskType).trim() : '';
  let rows = PROCEDURES.map((p) => ({
    id: p.id,
    taskType: p.taskType,
    title: p.title,
    when: { keywords: p.when.keywords.slice(), tools: p.when.tools.slice() },
    steps: p.steps.slice(),
    pitfalls: p.pitfalls.slice(),
  }));
  if (id) rows = rows.filter((p) => p.id === id);
  if (taskType) rows = rows.filter((p) => p.taskType === taskType);
  return rows;
}

/**
 * 归一化匹配信号:接受字符串(用户消息)或 { text, toolName }。
 * @param {string|object} signal
 * @returns {{ text: string, toolName: string }}
 */
function _normSignal(signal) {
  if (signal && typeof signal === 'object') {
    return {
      text: String(signal.text || '').toLowerCase(),
      toolName: String(signal.toolName || signal.tool || ''),
    };
  }
  return { text: String(signal || '').toLowerCase(), toolName: '' };
}

/**
 * 据信号(用户消息文本 / 当前工具名)确定性匹配最相关的一套流程。
 * 打分:每个命中的关键词(子串) +1;工具名精确命中 +3(工具信号比自由文本更强)。
 * 取最高分且 >0 者;平分按声明顺序取先者(确定性)。无命中或门关 → null。
 * @param {string|object} signal 用户消息字符串,或 { text, toolName }
 * @param {object} [env]
 * @returns {object|null} 命中流程的浅拷贝(同 listProcedures 元素形状),或 null
 */
function matchProcedure(signal, env) {
  try {
    if (!isEnabled(env)) return null;
    const { text, toolName } = _normSignal(signal);
    if (!text && !toolName) return null;
    let best = null;
    let bestScore = 0;
    for (const p of PROCEDURES) {
      let score = 0;
      if (toolName && p.when.tools.includes(toolName)) score += 3;
      if (text) {
        for (const kw of p.when.keywords) {
          if (kw && text.includes(kw)) score += 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (!best || bestScore <= 0) return null;
    return listProcedures({ id: best.id }, env)[0] || null;
  } catch {
    return null; // 纯叶子:异常 → 安全默认(null),绝不抛
  }
}

/**
 * 把一套流程渲染成编号步骤的 markdown 块(供 currentMessage 前置注入 / 工具出口)。
 * 坏输入(缺 steps)→ 返回空串,绝不抛。
 * @param {object} proc listProcedures / matchProcedure 返回的流程对象
 * @returns {string}
 */
function buildProcedureBlock(proc) {
  if (!proc || !Array.isArray(proc.steps) || proc.steps.length === 0) return '';
  const lines = [`## 照着做:${proc.title}`,
    '这是本类任务的确定性流程。**按编号一步步做,不要即兴发挥、不要跳步。**'];
  proc.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  if (Array.isArray(proc.pitfalls) && proc.pitfalls.length) {
    lines.push('避坑:');
    proc.pitfalls.forEach((p) => lines.push(`- ${p}`));
  }
  return lines.join('\n');
}

/**
 * 构建注入「编码 profile」的**始终在场**流程索引指令:告诉模型有哪几套流程、匹配到就照着做。
 * 门控关或异常 → 返回空串(逐字节回退:profile 不含该段)。确定性,无随机。
 * @param {object} [env]
 * @returns {string}
 */
function buildProcedureDirective(env) {
  try {
    if (!isEnabled(env)) return '';
    const lines = [
      '## 照流程做事(别开盲盒)',
      '下面是几套针对高频任务的确定性流程。当你的当前任务命中其中一类时,**照着那套编号步骤一步步做,不要即兴发挥**——流程就是用来把不确定性压下去的。需要完整步骤时,系统会在该任务开始时把匹配到的那套流程注入给你。',
    ];
    PROCEDURES.forEach((p) => lines.push(`- **${p.taskType}** — ${p.title}`));
    return lines.join('\n');
  } catch {
    return ''; // 纯叶子:异常 → 安全默认(空串),绝不抛
  }
}

module.exports = {
  PROCEDURES,
  isEnabled,
  listProcedures,
  matchProcedure,
  buildProcedureBlock,
  buildProcedureDirective,
};
