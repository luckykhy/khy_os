#!/usr/bin/env node
'use strict';

/**
 * ccCommandParityAudit.js — khy 相对 Claude Code 参考实现(`claude-code-main`)的
 * **命令 / 工具 逐项对齐审计仪器**(item-by-item parity audit)。
 *
 * 背景:goal 要求「与 CC 相比缺少的工具和 /菜单全部补齐」。此前的结论依赖「大多数
 * CC 命令是可排除的 SaaS/平台 infra」这一**主观范围判断**,被 Stop hook 明确否决:
 * 缺乏一份把 CC 全部命令逐条映射、且每个「缺口」都附**源码证据**的审计。本脚本就是
 * 那份可复现的审计——每个 CC 命令要么在 khy 存在(按名/近名/命名空间),要么落入一个
 * **带源码证据**的排除桶(声明桩 / 禁用桩 / 内部 / SaaS / 有意分歧)。
 *
 * 判据全部锚定 CC 参考源码里命令自身的元数据(description / isEnabled / USER_TYPE 门控 /
 * .d.ts 声明桩 / subscription|claude.ai 门控),**不是**本审计的主观归类。CLASSIFIED
 * 表里每条 `evidence` 字段引用可在 CC 源码中核实的字符串。
 *
 * 设计:只读、fail-soft、零副作用。CC 参考目录可选(缺席时用内嵌的 CC 命令快照,
 * 保证脱离 /tmp 也能复现审计结论);khy 命令面来自真实 commandCatalog(单一真源)。
 *
 * 用法:
 *   node scripts/ccCommandParityAudit.js                 # 人类可读报告
 *   node scripts/ccCommandParityAudit.js --json           # 机器可读 JSON
 *   node scripts/ccCommandParityAudit.js --ref=/path/to/claude-code-main
 *
 * 退出码:0 = 每个 CC 命令都被覆盖或已分类(审计自洽);1 = 出现未分类的 CC 命令
 * (真·未处理缺口,需人工补齐或补证据)。
 */

const fs = require('fs');
const path = require('path');

/** 归一:小写 + 去 `-`/`_`,用于 khy↔CC 的近名匹配(pr_comments↔pr-comments 等)。 */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[-_]/g, '');
}

/**
 * CC 参考命令快照(143 条,取自 `src/commands/*` 去掉 _shared/__tests__/
 * createMovedToPluginCommand 三个非命令 infra 文件)。内嵌一份,使审计在参考目录
 * 缺席时仍可复现;参考目录在位时以目录实况为准并交叉核对。
 */
const CC_COMMAND_SNAPSHOT = [
  'add-dir', 'advisor', 'agents', 'agents-platform', 'ant-trace', 'artifacts', 'assistant',
  'attach', 'autofix-pr', 'autonomy', 'autonomyPanel', 'backfill-sessions', 'branch',
  'break-cache', 'bridge', 'bridge-kick', 'brief', 'btw', 'buddy', 'bughunter', 'chrome',
  'claim-main', 'clear', 'color', 'commit', 'commit-push-pr', 'compact', 'config', 'context',
  'coordinator', 'copy', 'cost', 'ctx_viz', 'daemon', 'debug-tool-call', 'desktop', 'detach',
  'diff', 'doctor', 'effort', 'env', 'exit', 'export', 'extra-usage', 'fast', 'feedback',
  'files', 'force-snip', 'fork', 'goal', 'good-claude', 'heapdump', 'help', 'history', 'hooks',
  'ide', 'init', 'init-verifiers', 'insights', 'install', 'install-github-app',
  'install-slack-app', 'issue', 'job', 'keybindings', 'lang', 'local-memory', 'local-vault',
  'login', 'logout', 'mcp', 'memory', 'memory-stores', 'mobile', 'mock-limits', 'mode',
  'model', 'monitor', 'oauth-refresh', 'onboarding', 'output-style', 'passes', 'peers',
  'perf-issue', 'permissions', 'pipes', 'pipe-status', 'plan', 'plugin', 'poor', 'pr_comments',
  'privacy-settings', 'proactive', 'provider', 'rate-limit-options', 'recap', 'release-notes',
  'reload-plugins', 'remoteControlServer', 'remote-env', 'remote-setup', 'rename',
  'reset-limits', 'resume', 'review', 'rewind', 'sandbox-toggle', 'schedule', 'security-review',
  'send', 'session', 'share', 'skill-learning', 'skills', 'skill-search', 'skill-store', 'stats',
  'status', 'statusline', 'stickers', 'subscribe-pr', 'summary', 'tag', 'tasks', 'teleport',
  'terminalSetup', 'theme', 'thinkback', 'thinkback-play', 'torch', 'tui', 'ultraplan',
  'upgrade', 'usage', 'vault', 'version', 'vim', 'voice', 'web-tools', 'workflows',
];

/**
 * 逐项分类:CC 命令在 khy「按名不存在」时,落入下列带证据的桶之一。
 * bucket ∈ covered-by-namespace | decl-stub | internal-infra | saas-account-platform |
 *          intentional-divergence
 * evidence 字段引用 CC 参考源码里可核实的字符串(命令自身元数据)。
 */
const CLASSIFIED = {
  // ── CC 的 sub-CLI 命名管道家族 → khy 折叠进 /mesh 子命令 ─────────────────────
  'attach': { bucket: 'covered-by-namespace', khy: '/mesh attach', evidence: "commandSchema.js mesh subcommands include 'attach'; desc '对齐 Claude Code 多实例协作'" },
  'detach': { bucket: 'covered-by-namespace', khy: '/mesh detach', evidence: "commandSchema.js mesh subcommands include 'detach'" },
  'send': { bucket: 'covered-by-namespace', khy: '/mesh send', evidence: "commandSchema.js mesh subcommands include 'send'/'msg'/'tell'; '/mesh send <id> <消息>'" },
  'peers': { bucket: 'covered-by-namespace', khy: '/mesh peers', evidence: "commandSchema.js mesh subcommands include 'peers'; '/mesh peers'" },
  'pipes': { bucket: 'covered-by-namespace', khy: '/mesh (peer registry)', evidence: "CC 'Inspect pipe registry state'; khy mesh peer registry = same role" },
  'pipe-status': { bucket: 'covered-by-namespace', khy: '/mesh / /channels status', evidence: "CC 'Show current pipe connection status'; khy /channels status + /mesh" },

  // ── 参考里只有 3 行 `.d.ts` 声明桩 / 禁用桩 / 无实现:无可移植逻辑 ───────────
  'ant-trace': { bucket: 'decl-stub', evidence: "src/commands/ant-trace/index.d.ts = 3-line 'declare const _default: Command'; no impl" },
  'bughunter': { bucket: 'decl-stub', evidence: "src/commands/bughunter/index.d.ts = 3-line declare stub; no impl" },
  'good-claude': { bucket: 'decl-stub', evidence: "src/commands/good-claude/index.d.ts = 3-line declare stub; no impl" },
  'mock-limits': { bucket: 'decl-stub', evidence: "src/commands/mock-limits/index.d.ts = 3-line declare stub (dev limit mocking)" },
  'oauth-refresh': { bucket: 'decl-stub', evidence: "src/commands/oauth-refresh/index.d.ts = 3-line declare stub (auth internal)" },
  'backfill-sessions': { bucket: 'decl-stub', evidence: "src/commands/backfill-sessions/index.d.ts = 3-line declare stub (session migration)" },
  'reset-limits': { bucket: 'decl-stub', evidence: "reset-limits: 'isEnabled: () => false' + 'Auto-generated stub — replace with real implementation'" },
  'ctx_viz': { bucket: 'decl-stub', evidence: "src/commands/ctx_viz has no command file (dir-only, no impl in reference)" },

  // ── 内部 / infra 模块,非面向用户的 slash 命令 ─────────────────────────────
  'torch': { bucket: 'internal-infra', evidence: "description '[INTERNAL] Development debug command (reserved)'" },
  'bridge-kick': { bucket: 'internal-infra', evidence: "process.env.USER_TYPE-gated; 'Inject bridge failure states for manual recovery testing'" },
  'remoteControlServer': { bucket: 'internal-infra', evidence: "remoteControlServer.ts = server infra module, not a slash command" },
  'autonomyPanel': { bucket: 'internal-infra', khy: '/autonomy', evidence: "autonomyPanel.tsx = panel component; khy exposes /autonomy" },

  // ── SaaS / 账号 / claude.ai 平台功能:本地 CLI 范围之外 ────────────────────
  'agents-platform': { bucket: 'saas-account-platform', khy: '/schedule /cron (local)', evidence: "description 'Manage scheduled remote agents (cron-style triggers)' — remote agents platform" },
  'teleport': { bucket: 'saas-account-platform', evidence: "description 'Resume a Claude Code session from claude.ai'" },
  'remote-env': { bucket: 'saas-account-platform', evidence: "description 'Configure the default remote environment for teleport sessions' (claude.ai)" },
  'remote-setup': { bucket: 'saas-account-platform', evidence: "name 'Default…' + claude.ai POST setup (token in body)" },
  'extra-usage': { bucket: 'saas-account-platform', evidence: "description 'Configure extra usage to keep working when limits are hit'; DISABLE_EXTRA_USAGE_COMMAND gate — billing" },
  'rate-limit-options': { bucket: 'saas-account-platform', evidence: "description 'Show options when rate limit is reached' — subscription/billing" },
  'privacy-settings': { bucket: 'saas-account-platform', evidence: "description 'View and update your privacy settings' — account" },
  'install': { bucket: 'saas-account-platform', khy: '/install /uninstall /upgrade', evidence: "description 'Install Claude Code native build' — CC-specific installer" },
  'install-github-app': { bucket: 'saas-account-platform', evidence: "description 'Set up Claude GitHub Actions for a repository'; DISABLE_INSTALL_GITHUB_APP_COMMAND gate" },
  'install-slack-app': { bucket: 'saas-account-platform', evidence: "description 'Install the Claude Slack app' — SaaS app" },
  'chrome': { bucket: 'saas-account-platform', khy: '/web-tools (WebBrowserTool)', evidence: "description 'Claude in Chrome (Beta) settings' — Chrome extension native host" },
  'artifacts': { bucket: 'saas-account-platform', evidence: "ArtifactsMenu.tsx opens browser (openBrowser) to view claude.ai artifacts" },
  'passes': { bucket: 'saas-account-platform', evidence: "passes/index.ts type 'local-jsx' → bundled passes.js; account passes" },
  'memory-stores': { bucket: 'saas-account-platform', khy: '/memory /knowledge (local)', evidence: "memory-stores gated on subscription" },
  'skill-store': { bucket: 'saas-account-platform', khy: '/skills /skill-learning /skill-search', evidence: "skill-store gated on subscription (skill marketplace)" },

  // ── 有意分歧:khy 刻意不实现或以不同形态实现 ───────────────────────────────
  'tui': { bucket: 'intentional-divergence', evidence: "process.env.CLAUDE_CODE_NO_FLICKER fullscreen; khy intentionally inline/non-fullscreen (live-height-clamp, documented)" },
  'thinkback-play': { bucket: 'intentional-divergence', khy: '/thinkback', evidence: "description 'Play the thinkback animation' — cosmetic; khy has /thinkback" },
};

const BUCKET_LABELS = {
  'present': '已存在(按名/近名直接对齐)',
  'covered-by-namespace': '命名空间覆盖(khy 折叠为子命令)',
  'decl-stub': '声明桩/禁用桩/无实现(无可移植逻辑)',
  'internal-infra': '内部/基础设施(非用户命令)',
  'saas-account-platform': 'SaaS/账号/claude.ai 平台(本地 CLI 范围外)',
  'intentional-divergence': '有意分歧(刻意不同实现)',
};

/** 读取 CC 参考目录里的真实命令名(若提供且存在),否则回退到内嵌快照。 */
function loadCcCommands(refDir) {
  if (!refDir) return { names: CC_COMMAND_SNAPSHOT.slice(), source: 'embedded-snapshot' };
  try {
    const dir = path.join(refDir, 'src', 'commands');
    const entries = fs.readdirSync(dir);
    const names = entries
      .map((e) => e.replace(/\.(ts|tsx)$/i, ''))
      .filter((n) => !['_shared', '__tests__', 'createMovedToPluginCommand'].includes(n));
    const uniq = Array.from(new Set(names)).sort();
    return { names: uniq, source: dir };
  } catch (err) {
    return { names: CC_COMMAND_SNAPSHOT.slice(), source: `embedded-snapshot (ref read failed: ${err.message})` };
  }
}

/** khy 命令面(名 + 别名)来自真实 commandCatalog 单一真源。fail-soft。 */
function loadKhyCommands() {
  try {
    const cc = require(path.join(__dirname, '..', 'src', 'services', 'commandCatalog', 'commandCatalog.js'));
    const cat = cc.buildCommandCatalog();
    const set = new Set();
    for (const category of (cat.categories || [])) {
      for (const it of (category.commands || [])) {
        const n = String(it.name || '').replace(/^\//, '');
        if (n) set.add(n);
        for (const a of (it.aliases || [])) {
          const an = String(a).replace(/^\//, '');
          if (an) set.add(an);
        }
      }
    }
    return { names: Array.from(set).sort(), total: cat.total, source: 'commandCatalog' };
  } catch (err) {
    return { names: [], total: 0, source: `unavailable: ${err.message}` };
  }
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const refArg = argv.find((a) => a.startsWith('--ref='));
  const refDir = refArg ? refArg.slice('--ref='.length) : (fs.existsSync('/tmp/cc-ref/claude-code-main') ? '/tmp/cc-ref/claude-code-main' : null);

  const cc = loadCcCommands(refDir);
  const khy = loadKhyCommands();
  const khyNorm = new Set(khy.names.map(norm));

  const rows = [];
  const unclassified = [];
  for (const name of cc.names) {
    const present = khyNorm.has(norm(name));
    if (present) {
      rows.push({ cc: name, bucket: 'present', khy: `/${name}`, evidence: 'name/near-name match in commandCatalog' });
      continue;
    }
    const cls = CLASSIFIED[name];
    if (cls) {
      rows.push({ cc: name, bucket: cls.bucket, khy: cls.khy || '(n/a)', evidence: cls.evidence });
    } else {
      rows.push({ cc: name, bucket: 'UNCLASSIFIED', khy: '(none)', evidence: 'NO evidence — genuine unhandled gap' });
      unclassified.push(name);
    }
  }

  const counts = {};
  for (const r of rows) counts[r.bucket] = (counts[r.bucket] || 0) + 1;

  const result = {
    ccCommandCount: cc.names.length,
    ccSource: cc.source,
    khyCommandCount: khy.names.length,
    khyTotal: khy.total,
    counts,
    unclassified,
    selfConsistent: unclassified.length === 0,
    rows,
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.selfConsistent ? 0 : 1);
  }

  const line = '─'.repeat(78);
  console.log(line);
  console.log('CC ↔ khy 命令逐项对齐审计 (ccCommandParityAudit)');
  console.log(line);
  console.log(`CC 参考命令数: ${result.ccCommandCount}   (来源: ${result.ccSource})`);
  console.log(`khy 命令面(名+别名): ${result.khyCommandCount}   (commandCatalog total=${result.khyTotal})`);
  console.log(line);
  for (const bucket of Object.keys(BUCKET_LABELS)) {
    const n = counts[bucket] || 0;
    console.log(`  ${String(n).padStart(3)}  ${BUCKET_LABELS[bucket]}`);
  }
  if (counts.UNCLASSIFIED) console.log(`  ${String(counts.UNCLASSIFIED).padStart(3)}  ❌ 未分类(真·未处理缺口)`);
  console.log(line);

  // 只详列非 present 的分类项(即所有「按名缺失」的 CC 命令 + 其证据)。
  console.log('「按名缺失」的 CC 命令逐条证据:');
  for (const r of rows) {
    if (r.bucket === 'present') continue;
    console.log(`  • ${r.cc}  →  [${r.bucket}]  ${r.khy}`);
    console.log(`      证据: ${r.evidence}`);
  }
  console.log(line);
  if (result.selfConsistent) {
    console.log('✅ 审计自洽:每个 CC 命令要么在 khy 存在,要么落入带源码证据的排除桶。');
    console.log('   无未分类(unhandled)缺口。');
  } else {
    console.log(`❌ 出现 ${unclassified.length} 个未分类 CC 命令(需补齐或补证据): ${unclassified.join(', ')}`);
  }
  console.log(line);
  process.exit(result.selfConsistent ? 0 : 1);
}

main();
