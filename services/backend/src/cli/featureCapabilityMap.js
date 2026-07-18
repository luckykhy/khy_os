'use strict';

const { getRouterCommandNames } = require('../constants/commandSchema');

const KNOWN_COMMANDS = new Set(getRouterCommandNames());

const COMMAND_IMPLEMENTATION = {
  quote: 'backend/src/cli/handlers/data.js::handleQuote',
  data: 'backend/src/cli/handlers/data.js::handleDataFetch|handleDataList',
  cache: 'backend/src/cli/handlers/data.js::handleCacheClear',
  backtest: 'backend/src/cli/handlers/backtest.js::handleBacktestRun|handleBacktestList',
  strategy: 'backend/src/cli/handlers/backtest.js::handleStrategyList',
  app: 'backend/src/cli/handlers/app.js::handleApp',
  gateway: 'backend/src/cli/handlers/gateway.js::handleGatewayStatus|handleGatewayConfig|handleGatewayManage',
  model: 'backend/src/cli/handlers/gateway.js::handleGatewaySelectModel',
  pool: 'backend/src/cli/handlers/pool.js::handlePool*',
  proxy: 'backend/src/cli/handlers/proxy.js::handleProxy*',
  docs: 'backend/src/cli/handlers/docs.js::handleDocs*',
  publish: 'backend/src/cli/handlers/publish.js::handlePublish',
  repo: 'backend/src/cli/handlers/repo.js::handleRepo',
  workspace: 'backend/src/cli/handlers/workspace.js::handleWorkspace',
  verify: 'backend/src/cli/handlers/verify.js::handleVerify',
  skill: 'backend/src/cli/handlers/skill.js::handleSkillCommand',
  session: 'backend/src/cli/handlers/session.js::handleSessionCommand',
  cron: 'backend/src/cli/handlers/cron.js::handleCronCommand',
  daemon: 'backend/src/cli/handlers/daemon.js::handleDaemon',
  arena: 'backend/src/cli/handlers/arena.js::handleArena',
  remote: 'backend/src/cli/handlers/remote.js::handleRemote',
  config: 'backend/src/cli/handlers/config.js::handleConfig',
  init: 'backend/src/cli/handlers/init.js::handleInit',
  doctor: 'backend/src/cli/handlers/init.js::handleDoctor',
  linux: 'backend/src/cli/handlers/linux.js::handleLinuxCommand',
  assistant: 'backend/src/cli/handlers/assistant.js::handleAssistantCommand',
  brief: 'backend/src/cli/handlers/assistant.js::handleAssistantCommand',
  ai: 'backend/src/cli/ai.js::chat',
};

const COMMAND_FEATURE = {
  quote: 'Market quote query',
  data: 'Market data fetch/list',
  cache: 'Cache maintenance',
  backtest: 'Strategy backtest',
  strategy: 'Strategy catalog',
  app: 'App lifecycle management',
  gateway: 'AI gateway management',
  model: 'AI model selection',
  pool: 'API key pool management',
  proxy: 'Proxy / relay routing',
  docs: 'Documentation guidance',
  publish: 'Project publishing',
  repo: 'Version management (beginner-safe)',
  workspace: 'Workspace snapshot',
  verify: 'Verification workflow',
  skill: 'Skill management',
  session: 'Session history list/show/resume/rename/delete/search/stats',
  cron: 'Scheduled tasks',
  daemon: 'Background daemon control',
  arena: 'Arena benchmarking',
  remote: 'Remote execution',
  config: 'CLI configuration',
  init: 'Project initialization',
  doctor: 'System health check',
  linux: 'Linux runtime tools',
  assistant: 'Assistant briefing',
  brief: 'Assistant briefing',
  ai: 'AI chat execution',
};

function _clean(text = '', maxLen = 120) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 3)}...` : oneLine;
}

function _resolveImplementation(command = '') {
  if (COMMAND_IMPLEMENTATION[command]) return COMMAND_IMPLEMENTATION[command];
  return `backend/src/cli/router.js::route(case '${command || 'unknown'}')`;
}

function _resolveFeature(command = '') {
  return COMMAND_FEATURE[command] || `Command routing: ${command || 'unknown'}`;
}

class FeatureCapabilityMap {
  constructor() {
    this.reset();
  }

  reset() {
    this.currentFeature = 'idle';
    this.command = '';
    this.subCommand = '';
    this.implementation = 'backend/src/cli/repl.js::startRepl';
    this.executable = 'ready';
    this.reason = 'waiting for input';
    this.lastTool = '';
    this.updatedAt = Date.now();
  }

  markCommandParsed(parsed = {}) {
    const command = String(parsed.command || '').trim();
    const subCommand = String(parsed.subCommand || '').trim();
    this.command = command;
    this.subCommand = subCommand;
    this.currentFeature = _resolveFeature(command);
    this.implementation = _resolveImplementation(command);
    this.executable = KNOWN_COMMANDS.has(command) ? 'ready' : 'ai-fallback';
    this.reason = KNOWN_COMMANDS.has(command)
      ? (subCommand ? `parsed: ${command} ${subCommand}` : `parsed: ${command}`)
      : `unknown command: ${command}`;
    this.updatedAt = Date.now();
  }

  markRouteResult(result) {
    if (result === true) {
      this.executable = 'completed';
      this.reason = `executed by ${this.implementation}`;
    } else if (result === false) {
      this.executable = 'delegated';
      this.currentFeature = 'AI task execution';
      this.implementation = 'backend/src/cli/repl.js::chatFn -> backend/src/services/toolUseLoop.js::runToolUseLoop';
      this.reason = 'forwarded to AI chat loop';
    } else if (result && typeof result === 'object' && result.aiForward) {
      this.executable = 'delegated';
      this.currentFeature = 'Command with AI forwarding';
      this.implementation = 'backend/src/cli/repl.js::route -> ai().chat';
      this.reason = 'command generated aiForward prompt';
    } else if (result === 'exit' || result === 'menu' || result === 'ai-status' || result === 'ai-config') {
      this.executable = 'ready';
      this.reason = `special route: ${result}`;
    }
    this.updatedAt = Date.now();
  }

  markError(error) {
    const msg = _clean(error && error.message ? error.message : String(error || 'unknown error'), 96);
    this.executable = 'blocked';
    this.reason = `runtime error: ${msg}`;
    this.updatedAt = Date.now();
  }

  markAiTask(input = '', toolLoopEnabled = true) {
    const preview = _clean(input, 72);
    this.command = 'ai';
    this.subCommand = toolLoopEnabled ? 'tool-loop' : 'single-turn';
    this.currentFeature = 'AI task execution';
    this.implementation = toolLoopEnabled
      ? 'backend/src/cli/repl.js::chatFn -> backend/src/services/toolUseLoop.js::runToolUseLoop'
      : 'backend/src/cli/repl.js::chatFn -> backend/src/cli/ai.js::chat';
    this.executable = 'running';
    this.reason = preview ? `task: ${preview}` : 'ai task started';
    this.updatedAt = Date.now();
  }

  markToolCall(toolName = '', params = {}) {
    const name = String(toolName || '').trim();
    const target = _clean(
      params.path || params.file_path || params.filePath || params.pattern || params.query || params.q || params.command || '',
      64
    );
    this.currentFeature = 'AI tool execution';
    this.implementation = 'backend/src/services/toolUseLoop.js::executeToolCall';
    this.executable = 'running';
    this.lastTool = name || this.lastTool;
    this.reason = name
      ? `tool call: ${name}${target ? ` (${target})` : ''}`
      : 'tool call';
    this.updatedAt = Date.now();
  }

  markToolResult(toolName = '', ok = true, detail = '') {
    const name = String(toolName || '').trim();
    const short = _clean(detail, 80);
    this.currentFeature = 'AI tool execution';
    this.implementation = 'backend/src/services/toolUseLoop.js::executeToolCall';
    this.executable = ok ? 'ready' : 'blocked';
    this.lastTool = name || this.lastTool;
    this.reason = name
      ? `${ok ? 'tool success' : 'tool failed'}: ${name}${short ? ` · ${short}` : ''}`
      : (ok ? 'tool success' : 'tool failed');
    this.updatedAt = Date.now();
  }

  markAiCompletion(success = true, reason = '') {
    this.currentFeature = 'AI task execution';
    this.command = 'ai';
    this.subCommand = 'tool-loop';
    this.implementation = 'backend/src/cli/repl.js::chatFn -> backend/src/services/toolUseLoop.js::runToolUseLoop';
    this.executable = success ? 'completed' : 'blocked';
    this.reason = reason ? _clean(reason, 96) : (success ? 'ai task completed' : 'ai task incomplete');
    this.updatedAt = Date.now();
  }

  renderLines() {
    return [
      'Feature Capability Map',
      `Current Feature: ${this.currentFeature}`,
      `Command Path: ${this.command || 'n/a'}${this.subCommand ? ` -> ${this.subCommand}` : ''}`,
      `Implementation: ${this.implementation}`,
      `Executable: ${this.executable}`,
      `Reason: ${this.reason}`,
      `Last Tool: ${this.lastTool || 'n/a'}`,
    ];
  }

  getCompactStatus() {
    const cmd = this.command ? `${this.command}${this.subCommand ? `/${this.subCommand}` : ''}` : 'n/a';
    return `${cmd} | ${this.executable} | ${this.currentFeature}`;
  }

  buildAiSteerMessage() {
    return [
      '[Feature Capability Map]',
      `Current Feature: ${this.currentFeature}`,
      `Command Path: ${this.command || 'n/a'}${this.subCommand ? ` -> ${this.subCommand}` : ''}`,
      `Implementation: ${this.implementation}`,
      `Executable: ${this.executable}`,
      `Reason: ${this.reason}`,
      'Rule: choose actions that match executable capability and implementation path.',
    ].join('\n');
  }

  getSnapshot() {
    return {
      currentFeature: this.currentFeature,
      command: this.command,
      subCommand: this.subCommand,
      implementation: this.implementation,
      executable: this.executable,
      reason: this.reason,
      lastTool: this.lastTool,
      updatedAt: this.updatedAt,
      compact: this.getCompactStatus(),
    };
  }
}

module.exports = {
  FeatureCapabilityMap,
};
