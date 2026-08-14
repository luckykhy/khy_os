'use strict';

/**
 * syscallGateway.scenarios.test.js — 系统调用审批网关三场景 + 防呆离线回归。
 *
 * 全程零外部依赖、零网络、零真实文件系统：意图由内存对象规约，交互器全为同步桩。
 * 覆盖：
 *   场景A 尝试删除文件        → L2 红灯，回车/小写一律拒，仅严格键入 YES 放行
 *   场景B 尝试全局安装包      → L2 红灯，强制挂起
 *   场景C 正常写入项目内文件  → L1 黄灯，问一次，可会话免审
 * 防呆：
 *   ① force:true / --yes 旁路注入 → 熔断 + 拒绝（即便本是 L1）
 *   ② L1 会话免审绝不跨会话（resetSession 后归零）
 *   ③ L2 必须差异化键入（"yes"/""/回车 不通过，"YES" 通过）
 *   ④ 非交互（无 prompter）下 L1/L2 一律 fail-closed
 *   ⑤ 反复硬闯 L2 达阈值 → 熔断并清场登记子进程
 *   ⑥ 预审批清单拒收 L2；L1 命中清单自动放行
 */

const path = require('path');
const gateway = require('../../src/services/syscallGateway');
const { classify, LEVELS, isExemptible } = require('../../src/services/syscallGateway/resourceClassifier');
const { buildIntent, detectBypassMarkers, ACTIONS, SCOPES } = require('../../src/services/syscallGateway/intentSchema');
const { route, DECISIONS } = require('../../src/services/syscallGateway/approvalRouter');
const { PermissionCache } = require('../../src/services/syscallGateway/permissionCache');
const { BreachBreaker } = require('../../src/services/syscallGateway/breachBreaker');

const CWD = path.sep === '\\' ? 'C:\\proj' : '/proj';
const HOME = path.sep === '\\' ? 'C:\\Users\\u' : '/home/u';

// 各场景用独立 sessionId，避免会话状态串扰。
let _seq = 0;
const sid = () => `t_${++_seq}`;

afterEach(() => {
  // 清理本测试创建的所有会话（最小权限：会话级、可整体重置）。
  for (let i = 0; i <= _seq; i++) gateway.resetSession(`t_${i}`);
});

describe('分级矩阵 classify（单一真源）', () => {
  test('删除文件 → L2', () => {
    const it = buildIntent({ tool: 'shell_command', params: { command: 'rm -rf build' }, cwd: CWD, home: HOME });
    expect(classify(it).level).toBe(LEVELS.L2);
  });
  test('全局安装 → L2', () => {
    const it = buildIntent({ tool: 'shell_command', params: { command: 'npm install -g typescript' }, cwd: CWD, home: HOME });
    expect(classify(it).level).toBe(LEVELS.L2);
  });
  test('写入项目内文件 → L1', () => {
    const it = buildIntent({ tool: 'write_file', params: { path: path.join(CWD, 'src', 'a.txt') }, cwd: CWD, home: HOME });
    expect(classify(it).level).toBe(LEVELS.L1);
  });
  test('写入系统级路径 → L2', () => {
    const sys = path.sep === '\\' ? 'C:\\Windows\\x.dll' : '/etc/passwd';
    const it = buildIntent({ tool: 'write_file', params: { path: sys }, cwd: CWD, home: HOME });
    expect(classify(it).level).toBe(LEVELS.L2);
  });
  test('项目内只读 → L0', () => {
    const it = buildIntent({ tool: 'read_file', params: { path: path.join(CWD, 'a.txt') }, isReadOnly: true, cwd: CWD, home: HOME });
    expect(classify(it).level).toBe(LEVELS.L0);
  });
  test('只读 shell 命令(dir/ls)即便工具静态 risk:critical 也不判 L2', () => {
    // 回归：shell_command 工具静态标 risk:'critical'（按最坏情况），但 dir/ls 这类
    // 命令工具动态自报 isReadOnly:true。只读不改状态，绝不该强制键入 YES(L2)。
    // 动态只读真相必须优先于静态 critical 标签。
    const it = buildIntent({
      tool: 'shell_command',
      params: { command: 'dir C:\\Windows\\Temp' },
      isReadOnly: true,
      risk: 'critical',
      cwd: CWD,
      home: HOME,
    });
    expect(classify(it).level).not.toBe(LEVELS.L2);
  });
  test('破坏性 shell 命令仍判 L2（critical 红线对写/删零弱化）', () => {
    // 反向守卫：只读提前判定绝不放过真正改状态的危险命令。删除恒 isReadOnly:false。
    const it = buildIntent({
      tool: 'shell_command',
      params: { command: 'rm -rf /important' },
      isReadOnly: false,
      isDestructive: true,
      risk: 'critical',
      cwd: CWD,
      home: HOME,
    });
    expect(classify(it).level).toBe(LEVELS.L2);
  });
  test('未知动作保守落 L2', () => {
    const it = buildIntent({ tool: 'totally_unknown_xyz', params: {}, cwd: CWD, home: HOME });
    expect(classify(it).level).toBe(LEVELS.L2);
  });
});

describe('场景A — 尝试删除文件（L2 红灯）', () => {
  const call = { sessionId: null, tool: 'shell_command', params: { command: 'rm important.txt' }, isDestructive: true, risk: 'high' };

  test('严格键入 YES 才放行', async () => {
    const s = sid();
    const prompter = { confirmL2: async () => 'YES' };
    const v = await gateway.evaluate({ ...call, sessionId: s }, { prompter });
    expect(v.level).toBe(LEVELS.L2);
    expect(v.allow).toBe(true);
    expect(v.decision).toBe(DECISIONS.USER_ALLOW);
  });

  test('防呆③：回车/空串不通过', async () => {
    const s = sid();
    const v = await gateway.evaluate({ ...call, sessionId: s }, { prompter: { confirmL2: async () => '' } });
    expect(v.allow).toBe(false);
  });

  test('防呆③：小写 "yes" 不通过', async () => {
    const s = sid();
    const v = await gateway.evaluate({ ...call, sessionId: s }, { prompter: { confirmL2: async () => 'yes' } });
    expect(v.allow).toBe(false);
  });

  test('防呆④：无交互器（非交互环境）一律拒绝', async () => {
    const s = sid();
    const v = await gateway.evaluate({ ...call, sessionId: s }, {});
    expect(v.allow).toBe(false);
  });
});

describe('场景B — 尝试全局安装包（L2 红灯）', () => {
  test('强制挂起；交互器抛错 → fail-closed 拒绝', async () => {
    const s = sid();
    const call = { sessionId: s, tool: 'shell_command', params: { command: 'npm i -g http-server' }, risk: 'high' };
    const boom = { confirmL2: async () => { throw new Error('user aborted'); } };
    const v = await gateway.evaluate(call, { prompter: boom });
    expect(v.level).toBe(LEVELS.L2);
    expect(v.allow).toBe(false);
  });
});

describe('场景C — 正常写入项目内文件（L1 黄灯）', () => {
  const mk = (s) => ({ sessionId: s, tool: 'write_file', params: { path: path.join(CWD, 'src', 'note.txt') }, cwd: CWD, home: HOME, risk: 'medium' });

  test('问一次：用户允许本次 → 放行', async () => {
    const s = sid();
    const v = await gateway.evaluate(mk(s), { prompter: { askL1: async () => 'once' } });
    expect(v.level).toBe(LEVELS.L1);
    expect(v.allow).toBe(true);
  });

  test('用户拒绝 → 拦截', async () => {
    const s = sid();
    const v = await gateway.evaluate(mk(s), { prompter: { askL1: async () => 'deny' } });
    expect(v.allow).toBe(false);
  });

  test('会话免审：第二次同类不再询问', async () => {
    const s = sid();
    let asked = 0;
    const prompter = { askL1: async () => { asked++; return 'session'; } };
    const v1 = await gateway.evaluate(mk(s), { prompter });
    const v2 = await gateway.evaluate(mk(s), { prompter });
    expect(v1.allow).toBe(true);
    expect(v2.allow).toBe(true);
    expect(asked).toBe(1); // 只问了一次
  });

  test('防呆②：会话免审绝不跨会话', async () => {
    const s = sid();
    const prompter = { askL1: async () => 'session' };
    await gateway.evaluate(mk(s), { prompter });
    gateway.resetSession(s); // 模拟会话结束/重启
    let asked = 0;
    const prompter2 = { askL1: async () => { asked++; return 'deny'; } };
    const v = await gateway.evaluate(mk(s), { prompter: prompter2 });
    expect(asked).toBe(1);   // 必须重新询问
    expect(v.allow).toBe(false);
  });
});

describe('防呆① — 旁路注入零容忍', () => {
  test('detectBypassMarkers 命中 force/--yes', () => {
    expect(detectBypassMarkers({ force: true }).length).toBeGreaterThan(0);
    expect(detectBypassMarkers({ command: 'rm x --force' }).length).toBeGreaterThan(0);
    expect(detectBypassMarkers({ force: false }).length).toBe(0); // false 不算
  });

  test('参数夹带 force:true → 熔断 + 拒绝（即便本是 L1 写入）', async () => {
    const s = sid();
    const call = { sessionId: s, tool: 'write_file', params: { path: path.join(CWD, 'a.txt'), force: true }, cwd: CWD, home: HOME };
    const v = await gateway.evaluate(call, { prompter: { askL1: async () => 'once' } });
    expect(v.allow).toBe(false);
    expect(v.tripped).toBe(true);
    // 熔断后即使是 L0 只读也被拒
    const v2 = await gateway.evaluate({ sessionId: s, tool: 'read_file', params: { path: path.join(CWD, 'b.txt') }, isReadOnly: true, cwd: CWD, home: HOME }, { prompter: { askL1: async () => 'once' } });
    expect(v2.allow).toBe(false);
  });
});

describe('防呆⑤ — 反复硬闯 L2 熔断并清场子进程', () => {
  test('被拒 L2 达阈值 → 跳闸 + 终止登记子进程', () => {
    const killed = [];
    const breaker = new BreachBreaker({ l2RetryThreshold: 3, killer: (pid) => killed.push(pid) });
    breaker.registerChild(4242);
    expect(breaker.reportDeniedL2()).toBe(false);
    expect(breaker.reportDeniedL2()).toBe(false);
    expect(breaker.reportDeniedL2()).toBe(true); // 第三次跳闸
    expect(breaker.tripped).toBe(true);
    expect(killed).toContain(4242);
    expect(breaker.shouldBlock()).toBe(true);
  });

  test('killer 抛错不反噬熔断', () => {
    const breaker = new BreachBreaker({ l2RetryThreshold: 1, killer: () => { throw new Error('no perm'); } });
    breaker.registerChild(99);
    expect(() => breaker.reportDeniedL2()).not.toThrow();
    expect(breaker.tripped).toBe(true);
  });
});

describe('防呆⑥ — 预审批清单', () => {
  test('清单拒收 L2 条目，接纳 L1', () => {
    const cache = new PermissionCache();
    const n = cache.submitManifest(
      [
        { action: 'write', scope: 'project' },     // L1 接纳
        { action: 'delete', scope: 'project' },     // L2 拒收
        { action: 'read', scope: 'project', isReadOnly: true }, // L0 接纳
      ],
      (probe) => classify(probe),
    );
    expect(n).toBe(2);
  });

  test('L1 命中清单 → 自动放行，不再询问', async () => {
    const s = sid();
    gateway.submitManifest(s, [{ action: 'write', scope: 'project' }]);
    let asked = 0;
    const v = await gateway.evaluate(
      { sessionId: s, tool: 'write_file', params: { path: path.join(CWD, 'x.txt') }, cwd: CWD, home: HOME },
      { prompter: { askL1: async () => { asked++; return 'deny'; } } },
    );
    expect(v.allow).toBe(true);
    expect(v.decision).toBe(DECISIONS.AUTO_ALLOW);
    expect(asked).toBe(0); // 清单命中，不打断
  });

  test('L2 永不可被清单命中（即便伪造 level）', () => {
    const cache = new PermissionCache();
    cache.submitManifest([{ action: 'delete', scope: 'project', level: 'L0' }], (probe) => classify(probe));
    const it = buildIntent({ tool: 'shell_command', params: { command: 'rm x' }, cwd: CWD, home: HOME });
    expect(cache.inManifest(it, LEVELS.L2)).toBe(false);
  });
});

describe('approvalRouter 纯决策契约', () => {
  test('L0 自动放行，无需交互器', async () => {
    const it = buildIntent({ tool: 'read_file', params: { path: path.join(CWD, 'a') }, isReadOnly: true, cwd: CWD, home: HOME });
    const r = await route({ intent: it, level: LEVELS.L0, cache: new PermissionCache() });
    expect(r.decision).toBe(DECISIONS.AUTO_ALLOW);
  });

  test('自定义 L2 确认串', async () => {
    const it = buildIntent({ tool: 'shell_command', params: { command: 'rm x' }, cwd: CWD, home: HOME });
    const r = await route({
      intent: it, level: LEVELS.L2, cache: new PermissionCache(),
      prompter: { confirmL2: async () => 'CONFIRM-DELETE' }, l2ConfirmWord: 'CONFIRM-DELETE',
    });
    expect(r.decision).toBe(DECISIONS.USER_ALLOW);
  });

  test('DENY 附结构化 cause：无交互器 → no-interactive-channel', async () => {
    const it = buildIntent({ tool: 'shell_command', params: { command: 'rm x' }, cwd: CWD, home: HOME });
    const r = await route({ intent: it, level: LEVELS.L2, cache: new PermissionCache() }); // 无 prompter
    expect(r.decision).toBe(DECISIONS.DENY);
    expect(r.cause).toBe('no-interactive-channel');
  });

  test('DENY 附结构化 cause：确认串不匹配 → confirm-mismatch', async () => {
    const it = buildIntent({ tool: 'shell_command', params: { command: 'rm x' }, cwd: CWD, home: HOME });
    const r = await route({
      intent: it, level: LEVELS.L2, cache: new PermissionCache(),
      prompter: { confirmL2: async () => 'nope' },
    });
    expect(r.decision).toBe(DECISIONS.DENY);
    expect(r.cause).toBe('confirm-mismatch');
  });

  test('DENY 附结构化 cause：L1 用户拒 → user-declined', async () => {
    const it = buildIntent({ tool: 'write_file', params: { path: path.join(CWD, 'a.txt') }, cwd: CWD, home: HOME });
    const r = await route({
      intent: it, level: LEVELS.L1, cache: new PermissionCache(),
      prompter: { askL1: async () => 'deny' },
    });
    expect(r.decision).toBe(DECISIONS.DENY);
    expect(r.cause).toBe('user-declined');
  });

  test('放行不带 cause（AUTO_ALLOW / USER_ALLOW）', async () => {
    const it = buildIntent({ tool: 'read_file', params: { path: path.join(CWD, 'a') }, isReadOnly: true, cwd: CWD, home: HOME });
    const r = await route({ intent: it, level: LEVELS.L0, cache: new PermissionCache() });
    expect(r.decision).toBe(DECISIONS.AUTO_ALLOW);
    expect(r.cause).toBeUndefined();
  });
});

describe('熔断只计真·硬闯，环境性拒绝(无交互通道)不锁死会话', () => {
  // 用户痛点根因回归：headless/自主/管道/后台环境下每个高危(L2)都因「无交互通道」被拒，
  // 旧行为把每次都计入熔断 → 三个互不相关的合法高危操作各撞一次就跳闸 → 连只读也全拒、
  // 会话被砖。修法：cause==='no-interactive-channel' 的拒绝不喂熔断（门控 KHY_GATEWAY_BREAKER_SMART）。
  const L2CALL = (s) => ({ sessionId: s, tool: 'shell_command', params: { command: 'rm important.txt' }, isDestructive: true, risk: 'high' });
  const L0READ = (s) => ({ sessionId: s, tool: 'read_file', params: { path: path.join(CWD, 'a.txt') }, isReadOnly: true, cwd: CWD, home: HOME });

  test('无交互通道下连拒 5 次 L2 → 不跳闸，随后 L0 只读仍放行', async () => {
    const s = sid();
    for (let i = 0; i < 5; i++) {
      const v = await gateway.evaluate(L2CALL(s), {}); // 无 prompter → no-interactive-channel
      expect(v.allow).toBe(false);
      expect(v.level).toBe(LEVELS.L2);
      expect(v.tripped).toBe(false); // 关键：环境性拒绝绝不跳闸
    }
    // 会话未被砖：只读 L0 仍自动放行。
    const ro = await gateway.evaluate(L0READ(s), {});
    expect(ro.allow).toBe(true);
    expect(ro.level).toBe(LEVELS.L0);
  });

  test('拒绝理由含可执行指引（为何被拒 + 合规放行途径）', async () => {
    const s = sid();
    const v = await gateway.evaluate(L2CALL(s), {});
    const joined = v.reasons.join(' ');
    expect(joined).toContain('非交互环境');
    expect(joined).toContain('permissions.json'); // 指引点名合规配置途径
  });

  test('真·硬闯仍跳闸：确认串反复不匹配达阈值 → 熔断', async () => {
    const s = sid();
    // confirmL2 恒返回错串 → cause=confirm-mismatch（真·硬闯，照常计数）。
    const wrong = { confirmL2: async () => 'nope' };
    let last;
    for (let i = 0; i < 3; i++) last = await gateway.evaluate(L2CALL(s), { prompter: wrong });
    expect(last.tripped).toBe(true); // 第三次跳闸，红线不弱化
  });

  test('旁路注入零容忍红线不变：force:true 一次即熔断', async () => {
    const s = sid();
    const v = await gateway.evaluate({ ...L2CALL(s), params: { command: 'rm x', force: true } }, {});
    expect(v.allow).toBe(false);
    expect(v.tripped).toBe(true); // 一次即跳闸
  });

  test('字节回退：KHY_GATEWAY_BREAKER_SMART=off → 无交互拒绝仍计数并跳闸（今日行为）', async () => {
    const prev = process.env.KHY_GATEWAY_BREAKER_SMART;
    process.env.KHY_GATEWAY_BREAKER_SMART = 'off';
    try {
      const s = sid();
      let last;
      for (let i = 0; i < 3; i++) last = await gateway.evaluate(L2CALL(s), {});
      expect(last.tripped).toBe(true); // 门控关：回退「所有 L2 被拒都计数」
    } finally {
      if (prev === undefined) delete process.env.KHY_GATEWAY_BREAKER_SMART;
      else process.env.KHY_GATEWAY_BREAKER_SMART = prev;
    }
  });
});

describe('makeControlPrompter 适配宿主通道', () => {
  test('allow-always → session；allow → once；deny → deny', async () => {
    const responses = [{ behavior: 'allow-always' }, { behavior: 'allow' }, { behavior: 'deny' }];
    let i = 0;
    const onCtrl = async () => responses[i++];
    const p = gateway.makeControlPrompter(onCtrl);
    expect(await p.askL1({ tool: 't', action: 'write', scope: 'project' })).toBe('session');
    expect(await p.askL1({ tool: 't', action: 'write', scope: 'project' })).toBe('once');
    expect(await p.askL1({ tool: 't', action: 'write', scope: 'project' })).toBe('deny');
  });

  test('L2 在仅 allow/deny 的宿主下取不到键入串 → fail-closed', async () => {
    const onCtrl = async () => ({ behavior: 'allow' }); // 不携带 typed
    const p = gateway.makeControlPrompter(onCtrl);
    // 新契约：confirmL2 返回 { typed, session }；无 typed → typed='' → 路由层 fail-closed。
    const res = await p.confirmL2({ tool: 't', action: 'delete', scope: 'project' });
    expect(res.typed).toBe('');
    expect(res.session).toBe(false);
  });

  test('宿主回传 typed 串 → 透传', async () => {
    const onCtrl = async () => ({ response: { typed: 'YES' } });
    const p = gateway.makeControlPrompter(onCtrl);
    const res = await p.confirmL2({ tool: 't', action: 'delete', scope: 'project' });
    expect(res.typed).toBe('YES');
    expect(res.session).toBe(false); // 未选「本会话总是允许」→ 非会话免审
  });

  test('宿主回传 allow-always/scope=session → session:true(本会话总是允许)', async () => {
    const viaBehavior = gateway.makeControlPrompter(async () => ({ response: { behavior: 'allow-always', typed: 'YES' } }));
    const r1 = await viaBehavior.confirmL2({ tool: 't', action: 'delete', scope: 'project' });
    expect(r1).toEqual({ typed: 'YES', session: true });
    const viaScope = gateway.makeControlPrompter(async () => ({ response: { typed: 'YES', scope: 'session' } }));
    const r2 = await viaScope.confirmL2({ tool: 't', action: 'delete', scope: 'project' });
    expect(r2).toEqual({ typed: 'YES', session: true });
  });

  test('容忍 Ink 原语响应：true→once / "always"→session / false→deny', async () => {
    const seq = [true, 'always', false];
    let i = 0;
    const p = gateway.makeControlPrompter(async () => seq[i++]);
    expect(await p.askL1({ tool: 't', action: 'write', scope: 'project' })).toBe('once');
    expect(await p.askL1({ tool: 't', action: 'write', scope: 'project' })).toBe('session');
    expect(await p.askL1({ tool: 't', action: 'write', scope: 'project' })).toBe('deny');
  });

  test('L2 箭头键确认：{behavior:allow, typed:YES} → 放行', async () => {
    // 模拟新的箭头键 PermissionsPrompt 在 L2「确认执行」行的解析载荷。
    const p = gateway.makeControlPrompter(async () => ({ behavior: 'allow', typed: 'YES' }));
    const s = sid();
    const v = await gateway.evaluate(
      { sessionId: s, tool: 'shell_command', params: { command: 'rm x.txt' }, isDestructive: true, risk: 'high' },
      { prompter: p },
    );
    expect(v.level).toBe(LEVELS.L2);
    expect(v.allow).toBe(true);
  });

  test('L2 箭头键拒绝：false → 拦截', async () => {
    const p = gateway.makeControlPrompter(async () => false);
    const s = sid();
    const v = await gateway.evaluate(
      { sessionId: s, tool: 'shell_command', params: { command: 'rm x.txt' }, risk: 'high' },
      { prompter: p },
    );
    expect(v.allow).toBe(false);
  });
});

describe('SANDBOX_ESCAPE — 跳出沙箱执行须键入 YES（L2、不可旁路、fail-closed）', () => {
  test('buildIntent 置位 sandboxEscape → 动作 SANDBOX_ESCAPE、作用域 SYSTEM', () => {
    // 即便底层是一条平平无奇的只读命令，逃逸声明也覆盖派生动作为最高危。
    const it = buildIntent({
      tool: 'shell_command', params: { command: 'ls' }, isReadOnly: true,
      sandboxEscape: true, cwd: CWD, home: HOME,
    });
    expect(it.action).toBe(ACTIONS.SANDBOX_ESCAPE);
    expect(it.scope).toBe(SCOPES.SYSTEM);
    expect(it.sandboxEscape).toBe(true);
  });

  test('classify SANDBOX_ESCAPE → L2，且 L2 不可豁免', () => {
    const it = buildIntent({ tool: 'x', params: {}, sandboxEscape: true, cwd: CWD, home: HOME });
    expect(classify(it).level).toBe(LEVELS.L2);
    expect(isExemptible(LEVELS.L2)).toBe(false);
  });

  test('evaluate：严格键入 YES 才放行', async () => {
    const s = sid();
    const v = await gateway.evaluate(
      { sessionId: s, tool: 'shell_command', params: { command: 'ls' }, isReadOnly: true, sandboxEscape: true, cwd: CWD, home: HOME },
      { prompter: { confirmL2: async () => 'YES' } },
    );
    expect(v.level).toBe(LEVELS.L2);
    expect(v.allow).toBe(true);
    expect(v.decision).toBe(DECISIONS.USER_ALLOW);
  });

  test('fail-closed：无交互器 → 拒绝', async () => {
    const s = sid();
    const v = await gateway.evaluate(
      { sessionId: s, tool: 'shell_command', params: { command: 'ls' }, sandboxEscape: true, cwd: CWD, home: HOME },
      {},
    );
    expect(v.level).toBe(LEVELS.L2);
    expect(v.allow).toBe(false);
  });

  test('不可旁路：autoApproveL1 对逃逸无效（仍须键入 YES）', async () => {
    const s = sid();
    const v = await gateway.evaluate(
      { sessionId: s, tool: 'shell_command', params: { command: 'ls' }, sandboxEscape: true, cwd: CWD, home: HOME },
      { autoApproveL1: true, prompter: { askL1: async () => 'session', confirmL2: async () => '' } },
    );
    expect(v.allow).toBe(false);
  });

  test('旁路注入零容忍：逃逸 + 参数夹带 force:true → 熔断 + 拒绝', async () => {
    const s = sid();
    const v = await gateway.evaluate(
      { sessionId: s, tool: 'shell_command', params: { command: 'ls', force: true }, sandboxEscape: true, cwd: CWD, home: HOME },
      { prompter: { confirmL2: async () => 'YES' } },
    );
    expect(v.allow).toBe(false);
    expect(v.tripped).toBe(true);
  });
});
