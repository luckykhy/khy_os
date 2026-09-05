'use strict';

/**
 * Startup visuals cluster extracted from replSession.js (behavior-preserving
 * god-file split — T-017 batch 1).
 *
 * Owns, verbatim from the former startRepl() closure:
 *   - tryPrintMascotImagePreview: inline-image (iTerm/WezTerm/Kitty) or chafa
 *     mascot probe; TTY-gated, fail-soft, never blocks startup.
 *   - renderStartupHeader: Claude-Code-style bordered welcome box (or legacy
 *     banner fallback) + post-banner best-effort notices (model retirement,
 *     unfinished-build resume hints, rotating startup tips).
 *
 * Pattern: factory receiving every formerly closure-bound dependency
 * explicitly (the @closuredeps inventory documented at the old inner defs in
 * replSession.js). The once-only render guard (_startupHeaderRendered) now
 * lives here as module-private factory state.
 *
 * NOTE: relative requires inside the moved bodies were re-based for this
 * module's location (src/cli/repl/): '../services/*' → '../../services/*',
 * '../../assets/*' → '../../../assets/*'.
 */

const fs = require('fs');
const path = require('path');

function createStartupVisuals(deps) {
  const {
    ai,
    fmt,
    c,
    VERSION,
    getDisplayWidthChar,
    formatShortCwd,
    getClassicMonsterPetLines,
    showGettingStarted,
  } = deps;

  // Use shared banner data service (single source of truth for banner data)
  const { getBannerData } = require('../../bannerDataService');

  function tryPrintMascotImagePreview() {
    if (!process.stdout.isTTY) {
      return false;
    }
    const term = String(process.env.TERM_PROGRAM || '');
    const supportsInlineImage =
      term === 'iTerm.app' || term === 'WezTerm' || !!process.env.KITTY_WINDOW_ID;

    const configured = String(process.env.KHY_MASCOT_IMAGE || '').trim();
    const candidates = [];
    if (configured) {
      candidates.push(path.resolve(configured));
    }
    candidates.push(path.resolve(__dirname, '../../../assets/mascot/xuanniao-original.jpg'));

    for (const imgPath of candidates) {
      if (!fs.existsSync(imgPath)) {
        continue;
      }
      if (supportsInlineImage) {
        try {
          const imageService = require('../../services/imageService');
          const image = imageService.readImageFromFile(imgPath);
          imageService.printImagePreview(image);
          return true;
        } catch {
          // Try terminal text fallback (chafa) below.
        }
      }
      try {
        const { spawnSync } = require('child_process');
        const cols = fmt().getTerminalColumns();
        const width = Math.max(36, Math.min(72, cols - 8));
        const height = Math.max(12, Math.min(24, Math.floor(width * 0.45)));
        const result = spawnSync('chafa', [`--size=${width}x${height}`, imgPath], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (result && result.status === 0 && String(result.stdout || '').trim()) {
          console.log('');
          console.log(String(result.stdout).trimEnd());
          return true;
        }
      } catch {
        // Try the next candidate path.
      }
    }
    return false;
  }

  let _startupHeaderRendered = false;
  /**
   * Render the startup banner/box (Claude-style bordered header or legacy banner).
   * Behavior-identical to the former startRepl()-scoped inner function.
   */
  function renderStartupHeader(force = false) {
    if (_startupHeaderRendered && !force) {
      return;
    }
    _startupHeaderRendered = true;
    const aiProvider = ai().getActiveProvider();
    if (!claudeUiEnabled) {
      printBanner(VERSION, aiProvider);
      if (showGettingStarted) {
        try {
          const gettingStarted = require('../../services/gettingStartedService');
          gettingStarted.displayGettingStarted();
        } catch {
          /* non-critical */
        }
      }
      return;
    }

    // Use shared banner data (single source of truth)
    const data = getBannerData({ version: VERSION, aiProvider });
    let modelName = data.modelName;
    let effortLabel = data.effortLabel;
    let billingType = data.billingType;
    let adapterName = data.adapterName;
    const modelSource = data.modelSource || '';

    if (!modelName) {
      modelName = process.env.GATEWAY_PREFERRED_MODEL || 'auto';
    }
    if (!adapterName) {
      adapterName = process.env.GATEWAY_PREFERRED_ADAPTER || aiProvider || 'auto';
    }

    // Determine billing type
    if (/ollama|local|llama/i.test(adapterName)) {
      billingType = '本地模型';
    } else if (/relay|web|clipboard/i.test(adapterName)) {
      billingType = '中继通道';
    }

    // Effort level
    try {
      const effort = ai().getEffort ? ai().getEffort() : 'high';
      const labels = { max: '最大强度', high: '高强度', medium: '中强度', low: '低强度' };
      effortLabel = labels[effort] || '高强度';
    } catch {
      /* best effort */
    }

    const cols = fmt().getTerminalColumns();

    // Try original mascot image first (inline image or chafa fallback),
    // then keep the text UI below as stable fallback.
    const imagePreviewShown = tryPrintMascotImagePreview();

    // ── Claude Code style bordered box ──
    // Layout:
    // ╭─── khy OS vX.Y.Z ───────────────────────────╮
    // │                                               │
    // │   Welcome back!        Tips for getting started│
    // │                        Run /init to create...  │
    // │   [mascot sprite]                              │
    // │                        Recent activity         │
    // │                        No recent activity      │
    // │                                               │
    // │   Model with effort · Billing                 │
    // │       /working/directory                      │
    // ╰───────────────────────────────────────────────╯

    const boxWidth = Math.min(cols - 4, 76);
    // Inner content width: box is "  ╭...╮" where visible = 2 indent + boxWidth chars.
    // Content lines: "  │ " (4 visible) + content + " │" (2 visible) = boxWidth,
    // so content area = boxWidth - 6. But use boxWidth - 2 for border chars total.
    const contentWidth = boxWidth - 2; // between │ and │ (including padding spaces)
    const innerWidth = contentWidth - 2; // minus " " padding on each side: "│ {inner} │"
    const dim = c.dim;

    // Measure visible display width, stripping ANSI codes and accounting for CJK/emoji
    const visLen = (s) => {
      const stripped = fmt().stripAnsi(s);
      let w = 0;
      for (const ch of stripped) {
        w += getDisplayWidthChar(ch);
      }
      return w;
    };

    // Pad/truncate content to exact visible width
    const padLine = (content, width) => {
      const gap = Math.max(0, width - visLen(content));
      return content + ' '.repeat(gap);
    };

    // Helper: build a full box row "  │ {content padded to innerWidth} │"
    const boxRow = (content) => {
      return dim('  │ ') + padLine(content, innerWidth) + dim(' │');
    };

    // Title line
    const titleText = ` khy OS v${VERSION} `;
    const topDashes = contentWidth - titleText.length; // dashes between ╭ and ╮
    const topLeft = Math.floor(topDashes / 2);
    const topRight = topDashes - topLeft;
    console.log('');
    console.log(
      dim(`  ╭${'─'.repeat(Math.max(1, topLeft))}`) +
        dim(titleText) +
        dim(`${'─'.repeat(Math.max(1, topRight))}╮`)
    );

    // Pet sprite + right-side info
    const petBronze = c.hex('#D77757');
    const petLinesFallback =
      typeof getClassicMonsterPetLines === 'function'
        ? getClassicMonsterPetLines(petBronze)
        : (() => {
            // Inline fallback: Chinese phoenix (Xuan Niao) single-color
            const z = petBronze;
            const d = c.dim;
            return [
              `       ${z('▄█▄')}`,
              `     ${z('▄█▀█▀█▄')}`,
              `     ${z('█▌░▀░▐█')}`,
              `      ${z('▜███▛')}`,
              `  ${z('▗▟████████▙▖')}`,
              `   ${z('▝▀▀▄██▄▀▀▘')}`,
              `       ${d('▐▌')}`,
            ];
          })();
    const petLines = imagePreviewShown ? Array(7).fill('') : petLinesFallback;

    // Left column width (pet + "Welcome back!")
    const leftColW = Math.floor(innerWidth * 0.45);
    const rightColW = innerWidth - leftColW;

    // Tips / activity section — 动态信息
    const green = c.hex('#4EBA65');

    // Auth method detection
    let authMethod = 'API 密钥';
    try {
      if (/relay|clipboard/i.test(adapterName)) {
        authMethod = '中继';
      } else if (/oauth/i.test(adapterName)) {
        authMethod = 'OAuth';
      } else if (/ollama|local/i.test(adapterName)) {
        authMethod = '本地';
      } else if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
        authMethod = 'API 密钥';
      }
    } catch {
      /* best effort */
    }

    // Context window
    let ctxWindow = '';
    try {
      const contextLimit = ai().getContextLimit ? ai().getContextLimit() : 0;
      if (contextLimit > 0) {
        ctxWindow = `${Math.round(contextLimit / 1000)}k 令牌`;
      }
    } catch {
      /* best effort */
    }

    // Gateway status
    let gatewayStatus = '';
    try {
      const gw = require('../../services/gateway/aiGateway');
      const statuses = typeof gw.getStatus === 'function' ? gw.getStatus() : [];
      const available = statuses.filter((s) => s.available);
      if (available.length > 0) {
        gatewayStatus = `${available.length} 个适配器就绪`;
      } else if (statuses.length > 0) {
        gatewayStatus = '已配置，检测中';
      } else {
        gatewayStatus = '就绪';
      }
    } catch {
      gatewayStatus = '就绪';
    }

    // Git branch —— 启动横幅的分支读取。这是**启动阻塞路径**上的一次同步 git
    // 派生;与 gitContextService._git / workspaceGitInit 对齐,默认走「无 shell 派生」
    // (spawnSync 直接派生 git,去掉 Windows execSync 的 cmd.exe 中介,cmd.exe → git
    // 两个进程降为单个 git.exe)。Git Bash 优先解析是 win32 专属关切,故仅在 win32 上
    // 调检测器(Unix 保持 'git' 字面量,零 `git --version` 探针,与历史逐字节一致)。
    // 门控 KHY_GIT_SHELL_FREE(default-on CANON);门关 / 无法安全分词 / 任何异常
    // → 逐字节回退历史 execSync 字符串路径。全程 fail-soft:任何失败 → 分支留空。
    let gitBranch = '';
    try {
      const { execSync, spawnSync } = require('child_process');

      let gitPath = 'git';
      if (process.platform === 'win32') {
        try {
          const detected = require('../../services/gitExecutableDetector').detectGitExecutable();
          if (detected) {
            gitPath = detected;
          }
        } catch {
          /* 检测失败 → 保持 'git'（历史行为） */
        }
      }

      let readViaSpawn = false;
      try {
        const plan = require('../../services/gitSpawnPlan');
        if (plan.isShellFreeGitEnabled(process.env)) {
          const argv = plan.toGitArgv('rev-parse --abbrev-ref HEAD');
          if (argv) {
            readViaSpawn = true;
            const res = spawnSync(gitPath, argv, {
              encoding: 'utf8',
              timeout: 3000,
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true,
            });
            if (res && !res.error && res.status === 0) {
              gitBranch = String(res.stdout ?? '').trim();
            }
          }
        }
      } catch {
        readViaSpawn = false;
      }

      if (!readViaSpawn) {
        // 逐字节回退:门关 / 无法分词 / 判定异常 → 历史 execSync 字符串路径。
        const quotedGit = gitPath === 'git' ? 'git' : `"${gitPath}"`;
        gitBranch = execSync(`${quotedGit} rev-parse --abbrev-ref HEAD`, {
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      }
    } catch {
      /* best effort — branch stays empty */
    }

    const tipsHeader = green('系统');
    const tipsBody = dim(`认证: ${authMethod}${ctxWindow ? ` · 上下文: ${ctxWindow}` : ''}`);
    const actHeader = green('状态');
    const actBody = dim(`网关: ${gatewayStatus}${gitBranch ? ` · 分支: ${gitBranch}` : ''}`);

    // Row 1: empty
    console.log(boxRow(''));

    // Row 2: "Welcome back!" + tips header
    const welcomeText = c.bold('欢迎回来');
    console.log(boxRow(padLine(`  ${welcomeText}`, leftColW) + padLine(tipsHeader, rightColW)));

    // Rows 3..N: phoenix lines + right-side intro/status
    // Spread right-side content across the 7-line sprite height
    const rightLines = ['', tipsBody, '', actHeader, actBody, '', ''];
    for (let i = 0; i < petLines.length; i++) {
      const right = rightLines[i] || '';
      console.log(boxRow(padLine(`  ${petLines[i]}`, leftColW) + padLine(right, rightColW)));
    }

    // Row 6: empty
    console.log(boxRow(''));

    // Row 7: model info
    const modelInfo = `${modelName} · ${effortLabel} · ${billingType}`;
    console.log(boxRow(`  ${dim(modelInfo)}`));

    // Row 7.5: model-source disclosure — only when the model is a fallback
    // (not the user's env preference), so users see WHY this model was picked.
    const sourceLabels = {
      lastVerified: '模型来源: 上次会话记忆',
      adapterDefault: '模型来源: 适配器默认',
    };
    if (sourceLabels[modelSource]) {
      console.log(boxRow(`  ${dim(sourceLabels[modelSource])}`));
    }

    // Row 8: working directory
    console.log(boxRow(`  ${dim(formatShortCwd())}`));

    // Bottom border
    console.log(dim(`  ╰${'─'.repeat(contentWidth)}╯`));
    console.log('');

    // ── 模型退役启动提示（对齐 CC 启动期 model-deprecation-warning）──
    // 门控 KHY_MODEL_DEPRECATION_NOTICE（默认开）。若当前钉选模型已排定退役日期，
    // 启动时给一行 CC 风格提示（时态感知：已于/将于）。当前 khy 型号(opus-4-x 等)不在
    // 退役表 → 无提示；仅当有人钉到旧代模型才触发。全 best-effort，绝不阻断启动。
    try {
      const fp = require('../../services/futureProofing');
      const notice = fp.getModelRetirementNotice(modelName, {
        adapterName,
        nowMs: Date.now(),
      });
      if (notice) {
        console.log('  ' + c.yellow(notice));
        console.log('');
      }
    } catch {
      /* 退役提示是增益，绝不阻断启动 */
    }

    // ── 未完成构建发现横幅 ──
    // 若当前工作目录存在被打断（断电/断网/token耗尽/Ctrl+C/khy故障）残留的可续检查点，
    // 在启动时主动提示，并给出确切续作命令。全 best-effort，绝不阻断启动。
    try {
      const resumeAdvisor = require('../../services/resumeAdvisor');
      try {
        resumeAdvisor.pendingForCwd && require('../../services/boulderState').purgeExpired?.();
      } catch {
        /* purge is optional */
      }
      const pending = resumeAdvisor.pendingForCwd(process.cwd());
      if (pending) {
        const hint = resumeAdvisor.formatStartupHint(pending, { color: c });
        if (hint) {
          console.log(hint);
          console.log('');
        }
      }
    } catch {
      /* 发现性是增益，绝不阻断启动 */
    }

    // ── 启动轮换提示（对齐 CC tips「背后的逻辑」）──
    // 门控 KHY_STARTUP_TIPS（默认开）。从内置 tips 注册表按 per-tip cooldownSessions 冷却 +
    // isRelevant 相关性过滤，选「最久未显示」的一条，跨会话持久化 numStartups/tipsHistory，
    // 在横幅后浮现一行。门控关/无候选 → 不显示（逐字节回退今日行为：今日 tips 为死代码，
    // 本就不显示任何提示）。全 best-effort，绝不阻断启动。
    try {
      const tipStore = require('../../services/tipHistoryStore');
      const tip = tipStore.bumpStartupAndSelectTip(process.env);
      if (tip && tip.text) {
        console.log('  ' + dim('※ 提示  ' + tip.text));
        console.log('');
      }
    } catch {
      /* 轮换提示是增益，绝不阻断启动 */
    }
  }

  function resetStartupHeaderRendered() {
    _startupHeaderRendered = false;
  }

  return { tryPrintMascotImagePreview, renderStartupHeader, resetStartupHeaderRendered };
}

module.exports = { createStartupVisuals };
