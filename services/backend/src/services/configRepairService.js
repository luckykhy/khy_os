'use strict';

/**
 * configRepairService.js — 薄壳:读取、检测、修复、备份 .env 配置文件。
 *
 * 调用纯叶子 configRepairPolicy.js 的损坏检测与修复策略,处理 IO 操作。
 */

const fs = require('fs');
const path = require('path');
const { detectEnvCorruption, repairEnvLines } = require('./configRepairPolicy');

/**
 * 解析 .env 路径(复用 config.js 的逻辑)。
 * @returns {{canonicalPath: string, targets: string[]}}
 */
const _resolveEnvPaths = require('../utils/resolveGatewayEnvPaths');

/**
 * 检测并修复配置文件(如果损坏)。
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - 试运行模式,不实际写入
 * @param {object} [options.env] - 环境变量(用于门控)
 * @returns {{repaired: boolean, backupPath?: string, issues: Array, removed?: number}}
 *
 * 流程:
 *   1. 读取 .env 文件
 *   2. 检测损坏
 *   3. 若损坏:创建备份、修复、写回(除非 dryRun)
 *   4. 返回结果
 */
async function repairConfigIfNeeded(options = {}) {
  const opts = options || {};
  const dryRun = opts.dryRun || false;
  const env = opts.env || process.env;

  try {
    const { canonicalPath, targets } = _resolveEnvPaths();

    // 读取配置文件
    if (!fs.existsSync(canonicalPath)) {
      return {
        repaired: false,
        issues: [],
        error: `配置文件不存在: ${canonicalPath}`,
      };
    }

    const content = fs.readFileSync(canonicalPath, 'utf-8');
    const lines = content.split(/\r?\n/);

    // 检测损坏
    const detection = detectEnvCorruption(lines, { env });
    if (!detection.isCorrupted) {
      return {
        repaired: false,
        issues: [],
        message: '配置文件正常',
      };
    }

    // 修复
    const repair = repairEnvLines(lines, detection.issues, { env });
    if (repair.removed === 0) {
      return {
        repaired: false,
        issues: detection.issues,
        message: '未找到可修复的问题',
      };
    }

    if (dryRun) {
      return {
        repaired: false,
        dryRun: true,
        issues: detection.issues,
        removed: repair.removed,
        message: `试运行:将移除 ${repair.removed} 行`,
      };
    }

    // 创建备份
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const backupPath = `${canonicalPath}.broken-${timestamp}`;
    fs.writeFileSync(backupPath, content);

    // 写回修复后的内容
    const repairedContent = repair.repaired.join('\n') + '\n';
    for (const targetPath of targets) {
      fs.writeFileSync(targetPath, repairedContent);
    }

    return {
      repaired: true,
      backupPath,
      issues: detection.issues,
      removed: repair.removed,
      message: `已修复配置文件,移除 ${repair.removed} 行,备份: ${backupPath}`,
    };
  } catch (error) {
    return {
      repaired: false,
      issues: [],
      error: `修复失败: ${error.message}`,
    };
  }
}

module.exports = {
  repairConfigIfNeeded,
};
