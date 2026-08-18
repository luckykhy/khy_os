'use strict';

/**
 * healEscalationService.js — 薄壳(IO 层):自愈失败后的**三级升级链**执行器。
 *
 * 背景(本文件解决的失败点):今天各自愈组件失败后就地返回 error 便结束——
 *   - sourceHealService 修不好(快照没了/解不开/写回失败)只返回 {ok,reason},没有下一步;
 *   - selfRepairTransaction 校验不过回滚了,回滚要是没滚干净也只在注解里提一句;
 *   - configGuard 主文件 + .bak 双损只能退回 schema 默认值,用户配置事实上已丢;
 *   - dbHealthService 四步全败只返回 {ok:false}。
 *   即「静默失败」:机器知道自己修不好了,却没有人被告知、也没有更重的手段被启用。
 *
 * 三级升级链(本文件把「下一步」固化成确定性的表 + 执行器):
 *   L1(自动)  各组件自身的重试/多步修复(已有,不在本文件)。
 *   L2(升级)  切换到更重的修复手段(本文件执行,按组件查表):
 *               sourceHealService → khy restore 取回纯净树(必要时联网)+ 逐文件补齐安装树
 *               configGuard       → freshInstallDoctor(便携自检 + 断链/指针自动修复)
 *               dbHealth          → 重建空库 + 通知用户(数据可能丢失,必须告知)
 *               selfRepairTransaction → 无更重手段(工作树状态须人工确认)→ 直接 L3
 *   L3(交人)  L2 也失败(或该组件本就无 L2)→ 写 `.khy/heal_escalation.json`
 *             + 终端告警(含具体故障与建议命令)。
 *
 * 每次升级都写 healAudit(healAuditService.logHealEvent),details.message 形如
 * 「L1 失败，升级到 L2(restore)」/「L2 失败，升级到 L3(交人)」,升级原因(failedAttempts)
 * 与升级前后的级别(from/to)一并入账,便于 `khy heal log` 回溯。
 *
 * 红线与护栏:
 *   - **fail-soft**:本服务任何环节出错都只降级为「本次不升级」,绝不把异常抛回自愈调用方
 *     ——自愈的善后机制自己把宿主搞崩是最坏的结果。
 *   - **冷却窗**:L2 是重手段(khy restore 可能联网 + 整树解包)。按组件记冷却时间戳到
 *     `.khy/heal_escalation_state.json`,默认 24h 内同组件不重复升级
 *     (KHY_HEAL_ESCALATION_COOLDOWN_HOURS 覆盖),避免启动路径反复触发重活。
 *   - **门控**:KHY_HEAL_ESCALATION 默认开(仅 0/false/off/no 关,关闭即字节回退到
 *     「失败就是失败」的旧行为);KHY_HEAL_ESCALATION_L2 默认开,单独关掉可以只留
 *     L3 记录/告警而不自动执行重手段。
 *   - **非目标**:不做远程告警/邮件通知,不自动提交 issue。L3 的出口只有本地文件 + 终端。
 *
 * 决策与 IO 分离:planEscalation / buildEscalationRecord / formatEscalationAlert /
 * classifySourceHealFailure 都是零 IO 纯函数(可单测、可被别的壳复用);IO(写文件、
 * 跑 restore、跑 doctor、重建库)全部经 `deps` 注入,默认实现懒 require,测试可整链替换。
 */

const fs = require('fs');
const path = require('path');

// ── 门控 ────────────────────────────────────────────────────────────────────

const OFF = new Set(['0', 'false', 'off', 'no']);

function _off(env, key) {
  const v = (env || {})[key];
  if (v === undefined || v === null || String(v).trim() === '') {
    return false;
  }
  return OFF.has(String(v).trim().toLowerCase());
}

/** 升级链总门控(默认开;关 → escalate() 直接短路,字节回退旧行为)。 */
function isEnabled(env) {
  return !_off(env || (typeof process !== 'undefined' ? process.env : {}), 'KHY_HEAL_ESCALATION');
}

/** L2(自动执行重手段)子门控(默认开;关 → 只记录 + 直接走 L3,不自动跑 restore/doctor)。 */
function isL2Enabled(env) {
  return !_off(
    env || (typeof process !== 'undefined' ? process.env : {}),
    'KHY_HEAL_ESCALATION_L2'
  );
}

// ── 纯决策区(零 IO,确定性,绝不抛) ─────────────────────────────────────────

const ESCALATION_FILE = 'heal_escalation.json';
const STATE_FILE = 'heal_escalation_state.json';
const DEFAULT_COOLDOWN_HOURS = 24;

/**
 * 组件名归一:各调用方历史叫法不一(sourceHeal / sourceHealService / dbHealth /
 * dbHealthService …),升级表只认规范名。未知名原样返回(→ 无 L2,直接 L3)。
 */
const _ALIASES = Object.freeze({
  sourceheal: 'sourceHealService',
  sourcehealservice: 'sourceHealService',
  configguard: 'configGuard',
  config: 'configGuard',
  dbhealth: 'dbHealth',
  dbhealthservice: 'dbHealth',
  selfrepair: 'selfRepairTransaction',
  selfrepairtransaction: 'selfRepairTransaction',
});

function normalizeComponent(component) {
  const raw = String(component || '').trim();
  if (!raw) {
    return '';
  }
  return _ALIASES[raw.toLowerCase()] || raw;
}

/**
 * 升级表:组件 → L2 手段 + L3 建议 + 严重级。单一真源——「自愈失败后的下一步是什么」
 * 只在这里定义,调用方不得各自拍脑袋。
 *   action           L2 执行器键(null = 该组件无自动 L2,失败即交人)
 *   label            审计消息里的手段名(「升级到 L2(restore)」)
 *   command          L2 等价的人工命令(写入记录,供人复现)
 *   suggestedAction  L3 交人时给出的建议命令
 *   severity         L3 记录的严重级
 */
const ESCALATION_TABLE = Object.freeze({
  sourceHealService: Object.freeze({
    action: 'restore',
    label: 'restore',
    command: 'khy restore',
    suggestedAction: 'khy restore',
    severity: 'high',
    what: '运行时源码自愈失败(缺失/损坏文件无法从随包快照补齐)',
  }),
  configGuard: Object.freeze({
    action: 'freshInstallDoctor',
    label: 'freshInstallDoctor',
    command: 'khy doctor --fix',
    suggestedAction: 'khy doctor --fix（仍失败则 pip install --force-reinstall khy-os）',
    severity: 'high',
    what: '配置文件主文件与 .bak 备份双双损坏(已退回默认值,原配置事实上已丢失)',
  }),
  dbHealth: Object.freeze({
    action: 'rebuildEmptyDb',
    label: 'rebuildEmptyDb',
    command: 'khy backup restore',
    suggestedAction: 'khy backup restore（从备份恢复数据库）',
    severity: 'critical',
    what: '数据库多步恢复全部失败(WAL checkpoint / .recover / 备份还原)',
  }),
  selfRepairTransaction: Object.freeze({
    action: null, // 工作树状态须人工确认,没有「更重的自动手段」可用
    label: null,
    command: null,
    suggestedAction: 'git status（人工核对工作树后 git checkout -- <文件> 或 git stash pop）',
    severity: 'high',
    what: '自修复事务校验未通过且回滚未能完整执行(工作树可能残留半截改动)',
  }),
});

/**
 * 给定组件产出升级计划(纯函数)。未登记组件 → 无 L2,直接交人。
 * @param {string} component
 * @returns {{component:string, known:boolean, l2Action:string|null, l2Label:string|null,
 *            command:string|null, suggestedAction:string, severity:string, what:string}}
 */
function planEscalation(component) {
  const name = normalizeComponent(component);
  const row = ESCALATION_TABLE[name];
  if (!row) {
    return {
      component: name || 'unknown',
      known: false,
      l2Action: null,
      l2Label: null,
      command: null,
      suggestedAction: 'khy doctor（未登记组件，请人工诊断）',
      severity: 'high',
      what: '自愈失败(未登记组件)',
    };
  }
  return {
    component: name,
    known: true,
    l2Action: row.action,
    l2Label: row.label,
    command: row.command,
    suggestedAction: row.suggestedAction,
    severity: row.severity,
    what: row.what,
  };
}

/** 升级审计消息(单一真源:审计与终端用同一句话)。 */
function formatUpgradeMessage(from, to, label) {
  const target = label ? `${to}(${label})` : to === 'L3' ? 'L3(交人)' : String(to);
  return `${from} 失败，升级到 ${target}`;
}

/** 归一 failedAttempts:只保留 {step, error} 两个字段,字符串化 + 封顶 20 条。 */
function normalizeAttempts(attempts) {
  const out = [];
  for (const a of Array.isArray(attempts) ? attempts : []) {
    if (!a) {
      continue;
    }
    if (typeof a === 'string') {
      out.push({ step: 'unknown', error: a.slice(0, 500) });
    } else {
      out.push({
        step: String(a.step || 'unknown').slice(0, 120),
        error: String(a.error === undefined || a.error === null ? '' : a.error).slice(0, 500),
      });
    }
    if (out.length >= 20) {
      break;
    }
  }
  return out;
}

/**
 * 组装 `.khy/heal_escalation.json` 的记录体(纯函数)。
 * 前五个字段是对外契约(timestamp / component / failedAttempts / suggestedAction / severity),
 * 其后为加性诊断字段(升级链轨迹、L2 结果、上下文),读方按需忽略。
 */
function buildEscalationRecord(input = {}) {
  const plan = input.plan || planEscalation(input.component);
  const attempts = normalizeAttempts(input.failedAttempts);
  const l2 = input.l2 || null;
  if (l2 && l2.ran && l2.ok === false) {
    attempts.push({
      step: `l2:${plan.l2Label || plan.l2Action || 'none'}`,
      error: String(l2.error || 'l2_failed').slice(0, 500),
    });
  }
  return {
    timestamp: input.timestamp || new Date().toISOString(),
    component: plan.component,
    failedAttempts: attempts,
    suggestedAction: plan.suggestedAction,
    severity: plan.severity,
    // 加性诊断字段
    what: plan.what,
    escalation: {
      from: l2 && l2.ran ? 'L2' : 'L1',
      to: 'L3',
      l2Attempted: !!(l2 && l2.ran),
      l2Action: plan.l2Action,
      l2Error: l2 && l2.ran && l2.ok === false ? String(l2.error || 'l2_failed') : null,
      l2Skipped: l2 && l2.skipped ? String(l2.skipped) : null,
    },
    context: input.context && typeof input.context === 'object' ? input.context : {},
    trigger: input.trigger ? String(input.trigger) : null,
  };
}

/**
 * L3 终端告警文本(纯函数):必须说清**具体故障**与**下一步建议**,不说套话。
 * @param {object} record buildEscalationRecord 的产物
 * @param {string} [filePath] 记录落盘位置(有则打印,便于人工取证)
 * @returns {string}
 */
function formatEscalationAlert(record, filePath) {
  const r = record && typeof record === 'object' ? record : {};
  const lines = [];
  lines.push('⚠️  自愈失败已升级到 L3（需人工处理）');
  lines.push(`    组件: ${r.component || 'unknown'}（${r.what || '自愈失败'}）`);
  const attempts = Array.isArray(r.failedAttempts) ? r.failedAttempts : [];
  if (attempts.length) {
    lines.push('    具体故障:');
    for (const a of attempts.slice(0, 6)) {
      lines.push(`      - ${a.step}: ${a.error || '(无错误信息)'}`);
    }
    if (attempts.length > 6) {
      lines.push(`      …… 另有 ${attempts.length - 6} 条`);
    }
  }
  const esc = r.escalation || {};
  if (esc.l2Attempted) {
    lines.push(`    L2 已尝试: ${esc.l2Action}（失败: ${esc.l2Error || '未知原因'}）`);
  } else if (esc.l2Action) {
    lines.push(`    L2 未执行: ${esc.l2Action}（${esc.l2Skipped || '已被门控关闭'}）`);
  } else {
    lines.push('    L2: 该组件无自动升级手段，直接交人');
  }
  lines.push(`    建议: ${r.suggestedAction || 'khy doctor'}`);
  if (filePath) {
    lines.push(`    详情: ${filePath}`);
  }
  return lines.join('\n');
}

/**
 * 把 sourceHealService.healSource / runStartupHeal 的返回值判成「L1 是否真的失败了」(纯函数)。
 *
 * 为什么需要判据而不是「非 ok 即失败」:sourceHeal 有几种**设计上的拒绝**并非故障——
 *   - `no-snapshot`:开发树本来就没有随包快照(交给 git),日常正常路径,绝不能升级;
 *   - `version-mismatch` / `too-many-changes`:红线主动拒写并已给出明确建议,是护栏生效
 *     而非失败,自动升级反而会把「护栏挡住的重活」偷偷做掉;
 *   - `healthy` / `dry-run` / `gate-off` / `throttled`:压根没修。
 * 真失败只有:参照丢了(快照没了/头坏了/解不开)、跑挂了、或者修了但没修成。
 *
 * @param {object} res healSource/runStartupHeal 结果
 * @param {object} [opts]
 * @param {boolean} [opts.hadSnapshotBefore] 本机曾记录过快照指纹(→ 快照「消失」属故障而非开发树)
 * @returns {{failed:boolean, reason:string, attempts:Array<{step:string,error:string}>}}
 */
function classifySourceHealFailure(res, opts = {}) {
  const r = res && typeof res === 'object' ? res : {};
  const reason = String(r.reason || '');
  const attempts = [];
  const no = (why) => ({ failed: false, reason: why, attempts: [] });

  switch (reason) {
    case 'no-snapshot':
    case 'no-snapshot-header':
      // 从来没有过快照 = 开发树,正常;曾经有过却不见了 = 参照被删,交给 L2 整树还原。
      if (!opts.hadSnapshotBefore) {
        return no('dev-tree-no-snapshot');
      }
      attempts.push({
        step: 'snapshot_locate',
        error: reason === 'no-snapshot' ? 'snapshot_missing' : 'snapshot_header_missing',
      });
      return { failed: true, reason: 'snapshot-gone', attempts };

    case 'snapshot-unreadable':
      attempts.push({ step: 'snapshot_read', error: 'decrypt_fail' });
      return { failed: true, reason: 'snapshot-unreadable', attempts };

    case 'error':
      attempts.push({
        step: 'heal_run',
        error: String((r.report && r.report.error) || r.error || 'unknown_error'),
      });
      return { failed: true, reason: 'heal-error', attempts };

    case 'attempted':
      // 有计划、真去写了,却一个文件都没落地。
      attempts.push({ step: 'apply', error: 'no_file_written' });
      for (const f of Array.isArray(r.failed) ? r.failed.slice(0, 10) : []) {
        attempts.push({ step: `apply:${(f && f.relPath) || '?'}`, error: (f && f.error) || '?' });
      }
      return { failed: true, reason: 'apply-failed', attempts };

    case 'version-mismatch':
    case 'too-many-changes':
      // 护栏主动拒写(已给人工建议),不是故障,不自动升级。
      return no(reason);

    default:
      break;
  }

  // 修了一部分但有文件失败(reason 通常是 'healed')→ 局部失败也算 L1 未竟。
  if (Array.isArray(r.failed) && r.failed.length > 0) {
    for (const f of r.failed.slice(0, 10)) {
      attempts.push({ step: `apply:${(f && f.relPath) || '?'}`, error: (f && f.error) || '?' });
    }
    return { failed: true, reason: 'partial-failure', attempts };
  }

  if (r.ok === false) {
    attempts.push({ step: 'heal_run', error: String(r.error || reason || 'unknown_error') });
    return { failed: true, reason: 'not-ok', attempts };
  }

  return no(reason || 'ok');
}

// ── IO 区(全部 fail-soft;可注入) ───────────────────────────────────────────

function _env(opts) {
  return (opts && opts.env) || (typeof process !== 'undefined' ? process.env : {});
}

/** `.khy` 目录(与 healAuditService 同一约定:项目 cwd 下的 .khy)。 */
function _khyDir(opts = {}) {
  if (opts.khyDir) {
    return path.resolve(opts.khyDir);
  }
  return path.join(opts.cwd || process.cwd(), '.khy');
}

/** L3 记录文件位置。 */
function getEscalationFilePath(opts = {}) {
  return path.join(_khyDir(opts), ESCALATION_FILE);
}

/** 冷却状态文件位置。 */
function getEscalationStatePath(opts = {}) {
  return path.join(_khyDir(opts), STATE_FILE);
}

function _readJsonSafe(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch {
    return null;
  }
}

function _writeJsonSafe(fp, obj) {
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function _cooldownMs(env) {
  try {
    const raw = env && env.KHY_HEAL_ESCALATION_COOLDOWN_HOURS;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return DEFAULT_COOLDOWN_HOURS * 3600 * 1000;
    }
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n)) {
      return DEFAULT_COOLDOWN_HOURS * 3600 * 1000;
    }
    return n <= 0 ? 0 : Math.round(n * 3600 * 1000);
  } catch {
    return DEFAULT_COOLDOWN_HOURS * 3600 * 1000;
  }
}

/** 冷却判定:同组件在窗口内已升级过 → 本次跳过(force 绕过)。 */
function _throttled(component, now, opts) {
  const ms = _cooldownMs(_env(opts));
  if (ms <= 0 || opts.force) {
    return false;
  }
  const state = _readJsonSafe(getEscalationStatePath(opts));
  const last = state && state[component] && Number(state[component].lastAt);
  return Number.isFinite(last) && now - last < ms;
}

function _markEscalated(component, now, level, opts) {
  const fp = getEscalationStatePath(opts);
  const state = _readJsonSafe(fp) || {};
  state[component] = { lastAt: now, level, at: new Date(now).toISOString() };
  _writeJsonSafe(fp, state);
}

/** 写审计(默认走 healAuditService;绝不因审计失败影响升级)。 */
function _audit(entry, deps) {
  try {
    const fn =
      (deps && typeof deps.audit === 'function' && deps.audit) ||
      require('./healAuditService').logHealEvent;
    return !!fn(entry);
  } catch {
    return false;
  }
}

/** 终端输出(默认 console.error;调用方可注入 printWarn 之类)。 */
function _emit(text, deps) {
  try {
    if (deps && typeof deps.log === 'function') {
      deps.log(text);
      return;
    }
    console.error(text);
  } catch {
    /* 告警打不出来也不能抛 */
  }
}

// ── L2 执行器(默认实现懒 require,避免启动期硬耦合;全部可注入) ───────────────

/**
 * L2(sourceHealService):取回整树纯净源码,再用它把安装树修回去。
 *
 * 两步,缺一不可:
 *   ① `khy restore` 到一个**独立空目录**(必要时联网取快照)。刻意不走 restore 的默认落点
 *      (cwd/Khy-OS):自动路径不该往用户当前目录里扔东西,更不许覆盖正在跑的安装树。
 *   ② 拿还原出的纯净树跑既有 healFromPristineDir(apply)——L1 失败的根因通常是「参照没了」
 *      (随包快照被删/解不开),参照一旦取回,原来的逐文件修复就能完成。
 *
 * 红线:第②步走**既有封顶**(KHY_SOURCE_HEAL_AUTO_MAX,默认 25),不加 force。升级链绝不
 * 把「过量红线挡下的 mass-write」偷偷做掉——差异真的大到超过封顶,那是 L3 交人的活
 * (记录里的建议就是人工 `khy restore` 整树还原)。
 */
async function _runRestore(ctx = {}, deps = {}) {
  if (typeof deps.runRestore === 'function') {
    return deps.runRestore(ctx);
  }
  const os = require('os');
  const heal = require('./sourceHealService');
  const { handleRestore } = require('../cli/handlers/publish');

  const dest =
    ctx.restoreDir || path.join(os.tmpdir(), `khy-heal-restore-${process.pid}-${Date.now()}`);
  const ok = await handleRestore([], { into: dest, ...(ctx.options || {}) });
  if (ok === false) {
    return { ok: false, error: 'restore_failed（快照获取或解密失败）' };
  }

  const pristineSrc = heal._pristineSrcDir(dest);
  if (!fs.existsSync(pristineSrc)) {
    return { ok: false, error: `restored_tree_layout_unexpected: ${pristineSrc}` };
  }

  const installSrcDir = ctx.installSrcDir || heal._installSrcDir();
  const r = heal.healFromPristineDir(pristineSrc, installSrcDir, { env: ctx.env, apply: true });
  if (!r || !r.ok) {
    return { ok: false, error: (r && r.report && r.report.error) || 'heal_from_restored_failed' };
  }
  const planned = Array.isArray(r.plan) ? r.plan.length : 0;
  const applied = Array.isArray(r.applied) ? r.applied.length : 0;
  const failed = Array.isArray(r.failed) ? r.failed.length : 0;
  if (failed > 0 || applied < planned) {
    // 还原树留在原地供人工取证(建议命令里会给出路径)。
    return {
      ok: false,
      error: `还原后仍有 ${planned - applied} 个文件未修复（失败 ${failed}）；还原树: ${dest}`,
    };
  }
  try {
    fs.rmSync(dest, { recursive: true, force: true });
  } catch {
    /* 清不掉临时还原树无所谓 */
  }
  return { ok: true, detail: `khy restore + 补齐 ${applied} 个文件` };
}

/** L2:全新安装体检 + 可修项自动修复(断链重建 / 数据指针校准)。 */
async function _runFreshInstallDoctor(ctx = {}, deps = {}) {
  if (typeof deps.runFreshInstallDoctor === 'function') {
    return deps.runFreshInstallDoctor(ctx);
  }
  const doctor = require('./freshInstallDoctor');
  const res = doctor.fixPortableIssues({ env: ctx.env });
  const checks = doctor.portableSelfHealChecks({ env: ctx.env }) || [];
  const stillBad = checks.filter((c) => c && c.ok === false && c.level === 'error');
  if (stillBad.length) {
    return {
      ok: false,
      error: stillBad.map((c) => `${c.label}: ${c.detail}`).join('; ').slice(0, 500),
    };
  }
  return { ok: true, detail: `fixed=${(res && res.fixed && res.fixed.length) || 0}` };
}

/** L2:重建空库 + 通知用户(数据可能丢失,必须明说)。 */
async function _runRebuildEmptyDb(ctx = {}, deps = {}) {
  if (typeof deps.runRebuildEmptyDb === 'function') {
    return deps.runRebuildEmptyDb(ctx);
  }
  const dbPath = ctx.dbPath;
  if (!dbPath) {
    return { ok: false, error: 'no_db_path' };
  }
  const db = require('./dbHealthService');
  const dbName = ctx.dbName || path.basename(String(dbPath));
  const r = db._rebuildEmptyDatabase(dbPath, dbName);
  if (!r || !r.ok) {
    return { ok: false, error: (r && r.reason) || 'rebuild_failed' };
  }
  db._notifyUser(
    `数据库 ${dbName} 多步恢复全部失败，已重建空库（原库已备份为 ${dbName}.corrupted-<时间戳>），历史数据可能丢失。`
  );
  return { ok: true, detail: r.reason };
}

const _L2_RUNNERS = Object.freeze({
  restore: _runRestore,
  freshInstallDoctor: _runFreshInstallDoctor,
  rebuildEmptyDb: _runRebuildEmptyDb,
});

// ── 顶层入口 ────────────────────────────────────────────────────────────────

/**
 * 执行一次升级。L1 已失败的组件调用本函数交出「下一步」。
 *
 * @param {object} input
 * @param {string} input.component 组件名(sourceHealService / configGuard / dbHealth / …)
 * @param {Array<{step:string,error:string}>} [input.failedAttempts] L1 的失败轨迹(写入记录)
 * @param {object} [input.context] 组件上下文(dbPath / filePath / targetDir …,原样入记录)
 * @param {boolean} [input.skipL2] 调用方**自己已经执行过**该 L2 手段且失败 → 不重复跑,直接 L3
 * @param {boolean} [input.force] 绕过冷却窗
 * @param {string} [input.trigger] 触发来源标签(cli-heal / cli-bootstrap / db-health …)
 * @param {object} [input.env]
 * @param {string} [input.cwd] `.khy` 落点(测试隔离)
 * @param {object} [input.deps] 注入:{audit, log, runRestore, runFreshInstallDoctor, runRebuildEmptyDb}
 * @param {number} [input.now] 注入当前时间戳(测试用)
 * @returns {Promise<{ok:boolean, escalated:boolean, level:'none'|'L2'|'L3', reason:string,
 *                    action:string|null, l2:object|null, file:string|null, record:object|null}>}
 */
async function escalate(input = {}) {
  const base = {
    ok: true,
    escalated: false,
    level: 'none',
    reason: 'noop',
    action: null,
    l2: null,
    file: null,
    record: null,
  };
  try {
    const env = _env(input);
    if (!isEnabled(env)) {
      return { ...base, reason: 'gate-off' };
    }

    const plan = planEscalation(input.component);
    if (!plan.component || plan.component === 'unknown') {
      return { ...base, reason: 'no-component' };
    }

    const now = typeof input.now === 'number' ? input.now : Date.now();
    const deps = input.deps || {};
    const ioOpts = { env, cwd: input.cwd, khyDir: input.khyDir, force: input.force };

    if (_throttled(plan.component, now, ioOpts)) {
      _audit(
        {
          component: plan.component,
          action: 'escalation_throttled',
          target: plan.component,
          result: 'partial',
          details: {
            message: `升级冷却窗内跳过（${DEFAULT_COOLDOWN_HOURS}h 默认窗，KHY_HEAL_ESCALATION_COOLDOWN_HOURS 可调）`,
            trigger: input.trigger || null,
          },
        },
        deps
      );
      return { ...base, reason: 'cooldown' };
    }

    const attempts = normalizeAttempts(input.failedAttempts);
    let l2 = null;

    // ── L2:切换到更重的修复手段 ──
    if (plan.l2Action && !input.skipL2 && isL2Enabled(env)) {
      _audit(
        {
          component: plan.component,
          action: 'escalate_l1_to_l2',
          target: plan.command || plan.l2Label,
          result: 'partial',
          details: {
            message: formatUpgradeMessage('L1', 'L2', plan.l2Label),
            from: 'L1',
            to: 'L2',
            l2Action: plan.l2Action,
            failedAttempts: attempts,
            trigger: input.trigger || null,
          },
        },
        deps
      );

      const runner = _L2_RUNNERS[plan.l2Action];
      let res;
      try {
        res = await runner({ ...(input.context || {}), env }, deps);
      } catch (err) {
        res = { ok: false, error: String((err && err.message) || err) };
      }
      l2 = {
        ran: true,
        ok: !!(res && res.ok),
        error: res && res.ok ? null : (res && res.error) || 'l2_failed',
        detail: (res && res.detail) || null,
      };

      _audit(
        {
          component: plan.component,
          action: 'escalate_l2_result',
          target: plan.command || plan.l2Label,
          result: l2.ok ? 'success' : 'failure',
          details: {
            message: l2.ok
              ? `L2(${plan.l2Label}) 修复成功`
              : `L2(${plan.l2Label}) 失败: ${l2.error}`,
            l2Action: plan.l2Action,
            trigger: input.trigger || null,
          },
        },
        deps
      );

      if (l2.ok) {
        _markEscalated(plan.component, now, 'L2', ioOpts);
        return {
          ...base,
          escalated: true,
          level: 'L2',
          reason: 'l2-ok',
          action: plan.l2Action,
          l2,
        };
      }
    } else if (plan.l2Action) {
      l2 = {
        ran: false,
        ok: false,
        skipped: input.skipL2
          ? '调用方已自行执行过该手段并失败'
          : 'KHY_HEAL_ESCALATION_L2 已关闭',
        error: input.skipL2 ? 'l2_already_failed' : 'l2_gate_off',
      };
    }

    // ── L3:交人 ──
    const record = buildEscalationRecord({
      component: plan.component,
      plan,
      failedAttempts: attempts,
      context: input.context,
      trigger: input.trigger,
      l2,
      timestamp: new Date(now).toISOString(),
    });

    const file = getEscalationFilePath(ioOpts);
    const written = _writeJsonSafe(file, record);

    _audit(
      {
        component: plan.component,
        action: 'escalate_to_l3',
        target: written ? file : plan.component,
        result: 'failure',
        details: {
          message: formatUpgradeMessage(l2 && l2.ran ? 'L2' : 'L1', 'L3', null),
          from: l2 && l2.ran ? 'L2' : 'L1',
          to: 'L3',
          severity: record.severity,
          suggestedAction: record.suggestedAction,
          failedAttempts: record.failedAttempts,
          escalationFile: written ? file : null,
          trigger: input.trigger || null,
        },
      },
      deps
    );

    _emit(formatEscalationAlert(record, written ? file : null), deps);
    _markEscalated(plan.component, now, 'L3', ioOpts);

    return {
      ...base,
      ok: false,
      escalated: true,
      level: 'L3',
      reason: 'l3-handoff',
      action: plan.l2Action,
      l2,
      file: written ? file : null,
      record,
    };
  } catch (err) {
    // 升级机制自身故障:绝不抛回自愈调用方。
    return { ...base, ok: false, reason: 'error', error: String((err && err.message) || err) };
  }
}

/**
 * 读取待处理的 L3 记录(没有 → null)。供 `khy heal` 等入口提示「上次自愈已交人」。
 */
function readPendingEscalation(opts = {}) {
  return _readJsonSafe(getEscalationFilePath(opts));
}

/** 清除 L3 记录(人工处理完毕后调用)。返回是否真的删掉了文件。 */
function clearEscalation(opts = {}) {
  try {
    const fp = getEscalationFilePath(opts);
    if (!fs.existsSync(fp)) {
      return false;
    }
    fs.unlinkSync(fp);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  // 门控
  isEnabled,
  isL2Enabled,
  // 纯决策
  ESCALATION_TABLE,
  normalizeComponent,
  planEscalation,
  formatUpgradeMessage,
  normalizeAttempts,
  buildEscalationRecord,
  formatEscalationAlert,
  classifySourceHealFailure,
  // IO
  escalate,
  readPendingEscalation,
  clearEscalation,
  getEscalationFilePath,
  getEscalationStatePath,
  // 内部(测试/复用)
  _cooldownMs,
  _runRestore,
  _runFreshInstallDoctor,
  _runRebuildEmptyDb,
};
