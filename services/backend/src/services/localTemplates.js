'use strict';

/**
 * 常见任务模板库（无模型 · 本地可用）
 * =================================================================
 * 角色：无 AI 模型时，对「给我一个周报模板 / 会议纪要怎么写 / commit message 模板」
 * 这类常见任务，本地直接产出结构化、可填充的模板骨架——不依赖网络也不依赖模型。
 *
 * 设计：单一真源模板注册表，每条 { id, label, keywords, render() }。
 *  - detectTemplate(query) -> id | null   （保守匹配，不命中返回 null 让上层降级）
 *  - renderTemplate(id) -> string         （纯文本骨架）
 *  - listTemplates() -> [{id,label}]      （用于能力菜单 / "有哪些模板"）
 *  - tryTemplate(query) -> string | null  （检测 + 渲染一步到位）
 *
 * 模板是「骨架 + 占位符 + 填写提示」，让用户照着填；绝不杜撰具体内容。
 * 全 env 可调开关：KHY_LOCAL_TEMPLATES=off 关闭。
 */

function _enabled() {
  const v = String(process.env.KHY_LOCAL_TEMPLATES || 'on').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(v);
}

// 显式「要模板」的意图词——只有同时命中某模板关键词时才触发，避免误抢正常问答。
const _WANT_TEMPLATE_RE = /(模板|样板|格式|骨架|怎么写|如何写|范文|范例|样例|套路|template|boilerplate|skeleton|format)/i;
// 「写/起草/帮我写」类生成动词——配合模板主题词也算请求模板骨架。
const _WRITE_VERB_RE = /(写一?[份个篇]?|起草|拟一?[份个]?|帮我?写|帮我?弄|生成一?[份个篇]?|draft|write\s+(?:a|an|me)?)/i;

/**
 * 模板注册表。keywords 为该模板的主题词（任一命中 + 「要模板」意图 → 匹配）。
 * render 返回纯文本骨架。
 */
const TEMPLATES = [
  {
    id: 'weekly_report',
    label: '周报',
    keywords: [/周报/, /工作报告/, /weekly\s*report/i],
    render: () => [
      '# 周报（{{姓名}} · {{本周日期范围}}）',
      '',
      '## 一、本周完成',
      '- {{事项1：做了什么 → 结果/产出}}',
      '- {{事项2}}',
      '- {{事项3}}',
      '',
      '## 二、数据/进展',
      '- {{关键指标或里程碑，如完成度 80%}}',
      '',
      '## 三、问题与风险',
      '- {{遇到的阻塞 / 需要的支持}}',
      '',
      '## 四、下周计划',
      '- {{下周事项1}}',
      '- {{下周事项2}}',
    ].join('\n'),
  },
  {
    id: 'meeting_minutes',
    label: '会议纪要',
    keywords: [/会议纪要/, /会议记录/, /minutes/i, /纪要/],
    render: () => [
      '# 会议纪要',
      '',
      '- 主题：{{会议主题}}',
      '- 时间：{{YYYY-MM-DD HH:MM}}',
      '- 地点/方式：{{线下会议室 / 线上链接}}',
      '- 参会人：{{姓名, 姓名, ...}}',
      '- 主持/记录：{{主持人}} / {{记录人}}',
      '',
      '## 一、议题与讨论',
      '1. {{议题1}}：{{讨论要点}}',
      '2. {{议题2}}：{{讨论要点}}',
      '',
      '## 二、决议事项',
      '- {{决议1}}',
      '',
      '## 三、待办（Action Items）',
      '| 事项 | 负责人 | 截止日期 |',
      '| --- | --- | --- |',
      '| {{待办1}} | {{负责人}} | {{日期}} |',
    ].join('\n'),
  },
  {
    id: 'email',
    label: '正式邮件',
    keywords: [/邮件/, /email/i, /mail/i, /发信/],
    render: () => [
      '主题：{{一句话说明邮件目的}}',
      '',
      '{{收件人称呼}}：',
      '',
      '您好！',
      '',
      '{{第一段：说明来意/背景，一两句}}',
      '',
      '{{第二段：具体事项/请求，可分点}}',
      '- {{要点1}}',
      '- {{要点2}}',
      '',
      '{{第三段：期望的下一步/时间节点}}',
      '',
      '如有疑问，欢迎随时联系。感谢！',
      '',
      '此致',
      '{{你的姓名}}',
      '{{职位 / 联系方式}}',
    ].join('\n'),
  },
  {
    id: 'leave_request',
    label: '请假条',
    keywords: [/请假条/, /请假/, /leave\s*request/i],
    render: () => [
      '请假申请',
      '',
      '{{审批人}}：',
      '',
      '本人 {{姓名}}，因 {{请假事由}}，需请 {{假别：事假/病假/年假}} {{N}} 天，',
      '时间自 {{开始日期}} 至 {{结束日期}}（共 {{N}} 天）。',
      '期间工作已交接给 {{交接人}}，紧急情况可电话联系：{{电话}}。',
      '',
      '请批准为盼。',
      '',
      '申请人：{{姓名}}',
      '日期：{{YYYY-MM-DD}}',
    ].join('\n'),
  },
  {
    id: 'prd',
    label: '产品需求文档（PRD）',
    keywords: [/prd/i, /需求文档/, /产品需求/],
    render: () => [
      '# {{产品/功能名}} 需求文档（PRD）',
      '',
      '## 1. 背景与目标',
      '- 背景：{{为什么做这个}}',
      '- 目标：{{要达成什么，最好可量化}}',
      '',
      '## 2. 用户与场景',
      '- 目标用户：{{谁用}}',
      '- 核心场景：{{在什么情况下用}}',
      '',
      '## 3. 功能需求',
      '| 编号 | 功能 | 优先级(P0/P1/P2) | 说明 |',
      '| --- | --- | --- | --- |',
      '| F1 | {{功能}} | P0 | {{描述}} |',
      '',
      '## 4. 非功能需求',
      '- 性能：{{}}  安全：{{}}  兼容：{{}}',
      '',
      '## 5. 验收标准',
      '- {{可验证的完成条件}}',
      '',
      '## 6. 排期与里程碑',
      '- {{阶段 → 日期}}',
    ].join('\n'),
  },
  {
    id: 'readme',
    label: '项目 README',
    keywords: [/readme/i, /项目说明/, /说明文档/],
    render: () => [
      '# {{项目名}}',
      '',
      '{{一句话项目简介}}',
      '',
      '## 功能特性',
      '- {{特性1}}',
      '- {{特性2}}',
      '',
      '## 安装',
      '```bash',
      '{{安装命令，如 npm install / pip install}}',
      '```',
      '',
      '## 快速开始',
      '```bash',
      '{{运行命令}}',
      '```',
      '',
      '## 配置',
      '| 变量 | 说明 | 默认值 |',
      '| --- | --- | --- |',
      '| {{KEY}} | {{说明}} | {{默认}} |',
      '',
      '## 许可证',
      '{{License，如 MIT}}',
    ].join('\n'),
  },
  {
    id: 'resume',
    label: '简历',
    keywords: [/简历/, /resume/i, /cv\b/i],
    render: () => [
      '# {{姓名}}',
      '{{职位意向}} · {{电话}} · {{邮箱}} · {{城市}}',
      '',
      '## 个人简介',
      '{{2-3 句概括你的经验与优势}}',
      '',
      '## 工作经历',
      '### {{公司}} · {{职位}}（{{起止时间}}）',
      '- {{用动词开头 + 量化结果，如“主导 X，提升 Y 30%”}}',
      '- {{职责/成果}}',
      '',
      '## 项目经历',
      '### {{项目名}}（{{时间}}）',
      '- 角色：{{}}  技术：{{}}  成果：{{}}',
      '',
      '## 技能',
      '- {{技能清单}}',
      '',
      '## 教育',
      '- {{学校}} · {{专业}} · {{学历}}（{{时间}}）',
    ].join('\n'),
  },
  {
    id: 'commit_message',
    label: 'Git commit message',
    keywords: [/commit\s*(?:message|msg)?/i, /提交信息/, /提交说明/, /git\s*提交/],
    render: () => [
      '<类型>(<范围>): <简短描述，祈使句，≤50 字>',
      '',
      '<正文：解释“为什么”而非“做了什么”，每行 ≤72 字。>',
      '<可分点列出关键改动。>',
      '',
      '<可选页脚：BREAKING CHANGE / Closes #123>',
      '',
      '— 类型参考 —',
      'feat 新功能 | fix 修复 | docs 文档 | style 格式 | refactor 重构',
      'perf 性能 | test 测试 | build 构建 | ci CI | chore 杂项',
    ].join('\n'),
  },
  {
    id: 'bug_report',
    label: 'Bug 报告',
    keywords: [/bug\s*report/i, /bug\s*报告/i, /缺陷报告/, /报bug/i, /提bug/i, /故障报告/],
    render: () => [
      '## Bug 报告',
      '',
      '**标题**：{{一句话概括问题}}',
      '',
      '**环境**：{{OS / 版本 / 浏览器等}}',
      '',
      '**复现步骤**：',
      '1. {{步骤1}}',
      '2. {{步骤2}}',
      '3. {{步骤3}}',
      '',
      '**期望结果**：{{应该发生什么}}',
      '',
      '**实际结果**：{{实际发生什么}}',
      '',
      '**日志/截图**：{{粘贴报错或附图}}',
    ].join('\n'),
  },
  {
    id: 'daily_plan',
    label: '日计划 / TODO',
    keywords: [/日计划/, /今日计划/, /todo/i, /待办清单/, /日程/],
    render: () => [
      '# {{YYYY-MM-DD}} 计划',
      '',
      '## 必须完成（最多 3 件）',
      '- [ ] {{最重要的事}}',
      '- [ ] {{次重要}}',
      '- [ ] {{第三件}}',
      '',
      '## 其它',
      '- [ ] {{事项}}',
      '',
      '## 时间块',
      '- {{上午：任务}}',
      '- {{下午：任务}}',
      '',
      '## 复盘',
      '- 完成：{{}}  未完成原因：{{}}',
    ].join('\n'),
  },
];

/**
 * 检测查询是否在请求某个模板。需同时满足：① 命中「要模板」意图词；② 命中某模板主题词。
 * 这样「写周报」（无“模板”字样）不会误触发，而「周报模板/周报怎么写」会。
 * @returns {string|null} 模板 id
 */
function detectTemplate(query) {
  if (!_enabled()) return null;
  const q = String(query || '');
  if (q.length < 2) return null;
  const wantsTemplate = _WANT_TEMPLATE_RE.test(q);
  const wantsWrite = _WRITE_VERB_RE.test(q);
  for (const tpl of TEMPLATES) {
    const topicHit = tpl.keywords.some(re => re.test(q));
    if (!topicHit) continue;
    // 主题词命中，且用户明确「要模板」或「写一份…」→ 命中模板骨架。
    if (wantsTemplate || wantsWrite) return tpl.id;
  }
  return null;
}

function renderTemplate(id) {
  const tpl = TEMPLATES.find(t => t.id === id);
  if (!tpl) return null;
  const body = tpl.render();
  return [
    `已为你生成「${tpl.label}」模板（本地 · 无模型）。把 {{...}} 占位符替换成实际内容即可：`,
    '',
    body,
    '',
    '（提示：配置 AI 模型后，可直接让 khy 按你的具体信息填好整篇。）',
  ].join('\n');
}

function listTemplates() {
  return TEMPLATES.map(t => ({ id: t.id, label: t.label }));
}

/** 检测 + 渲染一步到位。未命中返回 null。 */
function tryTemplate(query) {
  const id = detectTemplate(query);
  if (!id) return null;
  return renderTemplate(id);
}

module.exports = {
  detectTemplate,
  renderTemplate,
  listTemplates,
  tryTemplate,
  TEMPLATES,
};
