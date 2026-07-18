'use strict';

/**
 * models.js (ai-backend) — 极薄转发层,直接复用主 backend 的模型名称单一真源。
 *
 * 历史问题:ai-backend 各 routes/adapters 与主 backend 各自硬编码同一批模型 id
 * (`gpt-3.5-turbo`/`claude-3-sonnet-20240229`/`qwen-turbo`/`glm-4`/`qwen2.5:7b`/
 * `claude-sonnet-4-20250514` …)。主 backend 已把模型名收归唯一真源
 * `constants/models.js`(按角色建具名数组,首项=当前生效首选),换模型只改一处;
 * 但 ai-backend 仍各写各的字面量 → 「改一处、处处漏」在两个服务间复发。这里不再
 * 自造数组,而是跨包 require 主 backend 的同一真源(与 utils/dataHome.js、
 * constants/serviceDefaults.js 复用 backend 单源同模式),让 ai-backend 与 backend
 * 永远引用同一组模型名。换模型只改 services/backend/src/constants/models.js。
 *
 * 用法:`const { PRIMARY: MODELS } = require('../constants/models');`
 * 然后 `MODELS.relay` / `MODELS.ollama` / `MODELS.openaiDirect` 取代裸模型 id 字面量。
 */

const path = require('path');

// 复用主 backend 的模型名单一真源(PRIMARY / 各具名数组 / primaryOf)。
// services/ai-backend/src/constants → ../../../backend/src/constants/models
//   = services/backend/src/constants/models
module.exports = require(path.resolve(__dirname, '../../../backend/src/constants/models'));
