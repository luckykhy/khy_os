#!/usr/bin/env node

/**
 * fix-hardcoded-colors.js — 修复前端代码中的硬编码颜色
 * 
 * 将硬编码的颜色值替换为 CSS 变量。
 * 
 * 用法:
 *   node scripts/frontend/fix-hardcoded-colors.js                    # 预览模式
 *   node scripts/frontend/fix-hardcoded-colors.js --apply            # 执行修复
 *   node scripts/frontend/fix-hardcoded-colors.js --file <file>      # 处理单个文件
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

// 颜色映射表
const COLOR_MAP = {
  // 黑色系
  '#000': 'var(--khy-black)',
  '#000000': 'var(--khy-black)',
  '#0a0a0a': 'var(--khy-gray-900)',
  '#111': 'var(--khy-gray-900)',
  '#111111': 'var(--khy-gray-900)',
  '#1a1a1a': 'var(--khy-gray-900)',
  '#222': 'var(--khy-gray-800)',
  '#222222': 'var(--khy-gray-800)',
  '#333': 'var(--khy-gray-700)',
  '#333333': 'var(--khy-gray-700)',
  '#444': 'var(--khy-gray-600)',
  '#444444': 'var(--khy-gray-600)',
  '#555': 'var(--khy-gray-600)',
  '#555555': 'var(--khy-gray-600)',
  '#666': 'var(--khy-gray-500)',
  '#666666': 'var(--khy-gray-500)',
  '#777': 'var(--khy-gray-500)',
  '#777777': 'var(--khy-gray-500)',
  '#888': 'var(--khy-gray-400)',
  '#888888': 'var(--khy-gray-400)',
  '#999': 'var(--khy-gray-400)',
  '#999999': 'var(--khy-gray-400)',
  '#aaa': 'var(--khy-gray-300)',
  '#aaaaaa': 'var(--khy-gray-300)',
  '#bbb': 'var(--khy-gray-300)',
  '#bbbbbb': 'var(--khy-gray-300)',
  '#ccc': 'var(--khy-gray-200)',
  '#cccccc': 'var(--khy-gray-200)',
  '#ddd': 'var(--khy-gray-200)',
  '#dddddd': 'var(--khy-gray-200)',
  '#eee': 'var(--khy-gray-100)',
  '#eeeeee': 'var(--khy-gray-100)',
  '#f5f5f5': 'var(--khy-gray-50)',
  '#f9f9f9': 'var(--khy-gray-50)',
  '#fafafa': 'var(--khy-gray-50)',
  
  // 白色系
  '#fff': 'var(--khy-white)',
  '#ffffff': 'var(--khy-white)',
  
  // 蓝色系（主色调）
  '#1890ff': 'var(--khy-primary)',
  '#1989fa': 'var(--khy-primary)',
  '#1e90ff': 'var(--khy-primary)',
  '#2196f3': 'var(--khy-primary)',
  '#2962FF': 'var(--khy-primary)',
  '#3b82f6': 'var(--khy-primary)',
  '#409eff': 'var(--khy-primary)',
  '#409EFF': 'var(--khy-primary)',
  '#4a90e2': 'var(--khy-primary)',
  '#5b9bd5': 'var(--khy-primary)',
  '#64b5f6': 'var(--khy-primary-400)',
  '#90caf9': 'var(--khy-primary-300)',
  '#bbdefb': 'var(--khy-primary-200)',
  '#e3f2fd': 'var(--khy-primary-100)',
  '#eff6ff': 'var(--khy-primary-50)',
  
  // 绿色系（成功）
  '#00c853': 'var(--khy-success)',
  '#00e676': 'var(--khy-success)',
  '#10b981': 'var(--khy-success)',
  '#4caf50': 'var(--khy-success)',
  '#52c41a': 'var(--khy-success)',
  '#67c23a': 'var(--khy-success)',
  '#66bb6a': 'var(--khy-success)',
  '#81c784': 'var(--khy-success-300)',
  '#a5d6a7': 'var(--khy-success-200)',
  '#c8e6c9': 'var(--khy-success-100)',
  '#e8f5e9': 'var(--khy-success-50)',
  
  // 红色系（危险）
  '#d32f2f': 'var(--khy-danger)',
  '#e53935': 'var(--khy-danger)',
  '#ef4444': 'var(--khy-danger)',
  '#ef5350': 'var(--khy-danger)',
  '#f44336': 'var(--khy-danger)',
  '#f56c6c': 'var(--khy-danger)',
  '#ff5252': 'var(--khy-danger)',
  '#e57373': 'var(--khy-danger-300)',
  '#ef9a9a': 'var(--khy-danger-200)',
  '#ffcdd2': 'var(--khy-danger-100)',
  '#ffebee': 'var(--khy-danger-50)',
  
  // 黄色系（警告）
  '#f59e0b': 'var(--khy-warning)',
  '#f9a825': 'var(--khy-warning)',
  '#ff9800': 'var(--khy-warning)',
  '#ffa726': 'var(--khy-warning)',
  '#ffc107': 'var(--khy-warning)',
  '#ffeb3b': 'var(--khy-warning)',
  '#f7ba2a': 'var(--khy-warning)',
  '#ffcc02': 'var(--khy-warning)',
  '#fff176': 'var(--khy-warning-300)',
  '#fff59d': 'var(--khy-warning-200)',
  '#fff9c4': 'var(--khy-warning-100)',
  '#fffde7': 'var(--khy-warning-50)',
  
  // 青色系
  '#00bcd4': 'var(--khy-info)',
  '#0097a7': 'var(--khy-info)',
  '#00acc1': 'var(--khy-info)',
  '#26c6da': 'var(--khy-info-300)',
  '#4dd0e1': 'var(--khy-info-200)',
  '#b2ebf2': 'var(--khy-info-100)',
  '#e0f7fa': 'var(--khy-info-50)',
  
  // 特殊颜色（金融交易）
  '#67c23a': 'var(--khy-success)',  // 涨
  '#f56c6c': 'var(--khy-danger)',   // 跌
  '#409eff': 'var(--khy-primary)', // 平
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
  extensions: ['.css', '.scss', '.vue', '.js', '.ts'],
  
  // 排除的目录
  excludeDirs: ['node_modules', 'dist', '.git', '__tests__', 'tests'],
  
  // 颜色正则表达式
  colorRegex: /#([0-9a-fA-F]{3,8})\b/g,
  
  // 需要保留的颜色（包含这些模式的语句不会被处理）
  keepPatterns: [
    '// keep',           // 显式标记为保留
    '// @color-keep',    // 显式标记为保留
    'var(--',            // 已经是 CSS 变量
    'currentColor',      // 继承颜色
    'inherit',           // 继承
    'transparent',       // 透明
    'initial',           // 初始值
    'unset',             // 未设置
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
 * 检查是否应该保留该颜色
 */
function shouldKeepColor(line, patterns) {
  return patterns.some(pattern => line.includes(pattern));
}

/**
 * 标准化颜色值
 */
function normalizeColor(color) {
  // 移除空格
  color = color.trim();
  
  // 转换为小写
  color = color.toLowerCase();
  
  // 处理 3 位颜色值
  if (color.length === 4) {
    color = '#' + color[1] + color[1] + color[2] + color[2] + color[3] + color[3];
  }
  
  return color;
}

/**
 * 处理单个文件
 */
function processFile(filePath, options = {}) {
  const { apply = false } = options;
  
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  let modified = false;
  const changes = [];
  
  const newLines = lines.map((line, index) => {
    // 检查是否应该保留该行
    if (shouldKeepColor(line, CONFIG.keepPatterns)) {
      return line;
    }
    
    let newLine = line;
    let lineModified = false;
    
    // 查找所有颜色值
    const matches = line.match(CONFIG.colorRegex);
    if (!matches) {
      return line;
    }
    
    for (const match of matches) {
      const normalized = normalizeColor(match);
      const replacement = COLOR_MAP[normalized];
      
      if (replacement) {
        newLine = newLine.replace(new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), replacement);
        lineModified = true;
      }
    }
    
    if (lineModified) {
      modified = true;
      changes.push({
        line: index + 1,
        original: line.trim(),
        replaced: newLine.trim()
      });
    }
    
    return newLine;
  });
  
  if (modified && apply) {
    fs.writeFileSync(filePath, newLines.join('\n'), 'utf8');
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
function fixHardcodedColors(options = {}) {
  const { apply = false, file = null } = options;
  
  console.log(chalk.bold('\n🎨 前端硬编码颜色修复工具'));
  console.log(chalk.dim(`  模式: ${apply ? '执行' : '预览'}`));
  console.log(chalk.dim(`  颜色映射: ${Object.keys(COLOR_MAP).length} 个`));
  
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
    const result = processFile(filePath, { apply });
    if (result.modified) {
      results.push(result);
      totalChanges += result.changes.length;
    }
  }
  
  // 显示结果
  console.log(chalk.bold('\n📊 修复汇总'));
  console.log(chalk.dim(`  处理文件: ${files.length} 个`));
  console.log(chalk.dim(`  修改文件: ${results.length} 个`));
  console.log(chalk.dim(`  总变更数: ${totalChanges} 个`));
  
  if (results.length > 0) {
    console.log(chalk.bold('\n📝 变更详情'));
    
    for (const result of results.slice(0, 20)) { // 只显示前 20 个
      console.log(chalk.cyan(`\n  ${result.file}`));
      for (const change of result.changes.slice(0, 5)) { // 每个文件只显示前 5 个
        console.log(chalk.dim(`    第 ${change.line} 行:`));
        console.log(chalk.red(`      - ${change.original}`));
        console.log(chalk.green(`      + ${change.replaced}`));
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
    console.log(chalk.yellow('\n⚠️  这是预览模式，使用 --apply 参数执行实际修复'));
  } else {
    console.log(chalk.green('\n✅ 硬编码颜色修复完成'));
  }
}

// CLI 入口
if (require.main === module) {
  const args = process.argv.slice(2);
  
  const options = {
    apply: args.includes('--apply'),
    file: null
  };
  
  const fileIndex = args.indexOf('--file');
  if (fileIndex !== -1 && args[fileIndex + 1]) {
    options.file = args[fileIndex + 1];
  }
  
  fixHardcodedColors(options);
}

module.exports = { fixHardcodedColors, processFile, getFiles, COLOR_MAP };