const { randomUUID } = require('crypto');
const sessionService = require('./sessionService');

const messageService = {
  async send(data) {
    if (!data || !data.sessionId) {
      throw new Error('发送消息失败：缺少 sessionId');
    }
    if (!data.content && !data.attachments?.length) {
      throw new Error('发送消息失败：消息内容不能为空');
    }

    const session = await sessionService.get(data.sessionId);

    const userMessage = {
      id: randomUUID(),
      role: 'user',
      content: data.content || '',
      attachments: data.attachments || [],
      createdAt: Date.now(),
    };

    session.messages.push(userMessage);

    // Placeholder assistant reply — real AI call goes through aiGateway.
    const assistantMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      status: 'pending',
      createdAt: Date.now(),
    };
    session.messages.push(assistantMessage);
    session.updatedAt = Date.now();

    await sessionService.update(session.id, {
      messages: session.messages,
      updatedAt: session.updatedAt,
    });

    return { userMessage, assistantMessage, sessionId: session.id };
  },

  async feedback(data) {
    if (!data || !data.messageId) {
      throw new Error('反馈失败：缺少 messageId');
    }

    // Find the message across all sessions.
    const sessions = await sessionService.list(1000);
    for (const session of sessions) {
      const msg = session.messages.find((m) => m.id === data.messageId);
      if (msg) {
        msg.feedback = {
          type: data.feedbackType, // 'up' | 'down'
          comment: data.comment || '',
          createdAt: Date.now(),
        };
        await sessionService.update(session.id, { messages: session.messages });
        return { success: true, messageId: data.messageId };
      }
    }

    throw new Error(`消息不存在：${data.messageId}`);
  },

  async regenerate(messageId) {
    const sessions = await sessionService.list(1000);
    for (const session of sessions) {
      const idx = session.messages.findIndex((m) => m.id === messageId);
      if (idx !== -1) {
        const original = session.messages[idx];
        const regenerated = {
          ...original,
          id: require('crypto').randomUUID(),
          content: '',
          status: 'pending',
          regeneratedFrom: messageId,
          createdAt: Date.now(),
        };
        session.messages[idx] = regenerated;
        session.updatedAt = Date.now();
        await sessionService.update(session.id, {
          messages: session.messages,
          updatedAt: session.updatedAt,
        });
        return { message: regenerated, sessionId: session.id };
      }
    }

    throw new Error(`消息不存在：${messageId}`);
  },
};

module.exports = messageService;
