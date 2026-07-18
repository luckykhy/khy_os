const { BaseTool } = require('../_baseTool');

class BriefTool extends BaseTool {
  static toolName = 'Brief';
  static category = 'coordinator';
  static risk = 'safe';
  static aliases = ['brief', 'send_brief'];
  static searchHint = 'brief message proactive status update notification';
  static shouldDefer = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Send a brief message to the user. Supports markdown formatting.
Use 'proactive' status when surfacing something the user hasn't asked for.
Use 'normal' when replying to something the user just said.
Attachments can include file paths for photos, screenshots, diffs, or logs.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message for the user. Supports markdown.' },
        attachments: {
          type: 'array',
          description: 'Optional file paths to attach',
          items: { type: 'string' },
        },
        status: {
          type: 'string',
          description: "Use 'proactive' for unsolicited updates, 'normal' for replies (default 'normal')",
          enum: ['normal', 'proactive'],
          default: 'normal',
        },
      },
      required: ['message'],
    };
  }

  async execute(params) {
    const fs = require('fs');
    const resolvedAttachments = [];

    if (params.attachments && Array.isArray(params.attachments)) {
      for (const p of params.attachments) {
        if (fs.existsSync(p)) {
          const stat = fs.statSync(p);
          const ext = p.split('.').pop().toLowerCase();
          const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
          resolvedAttachments.push({
            path: p,
            size: stat.size,
            isImage: imageExts.includes(ext),
          });
        }
      }
    }

    return {
      success: true,
      message: params.message,
      attachments: resolvedAttachments.length > 0 ? resolvedAttachments : undefined,
      status: params.status || 'normal',
      sentAt: new Date().toISOString(),
    };
  }

  getActivityDescription() { return '发送简报'; }
}

module.exports = BriefTool;
