'use strict';

/**
 * entrypoints.js — `khy entry`：Khy 多端入口矩阵的 CLI 正门。
 *
 * 子命令：
 *   khy entry list                 列出全部端（形态 / 状态 / 源目录）
 *   khy entry list --kind=web      只看某一类端
 *   khy entry status               盘点产物：exe / apk / html 在哪、产出来没有、怎么得到
 *   khy entry info <id>            单个端的完整声明（启动/构建命令、平台档、端口、产物坐标）
 *   khy entry probe [id]           检活：探磁盘与工具链，报「声明 vs 磁盘」是否漂移
 *   khy entry launch <id>          启动一个端（--dry-run 只打印计划）
 *   khy entry build <id>           构建一个端（--dry-run 只打印计划）
 *
 * `status` 是回答「我怎么没看见 exe / apk / html」的那一条：产物按 LAYOUT-005 一律落
 * `entries/<producer>/`（2026-09-18 迁移，原为仓库根 `_build/`），故本目录既是指南针也是产物根——
 * 但 gitignore 只放行三件索引文件，`entries/*` 子目录不进 git；产物坐标的真源是
 * `docs/10_规范/registry/BUILD-OUTPUTS.json`，本命令把那份登记表解析成「在不在 + 怎么得到」。
 *
 * 与 `khy cross start` 的关系：那套是**开发期跨端拉起**的旧实现（硬编码命令表，
 * 且 mobile 项指向已损坏的 apps/khy-mobile）。本命令是它的收敛点——端矩阵是
 * 单一真源，`khy cross start` 保留为兼容入口，不再新增端。
 *
 * 与 `khy desktop` / `khy mobile` 的关系：那两个是**同名不同义**的命令
 * （桌面控制开关 / 配对二维码），刻意不接管，避免把两件事混成一个词。
 *
 * @module handlers/entrypoints
 */

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const entrypoints = require('../../services/entrypoints');

function fmt() {
  return require('../formatters');
}

const STATUS_LABEL = {
  ready: '就绪',
  degraded: '降级',
  broken: '损坏',
  planned: '未落地',
};

/**
 * 解析 `--key=value` / `--key` 形式的选项。
 * @param {string[]} args
 * @returns {{ options: object, positionals: string[] }}
 */
function parseFlags(args) {
  const options = {};
  const positionals = [];
  for (const raw of Array.isArray(args) ? args : []) {
    if (typeof raw !== 'string') continue;
    if (!raw.startsWith('--')) {
      positionals.push(raw);
      continue;
    }
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) {
      options[body] = true;
    } else {
      options[body.slice(0, eq)] = body.slice(eq + 1);
    }
  }
  return { options, positionals };
}

/**
 * 汇总选项与位置参数。
 *
 * **两个来源都要读，缺一不可**：`router.js` 已经在 `parseCommandArgs` 里把 `--flags`
 * 从 `args` 里剥走、放进了 `parsed.options`；而直接调用 handler 的场合
 * （测试、`--json` 之类的外部调用）flag 还留在 `args` 里。
 * 只读其中一个的后果是**静默失效**——曾实测到 `khy entry launch desktop --dry-run`
 * 因只读了 args 而忽略 --dry-run，真的去拉起了 Electron。所以这里取并集，
 * 且以 `parsed.options`（路由层解析的结果）为优先。
 *
 * @param {{ args?: string[], options?: object }} parsed
 * @returns {{ options: object, positionals: string[] }}
 */
function readArguments(parsed) {
  const fromArgs = parseFlags(parsed && parsed.args);
  const fromRouter =
    parsed && parsed.options && typeof parsed.options === 'object' ? parsed.options : {};
  return {
    positionals: fromArgs.positionals,
    options: { ...fromArgs.options, ...fromRouter },
  };
}

/**
 * 布尔开关判定：路由层给的是 `true`，直接调用可能给字符串。
 * @param {unknown} value
 * @returns {boolean}
 */
function isOn(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

// ── list ──────────────────────────────────────────────────────────

function renderList(f, asJson, filters) {
  const overview = entrypoints.overview(filters);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          meta: overview.meta,
          entries: overview.entries.map(e => ({
            id: e.id,
            kind: e.kind,
            title: e.title,
            artifactKind: e.artifactKind,
            source: e.source,
            status: e.status,
            statusNote: e.statusNote,
          })),
          errors: overview.errors,
        },
        null,
        2
      )
    );
    return overview.errors.length > 0 ? 1 : 0;
  }

  f.printInfo(`端矩阵 已加载 v${overview.meta.version || '?'}：${overview.path}`, '入口');

  const rows = overview.entries.map(e => [
    e.id,
    e.kind,
    e.artifactKind || '-',
    STATUS_LABEL[e.status] || e.status,
    e.source,
  ]);
  f.printTable(['端', '类型', '形态', '状态', '源目录'], rows);

  const counts = overview.entries.reduce((acc, e) => {
    acc[e.status] = (acc[e.status] || 0) + 1;
    return acc;
  }, {});
  const breakdown = Object.entries(counts)
    .map(([status, n]) => `${STATUS_LABEL[status] || status} ${n}`)
    .join(' / ');
  f.printInfo(
    `端统计 ${overview.entries.length} 个：${breakdown || '（空表）'}`,
    '入口'
  );

  const broken = overview.entries.filter(e => e.status === 'broken');
  for (const e of broken) {
    f.printWarn(
      `端 ${e.id} 已损坏：${e.statusNote || '无说明'} —— ` +
        `运行 khy entry info ${e.id} 查看收口建议`
    );
  }

  if (overview.errors.length > 0) {
    for (const err of overview.errors) {
      f.printError(`端矩阵校验失败：${err}`);
    }
    return 1;
  }
  return 0;
}

// ── info ──────────────────────────────────────────────────────────

function renderInfo(f, asJson, id) {
  const detail = entrypoints.describe(id);
  if (!detail) {
    const ids = entrypoints.registry.listIds();
    f.printError(
      `未知的端 ${id}：端矩阵里没有这个 id —— 现有端：${ids.join(' / ')}；` +
        '运行 khy entry list 查看全部'
    );
    return 1;
  }

  if (asJson) {
    console.log(JSON.stringify(detail, null, 2));
    return 0;
  }

  const lines = [
    `端 ${detail.id}（${detail.kind}）`,
    `标题：${detail.title}`,
    `形态：${detail.artifactKind || '未声明'}${detail.delivery ? ` —— ${detail.delivery}` : ''}`,
    `状态：${STATUS_LABEL[detail.status] || detail.status}${detail.statusNote ? ` —— ${detail.statusNote}` : ''}`,
    `源目录：${detail.sourceRel} → ${detail.source}`,
    `启动：${detail.launch ? entrypoints.launcher.formatPlan(detail.launch) : `不可用 —— ${detail.launchUnavailableReason}`}`,
    `构建：${detail.build ? entrypoints.launcher.formatPlan(detail.build) : `不可用 —— ${detail.buildUnavailableReason}`}`,
  ];
  if (detail.launch) {
    lines.push(`启动模式：${detail.launch.mode}（平台档 ${detail.launch.platformKey}）`);
  }
  if (detail.ports.length > 0) {
    for (const p of detail.ports) {
      lines.push(
        p.port === null
          ? `端口：${p.ref} 未登记 —— ${p.reason}`
          : `端口：${p.ref} = ${p.port}（来自 constants/serviceDefaults.js）`
      );
    }
  }
  if (detail.artifactOutput) {
    lines.push(
      `产物指针：docs/10_规范/registry/BUILD-OUTPUTS.json 的 "${detail.artifactOutput}" 条目（本表不复制产物路径）`
    );
  }
  for (const note of detail.notes) {
    lines.push(`注：${note}`);
  }

  for (const line of lines) console.log(line);
  return 0;
}

// ── status ────────────────────────────────────────────────────────
//
// 回答用户真正要问的那个问题：**「exe / apk / html 到底在哪、产出来没有？」**
//
// 与 list 的分工：list 讲「端声明了什么」，status 讲「磁盘上有什么」。
// 与 probe 的分工：probe 讲「端能不能跑起来」（源目录/标记/工具链/构建档），
// status 只讲「产物在不在」。两者都不写回 entries.json。

/**
 * 人读的形态标签。
 */
const ARTIFACT_LABEL = {
  shell: '终端脚本',
  exe: 'exe 安装包',
  apk: 'apk 安装包',
  aab: 'aab 上架包',
  html: 'html 静态站',
  binary: '可执行文件',
};

function renderStatus(f, asJson, id) {
  const entries = id
    ? [entrypoints.registry.getEntry(id, {})].filter(Boolean)
    : entrypoints.registry.listEntries({});

  if (id && entries.length === 0) {
    const ids = entrypoints.registry.listIds({});
    f.printError(
      `未知的端 ${id}：端矩阵里没有这个 id —— 现有端：${ids.join(' / ')}；` +
        '运行 khy entry status 查看全部'
    );
    return 1;
  }

  const rows = [];
  for (const entry of entries) {
    const detail = entrypoints.describe(entry.id, {});
    const artifact = detail.artifact;
    rows.push({
      id: entry.id,
      kind: entry.kind,
      label: ARTIFACT_LABEL[entry.artifactKind] || entry.artifactKind || '未声明',
      artifact,
      entryFiles: detail.entryFiles || [],
      declaredStatus: entry.status,
      statusNote: entry.statusNote,
    });
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        rows.map(r => ({
          id: r.id,
          kind: r.kind,
          artifactKind: r.label,
          status: r.artifact.status,
          registered: r.artifact.registered,
          exists: r.artifact.exists,
          presentAt: r.artifact.presentAt,
          candidates: r.artifact.candidates.map(c => ({ rel: c.rel, exists: c.exists })),
          rebuild: r.artifact.rebuild,
          reason: r.artifact.reason,
        })),
        null,
        2
      )
    );
    return 0;
  }

  for (const row of rows) {
    const a = row.artifact;
    const head = `端 ${row.id}：${row.label}`;

    // shell 类端的日常入口是**仓库里的文件**，不是构建产物。先报它——
    // 否则 `khy.bat` 明明在，却因为 pip wheel 没构建而显示「未产出」，误导人。
    if (row.entryFiles.length > 0) {
      const present = row.entryFiles.filter(e => e.exists).length;
      const line = row.entryFiles.map(e => `${e.rel}${e.exists ? '' : '（缺失）'}`).join(' / ');
      if (present === row.entryFiles.length) {
        f.printSuccess(`${head} —— 入口文件就绪 ${present}/${row.entryFiles.length}`);
      } else {
        f.printError(
          `${head} —— 入口文件缺失 ${row.entryFiles.length - present}/${row.entryFiles.length}`
        );
      }
      console.log(`    ${line}`);
    }

    const artifactHead = row.entryFiles.length > 0 ? `${head}（打包形态）` : head;

    if (!a.registered) {
      f.printWarn(`${artifactHead} —— 产物未登记`);
      console.log(`    ${a.reason}`);
    } else if (a.exists) {
      f.printSuccess(`${artifactHead} —— 已产出`);
      console.log(`    在：${a.presentAt}`);
      console.log(
        `    产物登记：docs/10_规范/registry/BUILD-OUTPUTS.json → "${a.id}"（状态 ${a.status || '未标'}）`
      );
    } else {
      f.printWarn(`${artifactHead} —— 未产出`);
      for (const candidate of a.candidates) {
        console.log(`    应为：${candidate.rel}${candidate.exists ? '' : '（磁盘上没有）'}`);
      }
      console.log(
        `    产物登记：docs/10_规范/registry/BUILD-OUTPUTS.json → "${a.id}"（状态 ${a.status || '未标'}）`
      );
      if (a.rebuild) console.log(`    得到它：${a.rebuild}`);
    }

    // 「产物在」不等于「能重新产出」。broken 端的 release/ 里躺着历史包，
    // 只报「已产出」会让人以为它可用——定档非 ready 时把理由一并摆出来。
    if (row.declaredStatus && row.declaredStatus !== 'ready') {
      const label = STATUS_LABEL[row.declaredStatus] || row.declaredStatus;
      console.log(`    ⚠ 本端定档：${label} —— ${row.statusNote || '（无说明）'}`);
    }
  }

  const produced = rows.filter(r => r.artifact.exists).length;
  const unregistered = rows.filter(r => !r.artifact.registered).length;
  f.printInfo(
    `产物盘点 ${rows.length} 个端：已产出 ${produced} / 未产出 ${rows.length - produced - unregistered}` +
      (unregistered > 0 ? ` / 未登记 ${unregistered}` : ''),
    '入口'
  );
  if (produced < rows.length) {
    console.log(
      '  说明：产物按 LAYOUT-005 一律落 _build/ 之下，不进源码树；' +
        'entries/ 是索引，不是产物存放处。'
    );
  }
  return 0;
}

// ── probe ─────────────────────────────────────────────────────────

function renderProbe(f, asJson, id) {
  const results = id ? [entrypoints.probeOne(id)].filter(Boolean) : entrypoints.probeAll();

  if (id && results.length === 0) {
    const ids = entrypoints.registry.listIds();
    f.printError(`未知的端 ${id}：端矩阵里没有这个 id —— 现有端：${ids.join(' / ')}`);
    return 1;
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return results.some(r => r.status === 'broken') ? 1 : 0;
  }

  for (const result of results) {
    for (const line of result.lines) console.log(line);
    const label = STATUS_LABEL[result.status] || result.status;
    const failed = result.checks.filter(c => !c.ok).length;
    if (result.status === 'ready') {
      f.printSuccess(`端 ${result.id}：就绪 —— ${result.checks.length}/${result.checks.length} 项检查通过`);
    } else {
      const msg = `端 ${result.id}：${label} —— ${failed}/${result.checks.length} 项未通过`;
      if (result.status === 'broken') f.printError(msg);
      else f.printWarn(msg);
      for (const check of result.checks.filter(c => !c.ok)) {
        console.log(`    · ${check.detail}`);
      }
    }
    if (result.drift) {
      f.printWarn(`端 ${result.id} 定档漂移：${result.drift}`);
    }
    if (result.machine && !result.machine.ok) {
      f.printWarn(`端 ${result.id} 本机不可用：${result.machine.detail}`);
    }
  }

  const broken = results.filter(r => r.status === 'broken').length;
  const degraded = results.filter(r => r.status === 'degraded').length;
  f.printInfo(
    `检活完成 ${results.length} 个端：就绪 ${results.length - broken - degraded} / 降级 ${degraded} / 损坏 ${broken}`,
    '入口'
  );
  return broken > 0 ? 1 : 0;
}

// ── launch / build ────────────────────────────────────────────────

async function runAction(f, action, id, flags, extraArgs = []) {
  if (!id) {
    f.printError(
      `缺少端 id：khy entry ${action} <id> —— 运行 khy entry list 查看可选端`
    );
    return 1;
  }

  const dryRun = isOn(flags.options['dry-run']);
  const options = { dryRun, extraArgs };

  const detail = entrypoints.describe(id, options);
  if (!detail) {
    const ids = entrypoints.registry.listIds();
    f.printError(
      `未知的端 ${id}：端矩阵里没有这个 id —— 现有端：${ids.join(' / ')}`
    );
    return 1;
  }

  const plan = action === 'launch' ? detail.launch : detail.build;
  const unavailable =
    action === 'launch' ? detail.launchUnavailableReason : detail.buildUnavailableReason;

  if (!plan) {
    f.printError(
      `端 ${id} 无法${action === 'launch' ? '启动' : '构建'}：${unavailable} —— ` +
        '修正 entrypoints.json 的对应字段，或改用其他端'
    );
    return 1;
  }

  const verb = action === 'launch' ? '启动' : '构建';
  const command = entrypoints.launcher.formatPlan(plan);

  if (dryRun) {
    f.printInfo(`端 ${id} ${verb}计划（dry-run 未执行）：${command}`, '入口');
    console.log(`  cwd：${plan.cwd}`);
    console.log(`  模式：${plan.mode}（attach 前台接管 / wait 前台等待 / detach 后台不等待）`);
    return 0;
  }

  f.printInfo(
    `端 ${id} ${verb}：${command}（模式 ${plan.mode}，cwd ${plan.cwd}）`,
    '入口'
  );

  const result = await entrypoints[action](id, options);
  if (!result.ok) {
    f.printError(`端 ${id} ${verb}失败：${result.error}`);
    return 1;
  }

  if (plan.mode === 'detach') {
    f.printSuccess(`端 ${id} 已转入后台运行（PID ${result.pid}），本命令不等待其退出`);
    return 0;
  }
  f.printSuccess(
    `端 ${id} ${verb}完成：进程退出码 ${result.exitCode === undefined ? '未知' : result.exitCode}`
  );
  return result.exitCode === 0 ? 0 : 1;
}

// ── 入口 ──────────────────────────────────────────────────────────

async function handleEntrypoints(parsed = {}) {
  const f = fmt();
  // entry 不在 router.js 的 SUB_COMMANDS 静态表里，所以 parsed.subCommand 恒为 null，
  // 子命令要从位置参数里取。
  const flags = readArguments(parsed);
  const sub = parsed.subCommand || flags.positionals[0] || 'list';
  const asJson = isOn(flags.options.json);

  // args 里通常第一个 token 就是子命令本身（khy entry info desktop），
  // 但 `khy entry desktop` 这种省略写法下它不在。统一按「剔掉子命令 token」
  // 归一，剩下的第一个 positional 才是端 id，其余是透传给端的附加参数。
  const positionalArgs =
    flags.positionals[0] === sub ? flags.positionals.slice(1) : flags.positionals;
  const id = positionalArgs[0] || null;

  switch (sub) {
    case 'list':
    case 'ls': {
      const filters = {};
      if (flags.options.kind) filters.kind = String(flags.options.kind);
      if (flags.options.status) filters.status = String(flags.options.status);
      return renderList(f, asJson, filters);
    }
    case 'info':
    case 'show':
      return renderInfo(f, asJson, id);
    case 'status':
    case 'artifacts':
      return renderStatus(f, asJson, id);
    case 'probe':
    case 'doctor':
      return renderProbe(f, asJson, id);
    case 'launch':
    case 'start':
      return runAction(f, 'launch', id, flags, positionalArgs.slice(1));
    case 'build':
      return runAction(f, 'build', id, flags, positionalArgs.slice(1));
    default:
      f.printError(
        `未知子命令 ${sub}：支持 list / info / probe / launch / build —— ` +
          '运行 khy entry list 查看全部端，khy entry info <id> 查看单个端'
      );
      return 1;
  }
}

module.exports = {
  handleEntrypoints,
  parseFlags,
  readArguments,
  isOn,
  [MANIFEST_EXPORT_KEY]: {
    name: 'entry',
    aliases: ['entries', 'duan', '多端'],
    description:
      'Khy 多端入口矩阵：列出/盘点产物/探测/启动/构建 终端·桌面·移动·网页 四类端',
    usage:
      'entry <list|status|info|probe|launch|build> [id] [--kind=] [--status=] [--dry-run] [--json]',
    subCommands: ['list', 'status', 'info', 'probe', 'launch', 'build'],
    category: 'system',
    handler: handleEntrypoints,
  },
};
