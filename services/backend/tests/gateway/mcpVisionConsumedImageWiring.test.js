'use strict';

/**
 * MCP 视觉成功后必须把图片转换为权威文字描述，并清除旧 CLI 文件桥痕迹。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const mcp = require(BE + '/src/services/mcp');
const h = require('./_ocrGatewayHarness');

const env = h.envSandbox([
  'KHY_TOOL_CAP_PROBE',
  'KHY_GLM_VISION_MODEL',
  'KHY_VISION_FALLBACK_MODEL',
  'KHY_MCP_VISION_SERVER',
]);
const originalCallTool = mcp.callTool;

before(() => {
  env.save();
  env.set({
    KHY_TOOL_CAP_PROBE: 'off',
    KHY_GLM_VISION_MODEL: 'off',
    KHY_VISION_FALLBACK_MODEL: '',
    KHY_MCP_VISION_SERVER: 'deepseek-eyes',
  });
});

after(() => {
  mcp.callTool = originalCallTool;
  env.restore();
});

test('MCP 成功后剥图、清理旧桥接路径并阻止 CLI 再次 Read', async () => {
  const seen = { prompt: null, options: null, mcpArgs: null, chunks: [] };
  const adapter = {
    detect: () => true,
    generate: async (prompt, options) => {
      if (/khy_probe_echo/.test(String(prompt || ''))) {
        return { success: true, content: 'yes', provider: 'textonly', adapter: 'textonly' };
      }
      seen.prompt = prompt;
      seen.options = options;
      return {
        success: true,
        content: '图中是一张蓝色状态面板。',
        provider: 'textonly',
        adapter: 'textonly',
        model: options && options.model,
      };
    },
    getStatus: () => ({ name: 'textonly', available: true, activeModel: 'text-only-model' }),
    listModels: async () => [],
  };

  h.wireSingle(adapter);
  genLeaf.setAiGatewayGenerateMethodDeps({
    collectProviderSiblingModels: () => [],
  });
  mcp.callTool = async (serverName, toolName, args) => {
    seen.mcpArgs = { serverName, toolName, args };
    return { content: [{ type: 'text', text: '识别结果：蓝色状态面板，状态正常。' }] };
  };

  const oldWindowsPath = 'C:\\Temp\\khy-cli-img-old\\image-1-deadbeef.png';
  const oldPosixPath = '/tmp/khy-cli-img-old/image-2-acde1234.jpg';
  const res = await h.gw.generate(
    `请描述图片\n【图片附件】请使用 Read 工具读取：\n- ${oldWindowsPath}`,
    {
      model: 'text-only-model',
      images: h.DEFAULT_IMG,
      messages: [
        { role: 'user', content: `历史桥接路径 ${oldPosixPath}` },
        { role: 'system', content: '普通路径 C:\\work\\report.json 应保留' },
      ],
      onChunk: (chunk) => seen.chunks.push(chunk),
    }
  );

  assert.equal(res.success, true);
  assert.deepEqual(
    { serverName: seen.mcpArgs.serverName, toolName: seen.mcpArgs.toolName },
    { serverName: 'deepseek-eyes', toolName: 'analyze_image' }
  );
  assert.match(seen.prompt, /\[图片已完成视觉识别\]/);
  assert.match(seen.prompt, /识别结果：蓝色状态面板/);
  assert.doesNotMatch(seen.prompt, /【图片附件】|khy-cli-img-old/);
  assert.equal(seen.options.images, undefined);
  assert.equal(seen.options._mcpVisionApplied, true);
  assert.equal(seen.options._imageTransportConsumed, true);
  assert.doesNotMatch(seen.options.messages[0].content, /khy-cli-img-old/);
  assert.match(seen.options.messages[1].content, /C:\\work\\report\.json/);

  const assistantMessages = seen.chunks.filter((chunk) => chunk && chunk.type === 'assistant_message');
  const statuses = seen.chunks
    .filter((chunk) => chunk && chunk.type === 'status')
    .map((chunk) => String(chunk.text || chunk.message || chunk.content || ''));
  assert.equal(assistantMessages.length, 0, 'MCP 进度不应作为持久助手消息重复输出');
  assert.equal(statuses.filter((text) => text.includes('图片识别中')).length, 1);
  assert.equal(statuses.filter((text) => text.includes('识别完成')).length, 1);
});
