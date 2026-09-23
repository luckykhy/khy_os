'use strict';

/**
 * hqReviewGate.test.js — `review -> done` 验收清算门 + `todo -> doing` 边界锁的行为锁。
 *
 * 关联设计：`.ai/hq/PROGRESS.json` 的 `review_done_rule` 段；机制说明见
 * `hqStore.js` 的「验收清算」与「scope_guard」两节。
 *
 * ⚠ **必须是 node:test 而不是 jest**：`services/backend/package.json` 里
 * `test:all = npm test && npm run test:node` —— 两套 runner 都扫全部 `*.test.js`，
 * jest 风格文件在 `test:node` 下 `jest is not defined` 落地即红；而
 * `jest.config.js:25` 会按 `require('node:test')` 标记把本文件从 jest 侧排除。
 * 这是本仓两套 runner 并存下的硬约定，勿改成 `describe/test`。
 *
 * ## 结构取舍（为什么只留 5 个 E2E spawn）
 *
 * 实测本机 `node bin/khy.js hq states` 冷启 **12~16s**（仓库体量所致，与被测
 * 逻辑无关）。若每个场景都 spawn，整文件要 4 分钟以上 —— 慢测试会被跳过，
 * 跳过的测试等于没有。所以：
 *   - **全矩阵**（9 个场景）走 `H.reviewDoneBlockers()` 纯逻辑直调 ——
 *     毫秒级，且测的就是门实际调用的那个函数；
 *   - **E2E 只留 5 个 spawn**，各证明一件纯逻辑证明不了的事：
 *     接线真实存在（拒绝非零退出码 + 状态不变 / 放行真的落盘 done /
 *     未填模板过不了门）。
 *
 * ## 为什么这个文件存在
 *
 * 2026-09-23 取证：`review -> done` 长期是**裸箭头**（无前置条件），`T-023`（P1）
 * 卡 review 3 天；`.khy/feedback/` 52 个存证目录零个被引用；3 条 `pending_verify`
 * Bug 的 notes 为 0。本文件同时执行**反向验证**（`[DESIGN-DELIV-001]` §1.2 的教训
 * —— 本仓出过「打印 7 PASS 但恒返回 0」的记分板）：坏数据必须真的被拒（非零退出码），
 * 好数据必须真的被放行 —— 缺后者无法区分「真判据」与「一律拒绝的 stub」。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const H = require('../../src/cli/hqStore');

const CLI = path.resolve(__dirname, '..', '..', 'bin', 'khy.js');
const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const REAL_HQ = path.join(REPO, '.ai', 'hq');

// ── 夹具 ─────────────────────────────────────────────────────────

/** 5 条判据的任务（形状对齐真实 T-023，但内容自足，不依赖真实数据）。 */
const TASK5 = () => ({
  id: 'T-999',
  status: 'review',
  acceptance: '1) 甲：npx jest 全绿；2) 乙：接口契约不变；3) 丙：新文件 eslint 零告警；4) 丁：行数 ≤800；5) 戊：文档同步',
  evidence: 'T-999-fixture',
});

/** 独立临时目录（每用例新建，绝不碰真实 `.khy/feedback/`）。 */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khy-hq-gate-'));
}

/** 合格的 N 条清算。breaks[i] 注入指定坏形态。 */
function goodLedger(n, breaks = {}) {
  let s = '# 验收清算\n\n';
  for (let i = 1; i <= n; i += 1) {
    const bad = breaks[i];
    if (bad === 'skip-no-reason') {
      s += `## ${i}) 判据 ${i}\n- 结果: SKIP\n\n`;
    } else if (bad === 'pass-no-evidence') {
      s += `## ${i}) 判据 ${i}\n- 结果: PASS\n\n`;
    } else if (bad === 'fail') {
      s += `## ${i}) 判据 ${i}\n- 结果: FAIL\n- 证据: 实测未通过\n\n`;
    } else {
      s += `## ${i}) 判据 ${i}\n- 结果: PASS\n- 证据: 实测通过\n\n`;
    }
  }
  return s;
}

function mkEvidence(fbRoot, name, files) {
  const dir = path.join(fbRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(dir, f), text, 'utf8');
  }
  return dir;
}

// ── 纯逻辑：acceptance 分句 ───────────────────────────────────────

test('splitAcceptance 认中文分号与 1) 2) 编号两种分句', () => {
  assert.deepStrictEqual(H.splitAcceptance('甲；乙；丙'), ['甲', '乙', '丙']);
  assert.deepStrictEqual(H.splitAcceptance('1) 甲；2) 乙；3) 丙'), ['甲', '乙', '丙']);
});

test('splitAcceptance 单句不裂；空输入返回空数组', () => {
  assert.deepStrictEqual(H.splitAcceptance('只有一条判据'), ['只有一条判据']);
  assert.deepStrictEqual(H.splitAcceptance(''), []);
  assert.deepStrictEqual(H.splitAcceptance(null), []);
});

test('splitAcceptance 括号内分号不切（T-024 实测回归锁：括号补充说明是本仓书写惯例）', () => {
  assert.deepStrictEqual(
    H.splitAcceptance('1) 甲（node:test；含矩阵）；2) 乙（a；b）'),
    ['甲（node:test；含矩阵）', '乙（a；b）']
  );
  assert.deepStrictEqual(H.splitAcceptance('甲（略）；乙'), ['甲（略）', '乙']);
});

// ── 纯逻辑：清算解析 ─────────────────────────────────────────────

test('parseAcceptanceLedger 合格样本零 error', () => {
  const { errors, verdicts } = H.parseAcceptanceLedger(goodLedger(3));
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(verdicts.length, 3);
  assert.ok(verdicts.every((v) => v.result === 'PASS'));
});

test('parseAcceptanceLedger 抓 SKIP 无理由 / PASS 无证据 / FAIL / 无段落 / 取值非法 / 空文件', () => {
  assert.ok(H.parseAcceptanceLedger('## 1) x\n- 结果: SKIP').errors.some((e) => /理由/.test(e)));
  assert.ok(H.parseAcceptanceLedger('## 1) x\n- 结果: PASS').errors.some((e) => /证据/.test(e)));
  assert.ok(H.parseAcceptanceLedger('## 1) x\n- 结果: FAIL\n- 证据: 挂了').errors.some((e) => /FAIL/.test(e)));
  assert.ok(H.parseAcceptanceLedger('随便写点什么').errors.some((e) => /##/.test(e)));
  assert.ok(H.parseAcceptanceLedger('## 1) x\n- 结果: 大概行吧').errors.some((e) => /非法/.test(e)));
  assert.ok(H.parseAcceptanceLedger('').errors.some((e) => /空/.test(e)));
});

// ── 纯逻辑：reviewDoneBlockers 全矩阵（门实际调用的函数）─────────

test('矩阵 A：缺 evidence 字段 → 阻断', () => {
  const { blockers } = H.reviewDoneBlockers({ ...TASK5(), evidence: undefined }, REPO);
  assert.ok(blockers.some((b) => /缺 evidence/.test(b)), JSON.stringify(blockers));
});

test('矩阵 A2：evidence 名称非法 → 阻断', () => {
  const { blockers } = H.reviewDoneBlockers({ ...TASK5(), evidence: 'a b/c' }, REPO);
  assert.ok(blockers.some((b) => /名称非法/.test(b)), JSON.stringify(blockers));
});

test('矩阵 B：evidence 目录不存在 → 阻断', () => {
  const fb = tmpDir();
  try {
    const { blockers } = H.reviewDoneBlockers(TASK5(), REPO, fb);
    assert.ok(blockers.some((b) => /目录不存在/.test(b)), JSON.stringify(blockers));
  } finally {
    fs.rmSync(fb, { recursive: true, force: true });
  }
});

test('矩阵 C：evidence 目录为空 → 阻断', () => {
  const fb = tmpDir();
  try {
    mkEvidence(fb, 'T-999-fixture', {});
    const { blockers } = H.reviewDoneBlockers(TASK5(), REPO, fb);
    assert.ok(blockers.some((b) => /目录为空/.test(b)), JSON.stringify(blockers));
  } finally {
    fs.rmSync(fb, { recursive: true, force: true });
  }
});

test('矩阵 D：有文件但缺 acceptance.md → 阻断', () => {
  const fb = tmpDir();
  try {
    mkEvidence(fb, 'T-999-fixture', { 'complaint.md': '主诉\n' });
    const { blockers } = H.reviewDoneBlockers(TASK5(), REPO, fb);
    assert.ok(blockers.some((b) => /acceptance\.md/.test(b)), JSON.stringify(blockers));
  } finally {
    fs.rmSync(fb, { recursive: true, force: true });
  }
});

test('矩阵 E/F/G：SKIP 缺理由 / PASS 缺证据 / FAIL 存在 → 都阻断', () => {
  const cases = [
    ['skip-no-reason', /理由/],
    ['pass-no-evidence', /证据/],
    ['fail', /FAIL/],
  ];
  for (const [bad, re] of cases) {
    const fb = tmpDir();
    try {
      mkEvidence(fb, 'T-999-fixture', { 'acceptance.md': goodLedger(5, { 2: bad }) });
      const { blockers } = H.reviewDoneBlockers(TASK5(), REPO, fb);
      assert.ok(
        blockers.some((b) => re.test(b)),
        `breaks=${bad} 应命中 ${re}；实际：${JSON.stringify(blockers)}`
      );
    } finally {
      fs.rmSync(fb, { recursive: true, force: true });
    }
  }
});

test('矩阵 H：清算条数少于判据条数（漏勾）→ 阻断', () => {
  const fb = tmpDir();
  try {
    mkEvidence(fb, 'T-999-fixture', { 'acceptance.md': goodLedger(2) });
    const { blockers } = H.reviewDoneBlockers(TASK5(), REPO, fb);
    assert.ok(blockers.some((b) => /漏勾/.test(b)), JSON.stringify(blockers));
  } finally {
    fs.rmSync(fb, { recursive: true, force: true });
  }
});

test('矩阵 I：全条清算且带证据 → 零阻断（防「一律拒绝的 stub」）', () => {
  const fb = tmpDir();
  try {
    mkEvidence(fb, 'T-999-fixture', { 'acceptance.md': goodLedger(5) });
    const { blockers, verdicts } = H.reviewDoneBlockers(TASK5(), REPO, fb);
    assert.deepStrictEqual(blockers, [], JSON.stringify(blockers));
    assert.strictEqual(verdicts.length, 5);
  } finally {
    fs.rmSync(fb, { recursive: true, force: true });
  }
});

test('矩阵 附：acceptance 质量与路径问题只 warning 不阻断（防误报率失控）', () => {
  const fb = tmpDir();
  try {
    // 纯描述性 acceptance（无命令无数字）+ 引用不存在的路径，但清算全勾
    const t = {
      id: 'T-999',
      status: 'review',
      acceptance: '按 _meta/SPLIT-PLAN.md 执行；界面好看；用户满意',
      evidence: 'T-999-fixture',
    };
    mkEvidence(fb, 'T-999-fixture', { 'acceptance.md': goodLedger(3) });
    const { blockers, warnings } = H.reviewDoneBlockers(t, REPO, fb);
    assert.deepStrictEqual(blockers, [], '形式问题不得阻断');
    assert.ok(warnings.some((w) => /无.*命令|数字/.test(w)), JSON.stringify(warnings));
    assert.ok(warnings.some((w) => /SPLIT-PLAN/.test(w)), JSON.stringify(warnings));
  } finally {
    fs.rmSync(fb, { recursive: true, force: true });
  }
});

// ── 纯逻辑：validateTask 新字段（出现即校验，存量不追溯）──────────

const base = { id: 'T-998', domain: 'cli', type: 'feature', priority: 'P1', status: 'todo' };

test('validateTask 放过不带新字段的存量条目；校验 evidence/baseline_metrics/scope_guard 形状', () => {
  assert.deepStrictEqual(H.validateTask({ ...base }), []);
  assert.ok(H.validateTask({ ...base, evidence: '   ' }).length);
  assert.ok(H.validateTask({ ...base, evidence: 'a b/c' }).length);
  assert.deepStrictEqual(H.validateTask({ ...base, evidence: 'T-998-slug' }), []);
  assert.ok(H.validateTask({ ...base, baseline_metrics: { jest_suites: '1231' } }).length);
  assert.deepStrictEqual(H.validateTask({ ...base, baseline_metrics: { jest_suites: 1231 } }), []);
  assert.ok(H.validateTask({ ...base, scope_guard: [] }).length);
  assert.ok(H.validateTask({ ...base, scope_guard: '不改 gateway' }).length);
  assert.deepStrictEqual(H.validateTask({ ...base, scope_guard: ['不改 gateway'] }), []);
});

// ── 纯逻辑：scope_guard 前缀抽取与越界判定 ───────────────────────

test('scopeGuardPrefixes 抽路径前缀；语义约束归人工；盘符剔除', () => {
  const { prefixes, manual } = H.scopeGuardPrefixes([
    '不改 services/backend 以外',
    '不动 keyStore 的对外契约',
    '绝不碰 D:/Portable 之外的盘',
  ]);
  assert.ok(prefixes.includes('services/backend'), JSON.stringify(prefixes));
  assert.ok(!prefixes.some((p) => /^D:/.test(p)), '盘符路径不得进前缀');
  assert.ok(manual.includes('不动 keyStore 的对外契约'), JSON.stringify(manual));
});

test('scopeViolations 判定边界之外的文件', () => {
  const sg = ['只改 services/backend 与 apps/ai-frontend'];
  const { outside } = H.scopeViolations(sg, [
    'services/backend/src/cli/hqStore.js',
    'apps/ai-frontend/src/views/Layout.vue',
    'kernel/foo.c',
  ]);
  assert.deepStrictEqual(outside, ['kernel/foo.c']);
});

// ── 端到端：接线证明（5 个 spawn，每个 ~13s）─────────────────────

/**
 * 真跑一次 CLI。
 *
 * ⚠ stdio 必须落**文件**而不是管道（2026-09-23 实测教训）：spawnSync 的管道版
 * 会等到「所有持有写端的后代进程都退出」才返回 —— 而 khy.js 启动时会拉起
 * 后台辅助进程（gateway warmup 等），其存活时间不可控（实测一次 988s，
 * 远超 120s 的 kill 超时：kill 只杀直接子进程，管道被孙进程攥着导致
 * spawnSync 迟迟不返回，r.status=null）。stdio 重定向到文件后，
 * 直接子进程一退出 spawnSync 即返回，后代进程攥着的文件句柄与我们无关。
 *
 * 同时显式关掉三类启动期后台行为（warmup / 更新检查 / 自动安装），
 * 让被测时间只含被测逻辑。
 */
function runCli(args, extraEnv, sandboxDir) {
  const outFile = path.join(
    sandboxDir,
    `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`
  );
  const fd = fs.openSync(outFile, 'w');
  try {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: REPO,
      encoding: 'utf8',
      env: Object.assign({}, process.env, extraEnv, {
        KHY_GATEWAY_WARMUP_ON_BOOT: '0',
        KHY_STARTUP_UPDATE_CHECK: '0',
        KHY_AUTO_UPDATE: '0',
      }),
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: 120000,
    });
    return { code: r.status, signal: r.signal, output: fs.readFileSync(outFile, 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

/** 建独立沙箱（真实 `.ai/hq/` 拷贝 + 空反馈目录），返回 env 覆盖。 */
function newSandboxEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-hq-gate-e2e-'));
  const hq = path.join(root, 'hq');
  fs.mkdirSync(hq, { recursive: true });
  for (const f of ['BUGS.json', 'PROGRESS.json', 'ROADMAP.md', 'MODELS.json']) {
    fs.copyFileSync(path.join(REAL_HQ, f), path.join(hq, f));
  }
  fs.cpSync(path.join(REAL_HQ, 'prompts'), path.join(hq, 'prompts'), { recursive: true });
  const fb = path.join(root, 'feedback');
  fs.mkdirSync(fb, { recursive: true });
  return { root, hq, fb, env: { KHY_HQ_DIR: hq, KHY_FEEDBACK_DIR: fb } };
}

function sandboxStatus(env, id) {
  const d = JSON.parse(fs.readFileSync(path.join(env.hq, 'PROGRESS.json'), 'utf8'));
  const t = (d.tasks || []).find((x) => x.id === id);
  return t ? t.status : null;
}

test('E2E 缺 evidence → 非零退出码且状态不变（接线真实存在的证明）', () => {
  const env = newSandboxEnv();
  try {
    const r = runCli(['hq', 'task', 'set', 'T-023', 'done'], env.env, env.root);
    assert.notStrictEqual(r.code, 0, `应被拒但退出码 ${r.code}；输出：\n${r.output}`);
    assert.strictEqual(sandboxStatus(env, 'T-023'), 'review', '被拒时状态必须不变');
    assert.ok(r.output.includes('缺 evidence'), r.output);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('E2E 存在 FAIL 的清算 → 拒（清算内容真的被读，不是只查目录存在）', () => {
  const env = newSandboxEnv();
  try {
    mkEvidence(env.fb, 'T-023-e2e', {
      'acceptance.md': goodLedger(5, { 3: 'fail' }),
    });
    const p = path.join(env.hq, 'PROGRESS.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = d.tasks.find((x) => x.id === 'T-023');
    t.status = 'review';
    t.evidence = 'T-023-e2e';
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');

    const r = runCli(['hq', 'task', 'set', 'T-023', 'done'], env.env, env.root);
    assert.notStrictEqual(r.code, 0, `应被拒；输出：\n${r.output}`);
    assert.ok(r.output.includes('FAIL'), r.output);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('E2E 全条清算 → 放行落盘 done 且清算入账（防「一律拒绝的 stub」）', () => {
  const env = newSandboxEnv();
  try {
    const p = path.join(env.hq, 'PROGRESS.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = d.tasks.find((x) => x.id === 'T-023');
    t.status = 'review';
    t.evidence = 'T-023-e2e';
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');
    const expected = H.splitAcceptance(t.acceptance).length;
    mkEvidence(env.fb, 'T-023-e2e', { 'acceptance.md': goodLedger(expected) });

    const r = runCli(['hq', 'task', 'set', 'T-023', 'done'], env.env, env.root);
    assert.strictEqual(r.code, 0, `应放行；输出：\n${r.output}`);
    assert.strictEqual(sandboxStatus(env, 'T-023'), 'done', '放行后应为 done');

    const d2 = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t2 = d2.tasks.find((x) => x.id === 'T-023');
    assert.ok(t2.acceptance_audit, '放行后应写入 acceptance_audit');
    assert.strictEqual(t2.acceptance_audit.total, expected);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('E2E accept 生成的未填模板必须过不了门（防「生成即完成」的形式主义）', () => {
  const env = newSandboxEnv();
  try {
    const r1 = runCli(['hq', 'accept', 'T-023', '--evidence', 'T-023-tpl'], env.env, env.root);
    assert.strictEqual(r1.code, 0, r1.output);
    const ledger = path.join(env.fb, 'T-023-tpl', 'acceptance.md');
    assert.ok(fs.existsSync(ledger), '应生成 acceptance.md');

    const p = path.join(env.hq, 'PROGRESS.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = d.tasks.find((x) => x.id === 'T-023');
    t.status = 'review';
    t.evidence = 'T-023-tpl';
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');

    const r2 = runCli(['hq', 'task', 'set', 'T-023', 'done'], env.env, env.root);
    assert.notStrictEqual(r2.code, 0, '未填的模板必须被拒');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('E2E accept 不覆盖已存在的清算文件', () => {
  const env = newSandboxEnv();
  try {
    mkEvidence(env.fb, 'T-023-keep', { 'acceptance.md': '我手写的，别动\n' });
    const r = runCli(['hq', 'accept', 'T-023', '--evidence', 'T-023-keep'], env.env, env.root);
    assert.strictEqual(r.code, 0, r.output);
    const text = fs.readFileSync(path.join(env.fb, 'T-023-keep', 'acceptance.md'), 'utf8');
    assert.strictEqual(text, '我手写的，别动\n', '已存在时不得覆盖');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

// ── 纯逻辑：acceptance 路径失效检测（含中文前缀回归锁）────────────

test('auditAcceptancePaths 抓不存在路径、放过真实路径、不被中文前缀污染', () => {
  const bad = H.auditAcceptancePaths(
    { id: 'T-998', acceptance: '按 _meta/SPLIT-PLAN.md 执行' },
    REPO
  );
  assert.strictEqual(bad.length, 1, JSON.stringify(bad));

  const ok = H.auditAcceptancePaths(
    { id: 'T-998', acceptance: '改 services/backend/src/cli/hqStore.js' },
    REPO
  );
  assert.deepStrictEqual(ok, []);

  // 曾把「终点：services/…」的中文前缀吞进路径 → 真实文件被误报（2026-09-23 修复）
  const cn = H.auditAcceptancePaths(
    { id: 'T-998', acceptance: '4) 终点：services/backend/src/cli/hqStore.js ≤800 行' },
    REPO
  );
  assert.deepStrictEqual(cn, [], JSON.stringify(cn));
});

// ── 纯逻辑：todo→doing 边界锁（不 spawn，直查 _applyState 同源判据）──
//
// E2E 版本需要真实 git 状态，且 `_applyState` 在 handlers 层（有 IO）。
// 这里锁「判据」本身：scope_guard 缺失/空数组/全空白都必须算「没锁边界」。
// 接线（handler 在 todo→doing 时调用它）由下方 spawn 用例覆盖。

test('边界锁判据：scope_guard 缺失 / 空数组 / 全空白都算未声明', () => {
  const missing = H.scopeGuardPrefixes(undefined);
  assert.deepStrictEqual(missing.prefixes, []);

  const empty = H.scopeGuardPrefixes([]);
  assert.deepStrictEqual(empty.prefixes, []);

  const blank = H.scopeGuardPrefixes(['  ', '']);
  assert.deepStrictEqual(blank.prefixes, []);
  assert.deepStrictEqual(blank.manual, []);
});

test('E2E todo→doing 未声明 scope_guard → 拒并指路（边界锁接线证明）', () => {
  const env = newSandboxEnv();
  try {
    const p = path.join(env.hq, 'PROGRESS.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = d.tasks.find((x) => x.id === 'T-001'); // 真实数据里的 todo 任务
    t.status = 'todo';
    delete t.scope_guard;
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');

    const r = runCli(['hq', 'task', 'set', 'T-001', 'doing'], env.env, env.root);
    assert.notStrictEqual(r.code, 0, `应被拒；输出：\n${r.output}`);
    assert.ok(r.output.includes('scope_guard'), r.output);
    assert.strictEqual(sandboxStatus(env, 'T-001'), 'todo', '被拒时状态必须不变');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('E2E task note --scope 写入边界后 todo→doing 放行（锁可以被满足）', () => {
  const env = newSandboxEnv();
  try {
    const p = path.join(env.hq, 'PROGRESS.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = d.tasks.find((x) => x.id === 'T-001');
    t.status = 'todo';
    delete t.scope_guard;
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');

    // ⚠ 每条边界一次调用：router.js 的 options 解析对重复 --key 是 last-wins
    // （router.js:764，`--scope a --scope b` 只会剩下 b）—— 实测教训，勿合并成一行。
    const r1 = runCli(
      ['hq', 'task', 'note', 'T-001', '--scope', '不改 services/backend 以外'],
      env.env,
      env.root
    );
    assert.strictEqual(r1.code, 0, r1.output);
    const r1b = runCli(
      ['hq', 'task', 'note', 'T-001', '--scope', '不动 keyStore 对外契约'],
      env.env,
      env.root
    );
    assert.strictEqual(r1b.code, 0, r1b.output);

    const d2 = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t2 = d2.tasks.find((x) => x.id === 'T-001');
    assert.ok(Array.isArray(t2.scope_guard) && t2.scope_guard.length === 2, JSON.stringify(t2.scope_guard));

    const r2 = runCli(['hq', 'task', 'set', 'T-001', 'doing'], env.env, env.root);
    assert.strictEqual(r2.code, 0, `声明边界后应放行；输出：\n${r2.output}`);
    assert.strictEqual(sandboxStatus(env, 'T-001'), 'doing');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
