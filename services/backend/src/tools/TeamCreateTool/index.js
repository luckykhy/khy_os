const { BaseTool } = require('../_baseTool');
const teammateBus = require('../teammateBus');

class TeamCreateTool extends BaseTool {
  static toolName = 'TeamCreate';
  static category = 'coordinator';
  static risk = 'medium';
  static aliases = ['team_create', 'create_teammate'];
  static searchHint = 'team create teammate parallel agent';
  static shouldDefer = true;

  isConcurrencySafe() { return false; }

  prompt() {
    return `Create a teammate — a long-running in-process agent that works in parallel on a subtask.

Unlike the Agent tool (one-shot, isolated sub-agent), a teammate is multi-turn:
you can message it mid-flight with SendMessage, and it messages you back. Its
replies are injected into your context automatically as <teammate-message>
blocks on the next turn — you do not poll for them.

Use teammates for collaborative, independent work streams where you may need to
send follow-up instructions before the work is done. Use the Agent tool instead
for fire-and-forget subtasks that need no further interaction.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the teammate' },
        task: { type: 'string', description: 'Task description for the teammate' },
        tools: { type: 'array', description: 'Allowed tool names', items: { type: 'string' } },
      },
      required: ['name', 'task'],
    };
  }

  async execute(params) {
    const result = teammateBus.createTeammate({
      name: params.name,
      task: params.task,
      tools: params.tools,
    });
    if (result && result.error) {
      return { success: false, error: result.error };
    }
    return {
      success: true,
      teammate_id: result.id,
      name: result.name,
      task: result.task,
      status: result.status,
      note: '队友已创建并开始执行；其回复会作为 <teammate-message> 自动注入你的下一轮上下文。'
        + '可用 SendMessage 向其追加指令，用 TeamDelete 结束它。',
    };
  }

  getActivityDescription(input) { return `创建协作代理：${input.name}`; }
}

module.exports = TeamCreateTool;
