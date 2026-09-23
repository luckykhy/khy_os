'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(ROOT, 'scripts', 'ci', 'check-change-safety.js');

function runSafetyCheck(...targets) {
  const result = spawnSync(process.execPath, [scriptPath, ...targets], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status == null ? 1 : result.status,
    stdout: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

describe('check-change-safety maintainer map integration', () => {
  test('uses exact-file maintainer verify commands for runtime files', () => {
    const { status, stdout } = runSafetyCheck('services/backend/src/services/daemonManager.js');

    assert.equal(status, 0);
    assert.match(stdout, /npm run test:one -- services\/backend\/tests\/daemonManager\.runtimePort\.test\.js/);
    assert.match(stdout, /khy doctor/);
  });

  test('uses directory maintainer verify commands for CLI handler targets', () => {
    const { status, stdout } = runSafetyCheck('services/backend/src/cli/handlers');

    assert.equal(status, 1);
    assert.match(stdout, /npm run test:one -- services\/backend\/tests\/cli\/router\.test\.js services\/backend\/tests\/cli\/repl\.tasks\.interaction\.test\.js/);
    assert.match(stdout, /node -e "require\('\.\/services\/backend\/src\/cli\/router'\)"/);
  });

  test('keeps targeted agent-rules command and prompt verification for prompt core', () => {
    const { status, stdout } = runSafetyCheck('services/backend/src/constants/prompts.js');

    assert.equal(status, 0);
    assert.match(stdout, /node scripts\/ci\/check-agent-rules\.js 'services\/backend\/src\/constants\/prompts\.js'/);
    assert.match(stdout, /node --test services\/backend\/tests\/promptOnDemandSections\.test\.js/);
    assert.doesNotMatch(stdout, /node scripts\/ci\/check-agent-rules\.js --changed/);
  });

  test('maps AI management files to the smallest useful verify commands', () => {
    const { status, stdout } = runSafetyCheck('services/ai-backend/src/routes/aiGatewayAdmin.js');

    assert.equal(status, 0);
    assert.match(stdout, /High-risk surface touched: route layer\./);
    assert.match(stdout, /npm run test:one -- services\/backend\/tests\/routes\/aiGatewayAdmin\.modelSlots\.test\.js services\/backend\/tests\/gatewayManage\.apiDisplay\.test\.js/);
    assert.match(stdout, /npm run build --prefix apps\/ai-frontend/);
  });

  test('maps safety gate files back to safety verification', () => {
    const { status, stdout } = runSafetyCheck('scripts/ci/check-change-safety.js');

    assert.equal(status, 0);
    assert.match(stdout, /npm run check:changed/);
    assert.match(stdout, /npm run check:quality-gates/);
  });

  test('prefers AI management verification over generic gateway checks for backend admin routes', () => {
    const { status, stdout } = runSafetyCheck('services/backend/src/routes/aiGatewayAdmin.js');

    assert.equal(status, 0);
    assert.match(stdout, /npm run test:one -- services\/backend\/tests\/routes\/aiGatewayAdmin\.modelSlots\.test\.js services\/backend\/tests\/gatewayManage\.apiDisplay\.test\.js/);
    assert.match(stdout, /npm run build --prefix apps\/ai-frontend/);
    assert.doesNotMatch(stdout, /npm run test:maintainer:gateway/);
  });

  test('keeps bootstrap verification minimal for packaging files already covered by the maintainer map', () => {
    const { status, stdout } = runSafetyCheck('pyproject.toml');

    assert.equal(status, 0);
    assert.match(stdout, /npm run check:manifest-sync/);
    assert.match(stdout, /npm run check:manifest-sync/);
    assert.match(stdout, /bash scripts\/release\/build-and-audit-pip-purity\.sh/);
    assert.doesNotMatch(stdout, /npm run test:maintainer:publish/);
    assert.doesNotMatch(stdout, /npm run check:version-sync/);
  });

  test('keeps generic gateway fallback for backend routes not covered by the maintainer map', () => {
    const { status, stdout } = runSafetyCheck('services/backend/src/routes/largeTasks.js');

    assert.equal(status, 0);
    assert.match(stdout, /npm run test:maintainer:gateway/);
    assert.match(stdout, /khy doctor/);
  });
});

describe('check-change-safety 全量模式的推荐命令', () => {
  test('无改动路径时:不推荐必然空转的 check-agent-rules,改推荐 finding 自己的复现命令', () => {
    // 用一个临时 wrapper 在 node **内部**把 PATH 收窄到空目录 ⇒ pythonInterpreter 探测不到
    // python / py / python3 ⇒ 产出 builtin-key-check-failed。**不写仓内任何文件**。
    // 这同时覆盖了「全量模式(改动集为空)但有 finding」这条此前不可达的路径。
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-no-python-'));
    const wrapper = path.join(emptyDir, 'run-without-python.js');
    fs.writeFileSync(
      wrapper,
      [
        "'use strict';",
        'process.env.PATH = ' + JSON.stringify(emptyDir) + ';',
        "process.argv = [process.argv[0], 'check-change-safety.js'];",
        'require(' + JSON.stringify(scriptPath) + ');',
      ].join('\n'),
    );
    try {
      const result = spawnSync(process.execPath, [wrapper], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
      });
      const stdout = `${result.stdout || ''}${result.stderr || ''}`;

      // 前置条件:这条判据确实触发了(否则下面的断言是空转的)。
      assert.match(stdout, /builtin-key-check-failed/);

      // 推荐块必须给出可执行的下一步:密钥检查器本体。
      assert.match(stdout, /check_builtin_keys\.py/);

      // 且不得再出现「无目标参数」的 check-agent-rules —— 它按
      // `process.exit(rawTargets.length > 0 ? 1 : 0)` 必然 exit 0,推荐它等于没推荐。
      assert.doesNotMatch(stdout, /^ - node scripts\/ci\/check-agent-rules\.js\s*$/m);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
