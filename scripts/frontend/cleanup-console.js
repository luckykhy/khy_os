#!/usr/bin/env node

/**
 * cleanup-console.js — 清理前端代码中的 console.log 语句
 * 
 * 将 console.log/warn/error 包装在 import.meta.env.DEV 检查中，
 * 或者完全移除（根据配置）。
 * 
 * 用法:
 *   node scripts/frontend/cleanup-console.js                    # 预览模式
 *   node scripts/frontend/cleanup-console.js --apply            # 执行清理
 *   node scripts/frontend/cleanup-console.js --remove           # 完全移除
 *   node scripts/frontend/cleanup-console.js --file <file>      # 处理单个文件
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

// 配置
const CONFIG = {
  // 需要处理的目录
  directories: [
    'software/khyquant/frontend/src',
    'apps/ai-frontend/src',
    'apps/khy-mobile/src'
  ],
  
  // 需要处理的文件扩展名
  extensions: ['.js', '.vue', '.ts'],
  
  // 排除的目录
  excludeDirs: ['node_modules', 'dist', '.git', '__tests__', 'tests'],
  
  // console 方法
  consoleMethods: ['log', 'warn', 'error', 'info', 'debug'],
  
  // 需要保留的 console 语句（包含这些模式的语句不会被处理）
  keepPatterns: [
    'console.error',  // 错误日志通常需要保留
    'console.warn',   // 警告日志通常需要保留
    '// keep',        // 显式标记为保留
    '// @console-keep' // 显式标记为保留
  ]
};

/**
 * 递归获取目录中的所有文件
 */
function getFiles(dir, extensions, excludeDirs) {
  const files = [];
  
  const items = fs.readdirSync(dir);
  
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      if (!excludeDirs.includes(item)) {
        files.push(...getFiles(fullPath, extensions, excludeDirs));
      }
    } else if (extensions.includes(path.extname(item))) {
      files.push(fullPath);
    }
  }
  
  return files;
}

/**
 * 检查是否应该保留该 console 语句
 */
function shouldKeepConsole(line, patterns) {
  return patterns.some(pattern => line.includes(pattern));
}

/**
 * 处理单个文件
 */
function processFile(filePath, options = {}) {
  const { apply = false, remove = false } = options;
  
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  let modified = false;
  const changes = [];
  
  const newLines = lines.map((line, index) => {
    const trimmedLine = line.trim();
    
    // 检查是否包含 console 调用
    const consoleMatch = trimmedLine.match(/console\.(log|warn|error|info|debug)\s*\(/);
    if (!consoleMatch) {
      return line;
    }
    
    const consoleMethod = consoleMatch[1];
    
    // 检查是否应该保留
    if (shouldKeepConsole(line, CONFIG.keepPatterns)) {
      return line;
    }
    
    // 检查是否已经被保护
    if (line.includes('import.meta.env.DEV') || line.includes('process.env.NODE_ENV')) {
      return line;
    }
    
    modified = true;
    const lineNum = index + 1;
    
    if (remove) {
      // 完全移除
      changes.push({
        line: lineNum,
        action: 'removed',
        content: trimmedLine
      });
      return null; // 返回 null 表示删除该行
    } else {
      // 包装在 DEV 检查中
      const indent = line.match(/^(\s*)/)[1];
      const wrappedLine = `${indent}if (import.meta.env.DEV) { ${trimmedLine} }`;
      
      changes.push({
        line: lineNum,
        action: 'wrapped',
        content: trimmedLine
      });
      
      return wrappedLine;
    }
  });
  
  if (modified && apply) {
    // 过滤掉 null 行（删除的行）
    const filteredLines = newLines.filter(line => line !== null);
    fs.writeFileSync(filePath, filteredLines.join('\n'), 'utf8');
  }
  
  return {
    file: filePath,
    modified,
    changes
  };
}

/**
 * 主函数
 */
function cleanupConsole(options = {}) {
  const { apply = false, remove = false, file = null } = options;
  
  console.log(chalk.bold('\n🧹 前端 console 清理工具'));
  console.log(chalk.dim(`  模式: ${apply ? '执行' : '预览'}`));
  console.log(chalk.dim(`  策略: ${remove ? '完全移除' : '包装在 DEV 检查中'}`));
  
  let files = [];
  
  if (file) {
    // 处理单个文件
    files = [file];
  } else {
    // 处理所有目录
    for (const dir of CONFIG.directories) {
      const fullPath = path.resolve(dir);
      if (fs.existsSync(fullPath)) {
        files.push(...getFiles(fullPath, CONFIG.extensions, CONFIG.excludeDirs));
      }
    }
  }
  
  console.log(chalk.dim(`  找到 ${files.length} 个文件`));
  
  let totalChanges = 0;
  const results = [];
  
  for (const filePath of files) {
    const result = processFile(filePath, { apply, remove });
    if (result.modified) {
      results.push(result);
      totalChanges += result.changes.length;
    }
  }
  
  // 显示结果
  console.log(chalk.bold('\n📊 清理汇总'));
  console.log(chalk.dim(`  处理文件: ${files.length} 个`));
  console.log(chalk.dim(`  修改文件: ${results.length} 个`));
  console.log(chalk.dim(`  总变更数: ${totalChanges} 个`));
  
  if (results.length > 0) {
    console.log(chalk.bold('\n📝 变更详情'));
    
    for (const result of results.slice(0, 20)) { // 只显示前 20 个
      console.log(chalk.cyan(`\n  ${result.file}`));
      for (const change of result.changes.slice(0, 5)) { // 每个文件只显示前 5 个
        console.log(chalk.dim(`    第 ${change.line} 行: ${change.action}`));
        console.log(chalk.dim(`      ${change.content}`));
      }
      if (result.changes.length > 5) {
        console.log(chalk.dim(`    ... 还有 ${result.changes.length - 5} 个变更`));
      }
    }
    
    if (results.length > 20) {
      console.log(chalk.dim(`\n  ... 还有 ${results.length - 20} 个文件`));
    }
  }
  
  if (!apply) {
    console.log(chalk.yellow('\n⚠️  这是预览模式，使用 --apply 参数执行实际清理'));
    console.log(chalk.dim('使用 --remove 参数完全移除 console 语句'));
  } else {
    console.log(chalk.green('\n✅ console 清理完成'));
  }
}

// CLI 入口
if (require.main === module) {
  const args = process.argv.slice(2);
  
  const options = {
    apply: args.includes('--apply'),
    remove: args.includes('--remove'),
    file: null
  };
  
  const fileIndex = args.indexOf('--file');
  if (fileIndex !== -1 && args[fileIndex + 1]) {
    options.file = args[fileIndex + 1];
  }
  
  cleanupConsole(options);
}

module.exports = { cleanupConsole, processFile, getFiles };