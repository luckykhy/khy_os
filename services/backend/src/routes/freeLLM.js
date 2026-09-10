/**
 * 免费LLM API路由
 * 提供LLM服务测试和状态查询接口
 */

const express = require('express');

const router = express.Router();
// llmService-free was removed in S9 cleanup — reuse the stub LLMService
const MultiFreeService = require('../services/multiFreeService');
const apiResponse = require('../utils/apiResponse');

// FreeLLMService was removed in the same cleanup; MultiFreeService (required
// above) exposes the same testConnection/getStatus surface these routes use.
const freeLLMService = new MultiFreeService();

/**
 * 测试LLM连接
 * GET /api/llm/test
 */
router.get('/test', async (req, res) => {
  try {
    console.log('🧪 开始测试免费LLM连接...');

    const testResult = await freeLLMService.testConnection();

    res.json({
      success: testResult.success,
      message: testResult.message,
      data: {
        provider: testResult.provider,
        response: testResult.response,
        availableProviders: testResult.availableProviders,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('LLM测试失败:', error);
    apiResponse.fail(res, 'INTERNAL', '测试失败', { status: 500 });
  }
});

/**
 * 获取LLM服务状态
 * GET /api/llm/status
 */
router.get('/status', (req, res) => {
  try {
    const status = freeLLMService.getStatus();

    apiResponse.success(res, {
      ...status,
      timestamp: new Date().toISOString(),
      version: '2.0.0-free',
    });
  } catch (error) {
    console.error('获取LLM状态失败:', error);
    apiResponse.fail(res, 'INTERNAL', '获取状态失败', { status: 500 });
  }
});

/**
 * 股票分析接口
 * POST /api/llm/analyze
 */
router.post('/analyze', async (req, res) => {
  try {
    const { stockCode, agentId = 'market', prompt } = req.body;

    if (!stockCode) {
      return apiResponse.fail(res, 'INVALID_ARGUMENT', '股票代码不能为空', { status: 400 });
    }

    console.log(`📊 开始分析股票: ${stockCode}, 智能体: ${agentId}`);

    const analysisPrompt =
      prompt ||
      `请对股票 ${stockCode} 进行专业分析，包括技术面、基本面和投资建议。请用中文回答，格式清晰。`;

    const result = await freeLLMService.analyze({
      prompt: analysisPrompt,
      agentId,
      stockCode,
      temperature: 0.7,
      maxTokens: 1500,
    });

    apiResponse.success(res, {
      stockCode,
      agentId,
      analysis: result,
      provider: freeLLMService.getAvailableProvider()?.name || '模拟分析引擎',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('股票分析失败:', error);
    apiResponse.fail(res, 'INTERNAL', '分析失败', { status: 500 });
  }
});

/**
 * 自定义文本生成
 * POST /api/llm/generate
 */
router.post('/generate', async (req, res) => {
  try {
    const { prompt, temperature = 0.7, maxTokens = 1000 } = req.body;

    if (!prompt) {
      return apiResponse.fail(res, 'INVALID_ARGUMENT', '提示词不能为空', { status: 400 });
    }

    console.log('🤖 开始生成文本响应...');

    const result = await freeLLMService.generateResponse(prompt);

    if (result.success) {
      apiResponse.success(res, {
        content: result.content,
        provider: result.provider,
        timestamp: new Date().toISOString(),
      });
    } else {
      apiResponse.fail(res, 'INTERNAL', '生成失败', { status: 500 });
    }
  } catch (error) {
    console.error('文本生成失败:', error);
    apiResponse.fail(res, 'INTERNAL', '生成失败', { status: 500 });
  }
});

/**
 * 获取配置指南
 * GET /api/llm/guide
 */
router.get('/guide', (req, res) => {
  apiResponse.success(res, {
    title: '免费LLM API配置指南',
    providers: [
      {
        name: 'Google Gemini Pro',
        description: '完全免费，质量高，响应快',
        url: 'https://makersuite.google.com/app/apikey',
        envVar: 'GEMINI_API_KEY',
        steps: [
          '访问 Google AI Studio',
          '登录Google账号',
          '点击 "Create API Key"',
          '复制API Key到环境变量',
        ],
        recommended: true,
      },
      {
        name: '智谱AI GLM-4',
        description: '中文友好，免费额度大',
        url: 'https://open.bigmodel.cn/',
        envVar: 'ZHIPU_API_KEY',
        steps: ['访问智谱AI开放平台', '注册并实名认证', '进入控制台', '创建API Key'],
        recommended: true,
      },
      {
        name: 'OpenAI GPT-3.5',
        description: '质量最高，需要国外手机号',
        url: 'https://platform.openai.com/api-keys',
        envVar: 'OPENAI_API_KEY',
        steps: [
          '访问OpenAI平台',
          '注册账号（需要国外手机号）',
          '创建API Key',
          '注意免费额度限制',
        ],
        recommended: false,
      },
    ],
    quickStart: {
      title: '快速开始',
      steps: [
        '复制 backend/.env.free-llm-template 为 backend/.env',
        '编辑 .env 文件，填入至少一个API密钥',
        '重启后端服务',
        '访问 /api/llm/test 测试连接',
      ],
    },
  });
});

/**
 * 获取动态免费模型列表
 * GET /api/llm/free-models
 */
router.get('/free-models', async (req, res) => {
  try {
    const dynamicFreeModelService = require('../services/dynamicFreeModelService');
    const result = await dynamicFreeModelService.listFreeModels();
    apiResponse.success(res, {
      models: result.models,
      count: result.models.length,
      source: result.source,
      cachedAt: result.cachedAt,
      description: result.source === 'cache' ? '来自本地缓存（TTL 5 分钟）' : '来自在线数据源',
    });
  } catch (error) {
    console.error('获取免费模型列表失败:', error);
    apiResponse.fail(res, 'INTERNAL', '获取免费模型列表失败', { status: 500 });
  }
});

/**
 * 手动触发免费模型列表刷新
 * POST /api/llm/free-models/refresh
 */
router.post('/free-models/refresh', async (req, res) => {
  try {
    const dynamicFreeModelService = require('../services/dynamicFreeModelService');
    const result = await dynamicFreeModelService.refresh();
    apiResponse.success(
      res,
      {
        models: result.models,
        count: result.models.length,
        source: result.source,
        cachedAt: result.cachedAt,
      },
      { message: '免费模型列表已刷新' }
    );
  } catch (error) {
    console.error('刷新免费模型列表失败:', error);
    apiResponse.fail(res, 'INTERNAL', '刷新失败', { status: 500 });
  }
});

/**
 * 获取免费模型缓存状态
 * GET /api/llm/free-models/status
 */
router.get('/free-models/status', (req, res) => {
  try {
    const dynamicFreeModelService = require('../services/dynamicFreeModelService');
    const status = dynamicFreeModelService.getCacheStatus();
    apiResponse.success(res, {
      ...status,
      description: status.hasCache
        ? `缓存有效，剩余 ${Math.ceil(status.remainingMs / 1000)} 秒`
        : '无有效缓存，下次请求将在线拉取',
    });
  } catch (error) {
    console.error('获取缓存状态失败:', error);
    apiResponse.fail(res, 'INTERNAL', '获取状态失败', { status: 500 });
  }
});

module.exports = router;
