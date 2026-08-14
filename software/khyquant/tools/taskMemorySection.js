'use strict';

/**
 * taskMemorySection — 主动召回「任务记忆」(Task Memory).
 *
 * 背景(goal 2026-07-03「永久/仓库/会话/任务记忆…仍然没有把握清楚主动写入与主动
 * 调用的时机,感觉 khy 特别健忘」):任务是用户点名的四类记忆里**唯一没有召回机制**
 * 的一类。任务写侧已完整——TaskCreate/TaskUpdate 把任务落进 largeTaskRuntimeStore
 * (JSON 持久化·跨轮/跨会话存活)。但读侧缺失:模型只有显式调用 `TaskList` 工具时
 * 才看得到任务板,否则每一轮都「忘」了还有哪些未完成任务。这正是用户所说的任务记忆
 * 「没把握主动调用的时机」,与仓库记忆(项目 MEMORY.md 只写不读)同一缺陷类。
 *
 * 本叶子把当前**未完成**任务(pending / in_progress)每轮折进系统提示,与全局记忆
 * (getMemorySection→loadMemoryPrompt)、项目记忆(loadProjectMemoryPrompt)对称。
 *
 * 契约(与既有记忆召回叶子一致):
 *   ① 无未完成任务(空板 / 全部已完成)→ 返回 null,字节回退不花上下文;
 *   ② 门控 KHY_TASK_MEMORY_RECALL 默认开·关(0/false/off/no/disable/disabled)→ null;
 *   ③ 绝不抛(任务子系统不可用 / 坏数据 → 降级 null)。
 * 纯读·零副作用·不改任何任务状态。
 */

// 与其它记忆召回门控同款 falsy 词表(prompts.getMemorySection / memdir 一致)。
const _OFF = ['0', 'false', 'off', 'no', 'disable', 'disabled'];

// 单轮最多列出的未完成任务条数——防止任务板过大淹没上下文(超出用一行汇总提示)。
const MAX_OPEN_LISTED = 20;

/**
 * 召回门控是否开启(默认开)。抽出以便测试与复用。
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
function isTaskRecallEnabled(env = process.env) {
  const raw = env && env.KHY_TASK_MEMORY_RECALL;
  return !_OFF.includes(String(raw == null ? '' : raw).trim().toLowerCase());
}

/**
 * 构造「任务记忆」系统提示段:当前未完成任务板。无未完成任务或门控关 → null。
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string|null}
 */
function getTaskMemorySection(env = process.env) {
  if (!isTaskRecallEnabled(env)) return null;
  try {
    const store = require('./_taskStore');
    const all = store.list();
    if (!Array.isArray(all) || all.length === 0) return null;

    const open = all.filter((t) => t && (t.status === 'pending' || t.status === 'in_progress'));
    if (open.length === 0) return null;

    // in_progress 优先,其次 pending;各自按 createdAt 最旧优先(与 snapshot 的确定性排序一致)。
    const byCreated = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    const running = open.filter((t) => t.status === 'in_progress').sort(byCreated);
    const pending = open.filter((t) => t.status === 'pending').sort(byCreated);
    const ordered = running.concat(pending);
    const shown = ordered.slice(0, MAX_OPEN_LISTED);

    const completedIds = new Set(
      all.filter((t) => t && t.status === 'completed').map((t) => String(t.id)),
    );
    const completedCount = completedIds.size;

    let buildBlockedBySuffix;
    try {
      ({ buildBlockedBySuffix } = require('./taskBlockedBySuffix'));
    } catch {
      buildBlockedBySuffix = () => '';
    }

    const lines = shown.map((t) => {
      const icon = t.status === 'in_progress' ? '→' : '○';
      let blocked = '';
      try { blocked = buildBlockedBySuffix(t.blockedBy, completedIds, env) || ''; } catch { blocked = ''; }
      // in_progress 用现在进行时 activeForm("Fixing auth bug"),否则用 subject。
      const label = (t.status === 'in_progress' && t.activeForm)
        ? t.activeForm
        : (t.subject || '(untitled)');
      const desc = (t.status !== 'in_progress' && t.description)
        ? ` — ${String(t.description).slice(0, 80)}`
        : '';
      return `${icon} #${t.id} ${label}${blocked}${desc}`;
    });
    if (ordered.length > shown.length) {
      lines.push(`… +${ordered.length - shown.length} more open task(s)`);
    }

    const header = [
      '# 任务记忆 (Task Memory)',
      '',
      "Your **open** tasks on this workspace's task board (persisted across turns and sessions).",
      'Keep working toward them: mark a task in_progress when you start it and completed when done.',
      '`→` = in progress, `○` = pending. This is background context — the latest user instruction always wins.',
      '',
    ];
    const footer = completedCount > 0 ? ['', `(${completedCount} task(s) already completed.)`] : [];
    return header.concat(lines).concat(footer).join('\n');
  } catch {
    return null;
  }
}

module.exports = { getTaskMemorySection, isTaskRecallEnabled, MAX_OPEN_LISTED };
