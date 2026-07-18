'use strict';

/**
 * Slash-command cluster dispatch (extracted from cli/router.js route()).
 *
 * Owns the contiguous run of interactive slash-shortcut case bodies (model / config / lang /
 * context / diff / effort / env / export / files / hooks / mcp / statusline / share / stats /
 * status / summary / tasks / theme / branch / debug / stickers …). The case bodies are relocated
 * verbatim (byte-identical) into this sibling leaf; because the leaf lives in the same directory as
 * router.js, every in-body relative require() resolves identically.
 *
 * route() pre-dispatches into dispatchSlashCommand before its main switch: a command that matches a
 * slash case is handled here and its result returned; every other command returns the
 * ROUTER_NOT_HANDLED sentinel so route() falls through to its own switch. Because a switch jumps
 * straight to the matching case, an exact-command pre-check is behavior-preserving.
 *
 * The moved bodies call route() recursively (e.g. /upgrade, /context, /branch re-dispatch to other
 * commands) — a back-reference to the host's route function that is injected via
 * setRouterDispatchSlashDeps to avoid a require cycle back into router.js. This leaf runs command
 * handlers that perform IO, so it does NOT self-declare as a pure zero-IO leaf.
 */

const path = require('path');

const ROUTER_NOT_HANDLED = Symbol('router_slash_not_handled');

// Host callback injected via DI (avoid a require cycle back into router.js). route() is a hoisted
// async function declaration in the host, so injecting it at host module-load time is TDZ-safe.
let route = null;
function setRouterDispatchSlashDeps(deps = {}) {
  if (typeof deps.route === 'function') route = deps.route;
}

async function dispatchSlashCommand(command, _ctx) {
  const {
    subCommand, args, options, rawCommandToken, parsed, context,
    printError, printHelp, printInfo, printTable, printSuccess, printWarn, withSpinner, chalk,
  } = _ctx;
  switch (command) {
      // ── Model (slash shortcut) ──
      case 'model': {
        const gw = require('./handlers/gateway');
        await gw.handleGatewaySelectModel(args, options);
        return true;
      }

      // ── Config (Hermes-style) ──
      case 'config': {
        const { handleConfig } = require('./handlers/config');
        await handleConfig(subCommand, args, options);
        return true;
      }

      // ── Language preference (/lang — aligns with Claude Code /lang) ──
      case 'lang': {
        const { handleLang } = require('./handlers/lang');
        await handleLang(subCommand, args, options);
        return true;
      }

      // ── Release notes (/release-notes — aligns with Claude Code /release-notes) ──
      case 'release-notes':
      case 'releasenotes': {
        const { handleReleaseNotes } = require('./handlers/releaseNotes');
        await handleReleaseNotes(subCommand, args, options);
        return true;
      }

      // ── Terminal setup (/terminal-setup — aligns with Claude Code terminalSetup) ──
      case 'terminal-setup':
      case 'terminalsetup': {
        const { handleTerminalSetup } = require('./handlers/terminalSetup');
        await handleTerminalSetup(subCommand, args, options);
        return true;
      }

      // ── Keybindings (/keybindings — aligns with Claude Code keybindings) ──
      case 'keybindings':
      case 'keys':
      case 'shortcuts': {
        const { handleKeybindings } = require('./handlers/keybindings');
        await handleKeybindings(subCommand, args, options);
        return true;
      }

      // ── Perf report (/perf-issue — aligns with Claude Code perf-issue) ──
      case 'perf-issue':
      case 'perfissue': {
        const { handlePerfIssue } = require('./handlers/perfIssue');
        await handlePerfIssue(subCommand, args, options);
        return true;
      }

      // ── Issue report (/issue — aligns with Claude Code /issue) ──
      case 'issue': {
        const { handleIssue } = require('./handlers/issue');
        await handleIssue(subCommand, args, options);
        return true;
      }

      // ── Feedback / bug report (/feedback · /bug — aligns with Claude Code /feedback) ──
      // 语义区别于 /issue:对 khy 工具本身提反馈,只落本地草稿并指向上游,绝不静默外发。
      case 'feedback':
      case 'bug': {
        const { handleFeedback } = require('./handlers/feedback');
        await handleFeedback(subCommand, args, options);
        return true;
      }

      // ── OS sandbox toggle (/sandbox-toggle — aligns with Claude Code sandbox-toggle) ──
      case 'sandbox-toggle':
      case 'sandboxtoggle': {
        const { handleSandboxToggle } = require('./handlers/sandboxToggle');
        await handleSandboxToggle(subCommand, args, options);
        return true;
      }

      // ── Init verifiers (/init-verifiers — aligns with Claude Code init-verifiers; prompt-type via aiForward) ──
      case 'init-verifiers':
      case 'initverifiers': {
        const { handleInitVerifiers } = require('./handlers/initVerifiers');
        return await handleInitVerifiers(subCommand, args, options);
      }

      // ── Fork session (/fork — aligns with Claude Code /fork; duplicate current conversation into an independent copy) ──
      case 'fork': {
        const { handleFork } = require('./handlers/fork');
        await handleFork(subCommand, args, options);
        return true;
      }

      // ── Session topology (/topology — learns from Stello: organize /fork branches into a navigable conversation web) ──
      case 'topology':
      case 'forest': {
        const { handleTopology } = require('./handlers/topology');
        await handleTopology(subCommand, args, options);
        return true;
      }

      // ── By the way (/btw — aligns with Claude Code by-the-way; queue a non-interrupting hint merged into the next turn) ──
      case 'btw': {
        const { handleBtw } = require('./handlers/btw');
        await handleBtw(subCommand, args, options);
        return true;
      }

      // ── Autonomy inspector (/autonomy — aligns with Claude Code /autonomy; read-only inspection of khy's autonomy surfaces + single-flow view/cancel/resume) ──
      case 'autonomy': {
        const { handleAutonomy } = require('./handlers/autonomy');
        await handleAutonomy(subCommand, args, options);
        return true;
      }

      // ── Proactive toggle (/proactive — aligns with Claude Code /proactive; toggle khy's autonomous idle-tick mode on|off|toggle|status) ──
      case 'proactive': {
        const { handleProactive } = require('./handlers/proactive');
        await handleProactive(subCommand, args, options);
        return true;
      }

      // ── Onboarding re-runner (/onboarding — aligns with Claude Code /onboarding; re-run first-run setup steps full|theme|trust|model|mcp|status) ──
      case 'onboarding': {
        const { handleOnboarding } = require('./handlers/onboarding');
        await handleOnboarding(subCommand, args, options);
        return true;
      }

      // ── Tool-call transcript viewer (/debug-tool-call — aligns with Claude Code /debug-tool-call; pairs the last N tool_use↔tool_result from the current session transcript) ──
      case 'debug-tool-call':
      case 'debugtoolcall': {
        const { handleDebugToolCall } = require('./handlers/debugToolCall');
        await handleDebugToolCall(subCommand, args, options);
        return true;
      }

      // ── Session recap (/recap — aligns with Claude Code /recap; deterministic recap of the current session via existing sessionRecapService) ──
      case 'recap': {
        const { handleRecap } = require('./handlers/recap');
        await handleRecap(subCommand, args, options);
        return true;
      }

      // ── Usage review (/thinkback — aligns with Claude Code /thinkback; khy-native deterministic period review over local usage data, no cloud/animation layer) ──
      case 'thinkback': {
        const { handleThinkback } = require('./handlers/thinkback');
        await handleThinkback(subCommand, args, options);
        return true;
      }

      // ── Copy assistant reply / code blocks to system clipboard (/copy — aligns with Claude Code /copy) ──
      case 'copy': {
        const { handleCopy } = require('./handlers/copy');
        await handleCopy(subCommand, args, options);
        return true;
      }

      // ── Rename current session title (/rename — aligns with Claude Code /rename) ──
      case 'rename': {
        const { handleRename } = require('./handlers/rename');
        await handleRename(subCommand, args, options);
        return true;
      }

      // ── Tag current session (/tag — aligns with Claude Code /tag; same tag again = remove) ──
      case 'tag': {
        const { handleTag } = require('./handlers/tag');
        await handleTag(subCommand, args, options);
        return true;
      }

      // ── V8 heap snapshot (/heapdump — aligns with Claude Code /heapdump; writes a .heapsnapshot for Chrome DevTools plus a memory-diagnostics JSON) ──
      case 'heapdump': {
        const { handleHeapdump } = require('./handlers/heapdump');
        await handleHeapdump(subCommand, args, options);
        return true;
      }

      // ── Prefix-cache break (/break-cache — aligns with Claude Code /break-cache; once/always/off/status, injects a nonce into the system-prompt prefix to bust the Anthropic prompt cache) ──
      case 'break-cache':
      case 'breakcache': {
        const { handleBreakCache } = require('./handlers/breakCache');
        await handleBreakCache(subCommand, args, options);
        return true;
      }

      // ── Per-session accent color (/color — aligns with Claude Code /color; set/list/reset the current session's display color, applied to the TUI input frame) ──
      case 'color': {
        const { handleColor } = require('./handlers/color');
        await handleColor(subCommand, args, options);
        return true;
      }

      // ── Model advisor (/advisor — aligns with Claude Code /advisor; recommend the best executable model from observed performance via gateway probe + UCB bandit) ──
      case 'advisor': {
        const { handleAdvisor } = require('./handlers/advisor');
        await handleAdvisor(subCommand, args, options);
        return true;
      }

      // ── Autofix CI (/autofix-pr — aligns with Claude Code /autofix-pr; read current-branch CI and locally run the audit→fix loop on failure, instead of cloud teleport) ──
      case 'autofix-pr':
      case 'autofixpr': {
        const { handleAutofixPr } = require('./handlers/autofixPr');
        await handleAutofixPr(subCommand, args, options);
        return true;
      }

      // ── Claim main (/claim-main — aligns with Claude Code /claim-main; claim the single "main" role across same-machine khy instances via a durable getDataDir pointer + PID liveness, instead of socket/pipe IPC) ──
      case 'claim-main':
      case 'claimmain': {
        const { handleClaimMain } = require('./handlers/claimMain');
        await handleClaimMain(subCommand, args, options);
        return true;
      }

      // ── IDE integration status (/ide — aligns with Claude Code /ide; report detected IDEs + the khy LAN bridge channel state, instead of faking an IDE-extension lock-file/WebSocket handshake) ──
      case 'ide': {
        const { handleIdeStatus } = require('./handlers/ideStatus');
        await handleIdeStatus(subCommand, args, options);
        return true;
      }

      // ── Subscribe PR CI (/subscribe-pr — aligns with Claude Code /subscribe-pr; locally persist a PR/branch subscription, poll CI on explicit check, notify via the existing push channel on a changed terminal state, instead of cloud OAuth push) ──
      case 'subscribe-pr':
      case 'subscribepr': {
        const { handleSubscribePr } = require('./handlers/subscribePr');
        await handleSubscribePr(subCommand, args, options);
        return true;
      }

      // ── PR comments (/pr-comments — aligns with Claude Code /pr_comments; fetch a
      //    GitHub PR's discussion/review/inline comments into the session via gh,
      //    read-only, GitHub-only) ──
      case 'pr-comments':
      case 'prcomments': {
        const { handlePrComments } = require('./handlers/prComments');
        return await handlePrComments(subCommand, args, options);
      }

      // ── Web tools config (/web-tools — aligns with Claude Code /web-tools; surface
      //    the active web-search backend (Kiro MCP) + runtime dynamic engines
      //    (search_engines.json / KHY_SEARCH_EXTRA_ENGINES), read-only) ──
      case 'web-tools':
      case 'webtools': {
        const { handleWebTools } = require('./handlers/webTools');
        return await handleWebTools(subCommand, args, options);
      }

      // ── Claude Code aligned commands ──
      case 'upgrade': {
        return route({
          ...parsed,
          command: 'update',
          subCommand: null,
        }, context);
      }

      case 'compact': {
        const ai = require('./ai');
        // `/compact <instructions>` —— 把用户打的自由文本作为摘要聚焦指令喂给
        // compactHistory 早已存在的 focus 槽(ai.js:1650 options.instructions →
        // :1739 "Focus priority: …")。今日此参数在此被丢弃(硬编码 {mode:'auto'})。
        // 纯叶子 buildCompactOptions 决定 options:门控关/无参数 → {mode:'auto'}
        // (逐字节回退今日);有参数 → {mode:'auto', instructions:<文本>}。fail-soft。
        let compactOptions = { mode: 'auto' };
        try {
          compactOptions = require('./compactInstructions')
            .buildCompactOptions({ subCommand, args }, process.env);
        } catch (_) { /* fail-soft:回退硬编码 auto */ }
        const compactResult = typeof ai.compactConversation === 'function'
          ? ai.compactConversation(compactOptions)
          : null;
        if (!compactResult || compactResult.success === false) {
          printError('会话压缩失败');
          return true;
        }
        if (compactResult.changed === false) {
          printInfo(`无需压缩：当前消息 ${compactResult.previousCount}`);
          return true;
        }
        // 成功行追加 auto 决定的压缩强度 + 折叠条数(结果对象早已算出却从不呈现)。
        // 纯叶子 buildCompactSuccessLine:门控关/缺字段 → 逐字节回退 legacy 串。
        let _compactLine = `会话已压缩：${compactResult.previousCount} -> ${compactResult.nextCount}`;
        try {
          _compactLine = require('./compactResultSummary')
            .buildCompactSuccessLine(compactResult, process.env);
        } catch (_) { /* fail-soft:回退 legacy 串 */ }
        printSuccess(_compactLine);
        return true;
      }

      // Manual context trim — user-driven counterpart to /compact (CC's Snip).
      //   /snip          → drop the most recent turn
      //   /snip 3        → drop the last 3 messages
      //   /snip 2-5      → drop messages 2..5 (1-based, inclusive)
      case 'snip': {
        const ai = require('./ai');
        if (typeof ai.snipConversation !== 'function') {
          printError('snip 不可用');
          return true;
        }
        const arg = String(args[0] || subCommand || '').trim();
        let opts = {};
        if (/^\d+-\d+$/.test(arg)) {
          const [a, b] = arg.split('-').map((n) => parseInt(n, 10));
          opts = { range: [a, b] };
        } else if (/^\d+$/.test(arg)) {
          opts = { count: parseInt(arg, 10) };
        }
        const snipResult = ai.snipConversation(opts);
        if (!snipResult || snipResult.success === false) {
          printError(snipResult?.error || 'snip 失败');
          return true;
        }
        if (snipResult.changed === false) {
          printInfo(`无可裁剪内容：当前消息 ${snipResult.previousCount}`);
          return true;
        }
        printSuccess(`已裁剪 ${snipResult.removedCount} 条消息：${snipResult.previousCount} -> ${snipResult.nextCount}`);
        return true;
      }

      case 'context': {
        const hud = require('./hudRenderer');
        const state = hud.getState();
        // 占用率/余量/健康分级计算收敛到纯叶子 SSOT(与 CtxInspectTool 同源,不再各处自写 round 公式)。
        const { computeContextStats } = require('../services/context/ctxWindowStats');
        const stats = computeContextStats({
          used: state?.contextWindow?.used,
          limit: state?.contextWindow?.limit,
          sessionInput: state?.sessionTokens?.input,
          sessionOutput: state?.sessionTokens?.output,
          requestCount: state?.requestCount,
          // model 透传:hudState.lastModel 一直在手却从不传入(输入侧半接线),
          // 导致 computeContextStats 的 model 字段恒为 ''。此处补接,供详情行显示。
          model: state?.lastModel,
        }, process.env);
        const statusColor = stats.status === 'critical' ? chalk.red
          : stats.status === 'warning' ? chalk.yellow : chalk.green;
        // token 数字走 ccFormatTokensOr SSOT(对齐 CC formatTokens:紧凑记数、
        // >10k 不钉 ".0"、百万级进 "m")。门控关 → 各 call-site 自己的 .toFixed
        // 历史规则逐字节回退。仅 token 图(k 后缀),不碰时长(s 后缀)。
        const { ccFormatTokensOr: _tk } = require('./ccFormat');
        const tk1 = (n) => _tk(n, `${(n / 1000).toFixed(1)}k`, process.env);
        const tk0 = (n) => _tk(n, `${(n / 1000).toFixed(0)}k`, process.env);
        // 交互中文面对齐:TUI 走本 route() 路径 /context,此前印**英文**标签(Context Window /
        // Used / Remaining / Session),而 REPL 键入 /context 孪生(repl.js:4930)印**中文**
        // (上下文窗口 / 已使用 / 剩余 / 会话令牌)——同一命令、同一 computeContextStats SSOT,
        // 却因标签语言分叉给出两套体验(承「菜单孪生 vs router-path drift」家族)。TUI 只见这条
        // 英文路径(REPL 在 route() 之前就拦了 /context),故用户眼中「TUI 的 /context 不如经典模式」。
        // 门控 KHY_CONTEXT_ZH_LABELS 默认开 → 中文标签与 REPL 孪生逐字对齐(健康分级词同源:
        // 接近上限/偏高/健康);关 → 逐字节回退英文标签。数值/颜色/详情行一律不变。
        const _ctxOff = ['0', 'false', 'off', 'no', 'disable', 'disabled'];
        const _ctxZh = !_ctxOff.includes(
          String(process.env.KHY_CONTEXT_ZH_LABELS || '').trim().toLowerCase()
        );
        if (_ctxZh) {
          const _statusZh = stats.status === 'critical' ? '接近上限'
            : stats.status === 'warning' ? '偏高' : '健康';
          console.log(chalk.bold('\n  上下文窗口'));
          console.log(`    已使用: ${tk1(stats.used)} / ${tk0(stats.limit)} 令牌 (${stats.percentUsed}%) ${statusColor(_statusZh)}`);
          console.log(`    剩余: ${tk1(stats.remaining)} 令牌`);
          console.log(`    会话令牌: ↑${tk1(stats.sessionInput)} ↓${tk1(stats.sessionOutput)}`);
        } else {
          console.log(chalk.bold('\n  Context Window:'));
          console.log(`    Used: ${tk1(stats.used)} / ${tk0(stats.limit)} tokens (${stats.percentUsed}%) ${statusColor(stats.status)}`);
          console.log(`    Remaining: ${tk1(stats.remaining)} tokens`);
          console.log(`    Session: ↑${tk1(stats.sessionInput)} ↓${tk1(stats.sessionOutput)}`);
        }
        // 详情行(Model / Requests / 上限来源诚实标注)——computeContextStats 早已算出
        // requestCount/limitSource/model(JSDoc 均标「透传展示」)却从不呈现。纯叶子
        // buildContextDetailLines:门控关 → [] 逐字节回退(不追加任何行)。
        try {
          const _detail = require('./contextPanelDetail')
            .buildContextDetailLines(stats, process.env);
          for (const _l of _detail) console.log(chalk.dim(`    ${_l}`));
        } catch (_) { /* fail-soft:略过详情行 */ }
        console.log('');
        return true;
      }

      case 'diff': {
        try {
          const { execFileSync } = require('child_process');
          // --no-index 在有差异时退出码为 1(execFileSync 抛),diff 文本在 e.stdout,须捕获。
          const runGit = (args) => {
            try { return { stdout: execFileSync('git', args, { encoding: 'utf-8', timeout: 8000, maxBuffer: 1 << 24 }) }; }
            catch (e) { return { stdout: (e && e.stdout) ? String(e.stdout) : '' }; }
          };
          const diff = require('./gitDiffCollect').collectWorkingTreeDiff(runGit, process.env).trim();
          if (!diff) {
            printInfo('没有未提交改动');
            return true;
          }
          // 统一 diff 文本按行首 +/-/@@ 着色:新增绿、删除红、头部/上下文 dim。
          // 不可用 renderSideBySideDiff(它把整份 diff 当 oldContent 再做 LCS → 全红且丢弃返回值)。
          console.log(require('./diffRenderer').renderDiff(diff));
        } catch (err) {
          printError(`Diff 失败: ${err.message}`);
        }
        return true;
      }

      case 'effort': {
        const ai = require('./ai');
        if (!args[0]) {
          const current = typeof ai.getEffort === 'function' ? ai.getEffort() : 'unknown';
          printInfo(`当前精度: ${current}`);
          printInfo('用法: effort <low|medium|high|max>');
          return true;
        }
        const next = String(args[0]).toLowerCase();
        if (typeof ai.setEffort !== 'function' || !ai.setEffort(next)) {
          printError('无效精度，支持: low / medium / high / max');
          return true;
        }
        const presets = typeof ai.getEffortPresets === 'function' ? ai.getEffortPresets() : {};
        const preset = presets[next];
        if (preset) {
          printSuccess(`模型精度已切换: ${next} (${preset.label}) — temp=${preset.temperature}, maxTokens=${preset.maxTokens}`);
        } else {
          printSuccess(`模型精度已切换: ${next}`);
        }
        return true;
      }

      case 'env': {
        console.log(chalk.bold('\n  Environment:'));
        console.log(`    Platform: ${process.platform} ${process.arch}`);
        console.log(`    Node: ${process.version}`);
        console.log(`    CWD: ${process.cwd()}`);
        console.log(`    Shell: ${process.env.SHELL || 'N/A'}`);
        try {
          const { execSync } = require('child_process');
          const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', timeout: 2000 }).trim();
          console.log(`    Git branch: ${branch}`);
        } catch { /* non-git directory */ }
        console.log('');
        return true;
      }

      case 'export': {
        const fs = require('fs');
        const ai = require('./ai');
        const conversation = typeof ai.getConversation === 'function' ? ai.getConversation() : [];
        const outputPath = path.resolve(
          String(options.out || options.output || args[0] || `khy-session-${Date.now()}.json`)
        );
        fs.writeFileSync(outputPath, JSON.stringify(conversation, null, 2), 'utf-8');
        printSuccess(`会话已导出: ${outputPath}`);
        return true;
      }

      case 'fast': {
        printInfo('fast 模式是 REPL 会话级开关，请在交互模式运行 /fast');
        return true;
      }

      case 'files': {
        try {
          const { execSync } = require('child_process');
          const limitRaw = Number.parseInt(String(args[0] || '30'), 10);
          const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 30;
          const files = execSync('git ls-files', { encoding: 'utf-8', timeout: 5000 })
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
          printInfo(`仓库文件: ${files.length}`);
          files.slice(0, limit).forEach((file) => console.log(`    ${file}`));
          if (files.length > limit) {
            printInfo(`其余 ${files.length - limit} 个文件可用 "files ${Math.min(files.length, 200)}" 查看更多`);
          }
        } catch (err) {
          printError(`文件列表失败: ${err.message}`);
        }
        return true;
      }

      case 'hooks': {
        try {
          const hookSystem = require('./hooks/hookSystem');
          const registry = hookSystem.registry;
          const rows = [];
          for (const event of registry.events) {
            const hooks = registry.getHooks(event);
            if (hooks.length > 0) {
              rows.push([event, String(hooks.length)]);
            }
          }
          if (rows.length === 0) {
            printInfo('当前无已注册 Hooks');
            return true;
          }
          printTable(['Event', 'Count'], rows);
          printInfo(`总计: ${registry.count} hooks`);
        } catch (err) {
          printError(`Hooks 状态读取失败: ${err.message}`);
        }
        return true;
      }

      case 'mcp': {
        // 增删/预设发现走专用 handler(写 mcp.json / 列预设);其余(状态/governance)保持下方只读视图。
        if (subCommand === 'add' || subCommand === 'remove' || subCommand === 'rm'
          || subCommand === 'presets' || subCommand === 'preset' || subCommand === 'serve') {
          require('./handlers/mcp').handleMcp(subCommand, args, options);
          return true;
        }
        try {
          const mcp = require('../services/mcp');
          const gov = require('../services/mcp/mcpGovernance');
          const config = typeof mcp.loadConfig === 'function' ? mcp.loadConfig(process.cwd()) : { mcpServers: {} };
          const mcpServers = (config && config.mcpServers) || {};
          const servers = Object.keys(mcpServers);
          const connected = typeof mcp.getConnectedServers === 'function' ? mcp.getConnectedServers() : [];
          const tools = typeof mcp.listMCPTools === 'function' ? mcp.listMCPTools() : [];
          const view = gov.buildGovernanceView({
            mcpServers,
            connected,
            tools,
            paths: {
              userPath: path.join(require('os').homedir(), '.khy', 'mcp.json'),
              legacyPath: path.join(require('os').homedir(), '.khyquant', 'mcp.json'),
              projectDir: process.cwd(),
            },
          });

          // `khy mcp governance` (alias: gov) → full single-source-of-truth view:
          // 加载关系 / 审批关系 / 优先级关系。Otherwise keep the compact status table.
          const wantsGovernance = subCommand === 'governance' || subCommand === 'gov';

          printInfo(`MCP 配置服务器: ${servers.length}`);
          printInfo(`MCP 已连接: ${connected.length}`);
          // 刀95: 每台服务器的连接态(connected/connecting/failed/pending/disabled)+失败原因
          // 早已在 MCP 客户端 _connections(state/_lastError),getState().clients 已 spread 暴露,
          // 但 /mcp 表把它塌成布尔 Connected:yes/no → failed 与 pending 无从区分、原因永不显示(half-wired)。
          // 纯决策在叶子 mcpServerStatus.resolveMcpServerState;门控 KHY_MCP_SERVER_STATUS 关 → 逐字节回退布尔列。
          const _mcpStatusByName = {};
          try {
            const st = typeof mcp.getState === 'function' ? mcp.getState() : null;
            if (st && Array.isArray(st.clients)) {
              for (const c of st.clients) {
                if (c && c.name) _mcpStatusByName[c.name] = { type: c.type, error: c.error };
              }
            }
          } catch { /* fail-soft: 状态快照失败 → 回退布尔 */ }
          let _mcpDetailed = false;
          let _resolveMcpServerState = null;
          try {
            const _m = require('../services/mcp/mcpServerStatus');
            _mcpDetailed = _m.mcpServerStatusEnabled(process.env);
            _resolveMcpServerState = _m.resolveMcpServerState;
          } catch { _mcpDetailed = false; }
          if (_mcpDetailed) {
            const failedCount = Object.values(_mcpStatusByName)
              .filter((v) => v && String(v.type).toLowerCase() === 'failed').length;
            if (failedCount > 0) printWarn(`MCP 连接失败: ${failedCount}（详见下表 State 列）`);
          }
          if (servers.length > 0) {
            if (_mcpDetailed && typeof _resolveMcpServerState === 'function') {
              printTable(['Server', 'Scope', 'State', 'Tools', 'Disabled'], view.servers.map((s) => {
                const raw = _mcpStatusByName[s.name] || {};
                const st = _resolveMcpServerState({
                  disabled: s.disabled, connected: s.connected, type: raw.type, error: raw.error,
                }, process.env);
                return [
                  s.name,
                  s.scopeLabel,
                  st.detail ? `${st.state} (${st.detail})` : st.state,
                  String(s.toolCount),
                  s.disabled ? 'yes' : 'no',
                ];
              }));
            } else {
              printTable(['Server', 'Scope', 'Connected', 'Tools', 'Disabled'], view.servers.map((s) => [
                s.name,
                s.scopeLabel,
                s.connected ? 'yes' : 'no',
                String(s.toolCount),
                s.disabled ? 'yes' : 'no',
              ]));
            }
          }

          if (wantsGovernance) {
            console.log(chalk.bold('\n  加载关系 / 优先级（mcp.json 专用文件，后读覆盖先读）:'));
            printTable(['#', 'Scope', 'Path', 'Overrides'], view.precedence.map((r) => [
              String(r.order),
              r.label,
              r.path || '(未设置)',
              r.overrides || '—',
            ]));
            console.log(chalk.bold('\n  审批关系（工具注解 → 权限层语义）:'));
            printInfo('  破坏性 destructiveHint → 不可绕过的人闸门确认（KHY_HUMAN_GATE）');
            printInfo('  只读 readOnlyHint     → plan 模式可放行，可自动批准');
            printInfo('  无注解               → 常规权限流程（默认需批准，plan 不放行）');
          }

          console.log('');
          for (const line of gov.summarizeGovernance(view)) printInfo(line);
          printInfo(wantsGovernance
            ? '提示: 高级管理请在 REPL 中使用 /mcp'
            : '提示: `khy mcp governance` 查看加载/审批/优先级全貌；高级管理用 REPL `/mcp`');
        } catch (err) {
          printError(`MCP 状态读取失败: ${err.message}`);
        }
        return true;
      }

      case 'statusline': {
        await require('./handlers/statusline').handleStatusLine(subCommand, args, options);
        return true;
      }

      case 'share': {
        const fs = require('fs');
        const ai = require('./ai');
        const conversation = typeof ai.getConversation === 'function' ? ai.getConversation() : [];
        if (!conversation.length) {
          printInfo('当前会话为空，无可分享内容。');
          return true;
        }
        let contentToText;
        try { ({ contentToText } = require('../services/contentBlockUtils')); }
        catch { contentToText = (c) => String(c == null ? '' : c); }

        const ROLE_LABEL = { user: '🧑 User', assistant: '🤖 Assistant', system: '⚙️ System', tool: '🔧 Tool' };
        const lines = [`# KHY 会话分享`, '', `> 导出时间：${new Date().toISOString()}`, `> 消息条数：${conversation.length}`, ''];
        for (const msg of conversation) {
          const text = contentToText(msg && msg.content).trim();
          if (!text) continue; // skip empty turns (e.g. tool_use-only assistant frames)
          lines.push(`## ${ROLE_LABEL[msg.role] || msg.role || 'unknown'}`, '', text, '');
        }
        const markdown = lines.join('\n');

        const outputPath = path.resolve(
          String(options.out || options.output || args[0] || `khy-share-${Date.now()}.md`)
        );
        fs.writeFileSync(outputPath, markdown, 'utf-8');

        let copied = false;
        try { copied = require('../services/imageService').writeClipboardText(markdown); }
        catch { copied = false; }

        printSuccess(`会话已分享为 Markdown：${outputPath}`);
        printInfo(copied
          ? '已复制到剪贴板，可直接粘贴分享。'
          : '剪贴板不可用（未安装 pbcopy/xclip/wl-copy）— 请直接分享上述文件。');
        return true;
      }

      case 'stats': {
        const ai = require('./ai');
        const stats = typeof ai.getConversationStats === 'function' ? ai.getConversationStats() : null;
        if (!stats) {
          printError('会话统计不可用');
          return true;
        }
        printTable(
          ['Metric', 'Value'],
          [
            ['messages.total', String(stats.totalMessages || 0)],
            ['messages.user', String(stats.userMessages || 0)],
            ['messages.assistant', String(stats.assistantMessages || 0)],
            ['messages.tool', String(stats.toolMessages || 0)],
            ['effort', String(stats.effort || 'unknown')],
            ['studyMode', String(Boolean(stats.studyMode))],
          ]
        );
        return true;
      }

      case 'status': {
        try {
          const ai = require('./ai');
          const hud = require('./hudRenderer');
          hud.refreshGit();
          const state = hud.getState();
          const provider = typeof ai.getActiveProvider === 'function' ? ai.getActiveProvider() : 'unknown';
          // 刀94: /status 补齐 CC status.tsx 点名的 Model + Account,以及 git ahead/behind。
          // 三样都早已在 hudState(updateModelInfo/account-email 事件/refreshGit 填充)且已被
          // 状态栏与 /hud 面板渲染,唯 /status 呈现侧未接 → half-wired。纯决策在叶子
          // statusPanelExtras(模型友好名走 formatModelLabel SSOT 由此壳注入),渲染留本壳。
          // 门控 KHY_STATUS_PANEL_DETAIL 关 → extras 三片全空 → 短路不追加 Model/Account 行、
          // Branch 无 ahead/behind 后缀 → 逐字节回退刀94前四行。
          let extras = { model: null, account: null, gitSuffix: '' };
          try {
            const { buildStatusPanelExtras } = require('./statusPanelExtras');
            const { formatModelLabel } = require('./ccModelName');
            extras = buildStatusPanelExtras(state, { formatModelLabel }, process.env);
          } catch { /* fail-soft: 额外三片失败绝不影响主 /status */ }
          console.log(chalk.bold('\n  Status:'));
          console.log(`    Provider: ${provider}`);
          if (extras.model) {
            console.log(`    Model: ${extras.model}`);
          }
          if (extras.account) {
            console.log(`    Account: ${extras.account}`);
          }
          if (state?.git?.branch) {
            console.log(`    Branch: ${state.git.branch}${state.git.dirty ? ` (${state.git.dirtyCount} changed)` : ''}${extras.gitSuffix}`);
          }
          console.log(`    Context: ${Math.round((state?.contextWindow?.used || 0) / 1000)}k/${Math.round((state?.contextWindow?.limit || 0) / 1000)}k`);
          console.log(`    Requests: ${state?.requestCount || 0}`);
          console.log('');
        } catch (err) {
          printError(`状态读取失败: ${err.message}`);
        }
        return true;
      }

      case 'summary': {
        const ai = require('./ai');
        const stats = typeof ai.getConversationStats === 'function' ? ai.getConversationStats() : null;
        if (!stats) {
          printError('会话摘要不可用');
          return true;
        }
        printInfo(`会话摘要: 共 ${stats.totalMessages || 0} 条消息（用户 ${stats.userMessages || 0} / 助手 ${stats.assistantMessages || 0} / 工具 ${stats.toolMessages || 0}）`);
        return true;
      }

      case 'tasks': {
        const taskControlService = require('../services/taskControlService');
        const { runTasksControlContract } = require('./tasksControlContract');
        const argsText = args.join(' ').trim();
        const tokens = argsText ? argsText.split(/\s+/).filter(Boolean) : [];
        const primary = String(tokens[0] || '').trim().toLowerCase();
        const TASK_ACTION_ALIASES = {
          cancel: 'cancel',
          stop: 'cancel',
          kill: 'cancel',
          pause: 'pause',
          resume: 'resume',
          取消: 'cancel',
          暂停: 'pause',
          恢复: 'resume',
        };
        const TASK_FILTER_ALIASES = {
          all: 'all',
          a: 'all',
          pending: 'pending',
          queue: 'pending',
          queued: 'pending',
          running: 'running',
          run: 'running',
          active: 'running',
          paused: 'paused',
          pause: 'paused',
          completed: 'completed',
          done: 'completed',
          success: 'completed',
          failed: 'failed',
          fail: 'failed',
          error: 'failed',
          全部: 'all',
          待处理: 'pending',
          运行中: 'running',
          已暂停: 'paused',
          已完成: 'completed',
          失败: 'failed',
        };
        const taskStatusLabel = (status = '') => {
          const value = String(status || '').toLowerCase();
          const labels = {
            pending: '待处理',
            created: '待处理',
            queued: '待处理',
            claimed: '待处理',
            running: '执行中',
            retrying: '重试中',
            pausing: '暂停中',
            paused: '已暂停',
            succeeded: '已完成',
            success: '已完成',
            completed: '已完成',
            done: '已完成',
            failed: '失败',
            cancelled: '已取消',
            dead_letter: '失败终止',
            timeout: '超时',
          };
          return labels[value] || String(status || '未知');
        };
        const taskGroup = (status = '') => {
          const text = String(status || '').toLowerCase();
          if (['pending', 'queued', 'created', 'claimed'].includes(text)) return 'pending';
          if (['running', 'retrying', 'pausing'].includes(text)) return 'running';
          if (['paused'].includes(text)) return 'paused';
          if (['succeeded', 'success', 'completed', 'done'].includes(text)) return 'completed';
          if (['failed', 'cancelled', 'dead_letter', 'timeout'].includes(text)) return 'failed';
          return 'pending';
        };

        if (primary === '?' || primary === 'help' || primary === 'h' || primary === '帮助') {
          printInfo('用法: tasks');
          printInfo('      tasks run <命令...>            后台运行 shell 命令(分离进程,关掉 REPL 也继续)');
          printInfo('      tasks run agent <目标...>      后台跑一个 AI 目标(headless)');
          printInfo('      tasks logs <taskId>           查看某任务的输出');
          printInfo('      tasks all|pending|running|paused|completed|failed [limit]');
          printInfo('      tasks <taskId>');
          printInfo('      tasks cancel|pause|resume <taskId> [reason]');
          printInfo('      tasks clean   清理陈旧任务(超过保留期未更新)');
          return true;
        }

        // `tasks run <cmd>` / `tasks run agent <goal>`: enqueue a background
        // task and spawn its detached runner (survives REPL/CLI exit). Gated by
        // KHY_BG_TASKS. Concurrency is unbounded — each run spawns immediately.
        // Note: the top-level CLI strips `--`-flags, so `agent` is the portable
        // kind selector; `--agent`/`-a` also work inside the REPL.
        if (primary === 'run' || primary === '运行' || primary === '跑') {
          const backgroundTaskLauncher = require('../services/backgroundTaskLauncher');
          if (!backgroundTaskLauncher.isEnabled()) {
            printError('后台任务已禁用(KHY_BG_TASKS=off)。');
            return true;
          }
          const rest = tokens.slice(1);
          let kind = 'shell';
          let body = argsText.replace(/^\s*(run|运行|跑)\s*/i, '');
          if (rest[0] === '--agent' || rest[0] === '-a' || rest[0] === 'agent') {
            kind = 'agent';
            body = body.replace(/^\s*(--agent|-a|agent)\s*/i, '');
          }
          body = body.trim();
          if (!body) {
            printError(kind === 'agent' ? '请提供 agent 目标:tasks run --agent <目标>' : '请提供命令:tasks run <命令>');
            return true;
          }
          const launched = backgroundTaskLauncher.launch(
            kind === 'agent' ? { kind, prompt: body, cwd: process.cwd() } : { kind, command: body, cwd: process.cwd() }
          );
          if (!launched.ok) {
            printError(launched.error || '后台任务启动失败。');
            return true;
          }
          printSuccess(`已在后台启动任务 ${launched.task.id}（${kind}）。`);
          printInfo(`  查看输出: khy tasks logs ${launched.task.id}`);
          printInfo(`  停止任务: khy tasks cancel ${launched.task.id}`);
          printInfo('  提示:后台任务不设并发上限,请自行控制同时运行的数量。');
          return true;
        }

        // `tasks logs <taskId>`: tail the task's disk output log.
        if (primary === 'logs' || primary === 'log' || primary === '日志') {
          const backgroundTaskLauncher = require('../services/backgroundTaskLauncher');
          const targetId = String(tokens[1] || '').trim();
          if (!targetId) {
            printError('请提供任务 ID:tasks logs <taskId>');
            return true;
          }
          const found = taskControlService.getTask(targetId);
          if (!found.ok) {
            printError(found.message || `未找到任务 ${targetId}。`);
            return true;
          }
          const content = backgroundTaskLauncher.tailLogs(targetId);
          if (!content) {
            printInfo(`任务 ${targetId} 暂无输出(可能刚启动或无输出)。`);
            return true;
          }
          printInfo(`—— ${targetId} 输出 ——`);
          for (const line of String(content).split('\n')) {
            printInfo(line);
          }
          return true;
        }

        // `tasks clean`: manually prune stale persisted tasks now, without waiting
        // for a restart or deleting the store file. Same sweep as the startup hook
        // (taskCleanupService); honors KHY_TASK_CLEANUP / KHY_TASK_CLEANUP_DAYS.
        if (primary === 'clean' || primary === '清理') {
          const result = require('../services/taskCleanupService').cleanupStaleTasks({
            log: (line) => printInfo(line),
          });
          if (!result.ran) {
            printInfo('任务自动清理已关闭(KHY_TASK_CLEANUP=off)。');
          } else if (result.removed === 0) {
            printInfo('没有需要清理的陈旧任务。');
          } else {
            printSuccess(`已清理 ${result.removed} 条陈旧任务。`);
          }
          return true;
        }

        const control = runTasksControlContract(argsText, {
          taskControlService,
          actionAliases: TASK_ACTION_ALIASES,
          taskStatusLabel,
          defaultCancelReason: 'Cancelled by tasks command',
        });
        if (control.handled) {
          for (const event of control.events) {
            if (event.level === 'success') printSuccess(event.text);
            else if (event.level === 'info') printInfo(event.text);
            else printError(event.text);
          }
          return true;
        }

        const listedTasks = taskControlService.listTasks();
        const allTasks = Array.isArray(listedTasks) ? listedTasks : [];
        const summary = { total: allTasks.length, pending: 0, running: 0, paused: 0, completed: 0, failed: 0 };
        for (const task of allTasks) {
          summary[taskGroup(task && task.status)] += 1;
        }
        printInfo(
          `任务概览 total=${summary.total} pending=${summary.pending} running=${summary.running} paused=${summary.paused} completed=${summary.completed} failed=${summary.failed}`
        );

        const filter = primary ? (TASK_FILTER_ALIASES[primary] || null) : 'all';
        if (filter) {
          const filtered = filter === 'all'
            ? allTasks
            : allTasks.filter((item) => taskGroup(item.status) === filter);
          const rawLimit = Number.parseInt(String(tokens[1] || (filter === 'all' ? 12 : 20)), 10);
          const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : (filter === 'all' ? 12 : 20);
          if (filtered.length === 0) {
            printInfo(`没有匹配任务（过滤器: ${filter}）`);
            return true;
          }
          const rows = filtered.slice(0, limit).map(task => [
            String(task.id || '-'),
            `${taskStatusLabel(task.status)} (${task.status || '-'})`,
            String(task.type || '-'),
            task.progress_pct === undefined ? '-' : `${Math.round(Number(task.progress_pct) || 0)}%`,
            `${Number.isFinite(Number(task.attempt_count)) ? Number(task.attempt_count) : 0}/${Number.isFinite(Number(task.max_attempts)) ? Number(task.max_attempts) : '-'}`,
            String(task.updated_at || task.created_at || '-').replace('T', ' ').slice(0, 19),
          ]);
          if (rows.length > 0) {
            printTable(['Task ID', '状态', '类型', '进度', '重试', 'Updated'], rows);
          }
          return true;
        }
        const taskId = String(tokens[0] || '').trim();
        if (!taskId) return true;

        const detail = taskControlService.getTaskDetail(taskId, { includeAudit: true });
        if (!detail.ok) {
          printError(detail.message || `任务不存在: ${taskId}`);
          return true;
        }
        const task = detail.task || {};
        printTable(
          ['Field', 'Value'],
          [
            ['id', String(task.id || '-')],
            ['status', String(task.status || '-')],
            ['type', String(task.type || '-')],
            ['progress', task.progress_pct === undefined ? '-' : `${task.progress_pct}%`],
            ['attempts', `${task.attempt_count || 0}/${task.max_attempts || '-'}`],
          ]
        );
        return true;
      }

      case 'theme': {
        if (args[0]) {
          return route({
            command: 'skin',
            subCommand: 'set',
            args,
            options,
            rawInput: parsed.rawInput,
            rawCommandToken: parsed.rawCommandToken,
          }, context);
        }
        return route({
          command: 'skin',
          subCommand: 'list',
          args: [],
          options: {},
          rawInput: 'skin list',
          rawCommandToken: 'skin',
        }, context);
      }

      case 'branch': {
        try {
          const { execSync } = require('child_process');
          const branches = execSync('git branch -a', { encoding: 'utf-8', timeout: 5000 }).trim();
          console.log(chalk.bold('\n  Git Branches:'));
          for (const row of branches.split(/\r?\n/).filter(Boolean)) {
            console.log(`    ${row.trim()}`);
          }
          console.log('');
        } catch (err) {
          printError(`分支读取失败: ${err.message}`);
        }
        return true;
      }

      case 'debug': {
        // 刀113(修正):裸 `/debug` 的 LIVE 路径就是这里(router case)。此前只回一句
        // **循环无用**提示——「请在 REPL 中使用 /debug」,而用户正是在 REPL 里键入 /debug。
        // 真正的「背后逻辑」= 展示本会话最近的工具调用,与 `/debug-tool-call` 同一后端
        // (handlers/debugToolCall + 纯叶子 cli/debugToolCall,零新逻辑)。
        // ⚠ 结构真相:repl.js 内同名 `/debug` 处理块(flag 链 selected.flag==='debug' 与
        //   typed trimmed==='/debug')都被上方 CC-aligned Set 路由块(repl.js:3922 →
        //   route()→本 case)shadow 成 dead code,故必须在此 LIVE 路径修复。
        // 门控 KHY_DEBUG_MENU_INLINE 关(或 KHY_DEBUG_TOOL_CALL 关)→ 逐字节回退旧提示行。
        const _dbgLeaf = require('./debugToolCall');
        if (_dbgLeaf.menuInlineEnabled(process.env) && _dbgLeaf.isEnabled(process.env)) {
          const { handleDebugToolCall } = require('./handlers/debugToolCall');
          await handleDebugToolCall(subCommand, args, options);
          return true;
        }
        printInfo('debug 命令暂未提供独立子命令，请在 REPL 中使用 /debug');
        return true;
      }

      case 'stickers': {
        const stickers = ['(╯°□°)╯︵ ┻━┻', '┬─┬ノ( º _ ºノ)', '( •_•)>⌐■-■', '(⌐■_■)', '\\(^_^)/', '(>_<)', '(◕‿◕)'];
        console.log(`\n  ${stickers[Math.floor(Math.random() * stickers.length)]}\n`);
        return true;
      }
      default: return ROUTER_NOT_HANDLED;
    }
}

module.exports = { dispatchSlashCommand, setRouterDispatchSlashDeps, ROUTER_NOT_HANDLED };
