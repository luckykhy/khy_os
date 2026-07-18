'use strict';

/**
 * agentFsService.js — AgentFS: file-driven, git-versioned, layered per-agent storage.
 *
 * Borrowed from DesireCore's AgentFS (借鉴分析 #1). Khy-OS already stores persona,
 * memory, skills and custom agents as files, but scattered and global. AgentFS
 * consolidates one *agent* into a single directory that is its own git repository,
 * and adds L0/L1/L2 layered loading so long-lived agent state need not all be paid
 * for in the context window.
 *
 * Layout (under `<dataHome>/agents/<id>/`):
 *   agent.json          metadata {id,name,description,model,schema,version,createdAt}
 *   persona.md          who the agent is (seeded from personaService.defaultTemplate)
 *   principles.md       red lines / non-negotiables (never auto-overwritten)
 *   memory/MEMORY.md    memory index (memdir convention)
 *   skills/             per-agent skills (manifest.json + prompt.md convention)
 *   workflows/          SOP placeholder
 *   tools/permissions.json  per-agent allow/ask/deny placeholder (not yet enforced)
 *   heartbeat/HEARTBEAT.md  DesireCore-style heartbeat checklist template
 *   .git/               each agent is an independent git repo
 *
 * Versioning is best-effort: when git is absent the store still reads/writes, it
 * just skips snapshots (warned once). No new dependencies — Node built-ins only.
 *
 * Scope (first cut): storage substrate + CLI. This module is NOT wired into the
 * live system prompt / chat pipeline yet — that is a deliberate Phase 2.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getDataHome } = require('../../utils/dataHome');

const SCHEMA_VERSION = 1;

// Asset relative paths that scaffold writes (used by listing/verification too).
const ASSET_FILES = Object.freeze({
  manifest: 'agent.json',
  persona: 'persona.md',
  principles: 'principles.md',
  memoryIndex: path.join('memory', 'MEMORY.md'),
  permissions: path.join('tools', 'permissions.json'),
  heartbeat: path.join('heartbeat', 'HEARTBEAT.md'),
});

const SCAFFOLD_DIRS = Object.freeze(['memory', 'skills', 'workflows', 'tools', 'heartbeat']);

// ── Five-asset model (借鉴分析 #2, from DesireCore) ───────────────────────────
// One companion = five independently-governable assets. This is the single
// source of truth that maps DesireCore's taxonomy onto AgentFS layout. `dirs`
// are scanned for arbitrary files; `files` are fixed single-file assets.
const ASSET_MODEL = Object.freeze([
  Object.freeze({ key: 'persona',  label: 'Persona（人格）',     files: ['persona.md', 'principles.md'], dirs: [] }),
  Object.freeze({ key: 'playbook', label: 'Playbook（行为手册）', files: [], dirs: ['workflows'] }),
  Object.freeze({ key: 'memory',   label: 'Memory（记忆账本）',   files: [], dirs: ['memory'] }),
  Object.freeze({ key: 'toolBody', label: 'Tool Body（工具身体）', files: [path.join('tools', 'permissions.json')], dirs: ['skills'] }),
  Object.freeze({ key: 'receipts', label: 'Receipts（行动回执）', files: [], dirs: [], external: 'receipts' }),
]);

// Valid agent id: lowercase slug, 1–64 chars, starts alphanumeric.
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

let _gitMissingWarned = false;

// ─────────────────────────────────────────────────────────────────────────────
// Paths & validation
// ─────────────────────────────────────────────────────────────────────────────

/** Root that holds every agent directory: `<dataHome>/agents`. */
function getAgentsRoot() {
  return path.join(getDataHome(), 'agents');
}

/**
 * Resolve an agent's directory, validating the id and guarding against path
 * traversal. Throws on an invalid id or any path that escapes the agents root.
 * @param {string} id
 * @returns {string} absolute agent directory
 */
function _agentDir(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new Error(`非法的 agent id: ${JSON.stringify(id)}（要求小写字母/数字/-/_，1–64 位，且不以 -/_ 开头）`);
  }
  const root = getAgentsRoot();
  const dir = path.resolve(root, id);
  // Defence in depth: even a regex-valid id must stay inside root.
  if (dir !== path.join(root, id) || !(dir + path.sep).startsWith(root + path.sep)) {
    throw new Error(`路径穿越被拒绝: ${id}`);
  }
  return dir;
}

/**
 * Slugify a display name into a candidate id. Non-ASCII (e.g. Chinese) names
 * collapse to empty, in which case the caller must supply an explicit id.
 * @param {string} name
 * @returns {string}
 */
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64);
}

// ─────────────────────────────────────────────────────────────────────────────
// git plumbing (best-effort; mirrors checkpointService's execFileSync pattern)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a git command inside `dir`. Returns {ok, stdout} or, when git is missing,
 * {gitless:true}. Never throws on ENOENT; other git failures return {ok:false}.
 * @param {string} dir
 * @param {string[]} args
 * @returns {{ok:boolean, stdout?:string, gitless?:boolean, error?:string}}
 */
function _git(dir, args) {
  try {
    const stdout = execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    return { ok: true, stdout: typeof stdout === 'string' ? stdout : '' };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      if (!_gitMissingWarned) {
        _gitMissingWarned = true;
        // eslint-disable-next-line no-console
        console.warn('[agentFs] 未找到 git，AgentFS 将在无版本化模式下工作（只读写文件，不做快照）。');
      }
      return { gitless: true, ok: false };
    }
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/** Initialise a git repo in `dir` (no-op if already one / git absent). */
function _gitInit(dir) {
  const inside = _git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.gitless) return { gitless: true };
  if (inside.ok && inside.stdout.trim() === 'true') return { ok: true };
  return _git(dir, ['init', '-q']);
}

/**
 * Stage everything and commit with an identity that does not depend on the
 * user's global git config. Returns {committed:bool} / {gitless:true}.
 * @param {string} dir
 * @param {string} message
 */
function _gitCommit(dir, message) {
  const add = _git(dir, ['add', '-A']);
  if (add.gitless) return { gitless: true };
  if (!add.ok) return { committed: false, error: add.error };
  const commit = _git(dir, [
    '-c', 'user.name=khy', '-c', 'user.email=khy@local',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '-m', message,
  ]);
  if (commit.gitless) return { gitless: true };
  return { committed: commit.ok, error: commit.error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scaffold templates
// ─────────────────────────────────────────────────────────────────────────────

function _personaSeed() {
  try {
    return require('../personaService').defaultTemplate();
  } catch {
    return '# Persona\n\n## Answer Strategy\n- Lead with the direct answer, then the reasoning.\n';
  }
}

function _principlesSeed(name) {
  return [
    `# Principles — ${name}`,
    '',
    '> 红线 / 不可逾越。这些规则永不被自动学习或自我进化覆写。',
    '',
    '- 绝不泄露密钥或打印未脱敏的凭据。',
    '- 绝不绕过明确的人闸门（human-gate）。',
    '- 对破坏性/不可逆操作，先确认再执行。',
    '',
  ].join('\n');
}

function _memoryIndexSeed(name) {
  return [
    `# Memory — ${name}`,
    '',
    '关系记忆索引。每条记忆一个文件，正文带 frontmatter；本文件每行一个指针。',
    '',
  ].join('\n');
}

function _heartbeatSeed() {
  return [
    '# 心跳检查（HEARTBEAT.md）',
    '',
    '> 留空或只有注释则不发起检查。',
    '',
    '## 数据源',
    '# - 邮箱：检查来自关键联系人的未读邮件',
    '# - GitHub：检查被 @、PR 审查请求和失败的 CI',
    '',
    '## 判断标准',
    '# - 没有新增重要事项时保持安静',
    '# - 需要外部操作时只提建议，不直接执行',
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

function _hasManifest(dir) {
  try {
    return fs.statSync(path.join(dir, ASSET_FILES.manifest)).isFile();
  } catch {
    return false;
  }
}

/**
 * Create a new agent: scaffold the layout, git-init, and make the first commit.
 * @param {object} opts
 * @param {string} opts.name        display name (required)
 * @param {string} [opts.description]
 * @param {string} [opts.model]
 * @param {string} [opts.id]        explicit id; otherwise slugified from name
 * @param {string} [opts.createdAt] ISO timestamp (injected for reproducibility)
 * @returns {{ id:string, dir:string, manifest:object, versioned:boolean }}
 */
function createAgent(opts = {}) {
  const name = String(opts.name || '').trim();
  if (!name) throw new Error('createAgent: name 必填');

  let id = opts.id ? String(opts.id).trim() : slugify(name);
  if (!id) {
    throw new Error(`无法从名称 "${name}" 推导出 id（可能是非 ASCII 名称），请用 --id 显式指定一个英文 id。`);
  }
  const dir = _agentDir(id); // validates id + traversal

  if (_hasManifest(dir)) {
    throw new Error(`agent 已存在: ${id}（目录 ${dir}）`);
  }

  fs.mkdirSync(dir, { recursive: true });
  for (const sub of SCAFFOLD_DIRS) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }

  const manifest = {
    id,
    name,
    description: opts.description ? String(opts.description) : '',
    model: opts.model ? String(opts.model) : '',
    schema: 'agentfs',
    version: SCHEMA_VERSION,
    createdAt: opts.createdAt || null,
  };

  _writeFile(path.join(dir, ASSET_FILES.manifest), JSON.stringify(manifest, null, 2) + '\n');
  _writeFile(path.join(dir, ASSET_FILES.persona), _personaSeed());
  _writeFile(path.join(dir, ASSET_FILES.principles), _principlesSeed(name));
  _writeFile(path.join(dir, ASSET_FILES.memoryIndex), _memoryIndexSeed(name));
  _writeFile(path.join(dir, ASSET_FILES.permissions), JSON.stringify({ rules: [] }, null, 2) + '\n');
  _writeFile(path.join(dir, ASSET_FILES.heartbeat), _heartbeatSeed());

  const initRes = _gitInit(dir);
  const commitRes = initRes.gitless ? { gitless: true } : _gitCommit(dir, `chore(agentfs): create agent ${id}`);
  const versioned = !initRes.gitless && !commitRes.gitless && commitRes.committed === true;

  return { id, dir, manifest, versioned };
}

/** List all agents (directories containing agent.json), sorted by id. */
function listAgents() {
  const root = getAgentsRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
    const dir = path.join(root, e.name);
    if (!_hasManifest(dir)) continue;
    const manifest = _readManifest(dir);
    if (manifest) out.push(manifest);
  }
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return out;
}

/** Get one agent's manifest + dir, or null if it does not exist. */
function getAgent(id) {
  const dir = _agentDir(id);
  if (!_hasManifest(dir)) return null;
  const manifest = _readManifest(dir);
  if (!manifest) return null;
  return { id, dir, manifest };
}

function _readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, ASSET_FILES.manifest), 'utf-8'));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Asset read / write (write → commit)
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve an asset path inside an agent dir, guarding against traversal. */
function _assetPath(dir, rel) {
  if (typeof rel !== 'string' || !rel) throw new Error('asset 相对路径必填');
  const resolved = path.resolve(dir, rel);
  if (!(resolved + path.sep).startsWith(dir + path.sep) && resolved !== dir) {
    throw new Error(`asset 路径穿越被拒绝: ${rel}`);
  }
  return resolved;
}

function _writeFile(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
}

/** Read an agent asset (relative path). Returns string, or null if missing. */
function readAsset(id, rel) {
  const dir = _agentDir(id);
  const abs = _assetPath(dir, rel);
  try {
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Write an agent asset and snapshot it with a git commit (best-effort).
 * @returns {{ path:string, versioned:boolean }}
 */
function writeAsset(id, rel, content, options = {}) {
  const dir = _agentDir(id);
  if (!_hasManifest(dir)) throw new Error(`agent 不存在: ${id}`);
  const abs = _assetPath(dir, rel);
  _writeFile(abs, typeof content === 'string' ? content : String(content));
  const message = options.message || `chore(agentfs): update ${rel}`;
  const res = _gitCommit(dir, message);
  return { path: abs, versioned: !res.gitless && res.committed === true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layered loading (L0 / L1 / L2) — the core feature
// ─────────────────────────────────────────────────────────────────────────────

const LEVELS = Object.freeze(['L0', 'L1', 'L2']);

function _firstHeadingBlock(md) {
  if (!md) return '';
  const lines = md.split('\n');
  const out = [];
  let started = false;
  for (const line of lines) {
    const isHeading = /^#{1,6}\s/.test(line);
    if (isHeading) {
      if (started) break; // stop at the second heading
      started = true;
    }
    if (started) out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * Assemble a layered view of an agent. Levels are cumulative:
 *   L0  identity only — manifest summary + persona's first block + principles.
 *   L1  L0 + summaries — memory index + skill catalog + heartbeat presence.
 *   L2  L1 + full content — full persona, every memory file, every skill prompt.
 * @param {string} id
 * @param {'L0'|'L1'|'L2'} [level='L0']
 * @returns {{ id:string, level:string, text:string, bytes:number }}
 */
function loadLayered(id, level = 'L0') {
  const lvl = LEVELS.includes(level) ? level : 'L0';
  const agent = getAgent(id);
  if (!agent) throw new Error(`agent 不存在: ${id}`);
  const { dir, manifest } = agent;
  const want = LEVELS.indexOf(lvl);
  const parts = [];

  // ── L0: identity (always) ──
  parts.push(
    `# Agent: ${manifest.name} (${manifest.id})`,
    manifest.description ? `\n${manifest.description}` : '',
    manifest.model ? `\nModel: ${manifest.model}` : '',
  );
  const persona = readAsset(id, ASSET_FILES.persona) || '';
  const personaBlock = _firstHeadingBlock(persona);
  if (personaBlock) parts.push('\n## Persona\n' + personaBlock);
  const principles = readAsset(id, ASSET_FILES.principles) || '';
  if (principles.trim()) parts.push('\n## Principles (red lines)\n' + principles.trim());

  // ── L1: summaries ──
  if (want >= 1) {
    const memIndex = readAsset(id, ASSET_FILES.memoryIndex) || '';
    if (memIndex.trim()) parts.push('\n## Memory index\n' + memIndex.trim());

    const skills = _skillCatalog(dir);
    if (skills) parts.push('\n## Skills\n' + skills);

    const heartbeat = readAsset(id, ASSET_FILES.heartbeat) || '';
    const hbActive = heartbeat.split('\n').some(l => l.trim() && !l.trim().startsWith('#'));
    parts.push(`\n## Heartbeat\n${hbActive ? 'active' : 'idle (no active checks)'}`);
  }

  // ── L2: full content ──
  if (want >= 2) {
    if (persona.trim()) parts.push('\n## Persona (full)\n' + persona.trim());
    const memFull = _allMemoryFiles(dir);
    if (memFull) parts.push('\n## Memory (full)\n' + memFull);
    const skillPrompts = _allSkillPrompts(dir);
    if (skillPrompts) parts.push('\n## Skill prompts (full)\n' + skillPrompts);
    const workflows = _allWorkflows(dir);
    if (workflows) parts.push('\n## Workflows\n' + workflows);
  }

  const text = parts.filter(Boolean).join('\n').trim() + '\n';
  return { id, level: lvl, text, bytes: Buffer.byteLength(text, 'utf-8') };
}

// ─────────────────────────────────────────────────────────────────────────────
// Five-asset model view (借鉴分析 #2)
// ─────────────────────────────────────────────────────────────────────────────

/** Stat a file relative to an agent dir; returns null if absent/unreadable. */
function _statRel(dir, rel) {
  try {
    const abs = _assetPath(dir, rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    return { rel, bytes: st.size, exists: true };
  } catch { return null; }
}

/** List files (one level deep) under an agent subdir, with sizes. */
function _listDirFiles(dir, sub) {
  const out = [];
  const walk = (absBase, relBase) => {
    let entries = [];
    try { entries = fs.readdirSync(absBase, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = path.join(relBase, e.name);
      const abs = path.join(absBase, e.name);
      if (e.isDirectory()) { walk(abs, rel); continue; }
      if (e.isFile()) {
        let bytes = 0;
        try { bytes = fs.statSync(abs).size; } catch { /* skip */ }
        out.push({ rel, bytes, exists: true });
      }
    }
  };
  walk(path.join(dir, sub), sub);
  return out;
}

/**
 * Describe a companion as the five-asset model: which assets are present, their
 * files and byte sizes. Pure read-only; missing files/git never throw.
 * Receipts is an *external* asset — its count is supplied by the caller via
 * opts.countReceipts(companionId) (the handler layer owns the receiptService
 * dependency), not read from files on disk.
 * @param {string} id
 * @param {{countReceipts?: (companionId: string) => number}} [opts]
 * @returns {Array<{key,label,present,files,bytes,summary,external?}>}
 */
function describeAssets(id, opts = {}) {
  const agent = getAgent(id);
  if (!agent) throw new Error(`agent 不存在: ${id}`);
  const { dir } = agent;
  // Receipts is an external asset: the caller (which already owns the
  // receiptService dependency) injects the counter, so agentFsService keeps no
  // sideways edge into receiptService. Absent injector → 0 (asset reads empty).
  const countReceipts = typeof opts.countReceipts === 'function' ? opts.countReceipts : null;

  return ASSET_MODEL.map((a) => {
    if (a.external === 'receipts') {
      let count = 0;
      try {
        count = countReceipts ? countReceipts(id) : 0;
      } catch { /* receipts optional */ }
      return {
        key: a.key, label: a.label, external: 'receipts',
        present: count > 0, files: [], bytes: 0, count,
        summary: count > 0 ? `${count} 条回执` : '尚无回执',
      };
    }

    const files = [];
    for (const rel of (a.files || [])) {
      const s = _statRel(dir, rel);
      if (s) files.push(s);
    }
    for (const sub of (a.dirs || [])) {
      files.push(..._listDirFiles(dir, sub));
    }
    const bytes = files.reduce((n, f) => n + (f.bytes || 0), 0);
    const present = files.length > 0;
    return {
      key: a.key, label: a.label,
      present, files, bytes,
      summary: present ? `${files.length} 个文件 · ${bytes} bytes` : '（空）',
    };
  });
}

function _skillCatalog(dir) {
  const skillsDir = path.join(dir, 'skills');
  let names = [];
  try {
    names = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return '';
  }
  const lines = [];
  for (const n of names) {
    let desc = '';
    try {
      const man = JSON.parse(fs.readFileSync(path.join(skillsDir, n, 'manifest.json'), 'utf-8'));
      desc = man.description || man.whenToUse || '';
    } catch { /* no manifest */ }
    lines.push(`- ${n}${desc ? ` — ${desc}` : ''}`);
  }
  return lines.join('\n');
}

function _allMemoryFiles(dir) {
  const memDir = path.join(dir, 'memory');
  let files = [];
  try {
    files = fs.readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').sort();
  } catch {
    return '';
  }
  const blocks = [];
  for (const f of files) {
    try {
      blocks.push(`### ${f}\n` + fs.readFileSync(path.join(memDir, f), 'utf-8').trim());
    } catch { /* skip */ }
  }
  return blocks.join('\n\n');
}

function _allSkillPrompts(dir) {
  const skillsDir = path.join(dir, 'skills');
  let names = [];
  try {
    names = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch {
    return '';
  }
  const blocks = [];
  for (const n of names) {
    try {
      blocks.push(`### ${n}\n` + fs.readFileSync(path.join(skillsDir, n, 'prompt.md'), 'utf-8').trim());
    } catch { /* skip */ }
  }
  return blocks.join('\n\n');
}

function _allWorkflows(dir) {
  const wfDir = path.join(dir, 'workflows');
  let files = [];
  try {
    files = fs.readdirSync(wfDir).filter(f => f.endsWith('.md')).sort();
  } catch {
    return '';
  }
  const blocks = [];
  for (const f of files) {
    try {
      blocks.push(`### ${f}\n` + fs.readFileSync(path.join(wfDir, f), 'utf-8').trim());
    } catch { /* skip */ }
  }
  return blocks.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// History / revert (git-backed; best-effort)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return commit history for an agent (newest first). Empty when git is absent.
 * @param {string} id
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @returns {Array<{ hash:string, subject:string }>}
 */
function history(id, opts = {}) {
  const dir = _agentDir(id);
  if (!_hasManifest(dir)) throw new Error(`agent 不存在: ${id}`);
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 50;
  const res = _git(dir, ['log', `-n${limit}`, '--pretty=format:%h\t%s']);
  if (!res.ok || !res.stdout) return [];
  return res.stdout.split('\n').filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    return tab === -1
      ? { hash: line, subject: '' }
      : { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
}

/**
 * Restore the working tree to a past commit and snapshot the result.
 * @returns {{ reverted:boolean, versioned:boolean }}
 */
function revertTo(id, commit) {
  const dir = _agentDir(id);
  if (!_hasManifest(dir)) throw new Error(`agent 不存在: ${id}`);
  if (!/^[0-9a-f]{4,40}$/i.test(String(commit || ''))) {
    throw new Error(`非法 commit: ${commit}`);
  }
  const restore = _git(dir, ['restore', '--source', commit, '--', '.']);
  if (restore.gitless) return { reverted: false, versioned: false };
  if (!restore.ok) throw new Error(`revert 失败: ${restore.error || 'git restore'}`);
  const res = _gitCommit(dir, `chore(agentfs): revert to ${commit}`);
  return { reverted: true, versioned: !res.gitless && res.committed === true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Active companion pointer (Phase 2 — system-prompt integration)
//
// One small JSON file marks which companion is "active". When set, the chat
// system prompt injects that companion's layered context (see
// companionPromptSection). When unset, nothing changes — zero regression.
// ─────────────────────────────────────────────────────────────────────────────

function _activePointerPath() {
  return path.join(getAgentsRoot(), '.active.json');
}

/** Return the active companion id, or null. Validates the agent still exists. */
function getActiveAgentId() {
  try {
    const raw = fs.readFileSync(_activePointerPath(), 'utf-8');
    const id = JSON.parse(raw).id;
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    if (!_hasManifest(_agentDir(id))) return null;
    return id;
  } catch {
    return null;
  }
}

/** Mark a companion active. Throws if it does not exist. */
function setActiveAgent(id) {
  const dir = _agentDir(id);
  if (!_hasManifest(dir)) throw new Error(`agent 不存在: ${id}`);
  const root = getAgentsRoot();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(_activePointerPath(), JSON.stringify({ id }) + '\n', 'utf-8');
  return { id };
}

/** Clear the active companion pointer (idempotent). */
function clearActiveAgent() {
  try { fs.unlinkSync(_activePointerPath()); } catch { /* already clear */ }
  return { cleared: true };
}

/**
 * Cache-invalidation stamp for the companion system-prompt section. Combines
 * the active id with the mtime/size of its identity-bearing files, so the
 * cached prompt section refreshes when you switch companions OR edit one.
 * @param {string} [level='L1']
 * @returns {string}
 */
function activeStamp(level = 'L1') {
  const id = getActiveAgentId();
  if (!id) return 'none';
  const dir = _agentDir(id);
  const parts = [id, level];
  const files = [ASSET_FILES.manifest, ASSET_FILES.persona, ASSET_FILES.principles, ASSET_FILES.memoryIndex];
  for (const rel of files) {
    try {
      const st = fs.statSync(path.join(dir, rel));
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch { parts.push('?'); }
  }
  return parts.join('|');
}

/**
 * Build the system-prompt section for the active companion, or null when none
 * is active. Default level L1 (identity + red lines + memory index + skill
 * catalog) keeps token cost bounded; pass 'L2' for full content.
 * @param {object} [opts]
 * @param {'L0'|'L1'|'L2'} [opts.level='L1']
 * @returns {string|null}
 */
function companionPromptSection(opts = {}) {
  const id = getActiveAgentId();
  if (!id) return null;
  const level = LEVELS.includes(opts.level) ? opts.level : 'L1';
  let view;
  try {
    view = loadLayered(id, level);
  } catch {
    return null;
  }
  if (!view || !view.text || !view.text.trim()) return null;
  return [
    '# Active Companion',
    'The following describes the currently active companion (an AgentFS agent:',
    "its persona, red lines, and memory). It shapes HOW you respond. Project",
    'instructions and explicit user requests take precedence on any conflict;',
    'never cross a red line listed under Principles.',
    '',
    view.text.trim(),
  ].join('\n');
}

module.exports = {
  getAgentsRoot,
  createAgent,
  listAgents,
  getAgent,
  readAsset,
  writeAsset,
  loadLayered,
  describeAssets,
  history,
  revertTo,
  slugify,
  getActiveAgentId,
  setActiveAgent,
  clearActiveAgent,
  activeStamp,
  companionPromptSection,
  ASSET_FILES,
  ASSET_MODEL,
  LEVELS,
  // exposed for tests
  _agentDir,
};
