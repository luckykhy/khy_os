/**
 * Workflow export providers — single source of truth for multi-agent export.
 *
 * The canvas graph and its Mermaid flowchart are provider-agnostic; the ONLY
 * things that vary when targeting a different AI coding agent are:
 *   1. where the derived files land (skill / agent directories),
 *   2. how each node-type instruction names the agent's native tools,
 *   3. how the user invokes the exported skill.
 *
 * This module captures exactly those three axes per provider so
 * workflowExportService stays a thin renderer. Adding a provider = one entry
 * here (no exporter logic change). Modelled after cc-wf-studio's
 * getSubAgentDescription / getAskUserQuestionDescription / getShellToolDescription,
 * adapted to KHY's node set (which additionally has code/http/toolCall nodes
 * that cc-wf-studio lacks).
 *
 * Instruction prose stays Chinese (matches the existing KHY export and the
 * project language policy); only the tool *identifiers* are provider-specific.
 *
 * Directory semantics:
 *   - `home: true`  dirs are resolved against the user's home (KHY harness
 *     default — shares the OS home with the agent runtime).
 *   - `home: false` dirs are resolved against the export root (project cwd),
 *     mirroring how cc-wf-studio writes into .claude/ .codex/ etc.
 */
'use strict';

/**
 * @typedef {Object} ProviderTools
 * @property {string} askUserQuestion  native ask-the-user tool name
 * @property {string} subAgent         native sub-agent / task spawn tool name
 * @property {string} skill            how a skill is invoked
 * @property {string} shell            native shell/command tool name
 * @property {string} http             native HTTP/fetch tool name
 *
 * @typedef {Object} Provider
 * @property {string} id
 * @property {string} label            human label (for UI / docs)
 * @property {string} agentName        agent display name used in prose
 * @property {{ skill: string, agent?: string, home: boolean }} dirs
 * @property {(slug: string) => string} invoke  how the user triggers the skill
 * @property {ProviderTools} tools
 */

/** @type {Record<string, Provider>} */
const PROVIDERS = {
  // Default: byte-compatible with the historical single-provider export.
  khy: {
    id: 'khy',
    label: 'KHY Harness',
    agentName: 'KHY',
    dirs: { skill: '.khyquant/skills', agent: '.khy/agents', home: true },
    invoke: (slug) => `goal: run ${slug}`,
    tools: {
      askUserQuestion: 'askUserQuestion 工具',
      subAgent: '子代理',
      skill: '技能',
      shell: 'Bash 工具',
      http: 'HTTP 请求',
    },
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    agentName: 'Claude Code',
    dirs: { skill: '.claude/commands', agent: '.claude/agents', home: false },
    invoke: (slug) => `/${slug}`,
    tools: {
      askUserQuestion: 'AskUserQuestion 工具',
      subAgent: 'Task 工具',
      skill: 'Skill 工具',
      shell: 'Bash 工具',
      http: 'WebFetch 工具',
    },
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    agentName: 'Codex CLI',
    dirs: { skill: '.codex/skills', home: false },
    invoke: (slug) => `$${slug}`,
    tools: {
      askUserQuestion: 'ask_user_question 工具',
      subAgent: 'spawn_agent 工具',
      skill: 'skill',
      shell: 'shell 工具',
      http: 'shell 工具（curl）',
    },
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    agentName: 'Gemini CLI',
    dirs: { skill: '.gemini/skills', home: false },
    invoke: (slug) => slug,
    tools: {
      askUserQuestion: 'ask_user 工具',
      subAgent: '子代理',
      skill: 'skill',
      shell: 'run_shell_command 工具',
      http: 'run_shell_command 工具（curl）',
    },
  },
  'roo-code': {
    id: 'roo-code',
    label: 'Roo Code',
    agentName: 'Roo Code',
    dirs: { skill: '.roo/skills', home: false },
    invoke: (slug) => `:${slug}`,
    tools: {
      askUserQuestion: 'ask_followup_question 工具',
      subAgent: 'new_task 工具',
      skill: 'skill',
      shell: 'execute_command 工具',
      http: 'execute_command 工具（curl）',
    },
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    agentName: 'Copilot CLI',
    dirs: { skill: '.github/skills', home: false },
    invoke: (slug) => `/${slug}`,
    tools: {
      askUserQuestion: '提问工具',
      subAgent: 'task/agent 工具',
      skill: 'skill',
      shell: '终端命令',
      http: '终端命令（curl）',
    },
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    agentName: 'Cursor',
    dirs: { skill: '.cursor/skills', agent: '.cursor/agents', home: false },
    invoke: (slug) => slug,
    tools: {
      askUserQuestion: '提问工具',
      subAgent: '子代理',
      skill: 'skill',
      shell: 'Bash 工具',
      http: 'Bash 工具（curl）',
    },
  },
};

const DEFAULT_PROVIDER = 'khy';

/** Resolve a provider by id, or throw a 400-style error for an unknown id. */
function getProvider(id) {
  const key = id == null || id === '' ? DEFAULT_PROVIDER : String(id);
  const provider = PROVIDERS[key];
  if (!provider) {
    const err = new Error(
      `Unknown export provider '${key}'. Valid: ${Object.keys(PROVIDERS).join(', ')}`
    );
    err.statusCode = 400;
    throw err;
  }
  return provider;
}

function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label }));
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER,
  getProvider,
  listProviders,
};
