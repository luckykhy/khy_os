/**
 * adoptRole — make the assistant play a role/character from a natural-language
 * description. The third instance of the capability-as-code convention
 * (DESIGN-ARCH-059) and the first *behavioral* one: instead of transforming a
 * file, it shapes HOW the assistant responds, by synthesizing a structured,
 * safety-bounded role block that the system-prompt assembler injects BELOW the
 * hard prohibitions / project rules / persona red-lines.
 *
 * One shared core (cli/handlers/role.js `runRole`) backs the `khy role` CLI
 * command, the `/role` slash command, this agent tool, and the in-chat
 * auto-detection seam, with co-located tests, shipping with the product via the
 * wheel rather than living as an assistant memory note.
 *
 * Safety: prompts that try to DISABLE safety ("ignore all rules", "developer
 * mode", "DAN", "越狱", "no restrictions") are refused, not synthesized; every
 * role carries a non-negotiable safety footer; free-form text is injection
 * scanned (fail-closed). The role only shapes voice and expertise — it can
 * never override prohibitions, project rules or red-lines.
 */
const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'adoptRole',
  description:
    'Make the assistant play a role/character described in natural language ' +
    '(e.g. "资深律师", "act as a strict interviewer"). Synthesizes a structured ' +
    'role from the description, or matches a curated preset (lawyer / doctor / ' +
    'teacher / translator / interviewer / product-manager). The role is active ' +
    'for the current conversation only unless `save` is true (then it is also ' +
    'persisted to the user persona). The role only shapes tone and expertise — ' +
    'it never overrides safety rules, project instructions or red-lines, and ' +
    'jailbreak-style "ignore the rules / developer mode" prompts are refused.',
  category: 'system',
  risk: 'low',
  isReadOnly: false,
  isConcurrencySafe: true,

  aliases: ['role', 'set_role', 'play_role', 'roleplay', 'act_as', '扮演角色'],
  searchHint:
    'role play persona character act as roleplay 扮演 角色 你现在是 假装 资深 律师 医生 老师 教师 翻译 面试官 产品经理',

  inputSchema: {
    role: {
      type: 'string',
      required: true,
      description:
        'The role/character to adopt, in natural language. e.g. "资深律师", ' +
        '"a patient math teacher", "act as a strict technical interviewer".',
    },
    save: {
      type: 'boolean',
      required: false,
      description:
        'If true, also persist the role to the user persona so it survives across ' +
        'sessions (defaults to false = current conversation only).',
    },
    preset: {
      type: 'string',
      required: false,
      description:
        'Force a curated preset by key (e.g. 资深律师). If omitted, a preset is ' +
        'matched from the description, falling back to a free-form synthesized role.',
    },
  },

  capability: {
    summary:
      '根据用户提示词扮演角色:自由角色或优质预设(律师/医生/教师/翻译/面试官/产品经理),本次对话生效(可保存);安全红线/项目规则/硬禁令恒优先,越权角色被拒',
    learnedFrom: '2026-06 用户教学:根据提示词正确扮演角色',
    tests: ['tests/roleService.test.js'],
    surfaces: ['cli', 'agent', 'mcp'],
  },

  getActivityDescription(input) {
    const r = input?.role ? String(input.role).slice(0, 24) : '角色';
    return `扮演角色：${r}`;
  },
  getToolUseSummary(input) {
    if (!input?.role) return null;
    return `扮演：${String(input.role).slice(0, 24)}${input.save ? '（保存）' : ''}`;
  },

  async execute(params) {
    if (!params?.role) return { success: false, error: '需要提供要扮演的角色描述。' };
    try {
      const { runRole } = require('../cli/handlers/role');
      return runRole({
        role: params.role,
        action: 'set',
        scope: params.save ? 'save' : 'session',
        preset: params.preset,
      });
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
