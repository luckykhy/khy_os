'use strict';

/**
 * growthDataDir.js — 「growth 学习数据目录」单一真源。
 *
 * 收敛 src/services/ 下 4 处体逐字节相同、仅函数名不同的 `return getBaseDataDir('growth')`
 * (learningOverlay._overlayDir · learningProfile._profileDir ·
 *  learningImprove._findingsDir · learningCurriculum._progressDir):
 *   四者语义标签不同(overlay/profile/findings/progress)但物理解析同一目录 `~/.khyos/growth`。
 *   将 `'growth'` 子目录字面量集中于此单一真源,杜绝 4 处漂移。
 *
 * 契约:委托 utils/dataHome.getBaseDataDir('growth')。
 * **dataHome 依 KHY home 环境/文件系统解析——非纯**;边界隔离在 dataHome。
 *
 * 各消费方保留同名本地 `const _xxxDir = require('../utils/growthDataDir')` → 调用点逐字节不变。
 */

const { getBaseDataDir } = require('./dataHome');

function growthDataDir() {
  return getBaseDataDir('growth');
}

module.exports = growthDataDir;
