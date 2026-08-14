'use strict';

/**
 * dataHome.js (ai-backend) — 极薄转发层，直接复用主 backend 的数据家解析器。
 *
 * 历史问题:ai-backend 各服务各自 `path.join(os.homedir(), '.khyquant')` 直写 legacy
 * 目录,而主 backend 经 getAppHome() 已收敛到 ~/.khy(legacy 既存优先)。同一守护进程
 * 里两套根并存 → 全新 HOME 上出现 .khy / .khyquant 双写。这里不再自造解析逻辑,而是
 * 跨包 require 主 backend 的单一真源(与 pluginService.js 复用 backend 服务同模式),
 * 让 ai-backend 与 backend 永远落在同一数据家。
 *
 * 用法:`const { getAppHome, getAppDataDir, getLegacyDataHome } = require('../utils/dataHome');`
 * 然后 `getAppDataDir('api_keys.json')` 取代 `path.join(os.homedir(), '.khyquant', 'api_keys.json')`。
 */

const path = require('path');

// 复用主 backend 的 dataHome 单一真源(getAppHome/getAppDataDir/getLegacyDataHome 等)。
// services/ai-backend/src/utils → ../../../backend/src/utils/dataHome = services/backend/src/utils/dataHome
module.exports = require(path.resolve(__dirname, '../../../backend/src/utils/dataHome'));
