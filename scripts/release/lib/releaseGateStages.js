'use strict';
/**
 * 纯叶子 releaseGateStages —— 发布门禁的阶段清单与判定逻辑(单一真源)。
 *
 * 本文件只包含数据与纯函数:阶段定义、tier/kind 选择、结果汇总、Go/No-Go 判定、
 * JSON 序列化。它不做任何 IO(不 require fs/child_process,不写标准流,不 process.exit),
 * 因此可被 node --test 直接单测,也可被薄壳 release-gate.js 消费执行。真正跑命令、
 * 读环境、着色输出、决定进程退出码的副作用全部留在薄壳里。
 *
 * 设计动机:仓库已有大量各自独立、且已被验证的硬检查入口(check:* / test:maintainer:*),
 * 但没有一条「任一步失败即阻断发布」的聚合链。本叶子把这些既有命令编排成有序、分层、
 * 可判定的发布门禁,而不重新发明其中任何一个检查。
 *
 * 字段:
 *   id       —— 稳定标识(测试/JSON 用)。
 *   title    —— 人类可读阶段名。
 *   tier     —— 'must'(硬门槛,失败即 NO-GO)| 'recommended'(强烈建议,失败降级 WARN)。
 *   kind     —— 'deterministic'(本机可确定性执行,复用既有命令)
 *               | 'environment'(依赖干净容器/真实升级/前后端实连/回滚,本机无法确定性
 *                 执行;门禁标为 MANUAL 并给出确切命令,绝不静默 PASS)。
 *   command  —— deterministic:实际执行的 shell 命令;environment:给操作者的确切指引。
 */

// 有序阶段清单。顺序按依赖递进:先版本/清单一致性,再语法/红线,再体检,最后重命令。
const STAGES = [
  {
    id: 'version-sync',
    title: '版本三源一致(pyproject / npm 清单 / backend)',
    tier: 'must',
    kind: 'deterministic',
    command: 'npm run check:version-sync',
  },
  {
    id: 'manifest-sync',
    title: '打包 manifest 同步',
    tier: 'must',
    kind: 'deterministic',
    command: 'npm run check:manifest-sync',
  },
  {
    id: 'khyos-pins',
    title: 'khyos 工具链无漂移 pin',
    tier: 'must',
    kind: 'deterministic',
    command: 'npm run check:khyos-pins',
  },
  {
    id: 'node-syntax',
    title: 'Node 语法',
    tier: 'must',
    kind: 'deterministic',
    command: 'npm run check:node-syntax',
  },
  {
    id: 'python-syntax',
    title: 'Python 语法',
    tier: 'must',
    kind: 'deterministic',
    command: 'npm run check:python-syntax',
  },
  {
    id: 'small-model-safety',
    title: '仓库红线(change-safety / agent-rules / leaf-contract / model-hardcoding)',
    tier: 'must',
    kind: 'deterministic',
    command: 'npm run check:small-model:safety',
  },
  {
    id: 'maintainer-safety',
    title: '维护映射表 + 安全门禁',
    tier: 'must',
    kind: 'deterministic',
    command: 'npm run check:maintainer:safety',
  },
  {
    id: 'ai-chat-ui-control',
    title: 'AI Chat UI 控制请求',
    tier: 'must',
    kind: 'deterministic',
    command: 'npm run check:ai-chat-ui-control-request',
  },
  {
    id: 'doctor-preflight',
    // 只读体检(等价 khy preflight):绝不用会写盘/自愈的 `khy doctor`(裸),那属于
    // 环境门的手动步骤。--check 让 doctor 只诊断不修复,退出码如实反映阻塞项。
    title: 'khy doctor 只读体检(--check,不自愈)',
    tier: 'must',
    kind: 'deterministic',
    command: 'khy doctor --check',
  },
  {
    // 离机还原就绪自检:发布物在别的电脑/系统上「装完能完整、简单地还原」是本渠道
    // (pip / npm 唯二离机通道)的核心承诺。restore-check.js 只读探测,任一探针失败退化为
    // null(未知)绝不崩,仅在真有拦路项时退出码 1 -> must 阻断。把它接进门禁,单人维护者
    // 发包前 `npm run gate:release` 一条命令即得还原就绪的 Go/No-Go,不必记住手动跑。
    id: 'restore-readiness',
    title: '离机还原就绪自检(装完能否完整简单还原)',
    tier: 'must',
    kind: 'deterministic',
    command: 'npm run restore-check',
  },
  {
    // 已装副本完整性:探测 bundled 运行时关键文件是否齐全(缺一即 exit 1)。与 restore-readiness
    // 正交——前者问「能不能还原」,本项问「装出来的副本是不是完整的」。同为只读、不抛、退出码如实。
    id: 'install-integrity',
    title: '已装副本完整性自检(bundled 运行时关键文件齐全)',
    tier: 'must',
    kind: 'deterministic',
    command: 'npm run verify-install',
  },
  {
    id: 'maintainer-tests',
    title: '维护者测试集(CLI / 网关 / 运行时 / AI 管理 / 发布预检)',
    tier: 'recommended',
    kind: 'deterministic',
    command: 'npm run test:maintainer:all',
  },
  {
    id: 'pip-purity',
    title: 'pip 发布物纯度 / 完整性审计(隔离构建)',
    tier: 'recommended',
    kind: 'deterministic',
    command: 'npm run check:pip-packaging',
  },

  // ── 环境门 ────────────────────────────────────────────────────────────────
  // 干净容器新装、真实旧版升级、前后端实连、回滚——本机无法确定性执行。门禁把它们
  // 标为 MANUAL 并打印确切命令/指引,计入最终人工 Go/No-Go,但绝不静默 PASS。
  {
    id: 'fresh-install',
    title: '干净环境新装冒烟',
    tier: 'must',
    kind: 'environment',
    command:
      'pip install khy-os && khy --version && khy doctor    ' +
      '# npm 通道: npm install -g @khy-os/khy-os && khy --version',
  },
  {
    id: 'upgrade',
    title: '旧版升级冒烟(保留旧配置 / 会话 / 数据)',
    tier: 'must',
    kind: 'environment',
    command:
      '在存有旧配置的机器上升级到本版:验证启动正常、旧会话/token/app 数据不被无声破坏、' +
      '迁移失败时能说清「已完成什么、剩什么」。至少覆盖「上一正式版 -> 本版」。',
  },
  {
    id: 'frontend-backend',
    title: '前端连通后端(端口漂移容错)',
    tier: 'must',
    kind: 'environment',
    command:
      '启动后端 + 前端,验证前端拿到真实端口并连上;端口被占用时自动探测下一个可用端口,' +
      '不出现 EADDRINUSE 直接启动失败。可参考: npm run test:maintainer:runtime。',
  },
  {
    id: 'rollback',
    title: '回滚路径',
    tier: 'must',
    kind: 'environment',
    command:
      '降级到上一版,验证:配置保留、数据目录兼容、回滚后仍可再次升级。',
  },
];

const TIERS = ['must', 'recommended'];
const KINDS = ['deterministic', 'environment'];

/**
 * 按 tier 选取阶段。
 *   'must' —— 仅 must 阶段(最小硬门槛)。
 *   'all'  —— must + recommended(完整彩排)。
 * 无论哪种,environment 阶段始终保留(它们只被展示为 MANUAL,不参与自动执行)。
 * @returns {{ runnable: object[], manual: object[], selected: object[] }}
 */
function selectStages(tier) {
  const wantAll = tier === 'all' || tier === 'recommended';
  const selected = STAGES.filter((s) => {
    if (s.kind === 'environment') return true;
    if (wantAll) return true;
    return s.tier === 'must';
  });
  const runnable = selected.filter((s) => s.kind === 'deterministic');
  const manual = selected.filter((s) => s.kind === 'environment');
  return { runnable, manual, selected };
}

/** 归一化一个执行结果为标准形状(纯函数,不改入参)。 */
function makeResult(stage, { status, code = null, ms = 0, detail = '' } = {}) {
  return {
    id: stage.id,
    title: stage.title,
    tier: stage.tier,
    kind: stage.kind,
    command: stage.command,
    status, // 'pass' | 'fail' | 'skip' | 'manual'
    code,
    ms,
    detail: String(detail || ''),
  };
}

/**
 * 计算自动化判定。
 * automatedGo=false 当且仅当存在 tier==='must' 且 kind==='deterministic' 且 status==='fail'。
 * recommended 的失败只计入 warnings,不翻转 automatedGo。
 * environment 阶段永远是 status==='manual',不参与 automatedGo,但计入 manualRequired。
 * @returns {{ automatedGo: boolean, blockers: object[], warnings: object[], manualRequired: object[] }}
 */
function computeVerdict(results) {
  const blockers = results.filter(
    (r) => r.tier === 'must' && r.kind === 'deterministic' && r.status === 'fail',
  );
  const warnings = results.filter(
    (r) => r.tier === 'recommended' && r.kind === 'deterministic' && r.status === 'fail',
  );
  const manualRequired = results.filter(
    (r) => r.kind === 'environment' && r.tier === 'must',
  );
  return {
    automatedGo: blockers.length === 0,
    blockers,
    warnings,
    manualRequired,
  };
}

const STATUS_MARK = {
  pass: 'PASS',
  fail: 'FAIL',
  skip: 'SKIP',
  manual: 'MANUAL',
};

/** 单结果格式化为一行(无颜色,纯字符串)。 */
function formatResultLine(r) {
  const mark = STATUS_MARK[r.status] || String(r.status).toUpperCase();
  const tierTag = r.tier === 'must' ? 'must' : 'reco';
  const time = r.kind === 'deterministic' && r.ms ? ` (${r.ms}ms)` : '';
  return `[${mark}] (${tierTag}) ${r.title}${time}`;
}

/**
 * 渲染完整报告(无颜色,纯字符串)。薄壳可在此基础上着色。
 * 包含:逐阶段行、失败定位(命令 + detail 摘要)、环境门手动清单、最终判定。
 */
function formatReport(results, verdict) {
  const v = verdict || computeVerdict(results);
  const lines = [];
  lines.push('发布门禁 —— 阶段结果');
  lines.push('='.repeat(60));

  for (const r of results.filter((x) => x.kind === 'deterministic')) {
    lines.push(formatResultLine(r));
  }

  const manual = results.filter((x) => x.kind === 'environment');
  if (manual.length) {
    lines.push('');
    lines.push('环境门(MANUAL —— 本机无法确定性执行,须人工彩排,不视为已通过):');
    for (const r of manual) {
      lines.push(`  [MANUAL] (${r.tier === 'must' ? 'must' : 'reco'}) ${r.title}`);
      lines.push(`           ${r.command}`);
    }
  }

  if (v.blockers.length) {
    lines.push('');
    lines.push('阻断项(must 失败 —— 发布 NO-GO):');
    for (const b of v.blockers) {
      lines.push(`  - ${b.title}`);
      lines.push(`      命令: ${b.command}`);
      if (b.detail) lines.push(`      定位: ${firstLines(b.detail, 3)}`);
    }
  }
  if (v.warnings.length) {
    lines.push('');
    lines.push('警告项(recommended 失败 —— 不阻断,但发布前应处理):');
    for (const w of v.warnings) {
      lines.push(`  - ${w.title} (${w.command})`);
    }
  }

  lines.push('');
  lines.push('='.repeat(60));
  if (v.automatedGo) {
    lines.push(
      `自动化门禁: GO —— 确定性检查全部通过。` +
        `仍须完成 ${v.manualRequired.length} 项环境门手动彩排后才可最终 Go。`,
    );
  } else {
    lines.push(
      `自动化门禁: NO-GO —— ${v.blockers.length} 个 must 阶段失败,发布被阻断。`,
    );
  }
  return lines.join('\n');
}

/** 取字符串前 n 行拼成单行摘要(用于失败定位)。 */
function firstLines(text, n) {
  return String(text)
    .split('\n')
    .map((s) => s.trimEnd())
    .filter((s) => s.length)
    .slice(0, n)
    .join(' | ');
}

/** 序列化为机器可消费 JSON 对象(--json)。纯数据,无 IO。 */
function toJson(results, verdict) {
  const v = verdict || computeVerdict(results);
  return {
    schema: 'khy.release-gate/v1',
    automatedGo: v.automatedGo,
    verdict: v.automatedGo ? 'GO' : 'NO-GO',
    counts: {
      total: results.length,
      pass: results.filter((r) => r.status === 'pass').length,
      fail: results.filter((r) => r.status === 'fail').length,
      manual: results.filter((r) => r.status === 'manual').length,
      blockers: v.blockers.length,
      warnings: v.warnings.length,
      manualRequired: v.manualRequired.length,
    },
    stages: results.map((r) => ({
      id: r.id,
      title: r.title,
      tier: r.tier,
      kind: r.kind,
      status: r.status,
      code: r.code,
      ms: r.ms,
    })),
  };
}

module.exports = {
  STAGES,
  TIERS,
  KINDS,
  selectStages,
  makeResult,
  computeVerdict,
  formatResultLine,
  formatReport,
  firstLines,
  toJson,
};
