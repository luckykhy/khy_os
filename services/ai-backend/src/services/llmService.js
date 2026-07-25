// 安全加载：ai-backend 可能不含 multiFreeService，回退到 backend 路径
const path = require('path');
let MultiFreeService;
try {
  MultiFreeService = require('./multiFreeService');
} catch {
  try {
    MultiFreeService = require(path.resolve(__dirname, '../../../../backend/src/services/multiFreeService'));
  } catch {
    // 无可用 LLM 服务时返回空壳，避免顶层崩溃
    MultiFreeService = class MultiFreeServiceStub {
      async generateResponse() { return { success: false, content: '', error: 'MultiFreeService 不可用' }; }
    };
  }
}

module.exports = MultiFreeService;
