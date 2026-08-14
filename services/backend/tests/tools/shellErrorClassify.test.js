'use strict';

/**
 * shellErrorClassify — 把「未见过的」shell 失败(非空 stderr、不属 python 姿势错)据报错签名
 * 归入一个已知环境/姿势错家族,各追加一句可操作改法。目标:khyos 面对没被专门教过的错误时,
 * 默认反应从「裸抛 stderr → 反复试错」提升为「附一条修复方向」。
 *
 * 本套件验证:七类家族各命中一句改法、单火(最多一条)、让位 python(not-found)、只治环境/
 * 姿势错不猜业务逻辑错、门控关字节回退 null、fail-soft 绝不抛、LIVE wiring 进 composeShellError。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mod = require('../../src/tools/shellErrorClassify');

test('家族①缺依赖(Node):Cannot find module → npm install + 点名包', () => {
  const h = mod.buildShellErrorHint(
    'node build.js',
    "Error: Cannot find module 'chalk'\n    at ...",
    {},
  );
  assert.ok(h);
  assert.ok(/chalk/.test(h), '应点名缺失包');
  assert.ok(/npm/.test(h), '应给 npm 安装方向');
});

test('家族①缺依赖(Python):ModuleNotFoundError → pip install + 点名模块', () => {
  const h = mod.buildShellErrorHint(
    'python analyze.py',
    "ModuleNotFoundError: No module named 'pandas'",
    {},
  );
  assert.ok(h);
  assert.ok(/pandas/.test(h));
  assert.ok(/pip install/.test(h));
});

test('家族②端口占用:EADDRINUSE → 查占用/换端口', () => {
  const h = mod.buildShellErrorHint('node server.js', 'Error: listen EADDRINUSE: address already in use :::3000', {});
  assert.ok(h);
  assert.ok(/占用|lsof|netstat/.test(h));
});

test('家族③磁盘满:ENOSPC → 清理/换路径', () => {
  const h = mod.buildShellErrorHint('cp big.iso /mnt/x', "cp: error writing '/mnt/x': No space left on device", {});
  assert.ok(h);
  assert.ok(/磁盘|空间|df/.test(h));
});

test('家族④网络/DNS:ECONNREFUSED → 核实可达/代理', () => {
  const h = mod.buildShellErrorHint('curl https://x.example', 'curl: (7) Failed to connect: Connection refused (ECONNREFUSED)', {});
  assert.ok(h);
  assert.ok(/网络|连接|DNS|代理/.test(h));
});

test('家族⑤权限拒绝:Permission denied → 核实属主/慎 sudo', () => {
  const h = mod.buildShellErrorHint('./deploy.sh', 'bash: ./deploy.sh: Permission denied', {});
  assert.ok(h);
  assert.ok(/权限|chmod|sudo/.test(h));
});

test('家族⑥命令找不到(非 python):command not found → 点名命令 + which/where', () => {
  const h = mod.buildShellErrorHint('kubectl get pods', 'bash: kubectl: command not found', {});
  assert.ok(h);
  assert.ok(/kubectl/.test(h), '应点名命令');
  assert.ok(/which|where|PATH/.test(h));
});

test('家族⑥让位 python:python3 not recognized → null(交给 pythonInvocationHint)', () => {
  const h = mod.buildShellErrorHint(
    'python3 -c "print(1)"',
    "'python3' 不是内部或外部命令",
    {},
  );
  assert.strictEqual(h, null, 'python 的 not-found 家族应让位,不双开');
});

test('家族⑦路径不存在:ENOENT → 核实路径/cwd', () => {
  const h = mod.buildShellErrorHint('cat missing.txt', "cat: missing.txt: No such file or directory", {});
  assert.ok(h);
  assert.ok(/路径|ENOENT|pwd|ls/.test(h));
});

test('家族·下载/HTTP 404(截图真景):powershell Invoke-WebRequest Not Found → 判「远端资源没找到」而非「找不到命令」', () => {
  // 精确复现截图:纯文本模型跑 powershell 下载 OpenCode 便携版,远端 404,
  // 旧逻辑被裸 "Not Found" / ": not found" 误诊成「找不到命令 powershell」。
  const stderr = [
    'Invoke-WebRequest : Not Found',
    'At line:1 char:1',
    "+ Invoke-WebRequest -Uri 'https://github.com/opencode-ai/opencode/releases/...'",
    '    + CategoryInfo          : InvalidOperation: (System.Net.HttpWebRequest:HttpWebRequest) [Invoke-WebRequest], WebException',
    '    + FullyQualifiedErrorId : WebCmdletWebResponseException,Microsoft.PowerShell.Commands.InvokeWebRequestCommand',
  ].join('\n');
  const h = mod.buildShellErrorHint(
    'powershell -Command "Invoke-WebRequest -Uri \'https://github.com/opencode-ai/opencode/releases/x\'"',
    stderr,
    {},
  );
  assert.ok(h, '应命中下载家族');
  assert.ok(/下载|远端|资源/.test(h), '应判为远端资源没找到');
  assert.ok(!/找不到命令/.test(h), '绝不能再误诊成「找不到命令」');
  assert.ok(/gh release|api\.github\.com|资产|tag|标签/.test(h), '应给「先查发布 API 列真实资产」的可操作方向');
});

test('家族·下载单火优先:含 404 + 裸 "not found" 时,下载家族赢在命令/路径家族之前', () => {
  const h = mod.buildShellErrorHint(
    'curl -f https://example.com/x.tar.gz',
    'curl: (22) The requested URL returned error: 404 Not Found',
    {},
  );
  assert.ok(h);
  assert.ok(/下载|远端/.test(h));
  assert.ok(!/找不到命令|路径/.test(h), '下载家族排在命令/路径之前,单火不让位');
});

test('无回归:真·命令缺失(无下载签名)仍判「找不到命令」', () => {
  const h = mod.buildShellErrorHint('frobnicate --help', 'bash: frobnicate: command not found', {});
  assert.ok(h);
  assert.ok(/找不到命令|frobnicate/.test(h), '纯命令缺失不应被下载家族抢走');
  assert.ok(!/下载|远端资源/.test(h));
});

test('单火:同时含缺模块 + 权限签名 → 只返回优先级最高的一条(缺模块)', () => {
  const h = mod.buildShellErrorHint(
    'python x.py',
    "ModuleNotFoundError: No module named 'requests'\nPermissionError: [Errno 13] Permission denied",
    {},
  );
  assert.ok(h);
  // 应是缺模块(规则表①在权限⑤之前),且不把两条堆叠成墙
  assert.ok(/requests/.test(h) && /pip install/.test(h));
  assert.ok(h.indexOf('\n') === -1 || !/chmod/.test(h), '单火:不应叠加权限那条');
});

test('只治环境/姿势错,不猜业务逻辑错 → null', () => {
  // 断言失败 / 业务异常:修复在用户代码里,不属本叶子
  assert.strictEqual(mod.buildShellErrorHint('npm test', 'AssertionError: expected 1 to equal 2', {}), null);
  assert.strictEqual(mod.buildShellErrorHint('python x.py', "KeyError: 'name'", {}), null);
  assert.strictEqual(mod.buildShellErrorHint('go build', 'undefined: fmt.Printlnn', {}), null);
});

test('空输出 → null(归 diagnoseEmptyFailure 管,本叶子不接管)', () => {
  assert.strictEqual(mod.buildShellErrorHint('ls /x', '', {}), null);
  assert.strictEqual(mod.buildShellErrorHint('ls /x', '   ', {}), null);
});

test('门控关 → null(字节回退,不追加任何行)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      mod.buildShellErrorHint('node server.js', 'EADDRINUSE: address already in use', {
        KHY_SHELL_ERROR_CLASSIFY: off,
      }),
      null,
      off,
    );
  }
});

test('shellErrorClassifyEnabled:默认开 + 关闭词表(CANON 4 词)', () => {
  assert.strictEqual(mod.shellErrorClassifyEnabled({}), true);
  assert.strictEqual(mod.shellErrorClassifyEnabled({ KHY_SHELL_ERROR_CLASSIFY: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(mod.shellErrorClassifyEnabled({ KHY_SHELL_ERROR_CLASSIFY: off }), false, off);
  }
});

test('_firstCommandToken:跳 env 赋值 / sudo / rtk 前缀,取 basename', () => {
  assert.strictEqual(mod._firstCommandToken('kubectl get pods'), 'kubectl');
  assert.strictEqual(mod._firstCommandToken('FOO=1 sudo /usr/bin/helm ls'), 'helm');
  assert.strictEqual(mod._firstCommandToken('rtk git status'), 'git');
  assert.strictEqual(mod._firstCommandToken(''), '');
});

test('fail-soft:异常 / 非字符串输入绝不抛', () => {
  for (const bad of [null, undefined, 123, {}, []]) {
    assert.doesNotThrow(() => mod.buildShellErrorHint(bad, bad, {}));
  }
});

test('LIVE wiring:shellDiagnostics.composeShellError 确实 require 本叶子', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/tools/shellDiagnostics.js'),
    'utf8',
  );
  assert.ok(
    /require\(['"]\.\/shellErrorClassify['"]\)/.test(src),
    'shellDiagnostics 应懒加载 shellErrorClassify',
  );
  assert.ok(/buildShellErrorHint/.test(src), '应调用 buildShellErrorHint');
});

test('端到端:composeShellError 对已知家族追加改法,对未知错误逐字节不变', () => {
  const { composeShellError } = require('../../src/tools/shellDiagnostics');
  // 已知家族(端口占用)→ 应含改法
  const known = composeShellError(1, 'Error: listen EADDRINUSE: address already in use', 'node server.js');
  assert.ok(/占用|lsof|netstat/.test(known), 'composeShellError 应对已知家族追加改法');
  // 未知/业务错 → 不应追加任何家族行(仍含原 stderr)
  const unknown = composeShellError(1, 'AssertionError: expected 1 to equal 2', 'npm test');
  assert.ok(/AssertionError/.test(unknown));
  assert.ok(!/lsof|chmod|pip install|npm install/.test(unknown), '未知错误不应误追加改法');
});
