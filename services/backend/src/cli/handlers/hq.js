'use strict';

/**
 * hq.js — `khy hq …` 命令族：任务/Bug 状态真源的操作面。
 *
 * 取代 khy-os-hq（指挥部）的 7 个 Python 脚本（`next.py` / `new_bug.py` /
 * `update_status.py` 等），数据真源在 `.ai/hq/`。能力吸收的背景与裁决见
 * `docs/03_DESIGN_设计/[DESIGN-ARCH-118] HQ 能力吸收与多机协作规范.md`。
 *
 *   khy hq status                    状态总览（Bug + 任务 + 模型路由 + 本机占用）
 *   khy hq next                      按 PROCESS-102 五档瀑布自动选取 → 渲染自包含提示词
 *   khy hq next --skip-health        跳过 G0 验收债清理，直接进入排程（人的显式指定权）
 *   khy hq next --bug BUG-001        指定 Bug 渲染修复提示词
 *   khy hq next --verify BUG-001     指定 Bug 渲染回归验证提示词
 *   khy hq next --task T-002         指定任务渲染提示词
 *   khy hq next --kind distill       手动渲染模板（不绑定 Bug/任务）
 *   khy hq verify [BUG-001]          只读体检（数据一致性 + 提示词结构）
 *   khy hq bug new "标题" --severity P1 --domain cli
 *   khy hq bug set BUG-001 pending_verify --root-cause "…" --fix "…" --note "…"
 *   khy hq task set T-002 done --note "…"
 *   khy hq states                    打印两张状态机与全部合法迁移
 *   khy hq release [ID]              释放本机占用（不迁移状态）
 *
 * 选项：`--json`（机读输出，供 AI/工具程序化消费）、`--copy`（复制到剪贴板）、
 *       `--out FILE`（写入文件）。
 *
 * 分工：纯逻辑与状态机在 `../hqStore.js`（零副作用叶子、可单测），本文件只做
 * 参数解析与终端呈现。**状态迁移的裁决权只在 `hqStore.canTransition`** ——
 * 非法迁移必须当场拒绝，与 HQ 原行为一致。
 *
 * @module handlers/hq
 */

const fs = require('fs');
const path = require('path');

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const H = require('../hqStore');

function _chalk() {
  try {
    const m = require('chalk');
    return m && m.default ? m.default : m;
  } catch {
    const id = (s) => s;
    return new Proxy({}, { get: () => id });
  }
}

/** printError/printInfo 由 router 注入，非交互场景回退 console。 */
function _say(ctx, kind, msg) {
  const fn = ctx && ctx[kind === 'err' ? 'printError' : kind === 'warn' ? 'printWarn' : 'printInfo'];
  if (typeof fn === 'function') {
    fn(msg);
    return;
  }
  console.log(msg);
}

/**
 * 解析 `khy hq <sub> …` 的位置参数与旗标。
 *
 * router 的通用解析器把 `--flag value` 收进 `options`，但 `khy hq` 的语义里
 * 「值」常常是中文标题或含空格的备注，交给通用解析器会被二次切分。故此处
 * **自己扫一遍 argv 形态的 args**，只把明确的 `--k v` 对摘出来，其余按位置留下。
 */
/**
 * 旗标赋值：**重复出现的旗标收进数组**，单次出现保持标量。
 *
 * 为什么改这里：`--scope "不改 A" --scope "不动 B"` 这类「多条边界」天然是
 * 重复旗标，旧逻辑会让后者覆盖前者 —— 用户以为写了两条边界，实际只存了一条，
 * 恰好是「边界锁失效」的静默形态。单值旗标（--note/--fix 等）行为不变：
 * 它们从不重复，出现重复时旧逻辑本就是「后者胜」的无意覆盖，收成数组只会
 * 更诚实，且写入端都有 `Array.isArray` 兜底。
 */
function _setFlag(flags, key, value) {
  if (!(key in flags)) {
    flags[key] = value;
    return;
  }
  const cur = flags[key];
  if (Array.isArray(cur)) {
    cur.push(value);
  } else {
    flags[key] = [cur, value];
  }
}

function parseArgs(args, options) {
  const positional = [];
  const flags = Object.assign({}, options || {});
  const list = Array.isArray(args) ? args.slice() : [];
  for (let i = 0; i < list.length; i += 1) {
    const tok = String(list[i]);
    const m = /^--([A-Za-z][\w-]*)(?:=(.*))?$/.exec(tok);
    if (!m) {
      positional.push(tok);
      continue;
    }
    const key = m[1];
    const negated = key.startsWith('no-');
    const canon = negated ? key.slice(3) : key;
    if (m[2] !== undefined) {
      _setFlag(flags, canon, m[2]);
    } else if (i + 1 < list.length && !/^--[A-Za-z]/.test(String(list[i + 1]))) {
      _setFlag(flags, canon, String(list[i + 1]));
      i += 1;
    } else {
      _setFlag(flags, canon, !negated);
    }
  }
  return { positional, flags };
}

function _truthy(v) {
  return v === true || v === 'true' || v === '1' || v === 'yes' || v === '';
}

function _severityLabel(sev) {
  return H.SEVERITY_NAME[sev] || sev || '?';
}

function _typeLabel(type) {
  return H.TYPE_NAME[type] || type || '?';
}

// ── status ───────────────────────────────────────────────────────

function _printStatus(c, data) {
  const line = '='.repeat(62);
  console.log(line);
  console.log(`khy-os 任务状态总览    khy_os v${data.khy_os_version}    ${data.date}`);
  console.log(line);

  console.log(`\n【Bug】共 ${data.bugs.length} 条`);
  if (!data.bugs.length) {
    console.log(c.dim('  (空) — 用 `khy hq bug new "标题"` 登记'));
  }
  for (const b of data.bugs) {
    const held = b.held_by_other
      ? c.yellow(` [他机占用→${b.claimed_by}]`)
      : b.claimed_by
        ? c.dim(' [本机占用]')
        : '';
    console.log(
      `  ${b.id} [${b.status}] ${_severityLabel(b.severity).padEnd(8)} ` +
        `${String(b.title || '').slice(0, 36)}${held}`
    );
  }

  const p = data.progress;
  console.log(`\n【路线图任务】进度 ${p.done}/${p.total} done`);
  for (const t of data.tasks) {
    const arrow = t.suggested_model ? `  -> ${t.suggested_model}` : '';
    const held = t.held_by_other
      ? c.yellow(` [他机占用→${t.claimed_by}]`)
      : t.claimed_by
        ? c.dim(' [本机占用]')
        : '';
    console.log(
      `  ${t.id} [${t.status}] ${_typeLabel(t.type)} P${String(t.priority || '?').replace(/^P/, '')}  ` +
        `${String(t.title || '').slice(0, 36)}${arrow}${held}`
    );
  }

  if (data.model_routing.length) {
    console.log('\n【模型路由】(strengths 非空者，详见 .ai/hq/MODELS.json)');
    for (const m of data.model_routing) {
      console.log(`  ${String(m.display).padEnd(12)} 擅长: ${(m.strengths || []).join(', ')}`);
    }
  }

  console.log(`\n【本机标识】${data.machine_id}   (KHY_MACHINE_ID 可覆盖)`);
  console.log(`【数据真源】${data.khy_os_path}`);
}

async function cmdStatus(ctx, flags) {
  const data = H.buildStatus(null);
  if (_truthy(flags.json)) {
    console.log(JSON.stringify(data, null, 2));
    return true;
  }
  const c = _chalk();
  _printStatus(c, data);
  return true;
}

// ── next ─────────────────────────────────────────────────────────

const _STAGE_NAME = {
  G1: 'G1 救火 · open Bug',
  G2: 'G2 要事 · P0/P1 待办',
  G3: 'G3 次事 · P2/P3 待办',
};

function _evidenceLine(ev) {
  if (!ev) {
    return '';
  }
  return `open Bug ${ev.openBugs} · P0/P1 待办 ${ev.todoP01} · P2/P3 待办 ${ev.todoP23} · `
    + `待验证 Bug ${ev.pendingVerify} · 待验收任务 ${ev.reviewTasks} · 过期租约 ${ev.staleClaims}`;
}

/** 依 CLI 选择解析出 (kind, mapping, label, itemId)。 */
function _resolveNext(positional, flags, me) {
  const root = null;
  const all = H.loadAll(root);
  if (!all.bugs.ok) {
    return { error: `BUGS.json 无法读取: ${all.bugs.error}` };
  }
  if (!all.progress.ok) {
    return { error: `PROGRESS.json 无法读取: ${all.progress.error}` };
  }
  const base = { KHYOS_PATH: H.khyosPathExpr(root) };

  const kindFlag = flags.kind;
  if (kindFlag) {
    const label = H.KIND_NAME[kindFlag] || H.TYPE_NAME[kindFlag] || kindFlag;
    return { kind: kindFlag, mapping: base, label, itemId: null };
  }

  const bugId = flags.bug || positional[0];
  const verifyId = flags.verify;
  if (verifyId || flags['verify-only']) {
    const id = verifyId || bugId;
    const bug = H.findItem(all.bugs.data.bugs, id);
    if (!bug) {
      const ids = (all.bugs.data.bugs || []).map((b) => b.id).join(', ') || '(空)';
      return { error: `未找到 ${id}。现有: ${ids}` };
    }
    return {
      kind: 'verify',
      mapping: Object.assign({}, base, H.bugMapping(bug)),
      label: H.KIND_NAME.verify,
      itemId: bug.id,
    };
  }
  if (flags.bug) {
    const bug = H.findItem(all.bugs.data.bugs, flags.bug);
    if (!bug) {
      const ids = (all.bugs.data.bugs || []).map((b) => b.id).join(', ') || '(空)';
      return { error: `未找到 ${flags.bug}。现有: ${ids}` };
    }
    return {
      kind: 'bug',
      mapping: Object.assign({}, base, H.bugMapping(bug)),
      label: H.KIND_NAME.bug,
      itemId: bug.id,
    };
  }
  if (flags.task) {
    const task = H.findItem(all.progress.data.tasks, flags.task);
    if (!task) {
      const ids = (all.progress.data.tasks || []).map((t) => t.id).join(', ') || '(空)';
      return { error: `未找到 ${flags.task}。现有: ${ids}` };
    }
    const kind = task.type || 'feature';
    const models = H.readJsonSafe(all.paths.models);
    const [disp, entry] = H.modelHint(models.ok ? models.data : {}, kind, task.domain || '');
    return {
      kind,
      mapping: Object.assign({}, base, H.taskMapping(task)),
      label:
        _typeLabel(kind) + (disp ? ` [推荐入口: ${disp} -> ${entry}]` : ''),
      itemId: task.id,
    };
  }

  const picked = H.pickNext(all.bugs.data, all.progress.data, me, new Date(), {
    skipHealth: _truthy(flags['skip-health']),
  });
  if (picked.action === 'idle') {
    return { idle: true, evidence: picked.evidence };
  }
  if (picked.action === 'health') {
    return { health: picked.items, evidence: picked.evidence };
  }
  if (picked.action === 'ask') {
    return { ask: picked };
  }
  // pick：带档位与证据，供渲染引用（PROCESS-102：答案必须可举证）
  if (picked.kind === 'bug') {
    return {
      kind: 'bug',
      mapping: Object.assign({}, base, H.bugMapping(picked.item)),
      label: H.KIND_NAME.bug,
      itemId: picked.item.id,
      stage: picked.stage,
      evidence: picked.evidence,
    };
  }
  const kind = picked.item.type || 'feature';
  const models = H.readJsonSafe(all.paths.models);
  const [disp] = H.modelHint(models.ok ? models.data : {}, kind, picked.item.domain || '');
  return {
    kind,
    mapping: Object.assign({}, base, H.taskMapping(picked.item)),
    label: _typeLabel(kind) + (disp ? ` [推荐入口: ${disp}]` : ''),
    itemId: picked.item.id,
    paths: all.paths,
    stage: picked.stage,
    evidence: picked.evidence,
  };
}

/**
 * 领取占用（任务或 Bug）。返回 `{ok, reason}`。
 * 这一步是「两台机器不会挑中同一条」的落地点：他机持有存活租约时拒绝渲染。
 */
function _claim(kind, itemId, me) {
  if (!itemId) {
    return { ok: true };
  }
  const p = H.paths(null);
  if (kind === 'task' || /^T-/.test(itemId)) {
    const doc = H.readJsonSafe(p.progress);
    if (!doc.ok) {
      return { ok: false, reason: `PROGRESS.json 无法读取: ${doc.error}` };
    }
    const task = H.findItem(doc.data.tasks, itemId);
    if (!task) {
      return { ok: false, reason: `未找到任务 ${itemId}` };
    }
    if (H.heldByOther(task, me)) {
      return {
        ok: false,
        reason: `任务已被 ${task.claimed_by} 占用（租约至 ${task.lease_expires}）`,
      };
    }
    Object.assign(task, H.stampClaim({}, me));
    H.saveJson(p.progress, doc.data);
    H.log(`claim task ${itemId} by ${me}`, p.root);
    return { ok: true };
  }
  if (/^BUG-/.test(itemId)) {
    const doc = H.readJsonSafe(p.bugs);
    if (!doc.ok) {
      return { ok: false, reason: `BUGS.json 无法读取: ${doc.error}` };
    }
    const bug = H.findItem(doc.data.bugs, itemId);
    if (!bug) {
      return { ok: false, reason: `未找到 Bug ${itemId}` };
    }
    if (H.heldByOther(bug, me)) {
      return {
        ok: false,
        reason: `Bug 已被 ${bug.claimed_by} 占用（租约至 ${bug.lease_expires}）`,
      };
    }
    Object.assign(bug, H.stampClaim({}, me));
    H.saveJson(p.bugs, doc.data);
    H.log(`claim bug ${itemId} by ${me}`, p.root);
    return { ok: true };
  }
  return { ok: true };
}

function _copyToClipboard(text) {
  try {
    const { spawnSync } = require('child_process');
    if (process.platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-Command', '$input | Set-Clipboard'], {
        input: text,
        encoding: 'utf-8',
        timeout: 15000,
      });
      return !r.error && r.status === 0;
    }
    const cmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip';
    const argv = process.platform === 'darwin' ? [] : ['-selection', 'clipboard'];
    const r = spawnSync(cmd, argv, { input: text, encoding: 'utf-8', timeout: 15000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

async function cmdNext(ctx, positional, flags) {
  const c = _chalk();
  const me = H.machineId();
  const r = _resolveNext(positional, flags, me);

  if (r.error) {
    _say(ctx, 'err', `[ERROR] ${r.error}`);
    process.exitCode = 1;
    return true;
  }
  if (r.health) {
    const msg = {
      action: 'health',
      stage: 'G0',
      message: '先还验收债与清理滞留状态，清完自动恢复正常排程（PROCESS-102）',
      evidence: r.evidence,
      items: r.health.map((h) => ({
        id: h.item.id,
        kind: h.kind,
        severity: h.item.severity || h.item.priority,
        title: h.item.title,
        reason: h.reason,
        howto: h.howto,
      })),
      skip_how: '确需先领新活: khy hq next --skip-health',
    };
    if (_truthy(flags.json)) {
      console.log(JSON.stringify(msg, null, 2));
      return true;
    }
    console.log(`=== 建议下一步：G0 健康 · 瓶颈解锁（${r.health.length} 条，暂不排新活）===`);
    for (const h of r.health) {
      const sev = h.item.severity || h.item.priority || '?';
      console.log(`- [${h.item.id}] ${sev} · ${h.reason} → ${h.howto}`);
      if (h.item.title) console.log(c.dim(`    ${h.item.title}`));
    }
    console.log(`证据: ${_evidenceLine(r.evidence)}`);
    console.log('清完后重跑 khy hq next 即恢复正常排程；确需先领新活: khy hq next --skip-health');
    return true;
  }

  if (r.ask) {
    const msg = {
      action: 'ask',
      stage: 'G4',
      tied_in: r.ask.stage,
      message: '同档并列且评分无法决胜——按 PROCESS-102 停下来问，不按登记顺序任取',
      candidates: r.ask.candidates.map((cd) => ({
        id: cd.item.id,
        kind: cd.kind,
        severity: cd.item.severity || cd.item.priority,
        title: cd.item.title,
        why: cd.why,
      })),
      evidence: r.ask.evidence,
    };
    if (_truthy(flags.json)) {
      console.log(JSON.stringify(msg, null, 2));
      return true;
    }
    const c0 = c;
    console.log(`=== 建议下一步：G4 停下来，由你定（并列于 ${r.ask.stage} 档）===`);
    r.ask.candidates.forEach((cd, i) => {
      const sev = cd.item.severity || cd.item.priority || '?';
      console.log(`${i + 1}. [${cd.item.id}] ${sev} · ${cd.item.domain || ''} — ${cd.item.title || ''}（${cd.why}）`);
    });
    console.log('今天想动哪个方向？直接指定: khy hq next --task T-XXX 或 --verify BUG-XXX');
    console.log(c0.dim('或补登评分让系统下次能决胜: khy hq task note <ID> --cod 1-5 --conf 1-3 --size S|M|L'));
    return true;
  }

  if (r.idle) {
    const msg = {
      action: 'idle',
      message: '没有待办：无 open Bug、无 todo 任务',
      evidence: r.evidence,
      how_to_add: 'khy hq bug new "标题" 登记新 Bug；或在 .ai/hq/PROGRESS.json 规划任务',
    };
    if (_truthy(flags.json)) {
      console.log(JSON.stringify(msg, null, 2));
    } else {
      console.log(msg.message);
      console.log(msg.how_to_add);
    }
    return true;
  }

  // 领取占用（渲染前）。被他机占用的条目拒绝渲染并给出明确理由。
  const claim = _claim(r.kind, r.itemId, me);
  if (!claim.ok) {
    if (_truthy(flags.json)) {
      console.log(
        JSON.stringify({ action: 'blocked', item_id: r.itemId, reason: claim.reason }, null, 2)
      );
    } else {
      _say(ctx, 'warn', `[WARN] ${claim.reason}`);
      console.log(
        '该条目已被其他机器占用，为避免两机重复工作，本机暂不渲染。' +
          '可在其租约到期后再领，或先与另一台机器确认进度。'
      );
    }
    process.exitCode = 2;
    return true;
  }

  const tpl = H.loadTemplate(r.kind, null);
  if (!tpl.ok) {
    _say(ctx, 'err', `[ERROR] ${tpl.error}`);
    process.exitCode = 1;
    return true;
  }
  const prompt = H.renderPrompt(tpl.body, r.mapping);
  const out = {
    action: 'prompt',
    kind: r.kind,
    label: r.label,
    item_id: r.itemId,
    stage: r.stage,
    evidence: r.evidence,
    khy_os_path: H.khyosPathExpr(null),
    machine_id: me,
    prompt,
  };

  if (_truthy(flags.json)) {
    console.log(JSON.stringify(out, null, 2));
    return true;
  }

  console.log(`=== 建议下一步：${r.label} ===`);
  if (r.stage) {
    console.log(`档位依据: ${_STAGE_NAME[r.stage] || r.stage} · 证据: ${_evidenceLine(r.evidence)}`);
  }

  if (flags.out) {
    try {
      require('fs').writeFileSync(String(flags.out), prompt, 'utf-8');
      console.log(c.green(`[OK] 提示词已写入: ${flags.out}`));
    } catch (err) {
      _say(ctx, 'err', `[ERROR] 写入失败: ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    }
  }
  if (_truthy(flags.copy)) {
    console.log(
      _copyToClipboard(prompt) ? c.green('[OK] 已复制到剪贴板') : c.yellow('[WARN] 剪贴板失败，请手动复制')
    );
  }
  if (!flags.out) {
    console.log('');
    console.log(prompt);
  }

  if (r.itemId) {
    const isBug = /^BUG-/.test(r.itemId);
    const targetState = isBug || r.kind === 'verify' ? 'pending_verify' : 'review';
    console.log('');
    console.log('接下来（会话协议）：');
    console.log('  1. 把上面提示词交给在 khy-os 里打开的任意 AI 执行');
    console.log('  2. 拿到结果后回填状态：');
    console.log(
      `     khy hq ${isBug ? 'bug' : 'task'} set ${r.itemId} ${targetState} [--note "..."]`
    );
    console.log('  3. 收工门禁：npm run check:structure');
    console.log(c.dim('  状态机速查：khy hq states'));
  }

  H.log(`next rendered kind=${r.kind} item=${r.itemId || '-'} copy=${Boolean(flags.copy)} json=${Boolean(flags.json)}`);
  return true;
}

// ── verify ───────────────────────────────────────────────────────

async function cmdVerify(ctx, positional, flags) {
  const c = _chalk();
  const idFilter = positional[0] || flags.bug || null;
  const report = H.validateDataset(null);

  let errors = report.errors;
  let warnings = report.warnings;
  if (idFilter) {
    errors = errors.filter((e) => e.includes(idFilter));
    warnings = warnings.filter((e) => e.includes(idFilter));
  }

  if (_truthy(flags.json)) {
    console.log(
      JSON.stringify(
        { ok: errors.length === 0, filter: idFilter, errors, warnings, checks: report.checks },
        null,
        2
      )
    );
    if (errors.length) {
      process.exitCode = 1;
    }
    return true;
  }

  console.log('');
  console.log(c.bold(`  khy hq 数据体检${idFilter ? `（过滤 ${idFilter}）` : ''}`));
  console.log('');
  for (const chk of report.checks) {
    if (!idFilter) {
      console.log(`  ${c.green('✓')} ${chk}`);
    }
  }
  for (const w of warnings) {
    console.log(`  ${c.yellow('!')} ${w}`);
  }
  for (const e of errors) {
    console.log(`  ${c.red('✗')} ${e}`);
  }
  console.log('');
  if (errors.length) {
    console.log(c.red(`  ${errors.length} 条 error，${warnings.length} 条 warning`));
    process.exitCode = 1;
  } else {
    console.log(c.green(`  0 error，${warnings.length} 条 warning`));
  }
  console.log('');
  return true;
}

// ── bug new / bug set / task set ─────────────────────────────────

function _nextBugId(doc) {
  let next = doc.next_id || 1;
  const max = (doc.bugs || []).reduce((acc, b) => {
    const m = /^BUG-(\d+)$/.exec(String((b && b.id) || ''));
    return m ? Math.max(acc, parseInt(m[1], 10)) : acc;
  }, 0);
  // next_id 若落后于已用编号（历史数据被手工编辑过），取 max+1 兜底 —— 撞 ID 的代价
  // 远高于编号跳号，宁可跳号。
  if (next <= max) {
    next = max + 1;
  }
  return { id: `BUG-${String(next).padStart(3, '0')}`, next_id: next + 1 };
}

async function cmdBugNew(ctx, positional, flags) {
  const c = _chalk();
  const p = H.paths(null);
  const doc = H.readJsonSafe(p.bugs);
  if (!doc.ok) {
    _say(ctx, 'err', `[ERROR] BUGS.json 无法读取: ${doc.error}`);
    process.exitCode = 1;
    return true;
  }

  const title = [...positional].join(' ').trim();
  if (!title) {
    _say(ctx, 'err', '[ERROR] 标题不能为空');
    console.log(c.dim('  用法: khy hq bug new "标题" [--severity P1] [--domain cli]' +
      ' [--symptom "…"] [--repro "…"] [--suspect "…"]'));
    process.exitCode = 1;
    return true;
  }

  const severity = String(flags.severity || 'P2').toUpperCase();
  if (!H.SEVERITIES.includes(severity)) {
    _say(ctx, 'err', `[ERROR] 无效严重度: ${severity}，可选: ${H.SEVERITIES.join('/')}`);
    process.exitCode = 1;
    return true;
  }
  const domain = String(flags.domain || 'services');
  if (!H.DOMAINS.includes(domain)) {
    _say(ctx, 'err', `[ERROR] 无效域: ${domain}，可选: ${H.DOMAINS.join(', ')}`);
    process.exitCode = 1;
    return true;
  }

  const { id, next_id } = _nextBugId(doc.data);
  const bug = {
    id,
    title,
    severity,
    domain,
    status: 'open',
    symptom: flags.symptom || '',
    repro: flags.repro || '',
    suspect_area: flags.suspect || '',
    root_cause: '',
    fix_summary: '',
    created: H.today(),
    updated: H.today(),
    notes: [],
  };

  const errs = H.validateBug(bug);
  if (errs.length) {
    for (const e of errs) {
      _say(ctx, 'err', `[ERROR] ${e}`);
    }
    process.exitCode = 1;
    return true;
  }

  doc.data.bugs = doc.data.bugs || [];
  doc.data.bugs.push(bug);
  doc.data.next_id = next_id;
  H.saveJson(p.bugs, doc.data);
  H.log(`new_bug ${id} [${severity}] ${title} (${domain})`, p.root);

  console.log('');
  console.log('='.repeat(50));
  console.log(c.green(`[OK] 已登记 ${id} | 优先级 ${severity} | 域 ${domain}`));
  console.log(`下一步：khy hq next --bug ${id}    即可生成修复提示词`);
  console.log('');
  return true;
}

/**
 * `review -> done` 的验收清算门（薄呈现层，判定在 `H.reviewDoneBlockers`）。
 *
 * 存在意义：把「拒绝的理由」讲成一个**可执行的动作清单**，而不是一句「校验失败」。
 * 实测教训（`[DESIGN-DELIV-001]` §1.2）：本仓有过「打印 7 PASS 但恒返回 0」的记分板，
 * 也有过「字段定义了但 23 条一条没填」的 `cod/conf/size`。所以这道门必须在
 * `done` 那一刻返回非零并明确说「差什么、怎么补」。
 *
 * @param {object} task
 * @param {object} flags
 * @returns {{ok: boolean, error?: string, blockers?: string[], warnings?: string[], verdicts?: object[]}}
 */
function _gateReviewToDone(task, flags) {
  const repoRoot = H.REPO_ROOT;
  const { blockers, warnings, verdicts } = H.reviewDoneBlockers(task, repoRoot, H.feedbackDir());

  if (blockers.length) {
    const c = _chalk();
    const lines = [];
    lines.push(`${task.id} 尚不具备翻 done 的条件（${blockers.length} 项未满足）：`);
    blockers.forEach((b, i) => lines.push(`  ${i + 1}. ${b}`));
    if (warnings.length) {
      lines.push('');
      lines.push('同时有提醒（不阻断）：');
      warnings.forEach((w) => lines.push(`  ! ${w}`));
    }
    lines.push('');
    lines.push(c.dim(`  acceptance 共 ${H.splitAcceptance(task.acceptance).length} 条判据，` +
      `已清算 ${verdicts.length} 条`));
    lines.push(c.dim(`  生成清算模板：khy hq accept ${task.id}`));
    return { ok: false, error: lines.join('\n'), blockers, warnings, verdicts };
  }

  // 通过：把清算结果写回任务，供后续复核（不写证据全文，只写摘要）
  task.acceptance_audit = {
    at: H.today(),
    total: verdicts.length,
    verdicts: verdicts.map((v) => `${v.result}:${v.title}`.slice(0, 80)),
  };
  return { ok: true, warnings, verdicts };
}

/** 状态迁移的公共实现（Bug 与任务共用）。 */
function _applyState(kind, itemId, newState, flags) {
  const p = H.paths(null);
  const file = kind === 'bug' ? p.bugs : p.progress;
  const doc = H.readJsonSafe(file);
  if (!doc.ok) {
    return { ok: false, error: `${path.basename(file)} 无法读取: ${doc.error}` };
  }

  const list = kind === 'bug' ? doc.data.bugs : doc.data.tasks;
  const item = H.findItem(list, itemId);
  if (!item) {
    const ids = (list || []).map((x) => x.id).join(', ') || '(空)';
    return { ok: false, error: `未找到 ${itemId}。现有: ${ids}` };
  }

  if (!H.isValidState(kind, newState)) {
    const all = kind === 'bug' ? H.BUG_STATES : H.TASK_STATES;
    return { ok: false, error: `无效${kind === 'bug' ? ' Bug ' : '任务'}状态: ${newState}，可选: ${all.join(', ')}` };
  }

  const from = item.status;
  const verdict = H.canTransition(kind, from, newState);
  if (!verdict.ok) {
    return { ok: false, error: verdict.error, illegal: true };
  }

  // ── 验收清算前置（仅任务 review -> done）────────────────────────
  // 这是本次改动的核心：`review -> done` 此前是一个**裸箭头**，无任何前置条件。
  // 现在改成「必须附验收证据」。判定逻辑在 `hqStore.reviewDoneBlockers`
  // （纯逻辑、可单测），这里只负责「拒绝写入并把原因说清楚」。
  //
  // ⚠ 刻意不放进 `scripts/ci/`：判据查的是 `.ai/hq/` 这个**多机共享的任务账本**，
  // 按天变动，不是代码。做成 commit 门会让「改任务状态」变阻塞式操作，反而促使绕过。
  // 依据是本仓既定裁决「能落在命令写入路径上的约束，就不要升级成检查器」。
  if (kind === 'task' && newState === 'done') {
    const gate = _gateReviewToDone(item, flags);
    if (!gate.ok) {
      return { ok: false, error: gate.error, gateFailed: true, gate };
    }
  }

  // ── 入口锁边界（仅任务 todo -> doing）──────────────────────────
  //
  // 「偏离」的入口根因（2026-09-23 取证）：任务只锁了「目标」（acceptance），
  // 没锁「边界」。RUNTIME-008 的五问第 5 问「不做什么」此前只在改动级生效，
  // 任务开工时从未被问过。现在开工必须先写一句边界 —— 这是 scope_guard
  // 「必填」的唯一落点。validateTask 里刻意不要求必填（存量不追溯、且
  // 「字段定义了没人填」的 cod/conf/size 教训是**校验放错了地方**）：
  // 校验放在写入路径的最窄处（这一刻），才拦得住人。
  if (kind === 'task' && from === 'todo' && newState === 'doing') {
    const sg = Array.isArray(item.scope_guard)
      ? item.scope_guard.filter((s) => String(s || '').trim())
      : [];
    if (!sg.length) {
      return {
        ok: false,
        scopeGuardMissing: true,
        error:
          `${itemId} 开工前必须先声明边界（scope_guard）—— 至少一条「不做什么」。\n` +
          `  这是 BUILD 五问的第 5 问（RUNTIME-008），不锁边界的长任务必然漂移。\n` +
          `  用法（每条边界一次调用，逐条追加）：khy hq task note ${itemId} --scope "不改 services/backend 以外"\n` +
          `  ⚠ 同一命令里重复 --scope 会被 router 的通用解析器折叠成最后一个（router.js options 解析 last-wins），\n` +
          `  所以不要试图一行写多条 —— 多跑几次 task note 即可。\n` +
          `  写完再执行：khy hq task set ${itemId} doing`,
      };
    }
  }
  if (kind === 'task' && flags.scope !== undefined) {
    const values = Array.isArray(flags.scope) ? flags.scope : [flags.scope];
    const cleaned = values.map((s) => String(s || '').trim()).filter(Boolean);
    if (cleaned.length) {
      item.scope_guard = [...new Set([...(Array.isArray(item.scope_guard) ? item.scope_guard : []), ...cleaned])];
    }
  }

  item.status = newState;
  item.updated = H.today();
  // 任何状态迁移都是「所有权转移」：清掉占用/租约，避免 stale claim 停在
  // pending_verify / review 上让下一台机器误判「已有人在做」。
  H.clearClaim(item);

  // `--evidence`：把证据目录**写进任务**，让存证与任务产生可检索的绑定。
  // 此前 `.khy/feedback/` 下 52 个目录零个被引用（本仓曾 grep `feedback` 命中 0 次），
  // 就是因为目录名手工拼、任务里无处声明。
  if (kind === 'task' && flags.evidence) {
    item.evidence = String(flags.evidence).trim();
  }
  if (kind === 'task' && flags['baseline-metrics']) {
    try {
      const bm = JSON.parse(String(flags['baseline-metrics']));
      if (bm && typeof bm === 'object' && !Array.isArray(bm)) {
        item.baseline_metrics = Object.assign({}, item.baseline_metrics, bm);
      }
    } catch {
      /* 形状非法时交由 validateTask 在 verify 时报出，此处不阻断迁移 */
    }
  }

  if (kind === 'bug') {
    if (flags['root-cause']) {
      item.root_cause = String(flags['root-cause']);
    }
    if (flags.fix) {
      item.fix_summary = String(flags.fix);
    }
  }
  if (flags.note) {
    item.notes = item.notes || [];
    item.notes.push(`${H.today()}: ${flags.note}`);
  }

  H.saveJson(file, doc.data);

  // ROADMAP.md 同步（仅任务）：把表格行里的状态列改写为新状态。
  let synced = null;
  if (kind === 'task') {
    synced = _syncRoadmap(p.roadmap, itemId, newState);
  }

  H.log(`${kind} ${itemId} ${from} -> ${newState}${flags.note ? ' | ' + flags.note : ''}`, p.root);
  return { ok: true, from, to: newState, synced, item };
}

/**
 * 同步 ROADMAP.md 的状态列。
 *
 * `null` = 文件不可读；`false` = 文件可读但没找到该任务的行；`true` = 已改写。
 * 区分这三态很重要：原 Python 版把「文件不存在」也归成「未找到行」，会掩盖真实故障。
 */
function _syncRoadmap(roadmapFile, taskId, newState) {
  let text;
  try {
    text = require('fs').readFileSync(roadmapFile, 'utf-8');
  } catch {
    return null;
  }
  const esc = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `^(\\|\\s*${esc}\\s*\\|.*)\\|\\s*(?:${H.TASK_STATES.join('|')})\\s*\\|\\s*$`,
    'm'
  );
  const out = text.replace(re, (_m, head) => `${head}| ${newState} |`);
  if (out === text) {
    return false;
  }
  try {
    require('fs').writeFileSync(roadmapFile, out, 'utf-8');
    return true;
  } catch {
    return null;
  }
}

async function cmdBugSet(ctx, positional, flags) {
  const c = _chalk();
  const [itemId, newState] = positional;
  if (!itemId || !newState) {
    _say(ctx, 'err', '[ERROR] 用法: khy hq bug set <BUG-ID> <状态> [--note "…"]' +
      ' [--root-cause "…"] [--fix "…"]');
    process.exitCode = 1;
    return true;
  }
  const r = _applyState('bug', itemId, newState, flags);
  if (!r.ok) {
    _say(ctx, 'err', `[ERROR] ${r.error}`);
    if (r.illegal) {
      console.log(c.dim('  合法迁移一览: khy hq states'));
    }
    process.exitCode = 1;
    return true;
  }
  console.log(c.green(`[OK] ${itemId} ${r.from} -> ${r.to}`));
  if (r.to === 'pending_verify') {
    console.log(`下一步：khy hq next --verify ${itemId}  生成回归验证提示词`);
  }
  return true;
}

async function cmdTaskSet(ctx, positional, flags) {
  const c = _chalk();
  const [itemId, newState] = positional;
  if (!itemId || !newState) {
    _say(ctx, 'err', '[ERROR] 用法: khy hq task set <T-ID> <状态> [--note "…"]');
    process.exitCode = 1;
    return true;
  }
  const r = _applyState('task', itemId, newState, flags);
  if (!r.ok) {
    // 验收清算门的拒绝自带多行说明，不走单行 [ERROR] 方言 —— 它要教人怎么补，
    // 而不是只说「不合法」（状态机非法迁移才用单行方言）。
    if (r.gateFailed) {
      console.log(c.red(`[REFUSED] ${itemId} review -> done 被拒`));
      console.log('');
      console.log(r.error);
      process.exitCode = 1;
      return true;
    }
    _say(ctx, 'err', `[ERROR] ${r.error}`);
    if (r.illegal) {
      console.log(c.dim('  合法迁移一览: khy hq states'));
    }
    process.exitCode = 1;
    return true;
  }
  const tail =
    r.synced === false
      ? '  (提示：ROADMAP.md 中未找到可同步的表格行)'
      : r.synced === null
        ? '  (提示：ROADMAP.md 不可读，未同步)'
        : '';
  console.log(c.green(`[OK] ${itemId} ${r.from} -> ${r.to}`) + tail);
  if (r.to === 'done' && r.item && r.item.acceptance_audit) {
    console.log(c.dim(`  验收清算已入账：${r.item.acceptance_audit.total} 条判据全部有结果`));
  }
  return true;
}

// ── note（只补备注，不动状态）───────────────────────────────────

/**
 * 追加一条工作备注，**不迁移状态**。
 *
 * 为什么单独有这条命令：状态机只允许「合法迁移」，但很多真实场景是「状态不变、
 * 只想补记一句」（例如回归验证提示词要求先补 `root_cause` 再渲染）。若强行复用
 * `bug set <ID> <同一个状态>`，会被状态机按「终态/自环」正确拒绝 —— 那就把用户
 * 逼去手改 JSON，绕过全部校验。所以单独开一条只写 `notes` 的窄命令：它不碰
 * `status`，也就不需要过状态机。
 */
function _applyNote(kind, itemId, flags) {
  const p = H.paths(null);
  const file = kind === 'bug' ? p.bugs : p.progress;
  const doc = H.readJsonSafe(file);
  if (!doc.ok) {
    return { ok: false, error: `${path.basename(file)} 无法读取: ${doc.error}` };
  }
  const list = kind === 'bug' ? doc.data.bugs : doc.data.tasks;
  const item = H.findItem(list, itemId);
  if (!item) {
    const ids = (list || []).map((x) => x.id).join(', ') || '(空)';
    return { ok: false, error: `未找到 ${itemId}。现有: ${ids}` };
  }
  const scopeValues = flags.scope === undefined
    ? []
    : (Array.isArray(flags.scope) ? flags.scope : [flags.scope]).map((s) => String(s || '').trim()).filter(Boolean);
  if (!flags.note && !flags['root-cause'] && !flags.fix && !scopeValues.length
    && flags.cod === undefined && flags.conf === undefined && flags.size === undefined) {
    return { ok: false, error: '没有任何可写入的内容（--note / --scope / --root-cause / --fix / --cod / --conf / --size 至少给一个）' };
  }
  if (kind === 'task' && scopeValues.length) {
    // scope_guard 是「边界清单」，允许追加但**不允许清空**：
    // `--scope ""` 之类只会被过滤掉，绝不覆盖已有边界 —— 清空边界等于拆锁。
    const existing = Array.isArray(item.scope_guard) ? item.scope_guard.filter((s) => String(s || '').trim()) : [];
    item.scope_guard = [...new Set([...existing, ...scopeValues])];
  }
  if (kind === 'task' && (flags.cod !== undefined || flags.conf !== undefined || flags.size !== undefined)) {
    const candidate = Object.assign({}, item);
    if (flags.cod !== undefined) candidate.cod = Number(flags.cod);
    if (flags.conf !== undefined) candidate.conf = Number(flags.conf);
    if (flags.size !== undefined) candidate.size = String(flags.size).toUpperCase();
    const bad = H.validateTask(candidate).filter((e) => /cod|conf|size/.test(e));
    if (bad.length) {
      return { ok: false, error: `评分字段非法: ${bad.join('；')}（cod 1-5 / conf 1-3 / size S|M|L）` };
    }
    if (flags.cod !== undefined) item.cod = candidate.cod;
    if (flags.conf !== undefined) item.conf = candidate.conf;
    if (flags.size !== undefined) item.size = candidate.size;
  }
  if (flags.note) {
    item.notes = item.notes || [];
    item.notes.push(`${H.today()}: ${flags.note}`);
  }
  if (kind === 'bug' && flags['root-cause']) {
    item.root_cause = String(flags['root-cause']);
  }
  if (kind === 'bug' && flags.fix) {
    item.fix_summary = String(flags.fix);
  }
  item.updated = H.today();
  H.saveJson(file, doc.data);
  H.log(`${kind} ${itemId} note appended${flags.note ? ' | ' + flags.note : ''}`, p.root);
  return { ok: true, item };
}

async function cmdNote(ctx, kind, positional, flags) {
  const c = _chalk();
  const itemId = positional[0];
  if (!itemId) {
    _say(ctx, 'err', `[ERROR] 用法: khy hq ${kind} note <ID> [--note "…"] [--scope "…"(仅任务;一条一次调用,可多次执行追加)] [--root-cause "…"] [--fix "…"] [--cod 1-5 --conf 1-3 --size S|M|L]`);
    process.exitCode = 1;
    return true;
  }
  const r = _applyNote(kind, itemId, flags);
  if (!r.ok) {
    _say(ctx, 'err', `[ERROR] ${r.error}`);
    process.exitCode = 1;
    return true;
  }
  if (kind === 'task' && Array.isArray(r.item.scope_guard) && r.item.scope_guard.length) {
    console.log(c.green(`[OK] ${itemId} 备注已追加（状态保持 ${r.item.status} 不变）`));
    console.log(c.dim(`  当前边界 ${r.item.scope_guard.length} 条: ${r.item.scope_guard.join(' ; ')}`));
    return true;
  }
  console.log(c.green(`[OK] ${itemId} 备注已追加（状态保持 ${r.item.status} 不变）`));
  return true;
}

// ── accept（生成验收清算模板）────────────────────────────────────

/**
 * `khy hq accept <T-ID> [--evidence <名称>]` —— 生成验收清算模板到
 * `.khy/feedback/<名称>/acceptance.md`，**按 `acceptance` 的实际判据逐条预填骨架**。
 *
 * 为什么要生成而不是让人手写：`acceptance` 的分句是机器可解析的（实测 23 条
 * 分句数 1~7 不等），预填骨架能把「逐条勾选」变成填空而不是回忆 ——
 * 回忆会漏，填空不会。且骨架里已经含 `结果:` 占位，`reviewDoneBlockers`
 * 会因取值非法而拒收未填的模板，**不会出现「生成了模板就算完成」**。
 *
 * 只读 + 单文件写入（目标不存在才写；已存在则只打印路径，绝不覆盖）。
 */
async function cmdAccept(ctx, positional, flags) {
  const c = _chalk();
  const itemId = positional[0];
  if (!itemId) {
    _say(ctx, 'err', '[ERROR] 用法: khy hq accept <T-ID> [--evidence <名称>]');
    process.exitCode = 1;
    return true;
  }
  const p = H.paths(null);
  const doc = H.readJsonSafe(p.progress);
  if (!doc.ok) {
    _say(ctx, 'err', `[ERROR] PROGRESS.json 无法读取: ${doc.error}`);
    process.exitCode = 1;
    return true;
  }
  const task = H.findItem(doc.data.tasks, itemId);
  if (!task) {
    _say(ctx, 'err', `[ERROR] 未找到 ${itemId}`);
    process.exitCode = 1;
    return true;
  }

  const items = H.splitAcceptance(task.acceptance);
  if (!items.length) {
    _say(ctx, 'err', `[ERROR] ${itemId} 的 acceptance 为空 —— 先补完成定义，再生成清算模板`);
    process.exitCode = 1;
    return true;
  }

  const name = String(flags.evidence || task.evidence || '').trim();
  if (!name) {
    _say(ctx, 'err', `[ERROR] 缺 --evidence <名称>（且 ${itemId} 上也没存过 evidence 字段）`);
    console.log(c.dim(`  建议名称：${itemId.toLowerCase()}-<slug>，例如 ${itemId.toLowerCase()}-split-batch`));
    process.exitCode = 1;
    return true;
  }
  if (!H.EVIDENCE_NAME_RE.test(name)) {
    _say(ctx, 'err', `[ERROR] evidence 名称非法: ${JSON.stringify(name)}（只允许字母/数字/./_/-）`);
    process.exitCode = 1;
    return true;
  }

  const dir = path.join(H.feedbackDir(), name);
  const ledger = path.join(dir, 'acceptance.md');

  const body = [
    `# ${itemId} 验收清算`,
    '',
    `> 由 \`khy hq accept ${itemId}\` 生成。逐条填 \`结果:\`；`,
    '> `PASS` 必须有 `证据:`，`SKIP` 必须有 `理由:`，有 `FAIL` 则不许翻 done。',
    `> 生成时间：${H.today()}`,
    '',
    ...items.flatMap((it, i) => [
      `## ${i + 1}) ${it.replace(/\n/g, ' ')}`,
      '- 结果: ',
      '- 证据: ',
      '',
    ]),
    '<!-- 结果取值只能是 PASS / FAIL / SKIP 三选一 -->',
    '',
  ].join('\n');

  if (fs.existsSync(ledger)) {
    console.log(c.yellow(`[SKIP] 已存在，未覆盖：.khy/feedback/${name}/acceptance.md`));
    console.log(c.dim('  如需重生成，请先自行备份并删除该文件。'));
    return true;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ledger, body, 'utf8');
  } catch (e) {
    _say(ctx, 'err', `[ERROR] 写入失败：${e.message}`);
    process.exitCode = 1;
    return true;
  }

  console.log(c.green(`[OK] 已生成验收清算模板（${items.length} 条判据）`));
  console.log(`  ${path.relative(H.REPO_ROOT, ledger).split(path.sep).join('/')}`);
  console.log('');
  console.log('  下一步：');
  console.log(`    1. 逐条填 结果/证据`);
  console.log(`    2. khy hq task set ${itemId} review --evidence ${name}   # 记下绑定`);
  console.log(`    3. khy hq task set ${itemId} done                        # 清算通过才放行`);
  return true;
}

// ── scope（边界核对：越界可见，不拦）────────────────────────────

/**
 * `khy hq scope <T-ID>` —— 把工作树改动对照 scope_guard 报出来。
 *
 * 定位：**可见，不拦**（exit 0）。2026-09-23 取证的教训是「没人知道」，
 * 不是「没人管」—— T-020 的目标真源丢了 4 天没人发现，问题从来是可见性。
 *
 * ⚠ 诚实的局限（必须写进输出）：本仓工作树是**共享脏工作树**（并行会话常态
 * 500~10000 条未提交变动，见 [MGMT-PLAN-008] §三），git 无法把改动归属到
 * 某个任务。所以命中「边界之外」只代表**可能**越界，需人工归因 ——
 * 绝不能拿这份报告当门，否则全是噪音。
 */
async function cmdScope(ctx, positional) {
  const c = _chalk();
  const itemId = positional[0];
  if (!itemId) {
    _say(ctx, 'err', '[ERROR] 用法: khy hq scope <T-ID>');
    process.exitCode = 1;
    return true;
  }
  const p = H.paths(null);
  const doc = H.readJsonSafe(p.progress);
  if (!doc.ok) {
    _say(ctx, 'err', `[ERROR] PROGRESS.json 无法读取: ${doc.error}`);
    process.exitCode = 1;
    return true;
  }
  const task = H.findItem(doc.data.tasks, itemId);
  if (!task) {
    _say(ctx, 'err', `[ERROR] 未找到 ${itemId}`);
    process.exitCode = 1;
    return true;
  }
  const sg = Array.isArray(task.scope_guard) ? task.scope_guard.filter((s) => String(s || '').trim()) : [];
  console.log(`  ${itemId} ${task.status} · 边界 ${sg.length} 条`);

  if (!sg.length) {
    console.log(c.yellow('  未声明 scope_guard —— 无法核对边界。'));
    console.log(c.dim(`  补充：khy hq task note ${itemId} --scope "不改 XX"`));
    if (task.status === 'doing') {
      console.log(c.dim('  （该任务在边界锁上线前已开工，属存量豁免，不追溯）'));
    }
    return true;
  }

  const { prefixes, manual } = H.scopeGuardPrefixes(sg);
  if (prefixes.length) {
    console.log(`  机器可核对的路径前缀: ${prefixes.join(', ')}`);
  }
  if (manual.length) {
    console.log(c.dim(`  无法机器核对（需人工）: ${manual.join(' ; ')}`));
  }

  const changes = H.collectWorktreeChanges(H.REPO_ROOT);
  if (changes === null) {
    console.log(c.yellow('  git status 不可用（本仓 git 曾物理损坏）—— 跳过越界核对。'));
    return true;
  }
  if (!prefixes.length) {
    console.log(c.dim(`  工作树改动 ${changes.length} 项（无可核对前缀，不做比对）`));
    return true;
  }
  const { outside } = H.scopeViolations(sg, changes);
  console.log(`  工作树改动共 ${changes.length} 项，其中边界之外 ${outside.length} 项`);
  if (!outside.length) {
    console.log(c.green('  [OK] 未发现越界改动'));
    return true;
  }
  console.log(c.yellow(`  ⚠ 以下 ${Math.min(outside.length, 20)} 项在声明边界之外（可能越界，共享工作树需人工归因）：`));
  for (const f of outside.slice(0, 20)) {
    console.log(`      ${f}`);
  }
  if (outside.length > 20) {
    console.log(c.dim(`      …及另外 ${outside.length - 20} 项`));
  }
  console.log(c.dim('  若确属本任务越界改动：要么收敛改动，要么把边界写进 scope_guard（说清楚为什么）。'));
  return true;
}

// ── release / states / help ──────────────────────────────────────

async function cmdRelease(positional) {
  const c = _chalk();
  const p = H.paths(null);
  const me = H.machineId();
  const target = positional[0] || null;
  const released = [];

  for (const [kind, file, listKey] of [
    ['bug', p.bugs, 'bugs'],
    ['task', p.progress, 'tasks'],
  ]) {
    const doc = H.readJsonSafe(file);
    if (!doc.ok) {
      continue;
    }
    let touched = false;
    for (const item of doc.data[listKey] || []) {
      if (!item || !item.claimed_by) {
        continue;
      }
      if (!H.sameMachine(item.claimed_by, me)) {
        continue;
      }
      if (target && item.id !== target) {
        continue;
      }
      H.clearClaim(item);
      released.push(`${item.id}(${kind})`);
      touched = true;
    }
    if (touched) {
      H.saveJson(file, doc.data);
    }
  }

  if (!released.length) {
    console.log(c.dim(`本机（${me}）当前没有持有任何占用。`));
    return true;
  }
  console.log(c.green(`[OK] 已释放本机占用: ${released.join(', ')}`));
  H.log(`release ${released.join(',')} by ${me}`, p.root);
  return true;
}

function cmdStates() {
  const c = _chalk();
  console.log('');
  console.log(c.bold('  bug 状态机'));
  for (const [s, nxt] of Object.entries(H.BUG_TRANSITIONS)) {
    console.log(`    ${s.padEnd(15)} -> ${nxt.length ? nxt.join(', ') : c.dim('(终态)')}`);
  }
  console.log('');
  console.log(c.bold('  task 状态机'));
  for (const [s, nxt] of Object.entries(H.TASK_TRANSITIONS)) {
    console.log(`    ${s.padEnd(15)} -> ${nxt.length ? nxt.join(', ') : c.dim('(终态)')}`);
  }
  console.log('');
  console.log(c.dim(`  选取优先级：open Bug（${H.SEVERITIES.join('→')}）优先于 todo 任务（${H.SEVERITIES.join('→')}）`));
  console.log(c.dim(`  租约时长：${H.LEASE_MINUTES} 分钟（他机持有存活租约的条目不会被本机领取）`));
  console.log('');
  return true;
}

function _help(c) {
  console.log('');
  console.log(c.bold('  khy hq — 任务/Bug 状态真源（.ai/hq/）'));
  console.log('');
  console.log(c.dim('    khy hq status                     状态总览'));
  console.log(c.dim('    khy hq next                       自动挑最高优先级 → 渲染提示词'));
  console.log(c.dim('    khy hq next --bug BUG-001         指定 Bug 渲染修复提示词'));
  console.log(c.dim('    khy hq next --verify BUG-001      指定 Bug 渲染回归验证提示词'));
  console.log(c.dim('    khy hq next --task T-002          指定任务渲染提示词'));
  console.log(c.dim('    khy hq next --kind distill        手动渲染模板（不绑定条目）'));
  console.log(c.dim('    khy hq verify [BUG-001]           只读体检（数据一致性 + 提示词结构）'));
  console.log(c.dim('    khy hq accept T-002 [--evidence <名称>]  生成验收清算模板（review→done 前置）'));
  console.log(c.dim('    khy hq scope T-002                边界核对（越界可见，不拦）'));
  console.log(c.dim('    khy hq bug new "标题" [--severity P1] [--domain cli]'));
  console.log(c.dim('    khy hq bug set BUG-001 pending_verify [--root-cause "…"] [--fix "…"]'));
  console.log(c.dim('    khy hq bug note BUG-001 [--note "…"] [--root-cause "…"] [--fix "…"]'));
  console.log(c.dim('    khy hq task set T-002 doing                      开工前需已声明 scope_guard'));
  console.log(c.dim('    khy hq task note T-002 --scope "不改 XX"         追加边界（每条一次调用）'));
  console.log(c.dim('    khy hq task set T-002 review [--evidence <名称>] [--note "…"]'));
  console.log(c.dim('    khy hq task set T-002 done [--note "…"]        需验收清算通过才放行'));
  console.log(c.dim('    khy hq task note T-002 [--note "…"]             只补备注，不动状态'));
  console.log(c.dim('    khy hq release [ID]               释放本机占用'));
  console.log(c.dim('    khy hq states                     打印状态机与合法迁移'));
  console.log('');
  console.log(c.dim('    选项: --json 机读输出 · --copy 复制提示词 · --out FILE 写入文件'));
  console.log(c.dim('    真源: .ai/hq/{PROGRESS,BUGS,MODELS}.json + ROADMAP.md + prompts/'));
  console.log('');
  return true;
}

// ── 入口 ─────────────────────────────────────────────────────────

/**
 * `khy hq …` 路由。
 *
 * 返回契约：**恒为 `true`** —— `hq` 是已知命令，即便子操作失败也算「已处理」；
 * 失败通过 `process.exitCode = 1` 让 shell 看到非零状态。返回 `false` 会让
 * 非交互启动器把真实失败误报成 `未知命令: hq`。
 */
async function handleHq(parsed = {}, ctx = {}) {
  const sub = String(parsed.subCommand || (parsed.args && parsed.args[0]) || '').toLowerCase();
  const rawArgs = parsed.args || [];
  // subCommand 已被消费掉时，args 里不再含它；两种解析形态都要能吃到位置参数。
  const rest = sub && rawArgs[0] === sub ? rawArgs.slice(1) : rawArgs;
  const { positional, flags } = parseArgs(rest, parsed.options);

  const c = _chalk();

  switch (sub) {
    case '':
    case 'help':
      return _help(c);
    case 'status':
      return cmdStatus(ctx, flags);
    case 'next':
      return cmdNext(ctx, positional, flags);
    case 'verify':
    case 'check':
      return cmdVerify(ctx, positional, flags);
    case 'accept':
      return cmdAccept(ctx, positional, flags);
    case 'scope':
      return cmdScope(ctx, positional);
    case 'bug': {
      const action = String(positional.shift() || '').toLowerCase();
      if (action === 'new' || action === 'add') {
        return cmdBugNew(ctx, positional, flags);
      }
      if (action === 'set' || action === 'update') {
        return cmdBugSet(ctx, positional, flags);
      }
      if (action === 'note') {
        return cmdNote(ctx, 'bug', positional, flags);
      }
      _help(c);
      return true;
    }
    case 'task': {
      const action = String(positional.shift() || '').toLowerCase();
      if (action === 'set' || action === 'update') {
        return cmdTaskSet(ctx, positional, flags);
      }
      if (action === 'note') {
        return cmdNote(ctx, 'task', positional, flags);
      }
      _help(c);
      return true;
    }
    case 'release':
      return cmdRelease(positional);
    case 'states':
      return cmdStates();
    default:
      // 便捷写法：`khy hq BUG-001` ≡ `khy hq next --bug BUG-001`
      if (/^BUG-\d+$/.test(sub)) {
        return cmdNext(ctx, [sub], flags);
      }
      if (/^T-\d+$/.test(sub)) {
        return cmdNext(ctx, [], Object.assign({}, flags, { task: sub }));
      }
      _help(c);
      return true;
  }
}

module.exports = {
  handleHq,
  parseArgs,
  _nextBugId,
  _syncRoadmap,
  _applyState,
  _applyNote,
  [MANIFEST_EXPORT_KEY]: {
    name: 'hq',
    description: '任务/Bug 状态真源操作面（.ai/hq/）：状态总览、下一步提示词、状态机迁移',
    usage: 'hq [status|next|verify|accept|scope|bug new|bug set|bug note|task set|task note|release|states]',
    subCommands: ['status', 'next', 'verify', 'accept', 'scope', 'bug', 'task', 'release', 'states'],
    category: 'workflow',
    handler: handleHq,
  },
};
