'use strict';

/**
 * toolCalling 内置工具定义与风险表(从 toolCalling.js 上帝文件抽出)。
 *
 * 导出 BUILTIN_TOOLS(AI 可调内置工具数组,含 open_app / import_model / list_models /
 * optimize_config 等带 handler 的条目)、RISK_LEVELS(风险层 UI 表)、PERMISSIONS_FILE。
 * open_app handler 复用 app-launch 兄弟叶子的探测/启动/验证函数;其余 handler 懒加载
 * modelImportService/selfOptimizer 等。零宿主可变态读取(不碰 _allTools/_permissions/
 * _preflightContext);_allTools 仍在宿主由 `[...BUILTIN_TOOLS]` 展开。
 *
 * **刻意非纯零 IO 叶子**:handler 内 spawn/启动进程/读写文件/懒加载服务。放置为
 * toolCalling.js 的**同目录兄弟**以保迁移的 require 相对路径字节不变。宿主 _allTools 展开、
 * loadPermissions/savePermissions、module.exports 按**同名 re-import** 接回,调用点字节不变。
 */
const path = require('path');
const os = require('os');
// open_app handler 复用 app-launch 兄弟叶子(byte-identical 相对路径)。
const {
  _hasGraphicalSession, _resolveOpenDefaultTarget, _buildAppCandidates, _getInstalledApps,
  _matchInstalledApp, _commandExists, _inferWindowsImageName, _getWindowsProcessPids,
  _spawnDetached, _verifyWindowsLaunch, _formatLaunchOutput, _splitExecLine, _launchLinuxDesktopEntry,
} = require('./toolCallingAppLaunch');
// launchOutcome leaf (fail-soft): honest "已启动" wording on a clean spawn.
let _launchOutcome; try { _launchOutcome = require('./launchOutcome'); } catch { _launchOutcome = null; }

const PERMISSIONS_FILE = path.join(os.homedir(), '.khyquant', 'tool_permissions.json');

// Tool categories and risk levels.
// The KEYS of this map are the canonical five risk tiers — identical to the
// single source of truth constants/riskOrder.js RISK_LEVELS. This object adds a
// UI presentation layer (label/color) plus the `autoApprove` policy flag on top
// of that shared vocabulary; a drift-guard test asserts its keys === RISK_LEVELS.
const RISK_LEVELS = {
  safe: { label: '安全', color: 'green', autoApprove: true },
  low: { label: '低风险', color: 'cyan', autoApprove: false },
  medium: { label: '中风险', color: 'yellow', autoApprove: false },
  high: { label: '高风险', color: 'red', autoApprove: false },
  critical: { label: '危险', color: 'redBright', autoApprove: false },
};

// Built-in tools available for AI to call
// NOTE: Tools with richer implementations in tools/ directory have been removed from here.
// Removed: quote, backtest, data_fetch, search, execute_code, shell_command, strategy_list,
// web_search, git_status, git_diff, git_commit, read_file, write_file
// (resolved via tools/ registry with isEnabled, inputSchema, aliases, etc.)
const BUILTIN_TOOLS = [
  {
    name: 'open_app',
    description: 'Open an application installed on this computer, OR open a URL / an existing file with the system default program. Accepts: an app name in any language (e.g. "docker", "apifox", "火狐", "文件管理器"); a URL (http/https/file://) — opened in the default browser; or a path to an existing file (e.g. a .html / .pdf / image / document) — opened with its default handler. Automatically finds and launches the correct binary for app names.',
    category: 'system',
    risk: 'medium',
    parameters: {
      name: { type: 'string', required: true, description: 'Application name (fuzzy match), a URL, or a path to an existing file' },
    },
    handler: async (params) => {
      const rawName = String(params.name || '').trim();
      const appName = rawName.toLowerCase();
      if (!appName) return { success: false, error: 'Application name is required' };
      if (process.platform === 'linux' && !_hasGraphicalSession()) {
        return {
          success: false,
          error: 'No graphical session detected (DISPLAY/WAYLAND_DISPLAY is not set). Unable to open GUI applications from this terminal session.',
        };
      }
      // Triage: a URL or an existing file goes to the OS default handler instead
      // of the installed-app matcher (so "open this webpage / .html" works even
      // though the model picked open_app rather than a browser-open tool).
      const defaultTarget = _resolveOpenDefaultTarget(rawName, process.cwd());
      if (defaultTarget) {
        try {
          require('../tools/platformUtils').openDefault(defaultTarget);
          return {
            success: true,
            mode: 'openDefault',
            target: defaultTarget,
            output: `Opened with the system default handler: ${defaultTarget}`,
          };
        } catch (err) {
          return { success: false, error: `Failed to open ${defaultTarget}: ${err.message}` };
        }
      }
      const candidates = _buildAppCandidates(rawName);

      // Build index of installed apps from .desktop files
      const apps = _getInstalledApps();

      // Fuzzy match installed apps (single source of truth: _matchInstalledApp).
      let match = _matchInstalledApp(rawName);

      if (!match) {
        // Fallback: if binary exists in PATH, launch directly.
        const runnable = (candidates.length > 0 ? candidates : [appName]).find(c => _commandExists(c));
        if (runnable) {
          try {
            const imageName = _inferWindowsImageName(runnable);
            const beforePids = process.platform === 'win32'
              ? _getWindowsProcessPids(imageName)
              : new Set();
            await _spawnDetached(runnable, [], {
              env: { ...process.env },
            });
            const verification = process.platform === 'win32'
              ? await _verifyWindowsLaunch(runnable, beforePids, 2000, { imageName })
              : { verified: true, mode: 'spawn' };
            const output = _launchOutcome
              ? _launchOutcome.formatLaunchOutput(rawName, runnable, verification, process.env)
              : _formatLaunchOutput(rawName, runnable, verification);
            return {
              success: true,
              verified: !!verification.verified,
              verification,
              output,
            };
          } catch (err) {
            return { success: false, error: `Failed to launch ${rawName}: ${err.message}` };
          }
        }

        // List similar apps as suggestions
        const suggestions = apps
          .filter(a => a.searchText.includes(appName.charAt(0)))
          .slice(0, 5)
          .map(a => a.name);
        return {
          success: false,
          error: `Application "${params.name}" not found on this system.`,
          hint: suggestions.length > 0
            ? `Similar apps: ${suggestions.join(', ')}`
            : 'No similar apps found. The user may need to install it first.',
        };
      }

      // Launch the app detached
      try {
        const execLine = String(match.exec || '').trim();
        if (!execLine) {
          return { success: false, error: `Failed to launch ${match.name}: empty launch command` };
        }

        const normalizedExec = execLine.replace(/^"+|"+$/g, '');
        if (process.platform !== 'win32' && /^[A-Za-z]:\\/.test(normalizedExec)) {
          return { success: false, error: `Failed to launch ${match.name}: Windows path detected on non-Windows runtime` };
        }

        let launchCommand = normalizedExec;
        let launchArgs = [];
        if (process.platform === 'win32') {
          const isPathLike = /^(?:[A-Za-z]:\\|\\\\|\.{1,2}[\\/])/.test(normalizedExec);
          const isDirectFile = /\.(lnk|url|exe|msi|cmd|bat)$/i.test(normalizedExec);
          if (!(isPathLike && isDirectFile)) {
            const execParts = _splitExecLine(normalizedExec);
            if (execParts.length === 0) {
              return { success: false, error: `Failed to launch ${match.name}: invalid launch command` };
            }
            launchCommand = execParts[0];
            launchArgs = execParts.slice(1);
          }
        } else {
          const execParts = _splitExecLine(normalizedExec);
          if (execParts.length === 0) {
            return { success: false, error: `Failed to launch ${match.name}: invalid launch command` };
          }
          launchCommand = execParts[0];
          launchArgs = execParts.slice(1);
        }

        const imageName = _inferWindowsImageName(launchCommand);
        const beforePids = process.platform === 'win32'
          ? _getWindowsProcessPids(imageName)
          : new Set();
        await _spawnDetached(launchCommand, launchArgs, {
          env: { ...process.env },
        });
        const verification = process.platform === 'win32'
          ? await _verifyWindowsLaunch(launchCommand, beforePids, 2000, { imageName })
          : { verified: true, mode: 'spawn' };
        const output = _launchOutcome
          ? _launchOutcome.formatLaunchOutput(match.name, match.bin, verification, process.env)
          : _formatLaunchOutput(match.name, match.bin, verification);
        return {
          success: true,
          verified: !!verification.verified,
          verification,
          output,
        };
      } catch (err) {
        if (process.platform === 'linux') {
          const fallback = await _launchLinuxDesktopEntry(match);
          if (fallback.launched) {
            const verification = { verified: true, mode: fallback.mode, launcher: fallback.hint };
            return {
              success: true,
              verified: true,
              verification,
              output: `已通过桌面入口启动: ${match.name} (${fallback.hint})`,
            };
          }
          const reason = fallback.error?.message || fallback.reason || 'desktop-entry-launch-failed';
          return { success: false, error: `Failed to launch ${match.name}: ${err.message}; fallback failed: ${reason}` };
        }
        return { success: false, error: `Failed to launch ${match.name}: ${err.message}` };
      }
    },
  },
  {
    name: 'import_model',
    description: 'Import a local model file/directory or download from URL. Supports: .gguf, .safetensors, .zip archives, model directories. Auto-detects format, extracts archives, patches for llama.cpp compatibility, validates, and registers with Ollama.',
    category: 'ai',
    risk: 'medium',
    parameters: {
      source: { type: 'string', required: true, description: 'Local file/directory path or download URL' },
      name: { type: 'string', required: false, description: 'Target model name (auto-derived if omitted)' },
      base: { type: 'string', required: false, description: 'Base model for adapter imports' },
    },
    handler: async (params) => {
      const modelImport = require('./modelImportService');
      const source = String(params.source || '').trim();
      if (!source) return { success: false, error: 'No source path or URL provided' };
      const result = await modelImport.importModel(source, {
        name: params.name,
        base: params.base,
      });
      if (result.success) {
        return {
          success: true,
          output: `Model imported: ${result.model} (${result.sourceKind})\nSteps: ${(result.steps || []).join(' → ')}`,
          model: result.model,
        };
      }
      return { success: false, error: result.error, steps: result.steps };
    },
  },
  {
    name: 'download_model',
    description: 'Download a model from a URL (HuggingFace, ModelScope, GitHub, direct links). Auto-detects format and imports after download.',
    category: 'ai',
    risk: 'medium',
    parameters: {
      url: { type: 'string', required: true, description: 'Model download URL' },
      name: { type: 'string', required: false, description: 'Target model name (auto-derived if omitted)' },
    },
    handler: async (params) => {
      const modelImport = require('./modelImportService');
      const url = String(params.url || '').trim();
      if (!url) return { success: false, error: 'No URL provided' };
      const result = await modelImport.importFromUrl(url, { name: params.name });
      if (result.success) {
        return {
          success: true,
          output: `Model downloaded and imported: ${result.model} (${result.sourceKind})\nSteps: ${(result.steps || []).join(' → ')}`,
          model: result.model,
        };
      }
      return { success: false, error: result.error, steps: result.steps };
    },
  },
  {
    name: 'list_models',
    description: 'List all models on this computer: imported KHY/Ollama models and local model files found on disk. Shows model name, size, format, location, and import status.',
    category: 'ai',
    risk: 'low',
    parameters: {},
    handler: async () => {
      const modelImport = require('./modelImportService');
      const all = await modelImport.listAllModels();

      const lines = [];
      if (all.khyModels.length) {
        lines.push('=== KHY/Ollama 已导入模型 ===');
        for (const m of all.khyModels) {
          lines.push(`  ✓ ${m.name}  ${m.size}  ${m.family}  ${m.quantization || ''}`);
        }
      } else {
        lines.push('=== KHY/Ollama 已导入模型 === (无)');
      }

      lines.push('');
      if (all.localModels.length) {
        lines.push('=== 本地模型文件 ===');
        for (const m of all.localModels) {
          const tag = m.imported ? '[已导入]' : '[未导入]';
          lines.push(`  ${tag} ${m.name}  ${m.sizeStr}  ${m.format}  📂 ${m.path}`);
        }
      } else {
        lines.push('=== 本地模型文件 === (未发现)');
      }

      if (all.ideModels && all.ideModels.length) {
        lines.push('');
        lines.push('=== IDE 可用模型 ===');
        for (const m of all.ideModels) {
          lines.push(`  ${m.source}/${m.name}  (路由: ${m.route})`);
        }
        const { resolveLocalProxyOpenAiBaseUrl } = require('../utils/proxyBaseUrl');
        lines.push(`提示: 通过 gateway proxy (${resolveLocalProxyOpenAiBaseUrl()}) 可作为 OpenAI API 使用`);
      }

      return {
        success: true,
        output: lines.join('\n'),
        khyCount: all.khyModels.length,
        localCount: all.localModels.length,
        ideCount: (all.ideModels || []).length,
      };
    },
  },
  {
    name: 'export_ollama_model',
    description: 'Export a model from Ollama to a local GGUF file for KHY use. Creates a symlink or copy in the KHY models directory.',
    category: 'ai',
    risk: 'medium',
    parameters: {
      model: { type: 'string', required: true, description: 'Ollama model name (e.g. qwen3.5:4b)' },
      dest: { type: 'string', required: false, description: 'Destination directory (default: KHY models/)' },
    },
    handler: async (params) => {
      const modelImport = require('./modelImportService');
      const model = String(params.model || '').trim();
      if (!model) return { success: false, error: 'No model name provided' };
      const result = await modelImport.exportFromOllama(model, params.dest);
      if (result.success) {
        return { success: true, output: `Exported: ${result.model} → ${result.path} (${result.sizeMB} MB)` };
      }
      return { success: false, error: result.error };
    },
  },
  // ── Self-optimization tools ──
  // NOTE: shell_command, read_file, write_file, strategy_list, web_search,
  // git_status, git_diff, git_log, git_add, git_commit, git_push, git_branch,
  // git_checkout all migrated to tools/ directory with richer implementations
  // (isEnabled, inputSchema, aliases, validateInput, etc.)
  {
    name: 'optimize_config',
    description: 'Safely update AI configuration (system prompt, agent roles, prompt library). Hot-update, no restart needed.',
    category: 'optimization',
    risk: 'medium',
    parameters: {
      target: { type: 'string', required: true, description: 'Config target: system_prompt | agent_roles | prompt_library' },
      content: { type: 'string', required: true, description: 'New content for the config' },
      reason: { type: 'string', required: true, description: 'Why this optimization' },
    },
    handler: async (params) => {
      const optimizer = require('./selfOptimizer');
      return optimizer.applyOptimization(params.target, params.content, params.reason);
    },
  },
  {
    name: 'propose_code_change',
    description: 'Propose a source code change via git branch (requires user review, does not affect running code)',
    category: 'optimization',
    risk: 'high',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Absolute path to the source file' },
      content: { type: 'string', required: true, description: 'Proposed new file content' },
      description: { type: 'string', required: true, description: 'What was changed and why' },
    },
    handler: async (params) => {
      const optimizer = require('./selfOptimizer');
      return optimizer.proposeCodeChange(params.file_path, params.content, params.description);
    },
  },
];

module.exports = {
  PERMISSIONS_FILE,
  RISK_LEVELS,
  BUILTIN_TOOLS,
};
