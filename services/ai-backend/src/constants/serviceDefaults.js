'use strict';

/**
 * serviceDefaults.js (ai-backend) — 云端点等外部服务默认值的单一真源转发层。
 *
 * 历史问题:ai-backend 是独立目录树,各处自行 `process.env.KHY_CLOUD_ENDPOINT ||
 * 'https://api.khyquant.top'` 重复硬编码生产域名(如 skillRegistry.getRegistryEndpoint),
 * 域名迁移 / 自托管时会漏改。这里不再各自硬编码,而是跨包 require 主 backend 的
 * constants/serviceDefaults.js 单一真源(与 ../utils/dataHome 复用 backend 同模式),
 * 让 CLOUD_DEFAULT_ENDPOINT / TELEMETRY_DEFAULT_ENDPOINT / CLOUD_DEFAULT_HOST 等
 * 永远只有一处字面量(backend/src/constants/serviceDefaults.js),迁移只改那一处。
 *
 * 注:本文件路径以 `constants/serviceDefaults.js` 结尾,会被 scripts/check-agent-rules.js
 * 的 isSourceOfTruth 识别为单一真源而豁免;但它本身不含任何域名字面量(只做转发)。
 */

const path = require('path');

// services/ai-backend/src/constants → ../../../backend/src/constants/serviceDefaults
module.exports = require(path.resolve(__dirname, '../../../backend/src/constants/serviceDefaults'));
