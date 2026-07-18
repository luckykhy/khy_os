'use strict';

/**
 * deliverableClosure.js — 自驱收尾保障（[DESIGN-ARCH-050] §3.5）。
 *
 * 解决用户第二条痛点：「不用提示词推它，有时它就不出结果」。根因是——既有的「你还没真正交付」
 * 类 nudge 全部挂在 `_harnessProfile.nudges` 后面，对强模型档（T0）默认关闭；于是模型回一句
 * 进度前言（"让我看看…/我先检查一下"）或空壳就收尾，把「过程」当成了「结果」交付出去。
 *
 * 本守卫**与模型档无关**：只要「确实干了活（有成功工具调用）」却「没产出实质结论」，
 * 就强制再推一轮，命令模型基于已有结果写出完整最终答复。一次性、有界，绝不死缠。
 *
 * 纯函数、自带最小判定器，不依赖 toolUseLoop 内部私有函数，便于独立单测。
 */

// 进度前言：以「让我/我来/我先/正在/接下来/现在/首先…去做某事」开头且没有实质结论的句子。
const PROGRESS_ONLY_RE = /^(让我|我来|我先|我现在|我会|稍等|请稍候|正在|接下来|现在|首先|那么我|好的[，,]?\s*(我|让我))/;
const PROGRESS_TAIL_RE = /(看一?看|查看|检查|读取|分析|了解|确认|搜索|查询|尝试|处理)([一下]*)?[。.…]*$/;
// 内嵌/尾部「半截话」意图：真实卡壳常**不**从首字符起头（「文件已经在桌面上了，让我用图像识别查看内容」），
// 只在**最后一句**里检测「让我…<动作>」式悬而未决的计划小句。用户原话痛点「也不要总是半截话」。
const PROGRESS_INTENT_LEAD_RE = /(让我|我来|我先|我现在|我去|我这就|我马上|我可以先|我打算|我准备|接下来我?|那我|那就|现在我?来?|继续)/;
const PROGRESS_TASK_VERB_RE = /(检查|排查|查看|看一?看|看一?下|看一眼|读取|读|分析|识别|了解|确认|搜索|查询|尝试|处理|定位|梳理|整理|清理|运行|执行|打开|扫描|浏览)/;

// 结论/交付词表——与 toolUseLoop 的 hasConclusion 口径对齐，并补齐应用启动类终态动词，
// 避免把「已启动: 夸克」「已打开: X」这类**简短但完整**的交付确认误判为「只有进度」。
const CONCLUSION_RE = /(完成|成功|已创建|已修改|已生成|已实现|已修复|已整理|已部署|已运行|已验证|已启动|已打开|已执行|已发送|已安装|已下载|已配置|启动了|打开了|验证|无需|不需要|结论|总结|结果|综上|done|completed|finished|created|implemented|fixed|launched|opened|started|verified|summary|result)/i;

// 纯应答口水：整句只是「好的/嗯/收到/明白了/ok」之类无实质内容的客套确认。
// 工具已经跑完、数据已在手里，却只回一句这样的应答 = 把过程当结果、没做总结
// （用户原话痛点「只有过程没有总结」的典型形态之一）。整句锚定，只抓纯客套，
// 绝不误伤任何携带实质信息的简短交付（如「已启动: 夸克」含结论词，由上面的 CONCLUSION_RE 放过）。
const BARE_ACK_RE = /^(好的?|行|嗯+|哦+|噢+|额+|呃+|ok(ay)?|sure|alright|got\s*it|收到|明白了?|知道了|了解|没问题|可以的?|当然)[，,。.!！?？~、…\s]*$/i;

// ── 时态判别（门控 KHY_PLAN_KICKOFF_TENSE，默认开）──────────────────────────
// 真根因：`CONCLUSION_RE` 里 完成/成功/验证/结果 这些词在**未来时执行计划**中同样高频出现
// （「确保…可运行」「完成交付」「逐一验证」），于是一段「只列了计划、一个工具都没调」的长文
// 被误判为「已交付」→ `shouldForceKickoff` 让位 → 既有自驱 nudge 被否决 → khy 写了计划就停。
// 修法（不改裁剪策略，换判据口径）：在 CONCLUSION_RE 之前先做时态判别——**多步枚举 + 前瞻计划腔
// + 无任何完成标记** = 未执行计划 = 只有进度。有完成标记（已X / X通过 / X成功）则**不**判为未执行，
// 交回下游结论判定，绝不误伤真交付（含带编号的产物清单）。

// 枚举步骤：行首「1. / 2) / 3、」等有序列表项（≥2 条才算多步计划）。
const PLAN_STEP_RE = /(^|\n)\s*\d+[.)、]\s*\S/g;
// 顺序连接词：首先…然后…接着…最后（≥2 个才算铺陈了多步流程）。
const PLAN_SEQUENCE_RE = /(首先|第一步|然后|接着|随后|之后|再然后|最后|最终|下一步)/g;
// 前瞻计划腔：明确表达「打算去做」而非「已经做完」。
const PLAN_LEAD_FUTURE_RE = /(计划|打算|准备|将要?|我会|我要|接下来|下一步|拟|即将|我来(帮|把|给|做|写|建|跑|运行)|下面是|下面.{0,4}(开始|进行|执行))/;
// 完成标记（perfective）：真正表示「已经做完/验证过」的过去时/完成体词。命中即**不**算未执行计划。
// 只认强完成信号（已X / X通过 / X成功 / X完毕 / 了字收尾的完成），不认裸「完成」（可能是未来目标「完成交付」）。
const PERFECTIVE_DELIVERY_RE = /(已经?(完成|创建|修改|生成|实现|修复|整理|部署|运行|验证|启动|打开|执行|发送|安装|下载|配置|跑通|构建|编译)|(验证|测试|编译|构建|运行|启动|部署|检查|安装)(通过|成功|完毕|完成|无误)|通过了|成功了|跑通了|done|passed|succeeded|built successfully|completed successfully)/i;

function _planKickoffTenseEnabled() {
  const v = String(process.env.KHY_PLAN_KICKOFF_TENSE || '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no', 'disable', 'disabled'].includes(v);
}

/**
 * 判一段回复是否「只列了未来时多步计划、却尚未执行」。
 * 保守三条件同时成立才为真：①有完成标记 → 立即否（真交付/半成品报告，交回下游）；
 * ②多步枚举（≥2 条有序列表项 或 ≥2 个顺序连接词）；③带前瞻计划腔。
 * 三者缺一即 false（宁可漏判，不误伤真交付）。纯函数、确定性。
 */
function _looksLikeUnexecutedPlan(text) {
  const t = String(text || '');
  if (PERFECTIVE_DELIVERY_RE.test(t)) return false; // 有完成标记 → 非「未执行」
  const stepCount = (t.match(PLAN_STEP_RE) || []).length;
  const seqCount = (t.match(PLAN_SEQUENCE_RE) || []).length;
  const enumerated = stepCount >= 2 || seqCount >= 2;
  if (!enumerated) return false;                     // 非多步枚举 → 不当计划
  return PLAN_LEAD_FUTURE_RE.test(t);                // 且带前瞻计划腔
}

/**
 * 判一段回复是否「只有进度、没有结论」。
 *
 * 精确策略（零误报优先）：只有「空」或「首句是进度腔（让我…/我先…/…看一下）且全文无任何结论词」
 * 才算未交付。**不**用长度阈值——CJK 下「已启动: 夸克」只有几个字却是完整交付，长度判定会误伤。
 */
function looksLikeProgressOnly(text) {
  const t = String(text || '').trim();
  if (!t) return true; // 空 = 显然没交付
  // 时态判别先行（门控默认开）：未来时多步计划、零完成标记 → 只有进度（未执行），
  // 别被计划文里的「完成/成功/验证」误当已交付。门控关 → 逐字节回退今日行为（直接走 CONCLUSION_RE）。
  if (_planKickoffTenseEnabled() && _looksLikeUnexecutedPlan(t)) return true;
  if (CONCLUSION_RE.test(t)) return false; // 带任何结论词 → 视为已交付
  if (BARE_ACK_RE.test(t)) return true; // 纯客套应答（「好的。」）= 没做总结
  const firstLine = t.split('\n').map((s) => s.trim()).find(Boolean) || '';
  if (PROGRESS_ONLY_RE.test(firstLine) || PROGRESS_TAIL_RE.test(firstLine)) return true;
  // 内嵌/尾部「半截话」：以最后一句为「让我…<动作>」式悬而未决前言收尾（且全文无结论词，上面已排除）。
  const clauses = t.split(/[。．.!?！？;；\n]+/).map((s) => s.trim()).filter(Boolean);
  const lastClause = clauses.length ? clauses[clauses.length - 1] : '';
  return !!lastClause && PROGRESS_INTENT_LEAD_RE.test(lastClause) && PROGRESS_TASK_VERB_RE.test(lastClause);
}

/**
 * 是否需要强制收尾。
 * @param {object} input
 * @param {string} input.reply           模型本轮去除工具调用后的纯文本
 * @param {number} input.pendingToolCalls 本轮还要执行的工具数（>0 说明没在收尾，不介入）
 * @param {number} input.totalToolCalls   全程已执行的工具调用数（>0 说明确实干了活）
 * @param {boolean}input.echoOfToolOutput 回复只是把工具原文逐字回贴（caller 比对工具结果算出）
 * @param {boolean}input.used            本守卫是否已用过（一次性）
 * @returns {boolean}
 */
function shouldForceClosure(input = {}) {
  if (input.used) return false;
  if ((input.pendingToolCalls || 0) > 0) return false; // 还在执行，不是收尾时刻
  if ((input.totalToolCalls || 0) <= 0) return false;  // 没干活就不存在「干了没交付」
  if (input.echoOfToolOutput) return true; // 把工具原文当结果回贴 = 没做总结
  return looksLikeProgressOnly(input.reply);
}

/** 注入文案：禁止再调工具，命令基于已有结果写出完整最终答复。 */
function buildClosureMessage(userMessage) {
  const u = String(userMessage || '').slice(0, 300);
  return '[SYSTEM 收尾保障] 你已经执行了若干操作，但本轮只回了进度/过程性内容，没有给出**最终结果**。'
    + '这正是「干了活却不交付」的问题。请立即基于上面已获得的工具结果，直接写出完整、可交付的最终答复：\n'
    + '1. 你最终做成了什么 / 得到了什么结论；\n'
    + '2. 关键产物或要点（文件、数据、答案本身）；\n'
    + '3. 如有未完成项，明确指出。\n'
    + '不要再说「让我…」「我来看看…」这类过程话；现在就给结果。\n\n'
    + (u ? `用户原始请求: ${u}` : '');
}

/**
 * 是否需要强制「自驱启动」（收尾守卫的镜像缺口）。
 *
 * 治第三条痛点：「回复断断续续，必须用提示词推动」。根因——模型回一句计划前言
 * （"我先看看桌面有什么…"）却**连一个工具都没调**就收尾。`shouldForceClosure`
 * 故意在 `totalToolCalls<=0` 时让位（它只管「干了活没交付」），于是「连活都没开始」
 * 这条对称缺口无人兜底，用户只能手动打「继续」。
 *
 * 默认仅在「啥都没做、只回了计划前言」时为真——`used` / `pendingToolCalls>0` /
 * `totalToolCalls>0` 任一为真都不介入（前两者说明不是这条缺口，后者交给 closure 守卫）。
 *
 * `allowAfterWork=true` 时放开 `totalToolCalls>0` 这条让位：覆盖「干了一半又回前言」的续作缺口
 * （closure 守卫一次性、用尽即失守，用户原话痛点「也不要总是半截话我推了动一下否则直接不动」）。
 * 调用方须自带**有界计数 + 同前言签名 break**，本函数只做单点判定、不负责防死循环。
 *
 * @param {object} input
 * @param {string} input.reply            模型本轮去除工具调用后的纯文本
 * @param {number} input.pendingToolCalls 本轮待执行的工具数（>0 → 模型其实在调工具，不介入）
 * @param {number} input.totalToolCalls   全程已执行的工具调用数（>0 → 不属于「没开始」）
 * @param {boolean}input.allowAfterWork   是否也覆盖「干了一半又回前言」（默认 false：仅管「没开始」）
 * @param {boolean}input.used             本守卫是否已用过（一次性，仅旧调用方使用）
 * @returns {boolean}
 */
function shouldForceKickoff(input = {}) {
  if (input.used) return false;
  if ((input.pendingToolCalls || 0) > 0) return false; // 模型其实要调工具，不是干瞪眼
  if (!input.allowAfterWork && (input.totalToolCalls || 0) > 0) return false; // 默认：已开过工交给 closure 守卫
  return looksLikeProgressOnly(input.reply);
}

/** 注入文案：现在就执行第一步（调用工具）；若确实无需工具，直接给完整结果——别只描述计划。 */
function buildKickoffMessage(userMessage) {
  const u = String(userMessage || '').slice(0, 300);
  return '[SYSTEM 自驱启动] 你本轮只回了一句计划/前言（"我先看看…/让我…"），却没有真正开始——'
    + '没有调用任何工具，也没有给出结果。请**立即开始执行第一步**：\n'
    + '1. 若需要工具（查看目录、读文件、运行命令、打开应用等），现在就调用相应工具，不要只口头描述；\n'
    + '2. 若该任务确实无需任何工具，直接给出完整、可交付的最终答复；\n'
    + '3. 不要再说「我先…」「让我看看…」这类只有计划没有动作的话——现在就动手。\n\n'
    + (u ? `用户原始请求: ${u}` : '');
}

module.exports = {
  shouldForceClosure,
  looksLikeProgressOnly,
  buildClosureMessage,
  shouldForceKickoff,
  buildKickoffMessage,
  _looksLikeUnexecutedPlan,
  _planKickoffTenseEnabled,
};
