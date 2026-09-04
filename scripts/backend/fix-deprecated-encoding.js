#!/usr/bin/env node

/**
 * fix-deprecated-encoding.js — 修复废弃服务文件中的编码问题
 * 
 * 将乱码的中文注释替换为正确的中文。
 * 
 * 用法:
 *   node scripts/backend/fix-deprecated-encoding.js           # 预览模式
 *   node scripts/backend/fix-deprecated-encoding.js --apply   # 执行修复
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 颜色输出
const chalk = {
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  cyan: (text) => `\x1b[36m${text}\x1b[0m`,
  dim: (text) => `\x1b[2m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
};

// 需要修复的文件列表
const DEPRECATED_FILES = [
  'akshareDataService.js',
  'akshareUpdater.js',
  'alternativeDataService.js',
  'backtestEngine.js',
  'cacheService.js',
  'changeRegressionGate.js',
  'comprehensiveDataService.js',
  'enhancedMockDataService.js',
  'finlightNewsService.js',
  'freeStockDataService.js',
  'instrumentService.js',
  'instrumentSyncService.js',
  'jsDataSources.js',
  'klineDataService.js',
  'marketDataService.js',
  'mlAgentService.js',
  'pythonDataSourceService.js',
  'pythonStrategyEngine.js',
  'realtimeDataService.js',
  'stockAnalysisEngine.js',
  'strategyEngine.js',
  'strategyRecommender.js',
  'tdxFormulaEngine.js',
  'tradingAgentsService.js'
];

// 标准废弃注释模板
const DEPRECATED_HEADER = `/**
 * @deprecated 2026-09-03 此文件是 quantApp 的兼容别名 shim，3 月后删除。
 * 如需使用，请改为 require('./domain/extensions/extensions/quantApp').loadModule('services/FILENAME')
 */`;

const DEPRECATED_COMMENT_1 = '// 兼容别名：核心不依赖 khyquant 的磁盘位置，只点名服务 quant-app（[DESIGN-ARCH-069] §3.4）';
const DEPRECATED_COMMENT_2 = '// 应用缺席时这里返回 null 而不是加载期抛出 MODULE_NOT_FOUND —— 那是 §4.1「删目录即卸载」的前提';

/**
 * 处理单个文件
 */
function processFile(filePath, options = {}) {
  const { apply = false } = options;
  
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  
  // 检查是否包含乱码
  const hasGarbled = content.includes('�') || content.includes('º') || content.includes('�');
  if (!hasGarbled) {
    return { file: filePath, modified: false, reason: 'No garbled characters found' };
  }
  
  const fileName = path.basename(filePath);
  const header = DEPRECATED_HEADER.replace('FILENAME', fileName);
  
  // 构建新的文件内容
  const newContent = `${header}
${DEPRECATED_COMMENT_1}
${DEPRECATED_COMMENT_2}
module.exports = require('./domain/extensions/extensions/quantApp').loadModule('services/${fileName}');
`;
  
  if (apply) {
    fs.writeFileSync(filePath, newContent, 'utf8');
  }
  
  return {
    file: filePath,
    modified: true,
    originalLength: content.length,
    newLength: newContent.length
  };
}

/**
 * 主函数
 */
function fixDeprecatedEncoding(options = {}) {
  const { apply = false } = options;
  
  console.log(chalk.bold('\n🔧 废弃服务文件编码修复工具'));
  console.log(chalk.dim(`  模式: ${apply ? '执行' : '预览'}`));
  console.log(chalk.dim(`  待处理文件: ${DEPRECATED_FILES.length} 个`));
  
  const results = [];
  let modifiedCount = 0;
  
  for (const fileName of DEPRECATED_FILES) {
    const filePath = path.resolve('services/backend/src/services', fileName);
    
    if (!fs.existsSync(filePath)) {
      results.push({ file: fileName, modified: false, reason: 'File not found' });
      continue;
    }
    
    const result = processFile(filePath, { apply });
    results.push(result);
    
    if (result.modified) {
      modifiedCount++;
    }
  }
  
  // 显示结果
  console.log(chalk.bold('\n📊 修复汇总'));
  console.log(chalk.dim(`  总文件数: ${DEPRECATED_FILES.length} 个`));
  console.log(chalk.dim(`  需要修复: ${modifiedCount} 个`));
  console.log(chalk.dim(`  无需修复: ${DEPRECATED_FILES.length - modifiedCount} 个`));
  
  if (modifiedCount > 0) {
    console.log(chalk.bold('\n📝 变更详情'));
    
    for (const result of results.filter(r => r.modified)) {
      console.log(chalk.green(`\n  ✓ ${result.file}`));
      if (result.originalLength) {
        console.log(chalk.dim(`    原长度: ${result.originalLength} 字符`));
        console.log(chalk.dim(`    新长度: ${result.newLength} 字符`));
      }
    }
  }
  
  if (!apply) {
    console.log(chalk.yellow('\n⚠️  这是预览模式，使用 --apply 参数执行实际修复'));
  } else {
    console.log(chalk.green('\n✅ 编码修复完成'));
  }
}

// CLI 入口
if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  
  fixDeprecatedEncoding({ apply });
}

module.exports = { fixDeprecatedEncoding, processFile };