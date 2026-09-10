'use strict';

const { sendWeChatNotification } = require('../../src/utils/notifier');

describe('notifier', () => {
  describe('sendWeChatNotification', () => {
    test('returns false when no sendKey', async () => {
      const result = await sendWeChatNotification('', { signal: 'BUY', symbol: 'AAPL' });
      expect(result).toBe(false);
    });

    test('returns false when sendKey is null', async () => {
      const result = await sendWeChatNotification(null, { signal: 'BUY', symbol: 'AAPL' });
      expect(result).toBe(false);
    });
  });
});

