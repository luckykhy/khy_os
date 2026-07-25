'use strict';

/**
 * projectMemoryContract.js — 纯叶子:为「项目级记忆目录」生成人类可读、可维护的 MEMORY.md 契约。
 *
 * 背景(诚实记录现状):
 *   - 全局/用户级记忆(getMemoryDir → <dataHome>/.khy/memory/)**有**一份被维护的 MEMORY.md 索引,
 *     由 loadMemoryPrompt/updateMemoryIndex 装配进系统提示。
 *   - 项目级记忆(getProjectMemoryDir → <dataHome>/projects/<sha256(root)>/memory/)是按项目根路径
 *     哈希出的目录,**从未**有一份被维护的 MEMORY.md 契约,也没有给人看的入口——这是本刀要补的缺口。
 *
 * 本叶子只产**文本契约**(确定性、零 IO):由 caller 注入 projectRoot/memoryDir;
 * 真正的写盘/读盘(seed 索引、统计条目)归 memdir.js 的 IO 壳。
 *
 * 门控 KHY_PROJECT_MEMORY 默认开;关 → isEnabled 返回 false,IO 壳据此跳过 seed(字节回退:不创建)。
 */

const FALSY = new Set(['0', 'false', 'off', 'no']);

/** 项目记忆功能门控(默认开;{0,false,off,no} 关闭)。 */
function isEnabled(env) {
  const e = env && typeof env === 'object' ? env : {};
  const raw = e.KHY_PROJECT_MEMORY;
  if (raw === undefined || raw === null || raw === '') return true;
  return !FALSY.has(String(raw).trim().toLowerCase());
}

/**
 * 生成项目级 MEMORY.md 的种子内容(可维护契约)。与全局记忆同构的四类型分类 + 维护规则,
 * 但明确声明「项目级、按项目根隔离」,并写清项目根与目录位置便于人类定位。
 *
 * @param {object} args
 * @param {string} [args.projectRoot]  项目根路径(展示用)
 * @param {string} [args.memoryDir]    本项目记忆目录绝对路径(展示用)
 * @returns {string} MEMORY.md 种子文本(以换行结尾)
 */
function buildProjectMemoryIndexContract(args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  const projectRoot = a.projectRoot ? String(a.projectRoot) : '(未知项目根)';
  const memoryDir = a.memoryDir ? String(a.memoryDir) : '(项目记忆目录)';
  const lines = [
    '# 项目记忆 (Project Memory)',
    '',
    '> 这是**项目级**记忆索引,仅作用于本项目(按项目根路径隔离),不与其他项目共享。',
    '> 全局/跨项目记忆另有其自己的 MEMORY.md(用户级记忆目录)。',
    '',
    `- 项目根:\`${projectRoot}\``,
    `- 记忆目录:\`${memoryDir}\``,
    '',
    '## 维护契约',
    '',
    '每条记忆是一个独立 `.md` 文件,带 YAML frontmatter;本文件是指向它们的**一行式索引**。',
    '保存分两步:',
    '',
    '**第一步** — 写一个带 frontmatter 的记忆文件:',
    '',
    '```markdown',
    '---',
    'name: {{记忆标题}}',
    'description: {{一行摘要,用于相关性匹配}}',
    'type: {{user, feedback, project, reference}}',
    '---',
    '',
    '{{记忆正文}}',
    '```',
    '',
    '**第二步** — 在本文件追加一行指针(每行 < ~150 字符):',
    '`- [标题](file.md) — 一行钩子`',
    '',
    '## 四种记忆类型',
    '',
    '- **user** — 用户的角色、目标、偏好、知识(决定如何为其定制行为)。',
    '- **feedback** — 关于「该怎么做事」的指导:纠正与确认都记;附上为什么。',
    '- **project** — 不可从代码推导的项目上下文:目标、决策、截止期(相对日期转绝对日期)。',
    '- **reference** — 外部系统指针(仪表盘、工单、文档、频道)。',
    '',
    '## 不该写进记忆的内容',
    '',
    '- 代码结构、约定、文件路径 — 可从代码库推导。',
    '- git 历史 / 谁改了什么 — git log / git blame 才是权威。',
    '- 调试解法、修复配方 — 修复在代码里,上下文在提交信息里。',
    '- 已写在 CLAUDE.md / khy.md 等指令文件里的内容。',
    '- 只与本次会话相关的临时状态。',
    '',
    '## 使用前先核实',
    '',
    '一条点名了具体文件/函数/开关的记忆,是「写下它的那一刻」的断言;',
    '推荐之前务必核实:文件还在吗、grep 得到那个函数吗、那个开关还有效吗。',
    '',
    '## 索引',
    '',
    '<!-- 在下面逐行追加指针,例如:- [标题](file.md) — 一行钩子 -->',
    '',
  ];
  return lines.join('\n');
}

/**
 * 从 MEMORY.md 原文统计「指针条目」行数(形如 `- [..](..)`)。纯函数,容错。
 * @param {string} raw
 * @returns {number}
 */
function countIndexEntries(raw) {
  if (typeof raw !== 'string' || !raw) return 0;
  let n = 0;
  for (const line of raw.split('\n')) {
    if (/^\s*-\s+\[[^\]]+\]\([^)]+\)/.test(line)) n += 1;
  }
  return n;
}

/** 人类可读摘要行(给 `khy memory project`)。 */
function summarizeProjectMemory(info = {}) {
  const i = info && typeof info === 'object' ? info : {};
  const exists = i.indexExists === true;
  const count = Number.isFinite(i.entryCount) ? i.entryCount : 0;
  return [
    `项目记忆目录:${i.memoryDir || '(未知)'}`,
    `MEMORY.md 契约:${exists ? `已就绪(${count} 条索引)` : '尚未创建'}`,
    `项目根:${i.projectRoot || '(未知)'}`,
  ];
}

module.exports = {
  isEnabled,
  buildProjectMemoryIndexContract,
  countIndexEntries,
  summarizeProjectMemory,
};
