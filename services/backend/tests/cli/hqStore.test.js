'use strict';

/**
 * hqStore.test.js — pure-logic tests for the HQ task/bug state store.
 *
 * Why these tests exist: `hqStore` is the JS successor to the khy-os-hq Python
 * scripts (`hq_common.py` / `next.py` / `update_status.py`). The state machines,
 * the lease semantics and the "no duplicate work across machines" rule are the
 * load-bearing behaviour — if any of them drifts, two machines silently pick the
 * same task, or a legal transition gets rejected. Both failure modes are
 * expensive and quiet, so they get explicit regression locks here.
 *
 * Scope: pure functions only (no disk writes, no temp fixtures). The IO paths
 * are exercised end-to-end via `khy hq verify` against the real `.ai/hq/` data.
 *
 * Reference: docs/03_DESIGN_设计/[DESIGN-ARCH-118] HQ 能力吸收与多机协作规范.md §3.2
 */

const path = require('path');

const H = require('../../src/cli/hqStore');

describe('hqStore', () => {
  describe('状态机 —— Bug', () => {
    test('open 只能去 in_progress / wontfix', () => {
      expect(H.canTransition('bug', 'open', 'in_progress').ok).toBe(true);
      expect(H.canTransition('bug', 'open', 'wontfix').ok).toBe(true);
      expect(H.canTransition('bug', 'open', 'closed').ok).toBe(false);
      expect(H.canTransition('bug', 'open', 'pending_verify').ok).toBe(false);
    });

    test('主链路 open → in_progress → pending_verify → closed 全通', () => {
      expect(H.canTransition('bug', 'open', 'in_progress').ok).toBe(true);
      expect(H.canTransition('bug', 'in_progress', 'pending_verify').ok).toBe(true);
      expect(H.canTransition('bug', 'pending_verify', 'closed').ok).toBe(true);
    });

    test('pending_verify 可被验证打回 in_progress', () => {
      expect(H.canTransition('bug', 'pending_verify', 'in_progress').ok).toBe(true);
    });

    test('closed 是终态，不可再变', () => {
      expect(H.canTransition('bug', 'closed', 'open').ok).toBe(false);
      expect(H.canTransition('bug', 'closed', 'in_progress').ok).toBe(false);
      expect(H.canTransition('bug', 'closed', 'closed').ok).toBe(false);
      expect(H.canTransition('bug', 'closed', 'closed').allowed).toEqual([]);
    });

    test('wontfix 可复活为 open', () => {
      expect(H.canTransition('bug', 'wontfix', 'open').ok).toBe(true);
    });

    test('in_progress 可退回 open', () => {
      expect(H.canTransition('bug', 'in_progress', 'open').ok).toBe(true);
    });

    test('拒绝时给出允许集与可读理由', () => {
      const r = H.canTransition('bug', 'open', 'closed');
      expect(r.ok).toBe(false);
      expect(r.allowed).toEqual(['in_progress', 'wontfix']);
      expect(r.error).toContain('非法状态迁移 open -> closed');
    });

    test('未知起始状态被拒（不是静默通过）', () => {
      const r = H.canTransition('bug', 'bogus', 'open');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('未知当前状态');
    });
  });

  describe('状态机 —— 任务', () => {
    test('todo 只能去 doing（不能跳级到 done）', () => {
      expect(H.canTransition('task', 'todo', 'doing').ok).toBe(true);
      expect(H.canTransition('task', 'todo', 'done').ok).toBe(false);
      expect(H.canTransition('task', 'todo', 'review').ok).toBe(false);
    });

    test('主链路 todo → doing → review → done 全通', () => {
      expect(H.canTransition('task', 'doing', 'review').ok).toBe(true);
      expect(H.canTransition('task', 'review', 'done').ok).toBe(true);
    });

    test('review 可打回 doing；doing 可退回 todo', () => {
      expect(H.canTransition('task', 'review', 'doing').ok).toBe(true);
      expect(H.canTransition('task', 'doing', 'todo').ok).toBe(true);
    });

    test('done 是终态', () => {
      expect(H.canTransition('task', 'done', 'todo').ok).toBe(false);
      expect(H.canTransition('task', 'done', 'doing').ok).toBe(false);
    });

    test('isValidState 只判「串是否合法」，不判「是否可达」', () => {
      expect(H.isValidState('task', 'todo')).toBe(true);
      expect(H.isValidState('task', 'nope')).toBe(false);
      expect(H.isValidState('bug', 'pending_verify')).toBe(true);
      expect(H.isValidState('bug', 'done')).toBe(false); // done 是任务态，不是 Bug 态
    });
  });

  describe('枚举与真源表（与 HQ hq_common.py 对齐）', () => {
    test('三个枚举与 HQ 逐字一致', () => {
      expect(H.DOMAINS).toEqual([
        'cli', 'gateway', 'services', 'kernel',
        'frontend', 'khyquant', 'platform', 'packaging', 'cross',
      ]);
      expect(H.SEVERITIES).toEqual(['P0', 'P1', 'P2', 'P3']);
      expect(H.TASK_TYPES).toEqual(['feature', 'refactor', 'performance', 'quality', 'docs']);
      expect(H.TASK_STATES).toEqual(['todo', 'doing', 'review', 'done']);
    });

    test('BUG_STATES 覆盖两张迁移表的所有键与值', () => {
      const seen = new Set();
      for (const [from, tos] of Object.entries(H.BUG_TRANSITIONS)) {
        seen.add(from);
        tos.forEach((t) => seen.add(t));
      }
      for (const s of seen) {
        expect(H.BUG_STATES).toContain(s);
      }
    });

    test('TASK_STATES 覆盖迁移表的所有键与值', () => {
      const seen = new Set();
      for (const [from, tos] of Object.entries(H.TASK_TRANSITIONS)) {
        seen.add(from);
        tos.forEach((t) => seen.add(t));
      }
      for (const s of seen) {
        expect(H.TASK_STATES).toContain(s);
      }
    });

    test('迁移表里没有「自己到自己」的空转', () => {
      for (const table of [H.BUG_TRANSITIONS, H.TASK_TRANSITIONS]) {
        for (const [from, tos] of Object.entries(table)) {
          expect(tos).not.toContain(from);
        }
      }
    });
  });

  describe('机器身份与租约', () => {
    const now = new Date('2026-09-17T10:00:00');

    test('sameMachine 大小写不敏感（避免本机自锁）', () => {
      // 真机场景：hostname 2541UGH10NVUR7S vs KHY_MACHINE_ID 2541ugh10nvur7s
      expect(H.sameMachine('2541UGH10NVUR7S', '2541ugh10nvur7s')).toBe(true);
      expect(H.sameMachine(' A ', 'a')).toBe(true);
      expect(H.sameMachine('a', 'b')).toBe(false);
      expect(H.sameMachine('', null)).toBe(true);
    });

    test('他机持有存活租约 → heldByOther 为真', () => {
      const item = { claimed_by: 'OTHER', lease_expires: '2026-09-17T12:00:00' };
      expect(H.heldByOther(item, 'ME', now)).toBe(true);
    });

    test('他机租约已过期 → 可被本机领取', () => {
      const item = { claimed_by: 'OTHER', lease_expires: '2026-09-17T09:00:00' };
      expect(H.heldByOther(item, 'ME', now)).toBe(false);
    });

    test('本机自己的租约不算他机占用（大小写不敏感）', () => {
      const item = { claimed_by: 'ME', lease_expires: '2026-09-17T12:00:00' };
      expect(H.heldByOther(item, 'me', now)).toBe(false);
    });

    test('无占用 / 缺租约戳 → 不构成他机占用', () => {
      expect(H.heldByOther({}, 'ME', now)).toBe(false);
      expect(H.heldByOther({ claimed_by: 'OTHER' }, 'ME', now)).toBe(false);
      expect(H.heldByOther(null, 'ME', now)).toBe(false);
    });

    test('stampClaim 是纯函数，写出的租约时长正确', () => {
      const src = { id: 'T-001', status: 'todo' };
      const out = H.stampClaim(src, 'MACHINE-A', 120, now);
      expect(out.claimed_by).toBe('MACHINE-A');
      expect(out.claimed_at).toBe('2026-09-17T10:00:00');
      expect(out.lease_expires).toBe('2026-09-17T12:00:00');
      // 原对象不被原地污染 —— 纯函数契约
      expect(src.claimed_by).toBeUndefined();
      expect(out.id).toBe('T-001');
      expect(out.status).toBe('todo');
    });

    test('clearClaim 清掉三个占用字段', () => {
      const item = {
        id: 'T-001',
        claimed_by: 'X',
        claimed_at: '2026-01-01T00:00:00',
        lease_expires: '2026-01-01T02:00:00',
      };
      H.clearClaim(item);
      expect(item.claimed_by).toBeUndefined();
      expect(item.claimed_at).toBeUndefined();
      expect(item.lease_expires).toBeUndefined();
      expect(item.id).toBe('T-001'); // 其它字段不动
    });

    test('isoLocal 输出 Python isoformat(timespec=seconds) 同形串', () => {
      expect(H.isoLocal(new Date('2026-09-17T05:06:07'))).toBe('2026-09-17T05:06:07');
    });

    test('today 输出 YYYY-MM-DD', () => {
      expect(H.today(new Date('2026-09-17T23:59:59'))).toBe('2026-09-17');
    });

    test('parseIso 对垃圾输入返回 null 而不抛', () => {
      expect(H.parseIso('not-a-date')).toBeNull();
      expect(H.parseIso('')).toBeNull();
      expect(H.parseIso(undefined)).toBeNull();
      expect(H.parseIso('2026-09-17T10:00:00')).toBeInstanceOf(Date);
    });
  });

  describe('severityKey（决定谁先被领取）', () => {
    test('P0 < P1 < P2 < P3', () => {
      expect(H.severityKey('P0')).toBeLessThan(H.severityKey('P1'));
      expect(H.severityKey('P1')).toBeLessThan(H.severityKey('P2'));
      expect(H.severityKey('P2')).toBeLessThan(H.severityKey('P3'));
    });

    test('未知值排在最后（不会挤到高优先级前面）', () => {
      expect(H.severityKey('P9')).toBeGreaterThan(H.severityKey('P3'));
      expect(H.severityKey(undefined)).toBeGreaterThan(H.severityKey('P3'));
    });
  });

  describe('pickNext —— PROCESS-102 五档瀑布（G0→G4）', () => {
    const now = new Date('2026-09-17T10:00:00');
    const bugsDoc = {
      bugs: [
        { id: 'BUG-001', status: 'pending_verify', severity: 'P0' },
        { id: 'BUG-002', status: 'open', severity: 'P2' },
        { id: 'BUG-003', status: 'open', severity: 'P0' },
      ],
    };
    const progDoc = {
      tasks: [
        { id: 'T-001', status: 'todo', priority: 'P1' },
        { id: 'T-002', status: 'doing', priority: 'P0' },
      ],
    };

    // ── G0 健康 · 瓶颈解锁 ──
    test('G0：pending_verify Bug 优先于一切排程（验收债先还）', () => {
      const r = H.pickNext(bugsDoc, progDoc, 'ME', now);
      expect(r.action).toBe('health');
      expect(r.items.map((x) => x.item.id)).toContain('BUG-001');
    });

    test('G0：review 任务进健康档，附验收命令', () => {
      const r = H.pickNext({ bugs: [] }, { tasks: [{ id: 'T-020', status: 'review', priority: 'P2' }] }, 'ME', now);
      expect(r.action).toBe('health');
      expect(r.items[0].howto).toContain('T-020');
    });

    test('G0：doing + 租约过期判滞留；租约存活不算', () => {
      const stale = { tasks: [{ id: 'T-001', status: 'doing', priority: 'P1', claimed_by: 'OTHER', lease_expires: '2026-09-17T09:00:00' }] };
      expect(H.pickNext({ bugs: [] }, stale, 'ME', now).action).toBe('health');
      const alive = { tasks: [{ id: 'T-001', status: 'doing', priority: 'P1', claimed_by: 'OTHER', lease_expires: '2026-09-17T12:00:00' }] };
      expect(H.pickNext({ bugs: [] }, alive, 'ME', now).action).toBe('idle');
    });

    test('skipHealth 显式跳过验收债，进入正常排程', () => {
      const r = H.pickNext(bugsDoc, progDoc, 'ME', now, { skipHealth: true });
      expect(r.action).toBe('pick');
      expect(r.kind).toBe('bug');
      expect(r.item.id).toBe('BUG-003');
      expect(r.stage).toBe('G1');
    });

    // ── G1 救火 ──
    test('G1：open Bug 优先于 todo 任务，按严重度取最高', () => {
      const noHealth = { bugs: bugsDoc.bugs.filter((b) => b.status !== 'pending_verify') };
      const r = H.pickNext(noHealth, progDoc, 'ME', now);
      expect(r.action).toBe('pick');
      expect(r.kind).toBe('bug');
      expect(r.item.id).toBe('BUG-003'); // P0 先于 P2
    });

    test('G1：同严重度并列且无评分字段 → ask，不再按登记顺序任取', () => {
      const tie = { bugs: [
        { id: 'BUG-010', status: 'open', severity: 'P1' },
        { id: 'BUG-011', status: 'open', severity: 'P1' },
      ] };
      const r = H.pickNext(tie, { tasks: [] }, 'ME', now);
      expect(r.action).toBe('ask');
      expect(r.candidates.map((c) => c.item.id).sort()).toEqual(['BUG-010', 'BUG-011']);
    });

    // ── G2/G3 要事与次事 ──
    test('G2：唯一 P1 待办直接选取，返回证据计数', () => {
      const r = H.pickNext({ bugs: [] }, { tasks: [{ id: 'T-001', status: 'todo', priority: 'P1' }, { id: 'T-999', status: 'todo', priority: 'P2' }] }, 'ME', now);
      expect(r.action).toBe('pick');
      expect(r.item.id).toBe('T-001');
      expect(r.stage).toBe('G2');
      expect(r.evidence.todoP01).toBe(1);
    });

    test('G2：同档内按 WSJF（cod×conf÷size）评分决胜', () => {
      const tasks = { tasks: [
        { id: 'T-A', status: 'todo', priority: 'P1', cod: 4, conf: 2, size: 'L' }, // 2.67
        { id: 'T-B', status: 'todo', priority: 'P1', cod: 4, conf: 3, size: 'S' }, // 12
      ] };
      const r = H.pickNext({ bugs: [] }, tasks, 'ME', now);
      expect(r.action).toBe('pick');
      expect(r.item.id).toBe('T-B');
    });

    test('G2：任一候选缺评分字段 → ask（缺字段的不许被顺序顶替）', () => {
      const tasks = { tasks: [
        { id: 'T-A', status: 'todo', priority: 'P1', cod: 5, conf: 3, size: 'S' },
        { id: 'T-B', status: 'todo', priority: 'P1' },
      ] };
      const r = H.pickNext({ bugs: [] }, tasks, 'ME', now);
      expect(r.action).toBe('ask');
      expect(r.candidates.length).toBe(2);
    });

    test('G2：评分并列 → ask', () => {
      const tasks = { tasks: [
        { id: 'T-A', status: 'todo', priority: 'P1', cod: 4, conf: 2, size: 'M' },
        { id: 'T-B', status: 'todo', priority: 'P1', cod: 6, conf: 2, size: 'L' }, // 与 T-A 并列? 4*2/2=4 vs 6*2/3=4 → 并列
      ] };
      const r = H.pickNext({ bugs: [] }, tasks, 'ME', now);
      expect(r.action).toBe('ask');
    });

    test('档位先到先赢：G2 有 P1 时，G3 里高分 P2 不得抢跑', () => {
      const tasks = { tasks: [
        { id: 'T-P1', status: 'todo', priority: 'P1', cod: 1, conf: 1, size: 'L' }, // 0.33
        { id: 'T-P2', status: 'todo', priority: 'P2', cod: 5, conf: 3, size: 'S' }, // 15
      ] };
      const r = H.pickNext({ bugs: [] }, tasks, 'ME', now);
      expect(r.action).toBe('pick');
      expect(r.item.id).toBe('T-P1');
      expect(r.stage).toBe('G2');
    });

    test('G3 档：P2/P3 走同一评分规则', () => {
      const tasks = { tasks: [
        { id: 'T-A', status: 'todo', priority: 'P2', cod: 2, conf: 3, size: 'S' },
        { id: 'T-B', status: 'todo', priority: 'P3' },
      ] };
      // P2 唯一于 G3 头部严重度组 → 直接选
      const r = H.pickNext({ bugs: [] }, tasks, 'ME', now);
      expect(r.item.id).toBe('T-A');
      expect(r.stage).toBe('G3');
    });

    // ── 多机语义（继承自旧 pickAuto） ──
    test('被他机占用且租约存活的条目被跳过；全被占 → idle', () => {
      const held = { bugs: [{ id: 'BUG-002', status: 'open', severity: 'P2', claimed_by: 'OTHER', lease_expires: '2026-09-17T12:00:00' }] };
      expect(H.pickNext(held, { tasks: [] }, 'ME', now).action).toBe('idle');
    });

    test('他机租约过期后该条目重新可领（机器掉线不死锁）', () => {
      const expired = { bugs: [{ id: 'BUG-002', status: 'open', severity: 'P2', claimed_by: 'OTHER', lease_expires: '2026-09-17T09:00:00' }] };
      const r = H.pickNext(expired, { tasks: [] }, 'ME', now);
      expect(r.item.id).toBe('BUG-002');
    });

    test('本机自己的占用不阻止自己继续（大小写不敏感）', () => {
      const mine = { tasks: [{ id: 'T-001', status: 'todo', priority: 'P1', claimed_by: 'me', lease_expires: '2026-09-17T12:00:00' }] };
      const r = H.pickNext({ bugs: [] }, mine, 'ME', now);
      expect(r.item.id).toBe('T-001');
    });

    test('全空 → idle（调用方据此报无待办）', () => {
      expect(H.pickNext({ bugs: [] }, { tasks: [] }, 'ME', now).action).toBe('idle');
      expect(H.pickNext(null, null, 'ME', now).action).toBe('idle');
    });
  });

  describe('validateTask —— WSJF 评分字段（cod/conf/size 可选，出现即校验）', () => {
    const base = { id: 'T-100', domain: 'cli', type: 'feature', priority: 'P2', status: 'todo' };
    test('缺字段合法（存量任务不追溯）', () => {
      expect(H.validateTask({ ...base })).toEqual([]);
    });
    test('合法取值通过', () => {
      expect(H.validateTask({ ...base, cod: 4, conf: 2, size: 'M' })).toEqual([]);
    });
    test('非法取值报错', () => {
      expect(H.validateTask({ ...base, cod: 6 }).length).toBeGreaterThan(0);
      expect(H.validateTask({ ...base, cod: 0 }).length).toBeGreaterThan(0);
      expect(H.validateTask({ ...base, conf: 9 }).length).toBeGreaterThan(0);
      expect(H.validateTask({ ...base, size: 'XL' }).length).toBeGreaterThan(0);
    });
  });

  describe('pickNext 容错', () => {
    test('容忍列表里的 null 条目', () => {
      const now = new Date('2026-09-17T10:00:00');
      const messy = { bugs: [null, { id: 'BUG-002', status: 'open', severity: 'P2' }] };
      const r = H.pickNext(messy, { tasks: [null] }, 'ME', now);
      expect(r.item.id).toBe('BUG-002');
    });
  });

  describe('renderPrompt —— 占位符替换', () => {
    test('替换已知占位符', () => {
      expect(H.renderPrompt('id={{ID}}', { ID: 'BUG-001' })).toBe('id=BUG-001');
    });

    test('空值/缺失/空白统一变 (待填写)，不留空', () => {
      // 留空会让 AI 以为「这一节本来就没内容」；(待填写) 明确标示缺口。
      expect(H.renderPrompt('a={{A}}', {})).toBe('a=(待填写)');
      expect(H.renderPrompt('a={{A}}', { A: '' })).toBe('a=(待填写)');
      expect(H.renderPrompt('a={{A}}', { A: '   ' })).toBe('a=(待填写)');
      expect(H.renderPrompt('a={{A}}', { A: null })).toBe('a=(待填写)');
    });

    test('同一占位符多次出现全部替换', () => {
      expect(H.renderPrompt('{{X}}-{{X}}', { X: 'v' })).toBe('v-v');
    });

    test('不改动非占位符的 {{}} 之外内容', () => {
      expect(H.renderPrompt('no placeholders', {})).toBe('no placeholders');
    });
  });

  describe('extractPromptBody —— 优先取 ```text 围栏', () => {
    test('抽出围栏内正文', () => {
      const md = 'head\n```text\nBODY\n```\ntail';
      expect(H.extractPromptBody(md)).toBe('BODY\n');
    });

    test('无围栏时回退整篇', () => {
      expect(H.extractPromptBody('whole')).toBe('whole\n');
    });
  });

  describe('映射器', () => {
    test('bugMapping 覆盖模板声明的全部占位符', () => {
      const m = H.bugMapping({
        id: 'BUG-001', title: 't', severity: 'P1', domain: 'cli',
        symptom: 's', repro: 'r', suspect_area: 'a',
        root_cause: 'rc', fix_summary: 'f',
      });
      expect(m).toEqual({
        BUG_ID: 'BUG-001', BUG_TITLE: 't', SEVERITY: 'P1', DOMAIN: 'cli',
        SYMPTOM: 's', REPRO: 'r', SUSPECT: 'a', ROOT_CAUSE: 'rc', FIX_SUMMARY: 'f',
      });
    });

    test('taskMapping 覆盖模板声明的全部占位符', () => {
      const m = H.taskMapping({
        id: 'T-001', title: 't', domain: 'cli', acceptance: 'acc', type: 'feature',
      });
      expect(m).toEqual({
        TASK_ID: 'T-001', TASK_TITLE: 't', DOMAIN: 'cli',
        ACCEPTANCE: 'acc', TASK_TYPE: 'feature',
      });
    });

    test('缺字段降级为空串（由 renderPrompt 统一填 (待填写)）', () => {
      expect(H.bugMapping({ id: 'BUG-001' }).SYMPTOM).toBe('');
      expect(H.taskMapping({ id: 'T-001' }).ACCEPTANCE).toBe('');
    });
  });

  describe('记录校验（写入路径上的约束）', () => {
    test('合法 Bug 通过', () => {
      expect(
        H.validateBug({
          id: 'BUG-001', severity: 'P1', domain: 'cli',
          status: 'open', created: '2026-09-17',
        })
      ).toEqual([]);
    });

    test('非法 Bug 逐项报出', () => {
      const errs = H.validateBug({
        id: 'X', severity: 'P9', domain: 'nope',
        status: 'bogus', created: '17/09/2026',
      });
      expect(errs.length).toBe(5);
      expect(errs.join(' ')).toContain('Bug ID 格式非法');
      expect(errs.join(' ')).toContain('严重度非法');
      expect(errs.join(' ')).toContain('域非法');
      expect(errs.join(' ')).toContain('状态非法');
      expect(errs.join(' ')).toContain('created 日期格式');
    });

    test('Task 缺 priority 被报出', () => {
      const errs = H.validateTask({
        id: 'T-001', domain: 'cli', type: 'feature', status: 'todo',
      });
      expect(errs.join(' ')).toContain('优先级非法');
    });

    test('Task 的 type 必须落在 TASK_TYPES 内', () => {
      const errs = H.validateTask({
        id: 'T-001', domain: 'cli', type: 'nope', priority: 'P1', status: 'todo',
      });
      expect(errs.join(' ')).toContain('类型非法');
    });
  });

  describe('modelHint —— 任务类型 → 建议入口', () => {
    const models = {
      models: [
        { id: 'a', display: 'A', strengths: ['refactor'], domains: ['cli'] },
        { id: 'b', display: 'B', strengths: ['feature'] },
      ],
    };

    test('命中 strengths 即返回 display', () => {
      expect(H.modelHint(models, 'feature')[0]).toBe('B');
    });

    test('domains 非空时作为附加过滤', () => {
      expect(H.modelHint(models, 'refactor', 'cli')[0]).toBe('A');
      expect(H.modelHint(models, 'refactor', 'kernel')[0]).toBeNull();
    });

    test('domain 为空则不过滤 domains', () => {
      expect(H.modelHint(models, 'refactor', '')[0]).toBe('A');
    });

    test('无匹配 → [null, null]', () => {
      expect(H.modelHint(models, 'docs')).toEqual([null, null]);
      expect(H.modelHint({}, 'feature')).toEqual([null, null]);
    });
  });

  describe('路径解析', () => {
    test('默认落在仓内 .ai/hq', () => {
      expect(H.paths(null).root).toBe(H.HQ_DIR);
      expect(H.paths(null).bugs).toBe(H.BUGS_JSON);
    });

    test('KHY_HQ_DIR 覆盖真的生效（测试夹具依赖此点）', () => {
      // 回归锁：旧的 `root || HQ_DIR` 实现会静默忽略 env，令「隔离测试」写进真实
      // 数据。这一条断言就是防它复发的那道闸。
      const p = H.paths(null, { KHY_HQ_DIR: 'D:/tmp/hq-fixture' });
      expect(p.root).toBe(path.resolve('D:/tmp/hq-fixture'));
      expect(p.bugs).toContain('hq-fixture');
    });

    test('显式 root 优先于 env', () => {
      const p = H.paths('D:/tmp/explicit', { KHY_HQ_DIR: 'D:/tmp/env' });
      expect(p.root).toBe(path.resolve('D:/tmp/explicit'));
    });

    test('空 env 值不算覆盖', () => {
      expect(H.paths(null, { KHY_HQ_DIR: '   ' }).root).toBe(H.HQ_DIR);
      expect(H.paths(null, {}).root).toBe(H.HQ_DIR);
    });

    test('khyosPathExpr 恒为仓库根，不落 HQ 数据目录', () => {
      // 回归锁：提示词里的【工作目录】必须是仓库根（AI 在这里干活），
      // 不是 `.ai/hq`（那只是数据存放处）。
      expect(H.khyosPathExpr(null)).toBe(H.REPO_ROOT);
      expect(H.khyosPathExpr(null)).not.toBe(H.HQ_DIR);
      expect(H.khyosPathExpr('D:/elsewhere')).toBe(path.resolve('D:/elsewhere'));
    });

    test('全部真源路径与 HQ 落点表一致', () => {
      const p = H.paths(null);
      expect(p.progress.endsWith('PROGRESS.json')).toBe(true);
      expect(p.bugs.endsWith('BUGS.json')).toBe(true);
      expect(p.roadmap.endsWith('ROADMAP.md')).toBe(true);
      expect(p.models.endsWith('MODELS.json')).toBe(true);
      expect(p.context.endsWith('CONTEXT.md')).toBe(true);
      expect(p.prompts.endsWith('prompts')).toBe(true);
    });
  });

  describe('readJsonSafe —— fail-soft', () => {
    test('不存在/畸形 JSON 返回 {ok:false} 而不抛', () => {
      const r = H.readJsonSafe('D:/definitely/not/here.json');
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe('string');
    });
  });

  describe('TYPE_TO_TEMPLATE 注册表', () => {
    test('每个 kind 都映射到一个 .md 相对路径', () => {
      for (const [kind, rel] of Object.entries(H.TYPE_TO_TEMPLATE)) {
        expect(typeof rel).toBe('string');
        expect(rel.endsWith('.md')).toBe(true);
        expect(kind.length).toBeGreaterThan(0);
      }
    });

    test('包含 bug 与 verify 两个核心模板', () => {
      expect(H.TYPE_TO_TEMPLATE.bug).toContain('bugfix');
      expect(H.TYPE_TO_TEMPLATE.verify).toContain('bugfix');
    });
  });

  describe('note-only 是独立于状态机的窄操作（回归锁）', () => {
    // 背景：提示词模板曾指示 AI 用 `bug set BUG-XXX --note "..."` 只补备注。
    // 但 `bug set` 需要目标状态，而状态机拒绝自环（终态更拒绝），该写法必然失败，
    // 会把用户逼去手改 JSON、绕过全部校验。故有了不走状态机的 `note`。
    // 这里锁住「状态机确实拒绝自环」这一前提 —— 只要它成立，`note` 就有存在必要。
    test('同状态自环被状态机拒绝（note 存在的理由）', () => {
      expect(H.canTransition('bug', 'pending_verify', 'pending_verify').ok).toBe(false);
      expect(H.canTransition('bug', 'closed', 'closed').ok).toBe(false);
      expect(H.canTransition('task', 'done', 'done').ok).toBe(false);
      expect(H.canTransition('task', 'todo', 'todo').ok).toBe(false);
    });

    test('反向：合法迁移确实被放行（拒绝不是「一律 false」的假绿）', () => {
      expect(H.canTransition('bug', 'pending_verify', 'closed').ok).toBe(true);
      expect(H.canTransition('task', 'todo', 'doing').ok).toBe(true);
    });
  });
});
