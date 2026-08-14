'use strict';

/**
 * memoryKairos — long-term memory system inspired by Y-code's KAIROS.
 *
 * Provides a file-based persistent memory with:
 * - Daily logs: timestamped entries organized by year/month/date
 * - MEMORY.md index: lightweight index of consolidated memories
 * - build_memory_system_section(): generates the system prompt section that
 *   tells the LLM how to use the memory system
 * - dreamConsolidation(): background thread that consolidates daily logs
 *   into structured memory files via LLM
 *
 * Storage layout (portable-aware):
 *   <appHome>/memory/
 *     logs/
 *       YYYY/
 *         MM/
 *           YYYY-MM-DD.md    ← daily log
 *     MEMORY.md                ← index (links to memory files)
 *     user/                    ← user profile memories
 *     feedback/                ← user feedback/corrections
 *     project/                 ← ongoing project context
 *     reference/               ← external resource pointers
 *
 * @module memoryKairos
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Paths (portable-aware) ──

let MEMORY_DIR;

function getMemoryDir() {
  if (MEMORY_DIR) {
    return MEMORY_DIR;
  }
  try {
    const { getAppHome } = require('../utils/dataHome');
    MEMORY_DIR = path.join(getAppHome(), 'memory');
  } catch {
    MEMORY_DIR = path.join(os.homedir(), '.khyquant', 'memory');
  }
  return MEMORY_DIR;
}

// ── Thread Safety ──

let _memoryIoLock = false;

function withMemoryLock(fn) {
  // Simple spin-based lock for Node.js single-threaded event loop
  // In practice, file I/O in Node.js is serialized by the event loop,
  // so this only protects against the background dream consolidation
  // thread running in a Worker thread.
  if (_memoryIoLock) {
    // Already locked — wait and retry
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!_memoryIoLock) {
          _memoryIoLock = true;
          fn().then(resolve).catch(reject);
        } else {
          setTimeout(check, 50);
        }
      };
      setTimeout(check, 50);
    });
  }
  _memoryIoLock = true;
  return fn().finally(() => {
    _memoryIoLock = false;
  });
}

// ── Directory Setup ──

function ensureMemoryDir() {
  const dir = getMemoryDir();
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  for (const sub of ['user', 'feedback', 'project', 'reference']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
}

// ── Daily Log ──

/**
 * Get the path for today's daily log.
 */
function dailyLogPath(date) {
  date = date || new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(getMemoryDir(), 'logs', String(year), month, `${day}.md`);
}

/**
 * Append an entry to today's daily log.
 *
 * @param {string} entry - The memory entry text
 */
async function appendToDailyLog(entry) {
  await withMemoryLock(async () => {
    ensureMemoryDir();
    const logPath = dailyLogPath();
    const timestamp = new Date().toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const line = `- [${timestamp}] ${entry}\n`;
    fs.appendFileSync(logPath, line, 'utf-8');
  });
}

/**
 * Extract <memory>...</memory> tags from text.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractMemoryTags(text) {
  if (!text) {
    return [];
  }
  const matches = text.match(/<memory>([\s\S]*?)<\/memory>/g);
  if (!matches) {
    return [];
  }
  return matches.map((m) => m.replace(/<\/?memory>/g, '').trim()).filter(Boolean);
}

// ── Memory Index ──

/**
 * Load the MEMORY.md index file.
 *
 * @returns {string}
 */
function loadMemoryIndex() {
  const indexPath = path.join(getMemoryDir(), 'MEMORY.md');
  if (!fs.existsSync(indexPath)) {
    return '';
  }
  try {
    return fs.readFileSync(indexPath, 'utf-8').slice(0, 10_000);
  } catch {
    return '';
  }
}

/**
 * Append lines to the MEMORY.md index.
 *
 * @param {string[]} lines - Lines to append (without trailing newline)
 */
async function appendToMemoryIndex(lines) {
  await withMemoryLock(async () => {
    ensureMemoryDir();
    const indexPath = path.join(getMemoryDir(), 'MEMORY.md');
    const content = lines.map((l) => (l.endsWith('\n') ? l : l + '\n')).join('');
    fs.appendFileSync(indexPath, content, 'utf-8');
  });
}

/**
 * Validate a memory filename to prevent path traversal.
 *
 * @param {string} fname
 * @returns {boolean}
 */
function isSafeMemoryFilename(fname) {
  if (!fname || typeof fname !== 'string') {
    return false;
  }
  if (fname.includes('..')) {
    return false;
  }
  if (fname.includes('/') || fname.includes('\\')) {
    return false;
  }
  if (path.extname(fname) !== '.md') {
    return false;
  }
  // No drive letters or absolute paths
  if (path.isAbsolute(fname)) {
    return false;
  }
  return path.basename(fname) === fname;
}

// ── Atomic Write ──

/**
 * Atomic write: write to temp file then rename.
 * Caller should hold _memoryIoLock.
 *
 * @param {string} filePath
 * @param {string} content
 */
function atomicWriteText(filePath, content) {
  const tmpPath = filePath + `.${process.pid}.${threadId()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

function threadId() {
  const WorkerThreads = 'worker_threads' in process ? require('worker_threads') : null;
  return WorkerThreads && WorkerThreads.threadId ? WorkerThreads.threadId : 'main';
}

// ── Memory System Section (for system prompt) ──

/**
 * Build the memory system section that gets injected into the system prompt.
 * This tells the LLM how to use the file-based memory system.
 *
 * @returns {string}
 */
function buildMemorySystemSection() {
  ensureMemoryDir();
  const memoryDir = getMemoryDir();
  const index = loadMemoryIndex();

  let section = `# Auto Memory\n\n`;
  section += `You have a persistent, file-based memory system at \`${memoryDir}/\`.\n`;
  section += `This directory already exists — write to it directly.\n\n`;
  section += `You should build up this memory system over time so that future conversations `;
  section += `have a complete picture of who the user is, how they'd like to collaborate, `;
  section += `what behaviors to avoid or repeat, and the context behind the work given.\n\n`;
  section += `If the user explicitly asks you to remember something, save it immediately. `;
  section += `If they ask you to forget something, find and remove the relevant entry.\n\n`;
  section += `## Types of memory\n\n`;
  section += `### user\n`;
  section += `Information about the user's role, goals, responsibilities, and knowledge.\n`;
  section += `**When to save:** When you learn details about the user's role, preferences, responsibilities, or knowledge.\n\n`;
  section += `### feedback\n`;
  section += `Guidance or correction the user has given you.\n`;
  section += `**When to save:** Any time the user corrects your approach.\n`;
  section += `**Body structure:** Lead with the rule, then a **Why:** line and a **How to apply:** line.\n\n`;
  section += `### project\n`;
  section += `Information about ongoing work, goals, decisions, bugs, or incidents.\n`;
  section += `**When to save:** When you learn who is doing what, why, or by when.\n\n`;
  section += `### reference\n`;
  section += `Pointers to where information lives in external systems.\n`;
  section += `**When to save:** When you learn about resources and their purpose.\n\n`;
  section += `## How to save memories\n\n`;
  section += `**Option A — <memory> tags (quick notes):**\n`;
  section += `Wrap text in \`<memory>...</memory>\` tags in your response. These are automatically extracted.\n\n`;
  section += `**Option B — Write files directly (structured memories):**\n`;
  section += `Write a \`.md\` file to \`${memoryDir}/\` with frontmatter:\n`;
  section += `\`\`\`markdown\n`;
  section += `---\nname: memory name\ndescription: one-line description\ntype: user | feedback | project | reference\n---\n\n`;
  section += `memory content\n`;
  section += `\`\`\`\n\n`;
  section += `Then add a pointer to that file in \`${memoryDir}/MEMORY.md\`.\n`;
  section += `MEMORY.md is an index, not a memory — it should contain only links with brief descriptions.\n`;

  if (index) {
    section += `\n## Current Memory Index (MEMORY.md)\n${index}\n`;
  } else {
    section += `\nNo memories consolidated yet.\n`;
  }

  return section;
}

// ── Dream Consolidation ──

/**
 * Run dream consolidation: gather recent daily logs + MEMORY.md index,
 * use an LLM to generate memory consolidation actions, apply them.
 *
 * @param {object} apiCaller - Object with a callLLM(messages) method
 * @param {number} [logCount=5] - Number of recent log files to process
 * @returns {{ actions: number, summary: string }}
 */
async function runDreamConsolidation(apiCaller, logCount = 5) {
  await withMemoryLock(async () => {
    ensureMemoryDir();
    const index = loadMemoryIndex();

    // Collect recent log files
    const logsDir = path.join(getMemoryDir(), 'logs');
    let logFiles = [];
    if (fs.existsSync(logsDir)) {
      logFiles = fs
        .readdirSync(logsDir, { recursive: true })
        .filter((f) => f.endsWith('.md'))
        .map((f) => path.join(logsDir, f));
      logFiles.sort();
      logFiles = logFiles.slice(-logCount);
    }

    // Read log contents
    let logContent = '';
    for (const f of logFiles) {
      try {
        logContent += `\n### File: ${path.basename(f)}\n` + fs.readFileSync(f, 'utf-8');
      } catch {
        /* skip unreadable */
      }
    }

    if (!logContent.trim() && !index) {
      return { actions: 0, summary: '没有可整理的记忆内容。' };
    }

    const memoryDir = getMemoryDir();
    const prompt = `你正在为 Khyos 整理长期记忆文件。你的任务是将最近的每日日志中的新事实、反馈和规则整理进分类记忆文件中，并更新索引 MEMORY.md。

记忆目录路径: \`${memoryDir}/\`

已有的记忆索引 (MEMORY.md) 内容:
${index || '(空)'}

最近的每日日志内容:
${logContent}

请结合已有索引和最近日志：
1. 提炼出需要新创建或更新的长期记忆（类型：user, feedback, project, reference）
2. 给出具体的合并与修改指令。输出合法的 JSON 数组，格式：
[
  {
    "action": "create_or_update",
    "filename": "feedback_rules.md",
    "content": "---\\nname: ...\\ndescription: ...\\ntype: feedback\\n---\\n\\n..."
  },
  {
    "action": "update_index",
    "content": "- [memory name](filename.md) — description"
  }
]

注意：
- 转换相对日期为绝对日期
- MEMORY.md 是索引文件：只允许走 update_index 追加，禁止 create_or_update 覆写
- 拒绝非法文件名（路径穿越风险）
- 保持极其精简，去粗取精
- 直接输出 JSON 数组，不要带包裹`;

    let actionsApplied = 0;
    const summaryLines = [];

    try {
      const response = await apiCaller.callLLM([{ role: 'user', content: prompt }], {
        temperature: 0.3,
        maxTokens: 2000,
      });

      const reply = response.content || response.text || '';
      const jsonMatch = reply.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return { actions: 0, summary: 'LLM 返回格式无法解析。' };
      }

      const actions = JSON.parse(jsonMatch[0]);
      const indexLines = [];

      for (const act of actions) {
        const actionType = act.action;
        if (actionType === 'create_or_update') {
          const fname = act.filename;
          const content = act.content;
          if (!fname || !content) {
            continue;
          }

          // Reject direct overwrite of MEMORY.md
          if (fname.trim().toLowerCase() === 'memory.md') {
            summaryLines.push('拒绝直接覆写索引文件 MEMORY.md');
            continue;
          }

          // Validate filename
          if (!isSafeMemoryFilename(fname)) {
            summaryLines.push(`拒绝非法记忆文件名: ${fname}`);
            continue;
          }

          const fpath = path.join(memoryDir, fname);
          atomicWriteText(fpath, content);
          summaryLines.push(`创建/更新记忆文件: ${fname}`);
          actionsApplied++;
        } else if (actionType === 'update_index') {
          const idxContent = act.content;
          if (idxContent) {
            indexLines.push(idxContent);
            actionsApplied++;
          }
        }
      }

      // Append index lines atomically
      if (indexLines.length > 0) {
        await appendToMemoryIndex(indexLines);
        summaryLines.push(`更新索引: ${indexLines.length} 条`);
      }
    } catch (err) {
      summaryLines.push(`整理过程出错: ${err.message}`);
    }

    return {
      actions: actionsApplied,
      summary: summaryLines.join('\n') || '无变化',
    };
  });
}

// ── Public API ──

module.exports = {
  getMemoryDir,
  ensureMemoryDir,
  dailyLogPath,
  appendToDailyLog,
  extractMemoryTags,
  loadMemoryIndex,
  appendToMemoryIndex,
  isSafeMemoryFilename,
  buildMemorySystemSection,
  runDreamConsolidation,
  withMemoryLock,
};
