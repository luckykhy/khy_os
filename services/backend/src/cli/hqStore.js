'use strict';

/**
 * hqStore.js — 任务/Bug 状态真源的读写叶子（零副作用、可单测）。
 *
 * 背景：khy-os-hq（指挥部）的能力于 2026-09-17 被吸收进本仓库，数据落
 * `.ai/hq/`（见 `docs/03_DESIGN_设计/[DESIGN-ARCH-118] HQ 能力吸收与多机协作规范.md`）。
 * 原 Python 脚本（`next.py` / `new_bug.py` / `update_status.py` / `hq_common.py`）
 * 已由 `khy hq …` 取代。本模块是那批脚本中**纯逻辑**部分的 JS 等价物。
 *
 * 分工（遵循「纯叶子 + 薄 IO 层」契约）：
 *   - 本文件      = 纯逻辑 + 最小 IO（路径解析、JSON 读写、状态机、租约计算）
 *   - `handlers/hq.js` = 薄 IO/呈现层（chalk 输出、剪贴板、CLI 参数）
 *
 * 设计纪律：
 *   1. **状态机是硬约束**：`canTransition` 是唯一裁决点，非法迁移必须被当场拒绝，
 *      与 HQ 原行为逐字对齐（`hq_common.py` 的 `BUG_TRANSITIONS` / `TASK_TRANSITIONS`）。
 *   2. **fail-soft**：可预期的失败返回 `{ ok: false, error }`，不抛异常。
 *   3. **路径零硬编码**：仓库根从本文件位置向上推导（`src/cli` → `src` → `backend`
 *      → `services` → 仓库根），不出现盘符或绝对路径。
 *   4. **写入是「改完再写」而非「先写后校」**：所有校验在 `saveJson` 之前完成，
 *      失败时磁盘保持原状。
 *
 * @module cli/hqStore
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 路径解析 ──────────────────────────────────────────────────────

/** 仓库根：src/cli → src → services/backend → services → <repo> */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** HQ 数据根（点目录，免于 LAYOUT 层级登记——见 check-repo-layout.js 的点目录豁免）。 */
const HQ_DIR = path.join(REPO_ROOT, '.ai', 'hq');
const PROMPTS_DIR = path.join(HQ_DIR, 'prompts');
const LOGS_DIR = path.join(HQ_DIR, 'logs');

/** 验收存证根：`.khy/feedback/`（与 `check-agent-feedback.js` 的 EVIDENCE 契约同址）。 */
const FEEDBACK_DIR = path.join(REPO_ROOT, '.khy', 'feedback');

const BUGS_JSON = path.join(HQ_DIR, 'BUGS.json');
const PROGRESS_JSON = path.join(HQ_DIR, 'PROGRESS.json');
const ROADMAP_MD = path.join(HQ_DIR, 'ROADMAP.md');
const MODELS_JSON = path.join(HQ_DIR, 'MODELS.json');
const CONTEXT_MD = path.join(HQ_DIR, 'CONTEXT.md');

/**
 * 允许 `KHY_HQ_DIR` 覆盖数据根——供测试夹具与「多机不同工作副本」场景使用。
 * 未设或为空则用仓内默认 `.ai/hq/`。绝不读盘、绝不抛。
 */
function hqDir(env = process.env) {
  const override = env && env.KHY_HQ_DIR;
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return HQ_DIR;
}

/**
 * 解析验收存证根，允许 `KHY_FEEDBACK_DIR` 覆盖。
 *
 * 与 `hqDir()` 同一条纪律：**测试注入点必须真的生效**。验收清算会在
 * `.khy/feedback/<name>/` 下找 `acceptance.md`，若没有覆盖点，任何对该判据的
 * 单测/反向验证都会写进真实存证目录、污染真实数据 —— 那样测试就只能靠
 * 「事后删除」兜底，而删除本身就是一次污染。故显式给一个覆盖点。
 *
 * 未设或为空则用仓内默认 `.khy/feedback/`。绝不读盘、绝不抛。
 */
function feedbackDir(env = process.env) {
  const override = env && env.KHY_FEEDBACK_DIR;
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return FEEDBACK_DIR;
}

/**
 * 按显式 root 解析全部真源路径。
 *
 * `root` 缺省时**走 `hqDir()`**（即尊重 `KHY_HQ_DIR` 覆盖），而不是直接落 `HQ_DIR` ——
 * 否则环境变量覆盖形同虚设：调用方一律传 `null`，测试夹具会被静默绕过、写进真实数据。
 * 这是「测试注入点必须真的生效」的硬要求，不是可选便利。
 *
 * 两条支路都过 `path.resolve`，令同一目录的 `D:/x` 与 `D:\\x` 两种写法归一 ——
 * 否则同一夹具在不同断言里得到不同字符串，比较会假性失败。
 */
function paths(root, env = process.env) {
  const base = path.resolve(root || hqDir(env));
  return {
    root: base,
    prompts: path.join(base, 'prompts'),
    logs: path.join(base, 'logs'),
    bugs: path.join(base, 'BUGS.json'),
    progress: path.join(base, 'PROGRESS.json'),
    roadmap: path.join(base, 'ROADMAP.md'),
    models: path.join(base, 'MODELS.json'),
    context: path.join(base, 'CONTEXT.md'),
  };
}

// ── 枚举（与 HQ `hq_common.py` 逐字对齐）────────────────────────

const DOMAINS = [
  'cli',
  'gateway',
  'services',
  'kernel',
  'frontend',
  'khyquant',
  'platform',
  'packaging',
  'cross',
];
const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
const TASK_TYPES = ['feature', 'refactor', 'performance', 'quality', 'docs'];
const TASK_STATES = ['todo', 'doing', 'review', 'done'];
const BUG_STATES = ['open', 'in_progress', 'pending_verify', 'closed', 'wontfix'];

/**
 * `evidence` 字段的命名约定：`<task-id>-<slug>`，小写字母/数字/`.`/`_`/`-`。
 *
 * 为什么要有约定：2026-09-23 实测 `.khy/feedback/` 下 52 个存证目录**三种前缀混用**
 * （`BUG-116-…` / `2026-09-18-…` / `g69-…`），无法把目录映射回任务 ⇒
 * 存证质量很高但**实际不可检索**。约定只对**新声明 `evidence` 的条目**生效，
 * 存量目录一律不追溯、不改名（同 `cod/conf/size` 的「出现即校验」范式）。
 */
const EVIDENCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 验收条目的结果枚举。`SKIP` 必须带理由，否则等于没验收。 */
const ACCEPT_RESULTS = ['PASS', 'FAIL', 'SKIP'];

/** Bug 状态机：唯一裁决表。 */
const BUG_TRANSITIONS = {
  open: ['in_progress', 'wontfix'],
  in_progress: ['pending_verify', 'open'],
  pending_verify: ['closed', 'in_progress'],
  closed: [],
  wontfix: ['open'],
};

/** 任务状态机：唯一裁决表。 */
const TASK_TRANSITIONS = {
  todo: ['doing'],
  doing: ['review', 'todo'],
  review: ['done', 'doing'],
  done: [],
};

/** 任务类型 → 提示词模板（相对 `.../prompts/`）。 */
const TYPE_TO_TEMPLATE = {
  bug: path.join('bugfix', '01-修复指定Bug.md'),
  verify: path.join('bugfix', '02-回归验证.md'),
  feature: path.join('feature', '01-新功能开发.md'),
  refactor: path.join('refactor', '01-模块重构.md'),
  performance: path.join('performance', '01-性能优化.md'),
  quality: path.join('quality', '01-测试补齐.md'),
  docs: path.join('docs', '01-文档完善.md'),
  distill: path.join('meta', '01-能力沉淀.md'),
  onboard: path.join('meta', '02-新机器接入.md'),
  'verify-sync': path.join('meta', '03-同步就绪验证.md'),
  worker: path.join('meta', '04-协作开发端.md'),
  gov: path.join('governance', '01-板块规则与协议总纲.md'),
  'crdt-collab': path.join('feature', 'CRDT-实时协作编辑引擎.md'),
};

const SEVERITY_NAME = { P0: 'P0 阻断', P1: 'P1 严重', P2: 'P2 一般', P3: 'P3 轻微' };
const TYPE_NAME = {
  feature: '新功能',
  refactor: '重构',
  performance: '性能',
  quality: '质量',
  docs: '文档',
};
const KIND_NAME = {
  distill: '能力沉淀',
  bug: 'Bug修复',
  verify: '回归验证',
  onboard: '新机器接入',
  'verify-sync': '同步就绪验证',
  worker: '协作开发端',
  gov: '板块规则治理',
};

/** 多机协作的租约时长（分钟）。 */
const LEASE_MINUTES = 120;

// ── 基础 IO（fail-soft）──────────────────────────────────────────

/**
 * 读 JSON。畸形或缺失由调用方决定如何降级——此处原样抛出，便于调用方
 * 区分「文件不存在」与「文件损坏」。薄 IO 层负责包装成 `{ok:false,error}`。
 */
function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

/** 安全读 JSON：返回 `{ok,data,error}`，绝不抛。 */
function readJsonSafe(file) {
  try {
    return { ok: true, data: loadJson(file) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * 写 JSON：注入 `last_updated`，`ensure_ascii=False` 等价（UTF-8 + 中文原样），
 * 缩进 2 空格，末尾换行 —— 与 HQ `hq_common.save_json` 逐字节同规则，
 * 保证双轨期两个写入口产出同一形态的文件。
 */
function saveJson(file, data) {
  const payload = Object.assign({}, data, { last_updated: today() });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return payload;
}

/** `YYYY-MM-DD`（本地时区，与 HQ 一致）。 */
function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ISO 本地时间（秒精度），与 Python `isoformat(timespec="seconds")` 同形。 */
function isoLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 解析 ISO 串；失败返回 null（不抛）。 */
function parseIso(s) {
  const t = Date.parse(String(s || ''));
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * 追加一行活动日志（fail-open：日志永远不该让主流程失败）。
 * 与 HQ 一致写到 `<hq>/logs/activity.log`；该目录 gitignore。
 */
function log(action, root) {
  try {
    const dir = path.join(root || HQ_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp =
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    fs.appendFileSync(path.join(dir, 'activity.log'), `[${stamp}] ${action}\n`, 'utf-8');
  } catch {
    /* fail-open */
  }
}

// ── 状态机 ───────────────────────────────────────────────────────

/**
 * 状态机唯一裁决点。
 * @param {'bug'|'task'} kind
 * @param {string} from
 * @param {string} to
 * @returns {{ok: boolean, allowed: string[], error?: string}}
 */
function canTransition(kind, from, to) {
  const table = kind === 'bug' ? BUG_TRANSITIONS : TASK_TRANSITIONS;
  if (!Object.prototype.hasOwnProperty.call(table, from)) {
    return { ok: false, allowed: [], error: `未知当前状态: ${from}` };
  }
  const allowed = table[from];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      allowed,
      error:
        `非法状态迁移 ${from} -> ${to}。允许: ` +
        (allowed.length ? allowed.join(', ') : '(终态，不可再变)'),
    };
  }
  return { ok: true, allowed };
}

/** 校验状态串本身是否合法（区别于「该状态是否可达」）。 */
function isValidState(kind, state) {
  return kind === 'bug' ? BUG_STATES.includes(state) : TASK_STATES.includes(state);
}

// ── 机器身份与租约（多机协作核心）───────────────────────────────

/**
 * 本机稳定标识：`KHY_MACHINE_ID` 优先，否则 hostname。
 * 同一台机器上二者常只差大小写，故所有比较一律走 `sameMachine`。
 */
function machineId(env = process.env) {
  const override = env && env.KHY_MACHINE_ID;
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  try {
    return os.hostname() || 'unknown-machine';
  } catch {
    return 'unknown-machine';
  }
}

/**
 * 机器名大小写不敏感比较。
 *
 * 为什么必须如此：同一台 Windows 机器的 hostname 与显式设置的 `KHY_MACHINE_ID`
 * 常常只差大小写（`2541UGH10NVUR7S` vs `2541ugh10nvur7s`）。字面比较会让这台机器
 * 把自己持有的租约误判成「他机占用」，从而把自己锁死到租约到期为止。
 */
function sameMachine(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/** 条目是否被**他机**以**存活租约**占用。 */
function heldByOther(item, me, now = new Date()) {
  const claimedBy = item && item.claimed_by;
  if (!claimedBy || sameMachine(claimedBy, me)) {
    return false;
  }
  const exp = parseIso(item.lease_expires);
  if (!exp) {
    return false;
  }
  return exp.getTime() > now.getTime();
}

/** 计算租约戳（纯函数，便于单测注入时钟）。 */
function stampClaim(item, machine, leaseMinutes = LEASE_MINUTES, now = new Date()) {
  const next = Object.assign({}, item);
  next.claimed_by = machine;
  next.claimed_at = isoLocal(now);
  next.lease_expires = isoLocal(new Date(now.getTime() + leaseMinutes * 60000));
  return next;
}

/** 清除占用三字段（原地修改并返回）。 */
function clearClaim(item) {
  if (!item || typeof item !== 'object') {
    return item;
  }
  delete item.claimed_by;
  delete item.claimed_at;
  delete item.lease_expires;
  return item;
}

// ── 载入与选取 ───────────────────────────────────────────────────

/** 载入 Bug 档与任务档（含各自顶层容器字段）。 */
function loadAll(root) {
  const p = paths(root);
  const bugs = readJsonSafe(p.bugs);
  const progress = readJsonSafe(p.progress);
  return { paths: p, bugs, progress };
}

/** 按 ID 找条目；找不到返回 null。 */
function findItem(list, id) {
  if (!Array.isArray(list)) {
    return null;
  }
  return list.find((x) => x && x.id === id) || null;
}

/** 严重度排序键（P0 < P1 < P2 < P3 < 其余）。 */
function severityKey(s) {
  const i = SEVERITIES.indexOf(s);
  return i === -1 ? SEVERITIES.length : i;
}

// ── PROCESS-102 五档瀑布：G0 健康 → G1 救火 → G2 要事 → G3 次事 → G4 疑问 ──

const SIZE_WEIGHT = { S: 1, M: 2, L: 3 };

/** WSJF 轻评分：cod(1-5) × conf(1-3) ÷ size(S/M/L→1/2/3)；字段不全返回 null。 */
function wsjfScore(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  if (!Number.isInteger(item.cod) || item.cod < 1 || item.cod > 5) {
    return null;
  }
  if (!Number.isInteger(item.conf) || item.conf < 1 || item.conf > 3) {
    return null;
  }
  const w = SIZE_WEIGHT[String(item.size || '').toUpperCase()];
  if (!w) {
    return null;
  }
  return (item.cod * item.conf) / w;
}

/** 按严重度取头部并列组（稳定，但**不**用顺序决胜——并列交给评分/ask）。 */
function _topSeverityGroup(list, sevOf) {
  const sorted = list
    .slice()
    .sort((a, b) => severityKey(sevOf(a)) - severityKey(sevOf(b)));
  if (!sorted.length) {
    return [];
  }
  const top = severityKey(sevOf(sorted[0]));
  return sorted.filter((x) => severityKey(sevOf(x)) === top);
}

function _round2(x) {
  return Math.round(x * 100) / 100;
}

/** 档内决胜：唯一头部直接 pick；并列时仅当全体有评分才按分数决胜，否则 ask。 */
function _stageResult(group, kind, stage, evidence) {
  if (group.length === 1) {
    return { action: 'pick', kind, item: group[0], stage, evidence };
  }
  const scores = group.map(wsjfScore);
  const whyOf = (i) =>
    scores[i] === null ? '缺评分字段 (cod/conf/size)' : `评分 ${_round2(scores[i])}`;
  if (scores.every((s) => s !== null)) {
    const max = Math.max(...scores);
    const winners = group.filter((_, i) => scores[i] === max);
    if (winners.length === 1) {
      return { action: 'pick', kind, item: winners[0], stage, evidence };
    }
  }
  return {
    action: 'ask',
    stage,
    candidates: group.map((item, i) => ({ kind, item, why: whyOf(i) })),
    evidence,
  };
}

/**
 * 自动选取下一步 —— PROCESS-102「下一步最该做什么决策标准」的机器实现。
 * 五档瀑布，首个能产出唯一赢家的档即答案；同档并列禁止按登记顺序任取。
 * 被他机以存活租约占用的条目一律跳过（多机不撞车的既有保障原样继承）。
 *
 * @param {{skipHealth?:boolean}} opts 人的显式指定权：跳过 G0 直接排程
 * @returns {{action:'idle'|'health'|'pick'|'ask', ...}}
 */
function pickNext(bugsDoc, progressDoc, me, now = new Date(), opts = {}) {
  const bugs = (bugsDoc && bugsDoc.bugs) || [];
  const tasks = (progressDoc && progressDoc.tasks) || [];
  const available = (x) => x && !heldByOther(x, me, now);
  const leaseExpired = (x) => {
    if (!x.lease_expires) {
      return false;
    }
    const t = parseIso(x.lease_expires);
    return t instanceof Date && !Number.isNaN(t.getTime()) && t < now;
  };

  const pendingVerify = bugs.filter((b) => b && b.status === 'pending_verify');
  const reviewTasks = tasks.filter((t) => t && t.status === 'review');
  const staleTasks = tasks.filter((t) => t && t.status === 'doing' && t.claimed_by && leaseExpired(t));
  const staleBugs = bugs.filter((b) => b && b.status === 'in_progress' && b.claimed_by && leaseExpired(b));

  const openBugs = bugs.filter((b) => b && b.status === 'open' && available(b));
  const todos = tasks.filter((t) => t && t.status === 'todo' && available(t));
  const evidence = {
    pendingVerify: pendingVerify.length,
    reviewTasks: reviewTasks.length,
    staleClaims: staleTasks.length + staleBugs.length,
    openBugs: openBugs.length,
    todoP01: todos.filter((t) => severityKey(t.priority) <= 1).length,
    todoP23: todos.filter((t) => severityKey(t.priority) > 1).length,
  };

  // G0 健康 · 瓶颈解锁：闭环未合不算新活（显式 skipHealth 除外）
  if (!opts.skipHealth && (pendingVerify.length || reviewTasks.length || staleTasks.length || staleBugs.length)) {
    const items = [
      ...pendingVerify.map((b) => ({
        kind: 'bug', item: b,
        reason: '待验证收尾 (pending_verify)',
        howto: `khy hq next --verify ${b.id}`,
      })),
      ...reviewTasks.map((t) => ({
        kind: 'task', item: t,
        reason: '待人工验收 (review)',
        howto: `验收通过后 khy hq task set ${t.id} done，不通过打回 doing`,
      })),
      ...staleTasks.map((t) => ({
        kind: 'task', item: t,
        reason: `进行中的租约已过期（持有者 ${t.claimed_by}）`,
        howto: sameMachine(t.claimed_by, me)
          ? `khy hq release ${t.id}，或领回后重新开工`
          : `与 ${t.claimed_by} 确认是否仍在进行；由该机器续租或释放`,
      })),
      ...staleBugs.map((b) => ({
        kind: 'bug', item: b,
        reason: `排查中的租约已过期（持有者 ${b.claimed_by}）`,
        howto: sameMachine(b.claimed_by, me)
          ? `khy hq release ${b.id}，或领回后继续`
          : `与 ${b.claimed_by} 确认是否仍在进行；由该机器续租或释放`,
      })),
    ];
    items.sort(
      (a, b) =>
        severityKey(a.item.severity || a.item.priority) - severityKey(b.item.severity || b.item.priority)
    );
    return { action: 'health', items, evidence };
  }

  // G1 救火：open Bug 按严重度
  if (openBugs.length) {
    return _stageResult(_topSeverityGroup(openBugs, (b) => b.severity), 'bug', 'G1', evidence);
  }
  // G2 要事：P0/P1 待办
  const p01 = _topSeverityGroup(todos.filter((t) => severityKey(t.priority) <= 1), (t) => t.priority);
  if (p01.length) {
    return _stageResult(p01, 'task', 'G2', evidence);
  }
  // G3 次事：P2/P3 待办
  const p23 = _topSeverityGroup(todos.filter((t) => severityKey(t.priority) > 1), (t) => t.priority);
  if (p23.length) {
    return _stageResult(p23, 'task', 'G3', evidence);
  }
  return { action: 'idle', evidence };
}

/**
 * 为单条任务匹配建议模型：取 `MODELS.json` 中第一个 `strengths` 命中该任务类型者。
 * `domains` 非空时作为附加过滤（域为空则不过滤）。返回 `[display, entry]`。
 */
function modelHint(modelsDoc, taskType, domain = '') {
  const models = (modelsDoc && modelsDoc.models) || [];
  for (const m of models) {
    const strengths = m.strengths || [];
    const domains = m.domains || [];
    if (strengths.includes(taskType)) {
      if (domains.length && domain && !domains.includes(domain)) {
        continue;
      }
      return [m.display, m.entry || ''];
    }
  }
  return [null, null];
}

/**
 * 状态总览快照（机读形态）—— 与原 `next.py --status --json` 的输出契约等价，
 * 只是 `khy_os_path` 恒为「本仓库根」：吸收后不存在「HQ 在哪、khy-os 在哪」两个问题。
 */
function buildStatus(root, env = process.env) {
  const p = paths(root);
  const bugsDoc = readJsonSafe(p.bugs);
  const progressDoc = readJsonSafe(p.progress);
  const modelsDoc = readJsonSafe(p.models);

  const bugs = ((bugsDoc.ok && bugsDoc.data.bugs) || []).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const tasks = (progressDoc.ok && progressDoc.data.tasks) || [];
  const models = ((modelsDoc.ok && modelsDoc.data.models) || []).filter((m) => m && m.strengths);

  const enriched = tasks.map((t) => {
    const [disp, entry] = modelHint(modelsDoc.ok ? modelsDoc.data : {}, t.type || '', t.domain || '');
    return Object.assign({}, t, { suggested_model: disp || null, suggested_entry: entry || null });
  });

  const me = machineId(env);
  return {
    date: today(),
    khy_os_version: (progressDoc.ok && progressDoc.data.khy_os_version) || '?',
    khy_os_path: REPO_ROOT,
    machine_id: me,
    bugs: bugs.map((b) => ({
      id: b.id,
      status: b.status,
      severity: b.severity,
      domain: b.domain,
      title: b.title,
      claimed_by: b.claimed_by || null,
      lease_expires: b.lease_expires || null,
      held_by_other: heldByOther(b, me),
    })),
    tasks: enriched.map((t) => ({
      id: t.id,
      status: t.status,
      type: t.type,
      priority: t.priority,
      domain: t.domain,
      title: t.title,
      suggested_model: t.suggested_model,
      claimed_by: t.claimed_by || null,
      lease_expires: t.lease_expires || null,
      held_by_other: heldByOther(t, me),
    })),
    model_routing: models.map((m) => ({
      id: m.id,
      display: m.display || m.id,
      strengths: m.strengths,
    })),
    progress: {
      done: tasks.filter((t) => t.status === 'done').length,
      total: tasks.length,
    },
  };
}

// ── 渲染 ─────────────────────────────────────────────────────────

/**
 * 从模板 Markdown 中抽出 ```text 围栏内的提示词正文。
 * 没有围栏时回退整篇（与原 `hq_common.load_template` 同行为）。
 */
function extractPromptBody(text) {
  const m = /```text\s*\n([\s\S]*?)```/.exec(text);
  const body = m ? m[1] : text;
  return body.trim() + '\n';
}

/** 载入并抽取模板；缺失或非法返回 `{ok:false,error}`。 */
function loadTemplate(kind, root) {
  const rel = TYPE_TO_TEMPLATE[kind];
  if (!rel) {
    return { ok: false, error: `未知提示词类型: ${kind}` };
  }
  const file = path.join(paths(root).prompts, rel);
  try {
    return { ok: true, body: extractPromptBody(fs.readFileSync(file, 'utf-8')) };
  } catch (err) {
    return { ok: false, error: `模板缺失: ${file}（${err && err.message ? err.message : err}）` };
  }
}

/**
 * 替换 `{{KEY}}` 占位符。**未知/空值统一变 `(待填写)`** —— 这比留空更安全：
 * 留空会让 AI 以为「这一节本来就没有内容」，而 `(待填写)` 明确标示缺口。
 */
function renderPrompt(templateText, mapping) {
  return String(templateText).replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    const val = mapping[key];
    return val !== undefined && val !== null && String(val).trim() ? String(val) : '(待填写)';
  });
}

/**
 * 嵌入提示词的「工作目录」表达 —— 恒为**仓库根**。
 *
 * 注意 `paths(undefined)` 与 `paths(null)` 的区别：`paths(root)` 用 `root || HQ_DIR`
 * 兜底，那是给「显式指定数据根」的测试夹具用的；数据根是 `.ai/hq/`，而 AI 真正要
 * 工作的目录是仓库根，两者不是一回事。此处必须走 `REPO_ROOT`（或显式传入的仓库根），
 * 绝不能落到 `HQ_DIR`。
 */
function khyosPathExpr(repoRoot) {
  return repoRoot ? path.resolve(repoRoot) : REPO_ROOT;
}

/** Bug → 模板占位符映射。 */
function bugMapping(bug) {
  return {
    BUG_ID: bug.id,
    BUG_TITLE: bug.title || '',
    SEVERITY: bug.severity || '',
    DOMAIN: bug.domain || '',
    SYMPTOM: bug.symptom || '',
    REPRO: bug.repro || '',
    SUSPECT: bug.suspect_area || '',
    ROOT_CAUSE: bug.root_cause || '',
    FIX_SUMMARY: bug.fix_summary || '',
  };
}

/** 任务 → 模板占位符映射。 */
function taskMapping(task) {
  return {
    TASK_ID: task.id,
    TASK_TITLE: task.title || '',
    DOMAIN: task.domain || '',
    ACCEPTANCE: task.acceptance || '',
    TASK_TYPE: task.type || '',
  };
}

// ── 写入路径约束（原 hq_check.py `meta` 组的降级形态）────────────
//
// 方案 §3.3 的裁决：`meta`（JSON↔MD 一致性）不升级成仓库级门禁，而是**降级为
// 命令写入路径校验** —— 「能落在命令写入路径上的约束，就不要升级成检查器」。
// 以下 `validate*` 就是那一步：由 `khy hq bug new` / `khy hq task set` 在落盘前调用。

/** 校验 bug 记录形状，返回 error 数组（空 = 通过）。 */
function validateBug(bug) {
  const errs = [];
  if (!/^BUG-\d{3,}$/.test(String(bug.id || ''))) {
    errs.push(`Bug ID 格式非法: ${JSON.stringify(bug.id)}`);
  }
  if (!SEVERITIES.includes(bug.severity)) {
    errs.push(`严重度非法: ${JSON.stringify(bug.severity)}（可选 ${SEVERITIES.join('/')}）`);
  }
  if (!DOMAINS.includes(bug.domain)) {
    errs.push(`域非法: ${JSON.stringify(bug.domain)}（可选 ${DOMAINS.join('/')}）`);
  }
  if (!BUG_STATES.includes(bug.status)) {
    errs.push(`状态非法: ${JSON.stringify(bug.status)}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(bug.created || ''))) {
    errs.push(`created 日期格式应为 YYYY-MM-DD`);
  }
  return errs;
}

/** 校验任务记录形状，返回 error 数组。 */
function validateTask(task) {
  const errs = [];
  if (!/^T-\d{3,}$/.test(String(task.id || ''))) {
    errs.push(`任务 ID 格式非法: ${JSON.stringify(task.id)}`);
  }
  if (!DOMAINS.includes(task.domain)) {
    errs.push(`域非法: ${JSON.stringify(task.domain)}`);
  }
  if (!TASK_TYPES.includes(task.type)) {
    errs.push(`类型非法: ${JSON.stringify(task.type)}（可选 ${TASK_TYPES.join('/')}）`);
  }
  if (!SEVERITIES.includes(task.priority)) {
    errs.push(`优先级非法: ${JSON.stringify(task.priority)}`);
  }
  if (!TASK_STATES.includes(task.status)) {
    errs.push(`状态非法: ${JSON.stringify(task.status)}`);
  }
  // PROCESS-102 档内评分字段：可选，出现即校验（存量不追溯）
  if (task.cod !== undefined && (!Number.isInteger(task.cod) || task.cod < 1 || task.cod > 5)) {
    errs.push(`cod 应为 1-5 整数: ${JSON.stringify(task.cod)}`);
  }
  if (task.conf !== undefined && (!Number.isInteger(task.conf) || task.conf < 1 || task.conf > 3)) {
    errs.push(`conf 应为 1-3 整数: ${JSON.stringify(task.conf)}`);
  }
  if (task.size !== undefined && !SIZE_WEIGHT[String(task.size).toUpperCase()]) {
    errs.push(`size 应为 S/M/L: ${JSON.stringify(task.size)}`);
  }
  // 验收证据与边界字段：同样「可选，出现即校验，存量不追溯」
  //
  // ⚠ 这里刻意**只校验形状、不要求必填**。原因：`cod/conf/size` 的反面教材 ——
  // 字段定义了、校验也写了，23 条任务一条没填 ⇒ 规则从未生效过一次。
  // 所以「必填」这件事**不在 `validateTask` 里做**，而在 `reviewDoneBlockers`
  // 里做（`review → done` 那一刻硬拒）。**校验在写入路径的最窄处，才拦得住人。**
  if (task.evidence !== undefined) {
    const ev = String(task.evidence || '').trim();
    if (!ev) {
      errs.push('evidence 不可为空字符串（要么不写，要么写 .khy/feedback/ 下的目录名）');
    } else if (!EVIDENCE_NAME_RE.test(ev)) {
      errs.push(`evidence 名称非法: ${JSON.stringify(ev)}（只允许字母/数字/./_/-，且不以符号开头）`);
    }
  }
  if (task.baseline_metrics !== undefined) {
    const bm = task.baseline_metrics;
    if (!bm || typeof bm !== 'object' || Array.isArray(bm)) {
      errs.push('baseline_metrics 应为对象（如 {"jest_suites": 1231, "jest_failed": 24}）');
    } else {
      for (const [k, v] of Object.entries(bm)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          errs.push(`baseline_metrics.${k} 应为数字: ${JSON.stringify(v)} —— "不劣化"类判据必须有基线数字`);
        }
      }
    }
  }
  if (task.scope_guard !== undefined) {
    const sg = task.scope_guard;
    if (!Array.isArray(sg)) {
      errs.push('scope_guard 应为字符串数组（每条一句"不做什么"）');
    } else if (!sg.length) {
      errs.push('scope_guard 不应为空数组（要么不写，要么至少列一条边界）');
    } else {
      sg.forEach((s, i) => {
        if (typeof s !== 'string' || !s.trim()) {
          errs.push(`scope_guard[${i}] 应为非空字符串`);
        }
      });
    }
  }
  return errs;
}

// ── 验收清算（review → done 的判据）──────────────────────────────
//
// 背景（2026-09-23 取证）：`review → done` 长期是一个**裸箭头** ——
// `TASK_TRANSITIONS.review = ['done', 'doing']`，`validateTask` 不检查任何证据。
// 后果实测：`T-023`（P1）卡在 review 3 天无人动；13 条 Bug 中 3 条 `pending_verify`
// 的 `notes` 为 0 条（进入待验证时零留痕）；`.khy/feedback/` 下 52 个存证目录
// **零个被引用过**（本文件全文 grep `feedback` 曾命中 0 次）。
//
// 设计裁决（沿用本文件「写入路径约束」一节已写明的立场）：
//   「能落在命令写入路径上的约束，就不要升级成检查器。」
// ⇒ 本判据**不进 `scripts/ci/`**，因此不需要门引用、不触发 `check-wiring.js`
//   的孤儿判定、不新增规则 ID。它是 `khy hq task set <ID> done` 的前置条件，
//   与 `canTransition` 同层：**不通过就拒绝写入**（`saveJson` 之前校验，磁盘保持原状）。
//
// 与 S1 墓碑的区别（`[DESIGN-DELIV-001]` §1.3 教训）：本机制**从第一天就是硬返回**，
// 不做「只记录不拦截」的观察者 —— 命令路径校验的「最小可行强度」就是拒绝写入。

/**
 * 把 `acceptance` 切成可逐条勾选的条目。
 *
 * 实测 23 条任务的 `acceptance` 已用两种分句法书写：
 *   - `；` / `;` 分隔（T-001 5 句、T-013 6 句、T-014/015 各 7 句）
 *   - `1) 2) 3)` 编号（T-020 5 条、T-023 5 条）
 * 两种都在本仓真实存在，故都识别。切不出多句时退化为单条（整段即一条判据），
 * **绝不因切不出来就放行**。
 *
 * @param {string} acceptance
 * @returns {string[]} 条目文本数组（已 trim、已去编号前缀、空条已剔除）
 */
function splitAcceptance(acceptance) {
  const text = String(acceptance || '').trim();
  if (!text) {
    return [];
  }
  // ⚠ 分号切割必须**括号感知**（2026-09-23 实测教训）：T-024 的 acceptance 里
  // 「（node:test；含反向验证矩阵…）」这类括号内分号被当成分隔符，5 条判据被
  // 切成 7 条 —— 清算条数对不上，门会拒一份实际完整的清算。本仓 acceptance
  // 的书写惯例大量使用括号内补充说明，故切割深度跟随（（）「」四种括号。
  const segments = [];
  let buf = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '（' || ch === '(' || ch === '「' || ch === '『') {
      depth += 1;
    } else if (ch === '）' || ch === ')' || ch === '」' || ch === '』') {
      depth = Math.max(0, depth - 1);
    }
    if ((ch === '；' || ch === ';') && depth === 0) {
      segments.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  segments.push(buf);
  const bySemi = segments.map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const seg of bySemi) {
    const parts = seg
      .split(/(?:^|\s)(?=\d+\))/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 1) {
      out.push(...parts);
    } else {
      out.push(seg);
    }
  }
  return out.map((s) => s.replace(/^\d+\)\s*/, '').trim()).filter(Boolean);
}

/**
 * 校验一条 `acceptance` 是否**可机器核对**。
 *
 * 判据（来自实测规律，非杜撰）：23 条任务里，`acceptance` 含可执行命令的 14 条
 * → 5 done / 0 悬挂；纯描述性的 9 条 → 0 done / 2 doing / 1 review。
 * 样本小，不足以断言因果，但足以立一条**廉价的形式要求**：
 * 完成定义里至少要有一条能跑的命令，或一个能核对的数字。
 *
 * ⚠ 这是 warning 级（不阻断），因为存量 9 条会立刻全红；
 * 阻断级只留给「证据缺失」（见 `reviewDoneBlockers`）。
 *
 * @param {object} task
 * @returns {string[]} warning 文本
 */
function auditAcceptanceQuality(task) {
  const out = [];
  const acc = String((task && task.acceptance) || '');
  if (!acc.trim()) {
    out.push(`${task && task.id}: acceptance 为空 —— 没有完成定义就没有完成判定`);
    return out;
  }
  const items = splitAcceptance(acc);
  const hasCmd = /(npm run|node scripts|node services|npx |pnpm |khy )/.test(acc);
  const hasNum = /\d/.test(acc);
  if (!hasCmd && !hasNum) {
    out.push(
      `${task.id}: acceptance 既无可执行命令也无数字阈值（${items.length} 条纯描述性判据）—— ` +
        '机器无法核对，只能靠人记，而人会忘'
    );
  }
  return out;
}

/**
 * 相对路径判据的**失效检测**：`acceptance` 里提到的仓内路径是否真的存在。
 *
 * 这是 2026-09-23 取证里最便宜也最有价值的一条。实测：`T-020` / `T-021` 的
 * acceptance 都写「严格按 `_meta/SPLIT-PLAN.md` 执行」，而该文件**仓内零命中** ——
 * 它其实改名搬到了 `docs/08_MGMT_项目管理/MGMT-PLAN/[MGMT-PLAN-008] …md`。
 * 任务备注把「文件不存在」与「文件改名了」混为一谈，两条任务因此停滞 4 天。
 *
 * **不是 AI 走偏了，是路标被搬走了而没人知道。**
 *
 * 只检查「像仓内路径」的 token（含 `/` 且带扩展名），并且：
 *   - 只核对**首个 token**，因为 `acceptance` 里的中文说明会与后续 token 粘连；
 *   - 检查失败是 warning（不阻断），因为文档改名是正常操作，
 *     我们只是要求「路标搬走时有人知道」。
 *
 * @param {object} task
 * @param {string} repoRoot
 * @returns {string[]} warning 文本
 */
function auditAcceptancePaths(task, repoRoot) {
  const out = [];
  const acc = String((task && task.acceptance) || '');
  // ⚠ 踩过的坑（2026-09-23 实测）：最初把路径 token 的字符类写成
  //   `[^\s，。；、（）「」]*?\/…`，于是「终点：services/backend/src/cli/replSession.js」
  //   里的**中文前缀「终点：」被一起吞进来**，拼出的路径当然不存在 ⇒ 两条真路径被误报。
  // 修正：路径用**段式**表达，每段限定为 ASCII 标识符（字母/数字/._-），
  // 段间用 `/` 连接。中文只可能出现在路径**前后**，不可能出现在段内，故天然截断。
  const SEG = '[A-Za-z0-9_.-]+';
  const re = new RegExp(`(${SEG}(?:\\/${SEG})+\\.(?:js|mjs|cjs|ts|vue|py|md|json|html))`, 'g');
  const seen = new Set();
  let m;
  while ((m = re.exec(acc)) !== null) {
    const ref = m[1];
    if (!ref || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    if (/^https?:/.test(ref) || /^[A-Za-z]:/.test(ref)) {
      continue;
    }
    // `[MGMT-PLAN-008]` 这类方括号编号不在字符类里，但路径前若紧跟 `[` 说明是文档编号，
    // 仍按真实文件核对即可（编号属于文件名的一部分，已在 SEG 内）。
    const abs = path.join(repoRoot, ref);
    if (fs.existsSync(abs)) {
      continue;
    }
    // 给一个「是不是改名了」的提示：按 basename 在仓内浅层搜同名不同路径
    const alt = findFileByName(repoRoot, path.basename(ref), 3);
    const hint = alt.length
      ? `—— 疑似改名/搬家，仓内同名文件在：${alt.join(' 、 ')}`
      : '—— 仓内零命中';
    out.push(`${task.id}: acceptance 引用的路径不存在：${ref} ${hint}`);
  }
  return out;
}

/**
 * 按文件名在仓内浅层搜索（限深度、跳过 node_modules/.git/.khy 等）。
 * 目的单一：给「路径失效」的告警补一条「是不是改名了」的线索。
 * fail-soft —— 任何读盘失败都当「没找到」，绝不抛。
 */
function findFileByName(repoRoot, basename, maxDepth) {
  const hits = [];
  const SKIP = new Set(['node_modules', '.git', '.khy', '.khyos', '.khyquant', 'dist', 'build', '_产物']);
  const walk = (dir, depth) => {
    if (depth > maxDepth || hits.length >= 5) {
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= 5) {
        return;
      }
      if (SKIP.has(e.name)) {
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === basename) {
        hits.push(path.relative(repoRoot, full).split(path.sep).join('/'));
      } else if (e.isDirectory()) {
        walk(full, depth + 1);
      }
    }
  };
  walk(repoRoot, 0);
  return hits;
}

/**
 * 校验一条验收清算记录（`.khy/feedback/<evidence>/acceptance.md`）是否成立。
 *
 * 格式（简单到可用 grep 核对，不让「逐条勾选」退化成人肉仪式）：
 *
 * ```markdown
 * # T-023 验收清算
 *
 * ## 1) keyStore 三 JSON CRUD+原子写
 * - 结果: PASS
 * - 证据: apps/khyos-desktop/test/keyStore.test.js 21/21 全绿
 *
 * ## 2) 独立窗口+三入口
 * - 结果: SKIP
 * - 理由: 需 GUI 环境，本轮无法执行；留待 T-023-b
 * ```
 *
 * 硬规则：
 *   1. 每个 `## ` 段必须有 `结果:` 字段，取值 ∈ {PASS, FAIL, SKIP}；
 *   2. `SKIP` 必须有 `理由:` 且非空（否则等于没验收）；
 *   3. `FAIL` 存在即拒绝 —— 有未通过的验收项不许翻 done；
 *   4. `PASS` 必须有 `证据:` 且非空（一句话也行，但不能空）。
 *
 * @param {string} text  acceptance.md 全文
 * @returns {{verdicts: object[], errors: string[]}}
 */
function parseAcceptanceLedger(text) {
  const errors = [];
  const verdicts = [];
  const src = String(text || '');
  if (!src.trim()) {
    return { verdicts, errors: ['验收清算文件为空'] };
  }
  const blocks = src.split(/^##\s+/m).slice(1);
  if (!blocks.length) {
    return { verdicts, errors: ['验收清算文件里没有任何 `## <判据>` 段'] };
  }
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const title = (lines[0] || '').trim();
    const body = lines.slice(1).join('\n');
    const resultM = /结果\s*[:：]\s*([A-Za-z]+)/.exec(body);
    const result = resultM ? resultM[1].toUpperCase() : null;
    const evidenceM = /证据\s*[:：]\s*(\S[^\n]*)/.exec(body);
    const reasonM = /理由\s*[:：]\s*(\S[^\n]*)/.exec(body);

    if (!result || !ACCEPT_RESULTS.includes(result)) {
      errors.push(`判据「${title}」缺 结果: 字段或取值非法（应为 ${ACCEPT_RESULTS.join('/')}）`);
      verdicts.push({ title, result: 'MISSING' });
      continue;
    }
    if (result === 'SKIP' && !(reasonM && reasonM[1].trim())) {
      errors.push(`判据「${title}」标 SKIP 但缺 理由: —— 没理由的跳过等于没验收`);
    }
    if (result === 'PASS' && !(evidenceM && evidenceM[1].trim())) {
      errors.push(`判据「${title}」标 PASS 但缺 证据: —— 没有证据的通过等于自说自话`);
    }
    if (result === 'FAIL') {
      errors.push(`判据「${title}」标 FAIL —— 存在未通过项，不许翻 done`);
    }
    verdicts.push({
      title,
      result,
      evidence: evidenceM ? evidenceM[1].trim() : '',
      reason: reasonM ? reasonM[1].trim() : '',
    });
  }
  return { verdicts, errors };
}

/**
 * `review → done` 的**阻断条件**（返回非空 = 拒绝写入）。
 *
 * 这是本机制的核心：`khy hq task set <ID> done` 在 `saveJson` 之前调用它，
 * 返回非空数组即当场拒绝、磁盘保持原状。
 *
 * 阻断项刻意只留**最少**四条 —— 每一条都对应一个实测到的失败：
 *   1. 无 `evidence` 声明 → 实测 52 个存证目录零个被引用；
 *   2. `evidence` 目录不存在或为空 → 沿用 `check-agent-feedback.js` 的 readEvidence 语义（trim 后非空才算数）；
 *   3. 验收清算文件缺失或有 error → 实测 3 条 `pending_verify` Bug 的 notes = 0，进入验证时零留痕；
 *   4. 勾选条数少于 acceptance 判据条数 → 漏勾的判据不算通过。
 *
 * **刻意不阻断的**（避免误报率失控，`[DESIGN-PROCESS-002]` §2 的 10% 阈值）：
 *   - `acceptance` 质量不佳（无命令/无数字）→ 只 warning；
 *   - 引用的路径失效 → 只 warning；
 *   - 数字阈值未逐条机器核对 → 只回显，不做判定。
 *
 * @param {object} task
 * @param {string} repoRoot
 * @param {string} [fbRoot] 存证根；缺省 `path.join(repoRoot, '.khy', 'feedback')`
 * @returns {{blockers: string[], warnings: string[], verdicts: object[]}}
 */
function reviewDoneBlockers(task, repoRoot, fbRoot) {
  const blockers = [];
  const warnings = [];
  let verdicts = [];
  if (!task || typeof task !== 'object') {
    return { blockers: ['任务对象为空'], warnings, verdicts };
  }
  const evidenceRoot = fbRoot || path.join(repoRoot, '.khy', 'feedback');

  warnings.push(...auditAcceptanceQuality(task));
  warnings.push(...auditAcceptancePaths(task, repoRoot));

  // ① evidence 声明
  const ev = task.evidence;
  if (!ev || !String(ev).trim()) {
    blockers.push(
      `${task.id}: 缺 evidence 字段 —— 没有声明验收证据目录，无法核对。` +
        '请先在 `.khy/feedback/` 下建 `<task-id>-<slug>/` 并写入 acceptance.md，' +
        `再执行：khy hq task set ${task.id} review --evidence <名称>`
    );
    return { blockers, warnings, verdicts };
  }
  const name = String(ev).trim();
  if (!EVIDENCE_NAME_RE.test(name)) {
    blockers.push(
      `${task.id}: evidence 名称非法（${JSON.stringify(name)}）—— 只允许字母/数字/./_/-，且不以符号开头`
    );
    return { blockers, warnings, verdicts };
  }

  // ② 证据目录存在且非空
  const dir = path.join(evidenceRoot, name);
  if (!fs.existsSync(dir)) {
    blockers.push(`${task.id}: evidence 目录不存在：.khy/feedback/${name}/`);
    return { blockers, warnings, verdicts };
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  } catch (e) {
    blockers.push(`${task.id}: evidence 目录不可读：.khy/feedback/${name}/（${e.message}）`);
    return { blockers, warnings, verdicts };
  }
  if (!entries.length) {
    blockers.push(`${task.id}: evidence 目录为空：.khy/feedback/${name}/ —— 空目录不算存证`);
    return { blockers, warnings, verdicts };
  }

  // ③ 验收清算文件
  const ledgerPath = path.join(dir, 'acceptance.md');
  let ledgerText = '';
  try {
    ledgerText = fs.readFileSync(ledgerPath, 'utf8');
  } catch {
    blockers.push(
      `${task.id}: 缺验收清算文件 .khy/feedback/${name}/acceptance.md —— ` +
        `请按 acceptance 的 ${splitAcceptance(task.acceptance).length} 条判据逐条给出 结果/证据`
    );
    return { blockers, warnings, verdicts };
  }
  const parsed = parseAcceptanceLedger(ledgerText);
  verdicts = parsed.verdicts;
  blockers.push(...parsed.errors.map((e) => `${task.id}: ${e}`));

  // ④ 条目数是否覆盖 acceptance 的判据条数（少勾 = 漏验收）
  const expected = splitAcceptance(task.acceptance).length;
  if (expected > 0 && verdicts.length < expected) {
    blockers.push(
      `${task.id}: 验收清算只覆盖 ${verdicts.length} 条，而 acceptance 有 ${expected} 条判据 —— 漏勾的判据不算通过`
    );
  }

  return { blockers, warnings, verdicts };
}

// ── scope_guard：入口锁边界 + 越界可见 ────────────────────────────
//
// 这是 RUNTIME-008 BUILD 五问第 5 问（「不做什么」）在**任务级**的落地。
// 五问此前只在改动级生效（`--changed` 判定到 BUILD 模态时才要）——任务开工时
// 从未被问过「边界在哪」。「偏离」的入口根因正是只锁了目标、没锁边界。
//
// 两半：
//   1. `todo → doing` 时**要求填**（硬前置，同 done 门）—— 入口锁边界；
//   2. `khy hq scope <T-ID>` 按需核对：工作树里边界之外的改动**报出来**，
//      不拦不判错。**「可见」就够了**（2026-09-23 取证的教训从来不是
//      「没人管」，是「没人知道」）。
//
// ⚠ 本仓的现实约束必须写进文档：工作树是**共享脏工作树**（并行会话常态
// 500~10000 条未提交变动，见 [MGMT-PLAN-008] §三），改动**无法归属到任务**。
// 所以越界报告只能是「提示人去看」，语义是「可能越界，需人工归因」，
// 绝不能拿它做门 —— 否则全部是噪音。

/**
 * 从 scope_guard 条目里抽出**机器可核对的路径前缀**。
 *
 * 与 `auditAcceptancePaths` 不同：边界前缀通常是**目录**（`services/backend`、
 * `apps/ai-frontend`），没有扩展名，故不要求扩展名。含盘符的 token
 * （`D:/Portable`）不是仓内相对路径，剔除。抽不出前缀的条目是**语义约束**
 * （「不动 keyStore 的对外契约」），机器核不了，由调用方标注「需人工」。
 *
 * @param {string[]} scopeGuard
 * @returns {{prefixes: string[], manual: string[]}}
 */
function scopeGuardPrefixes(scopeGuard) {
  const prefixes = [];
  const manual = [];
  for (const raw of Array.isArray(scopeGuard) ? scopeGuard : []) {
    const entry = String(raw || '').trim();
    if (!entry) {
      continue;
    }
    const tokens = entry.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g) || [];
    const inRepo = tokens.filter((t) => !/^[A-Za-z]:/.test(t));
    if (inRepo.length) {
      prefixes.push(...inRepo);
    } else {
      manual.push(entry);
    }
  }
  return { prefixes: [...new Set(prefixes)], manual };
}

/**
 * 找出**不在任何声明前缀内**的改动文件。
 *
 * @param {string[]} scopeGuard
 * @param {string[]} changedFiles 工作树改动（相对仓库根、正斜杠）
 * @returns {{outside: string[], prefixes: string[], manual: string[]}}
 */
function scopeViolations(scopeGuard, changedFiles) {
  const { prefixes, manual } = scopeGuardPrefixes(scopeGuard);
  if (!prefixes.length) {
    return { outside: [], prefixes, manual };
  }
  const outside = (changedFiles || []).filter(
    (f) => !prefixes.some((p) => f === p || f.startsWith(p + '/'))
  );
  return { outside, prefixes, manual };
}

/**
 * `git status --porcelain` 的宽松解析。
 *
 * 为什么不用 `-z`：本仓实测（2026-09-23 日志）rename 记录占两段、解析易错；
 * 普通格式一行一条，rename 行是 `R  old -> new`，取 `->` 后段即可。
 * fail-soft：git 不可用（本仓 git 对象库曾物理损坏）返回 null，调用方降级提示。
 *
 * @param {string} repoRoot
 * @returns {string[]|null}
 */
function collectWorktreeChanges(repoRoot) {
  const { spawnSync } = require('child_process');
  const git = process.env.KHY_GIT_BIN || 'git';
  const r = spawnSync(git, ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error || (r.status !== 0 && r.status !== null)) {
    return null;
  }
  const out = [];
  for (const raw of String(r.stdout || '').split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (line.length < 4) {
      continue;
    }
    let f = line.slice(3).trim();
    if (f.includes(' -> ')) {
      f = f.split(' -> ').pop().trim();
    }
    f = f.replace(/^"|"$/g, '');
    if (f) {
      out.push(f.split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * 校验整套数据（Bug 档 + 任务档 + ROADMAP 同步 + 模型档案 + 模板注册表）。
 * 这是原 `hq_check.py meta` 组的等价物，但**只作为 `khy hq verify` 的只读体检**，
 * 不进 `scripts/ci/` ⇒ 不需要门引用（避免 `check-wiring.js` 判孤儿）。
 *
 * @returns {{errors: string[], warnings: string[], checks: string[]}}
 */
function validateDataset(root, env = process.env) {
  const p = paths(root);
  const errors = [];
  const warnings = [];
  const checks = [];
  const me = machineId(env);
  // 仓库根：`root` 是 HQ 数据目录（`.ai/hq`），故仓库根 = 其上两级。
  // 不走 `path.dirname(p.root)` 的模糊推导 —— `KHY_HQ_DIR` 覆盖时若指向别处，
  // 推导结果会错，而 `acceptance` 路径是相对仓库根写的，错了就全表误报。
  // 因此显式回落到本文件位置推导的 `REPO_ROOT`（`:34` 的零硬编码约定）。
  const repoRoot = root ? path.resolve(root, '..', '..') : REPO_ROOT;

  const bugsDoc = readJsonSafe(p.bugs);
  const progressDoc = readJsonSafe(p.progress);

  if (!bugsDoc.ok) {
    errors.push(`BUGS.json 无法读取或解析: ${bugsDoc.error}`);
  }
  if (!progressDoc.ok) {
    errors.push(`PROGRESS.json 无法读取或解析: ${progressDoc.error}`);
  }
  if (!bugsDoc.ok || !progressDoc.ok) {
    return { errors, warnings, checks };
  }

  // ── 任务 ──
  const tasks = progressDoc.data.tasks || [];
  const taskIds = tasks.map((t) => t && t.id);
  const dupTasks = [...new Set(taskIds.filter((id) => taskIds.filter((x) => x === id).length > 1))];
  for (const d of dupTasks) {
    errors.push(`任务 ID 重复: ${d}`);
  }

  let roadmap = '';
  try {
    roadmap = fs.readFileSync(p.roadmap, 'utf-8');
  } catch {
    errors.push('无法读取 ROADMAP.md');
  }

  // ROADMAP 表格行：| T-xxx | 标题 | 类型 | 优先级 | 状态 |
  const rowStatus = {};
  const rowRe = new RegExp(
    `^\\|\\s*(T-\\d+)\\s*\\|[^|]+\\|[^|]+\\|[^|]+\\|\\s*(${TASK_STATES.join('|')})\\s*\\|\\s*$`,
    'gm'
  );
  let m;
  while ((m = rowRe.exec(roadmap)) !== null) {
    rowStatus[m[1]] = m[2];
  }

  for (const t of tasks) {
    if (!t || typeof t !== 'object') {
      errors.push('任务列表中存在非对象条目');
      continue;
    }
    for (const e of validateTask(t)) {
      errors.push(`${t.id || '?'}: ${e}`);
    }
    if (Object.prototype.hasOwnProperty.call(rowStatus, t.id)) {
      if (rowStatus[t.id] !== t.status) {
        errors.push(`${t.id} 状态不同步: JSON=${t.status} ROADMAP=${rowStatus[t.id]}`);
      }
    } else {
      errors.push(`${t.id} 在 ROADMAP.md 中没有可同步的状态行`);
    }
    const claimed = t.claimed_by;
    if (claimed && (t.status === 'review' || t.status === 'done')) {
      errors.push(`${t.id} 已到 ${t.status}=review/done 却仍带占用 ${claimed}，状态迁移应清除占用`);
    }
    if (claimed && !t.lease_expires) {
      errors.push(`${t.id} 带占用 ${claimed} 却缺少 lease_expires`);
    }
    if (claimed && sameMachine(claimed, me) && claimed !== me) {
      warnings.push(`${t.id} 的占用标识 ${JSON.stringify(claimed)} 与本机身份 ${JSON.stringify(me)} 大小写不一致`);
    }
    // 判据自身是否还成立：acceptance 引用的仓内路径是否存在（改名/搬家检测）。
    // 2026-09-23 新增 —— 实测 T-011/T-012/T-016/T-020/T-021 共 5 条任务的
    // acceptance 引用了不存在（或已改名）的路径，其中 2 条因此停滞 4 天。
    warnings.push(...auditAcceptancePaths(t, repoRoot));
    // `doing` 任务是否还活着：占用缺失 / 租约过期。
    // 2026-09-23 新增 —— 实测 T-020/T-021 声称 doing 却无 claimed_by、无 lease_expires，
    // 挂 4 天无人知。此处**只 warning 不 error**：doing 无占用可能是本机刚开工还没写回，
    // 也可能是真的死了，机器分不清，故只让「它可能停了」变得可见。
    if ((t.status === 'doing' || t.status === 'review') && !t.claimed_by) {
      warnings.push(`${t.id} 状态为 ${t.status} 但无占用（claimed_by 为空）—— 无法判断是「有人在做」还是「已停滞」`);
    }
    if (t.claimed_by && t.lease_expires) {
      const exp = parseIso(t.lease_expires);
      if (exp && exp.getTime() < Date.now()) {
        warnings.push(`${t.id} 的租约已于 ${t.lease_expires} 过期，但仍挂在 ${t.status} —— 可被他人接管，或应释放`);
      }
    }
  }
  for (const o of Object.keys(rowStatus).sort()) {
    if (!taskIds.includes(o)) {
      errors.push(`ROADMAP.md 中的 ${o} 在 PROGRESS.json 里不存在（幽灵行）`);
    }
  }
  if (!errors.some((e) => e.startsWith('任务') || /^T-/.test(e))) {
    checks.push(`${tasks.length} 条任务 ID/枚举/状态行全部一致`);
  }

  // ── Bug ──
  const bugs = bugsDoc.data.bugs || [];
  const bugIds = bugs.map((b) => b && b.id);
  const dupBugs = [...new Set(bugIds.filter((id) => bugIds.filter((x) => x === id).length > 1))];
  for (const d of dupBugs) {
    errors.push(`Bug ID 重复: ${d}`);
  }

  let maxNo = 0;
  for (const b of bugs) {
    for (const e of validateBug(b)) {
      errors.push(`${b && b.id ? b.id : '?'}: ${e}`);
    }
    const mm = /^BUG-(\d+)$/.exec(String((b && b.id) || ''));
    if (mm) {
      maxNo = Math.max(maxNo, parseInt(mm[1], 10));
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String((b && b.updated) || ''))) {
      errors.push(`${b && b.id}: updated 日期格式应为 YYYY-MM-DD`);
    }
    const claimed = b && b.claimed_by;
    if (claimed && (b.status === 'pending_verify' || b.status === 'closed')) {
      errors.push(`${b.id} 已到 ${b.status}=pending_verify/closed 却仍带占用 ${claimed}，状态迁移应清除占用`);
    }
    if (claimed && !b.lease_expires) {
      errors.push(`${b.id} 带占用 ${claimed} 却缺少 lease_expires`);
    }
    if (claimed && sameMachine(claimed, me) && claimed !== me) {
      warnings.push(`${b.id} 的占用标识 ${JSON.stringify(claimed)} 与本机身份 ${JSON.stringify(me)} 大小写不一致`);
    }
  }
  const nextId = bugsDoc.data.next_id || 0;
  if (bugs.length && nextId <= maxNo) {
    errors.push(`next_id(${nextId}) 未越过最大已用编号(${maxNo})，会撞 ID`);
  }
  checks.push(`${bugs.length} 条 Bug 记录通过 schema 校验`);

  // ── 模板注册表 ──
  const missing = [...new Set(Object.values(TYPE_TO_TEMPLATE))].filter(
    (rel) => !fs.existsSync(path.join(p.prompts, rel))
  );
  for (const rel of missing.sort()) {
    errors.push(`TYPE_TO_TEMPLATE 注册的模板不存在: ${rel}`);
  }
  if (!missing.length) {
    checks.push(`模板注册表 ${Object.keys(TYPE_TO_TEMPLATE).length} 项全部存在`);
  }

  // ── MODELS.json ──
  const modelsDoc = readJsonSafe(p.models);
  if (modelsDoc.ok) {
    const known = new Set(TASK_TYPES);
    for (const mm of modelsDoc.data.models || []) {
      const bad = (mm.strengths || []).filter((s) => !known.has(s));
      if (bad.length) {
        errors.push(`模型 ${mm.id} 的 strengths 含未知任务类型: ${bad.join(', ')}`);
      }
    }
    checks.push(`MODELS.json 载入正常，${(modelsDoc.data.models || []).length} 个模型档案`);
  } else {
    errors.push(`MODELS.json 无法读取或解析: ${modelsDoc.error}`);
  }

  // ── 提示词模板结构（原 hq_check `prompts` 组的等价物）──
  const promptErrors = validatePrompts(p.prompts);
  errors.push(...promptErrors);
  if (!promptErrors.length) {
    checks.push('提示词模板结构完整（围栏 / 角色 / 验证命令 / 占位符声明）');
  }

  return { errors, warnings, checks };
}

/**
 * 提示词模板结构检查：每个模板须有 ```text 围栏、【角色】、【验证命令】，
 * 且正文用到的 `{{X}}` 必须在头部注释里声明过。
 *
 * 与 `hq_check.py check_prompts` 的唯一差别：**只认「同一行内成对」的 `{{X}}`**。
 * 原文用逐字面量 `"{{XX}}"` 扫描，把 `docs/03_DESIGN_设计/[DESIGN-ARCH-XXX]`、
 * `BUG-XXX` 这类占位示例误判成占位符 —— 误报比漏报更贵（公理 A4），故此处收紧。
 */
function validatePrompts(promptsDir) {
  const errors = [];
  const listDir = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };

  const files = [];
  const walk = (dir) => {
    for (const e of listDir(dir)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__pycache__') {
          continue;
        }
        walk(full);
      } else if (e.name.endsWith('.md') && e.name !== 'README.md') {
        files.push(full);
      }
    }
  };
  walk(promptsDir);

  if (!files.length) {
    return ['未找到任何提示词模板'];
  }

  const fence = /```text\s*\n([\s\S]*?)```/;
  // 占位符必须在同一行内成对出现，且右侧紧邻的字符不是路径/编号延续。
  const inlinePh = /\{\{(\w+)\}\}/g;

  for (const file of files.sort()) {
    const rel = path.relative(promptsDir, file);
    let text;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      errors.push(`${rel} 无法读取`);
      continue;
    }
    const fm = fence.exec(text);
    if (!fm) {
      errors.push(`${rel} 缺少 \`\`\`text 提示词围栏`);
      continue;
    }
    const body = fm[1];
    const head = text.slice(0, fm.index);
    if (!body.includes('【角色】')) {
      errors.push(`${rel} 缺少【角色】定义`);
    }
    if (!body.includes('【验证命令】')) {
      errors.push(`${rel} 缺少【验证命令】段`);
    }
    const declared = new Set(head.match(inlinePh) || []);
    const used = new Set(body.match(inlinePh) || []);
    const undeclared = [...used].filter((u) => !declared.has(u));
    if (undeclared.length) {
      errors.push(`${rel} 使用了未在头部声明的占位符: ${undeclared.join(', ')}`);
    }
  }
  return errors;
}

module.exports = {
  // 路径
  REPO_ROOT,
  HQ_DIR,
  PROMPTS_DIR,
  LOGS_DIR,
  BUGS_JSON,
  PROGRESS_JSON,
  ROADMAP_MD,
  MODELS_JSON,
  CONTEXT_MD,
  hqDir,
  feedbackDir,
  paths,
  // 枚举与真源表
  DOMAINS,
  SEVERITIES,
  TASK_TYPES,
  TASK_STATES,
  BUG_STATES,
  BUG_TRANSITIONS,
  TASK_TRANSITIONS,
  TYPE_TO_TEMPLATE,
  SEVERITY_NAME,
  TYPE_NAME,
  KIND_NAME,
  LEASE_MINUTES,
  // IO
  loadJson,
  readJsonSafe,
  saveJson,
  today,
  isoLocal,
  parseIso,
  log,
  // 状态机
  canTransition,
  isValidState,
  // 多机
  machineId,
  sameMachine,
  heldByOther,
  stampClaim,
  clearClaim,
  // 选取
  loadAll,
  findItem,
  severityKey,
  pickNext,
  wsjfScore,
  modelHint,
  buildStatus,
  // 渲染
  extractPromptBody,
  loadTemplate,
  renderPrompt,
  khyosPathExpr,
  bugMapping,
  taskMapping,
  // 校验
  validateBug,
  validateTask,
  validateDataset,
  validatePrompts,
  // 验收清算（review → done 的判据；走命令写入路径，不进 scripts/ci）
  EVIDENCE_NAME_RE,
  ACCEPT_RESULTS,
  splitAcceptance,
  auditAcceptanceQuality,
  auditAcceptancePaths,
  findFileByName,
  parseAcceptanceLedger,
  reviewDoneBlockers,
  // scope_guard（入口锁边界 + 越界可见）
  scopeGuardPrefixes,
  scopeViolations,
  collectWorktreeChanges,
};
