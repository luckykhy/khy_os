/**
 * Self-Optimizer — safe AI self-improvement engine.
 *
 * Design principle: "Config hot-update, code cold-update"
 *
 * HOT-UPDATE (safe, no restart needed):
 *   ~/.khyquant/system_prompt.txt     — system prompt tuning
 *   ~/.khyquant/agent_roles.json      — agent role definitions
 *   ~/.khyquant/prompt_library.json   — curated prompt templates
 *   ~/.khyquant/learned_patterns.json — extracted patterns from transcripts
 *   ~/.khyquant/tool_permissions.json — tool trust levels
 *
 * COLD-UPDATE (requires git branch + user approval + restart):
 *   Any .js/.ts/.vue file in project source tree
 *
 * Transcript Learning:
 *   Reads Claude Code JSONL transcripts, extracts:
 *   - Successful tool call patterns (what tools, in what order)
 *   - Effective system prompts / instructions
 *   - Error recovery strategies
 *   - User preference signals (corrections, confirmations)
 *   Writes extracted wisdom to learned_patterns.json
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.khyquant');
const PATTERNS_FILE = path.join(CONFIG_DIR, 'learned_patterns.json');
const PROMPT_FILE = path.join(CONFIG_DIR, 'system_prompt.txt');
const ROLES_FILE = path.join(CONFIG_DIR, 'agent_roles.json');
const PROMPT_LIB_FILE = path.join(CONFIG_DIR, 'prompt_library.json');
const OPTIMIZATION_LOG = path.join(CONFIG_DIR, 'optimization_log.json');

// ── Source code protection ───────────────────────────────────────────
// khy OS core source directories that AI tools must NOT read/modify.
// This prevents the AI from exposing or reverse-engineering obfuscated
// source code when distributed via pip or npm packages.

const KHY_INSTALL_ROOT = path.resolve(__dirname, '../..');

/**
 * Check if a file path is inside the khy OS source tree.
 * Protected paths include the backend/src and frontend/src directories
 * of the KHY installation itself (NOT the user's working directory).
 * @param {string} filePath — absolute path
 * @returns {boolean}
 */
function isProtectedPath(filePath) {
  const resolved = path.resolve(filePath);
  const protectedDirs = [
    path.join(KHY_INSTALL_ROOT, 'backend', 'src'),
    path.join(KHY_INSTALL_ROOT, 'frontend', 'src'),
    path.join(KHY_INSTALL_ROOT, 'khy_quant'),
    path.join(KHY_INSTALL_ROOT, 'packages'),
  ];

  for (const dir of protectedDirs) {
    if (resolved.startsWith(dir + path.sep) || resolved === dir) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a path is the user's working directory (allowed).
 * User's CWD files are always accessible.
 * @param {string} filePath
 * @returns {boolean}
 */
function isUserPath(filePath) {
  const resolved = path.resolve(filePath);
  const userCwd = process.env.KHYQUANT_CWD || process.cwd();
  // Allow access if path is inside user's CWD and NOT inside KHY install
  return resolved.startsWith(userCwd + path.sep) && !isProtectedPath(resolved);
}

// Files that are safe to hot-update (no restart needed)
const SAFE_CONFIG_FILES = new Set([
  'system_prompt.txt',
  'agent_roles.json',
  'prompt_library.json',
  'learned_patterns.json',
  'tool_permissions.json',
  'skill_registry.json',
]);

// Maximum sizes to prevent runaway writes
const MAX_CONFIG_SIZE = 512 * 1024; // 512KB per config file
const MAX_PATTERNS = 200;
const MAX_OPTIMIZATION_LOG = 100;

/**
 * Ensure config directory exists.
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// ── Safe config write ────────────────────────────────────────────────

/**
 * Safely write a config file with backup and size guard.
 * @param {string} filename — basename (e.g. 'system_prompt.txt')
 * @param {string|object} content — string or JSON-serializable object
 * @returns {{ success: boolean, path: string, backup?: string, error?: string }}
 */
function safeWriteConfig(filename, content) {
  if (!SAFE_CONFIG_FILES.has(filename)) {
    return { success: false, error: `"${filename}" is not in the safe config whitelist` };
  }

  ensureConfigDir();
  const filePath = path.join(CONFIG_DIR, filename);
  const serialized = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

  // Size guard
  if (Buffer.byteLength(serialized, 'utf-8') > MAX_CONFIG_SIZE) {
    return { success: false, error: `Content exceeds maximum size (${MAX_CONFIG_SIZE / 1024}KB)` };
  }

  // Backup existing file
  let backup = null;
  try {
    if (fs.existsSync(filePath)) {
      backup = filePath + '.bak';
      fs.copyFileSync(filePath, backup);
    }
  } catch { /* best effort */ }

  // Validate JSON if applicable
  if (filename.endsWith('.json') && typeof content === 'string') {
    try { JSON.parse(content); } catch (e) {
      return { success: false, error: `Invalid JSON: ${e.message}` };
    }
  }

  try {
    fs.writeFileSync(filePath, serialized, 'utf-8');
    logOptimization('config_write', filename, { size: serialized.length });
    return { success: true, path: filePath, backup };
  } catch (e) {
    // Attempt restore from backup
    if (backup && fs.existsSync(backup)) {
      try { fs.copyFileSync(backup, filePath); } catch {}
    }
    return { success: false, error: e.message };
  }
}

/**
 * Read a config file.
 * @param {string} filename
 * @returns {string|null}
 */
function readConfig(filename) {
  const filePath = path.join(CONFIG_DIR, filename);
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
  } catch {}
  return null;
}

/**
 * Rollback a config file from its .bak backup.
 * @param {string} filename
 * @returns {boolean}
 */
function rollbackConfig(filename) {
  const filePath = path.join(CONFIG_DIR, filename);
  const backup = filePath + '.bak';
  try {
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, filePath);
      logOptimization('config_rollback', filename);
      return true;
    }
  } catch {}
  return false;
}

// ── Source code change (cold-update via git) ─────────────────────────

/**
 * Apply a source code change safely via git branch.
 * Does NOT modify the running code — creates a branch for user review.
 * @param {string} filePath — absolute path to source file
 * @param {string} newContent — proposed new content
 * @param {string} description — what was changed and why
 * @returns {{ success: boolean, branch?: string, error?: string }}
 */
function proposeCodeChange(filePath, newContent, description) {
  // Block changes to khy OS protected source
  if (isProtectedPath(filePath)) {
    return { success: false, error: 'Cannot modify khy OS core source code. Only user project files can be changed.' };
  }

  const { execSync } = require('child_process');
  const cwd = process.env.KHYQUANT_CWD || process.cwd();

  try {
    // Check if in a git repo
    execSync('git rev-parse --is-inside-work-tree', { cwd, timeout: 3000, stdio: 'pipe' });
  } catch {
    return { success: false, error: 'Not a git repository — cannot propose code changes safely' };
  }

  const branchName = `ai-optimize/${Date.now()}`;
  try {
    // Get current branch
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd, timeout: 3000, encoding: 'utf-8',
    }).trim();

    // Stash any uncommitted changes
    const hasChanges = execSync('git status --porcelain', {
      cwd, timeout: 3000, encoding: 'utf-8',
    }).trim().length > 0;

    if (hasChanges) {
      execSync('git stash push -m "auto-stash before AI optimization"', {
        cwd, timeout: 5000, stdio: 'pipe',
      });
    }

    // Create optimization branch
    execSync(`git checkout -b ${branchName}`, { cwd, timeout: 3000, stdio: 'pipe' });

    // Apply change
    fs.writeFileSync(filePath, newContent, 'utf-8');

    // Commit
    const relPath = path.relative(cwd, filePath);
    execSync(`git add "${relPath}"`, { cwd, timeout: 3000, stdio: 'pipe' });
    execSync(`git commit -m "ai-optimize: ${description.slice(0, 60)}"`, {
      cwd, timeout: 5000, stdio: 'pipe',
    });

    // Return to original branch
    execSync(`git checkout ${currentBranch}`, { cwd, timeout: 3000, stdio: 'pipe' });

    // Restore stash if we stashed
    if (hasChanges) {
      try { execSync('git stash pop', { cwd, timeout: 5000, stdio: 'pipe' }); } catch {}
    }

    logOptimization('code_proposal', relPath, { branch: branchName, description });

    return {
      success: true,
      branch: branchName,
      file: relPath,
      description,
      instruction: `git merge ${branchName}`,
    };
  } catch (e) {
    // Try to recover to original state
    try {
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd, timeout: 3000, encoding: 'utf-8',
      }).trim();
      if (currentBranch === branchName) {
        execSync('git checkout -', { cwd, timeout: 3000, stdio: 'pipe' });
        execSync(`git branch -D ${branchName}`, { cwd, timeout: 3000, stdio: 'pipe' });
      }
    } catch { /* give up */ }
    return { success: false, error: e.message };
  }
}

// ── Claude transcript learning ───────────────────────────────────────

/**
 * Parse a Claude Code JSONL transcript file and extract learning patterns.
 * @param {string} filePath — path to .jsonl transcript
 * @returns {{ patterns: object[], stats: object }}
 */
function parseTranscript(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  const stats = {
    totalMessages: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    errors: 0,
    corrections: 0,
    confirmations: 0,
  };

  const patterns = [];
  const toolSequences = [];
  let currentToolSeq = [];
  let lastAssistantMsg = '';

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    stats.totalMessages++;

    const role = entry.role || entry.type || '';
    const content = entry.content || entry.message || entry.text || '';
    const contentStr = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(c => c.text || '').join(' ')
      : JSON.stringify(content);

    // Count message types
    if (role === 'human' || role === 'user') {
      stats.userMessages++;

      // Detect corrections (user disagreed with AI)
      if (/不对|不是|错了|wrong|no[,.\s]|stop|别|不要|重新/.test(contentStr)) {
        stats.corrections++;
        patterns.push({
          type: 'correction',
          trigger: contentStr.slice(0, 200),
          context: lastAssistantMsg.slice(0, 200),
          lesson: `User corrected AI after: "${lastAssistantMsg.slice(0, 80)}"`,
        });
      }

      // Detect confirmations
      if (/好的|对|是的|yes|exactly|perfect|正确|没错|继续/.test(contentStr) && contentStr.length < 50) {
        stats.confirmations++;
        if (lastAssistantMsg) {
          patterns.push({
            type: 'confirmation',
            approach: lastAssistantMsg.slice(0, 200),
            lesson: 'User confirmed this approach works well',
          });
        }
      }

      // End current tool sequence
      if (currentToolSeq.length > 1) {
        toolSequences.push([...currentToolSeq]);
      }
      currentToolSeq = [];
    }

    if (role === 'assistant') {
      stats.assistantMessages++;
      lastAssistantMsg = contentStr;

      // Extract tool usage patterns
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            stats.toolCalls++;
            currentToolSeq.push({
              tool: block.name,
              input: typeof block.input === 'string' ? block.input.slice(0, 100)
                : JSON.stringify(block.input || {}).slice(0, 100),
            });
          }
        }
      }

      // Extract tool_call tags
      const toolCallMatches = contentStr.match(/<tool_call>[\s\S]*?<\/tool_call>/g);
      if (toolCallMatches) {
        stats.toolCalls += toolCallMatches.length;
        for (const tc of toolCallMatches) {
          const match = tc.match(/<tool_call>([\w]+)\((.*?)\)<\/tool_call>/);
          if (match) currentToolSeq.push({ tool: match[1], input: match[2].slice(0, 100) });
        }
      }
    }

    // Detect errors in tool results
    if (role === 'tool' || role === 'tool_result') {
      const isError = entry.is_error === true ||
        /error|failed|exception|traceback/i.test(contentStr);
      if (isError) {
        stats.errors++;
        patterns.push({
          type: 'error_recovery',
          tool: entry.tool_use_id || 'unknown',
          error: contentStr.slice(0, 200),
          lesson: 'Tool call resulted in error — check approach',
        });
      }
    }
  }

  // Extract common tool sequences
  if (toolSequences.length > 0) {
    // Find repeated sequences (simplified: just record all sequences of length >= 2)
    const seqMap = {};
    for (const seq of toolSequences) {
      const key = seq.map(s => s.tool).join(' → ');
      seqMap[key] = (seqMap[key] || 0) + 1;
    }
    for (const [seq, count] of Object.entries(seqMap)) {
      if (count >= 2) {
        patterns.push({
          type: 'tool_sequence',
          sequence: seq,
          count,
          lesson: `Common workflow: ${seq} (used ${count} times)`,
        });
      }
    }
  }

  return { patterns, stats };
}

/**
 * Learn from a Claude transcript and save patterns.
 * @param {string} filePath — path to .jsonl file
 * @returns {{ success: boolean, stats: object, patternsAdded: number }}
 */
function learnFromTranscript(filePath) {
  const { patterns, stats } = parseTranscript(filePath);

  // Load existing patterns
  let existing = [];
  try {
    if (fs.existsSync(PATTERNS_FILE)) {
      existing = JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf-8'));
    }
  } catch {}

  // Merge new patterns (avoid exact duplicates)
  const existingLessons = new Set(existing.map(p => p.lesson));
  let added = 0;
  for (const p of patterns) {
    if (!existingLessons.has(p.lesson)) {
      existing.push({ ...p, learnedAt: new Date().toISOString(), source: path.basename(filePath) });
      existingLessons.add(p.lesson);
      added++;
    }
  }

  // Cap total patterns
  while (existing.length > MAX_PATTERNS) existing.shift();

  // Save
  const result = safeWriteConfig('learned_patterns.json', existing);
  if (!result.success) {
    return { success: false, stats, patternsAdded: 0, error: result.error };
  }

  logOptimization('transcript_learn', path.basename(filePath), { stats, patternsAdded: added });

  return { success: true, stats, patternsAdded: added };
}

// ── AI-driven self-optimization ──────────────────────────────────────

/**
 * Generate an optimization proposal based on learned patterns.
 * Returns a prompt supplement that the AI can use to improve itself.
 * @returns {string} — additional system prompt content from learned patterns
 */
function getLearnedContext() {
  let context = '';

  // Load learned patterns
  try {
    if (fs.existsSync(PATTERNS_FILE)) {
      const patterns = JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf-8'));
      if (patterns.length > 0) {
        context += '\n\n[从历史对话中学到的经验]\n';

        // Group by type
        const corrections = patterns.filter(p => p.type === 'correction').slice(-5);
        const workflows = patterns.filter(p => p.type === 'tool_sequence').slice(-5);
        const confirmations = patterns.filter(p => p.type === 'confirmation').slice(-3);

        if (corrections.length > 0) {
          context += '避免的错误:\n';
          for (const c of corrections) {
            context += `- ${c.lesson}\n`;
          }
        }
        if (workflows.length > 0) {
          context += '有效的工作流:\n';
          for (const w of workflows) {
            context += `- ${w.lesson}\n`;
          }
        }
        if (confirmations.length > 0) {
          context += '用户认可的做法:\n';
          for (const c of confirmations) {
            context += `- ${c.lesson}\n`;
          }
        }
      }
    }
  } catch { /* best effort */ }

  // Load prompt library
  try {
    if (fs.existsSync(PROMPT_LIB_FILE)) {
      const lib = JSON.parse(fs.readFileSync(PROMPT_LIB_FILE, 'utf-8'));
      if (lib.instructions && lib.instructions.length > 0) {
        context += '\n[用户自定义指令]\n';
        for (const inst of lib.instructions.slice(-10)) {
          context += `- ${inst}\n`;
        }
      }
    }
  } catch { /* best effort */ }

  return context;
}

/**
 * Apply an AI-generated optimization to config.
 * The AI calls this with a target config and proposed changes.
 * @param {'system_prompt'|'agent_roles'|'prompt_library'} target
 * @param {string|object} content — new content
 * @param {string} reason — why this optimization
 * @returns {{ success: boolean, error?: string }}
 */
function applyOptimization(target, content, reason) {
  const fileMap = {
    system_prompt: 'system_prompt.txt',
    agent_roles: 'agent_roles.json',
    prompt_library: 'prompt_library.json',
    learned_patterns: 'learned_patterns.json',
  };

  const filename = fileMap[target];
  if (!filename) {
    return { success: false, error: `Unknown target: ${target}. Allowed: ${Object.keys(fileMap).join(', ')}` };
  }

  const result = safeWriteConfig(filename, content);
  if (result.success) {
    logOptimization('ai_optimize', target, { reason });
  }
  return result;
}

// ── Optimization log ─────────────────────────────────────────────────

/**
 * Log an optimization event.
 */
function logOptimization(action, target, details = {}) {
  ensureConfigDir();
  let log = [];
  try {
    if (fs.existsSync(OPTIMIZATION_LOG)) {
      log = JSON.parse(fs.readFileSync(OPTIMIZATION_LOG, 'utf-8'));
    }
  } catch {}

  log.push({
    timestamp: new Date().toISOString(),
    action,
    target,
    ...details,
  });

  // Cap log size
  while (log.length > MAX_OPTIMIZATION_LOG) log.shift();

  try {
    fs.writeFileSync(OPTIMIZATION_LOG, JSON.stringify(log, null, 2), 'utf-8');
  } catch {}
}

/**
 * Get optimization history.
 * @param {number} [limit=20]
 * @returns {Array}
 */
function getOptimizationHistory(limit = 20) {
  try {
    if (fs.existsSync(OPTIMIZATION_LOG)) {
      const log = JSON.parse(fs.readFileSync(OPTIMIZATION_LOG, 'utf-8'));
      return log.slice(-limit);
    }
  } catch {}
  return [];
}

/**
 * Get a summary of current learned state.
 * @returns {{ patterns: number, corrections: number, workflows: number, confirmations: number, lastOptimized: string|null }}
 */
function getLearningSummary() {
  const summary = {
    patterns: 0,
    corrections: 0,
    workflows: 0,
    confirmations: 0,
    errors: 0,
    lastOptimized: null,
    hasCustomPrompt: fs.existsSync(PROMPT_FILE),
    hasCustomRoles: fs.existsSync(ROLES_FILE),
    hasPromptLibrary: fs.existsSync(PROMPT_LIB_FILE),
  };

  try {
    if (fs.existsSync(PATTERNS_FILE)) {
      const patterns = JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf-8'));
      summary.patterns = patterns.length;
      summary.corrections = patterns.filter(p => p.type === 'correction').length;
      summary.workflows = patterns.filter(p => p.type === 'tool_sequence').length;
      summary.confirmations = patterns.filter(p => p.type === 'confirmation').length;
      summary.errors = patterns.filter(p => p.type === 'error_recovery').length;
    }
  } catch {}

  try {
    if (fs.existsSync(OPTIMIZATION_LOG)) {
      const log = JSON.parse(fs.readFileSync(OPTIMIZATION_LOG, 'utf-8'));
      if (log.length > 0) summary.lastOptimized = log[log.length - 1].timestamp;
    }
  } catch {}

  return summary;
}

module.exports = {
  // Config management
  safeWriteConfig,
  readConfig,
  rollbackConfig,
  SAFE_CONFIG_FILES,

  // Source code protection
  isProtectedPath,
  isUserPath,

  // Source code changes
  proposeCodeChange,

  // Transcript learning
  parseTranscript,
  learnFromTranscript,

  // Self-optimization
  getLearnedContext,
  applyOptimization,

  // History & summary
  getOptimizationHistory,
  getLearningSummary,
  logOptimization,
};
