'use strict';

/**
 * DataLocation.js — 数据位置抽象层
 *
 * 提供统一的数据路径解析，解决 ~/.khy 与 ~/.khyquant 双栖问题。
 *
 * 设计（对抗式综合方案 C）：
 *   - 目标：统一到 ~/.khy（新数据），兼容 ~/.khyquant（旧数据）
 *   - 策略：运行时按需透明迁移，不强制，老用户零感知
 *   - 迁移状态标记：~/.khy/.migration-complete
 *
 * 使用方式：
 *   const { getUserDataPath } = require('./DataLocation');
 *   const configPath = getUserDataPath('config.json');
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 迁移状态文件路径
const MIGRATION_STATUS_FILE = path.join(os.homedir(), '.khy', '.migration-complete');

/**
 * 获取 ~/.khy（Khy-OS 标准数据目录）。
 * @returns {string}
 */
function getKhyHome() {
  return path.join(os.homedir(), '.khy');
}

/**
 * 获取 ~/.khyquant（遗留数据目录）。
 * @returns {string}
 */
function getKhyquantHome() {
  return path.join(os.homedir(), '.khyquant');
}

/**
 * 检查遗留目录是否有真实数据。
 * @returns {boolean}
 */
function hasLegacyData() {
  const legacy = getKhyquantHome();
  try {
    if (!fs.existsSync(legacy)) return false;
    const files = fs.readdirSync(legacy);
    // 有文件且不是只有 .gitignore 之类的占位符
    return files.length > 1 || (files.length === 1 && !files[0].startsWith('.'));
  } catch {
    return false;
  }
}

/**
 * 检查迁移是否已完成。
 * @returns {boolean}
 */
function isMigrationComplete() {
  try {
    return fs.existsSync(MIGRATION_STATUS_FILE);
  } catch {
    return false;
  }
}

/**
 * 标记迁移完成。
 */
function markMigrationComplete() {
  try {
    const khyHome = getKhyHome();
    fs.mkdirSync(khyHome, { recursive: true });
    fs.writeFileSync(MIGRATION_STATUS_FILE, new Date().toISOString(), 'utf-8');
  } catch {
    // 非阻塞
  }
}

/**
 * 透明迁移：如果目标不存在但遗留目录有数据，则复制。
 * @param {string} dataType 数据类型（如 'config.json', 'skills', 'credentials'）
 * @returns {boolean} 是否执行了迁移
 */
function migrateIfNeeded(dataType) {
  const targetPath = path.join(getKhyHome(), dataType);
  const legacyPath = path.join(getKhyquantHome(), dataType);
  
  try {
    // 目标已存在，无需迁移
    if (fs.existsSync(targetPath)) return false;
    
    // 遗留目录无此数据，无需迁移
    if (!fs.existsSync(legacyPath)) return false;
    
    // 执行复制
    const stat = fs.statSync(legacyPath);
    if (stat.isDirectory()) {
      fs.cpSync(legacyPath, targetPath, { recursive: true });
    } else {
      fs.copyFileSync(legacyPath, targetPath);
    }
    
    console.log(`[DataLocation] 已迁移 ${dataType} 从 ~/.khyquant 到 ~/.khy`);
    return true;
  } catch (err) {
    console.warn(`[DataLocation] 迁移 ${dataType} 失败: ${err.message}`);
    return false;
  }
}

/**
 * 获取用户数据路径（主要 API）。
 *
 * 解析顺序：
 *   1. ~/.khy/<dataType>（标准位置）
 *   2. ~/.khyquant/<dataType>（遗留位置，如果存在且未迁移）
 *   3. 返回 ~/.khy/<dataType>（默认，即使不存在）
 *
 * @param {string} dataType 数据路径（如 'config.json', 'credentials/admin.json'）
 * @returns {string} 绝对路径
 */
function getUserDataPath(dataType) {
  const khyHome = getKhyHome();
  const targetPath = path.join(khyHome, dataType);
  
  // 如果迁移已完成，直接使用标准位置
  if (isMigrationComplete()) {
    return targetPath;
  }
  
  // 如果标准位置存在，直接使用
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }
  
  // 如果遗留位置存在，透明迁移
  const legacyHome = getKhyquantHome();
  const legacyPath = path.join(legacyHome, dataType);
  
  if (fs.existsSync(legacyPath)) {
    migrateIfNeeded(dataType);
    return targetPath; // 迁移后返回新位置
  }
  
  return targetPath;
}

/**
 * 获取用户数据目录。
 * @param {...string} segments 相对路径段
 * @returns {string} 绝对路径（目录已创建）
 */
function getUserDataDir(...segments) {
  const dir = path.join(getKhyHome(), ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 获取数据目录状态报告。
 * 用于 `khy doctor` 中的"数据目录健康检查"。
 * @returns {object} 状态报告
 */
function getStorageStatus() {
  const khyHome = getKhyHome();
  const khyquantHome = getKhyquantHome();
  
  const khyExists = fs.existsSync(khyHome);
  const khyquantExists = fs.existsSync(khyquantHome);
  const migrationComplete = isMigrationComplete();
  
  return {
    standard: {
      path: khyHome,
      exists: khyExists,
      migrationComplete,
    },
    legacy: {
      path: khyquantHome,
      exists: khyquantExists,
      hasData: hasLegacyData(),
    },
    healthy: khyExists && (migrationComplete || !khyquantExists),
    recommendation: _getRecommendation(khyExists, khyquantExists, migrationComplete),
  };
}

/**
 * 生成健康建议。
 */
function _getRecommendation(khyExists, khyquantExists, migrationComplete) {
  if (!khyExists && !khyquantExists) {
    return '数据目录尚未初始化，将使用默认位置 ~/.khy';
  }
  if (khyquantExists && !migrationComplete) {
    return '检测到遗留数据目录 ~/.khyquant，建议运行 khy migrate-data 完成迁移';
  }
  if (migrationComplete) {
    return '数据目录已统一到 ~/.khy';
  }
  return '数据目录状态正常';
}

module.exports = {
  getKhyHome,
  getKhyquantHome,
  hasLegacyData,
  isMigrationComplete,
  markMigrationComplete,
  migrateIfNeeded,
  getUserDataPath,
  getUserDataDir,
  getStorageStatus,
};
