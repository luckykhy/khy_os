/**
 * SkillTool — execute user-invocable skills, aligned with Claude Code's Skill tool.
 *
 * Skills are user-facing commands (slash commands) that provide specialized
 * capabilities. This tool bridges the AI to the skill registry.
 */
const { BaseTool } = require('../_baseTool');

class SkillTool extends BaseTool {
  static toolName = 'Skill';
  static category = 'system';
  static risk = 'medium';
  static aliases = ['skill', 'slash_command', 'invoke_skill'];
  static searchHint = 'skill slash command invoke execute plugin';
  static alwaysLoad = true;

  isReadOnly() { return false; }
  isConcurrencySafe() { return false; }

  prompt() {
    return `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - skill: "pdf" - invoke the pdf skill
  - skill: "commit", args: "-m 'Fix bug'" - invoke with arguments
  - skill: "review-pr", args: "123" - invoke with arguments
  - skill: "ms-office-suite:pdf" - invoke using fully qualified name

Important:
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'The skill name to invoke (e.g., "commit", "review-pr", "pdf")',
        },
        args: {
          type: 'string',
          description: 'Optional arguments for the skill',
        },
      },
      required: ['skill'],
    };
  }

  getActivityDescription(input) {
    return `执行技能：${input.skill || 'unknown'}`;
  }

  getToolUseSummary(input) {
    const args = input.args ? ` ${input.args}` : '';
    return `技能：/${input.skill}${args}`;
  }

  async execute(params, context) {
    const { skill, args } = params;

    if (!skill) {
      return { success: false, error: 'skill name is required' };
    }

    // A1 — model-invocation gate. A skill that declares
    // `disable-model-invocation: true` may only be run by a human via the CLI
    // (`khy skill run`); the model reaching it through SkillTool is refused.
    // Resolved against the manifest registry (the same loader used below) so
    // both built-in and user/project skills are covered.
    try {
      const manifestRegistry = require('../../skills');
      const resolved = manifestRegistry.findSkill(skill);
      if (resolved && resolved.disableModelInvocation) {
        return {
          success: false,
          skill,
          error: `Skill "${skill}" is not model-invocable (disable-model-invocation). A human must run it via \`khy skill run ${skill}\`.`,
        };
      }
    } catch { /* registry unavailable — fall through to normal resolution */ }

    // Level-2 skill loading (s07): resolve by registry NAME, never by a path
    // built from caller input. The manifest registry (src/skills) looks skills
    // up by name/trigger/alias and can reach every bundled built-in + user/
    // project skill; it builds no path from the argument, so it is
    // path-traversal-safe. Try it first — this is the primary loader.
    try {
      const manifestRegistry = require('../../skills');
      if (manifestRegistry.findSkill(skill)) {
        const result = await manifestRegistry.executeSkill(skill, args, context);
        return {
          success: true,
          skill,
          output: result,
          message: `技能 /${skill} 执行成功`,
        };
      }
    } catch { /* manifest registry unavailable — fall through */ }

    try {
      // Marketplace registry (installed + quant builtin skills).
      const skillRegistry = require('../../services/skillRegistry');
      const result = await skillRegistry.executeSkill(skill, args, context);
      return {
        success: true,
        skill,
        output: result,
        message: `技能 /${skill} 执行成功`,
      };
    } catch (err) {
      // Fallback: try command registry
      try {
        const cmdReg = require('../../cli/commandRegistry');
        const cmd = cmdReg.get(skill) || cmdReg.get(`/${skill}`);
        if (cmd && cmd.handler) {
          const result = await cmd.handler(args || '', context);
          return {
            success: true,
            skill,
            output: result,
            message: `命令 /${skill} 执行成功`,
          };
        }
      } catch { /* command registry not available */ }

      return {
        success: false,
        skill,
        error: `Skill "${skill}" not found or failed: ${err.message}`,
      };
    }
  }
}

module.exports = new SkillTool();
module.exports.SkillTool = SkillTool;
