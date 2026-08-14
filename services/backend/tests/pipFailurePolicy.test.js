'use strict';

const test = require('node:test');
const assert = require('node:assert');

const pol = require('../src/services/pipFailurePolicy');

// 用户真实贴的 Windows 报错(代理已关、端口拒连)。用模板字面量避免内嵌引号转义问题。
const REAL_PROXY_ERR = [
  'WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by',
  `'ProxyError('Cannot connect to proxy.', NewConnectionError(`,
  `'<urllib3.connection.HTTPSConnection object at 0x000001>: Failed to establish a new connection:`,
  `[WinError 10061] 由于目标计算机积极拒绝,无法连接。'))': /simple/khy-os/`,
  'Requirement already satisfied: khy-os in c:\\python\\lib\\site-packages',
].join('\n');

test('isEnabled: 默认开,仅 0/false/off/no 关', () => {
  assert.strictEqual(pol.isEnabled({}), true);
  assert.strictEqual(pol.isEnabled({ KHY_PIP_FAILURE_POLICY: 'true' }), true);
  assert.strictEqual(pol.isEnabled({ KHY_PIP_FAILURE_POLICY: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(pol.isEnabled({ KHY_PIP_FAILURE_POLICY: off }), false, `应关:${off}`);
  }
});

test('classifyPipFailure: 真实代理报错归类为 proxy 且建议直连重试', () => {
  const c = pol.classifyPipFailure(REAL_PROXY_ERR);
  assert.strictEqual(c.kind, 'proxy');
  assert.strictEqual(c.retryWithoutProxy, true);
  assert.strictEqual(c.transient, true);
  assert.strictEqual(pol.isProxyFailure(REAL_PROXY_ERR), true);
});

test('classifyPipFailure: 各代理同义文本', () => {
  for (const t of [
    "ProxyError('Cannot connect to proxy.')",
    'Cannot connect to proxy.',
    'Tunnel connection failed: 407 Proxy Authentication Required',
    'unable to connect to proxy: Connection refused',
  ]) {
    assert.strictEqual(pol.classifyPipFailure(t).kind, 'proxy', t);
  }
});

test('classifyPipFailure: 纯网络(非代理)归 network 且建议直连重试', () => {
  for (const t of [
    'Failed to establish a new connection: [Errno 111] Connection refused',
    'Max retries exceeded with url: /simple/khy-os/',
    'Temporary failure in name resolution',
    'Read timed out.',
  ]) {
    const c = pol.classifyPipFailure(t);
    assert.strictEqual(c.kind, 'network', t);
    assert.strictEqual(c.retryWithoutProxy, true, t);
  }
});

test('classifyPipFailure: not-found 优先于 network,且不建议直连重试', () => {
  const t = 'ERROR: Could not find a version that satisfies the requirement khy-os\nNo matching distribution found for khy-os';
  const c = pol.classifyPipFailure(t);
  assert.strictEqual(c.kind, 'not-found');
  assert.strictEqual(c.retryWithoutProxy, false);
});

test('classifyPipFailure: permission', () => {
  const c = pol.classifyPipFailure('ERROR: Could not install packages due to an OSError: [Errno 13] Permission denied');
  assert.strictEqual(c.kind, 'permission');
  assert.strictEqual(c.retryWithoutProxy, false);
});

test('classifyPipFailure: 空/垃圾输入 fail-soft 归 other', () => {
  for (const t of ['', null, undefined, '   ', 42, {}]) {
    const c = pol.classifyPipFailure(t);
    assert.strictEqual(c.kind, 'other');
    assert.strictEqual(c.retryWithoutProxy, false);
  }
});

test('stripProxyEnv: 剥掉全部代理键并设 NO_PROXY=*,不改入参', () => {
  const src = Object.freeze({
    PATH: '/usr/bin',
    HTTP_PROXY: 'http://127.0.0.1:7890',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    http_proxy: 'http://127.0.0.1:7890',
    https_proxy: 'http://127.0.0.1:7890',
    ALL_PROXY: 'socks5://127.0.0.1:7891',
    KHY_HOME: '/home/x',
  });
  const out = pol.stripProxyEnv(src);
  // 入参未被修改(Object.freeze 也证明纯函数不写入参)。
  assert.strictEqual(src.HTTP_PROXY, 'http://127.0.0.1:7890');
  // 代理键全没了。
  for (const k of pol.PROXY_ENV_KEYS) assert.strictEqual(out[k], undefined, k);
  // 非代理键保留。
  assert.strictEqual(out.PATH, '/usr/bin');
  assert.strictEqual(out.KHY_HOME, '/home/x');
  // NO_PROXY 双保险。
  assert.strictEqual(out.NO_PROXY, '*');
  assert.strictEqual(out.no_proxy, '*');
});

test('stripProxyEnv: 坏入参 fail-soft 不抛', () => {
  assert.doesNotThrow(() => pol.stripProxyEnv(null));
  assert.doesNotThrow(() => pol.stripProxyEnv(undefined));
  const out = pol.stripProxyEnv(123);
  assert.strictEqual(typeof out, 'object');
});

test('buildPipFailureDiagnosis: proxy 文案含直连命令、镜像、包名;autoRetried 影响首句', () => {
  const d = pol.buildPipFailureDiagnosis({ kind: 'proxy', pkg: 'khy-os', autoRetried: true });
  assert.match(d, /已自动尝试/);
  assert.match(d, /--proxy ""/);
  assert.match(d, /pypi\.tuna\.tsinghua\.edu\.cn/);
  assert.match(d, /khy-os/);
  const d2 = pol.buildPipFailureDiagnosis({ kind: 'proxy', pkg: 'khy-os', autoRetried: false });
  assert.doesNotMatch(d2, /已自动尝试/);
});

test('buildPipFailureDiagnosis: 各 kind 给出可操作命令', () => {
  assert.match(pol.buildPipFailureDiagnosis({ kind: 'network' }), /镜像/);
  assert.match(pol.buildPipFailureDiagnosis({ kind: 'not-found' }), /force-reinstall|镜像/);
  assert.match(pol.buildPipFailureDiagnosis({ kind: 'permission' }), /--user/);
  assert.match(pol.buildPipFailureDiagnosis({ kind: 'other' }), /pip install --upgrade/);
});

test('buildPipFailureDiagnosis: 坏入参 fail-soft 返回安全文案', () => {
  assert.doesNotThrow(() => pol.buildPipFailureDiagnosis());
  assert.doesNotThrow(() => pol.buildPipFailureDiagnosis(null));
  assert.match(pol.buildPipFailureDiagnosis(null), /pip install --upgrade khy-os/);
});

test('诊断是确定性模板,不内插用户环境里的代理地址(无回显面)', () => {
  // buildPipFailureDiagnosis 不接收任何代理地址参数,故无法回显用户的代理。
  // 文案里出现的 7890 只是 netstat 示例端口(Clash 默认),非用户输入回显。
  const d = pol.buildPipFailureDiagnosis({ kind: 'proxy', pkg: 'khy-os' });
  assert.doesNotMatch(d, /127\.0\.0\.1/); // 不出现任何具体代理 IP
  assert.match(d, /netstat -ano \| findstr 7890/); // 仅作为通用示例端口提示存在
});

test('classifyPipFailure: 真实 WinError 32 文件锁归 file-locked,不误判 permission', () => {
  const realWin32 = [
    'ERROR: Could not install packages due to an OSError: [WinError 32]',
    '另一个程序正在使用此文件,进程无法访问。',
  ].join('\n');
  const c = pol.classifyPipFailure(realWin32);
  assert.strictEqual(c.kind, 'file-locked');
  assert.strictEqual(c.retryWithoutProxy, false); // 不触发代理重试
  assert.strictEqual(c.transient, true);
});

test('classifyPipFailure: file-locked 优先于 permission(WinError 32 含「拒绝访问」但根因不同)', () => {
  const mixed = 'OSError: [WinError 32] 另一个程序正在使用此文件 拒绝访问';
  assert.strictEqual(pol.classifyPipFailure(mixed).kind, 'file-locked');
});

test('classifyPipFailure: 各 file-locked 同义文本', () => {
  for (const t of [
    '[WinError 32]',
    '另一个程序正在使用此文件',
    '进程无法访问',
    'being used by another process',
    'cannot access the file because it is being used',
    'The process cannot access the file',
  ]) {
    assert.strictEqual(pol.classifyPipFailure(t).kind, 'file-locked', t);
  }
});

test('buildPipFailureDiagnosis: file-locked 文案含「关掉所有 khy」「force-reinstall」', () => {
  const msg = pol.buildPipFailureDiagnosis({ kind: 'file-locked', pkg: 'khy-os' });
  assert.ok(msg.includes('WinError 32'));
  assert.ok(msg.includes('关掉所有 khy'));
  assert.ok(msg.includes('node.exe'));
  assert.ok(msg.includes('--force-reinstall'));
  assert.ok(msg.includes('注销/重启'));
  assert.ok(msg.includes('corrupt orphan'));
});

test('detectWindowsUpgradeLockRisk: win32 且 node>1 → atRisk:true', () => {
  const csv = '"Image Name","PID","Session Name","Session#","Mem Usage"\n"node.exe","1111","Console","1","50,000 K"\n"node.exe","2222","Console","1","60,000 K"';
  const r = pol.detectWindowsUpgradeLockRisk({ platform: 'win32', processListText: csv });
  assert.strictEqual(r.atRisk, true);
  assert.strictEqual(r.count, 2);
});

test('detectWindowsUpgradeLockRisk: win32 且仅 1 个 node → atRisk:false(自己)', () => {
  const csv = '"Image Name","PID"\n"node.exe","1111"';
  const r = pol.detectWindowsUpgradeLockRisk({ platform: 'win32', processListText: csv });
  assert.strictEqual(r.atRisk, false);
  assert.strictEqual(r.count, 1);
});

test('detectWindowsUpgradeLockRisk: 非 win32 → atRisk:false(无 WinError 32 风险)', () => {
  const csv = '"Image Name","PID"\n"node.exe","1111"\n"node.exe","2222"';
  assert.strictEqual(pol.detectWindowsUpgradeLockRisk({ platform: 'linux', processListText: csv }).atRisk, false);
  assert.strictEqual(pol.detectWindowsUpgradeLockRisk({ platform: 'darwin', processListText: csv }).atRisk, false);
});

test('detectWindowsUpgradeLockRisk: 空/坏输入 → atRisk:false,fail-soft', () => {
  assert.strictEqual(pol.detectWindowsUpgradeLockRisk({ platform: 'win32', processListText: '' }).atRisk, false);
  assert.strictEqual(pol.detectWindowsUpgradeLockRisk({ platform: 'win32', processListText: null }).atRisk, false);
  assert.strictEqual(pol.detectWindowsUpgradeLockRisk({ platform: 'win32' }).atRisk, false);
  assert.strictEqual(pol.detectWindowsUpgradeLockRisk({}).atRisk, false);
});

const AT_RISK = { atRisk: true, count: 3 };

test('buildUpgradeStopPlan: win32 + atRisk + 门开 → shouldStop,steps 含 daemon+tray', () => {
  const plan = pol.buildUpgradeStopPlan({ platform: 'win32', risk: AT_RISK, env: {} });
  assert.strictEqual(plan.shouldStop, true);
  const ids = plan.steps.map((s) => s.id);
  assert.deepStrictEqual(ids, ['daemon', 'tray']);
  assert.ok(typeof plan.message === 'string' && plan.message.length > 0);
});

test('buildUpgradeStopPlan: 非 win32 → 不停(无 WinError 32 风险)', () => {
  assert.strictEqual(pol.buildUpgradeStopPlan({ platform: 'linux', risk: AT_RISK, env: {} }).shouldStop, false);
  assert.strictEqual(pol.buildUpgradeStopPlan({ platform: 'darwin', risk: AT_RISK, env: {} }).shouldStop, false);
});

test('buildUpgradeStopPlan: 无风险 → 不停', () => {
  assert.strictEqual(pol.buildUpgradeStopPlan({ platform: 'win32', risk: { atRisk: false, count: 1 }, env: {} }).shouldStop, false);
  assert.strictEqual(pol.buildUpgradeStopPlan({ platform: 'win32', env: {} }).shouldStop, false);
});

test('buildUpgradeStopPlan: 门关 → passthrough(不停,退回今日警告-继续行为)', () => {
  const plan = pol.buildUpgradeStopPlan({ platform: 'win32', risk: AT_RISK, env: { KHY_PIP_FAILURE_POLICY: '0' } });
  assert.strictEqual(plan.shouldStop, false);
  assert.deepStrictEqual(plan.steps, []);
});

test('buildUpgradeStopPlan: 坏入参绝不抛,返回安全值', () => {
  assert.doesNotThrow(() => pol.buildUpgradeStopPlan(null));
  assert.doesNotThrow(() => pol.buildUpgradeStopPlan({ platform: 42, risk: 'x', env: null }));
  assert.strictEqual(pol.buildUpgradeStopPlan().shouldStop, false);
});

// ── buildLockRetryPlan(修:「pip 装到一半失败,往往要装两次才成功」)────────────────────────

test('isLockRetryEnabled: 默认开,仅 0/false/off/no 关', () => {
  assert.strictEqual(pol.isLockRetryEnabled({}), true);
  assert.strictEqual(pol.isLockRetryEnabled({ KHY_UPDATE_LOCK_RETRY: 'true' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(pol.isLockRetryEnabled({ KHY_UPDATE_LOCK_RETRY: off }), false, `应关:${off}`);
  }
});

test('buildLockRetryPlan: file-locked → 重试一次(force-reinstall + 有界等待)', () => {
  const plan = pol.buildLockRetryPlan({ kind: 'file-locked', alreadyRetried: false, env: {} });
  assert.strictEqual(plan.shouldRetry, true);
  assert.strictEqual(plan.forceReinstall, true);
  assert.ok(plan.waitMs > 0 && plan.waitMs <= 5000, 'waitMs 应为有界正数');
});

test('buildLockRetryPlan: 消费 transient——文件锁类的 classify.transient 为真才重试', () => {
  // 一致性:只有 classifyPipFailure 判为 file-locked(transient:true)的失败才自动重试。
  const cls = pol.classifyPipFailure('[WinError 32] 另一个程序正在使用此文件');
  assert.strictEqual(cls.kind, 'file-locked');
  assert.strictEqual(cls.transient, true);
  assert.strictEqual(pol.buildLockRetryPlan({ kind: cls.kind }).shouldRetry, true);
});

test('buildLockRetryPlan: 一次性——alreadyRetried 后不再重试', () => {
  const plan = pol.buildLockRetryPlan({ kind: 'file-locked', alreadyRetried: true, env: {} });
  assert.strictEqual(plan.shouldRetry, false);
});

test('buildLockRetryPlan: 仅 file-locked 才重试(proxy/network/not-found/permission/other 不重试)', () => {
  for (const kind of ['proxy', 'network', 'not-found', 'permission', 'other']) {
    assert.strictEqual(pol.buildLockRetryPlan({ kind }).shouldRetry, false, `不应重试:${kind}`);
  }
});

test('buildLockRetryPlan: 子门 KHY_UPDATE_LOCK_RETRY=0 → 逐字节回退(不重试)', () => {
  const plan = pol.buildLockRetryPlan({ kind: 'file-locked', env: { KHY_UPDATE_LOCK_RETRY: '0' } });
  assert.strictEqual(plan.shouldRetry, false);
});

test('buildLockRetryPlan: 父门 KHY_PIP_FAILURE_POLICY=0 → 不重试(总策略门关)', () => {
  const plan = pol.buildLockRetryPlan({ kind: 'file-locked', env: { KHY_PIP_FAILURE_POLICY: '0' } });
  assert.strictEqual(plan.shouldRetry, false);
});

test('buildLockRetryPlan: 坏入参绝不抛,返回安全值', () => {
  assert.doesNotThrow(() => pol.buildLockRetryPlan(null));
  assert.doesNotThrow(() => pol.buildLockRetryPlan({ kind: 42, env: null }));
  assert.strictEqual(pol.buildLockRetryPlan().shouldRetry, false);
});


