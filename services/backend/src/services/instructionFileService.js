/**
 * Multi-level khy.md instruction file discovery and loading.
 *
 * Mirrors CLAUDE.md pattern — discovers instruction files
 * at four levels (global, project, rules, cwd) and merges them into a
 * single block for injection into the AI system prompt.
 *
 * Levels (all loaded, bottom-up):
 *   ~/.khyquant/khy.md (or KHY.md) → global user instructions
 *   <git-root>/khy.md (or KHY.md)  → project-level instructions
 *   <git-root>/.khy/rules/*.md     → rule files
 *   <cwd>/khy.md (or KHY.md)       → directory-level (when cwd ≠ git-root)
 *
 * Limits:
 *   - Single file: max 8000 chars (truncated with warning)
 *   - Total merged: max 24000 chars
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
// External-include detection (aligns CC ClaudeMdExternalIncludesDialog 背后逻辑):
// flags `@path` imports resolving OUTSIDE the repo/cwd trust boundary so
// loadInstructions can surface a security warning — display/awareness only, the
// allow/deny gate in resolveIncludes is untouched. Pure leaf (no fs).
const { detectExternalIncludes, buildExternalIncludeWarning } = require('./instructionExternalIncludes');

const MAX_FILE_CHARS = 8000;
const MAX_TOTAL_CHARS = 24000;
const FILENAMES = ['khy.md', 'KHY.md'];
const RULES_DIR = '.khy/rules';
const MAX_INCLUDE_DEPTH = 3;
const MAX_INCLUDE_FILES = 10;
// AGENTS.md (plural) is the established cross-tool convention and stays first so
// its discovery priority is unchanged. agent.md / AGENT.md (singular) are added so
// that content written to a singular agent.md (via SaveInstruction target='agent')
// is also discovered and injected. Plural-before-singular keeps legacy behaviour
// byte-identical when both exist.
const COMPAT_FILENAMES = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', 'agent.md', 'AGENT.md'];

// ── Helpers ─────────────────────────────────────────────────────────────

function findGitRoot(from) {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd: from,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

function readFileSafe(filePath, maxChars = MAX_FILE_CHARS) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;

    let content = fs.readFileSync(filePath, 'utf-8');
    let truncated = false;
    if (content.length > maxChars) {
      content = content.slice(0, maxChars);
      truncated = true;
    }
    return { content, truncated, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * Process @include directives in instruction file content.
 * Supports: @path/to/file.md (relative to the instruction file's directory)
 *
 * Recursion is bounded by MAX_INCLUDE_DEPTH and MAX_INCLUDE_FILES.
 *
 * @param {string} content - Raw content with possible @include directives
 * @param {string} baseDir - Directory of the file containing the directives
 * @param {number} [depth=0] - Current recursion depth
 * @param {Set<string>} [visited] - Already-included paths (cycle prevention)
 * @returns {string} Content with includes resolved
 */
function resolveIncludes(content, baseDir, depth = 0, visited = new Set()) {
  if (depth >= MAX_INCLUDE_DEPTH || visited.size >= MAX_INCLUDE_FILES) return content;

  // Match @path/to/file patterns on their own line
  return content.replace(/^@(\S+)\s*$/gm, (match, relPath) => {
    if (visited.size >= MAX_INCLUDE_FILES) return match;

    const absPath = path.resolve(baseDir, relPath);
    const resolved = path.resolve(absPath);

    // Security: don't allow includes outside the project tree
    // 门控 KHY_INCLUDE_BOUNDARY_ANCHOR(默认开):裸 startsWith 会把名字前缀相同的兄弟目录
    // (proj-evil vs proj)、另一用户 home(/home/user2 vs /home/user)误判「允许范围内」而内联其
    // 文件进系统提示词(@include 注入 / 机密内联);锚定分隔符边界收紧。门关/异常 → 回退 legacy。
    let _includeAllowed = resolved.startsWith(baseDir) || resolved.startsWith(os.homedir());
    try {
      const _a = require('./instructionIncludeBoundary').isIncludeAllowed(resolved, baseDir, os.homedir(), path.sep, process.env);
      if (_a !== null) _includeAllowed = _a;
    } catch { /* fail-soft → legacy naive startsWith */ }
    if (!_includeAllowed) {
      return `<!-- @include denied: ${relPath} (outside allowed scope) -->`;
    }

    if (visited.has(resolved)) {
      return `<!-- @include cycle: ${relPath} -->`;
    }

    const included = readFileSafe(resolved, MAX_FILE_CHARS);
    if (!included) {
      return `<!-- @include not found: ${relPath} -->`;
    }

    visited.add(resolved);
    // Recurse for nested includes
    return resolveIncludes(included.content, path.dirname(resolved), depth + 1, visited);
  });
}

/**
 * Discover rule files from .khy/rules/ directory (glob *.md).
 * Mirrors CLAUDE.md's .claude/rules/*.md convention.
 *
 * @param {string} projectRoot - Git root or cwd
 * @returns {Array<{ path: string, content: string, truncated: boolean, size: number }>}
 */
function discoverRuleFiles(projectRoot) {
  const rulesDir = path.join(projectRoot, RULES_DIR);
  const results = [];

  try {
    if (!fs.existsSync(rulesDir) || !fs.statSync(rulesDir).isDirectory()) return results;

    const files = fs.readdirSync(rulesDir)
      .filter(f => f.endsWith('.md'))
      .sort(); // Deterministic order

    for (const file of files) {
      const filePath = path.join(rulesDir, file);
      const entry = readFileSafe(filePath);
      if (entry) {
        results.push({
          path: filePath,
          content: entry.content,
          truncated: entry.truncated,
          size: entry.size,
        });
      }
    }
  } catch {
    // rules directory unreadable
  }

  return results;
}

// ── Core API ────────────────────────────────────────────────────────────

/**
 * Discover all khy.md files for the given working directory.
 * @param {string} [cwd] - defaults to process.cwd()
 * @returns {Array<{ path: string, content: string, level: string, truncated: boolean, size: number }>}
 */
/**
 * 在目录下搜索 FILENAMES 中第一个存在的文件。
 * @param {string} dir
 * @returns {{ path: string, file: { content: string, truncated: boolean, size: number } } | null}
 */
function findFirstInstructionFile(dir) {
  for (const filename of FILENAMES) {
    const filePath = path.join(dir, filename);
    const file = readFileSafe(filePath);
    if (file) return { path: filePath, file };
  }
  return null;
}

function discoverInstructionFiles(cwd) {
  cwd = cwd || process.cwd();
  const results = [];
  const seen = new Set();

  // 1. Global: ~/.khyquant/khy.md 或 KHY.md
  const globalHit = findFirstInstructionFile(path.join(os.homedir(), '.khyquant'));
  if (globalHit) {
    const content = resolveIncludes(globalHit.file.content, path.dirname(globalHit.path));
    results.push({
      path: globalHit.path,
      content,
      level: 'global',
      truncated: globalHit.file.truncated,
      size: globalHit.file.size,
    });
    seen.add(path.resolve(globalHit.path));
  }

  // 2. Project: <git-root>/khy.md 或 KHY.md
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    const projectHit = findFirstInstructionFile(gitRoot);
    if (projectHit) {
      const resolved = path.resolve(projectHit.path);
      if (!seen.has(resolved)) {
        const content = resolveIncludes(projectHit.file.content, path.dirname(projectHit.path));
        results.push({
          path: projectHit.path,
          content,
          level: 'project',
          truncated: projectHit.file.truncated,
          size: projectHit.file.size,
          externalIncludes: detectExternalIncludes(projectHit.file.content, path.dirname(projectHit.path), gitRoot),
        });
        seen.add(resolved);
      }
    }

    // 2b. Rules: <git-root>/.khy/rules/*.md
    const ruleFiles = discoverRuleFiles(gitRoot);
    for (const rf of ruleFiles) {
      const rfResolved = path.resolve(rf.path);
      if (!seen.has(rfResolved)) {
        const content = resolveIncludes(rf.content, path.dirname(rf.path));
        results.push({
          path: rf.path,
          content,
          level: 'rules',
          truncated: rf.truncated,
          size: rf.size,
          externalIncludes: detectExternalIncludes(rf.content, path.dirname(rf.path), gitRoot),
        });
        seen.add(rfResolved);
      }
    }
  }

  // 3. CWD: <cwd>/khy.md 或 KHY.md (only if different from git root)
  const cwdHit = findFirstInstructionFile(cwd);
  if (cwdHit) {
    const cwdResolved = path.resolve(cwdHit.path);
    if (!seen.has(cwdResolved)) {
      const content = resolveIncludes(cwdHit.file.content, path.dirname(cwdHit.path));
      results.push({
        path: cwdHit.path,
        content,
        level: 'directory',
        truncated: cwdHit.file.truncated,
        size: cwdHit.file.size,
        externalIncludes: detectExternalIncludes(cwdHit.file.content, path.dirname(cwdHit.path), cwd),
      });
    }
  }

  return results;
}

/**
 * Load and merge all khy.md instructions into a single string.
 * Suitable for direct injection into the AI system prompt.
 *
 * @param {string} [cwd]
 * @returns {string} merged instructions (empty string if none found)
 */
function loadInstructions(cwd) {
  const files = discoverInstructionFiles(cwd);
  if (files.length === 0) return '';

  const LEVEL_LABELS = {
    global: '全局指令',
    project: '项目指令',
    rules: '规则指令',
    directory: '目录指令',
  };

  const sections = [];
  let totalChars = 0;

  for (const file of files) {
    const label = LEVEL_LABELS[file.level] || file.level;
    const header = `[${label} - ${file.path}]`;
    let content = file.content;

    // Security scan: detect potential prompt injection patterns
    const scanResult = scanForPromptInjection(content);
    if (scanResult.length > 0) {
      const warnings = scanResult.map(s => s.pattern).join(', ');
      const warningLine = `⚠ [SECURITY] Potential prompt injection detected in ${file.path}: ${warnings}`;
      // Strip dangerous lines but keep the rest
      for (const match of scanResult) {
        if (match.line !== undefined) {
          const lines = content.split('\n');
          lines[match.line] = `[REDACTED: ${match.pattern}]`;
          content = lines.join('\n');
        }
      }
      sections.push(warningLine);
    }

    // External-include security notice (aligns CC ClaudeMdExternalIncludesDialog):
    // if this file's `@path` imports resolve OUTSIDE the repo/cwd trust boundary,
    // surface a one-line warning next to the injection notice. Detection is gated
    // (KHY_EXTERNAL_INCLUDE_WARNING, default on) inside detectExternalIncludes →
    // empty array when off, so no line is appended (byte-identical fallback). This
    // only WARNS — resolveIncludes already made the allow/deny decision; we never
    // alter it here (read/awareness only, security control flow untouched).
    const extWarn = buildExternalIncludeWarning(file.path, file.externalIncludes);
    if (extWarn) {
      sections.push(extWarn);
    }

    // Enforce total limit
    const remaining = MAX_TOTAL_CHARS - totalChars - header.length - 2;
    if (remaining <= 0) break;
    if (content.length > remaining) {
      content = content.slice(0, remaining);
    }

    const section = `${header}\n${content}`;
    sections.push(section);
    totalChars += section.length;

    if (totalChars >= MAX_TOTAL_CHARS) break;
  }

  return sections.join('\n\n');
}

// ── Prompt Injection Detection ─────────────────────────────────────

/**
 * Scan text for common prompt injection patterns.
 * Returns array of matches with pattern name and line number.
 *
 * Patterns detected:
 * - Role override attempts ("you are now", "act as", "new system prompt")
 * - Instruction override ("ignore previous", "disregard above", "forget instructions")
 * - System prompt escape ("</system>", "[SYSTEM]:", "<<SYS>>")
 * - Hidden instructions (base64 encoded commands, zero-width chars)
 * - Privilege escalation ("admin mode", "developer mode", "jailbreak")
 *
 * @param {string} text
 * @returns {Array<{pattern: string, line: number, snippet: string}>}
 */
const INJECTION_PATTERNS = [
  { name: 'instruction_override', regex: /(?:^|\n)\s*(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|above|prior|earlier|existing)\s+(?:instructions?|rules?|prompts?|guidelines?)/im },
  { name: 'role_hijack', regex: /(?:^|\n)\s*(?:you are now|from now on you are|act as|pretend (?:to be|you are)|assume the role of|new system prompt|your new (?:role|instructions?|prompt))/im },
  { name: 'system_escape', regex: /<\/system>|<<SYS>>|<\|im_start\|>system|\[SYSTEM\]\s*:|<\|system\|>/i },
  { name: 'base64_command', regex: /(?:execute|run|eval|decode)\s*(?:this\s+)?base64[:\s]+[A-Za-z0-9+/]{40,}={0,2}/i },
  { name: 'privilege_escalation', regex: /(?:^|\n)\s*(?:enable|activate|enter|switch to)\s+(?:admin|developer|debug|god|root|sudo|jailbreak|unrestricted)\s+mode/im },
  { name: 'output_suppression', regex: /(?:do not|don't|never)\s+(?:mention|reveal|disclose|show|output)\s+(?:this|these|the)\s+(?:instructions?|rules?|prompt|system)/im },
];

function scanForPromptInjection(text) {
  if (!text || typeof text !== 'string') return [];
  const results = [];
  const lines = text.split('\n');

  // Layer 1: Built-in patterns (6 patterns, fast)
  for (const { name, regex } of INJECTION_PATTERNS) {
    const match = regex.exec(text);
    if (match) {
      let charCount = 0;
      let lineNum = 0;
      for (let i = 0; i < lines.length; i++) {
        charCount += lines[i].length + 1;
        if (charCount > match.index) {
          lineNum = i;
          break;
        }
      }
      results.push({
        pattern: name,
        line: lineNum,
        snippet: match[0].trim().slice(0, 80),
      });
    }
  }

  // Layer 2: Delegate to securityGuardService for deeper analysis (30+ patterns)
  // Unified scanning pipeline — catches patterns the built-in set misses
  try {
    const secGuard = require('./securityGuardService');
    if (secGuard && typeof secGuard.analyzeInput === 'function') {
      const analysis = secGuard.analyzeInput(text);
      if (analysis && !analysis.safe && analysis.severity !== 'LOW') {
        const existing = new Set(results.map(r => r.pattern));
        if (!existing.has(analysis.threat)) {
          results.push({
            pattern: `security_guard:${analysis.threat || 'unknown'}`,
            line: 0,
            snippet: `[${analysis.severity}] ${(analysis.refusal || '').slice(0, 60)}`,
          });
        }
      }
    }
  } catch { /* securityGuardService not available */ }

  return results;
}

/**
 * Get a summary of loaded instruction files (for /memory command).
 * @param {string} [cwd]
 * @returns {Array<{ path: string, level: string, size: number, truncated: boolean }>}
 */
function getInstructionSummary(cwd) {
  return discoverInstructionFiles(cwd).map(({ path: p, level, size, truncated }) => ({
    path: p,
    level,
    size,
    truncated,
  }));
}

function getCompatInstructionSummary(cwd) {
  cwd = cwd || process.cwd();
  const results = [];
  const seen = new Set();
  const homeDir = os.homedir();
  const searchDirs = [cwd];
  if (homeDir !== cwd) searchDirs.push(homeDir);

  for (const dir of searchDirs) {
    for (const filename of COMPAT_FILENAMES) {
      const filePath = path.join(dir, filename);
      const resolved = path.resolve(filePath);
      if (seen.has(resolved)) continue;
      const file = readFileSafe(filePath);
      if (!file) continue;
      seen.add(resolved);
      results.push({
        path: filePath,
        type: /agents?\.md$/i.test(filename) ? 'agents' : 'claude',
        size: file.size,
        truncated: file.truncated,
      });
    }
  }

  return results;
}

const QUICK_MEMORY_HEADING = '## Memories';

/**
 * Resolve the target instruction file for a quick-add memory.
 *   scope='project' (default) → existing khy.md under git-root (or cwd if no
 *                               git root), else <root>/khy.md to be created.
 *   scope='global'            → existing khy.md under ~/.khyquant, else create.
 * @returns {{ file: string, dir: string }}
 */
function _resolveQuickMemoryTarget(scope, cwd) {
  cwd = cwd || process.cwd();
  let dir;
  if (scope === 'global') {
    dir = path.join(os.homedir(), '.khyquant');
  } else {
    dir = findGitRoot(cwd) || cwd;
  }
  // Reuse an existing instruction file name if present, else default to khy.md.
  for (const name of FILENAMES) {
    if (fs.existsSync(path.join(dir, name))) return { file: path.join(dir, name), dir };
  }
  return { file: path.join(dir, FILENAMES[0]), dir };
}

// Singular agent.md family (target='agent'). Plural AGENTS.md is intentionally NOT
// a write target — it is the cross-tool shared file khy only reads; khy writes its
// own agent.md so it never clobbers a tool-ecosystem AGENTS.md.
const AGENT_FILENAMES = ['agent.md', 'AGENT.md'];

/**
 * Resolve the on-disk instruction file for a quick-add write, honoring the
 * `target` file family ('khy' → khy.md/KHY.md, 'agent' → agent.md/AGENT.md).
 * Mirrors _resolveQuickMemoryTarget's "reuse existing casing, else default"
 * behaviour so re-writes append to the same file the user already has.
 *
 * @param {'khy'|'agent'} target
 * @param {'project'|'global'} scope
 * @param {string} [cwd]
 * @returns {{ file: string, dir: string }}
 */
function _resolveInstructionTarget(target, scope, cwd) {
  if (target !== 'agent') return _resolveQuickMemoryTarget(scope, cwd);
  cwd = cwd || process.cwd();
  const dir = scope === 'global' ? path.join(os.homedir(), '.khyquant') : (findGitRoot(cwd) || cwd);
  for (const name of AGENT_FILENAMES) {
    if (fs.existsSync(path.join(dir, name))) return { file: path.join(dir, name), dir };
  }
  return { file: path.join(dir, AGENT_FILENAMES[0]), dir };
}

/**
 * Append a one-line memory to an instruction file — the user-driven counterpart
 * to the auto-memory pipeline, mirroring Claude Code's `#` quick-add. Because the
 * instruction file is ALWAYS injected into the system prompt, the note is first
 * screened for prompt-injection and rejected if it trips the scanner (we must not
 * let a stray `#` line plant attacker instructions into every future turn).
 *
 * The note is appended as a bullet under a `## Memories` section, created if
 * absent. The target file/dir is created on demand.
 *
 * @param {string} note - the memory text (already stripped of the leading `#`).
 * @param {object} [opts]
 * @param {'project'|'global'} [opts.scope='project']
 * @param {'khy'|'agent'} [opts.target='khy'] - target file family (agent → agent.md).
 * @param {string} [opts.cwd]
 * @param {Date} [opts.now] - injectable clock for deterministic tests.
 * @returns {{ success:boolean, file?:string, created?:boolean, note?:string, scope?:string, error?:string, threats?:Array }}
 */
function appendQuickMemory(note, opts = {}) {
  const text = String(note || '').trim();
  if (!text) return { success: false, error: '空记忆：# 后需跟随要记住的内容' };

  const scope = opts.scope === 'global' ? 'global' : 'project';
  const target = opts.target === 'agent' ? 'agent' : 'khy';

  const threats = scanForPromptInjection(text);
  if (threats.length > 0) {
    return {
      success: false,
      error: '记忆内容触发了提示注入检测，已拒绝写入（指令文件会注入到系统提示，必须保持可信）',
      threats,
    };
  }

  const { file, dir } = _resolveInstructionTarget(target, scope, opts.cwd);
  const stamp = (opts.now instanceof Date ? opts.now : new Date()).toISOString().slice(0, 10);
  const bullet = `- (${stamp}) ${text}`;

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const created = !fs.existsSync(file);
    let content = created ? '' : fs.readFileSync(file, 'utf-8');

    if (content.includes(QUICK_MEMORY_HEADING)) {
      // Insert the bullet at the end of the existing Memories section (right
      // before the next heading, or at EOF if it is the last section).
      const lines = content.split('\n');
      const headIdx = lines.findIndex((l) => l.trim() === QUICK_MEMORY_HEADING);
      let insertAt = lines.length;
      for (let i = headIdx + 1; i < lines.length; i++) {
        if (/^#{1,6}\s/.test(lines[i])) { insertAt = i; break; }
      }
      // Trim trailing blank lines inside the section so bullets stay contiguous.
      let end = insertAt;
      while (end > headIdx + 1 && lines[end - 1].trim() === '') end--;
      lines.splice(end, 0, bullet);
      content = lines.join('\n');
    } else {
      const sep = content && !content.endsWith('\n') ? '\n' : '';
      const lead = content ? `${sep}\n` : '';
      content = `${content}${lead}${QUICK_MEMORY_HEADING}\n\n${bullet}\n`;
    }

    fs.writeFileSync(file, content, 'utf-8');
    return { success: true, file, created, note: text, scope };
  } catch (err) {
    return { success: false, error: `写入失败: ${err.message}` };
  }
}

module.exports = {
  discoverInstructionFiles,
  findFirstInstructionFile,
  loadInstructions,
  appendQuickMemory,
  _resolveInstructionTarget,
  getInstructionSummary,
  getCompatInstructionSummary,
  resolveIncludes,
  discoverRuleFiles,
  scanForPromptInjection,
  FILENAMES,
  AGENT_FILENAMES,
  COMPAT_FILENAMES,
  MAX_FILE_CHARS,
  MAX_TOTAL_CHARS,
  MAX_INCLUDE_DEPTH,
  MAX_INCLUDE_FILES,
  RULES_DIR,
};
