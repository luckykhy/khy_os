const { BaseTool } = require('../_baseTool');

class RemoteTriggerTool extends BaseTool {
  static toolName = 'RemoteTrigger';
  static category = 'coordinator';
  static risk = 'medium';
  static aliases = ['remote_trigger'];
  static searchHint = 'remote trigger webhook notify signal';
  static shouldDefer = true;

  isConcurrencySafe() { return false; }

  prompt() {
    return `Trigger a remote action via webhook or API call.
Used for CI/CD triggers, notifications, or remote agent coordination.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Webhook URL to trigger' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT'], default: 'POST', description: 'HTTP method for the trigger request (default POST). GET sends no body.' },
        payload: { type: 'object', description: 'JSON payload to send' },
        headers: { type: 'object', description: 'Custom headers' },
      },
      required: ['url'],
    };
  }

  async execute(params) {
    try {
      const resp = await fetch(params.url, {
        method: params.method || 'POST',
        headers: { 'Content-Type': 'application/json', ...(params.headers || {}) },
        body: params.method !== 'GET' ? JSON.stringify(params.payload || {}) : undefined,
      });
      const text = await resp.text();
      return { success: resp.ok, status: resp.status, body: text.slice(0, 5000) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

module.exports = RemoteTriggerTool;
