#!/usr/bin/env node
'use strict';

/**
 * check-rollout-stage.js — 新机制落地阶段的守卫（PROCESS-006 / `[DESIGN-PROCESS-002]`）。
 *
 * 这个文件存在的理由见 `[DESIGN-PROCESS-002]` §6：PP-1/PP-2/PP-3 三条规定了
 * 「新拦截型机制必须怎么升阶」，但一直**没有守卫**——它们只是散文，靠人自觉。
 * 本守卫把这三条 + PP-4/PP-6 变成可执行的判据。
 *
 * ## 数据真源
 *
 * `docs/10_规范/registry/FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]` 段（PROCESS-006 §6
 * 明确建议的落点）。本脚本只**读**，绝不写——升级阶段是人的决定，不是脚本的决定。
 *
 * ## 查什么
 *
 * | 红线 | finding | 判据 |
 * |---|---|---|
 * | PP-1 禁止新机制直进 S3 | `rollout-stage-skip-s1` | stage ≥ S3 但无样本记录 |
 * | PP-2 毕业看样本量 | `rollout-stage-samples-insufficient` | 当前 stage 的样本量未达**上一阶**的阈值 |
 * | PP-3 S1/S2 必须旁路 | `rollout-stage-blocks-too-early` | stage ≤ S2 却已有规则是 blocking 强度 |
 * | PP-6 一次只升一阶 | `rollout-stage-jump` | `previousStage` 到 `stage` 跨了 2 阶以上 |
 * | PP-4 回退动作 | `rollout-stage-no-rollback` | 未登记回退动作（warning） |
 * | 阶段合法性 | `rollout-stage-unknown` | stage 不在 S1..S4 |
 * | 代码/登记一致性 | `rollout-stage-authority-drift` | 执行器里的阶段常量与登记表声明不一致 |
 *
 * ## 为什么「PP-3」这条最值钱
 *
 * 它防的是本仓已经踩过一次的坑：把 S1 阶段本该「只记录」的机制，登记成了会阻断的
 * 强度。**看起来一切正常**（其他守卫全绿），但机制已经越过了 PP-1 要求的观察期。
 * 判据不是读 `severity` 字段的字面值，而是**复算** ruleguard 的强度派生规则
 * （`gateStrength`：未声明 severity 时 P0/P1 → blocking），因为「没写」和
 * 「写了 advisory」在字面值上完全不同、效果上却可能一样。
 *
 * ## 输出方言
 *
 * `[ERROR|WARN ] <finding> <file>:<line>` + 两空格缩进 message，尾部 `Summary:`。
 * 用带锚点的方言（而非 check-repo-layout 那种不带 file:line 的聚合方言），
 * 因为阶段违规是**可定位**的：指向登记表里的具体条目，可被 `khy-allow-*` 精确抑制。
 *
 * 纪律（与仓库既有守卫一致）：零外部依赖、确定性、可离线跑、只读不改业务。
 *
 * Usage:
 *   node scripts/ci/check-rollout-stage.js
 *   node scripts/ci/check-rollout-stage.js --changed
 *   node scripts/ci/check-rollout-stage.js --explain
 *
 * Exit: 0 无 error，1 有 error，2 用法错误。
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OWNERSHIP_REL = 'docs/10_规范/registry/FEATURE-OWNERSHIP.json';
const REGISTRY_REL = 'docs/10_规范/registry/RULES-REGISTRY.json';

const args = process.argv.slice(2);
const changedMode = args.includes('--changed');
const explain = args.includes('--explain');

/**
 * 本守卫**自身**的落地阶段（PROCESS-006 PP-1：守门人也要过观察期）。
 *
 * ⚠ 这个常量不是装饰：它是 `FEATURE-OWNERSHIP.json` 里 `rollout-stage-guard` 条目的
 * `executorStage.constant`，`check-rollout-stage.js` 会拿它跟登记表比对，漂移即报错。
 * 当前 S1 ⇒ 只记录不阻断（PP-3）。升到 S3 前须按 PP-2 攒够样本。
 */
const GUARD_STAGE = 'S1';

/** 规范形只存小写；输出时映射成 ruleguard 要的定宽 6 字符方言标签。 */
const SEV_ERROR = 'error';
const SEV_WARNING = 'warning';
const labelOf = (s) => (s === SEV_ERROR ? 'ERROR' : 'WARN ');

/** PROCESS-006 §2 的毕业阈值：从某阶毕业所需的样本量。 */
const GRADUATION_SAMPLES = { S1: 200, S2: 50, S3: 20 };

/** 阶段序号，用于判「跨了几阶」。 */
const STAGE_ORDER = { S1: 1, S2: 2, S3: 3, S4: 4 };

/** ruleguard `gateStrength()` 的复算：未声明 severity 时按优先级派生。 */
function gateStrength(rule) {
  if (rule && typeof rule.severity === 'string' && ['blocking', 'ratchet', 'advisory'].includes(rule.severity)) {
    return rule.severity;
  }
  if (rule.priority === 'P0' || rule.priority === 'P1') return 'blocking';
  if (rule.priority === 'P2') return 'ratchet';
  return 'advisory';
}

/** 定位 JSON 里某个 domain/id 首次出现的行号（抑制锚点要真实行号）。 */
function lineOf(text, needle) {
  const idx = text.indexOf(needle);
  if (idx < 0) return 1;
  return text.slice(0, idx).split('\n').length;
}

function main() {
  const ownershipPath = path.join(REPO_ROOT, OWNERSHIP_REL);
  const registryPath = path.join(REPO_ROOT, REGISTRY_REL);

  if (!fs.existsSync(ownershipPath)) {
    // 登记表不存在 = 没有任何机制被登记。这是「seeded」阶段的合法状态，不报错。
    if (!changedMode) process.stdout.write('Summary: 0 error(s), 0 warning(s).\n');
    return 0;
  }

  const rawOwnership = fs.readFileSync(ownershipPath, 'utf8');
  let ownership;
  try {
    ownership = JSON.parse(rawOwnership);
  } catch (e) {
    if (!changedMode) {
      process.stdout.write(`[ERROR] rollout-stage-unreadable ${OWNERSHIP_REL}:1\n`);
      process.stdout.write(`  登记表不是合法 JSON：${e.message}\n`);
      process.stdout.write('Summary: 1 error(s), 0 warning(s).\n');
    }
    return 1;
  }

  const mechanisms = (ownership && ownership.rollout && ownership.rollout.mechanisms) || [];
  const findings = [];

  const add = (severity, finding, file, line, message) => {
    findings.push({ severity, finding, file, line, message });
  };

  if (!mechanisms.length) {
    // 空登记：合法（PROCESS-006 落地初期），但值得提醒一次。
    add(
      SEV_WARNING,
      'rollout-stage-no-mechanisms',
      OWNERSHIP_REL,
      1,
      'rollout.mechanisms 为空：没有任何机制登记落地阶段。新增拦截型机制时应在此登记，否则 PP-1/PP-6 无法被校验。'
    );
  }

  // 规则表：把规则 ID 映射成强度，供 PP-3 复算。
  let rulesById = new Map();
  let rawRegistry = '';
  if (fs.existsSync(registryPath)) {
    rawRegistry = fs.readFileSync(registryPath, 'utf8');
    try {
      const registry = JSON.parse(rawRegistry);
      for (const rule of registry.rules || []) rulesById.set(rule.id, rule);
    } catch {
      rulesById = new Map();
    }
  }

  for (const m of mechanisms) {
    const id = String((m && m.id) || '(未命名)');
    const anchorLine = lineOf(rawOwnership, JSON.stringify(m.id || id));
    const stage = String((m && m.stage) || '');

    // ── 阶段合法性 ────────────────────────────────────────────────
    if (!STAGE_ORDER[stage]) {
      add(
        SEV_ERROR,
        'rollout-stage-unknown',
        OWNERSHIP_REL,
        anchorLine,
        `机制 ${id} 的 stage="${stage}" 不是合法阶段（应取 S1|S2|S3|S4，见 [DESIGN-PROCESS-002] §2）。`
      );
      continue; // 阶段本身不合法，后续判据无从谈起
    }

    const samples = (m && m.samples && Number(m.samples.observed)) || 0;

    // ── PP-1：禁止新机制直进 S3 ───────────────────────────────────
    // 判据：进了门禁档（S3+）却没有任何观察样本 ⇒ 必然跳过了 S1 观察期。
    if (STAGE_ORDER[stage] >= 3 && samples <= 0) {
      add(
        SEV_ERROR,
        'rollout-stage-skip-s1',
        OWNERSHIP_REL,
        anchorLine,
        `机制 ${id} 已到 ${stage}（会拦截），但样本量为 ${samples} —— 违反 PP-1：新拦截型机制必须先过 S1 观测阶段，禁止直进 S3 门禁。`
      );
    }

    // ── PP-2：毕业看样本量，不看时间 ──────────────────────────────
    // 判据：当前阶是 Sn（n≥2），则从 S(n-1) 毕业所需的样本量必须已达成。
    const prev = `S${STAGE_ORDER[stage] - 1}`;
    const need = GRADUATION_SAMPLES[prev];
    if (STAGE_ORDER[stage] >= 2 && need && samples < need) {
      add(
        SEV_ERROR,
        'rollout-stage-samples-insufficient',
        OWNERSHIP_REL,
        anchorLine,
        `机制 ${id} 处于 ${stage}，但从 ${prev} 毕业需要 ≥${need} 条样本，实测 ${samples} 条 —— 违反 PP-2（阶段毕业以样本量计，禁止以时间计）。`
      );
    }

    // ── PP-3：S1/S2 必须旁路记录，禁止阻断 ────────────────────────
    if (STAGE_ORDER[stage] <= 2) {
      const ruleIds = Array.isArray(m.rules) ? m.rules : [];
      const blocking = [];
      for (const rid of ruleIds) {
        const rule = rulesById.get(rid);
        if (!rule) continue;
        if (gateStrength(rule) === 'blocking') blocking.push(rid);
      }
      if (blocking.length) {
        add(
          SEV_ERROR,
          'rollout-stage-blocks-too-early',
          OWNERSHIP_REL,
          anchorLine,
          `机制 ${id} 处于 ${stage}（只应记录），但其规则 ${blocking.join(', ')} 的强度已派生为 blocking —— 违反 PP-3（S1/S2 必须旁路记录，禁止阻断主流程）。`
        );
      }
    }

    // ── PP-6：一次只升一阶 ────────────────────────────────────────
    const prevStage = String((m && m.previousStage) || '');
    if (prevStage && STAGE_ORDER[prevStage] && STAGE_ORDER[stage] - STAGE_ORDER[prevStage] > 1) {
      add(
        SEV_ERROR,
        'rollout-stage-jump',
        OWNERSHIP_REL,
        anchorLine,
        `机制 ${id} 从 ${prevStage} 直接升到 ${stage}（跨 ${STAGE_ORDER[stage] - STAGE_ORDER[prevStage]} 阶）—— 违反 PP-6（同一机制禁止同时升两个阶段）。`
      );
    }

    // ── PP-4：回退动作必须登记（warning）──────────────────────────
    if (!String((m && m.rollback) || '').trim()) {
      add(
        SEV_WARNING,
        'rollout-stage-no-rollback',
        OWNERSHIP_REL,
        anchorLine,
        `机制 ${id} 未登记回退动作 —— PP-4 要求每个阶段都有明确的回退动作，且回退不依赖未提交的代码。`
      );
    }

    // ── 代码/登记一致性：执行器里的阶段常量不得与登记漂移 ──────────
    const auth = m && m.executorStage;
    if (auth && auth.file && auth.constant) {
      const abs = path.join(REPO_ROOT, String(auth.file));
      if (fs.existsSync(abs)) {
        const src = fs.readFileSync(abs, 'utf8');
        const re = new RegExp(`const\\s+${String(auth.constant)}\\s*=\\s*['"](S[1-4])['"]`);
        const hit = re.exec(src);
        if (!hit) {
          add(
            SEV_WARNING,
            'rollout-stage-authority-drift',
            String(auth.file),
            1,
            `机制 ${id} 声明阶段权威是 ${auth.file} 的 ${auth.constant} 常量，但文件里找不到该常量 —— 无法校验代码与登记是否一致。`
          );
        } else {
          // ⚠ 这里比的是**阻断语义**，不是字面相等。
          //
          // 踩过的坑（2026-09-18 真实部署暴露）：`check-agent-feedback.js` 的 `STAGE`
          // 常量控制的是「error 是否降级为 warning」＝**阻断档位**，而不是「机制处于第几阶」。
          // 一个登记为 S2（提示但不拦截）的机制，其执行器 STAGE 必须是 'S1'/'S2'（不阻断）——
          // 拿 `STAGE` 去和 `stage` 比相等，会把正确的搭配误报成漂移。
          //
          // ⇒ 判据改为：登记阶段「该不该拦」 vs 执行器常量「拦不拦」，不一致即漂移。
          //   两个方向都要抓：
          //   (a) 登记 S1/S2（不该拦）却 STAGE≥S3（会拦）→ 违反 PP-3；
          //   (b) 登记 S3/S4（该拦）却 STAGE≤S2（不拦）→ 机制形同虚设（登记了门禁但不生效）。
          const codeBlocks = STAGE_ORDER[hit[1]] >= 3;
          const stageShouldBlock = STAGE_ORDER[stage] >= 3;
          if (codeBlocks !== stageShouldBlock) {
            add(
              SEV_ERROR,
              'rollout-stage-authority-drift',
              String(auth.file),
              lineOf(src, hit[0]),
              codeBlocks
                ? `机制 ${id} 登记为 ${stage}（S1/S2 阶段按 PP-3 只应记录、禁止阻断），但 ${auth.file} 里 ${auth.constant}='${hit[1]}' 会阻断 —— 代码比登记更激进。`
                : `机制 ${id} 登记为 ${stage}（门禁档，应当拦截），但 ${auth.file} 里 ${auth.constant}='${hit[1]}' 不阻断 —— 登记了门禁却不生效，形同虚设。`
            );
          }
        }
      }
    }
  }

  const errors = findings.filter((f) => f.severity === SEV_ERROR);
  const warnings = findings.filter((f) => f.severity === SEV_WARNING);

  // `--changed` 一票否决详细输出：门里的消费者只认 finding 方言。
  const verbose = !changedMode;

  if (verbose) {
    process.stdout.write('check-rollout-stage: 新机制落地阶段守卫（PROCESS-006 / [DESIGN-PROCESS-002]）\n');
    process.stdout.write(`mechanisms: ${mechanisms.length} · threshold: S1=200 / S2=50 / S3=20\n`);
  }

  if (!findings.length) {
    if (verbose) process.stdout.write('result: no rollout-stage findings.\n');
  } else {
    if (verbose) process.stdout.write('result:\n');
    for (const f of [...errors, ...warnings]) {
      process.stdout.write(`[${labelOf(f.severity)}] ${f.finding} ${f.file}:${f.line}\n`);
      if (verbose) process.stdout.write(`  ${f.message}\n`);
    }
  }

  if (explain && verbose) {
    process.stdout.write('\n判据：\n');
    process.stdout.write('  PP-1 新拦截型机制必须先过 S1 观测，禁止直进 S3 → rollout-stage-skip-s1\n');
    process.stdout.write('  PP-2 阶段毕业以样本量计（S1≥200 / S2≥50 / S3≥20）→ rollout-stage-samples-insufficient\n');
    process.stdout.write('  PP-3 S1/S2 必须旁路记录，禁止阻断 → rollout-stage-blocks-too-early（按 gateStrength 复算，不看 severity 字面值）\n');
    process.stdout.write('  PP-4 每阶段必须有回退动作 → rollout-stage-no-rollback\n');
    process.stdout.write('  PP-6 一次只升一阶 → rollout-stage-jump\n');
  }

  process.stdout.write(`Summary: ${errors.length} error(s), ${warnings.length} warning(s).\n`);

  return errors.length ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main, gateStrength, GRADUATION_SAMPLES, STAGE_ORDER, GUARD_STAGE };
