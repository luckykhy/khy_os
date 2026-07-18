/**
 * Plan Mode Service — structured plan → approve → execute workflow.
 *
 * When a complex task is detected, AI generates a numbered execution plan.
 * The user can approve, modify, or reject before step-by-step execution.
 *
 * State machine: idle → generating → reviewing → executing → complete
 */
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ── Plan Persistence ─────────────────────────────────────────────────
const PLANS_DIR_NAME = 'plans';

function _getPlansDir() {
  const home = os.homedir();
  return path.join(home, '.khyquant', PLANS_DIR_NAME);
}

function _ensurePlansDir() {
  const dir = _getPlansDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * Save a plan to disk for cross-session recovery.
 * @param {object} plan - The parsed plan object
 * @param {string} userRequest - Original user request
 * @param {object} [meta] - Additional metadata (cwd, provider, etc.)
 * @returns {{ slug: string, filePath: string }}
 */
function savePlan(plan, userRequest, meta = {}) {
  const dir = _ensurePlansDir();
  const slug = _slugify(userRequest || 'plan') + '-' + crypto.randomBytes(3).toString('hex');
  const filePath = path.join(dir, `${slug}.json`);

  const payload = {
    slug,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: _state,
    userRequest: (userRequest || '').slice(0, 2000),
    plan,
    cwd: meta.cwd || process.cwd(),
    provider: meta.provider || null,
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  return { slug, filePath };
}

/**
 * Update an existing persisted plan (e.g., step status changes).
 * @param {string} slug
 * @param {object} updates - Partial fields to merge
 * @returns {boolean}
 */
function updatePersistedPlan(slug, updates) {
  const filePath = path.join(_getPlansDir(), `${slug}.json`);
  try {
    if (!fs.existsSync(filePath)) return false;
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a persisted plan by slug.
 * @param {string} slug
 * @returns {object|null}
 */
function loadPersistedPlan(slug) {
  const filePath = path.join(_getPlansDir(), `${slug}.json`);
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * List recent persisted plans (most recent first).
 * @param {number} [limit=10]
 * @returns {Array<{ slug: string, userRequest: string, state: string, createdAt: string, cwd: string }>}
 */
function listPersistedPlans(limit = 10) {
  const dir = _getPlansDir();
  try {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
          return { slug: data.slug, userRequest: (data.userRequest || '').slice(0, 120), state: data.state, createdAt: data.createdAt, cwd: data.cwd };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return files.slice(0, limit);
  } catch { return []; }
}

// ── State ─────────────────────────────────────────────────────────────
let _state = 'idle'; // idle | generating | reviewing | executing | complete
let _currentPlan = null;
let _currentPlanSlug = null;

function isStepExecutionFailure(result) {
  if (!result || typeof result !== 'object') return true;
  if (result.errorType || result.blocked) return true;

  const reply = String(result.reply || '').trim();
  if (!reply) return true;

  if (/^\s*(AI 请求失败|AI 未返回有效回复|error:|错误:)/i.test(reply)) return true;
  if (/(permission denied|operation not permitted|access denied|forbidden|not allowed)/i.test(reply)) return true;
  if (/(权限被拒绝|未授权|任务被权限阻止|无法完成|无法运行|未创建)/.test(reply)) return true;

  return false;
}

function runWithActivityTimeout(taskFactory, timeoutMs, errorMessage) {
  const idleMs = Math.max(1000, Number(timeoutMs) || 0);
  const checkEveryMs = Math.min(1000, Math.max(200, Math.floor(idleMs / 6)));

  return new Promise((resolve, reject) => {
    let settled = false;
    let lastActivity = Date.now();
    let watcher = null;

    const cleanup = () => {
      if (watcher) {
        clearInterval(watcher);
        watcher = null;
      }
    };

    const touch = () => {
      lastActivity = Date.now();
    };

    watcher = setInterval(() => {
      if (settled) return;
      const idleFor = Date.now() - lastActivity;
      if (idleFor <= idleMs) return;
      settled = true;
      cleanup();
      reject(new Error(errorMessage || `Timeout after ${idleMs}ms`));
    }, checkEveryMs);
    if (watcher.unref) watcher.unref();

    Promise.resolve()
      .then(() => taskFactory({ touch }))
      .then((value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });
  });
}

function extractAbsolutePaths(text) {
  if (!text) return [];
  const paths = new Set();
  const pattern = /(?:^|[\s`'"])(\/[^\s`'"]+)/g;
  let m;
  while ((m = pattern.exec(String(text)))) {
    const cleaned = m[1].replace(/[),.;:]+$/g, '').trim();
    if (cleaned) paths.add(cleaned);
  }
  return Array.from(paths);
}

function inferPlanBaseDirs(plan) {
  const combined = [
    ...(plan?.dataNeeds || []),
    ...(plan?.expectedOutputs || []),
    ...(plan?.risks || []),
    ...(plan?.steps || []).map(s => s.description || ''),
  ].join('\n');
  const absPaths = extractAbsolutePaths(combined);
  const dirs = [];
  for (const p of absPaths) {
    const last = path.basename(p);
    if (/\.[a-z0-9]{1,8}$/i.test(last)) {
      dirs.push(path.dirname(p));
    } else {
      dirs.push(p);
    }
  }
  const cwd = process.env.KHYQUANT_CWD || process.cwd();
  if (cwd) dirs.push(path.resolve(cwd));
  return Array.from(new Set(dirs.filter(Boolean)));
}

function inferStepFileTargets(stepDescription, plan) {
  const desc = String(stepDescription || '');
  const namePattern = /(?:^|[\s`'"])([A-Za-z0-9_.\/-]+\.[A-Za-z0-9]{1,8})(?=$|[\s`'".,;:])/g;
  const names = new Set();
  let m;
  while ((m = namePattern.exec(desc))) {
    names.add(m[1]);
  }
  const baseDirs = inferPlanBaseDirs(plan);
  const targets = new Set();
  for (const n of names) {
    if (n.startsWith('/')) {
      targets.add(path.resolve(n));
      continue;
    }
    for (const dir of baseDirs) {
      targets.add(path.resolve(dir, n));
    }
  }

  // If assistant reply already contains absolute artifact paths, include them.
  for (const p of extractAbsolutePaths(desc)) {
    const base = path.basename(p);
    if (/\.[a-z0-9]{1,8}$/i.test(base)) targets.add(path.resolve(p));
  }

  return Array.from(targets);
}

function hasExecutionIntent(stepDescription) {
  return /(创建|新建|写入|编写|生成|修改|编辑|运行|执行|测试|校验|验证|create|write|add|update|edit|run|execute|test|verify)/i
    .test(String(stepDescription || ''));
}

function hasWriteIntent(stepDescription) {
  return /(创建|新建|写入|编写|生成|修改|编辑|create|write|add|update|edit|文件|目录)/i
    .test(String(stepDescription || ''));
}

function hasRunIntent(stepDescription) {
  return /(运行|执行|测试|校验|验证|run|execute|test|verify|命令|command)/i
    .test(String(stepDescription || ''));
}

function hasRuntimeEvidence(reply) {
  const text = String(reply || '');
  if (!text.trim()) return false;
  if (/\b(pass|passed|fail|failed|exit code|stdout|stderr)\b/i.test(text)) return true;
  if (/(测试结果|通过|失败|退出码|命令输出|执行结果)/.test(text)) return true;
  if (/`(?:bash|node|npm|pnpm|yarn)\s+/i.test(text)) return true;
  return false;
}

function shortenReason(reason, maxLen = 220) {
  const text = String(reason || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'unknown reason';
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function getPlanPreviewStyle() {
  const raw = String(process.env.KHY_PLAN_PREVIEW_STYLE || 'natural').trim().toLowerCase();
  if (raw === 'compact' || raw === 'coach' || raw === 'natural') return raw;
  return 'natural';
}

function buildStepPreviewText(stepDescription, index, totalSteps, style = 'natural') {
  const summary = shortenReason(stepDescription, 100);
  if (style === 'compact') {
    return `第 ${index + 1}/${totalSteps} 步：${summary}`;
  }
  if (style === 'coach') {
    const leads = [
      `先把这一项拿下：${summary}`,
      `这一步是关键环节，我先推进：${summary}`,
      `我先处理这块核心任务：${summary}`,
      `这一步我会先落地，再马上反馈：${summary}`,
    ];
    return `${leads[index % leads.length]}（进度 ${index + 1}/${totalSteps}）`;
  }
  const leads = [
    `我先从这一项开始：${summary}`,
    `接下来我会处理这一步：${summary}`,
    `这一步我先落地执行：${summary}`,
    `先推进这一块内容：${summary}`,
  ];
  return `${leads[index % leads.length]}（当前进度 ${index + 1}/${totalSteps}）`;
}

function buildAttemptPreviewText(stepId, attemptNumber, maxAttempts, style = 'natural') {
  if (style === 'compact') {
    return `执行第 ${stepId} 步，尝试 ${attemptNumber}/${maxAttempts}。`;
  }
  if (style === 'coach') {
    if (maxAttempts <= 1) {
      return `开始执行第 ${stepId} 步，我会边做边汇报进展。`;
    }
    return `开始执行第 ${stepId} 步（第 ${attemptNumber}/${maxAttempts} 次尝试），我会及时调整并同步结果。`;
  }
  if (maxAttempts <= 1) {
    return `开始执行第 ${stepId} 步，完成后我会立刻同步结果。`;
  }
  return `开始执行第 ${stepId} 步（第 ${attemptNumber}/${maxAttempts} 次尝试），我会实时反馈结果。`;
}

function validateStepResult(step, plan, result, stepStartedAtMs) {
  if (isStepExecutionFailure(result)) {
    return { ok: false, reason: 'AI response indicates failure or no valid output' };
  }

  const desc = String(step?.description || '');
  if (!hasExecutionIntent(desc)) {
    return { ok: true, reason: '' };
  }

  const reply = String(result?.reply || '');
  const toolCalls = Number(result?.toolSummary?.totalCalls || 0);
  const fileTargets = inferStepFileTargets(desc, plan);
  const missingFiles = [];
  const staleFiles = [];

  for (const filePath of fileTargets) {
    if (!fs.existsSync(filePath)) {
      missingFiles.push(filePath);
      continue;
    }
    if (hasWriteIntent(desc)) {
      try {
        const st = fs.statSync(filePath);
        if (st.mtimeMs + 1500 < stepStartedAtMs) {
          staleFiles.push(filePath);
        }
      } catch {
        staleFiles.push(filePath);
      }
    }
  }

  if (missingFiles.length > 0) {
    return { ok: false, reason: `missing expected files: ${missingFiles.join(', ')}` };
  }

  if (hasWriteIntent(desc) && fileTargets.length > 0 && staleFiles.length === fileTargets.length && toolCalls <= 0) {
    return { ok: false, reason: 'no observable file updates for a write/create step' };
  }

  if (hasRunIntent(desc) && toolCalls <= 0 && !hasRuntimeEvidence(reply)) {
    return { ok: false, reason: 'run/test step has no executable evidence in output' };
  }

  // For mutation steps, require at least one concrete signal.
  if (hasWriteIntent(desc) && fileTargets.length === 0 && toolCalls <= 0 && !hasRuntimeEvidence(reply)) {
    return { ok: false, reason: 'write step has no tool evidence and no detectable artifacts' };
  }

  return { ok: true, reason: '' };
}

// ── Plan Prompt Template ──────────────────────────────────────────────
// 资深工程师级结构化计划。对标一份高质量交付计划应有的骨架:不只列步骤,而是先讲清
// 「为什么做」(背景+动机+预期结果)、用实际读过的代码给出「关键现状」实证(file:line →
// 现状)、给「计划」(具体可执行步骤+依赖)、「预计结果」、「风险与对策」(风险↔对策配对)、
// 「验证」(可运行的命令/测试,而非"读了代码"=验证)、「收尾」(残留风险/未做项/是否提交/下一步)。
// 逃生阀 KHY_PLAN_RICH=0/false/off/no 回退旧扁平模板(下方 LEGACY)。
const PLAN_PROMPT_RICH = `[大型任务 — 请先制定一份资深工程师级的详细执行计划]

用户请求: {REQUEST}

请像资深工程师交付计划那样，输出一份结构化计划，用 ## 标题分隔以下各段。
宁可简短也不要省略任一段；凡涉及代码改动，务必先实地查证再下笔，用证据说话。

## 为什么做
[背景与动机:要解决什么问题、是什么触发了它、期望的最终结果。讲清"为什么值得做"，2-5 句。]

## 关键现状
[你实际查证到的现状(不要凭空臆测)。涉及代码时列出读过的关键位置与其当前行为，
 形如 "文件:行 → 现状"；可用表格或 - 列表。这一段是计划可信度的根基。]

## 计划
1. [具体、独立可执行的步骤]
2. [步骤……]
...
[步骤间有明确输入/输出关系；某步依赖其它步用 [depends: 1,3] 标注。涉及代码改动时点名
 要改的文件/函数；需要外部数据或前置条件也在此段以 - 列出。]

## 预计结果
- [完成后应得到的交付物或可观察状态]

## 风险与对策
- [风险] → [对策/缓解]
[把"可能出错的地方"和"怎么兜住"配对写，逐条。]

## 验证
- [如何确认真的成功:跑哪些测试/命令、看哪些证据、期望的退出码或输出。
   注意"读了代码"不等于"验证过"；给出可复现的验证手段。]

## 收尾
- [残留风险、未做项、是否需要提交、下一步建议]

记住:好的计划让人一眼看懂"为什么做、怎么做、怎么验、剩什么"。`;

// LEGACY:旧 4 段模板,逃生阀 KHY_PLAN_RICH=0 时使用。
const PLAN_PROMPT_LEGACY = `[大型任务 — 请先制定详细执行计划]

用户请求: {REQUEST}

请输出一个结构化的执行计划，格式如下:

## 执行计划
1. [步骤描述]
2. [步骤描述]
...

## 需要的数据
- [数据项]

## 预计输出
- [输出描述]

## 风险与注意事项
- [风险项]

注意: 每个步骤应独立可执行，步骤之间有明确的输入/输出关系。`;

/** 是否启用资深工程师级富计划(逃生阀 KHY_PLAN_RICH=0/false/off/no 关闭)。 */
function _isRichPlanEnabled(env = process.env) {
  const flag = String((env && env.KHY_PLAN_RICH) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// 当前生效模板(供 enterPlanMode 取用)。保留 PLAN_PROMPT 名以兼容既有引用。
const PLAN_PROMPT = _isRichPlanEnabled() ? PLAN_PROMPT_RICH : PLAN_PROMPT_LEGACY;

/**
 * Enter plan mode: generate a plan from AI.
 * @param {string} userRequest - the user's original request
 * @param {object} aiModule - the ai module (lazy-loaded)
 * @param {object} [opts] - { onChunk, effort }
 * @returns {{ plan: object, rawResponse: string }}
 */
async function enterPlanMode(userRequest, aiModule, opts = {}) {
  _state = 'generating';

  const prompt = PLAN_PROMPT.replace('{REQUEST}', userRequest);
  let result;
  try {
    const preferredAdapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim().toLowerCase();
    const isLocalLikeAdapter = !preferredAdapter
      || preferredAdapter === 'localllm'
      || preferredAdapter === 'local-llm'
      || preferredAdapter === 'local'
      || preferredAdapter === 'ollama';
    const defaultPlanTimeout = isLocalLikeAdapter ? '120000' : '90000';
    const timeoutMs = Math.max(10000, parseInt(process.env.KHY_PLAN_MODE_TIMEOUT_MS || defaultPlanTimeout, 10));
    result = await runWithActivityTimeout(
      ({ touch }) => {
        const userOnChunk = typeof opts.onChunk === 'function' ? opts.onChunk : null;
        const userOnStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
        const userOnControlRequest = typeof opts.onControlRequest === 'function' ? opts.onControlRequest : null;
        return aiModule.chat(prompt, {
          ...opts,
          _isFollowUp: false,
          onChunk: (chunk) => {
            touch();
            if (userOnChunk) {
              try { userOnChunk(chunk); } catch { /* best effort */ }
            }
          },
          onStatus: (status) => {
            touch();
            if (userOnStatus) {
              try { userOnStatus(status); } catch { /* best effort */ }
            }
          },
          onControlRequest: (...args) => {
            touch();
            if (userOnControlRequest) {
              return userOnControlRequest(...args);
            }
            return undefined;
          },
        });
      },
      timeoutMs,
      `Plan generation timeout after ${Math.round(timeoutMs / 1000)}s`
    );
  } catch (err) {
    _state = 'idle';
    const lowerMsg = String(err && err.message ? err.message : '').toLowerCase();
    const timeoutLike = lowerMsg.includes('timeout') || lowerMsg.includes('timed out') || lowerMsg.includes('超时');
    return {
      plan: null,
      rawResponse: `计划模式生成失败: ${err && err.message ? err.message : 'unknown error'}`,
      provider: null,
      elapsed: 0,
      errorType: timeoutLike ? 'timeout' : 'error',
    };
  }

  if (!result.reply) {
    _state = 'idle';
    return { plan: null, rawResponse: '' };
  }

  if (result.errorType) {
    _state = 'idle';
    return {
      plan: null,
      rawResponse: result.reply,
      provider: result.provider || null,
      elapsed: result.elapsed || 0,
      errorType: result.errorType,
    };
  }

  const plan = parsePlanFromResponse(result.reply);
  _currentPlan = plan;
  _state = 'reviewing';

  // Persist plan to disk for cross-session recovery
  try {
    const persisted = savePlan(plan, userRequest, { provider: result.provider });
    _currentPlanSlug = persisted.slug;
  } catch { /* persistence is best-effort */ }

  return { plan, rawResponse: result.reply, provider: result.provider, elapsed: result.elapsed, slug: _currentPlanSlug };
}

// ── Step-type taxonomy (固化/灵活/人闸门) ──────────────────────────────
// Reuses the shared riskGate SSOT so plan steps speak the same language as the
// tool-call funnel, orchestration flow, and receipts.
let _riskGate = null;
function riskGate() {
  if (_riskGate === null) {
    try { _riskGate = require('./riskGate'); } catch { _riskGate = {}; }
  }
  return _riskGate;
}

const _DESTRUCTIVE_RE = /删除|清空|重置|覆盖|迁移|发布|部署|回滚|drop|\brm\b|delete|reset|overwrite|migrate|deploy|force|truncate|wipe/i;
const _READONLY_RE = /查看|读取|列出|检查|分析|查询|预览|read|list|inspect|analyze|review|check|view|show/i;

/**
 * Infer a step type from a natural-language plan-step description. Maps the
 * description to coarse risk signals, then defers to riskGate.deriveStepType.
 * Falls back to 'flexible' when riskGate is unavailable.
 * @param {string} description
 * @returns {string} hardened | flexible | human-gate
 */
function inferStepType(description) {
  const rg = riskGate();
  if (typeof rg.deriveStepType !== 'function') return 'flexible';
  const text = String(description || '');
  const isDestructive = _DESTRUCTIVE_RE.test(text);
  const isReadOnly = !isDestructive && _READONLY_RE.test(text);
  const risk = isDestructive ? 'high' : (isReadOnly ? 'safe' : 'medium');
  try {
    return rg.deriveStepType({ risk, isReadOnly, isDestructive });
  } catch {
    return 'flexible';
  }
}

/**
 * Render a short display tag for a step type, matching the receipts style.
 * @param {string} stepType
 * @returns {string} tag with trailing space, or '' for unknown
 */
function stepTypeTag(stepType) {
  let _chalk;
  const c = () => (_chalk ??= (require('chalk').default || require('chalk')));
  if (stepType === 'human-gate') return c().red('🔒人闸门 ');
  if (stepType === 'hardened') return c().dim('[固化] ');
  if (stepType === 'flexible') return c().cyan('[灵活] ');
  return '';
}

/**
 * Whether a plan step must pause for explicit human confirmation before running.
 * Kill switch: KHY_HUMAN_GATE=off bypasses. `bypass` is passed by the executor
 * when the user already opted into autonomous (Goal) mode before plan execution.
 * @param {string} stepType
 * @param {boolean} [bypass]
 * @returns {boolean}
 */
function requiresHumanGateStep(stepType, bypass = false) {
  if (bypass) return false;
  if (process.env.KHY_HUMAN_GATE === 'off') return false;
  const rg = riskGate();
  if (typeof rg.requiresHumanGate === 'function') {
    try { return !!rg.requiresHumanGate(stepType); } catch { /* fall through */ }
  }
  return stepType === 'human-gate';
}

/**
 * Pause and ask the user to confirm a human-gate step before execution.
 * Returns true to proceed, false to skip. No rl → best-effort proceed.
 * @param {object} step
 * @param {readline.Interface} rl
 * @param {object} renderer
 * @returns {Promise<boolean>}
 */
function _confirmHumanGate(step, rl, renderer) {
  let _chalk;
  const c = () => (_chalk ??= (require('chalk').default || require('chalk')));
  if (!rl || typeof rl.question !== 'function') return Promise.resolve(true);
  console.log('');
  console.log(c().red(`  🔒 人闸门 — 第 ${step.id} 步需确认: `) + c().white(step.description));
  return new Promise((resolve) => {
    rl.question(c().dim('  执行此步？(Enter/y 确认 · n 跳过) > '), (answer) => {
      const t = String(answer || '').trim().toLowerCase();
      if (['n', 'no', '取消', '跳过', 'skip'].includes(t)) {
        console.log(c().dim(`  已跳过第 ${step.id} 步`));
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

/**
 * 抓取某个 markdown 标题段的正文(从该标题行后到下一个标题或文末)。
 * headingAlt 为标题候选(如 '预计结果|预计输出'),用 markdown 标题锚定避免误命中正文中的同词。
 * @param {string} text 全文
 * @param {string} headingAlt 标题候选(正则片段)
 * @returns {string} 段落正文(不含标题行);未命中返回空串
 */
function _grabSection(text, headingAlt) {
  const re = new RegExp(`(?:^|\\n)#{1,6}\\s*(?:${headingAlt})[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s|$)`);
  const m = String(text || '').match(re);
  return m ? m[1] : '';
}

/**
 * 把段落正文拆成逐条字符串:兼容 - / • / * 项、数字编号项、以及 markdown 表格行;
 * 自动剥离列表标记、丢弃空行与表格分隔行(|---|)。
 * @param {string} body
 * @returns {string[]}
 */
function _sectionItems(body) {
  const out = [];
  for (const raw of String(body || '').split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    if (/^\|?\s*:?-{3,}/.test(line)) continue; // 表格分隔行 |---|---|
    line = line.replace(/^[-•*]\s+/, '').replace(/^\d+[.、)）]\s+/, '');
    if (line) out.push(line);
  }
  return out;
}

/** 把段落正文压成单段文本(用于「为什么做」这类散文段)。 */
function _sectionText(body) {
  return String(body || '').split('\n').map(s => s.trim()).filter(Boolean).join(' ').trim();
}

/**
 * Parse a numbered plan from AI response text.
 * Extracts steps from patterns like "1. xxx\n2. xxx\n..."
 *
 * @param {string} text - AI response containing a plan
 * @returns {{ steps: Array, dataNeeds: string[], expectedOutputs: string[], risks: string[], why: string, currentState: string[], verification: string[], wrapup: string[] }}
 */
function parsePlanFromResponse(text) {
  const plan = {
    steps: [],
    dataNeeds: [],
    expectedOutputs: [],
    risks: [],
    // 富计划新增字段(默认空,向后兼容;旧扁平计划不含这些段时保持空)。
    why: '',            // 「为什么做」:背景/动机/预期(段落文本)
    currentState: [],   // 「关键现状」:实地查证的 file:line → 现状(逐条)
    verification: [],   // 「验证」:可运行的命令/测试/证据(逐条)
    wrapup: [],         // 「收尾」:残留风险/未做项/是否提交/下一步(逐条)
  };

  // Extract numbered steps —— 仅从「计划/执行计划」段抽取,避免把「验证/收尾」里的编号项
  // 误当成可执行步骤(富模板下验证段常含 1./2. 编号)。无标题的纯编号列表回退全文(零回归)。
  const planBody = _grabSection(text, '执行计划|计划');
  const stepSource = planBody || text;
  const stepPattern = /(?:^|\n)\s*(\d+)[.、）)]\s*(.+)/g;
  const matches = [...stepSource.matchAll(stepPattern)];
  for (const m of matches) {
    plan.steps.push({
      id: parseInt(m[1], 10),
      description: m[2].trim().slice(0, 100),
      status: 'pending', // pending | in_progress | completed | skipped | error
      stepType: inferStepType(m[2]), // hardened | flexible | human-gate
      blocks: [],        // Step IDs that this step blocks
      blockedBy: [],     // Step IDs that must complete before this step
    });
  }

  // Auto-infer sequential dependencies: each step blocks the next
  for (let i = 0; i < plan.steps.length - 1; i++) {
    plan.steps[i].blocks.push(plan.steps[i + 1].id);
    plan.steps[i + 1].blockedBy.push(plan.steps[i].id);
  }

  // Parse explicit dependency annotations (e.g., "[depends: 1,3]" or "[after: 2]")
  for (const step of plan.steps) {
    const depMatch = step.description.match(/\[(?:depends|after|依赖)[:\s]+([0-9,\s]+)\]/i);
    if (depMatch) {
      const depIds = depMatch[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      step.blockedBy = [...new Set([...step.blockedBy, ...depIds])];
      step.description = step.description.replace(depMatch[0], '').trim();
      // Update reverse references
      for (const depId of depIds) {
        const depStep = plan.steps.find(s => s.id === depId);
        if (depStep && !depStep.blocks.includes(step.id)) {
          depStep.blocks.push(step.id);
        }
      }
    }
  }

  // ── 各段抽取(标题锚定,逐条/散文)。新旧标题都兼容,缺段即留默认空。 ──
  // 「需要的数据」(旧扁平模板);富模板将数据并入「计划」段,故此处缺省为空也正常。
  plan.dataNeeds = _sectionItems(_grabSection(text, '需要的数据'));
  // 「预计结果」(富) / 「预计输出」(旧)。
  plan.expectedOutputs = _sectionItems(_grabSection(text, '预计结果|预计输出'));
  // 「风险与对策」(富) / 「风险与注意事项」(旧):标题含「风险」即命中。
  plan.risks = _sectionItems(_grabSection(text, '风险'));
  // 富计划新增段(旧扁平计划无此标题 → 空,向后兼容)。
  plan.why = _sectionText(_grabSection(text, '为什么做|背景|动机'));
  plan.currentState = _sectionItems(_grabSection(text, '关键现状|现状'));
  plan.verification = _sectionItems(_grabSection(text, '验证'));
  plan.wrapup = _sectionItems(_grabSection(text, '收尾'));

  return plan;
}

/**
 * Present plan for user approval via interactive prompt.
 * @param {object} plan - parsed plan object
 * @param {object} renderer - aiRenderer module
 * @param {readline.Interface} rl - existing readline interface
 * @returns {Promise<{approved: boolean, modifications: string[]}>}
 */
async function presentForApproval(plan, renderer, rl) {
  // Goal mode: 跳过交互审批，直接自动确认
  if (process.env.KHY_GOAL_MODE_ACTIVE === 'true') {
    return { approved: true, modifications: [] };
  }

  let _chalk;
  const c = () => (_chalk ??= (require('chalk').default || require('chalk')));

  // 「为什么做」放最前:让用户一眼看懂动机(富计划独有,缺则跳过)。
  if (plan.why) {
    console.log('');
    console.log(c().cyan('  为什么做:'));
    console.log(c().dim(`    ${plan.why}`));
  }

  // 「关键现状」:实地查证的证据,提升计划可信度(富计划独有,缺则跳过)。
  if (Array.isArray(plan.currentState) && plan.currentState.length > 0) {
    console.log('');
    console.log(c().dim('  关键现状:'));
    plan.currentState.forEach(s => console.log(c().dim(`    • ${s}`)));
  }

  // Render plan as task checklist
  console.log('');
  const planTracker = new renderer.TaskPlanTracker();
  for (const step of plan.steps) {
    planTracker.addTask(stepTypeTag(step.stepType) + step.description);
  }
  planTracker.render();

  // 预计结果(富/旧均可能有)。
  if (Array.isArray(plan.expectedOutputs) && plan.expectedOutputs.length > 0) {
    console.log('');
    console.log(c().dim('  预计结果:'));
    plan.expectedOutputs.forEach(o => console.log(c().dim(`    • ${o}`)));
  }

  if (plan.dataNeeds.length > 0) {
    console.log('');
    console.log(c().dim('  需要的数据:'));
    plan.dataNeeds.forEach(d => console.log(c().dim(`    • ${d}`)));
  }

  if (plan.risks.length > 0) {
    console.log('');
    console.log(c().yellow('  风险与对策:'));
    plan.risks.forEach(r => console.log(c().yellow(`    ⚠ ${r}`)));
  }

  // 「验证」:完成后怎么确认真成了(富计划独有,缺则跳过)。
  if (Array.isArray(plan.verification) && plan.verification.length > 0) {
    console.log('');
    console.log(c().green('  验证:'));
    plan.verification.forEach(v => console.log(c().green(`    ✓ ${v}`)));
  }

  // 「收尾」:残留风险/未做项/是否提交/下一步(富计划独有,缺则跳过)。
  if (Array.isArray(plan.wrapup) && plan.wrapup.length > 0) {
    console.log('');
    console.log(c().dim('  收尾:'));
    plan.wrapup.forEach(w => console.log(c().dim(`    ↳ ${w}`)));
  }

  if (plan.steps.some(s => s.stepType === 'human-gate')) {
    console.log('');
    console.log(c().red('  🔒 人闸门步骤将在执行前暂停，需你逐一确认'));
  }

  console.log('');
  console.log(c().cyan('  操作: ') +
    c().white('Enter') + c().dim(' 确认执行 · ') +
    c().white('skip N') + c().dim(' 跳过步骤 · ') +
    c().white('edit N 描述') + c().dim(' 修改步骤 · ') +
    c().white('add after N 描述') + c().dim(' 新增步骤 · ') +
    c().white('n') + c().dim(' 取消')
  );
  console.log(c().dim('  输入 ? 查看示例；支持英文/中文命令，例如：跳过 2, 修改 1 更新描述'));

  return new Promise((resolve) => {
    const autoApproveMs = Math.max(0, parseInt(process.env.KHY_PLAN_AUTO_APPROVE_MS || '0', 10));
    let resolved = false;
    let autoTimer = null;

    const done = (payload) => {
      if (resolved) return;
      resolved = true;
      if (autoTimer) clearTimeout(autoTimer);
      resolve(payload);
    };

    if (autoApproveMs > 0) {
      const autoApproveSec = autoApproveMs >= 1000
        ? `${Math.round(autoApproveMs / 1000)}`
        : `${(autoApproveMs / 1000).toFixed(1)}`;
      console.log(c().dim(`  ${autoApproveSec} 秒无输入将自动确认执行`));
      autoTimer = setTimeout(() => {
        console.log(c().dim('  ⏱ 已自动确认，开始执行计划'));
        done({ approved: true, modifications: [] });
      }, autoApproveMs);
      if (autoTimer.unref) autoTimer.unref();
    }

    const askApproval = () => {
      rl.question(c().dim('  计划确认 > '), (answer) => {
        if (autoTimer) {
          clearTimeout(autoTimer);
          autoTimer = null;
        }
        const raw = String(answer || '').trim();
        const trimmed = raw.toLowerCase();

        if (!trimmed || ['y', 'yes', 'ok', '确认', '执行', '继续'].includes(trimmed)) {
          done({ approved: true, modifications: [] });
          return;
        }

        if (['n', 'no', '取消', 'abort', 'stop'].includes(trimmed)) {
          _state = 'idle';
          _currentPlan = null;
          done({ approved: false, modifications: [] });
          return;
        }

        if (trimmed === '?' || trimmed === 'help' || trimmed === 'h') {
          console.log(c().dim('  示例:'));
          console.log(c().dim('    skip 2'));
          console.log(c().dim('    edit 1 补充输入数据下载与校验'));
          console.log(c().dim('    add after 2 运行自测并记录关键输出'));
          askApproval();
          return;
        }

        const modifications = [];
        const invalidCommands = [];
        const commands = raw.split(/[;,]/).map(s => s.trim()).filter(Boolean);

        for (const cmd of commands) {
          const skipMatch = cmd.match(/^(?:skip|跳过)\s+(\d+)$/i);
          const editMatch = cmd.match(/^(?:edit|修改)\s+(\d+)\s+(.+)$/i);
          const addMatch = cmd.match(/^(?:add|添加)\s+(?:after\s+)?(\d+)\s+(.+)$/i) || cmd.match(/^在\s*(\d+)\s*后(?:添加)?\s+(.+)$/i);

          if (skipMatch) {
            const idx = parseInt(skipMatch[1], 10) - 1;
            if (idx >= 0 && idx < plan.steps.length) {
              plan.steps[idx].status = 'skipped';
              modifications.push(`Skipped step ${skipMatch[1]}`);
            } else {
              invalidCommands.push(`${cmd} (step out of range)`);
            }
            continue;
          }

          if (editMatch) {
            const idx = parseInt(editMatch[1], 10) - 1;
            if (idx >= 0 && idx < plan.steps.length) {
              plan.steps[idx].description = editMatch[2].trim();
              plan.steps[idx].stepType = inferStepType(editMatch[2]);
              modifications.push(`Edited step ${editMatch[1]}`);
            } else {
              invalidCommands.push(`${cmd} (step out of range)`);
            }
            continue;
          }

          if (addMatch) {
            const afterIdx = parseInt(addMatch[1], 10);
            if (Number.isNaN(afterIdx) || afterIdx < 0 || afterIdx > plan.steps.length) {
              invalidCommands.push(`${cmd} (step out of range)`);
              continue;
            }
            plan.steps.splice(afterIdx, 0, {
              id: afterIdx + 1,
              description: addMatch[2].trim(),
              status: 'pending',
              stepType: inferStepType(addMatch[2]),
            });
            plan.steps.forEach((s, i) => { s.id = i + 1; });
            modifications.push(`Added step after ${addMatch[1]}`);
            continue;
          }

          invalidCommands.push(cmd);
        }

        if (invalidCommands.length > 0) {
          console.log(c().yellow(`  未识别输入: ${invalidCommands.join(' ; ')}`));
          console.log(c().dim('  可用格式: Enter / skip N / edit N 描述 / add after N 描述 / n'));
          if (modifications.length === 0) {
            askApproval();
            return;
          }
        }

        done({ approved: true, modifications });
      });
    };

    askApproval();
  });
}

/**
 * Execute plan steps one by one with live progress tracking.
 * @param {object} plan - the plan with steps
 * @param {object} opts - { ai, renderer, rl, route, parseInput, onStepResult, onStepStart }
 * @returns {Array<{step: object, result: object}>}
 */
async function executePlanSteps(plan, opts) {
  // [P7] Continuous main-loop execution (default off; zero behavior change).
  // When KHY_PLAN_CONTINUOUS=1, an approved plan is handed to ONE chat() call as
  // a single structured task message so its tool-use loop executes the steps
  // continuously with cross-step context, rather than N isolated per-step chat()
  // calls (the legacy executor below). Aligns with CC, where an approved plan
  // runs inside the same agent loop. See _executePlanContinuous.
  if (String(process.env.KHY_PLAN_CONTINUOUS || '').trim() === '1') {
    return _executePlanContinuous(plan, opts);
  }

  const { ai: aiModule, renderer, rl, onStepResult, onStepStart } = opts;
  _state = 'executing';

  // 计划已审批，执行阶段自动提升权限，每个步骤作为小目标自主完成。
  // 注意：自动提升会置 KHY_GOAL_MODE_ACTIVE=true，因此不能用该 env 判断人闸门是否
  // 放行——否则永远自我绕过。activateIfNeeded 返回 null 表示用户执行前已自主开启 Goal
  // Mode（此时尊重其自主意图，放行人闸门）；返回非 null 表示是本流程刚提升的（人闸门仍生效）。
  let _execSavedState = null;
  let _userOptedAutonomous = false;
  try {
    const goalModeService = require('./goalModeService');
    _execSavedState = goalModeService.activateIfNeeded();
    _userOptedAutonomous = _execSavedState === null;
  } catch { /* goalModeService not available */ }

  const stepTimeoutMs = parseInt(process.env.KHY_PLAN_STEP_TIMEOUT_MS || '180000', 10);
  const maxStepRetry = Math.max(0, parseInt(process.env.KHY_PLAN_STEP_RETRY || '1', 10));

  const results = [];
  const planTracker = new renderer.TaskPlanTracker({ panelMode: true });

  // Add all non-skipped steps
  const activeSteps = plan.steps.filter(s => s.status !== 'skipped');
  const totalSteps = activeSteps.length;
  const previewStyle = getPlanPreviewStyle();
  for (const step of activeSteps) {
    planTracker.addTask(stepTypeTag(step.stepType) + step.description);
  }
  planTracker.render();

  for (let i = 0; i < activeSteps.length; i++) {
    const step = activeSteps[i];
    renderer.printStepLine('active', '准备执行', `第 ${step.id} 步`, `进度 ${i + 1}/${totalSteps}`);
    renderer.printStepDetail(buildStepPreviewText(step.description, i, totalSteps, previewStyle), false);
    if (typeof onStepStart === 'function') {
      try { onStepStart({ step, index: i, total: totalSteps }); } catch { /* best effort */ }
    }
    planTracker.start(i);

    // 人闸门：高危/破坏性步骤执行前暂停确认（Goal Mode 或 KHY_HUMAN_GATE=off 时自动放行）
    if (requiresHumanGateStep(step.stepType, _userOptedAutonomous)) {
      const gate = await _confirmHumanGate(step, rl, renderer);
      if (!gate) {
        planTracker.skip ? planTracker.skip(i) : planTracker.complete(i);
        step.status = 'skipped';
        const skipped = { step, result: { skipped: true, reason: 'human-gate denied' } };
        results.push(skipped);
        if (typeof onStepResult === 'function') {
          try { onStepResult(skipped); } catch { /* best effort */ }
        }
        continue;
      }
    }

    const stepStartedAt = Date.now();

    try {
      // Execute step via AI with follow-up flag (prevents recursive plan mode)
      const basePrompt = `[执行计划步骤 ${step.id}/${plan.steps.length}]\n\n任务: ${step.description}\n\n要求:\n1) 必须实际执行，不要只描述计划。\n2) 如果涉及文件创建/修改，请直接完成并在回复中给出具体文件路径。\n3) 如果涉及命令执行，请给出命令与关键输出。\n4) 若执行失败，明确说明失败原因。`;

      let attempt = 0;
      let acceptedResult = null;
      let lastResult = null;
      let lastValidation = { ok: false, reason: 'unknown' };
      const maxAttempts = maxStepRetry + 1;

      while (attempt <= maxStepRetry) {
        const attemptNumber = attempt + 1;
        const prompt = attempt === 0
          ? basePrompt
          : `${basePrompt}\n\n上次执行未通过校验：${lastValidation.reason}\n请重新执行该步骤，并提供可验证证据。`;

        renderer.printStepDetail(buildAttemptPreviewText(step.id, attemptNumber, maxAttempts, previewStyle), false);

        const result = await runWithActivityTimeout(
          ({ touch }) => aiModule.chat(prompt, {
            _isFollowUp: true,
            onChunk: () => { touch(); },
            onStatus: () => { touch(); },
            onControlRequest: () => { touch(); },
          }),
          stepTimeoutMs,
          `Plan step timeout after ${stepTimeoutMs}ms`
        );
        lastResult = result;
        lastValidation = validateStepResult(step, plan, result, stepStartedAt);
        if (lastValidation.ok) {
          acceptedResult = result;
          break;
        }

        renderer.printStepDetail(`步骤 ${step.id} 校验未通过: ${shortenReason(lastValidation.reason)}`, false);
        attempt += 1;
      }

      if (acceptedResult) {
        planTracker.complete(i);
        step.status = 'completed';
        const finalStepResult = { step, result: { ...acceptedResult, _planAttempts: attempt + 1 } };
        results.push(finalStepResult);
        if (typeof onStepResult === 'function') {
          try { onStepResult(finalStepResult); } catch { /* best effort */ }
        }
      } else {
        planTracker.fail(i);
        step.status = 'error';
        const errorMsg = lastValidation.reason || (lastResult && lastResult.reply ? lastResult.reply : 'No response');
        renderer.printStepDetail(`步骤 ${step.id} 失败: ${shortenReason(errorMsg)}`, false);
        const finalStepResult = { step, result: { ...lastResult, error: errorMsg, _planAttempts: maxAttempts } };
        results.push(finalStepResult);
        if (typeof onStepResult === 'function') {
          try { onStepResult(finalStepResult); } catch { /* best effort */ }
        }
      }
    } catch (err) {
      planTracker.fail(i);
      step.status = 'error';
      const finalStepResult = { step, result: { error: err.message } };
      results.push(finalStepResult);
      if (typeof onStepResult === 'function') {
        try { onStepResult(finalStepResult); } catch { /* best effort */ }
      }
    }
  }

  _state = 'complete';
  _currentPlan = null;

  // 确保任务面板清理
  try { require('./taskPanelState').clearTasks(); } catch { /* ignore */ }

  // 恢复权限
  if (_execSavedState) {
    try {
      const goalModeService = require('./goalModeService');
      goalModeService.deactivateIfNeeded(_execSavedState);
    } catch { /* best effort */ }
  }

  // Persist final plan state
  if (_currentPlanSlug) {
    try { updatePersistedPlan(_currentPlanSlug, { state: 'complete', plan }); } catch { /* best effort */ }
    _currentPlanSlug = null;
  }

  return results;
}

/**
 * [P7] Plain-text (no chalk) step-type label for the serialized plan message —
 * stepTypeTag() injects ANSI color codes which must not leak into the prompt.
 * @param {string} stepType
 * @returns {string}
 */
function _stepTypeLabelPlain(stepType) {
  if (stepType === 'human-gate') return '[人闸门] ';
  if (stepType === 'hardened') return '[固化] ';
  if (stepType === 'flexible') return '[灵活] ';
  return '';
}

/**
 * [P7] Serialize an approved plan into a single structured task message for
 * continuous main-loop execution. The model is asked to execute the steps
 * step-by-step within one loop, preserving cross-step context.
 * @param {object} plan
 * @param {Array<object>} steps - runnable (non-skipped, human-gate-approved) steps
 * @returns {string}
 */
function _serializeContinuousPlanMessage(plan, steps) {
  const lines = steps.map((s, i) => `${i + 1}) ${_stepTypeLabelPlain(s.stepType)}${s.description}`);
  return [
    `[连续执行已批准的计划 — 共 ${steps.length} 步]`,
    '',
    '以下是已经过用户审批的执行计划。请在同一连续过程中逐步执行，跨步骤保持上下文连续，',
    '并在推进时简要说明每一步的结果。',
    '',
    '步骤清单:',
    ...lines,
    '',
    '要求:',
    '1) 必须实际执行（创建/修改文件、运行命令），不要只描述计划。',
    '2) 涉及文件请给出具体路径；涉及命令请给出命令与关键输出。',
    '3) 后续步骤可直接复用前序步骤的结果，无需重复劳动。',
    '4) 若某步失败，明确说明原因后继续执行不依赖它的后续步骤。',
    '5) 全部完成后给出简要总结。',
  ].join('\n');
}

/**
 * [P7] Continuous main-loop plan executor (KHY_PLAN_CONTINUOUS=1).
 *
 * Hands the whole approved plan to ONE aiModule.chat() call as a single
 * structured task message; its tool-use loop runs the steps continuously with
 * cross-step context preserved, instead of N isolated per-step chat() calls.
 * Human-gate steps are still confirmed up front and excluded if denied. Goal
 * mode is auto-activated (as in the legacy executor) so approved non-gated work
 * runs autonomously while the explicit human-gate confirmations remain in force.
 * @param {object} plan
 * @param {object} opts - { ai, renderer, rl, onStepResult, onStepStart, onControlRequest }
 * @returns {Array<{step: object, result: object}>}
 */
async function _executePlanContinuous(plan, opts) {
  const { ai: aiModule, renderer, rl, onStepResult, onStepStart } = opts;
  _state = 'executing';

  let _execSavedState = null;
  let _userOptedAutonomous = false;
  try {
    const goalModeService = require('./goalModeService');
    _execSavedState = goalModeService.activateIfNeeded();
    _userOptedAutonomous = _execSavedState === null;
  } catch { /* goalModeService not available */ }

  const results = [];
  const activeSteps = plan.steps.filter(s => s.status !== 'skipped');

  // Human-gate steps: confirm up front; denied steps are excluded from the run
  // (still records a skipped result so callers see the same shape as legacy).
  const runnableSteps = [];
  for (const step of activeSteps) {
    if (requiresHumanGateStep(step.stepType, _userOptedAutonomous)) {
      const gate = await _confirmHumanGate(step, rl, renderer);
      if (!gate) {
        step.status = 'skipped';
        const skipped = { step, result: { skipped: true, reason: 'human-gate denied' } };
        results.push(skipped);
        if (typeof onStepResult === 'function') {
          try { onStepResult(skipped); } catch { /* best effort */ }
        }
        continue;
      }
    }
    runnableSteps.push(step);
  }

  const totalSteps = runnableSteps.length;
  const planTracker = new renderer.TaskPlanTracker({ panelMode: true });
  for (const step of runnableSteps) {
    planTracker.addTask(stepTypeTag(step.stepType) + step.description);
  }
  planTracker.render();

  if (totalSteps > 0) {
    if (typeof onStepStart === 'function') {
      try { onStepStart({ step: runnableSteps[0], index: 0, total: totalSteps }); } catch { /* best effort */ }
    }
    for (let i = 0; i < totalSteps; i++) planTracker.start(i);

    renderer.printStepLine('active', '连续执行', `共 ${totalSteps} 步`, '已批准计划交由主循环连续执行');

    const message = _serializeContinuousPlanMessage(plan, runnableSteps);
    let result = null;
    let runError = null;
    try {
      result = await aiModule.chat(message, {
        _isFollowUp: true,
        _planContinuous: true,
        onChunk: () => {},
        onStatus: () => {},
        onControlRequest: typeof opts.onControlRequest === 'function' ? opts.onControlRequest : undefined,
      });
    } catch (err) {
      runError = err;
    }

    const succeeded = !runError && !!result && !result.errorType;
    for (let i = 0; i < totalSteps; i++) {
      const step = runnableSteps[i];
      if (succeeded) {
        planTracker.complete(i);
        step.status = 'completed';
      } else {
        planTracker.fail(i);
        step.status = 'error';
      }
      const stepResult = succeeded
        ? { step, result: { ...result, _planContinuous: true } }
        : {
            step,
            result: {
              error: runError ? runError.message : ((result && result.errorType) || 'continuous run failed'),
              _planContinuous: true,
            },
          };
      results.push(stepResult);
      if (typeof onStepResult === 'function') {
        try { onStepResult(stepResult); } catch { /* best effort */ }
      }
    }
  }

  _state = 'complete';
  _currentPlan = null;

  try { require('./taskPanelState').clearTasks(); } catch { /* ignore */ }

  if (_execSavedState) {
    try {
      const goalModeService = require('./goalModeService');
      goalModeService.deactivateIfNeeded(_execSavedState);
    } catch { /* best effort */ }
  }

  if (_currentPlanSlug) {
    try { updatePersistedPlan(_currentPlanSlug, { state: 'complete', plan }); } catch { /* best effort */ }
    _currentPlanSlug = null;
  }

  return results;
}

/**
 * Get current plan mode state.
 */
function getState() {
  return _state;
}

/**
 * Whether the agent is currently in the plan read-only window — i.e. a plan is
 * being generated or reviewed but the user has not yet approved it. During this
 * window toolCalling hard-denies non-read-only tools (CC-aligned plan sandbox).
 * Once the plan is approved (`executing`) or aborted (`idle`/`complete`), writes
 * are allowed again. See the [P4] gate in toolCalling.requestPermission caller.
 * @returns {boolean}
 */
function isPlanReadOnly() {
  return _state === 'generating' || _state === 'reviewing';
}

/**
 * Reset plan mode to idle.
 */
function reset() {
  _state = 'idle';
  _currentPlan = null;
  _currentPlanSlug = null;
}

module.exports = {
  enterPlanMode,
  parsePlanFromResponse,
  inferStepType,
  stepTypeTag,
  presentForApproval,
  executePlanSteps,
  getState,
  isPlanReadOnly,
  reset,
  savePlan,
  updatePersistedPlan,
  loadPersistedPlan,
  listPersistedPlans,
  PLAN_PROMPT,
};

// 把只读状态读取器登记到零依赖叶子（[DESIGN-ARCH-051] §6.11）：toolCalling
// 经叶子读本标志，从而不再 import 计划链，断开巨型 SCC 的一条只读查询边。
require('./planModeSink').setPlanReadOnlyProvider(isPlanReadOnly);
