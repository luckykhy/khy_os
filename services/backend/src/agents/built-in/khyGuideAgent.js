'use strict';

/**
 * khy OS guide agent — helps users understand and use khy OS effectively.
 * Aligned with Claude Code's claudeCodeGuideAgent.ts, adapted for khy OS.
 */

const GLOB_TOOL_NAME = 'Glob';
const GREP_TOOL_NAME = 'Grep';
const FILE_READ_TOOL_NAME = 'Read';
const WEB_FETCH_TOOL_NAME = 'WebFetch';
const WEB_SEARCH_TOOL_NAME = 'WebSearch';
const SEND_MESSAGE_TOOL_NAME = 'SendMessage';

function getKhyGuideBasePrompt() {
  return `You are the khy OS guide agent. Your primary responsibility is helping users understand and use khy OS effectively.

**Your expertise spans three domains:**

1. **khy OS CLI**: Installation, configuration, hooks, skills, MCP servers, keyboard shortcuts, IDE integrations, settings, and workflows.

2. **Agent SDK**: Building custom AI agents using khy OS's agent architecture. Available for Node.js.

3. **AI Gateway**: The AI gateway for proxying model requests, tool use, and integrations with various providers (Ollama, Claude, GPT, etc.).

**Approach:**
1. Determine which domain the user's question falls into
2. Use ${WEB_FETCH_TOOL_NAME} to fetch relevant documentation if available
3. Use ${WEB_SEARCH_TOOL_NAME} if docs don't cover the topic
4. Reference local project files (CLAUDE.md, .khy/ directory) when relevant using ${FILE_READ_TOOL_NAME}, ${GLOB_TOOL_NAME}, and ${GREP_TOOL_NAME}
5. Provide clear, actionable guidance

**Guidelines:**
- Always prioritize official documentation over assumptions
- Keep responses concise and actionable
- Include specific examples or code snippets when helpful
- Help users discover features by proactively suggesting related commands, shortcuts, or capabilities
- When you cannot find an answer or the feature doesn't exist, direct the user to report it at the project's issue tracker

Complete the user's request by providing accurate guidance.`;
}

/** @type {import('../types').BuiltInAgentDefinition} */
const KHY_GUIDE_AGENT = {
  agentType: 'khy-guide',
  whenToUse: `Use this agent when the user asks questions ("Can khy...", "Does khy...", "How do I...") about: (1) khy OS CLI - features, hooks, slash commands, MCP servers, settings, IDE integrations, keyboard shortcuts; (2) Agent SDK - building custom agents; (3) AI Gateway - model proxying, tool use. **IMPORTANT:** Before spawning a new agent, check if there is already a running or recently completed khy-guide agent that you can continue via ${SEND_MESSAGE_TOOL_NAME}.`,
  tools: [
    GLOB_TOOL_NAME,
    GREP_TOOL_NAME,
    FILE_READ_TOOL_NAME,
    WEB_FETCH_TOOL_NAME,
    WEB_SEARCH_TOOL_NAME,
  ],
  source: 'built-in',
  baseDir: 'built-in',
  model: 'haiku',
  permissionMode: 'dontAsk',
  getSystemPrompt({ toolUseContext } = {}) {
    const basePrompt = getKhyGuideBasePrompt();
    const contextSections = [];

    if (toolUseContext && toolUseContext.options) {
      // 1. Custom skills
      const commands = toolUseContext.options.commands || [];
      const customCommands = commands.filter(cmd => cmd.type === 'prompt');
      if (customCommands.length > 0) {
        const commandList = customCommands
          .map(cmd => `- /${cmd.name}: ${cmd.description}`)
          .join('\n');
        contextSections.push(
          `**Available custom skills in this project:**\n${commandList}`,
        );
      }

      // 2. Custom agents
      const agentDefs = toolUseContext.options.agentDefinitions;
      if (agentDefs && agentDefs.activeAgents) {
        const customAgents = agentDefs.activeAgents.filter(
          a => a.source !== 'built-in',
        );
        if (customAgents.length > 0) {
          const agentList = customAgents
            .map(a => `- ${a.agentType}: ${a.whenToUse}`)
            .join('\n');
          contextSections.push(
            `**Available custom agents configured:**\n${agentList}`,
          );
        }
      }

      // 3. MCP servers
      const mcpClients = toolUseContext.options.mcpClients;
      if (mcpClients && mcpClients.length > 0) {
        const mcpList = mcpClients
          .map(client => `- ${client.name}`)
          .join('\n');
        contextSections.push(`**Configured MCP servers:**\n${mcpList}`);
      }
    }

    if (contextSections.length > 0) {
      return `${basePrompt}

---

# User's Current Configuration

The user has the following custom setup in their environment:

${contextSections.join('\n\n')}

When answering questions, consider these configured features and proactively suggest them when relevant.`;
    }

    return basePrompt;
  },
};

module.exports = { KHY_GUIDE_AGENT };
