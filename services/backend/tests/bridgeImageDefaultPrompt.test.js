/**
 * tests/bridgeImageDefaultPrompt.test.js
 *
 * 验证中转桥接 input 事件处理器在「只有附件、无文字」时注入默认
 * prompt "请描述这张图片" 的行为，与 app.jsx handleSubmit 对齐。
 *
 * 不依赖 React/Ink 运行时，只测纯逻辑分支。
 */
'use strict';

const { describe, test, expect, vi, beforeEach } = require('@jest/globals');

// ── 被测逻辑（从 useQueryBridge.js onBridgeEvent 输入处理块中提取） ──────────

/**
 * 模拟桥接 input 事件的数据处理：对 data.attachments 调用 resolveForChat，
 * 在 text 为空但有图片时注入默认 prompt。
 *
 * @param {object} data - 桥接事件载荷 { text?: string, attachments?: string[] }
 * @param {object} mockResolve - resolveForChat 的 mock 返回值
 * @returns {{ text: string, opts: { images?: string[] } }}
 */
function processBridgeInput(data, mockResolve) {
  let text = data && typeof data.text === 'string' ? data.text.trim() : '';
  const opts = { source: 'bridge' };
  const ids = data && Array.isArray(data.attachments) ? data.attachments : [];

  if (ids.length) {
    const resolved = mockResolve(ids);
    if (resolved.images && resolved.images.length) opts.images = resolved.images;
    if (resolved.promptBlocks && resolved.promptBlocks.length) {
      const blocks = resolved.promptBlocks.join('\n\n');
      text = text ? `${text}\n\n${blocks}` : blocks;
    }
  }

  // ── 修复点：与 app.jsx handleSubmit 对齐 ──
  if (text || (opts.images && opts.images.length)) {
    if (!text.trim() && opts.images && opts.images.length) {
      text = '请描述这张图片';
    }
  }

  return { text, opts };
}

// ── Mock ──────────────────────────────────────────────────────────────────────

const DEFAULT_IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

function mockResolveWithImages(images) {
  return () => ({
    images: images || [DEFAULT_IMAGE],
    promptBlocks: [],
    descriptors: [],
    missing: [],
  });
}

function mockResolveWithPromptBlocks(blocks) {
  return () => ({
    images: [],
    promptBlocks: blocks || ['extracted text from PDF'],
    descriptors: [],
    missing: [],
  });
}

function mockResolveMixed(images, blocks) {
  return () => ({
    images: images || [],
    promptBlocks: blocks || [],
    descriptors: [],
    missing: [],
  });
}

// ── 测试用例 ──────────────────────────────────────────────────────────────────

describe('bridge input handler: 图片 + 空文字 → 默认 prompt', () => {
  test('只有图片附件、无文字 → 注入 "请描述这张图片"', () => {
    const { text, opts } = processBridgeInput(
      { text: '', attachments: ['abc123'] },
      mockResolveWithImages([DEFAULT_IMAGE]),
    );

    expect(text).toBe('请描述这张图片');
    expect(opts.images).toEqual([DEFAULT_IMAGE]);
    expect(opts.source).toBe('bridge');
  });

  test('只有图片附件、文字全是空格 → 注入 "请描述这张图片"', () => {
    const { text } = processBridgeInput(
      { text: '   ', attachments: ['abc123'] },
      mockResolveWithImages([DEFAULT_IMAGE]),
    );

    expect(text).toBe('请描述这张图片');
  });

  test('文字 + 图片 → 保留原有文字，不注入默认 prompt', () => {
    const { text } = processBridgeInput(
      { text: '这张照片怎么样', attachments: ['abc123'] },
      mockResolveWithImages([DEFAULT_IMAGE]),
    );

    expect(text).toBe('这张照片怎么样');
  });

  test('纯文字、无附件 → 保留文字，无图片', () => {
    const { text, opts } = processBridgeInput(
      { text: '你好', attachments: [] },
      mockResolveWithImages([]),
    );

    expect(text).toBe('你好');
    expect(opts.images).toBeUndefined();
  });

  test('只有 promptBlocks（PDF 提取文本）、无图片 → 用 promptBlocks 填 text', () => {
    const { text, opts } = processBridgeInput(
      { text: '', attachments: ['pdf-id'] },
      mockResolveWithPromptBlocks(['PDF extracted content']),
    );

    expect(text).toBe('PDF extracted content');
    expect(opts.images).toBeUndefined();
  });

  test('文字 + promptBlocks + 图片 → 合并，不注入默认 prompt', () => {
    const { text } = processBridgeInput(
      { text: '帮我看下', attachments: ['pdf-id'] },
      mockResolveMixed([DEFAULT_IMAGE], ['PDF content']),
    );

    expect(text).toBe('帮我看下\n\nPDF content');
  });

  test('promptBlocks 填了 text、同时有图片 → promptBlocks 已填充 text，不注入默认', () => {
    const { text } = processBridgeInput(
      { text: '', attachments: ['pdf-id'] },
      mockResolveMixed([DEFAULT_IMAGE], ['PDF content']),
    );

    expect(text).toBe('PDF content');
  });

  test('多个图片附件 → 仍注入默认 prompt', () => {
    const { text } = processBridgeInput(
      { text: '', attachments: ['id1', 'id2'] },
      mockResolveWithImages(['data:image/png;base64,AAA=', 'data:image/png;base64,BBB=']),
    );

    expect(text).toBe('请描述这张图片');
  });

  test('无 attachments 字段 → 纯 fallback，不注入', () => {
    const { text, opts } = processBridgeInput(
      { text: '' },
      mockResolveWithImages([]),
    );

    expect(text).toBe('');
    expect(opts.images).toBeUndefined();
  });

  test('undefined data → 安全降级', () => {
    const { text } = processBridgeInput(undefined, mockResolveWithImages([]));
    expect(text).toBe('');
  });
});
