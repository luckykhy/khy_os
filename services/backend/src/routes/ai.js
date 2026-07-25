const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const stockAnalysisEngine = require('../services/stockAnalysisEngine');
const trainingData = require('../services/trainingDataService');
// Model-name SSOT: direct provider-call model choices flow from constants/models.js.
const { PRIMARY: MODELS } = require('../constants/models');

// AI chat endpoint - requires authentication to prevent resource abuse
router.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { stockCode, analysisContext, question, tokens, useLocalModel, conversationHistory, agentResults } = req.body;
    const safeQuestion = typeof question === 'string' ? question.trim() : '';
    const mergedContext = { ...(analysisContext || {}) };
    const bareStockCode = /^(sh|sz)?\d{6}$/i.test(safeQuestion) ? safeQuestion : null;
    const resolvedStockCode = stockCode || bareStockCode || null;

    if (agentResults) {
      mergedContext.agentResults = agentResults;
    }

    if (!safeQuestion) {
      return res.status(400).json({
        success: false,
        message: '问题不能为空'
      });
    }
    
    console.log('收到AI对话请求:', { stockCode: resolvedStockCode, question: safeQuestion, useLocalModel });
    
    // 快速响应问候语(不检查金融相关性)
    const q = safeQuestion.toLowerCase();
    if (q.includes('你好') || q.includes('您好') || q.includes('hello') || q.includes('hi')) {
      const greetings = [
        '你好!欢迎使用小K 👋\n\n我是您的智能AI助手,擅长量化交易分析,也能帮您:\n• 解答各类知识问题\n• 编程与技术咨询\n• 数据分析与计算\n• 股票行情与策略分析\n\n有什么可以帮您的?',
        '您好!很高兴为您服务 😊\n\n我是小K,一个全能AI助手。量化分析是我的特长,同时也能帮您解答编程、知识、生活等各类问题。\n\n请告诉我您需要什么帮助!',
        '嗨!我是小K智能助手 🤖\n\n擅长:\n✓ 量化交易与技术分析\n✓ 编程开发与问题排查\n✓ 知识解答与信息搜索\n✓ 数据计算与分析\n\n有什么想问的?',
        '你好呀!小K在线为您服务 ✨\n\n作为您的AI助手,我可以:\n• 分析股票行情与策略\n• 回答技术与编程问题\n• 提供知识咨询\n• 执行计算与数据处理\n\n有什么需要帮忙的吗?'
      ];
      const greeting = greetings[Math.floor(Math.random() * greetings.length)];
      // Record greeting interactions for training data
      try {
        trainingData.recordInteraction({
          userId: req.user?.id,
          sessionId: req.body.sessionId,
          messages: [{ role: 'user', content: safeQuestion }],
          response: greeting,
          model: '小K智能助手',
          intent: 'greeting',
          metadata: { source: 'web', adapter: 'predefined' },
        });
      } catch (recordErr) {
        console.error('[TrainingData] Record failed:', recordErr.message);
      }
      return res.json({
        success: true,
        answer: greeting,
        model: '小K智能助手',
        timestamp: Date.now()
      });
    }
    
    // Auto-detect bare stock code input and convert to a full analysis request
    if (bareStockCode) {
      try {
        const result = await stockAnalysisEngine.chat(resolvedStockCode, mergedContext, safeQuestion);
        return res.json({
          success: true,
          answer: result.answer,
          model: '小K智能助手',
          confidence: result.confidence,
          source: result.source,
          timestamp: result.timestamp
        });
      } catch (autoErr) {
        console.error('Auto stock code analysis failed:', autoErr);
        // Fall through to normal flow
      }
    }

    // Non-finance questions are still answered (no longer restricted to finance-only)
    // Note: isFinanceRelated() function below is kept for potential future use but not enforced
    
    // 使用小K金融量化助手(本地引擎)
    try {
      const result = await stockAnalysisEngine.chat(resolvedStockCode, mergedContext, safeQuestion);
      // Record interaction for training data collection
      try {
        trainingData.recordInteraction({
          userId: req.user?.id,
          sessionId: req.body.sessionId,
          messages: [{ role: 'user', content: safeQuestion }],
          response: result.answer,
          model: '小K智能助手',
          intent: result.source || 'general',
          metadata: { source: 'web', adapter: 'local-engine' },
        });
      } catch (recordErr) {
        console.error('[TrainingData] Record failed:', recordErr.message);
      }
      return res.json({
        success: true,
        answer: result.answer,
        model: '小K智能助手',
        confidence: result.confidence,
        source: result.source,
        timestamp: result.timestamp
      });
    } catch (engineError) {
      console.error('小K引擎调用失败:', engineError);
    }
    
    // 如果有Token,尝试使用云端AI
    if (tokens && Object.values(tokens).some(t => t && t.trim())) {
      try {
        const answer = await callCloudAI(resolvedStockCode, mergedContext, safeQuestion, tokens);
        try {
          trainingData.recordInteraction({
            userId: req.user?.id,
            sessionId: req.body.sessionId,
            messages: [{ role: 'user', content: safeQuestion }],
            response: answer,
            model: 'Cloud AI',
            intent: 'cloud-fallback',
            metadata: { source: 'web', adapter: 'cloud' },
          });
        } catch (recordErr) {
          console.error('[TrainingData] Record failed:', recordErr.message);
        }
        return res.json({
          success: true,
          answer: answer,
          model: 'Cloud AI',
          timestamp: Date.now()
        });
      } catch (error) {
        console.error('云端AI调用失败:', error);
      }
    }
    
    // 最后降级到预定义模式
    const answer = generatePredefinedAnswer(safeQuestion, mergedContext);
    res.json({
      success: true,
      answer: answer,
      model: '小K金融量化助手(简化模式)',
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error('AI对话错误:', error);
    res.status(500).json({
      success: false,
      message: '对话服务暂时不可用',
      error: error.message
    });
  }
});

// ---------------------------------------------------------------------------
// SSE streaming endpoint — returns AI response as Server-Sent Events.
//
// Event types:
//   start   — generation started, includes model name
//   control_request — adapter issued a control/permission request
//   chunk   — incremental text fragment
//   done    — final result with full content + usage info
//   error   — something went wrong
// ---------------------------------------------------------------------------
router.post('/chat/stream', authMiddleware, async (req, res) => {
  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // When the client navigates away mid-stream the socket closes. Stop writing
  // and tear down the heartbeat immediately so neither the 15s timer nor the
  // simulated-chunk loop keep pushing into a dead connection.
  let clientGone = false;
  const sendEvent = (data) => {
    if (clientGone) return;
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  const { question, stockCode, conversationHistory, tokens } = req.body;
  const safeQuestion = typeof question === 'string' ? question.trim() : '';

  if (!safeQuestion) {
    sendEvent({ type: 'error', message: 'Question is empty' });
    return res.end();
  }

  sendEvent({ type: 'start', model: 'auto', timestamp: Date.now() });

  // Keep-alive: send heartbeat every 15s while AI is processing,
  // so the frontend WebSocket and SSE connection don't think we're dead.
  const heartbeatTimer = setInterval(() => {
    try {
      sendEvent({ type: 'heartbeat', timestamp: Date.now() });
    } catch { /* connection may be closed */ }
  }, 15000);

  req.on('close', () => {
    clientGone = true;
    clearInterval(heartbeatTimer);
  });

  try {
    const gateway = require('../services/gateway/aiGateway');

    // Build system prompt for the conversation
    const system = `You are XiaoK, an intelligent AI assistant specializing in quantitative trading analysis. Answer in the user's language. Be concise, professional, and provide actionable insights. When discussing investments, always include risk warnings.`;

    const messages = [];
    if (Array.isArray(conversationHistory)) {
      for (const msg of conversationHistory.slice(-10)) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }
    messages.push({ role: 'user', content: safeQuestion });

    const result = await gateway.generate(safeQuestion, {
      system,
      messages,
      stockCode: stockCode || undefined,
      maxTokens: 2048,
      userId: req.user?.id,
      sessionId: req.body?.sessionId,
      preferredAdapter: req.body?.preferredAdapter || undefined,
      preferredModel: req.body?.preferredModel || undefined,
      onChunk: (chunk) => {
        if (!chunk) return;
        // Forward gateway status/heartbeat/channel events to SSE
        if (chunk.type === 'status') {
          sendEvent({ type: 'status', text: chunk.text || '', timestamp: Date.now() });
        } else if (chunk.type === 'heartbeat') {
          sendEvent({ type: 'heartbeat', text: chunk.text || '', timestamp: Date.now() });
        } else if (chunk.type === 'control_request') {
          sendEvent({
            type: 'control_request',
            requestId: String(chunk.requestId || chunk.id || '').trim(),
            request: chunk.request && typeof chunk.request === 'object' ? chunk.request : {},
            timestamp: Date.now(),
          });
        }
      },
    });

    // Dedup hit — return cached result directly
    if (result.deduplicated) {
      sendEvent({ type: 'chunk', content: result.content || '' });
      sendEvent({
        type: 'done',
        content: result.content || '',
        model: result.provider || 'AI',
        adapter: result.adapter || null,
        deduplicated: true,
      });
    } else if (result.success && result.content) {
      // Simulate streaming by chunking the completed response
      const content = result.content;
      const CHUNK_SIZE = 12; // characters per chunk
      for (let i = 0; i < content.length; i += CHUNK_SIZE) {
        sendEvent({ type: 'chunk', content: content.slice(i, i + CHUNK_SIZE) });
      }

      sendEvent({
        type: 'done',
        content: content,
        model: result.provider || result.model || 'AI',
        adapter: result.actualAdapter || result.adapter || null,
        usage: result.tokenUsage || null,
      });
    } else {
      // Gateway failed — fall back to stockAnalysisEngine
      const engineResult = await stockAnalysisEngine.chat(stockCode, {}, safeQuestion);
      const fallbackContent = engineResult.answer || 'No response available';

      const CHUNK_SIZE = 12;
      for (let i = 0; i < fallbackContent.length; i += CHUNK_SIZE) {
        sendEvent({ type: 'chunk', content: fallbackContent.slice(i, i + CHUNK_SIZE) });
      }

      sendEvent({
        type: 'done',
        content: fallbackContent,
        model: 'XiaoK Local',
        usage: null,
      });
    }
  } catch (err) {
    console.error('SSE stream error:', err);
    sendEvent({ type: 'error', message: err.message || 'Internal error' });
  } finally {
    clearInterval(heartbeatTimer);
  }

  res.end();
});

// 调用云端AI
async function callCloudAI(stockCode, analysisContext, question, tokens) {
  const axios = require('axios');
  
  // 构建系统Prompt
  const systemPrompt = `你是小K，一个智能AI助手，擅长量化交易分析，也能回答各类问题。

你的职责：
1. 回答用户的各类问题，包括但不限于金融、编程、知识、生活等
2. 当涉及股票投资时，基于分析结果提供专业、客观的见解
3. 解释技术指标、基本面数据和市场趋势
4. 对投资相关问题评估风险并给出建议

回答风格：
- 专业但易懂，避免过度专业术语
- 客观中立，不做绝对性判断
- 提供数据支持，引用分析结果
- 涉及投资时强调风险提示
- 回答简洁明了，重点突出

重要原则：
- 投资有风险，决策需谨慎
- 不保证收益，不承诺回报
- 投资建议仅供参考，不构成投资建议`;

  // 构建用户Prompt
  let userPrompt = `股票代码：${stockCode}\n`;
  userPrompt += `投资建议：${analysisContext.recommendation}\n`;
  userPrompt += `置信度：${analysisContext.confidence}%\n\n`;
  
  if (analysisContext.stockData) {
    userPrompt += `实时数据：\n`;
    userPrompt += `• 最新价：${analysisContext.stockData.latestPrice || '未知'}\n`;
    userPrompt += `• 涨跌幅：${analysisContext.stockData.changePercent || '未知'}%\n\n`;
  }
  
  userPrompt += `智能体分析结果：\n`;
  if (analysisContext.agentResults) {
    analysisContext.agentResults.forEach(agent => {
      userPrompt += `\n【${agent.agentName}】（评分 ${agent.score}/10）\n`;
      userPrompt += `${agent.analysis}\n`;
      if (agent.keyFindings && agent.keyFindings.length > 0) {
        userPrompt += `关键发现：${agent.keyFindings.join('、')}\n`;
      }
    });
  }
  
  userPrompt += `\n用户问题：${question}\n\n`;
  userPrompt += `请基于以上分析结果，用专业但易懂的语言回答用户的问题。回答要简洁明了，重点突出，并提供具体的操作建议。`;

  // 尝试各个AI提供商
  const providers = [
    {
      name: 'OpenAI',
      check: () => tokens.openai,
      call: async () => {
        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: MODELS.openaiDirect,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            temperature: 0.7,
            max_tokens: 800
          },
          {
            headers: {
              'Authorization': `Bearer ${tokens.openai}`,
              'Content-Type': 'application/json'
            },
            timeout: 15000
          }
        );
        return response.data.choices[0].message.content;
      }
    },
    {
      name: 'Claude',
      check: () => tokens.anthropic,
      call: async () => {
        const response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: MODELS.anthropicDirect,
            max_tokens: 800,
            messages: [
              { role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }
            ]
          },
          {
            headers: {
              'x-api-key': tokens.anthropic,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json'
            },
            timeout: 15000
          }
        );
        return response.data.content[0].text;
      }
    },
    {
      name: 'Gemini',
      check: () => tokens.google,
      call: async () => {
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${tokens.google}`,
          {
            contents: [{
              parts: [{
                text: `${systemPrompt}\n\n${userPrompt}`
              }]
            }]
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
          }
        );
        return response.data.candidates[0].content.parts[0].text;
      }
    },
    {
      name: '文心一言',
      check: () => tokens.baidu,
      call: async () => {
        // 文心一言需要先获取access_token
        const tokenResponse = await axios.post(
          `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${tokens.baidu}&client_secret=${tokens.baiduSecret || tokens.baidu}`
        );
        const accessToken = tokenResponse.data.access_token;
        
        const response = await axios.post(
          `https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions?access_token=${accessToken}`,
          {
            messages: [
              { role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }
            ]
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
          }
        );
        return response.data.result;
      }
    },
    {
      name: '通义千问',
      check: () => tokens.alibaba,
      call: async () => {
        const response = await axios.post(
          'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
          {
            model: MODELS.qwenDirect,
            input: {
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
              ]
            },
            parameters: {
              result_format: 'message'
            }
          },
          {
            headers: {
              'Authorization': `Bearer ${tokens.alibaba}`,
              'Content-Type': 'application/json'
            },
            timeout: 15000
          }
        );
        return response.data.output.choices[0].message.content;
      }
    },
    {
      name: '智谱AI',
      check: () => tokens.zhipu,
      call: async () => {
        // Default zhipu model flows through the gated SSoT leaf (glm-5.2 when the
        // KHY_GLM_LATEST_MODEL gate is on; byte-reverts to the legacy glm-4
        // MODELS.zhipuDirect when off / unavailable).
        let _zhipuModel = MODELS.zhipuDirect;
        try { _zhipuModel = require('../services/zhipuGlmModel').defaultZhipuModel() || _zhipuModel; } catch { /* fail-soft: keep legacy default */ }
        const response = await axios.post(
          'https://open.bigmodel.cn/api/paas/v4/chat/completions',
          {
            model: _zhipuModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ]
          },
          {
            headers: {
              'Authorization': `Bearer ${tokens.zhipu}`,
              'Content-Type': 'application/json'
            },
            timeout: 15000
          }
        );
        return response.data.choices[0].message.content;
      }
    }
  ];

  // 依次尝试可用的提供商
  for (const provider of providers) {
    if (provider.check()) {
      try {
        console.log(`🤖 尝试使用 ${provider.name}...`);
        const answer = await provider.call();
        console.log(`✅ ${provider.name} 调用成功`);
        return answer;
      } catch (error) {
        console.warn(`❌ ${provider.name} 调用失败:`, error.message);
        continue;
      }
    }
  }

  throw new Error('所有AI提供商均不可用，请检查Token配置');
}



// 生成预定义答案(简化模式)
function generatePredefinedAnswer(question, analysis) {
  const q = question.toLowerCase();
  
  // 关于推荐的问题
  if (q.includes('推荐') || q.includes('建议') || q.includes('买') || q.includes('卖')) {
    return `📊 根据分析结果:\n\n建议: ${analysis.recommendation}\n置信度: ${analysis.confidence}%\n\n${analysis.summary}\n\n⚠️ 投资有风险,建议结合自身情况谨慎决策。`;
  }
  
  // 关于风险的问题
  if (q.includes('风险') || q.includes('危险') || q.includes('安全')) {
    const riskAgent = analysis.agentResults?.find(a => a.agentId === 'risk');
    if (riskAgent) {
      return `⚠️ 风险评估:\n\n${riskAgent.analysis}\n\n建议:\n• 设置止损位\n• 控制仓位\n• 分散投资`;
    }
    return `⚠️ 风险提示:\n\n当前置信度: ${analysis.confidence}%\n\n建议:\n• 谨慎操作,注意风险控制\n• 不要满仓操作\n• 设置合理的止损位`;
  }
  
  // 关于技术面的问题
  if (q.includes('技术') || q.includes('指标') || q.includes('趋势')) {
    const marketAgent = analysis.agentResults?.find(a => a.agentId === 'market');
    if (marketAgent) {
      return `📈 技术分析:\n\n${marketAgent.analysis}\n\n建议查看完整的技术指标报告了解更多详情。`;
    }
    return `📈 技术分析:\n\n请查看市场分析师提供的详细技术分析报告,包含MACD、KDJ、RSI等多项指标。`;
  }
  
  // 关于基本面的问题
  if (q.includes('基本面') || q.includes('财务') || q.includes('估值')) {
    const fundAgent = analysis.agentResults?.find(a => a.agentId === 'fundamentals');
    if (fundAgent) {
      return `💼 基本面分析:\n\n${fundAgent.analysis}\n\n建议关注公司财报和行业动态。`;
    }
    return `💼 基本面分析:\n\n请查看基本面分析师提供的详细财务分析报告,包含PE、PB、ROE等估值指标。`;
  }
  
  // 默认回答
  return `关于 ${analysis.stockCode} 的分析:\n\n${analysis.summary}\n\n当前建议: ${analysis.recommendation}\n置信度: ${analysis.confidence}%\n\n💡 提示: 查看完整分析报告可了解更多详情。`;
}

// ── Persona (C2) ──
// Read-only summary of the active persona.md for the frontend Persona card.
// Returns headings + first lines only (never raw secrets — persona content is
// already injection-scanned by personaService on load).
router.get('/persona', (req, res) => {
  try {
    const personaService = require('../services/personaService');
    const summary = personaService.summarizePersona(process.cwd());
    res.json({ success: true, ...summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, present: false, sections: [] });
  }
});

module.exports = router;
