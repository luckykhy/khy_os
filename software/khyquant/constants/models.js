'use strict';

/**
 * models.js — khyquant 层对后端 SSOT 的重新导出。
 *
 * 单一真源始终是 services/backend/src/constants/models.js。
 * 本文件仅作透传，换模型只需修改后端版本。
 *
 * 用法: const { PRIMARY: MODELS } = require('../constants/models');
 */

const path = require('path');

module.exports = require(path.resolve(__dirname, '../../../services/backend/src/constants/models'));
