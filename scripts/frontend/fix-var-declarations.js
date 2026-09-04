#!/usr/bin/env node

/**
 * fix-var-declarations.js — 修复前端代码中的 var 声明
 * 
 * 将 var 声明替换为 const 或 let。
 * 
 * 用法:
 *   node scripts/frontend/fix-var-declarations.js                    # 预览模式
 *   node scripts/frontend/fix-var-declarations.js --apply            # 执行修复
 *   node scripts/frontend/fix-var-declarations.js --file <file>      # 处理单个文件
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
  
  // 排除的文件
  excludeFiles: [
    'mobilePage.js' // 包含嵌入式浏览器代码的模板文件
  ],
  
  // var 正则表达式
  varRegex: /\bvar\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g,
  
  // 需要保留的 var 声明（包含这些模式的语句不会被处理）
  keepPatterns: [
    '// keep',           // 显式标记为保留
    '// @var-keep',      // 显式标记为保留
    'var ',              // 在字符串中
    "'var ",             // 在字符串中
    '"var ',             // 在字符串中
  ]
};

/**
 * 递归获取目录中的所有文件
 */
function getFiles(dir, extensions, excludeDirs, excludeFiles) {
  const files = [];
  
  const items = fs.readdirSync(dir);
  
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      if (!excludeDirs.includes(item)) {
        files.push(...getFiles(fullPath, extensions, excludeDirs, excludeFiles));
      }
    } else if (extensions.includes(path.extname(item)) && !excludeFiles.includes(item)) {
      files.push(fullPath);
    }
  }
  
  return files;
}

/**
 * 检查是否应该保留该 var 声明
 */
function shouldKeepVar(line, patterns) {
  return patterns.some(pattern => line.includes(pattern));
}

/**
 * 分析变量是否被重新赋值
 */
function isReassigned(varName, lines, startLine) {
  // 简单的启发式检查：如果变量在后续行中被赋值，则使用 let
  const reassignmentPatterns = [
    new RegExp(`\\b${varName}\\s*=\\s*[^=]`, 'g'),  // 赋值
    new RegExp(`\\b${varName}\\s*\\+=`, 'g'),        // += 运算
    new RegExp(`\\b${varName}\\s*-=` , 'g'),         // -= 运算
    new RegExp(`\\b${varName}\\s*\\*=` , 'g'),       // *= 运算
    new RegExp(`\\b${varName}\\s*\\/=` , 'g'),       // /= 运算
    new RegExp(`\\b${varName}\\+\\+`, 'g'),          // ++ 运算
    new RegExp(`\\+\\+${varName}`, 'g'),             // ++ 运算
    new RegExp(`\\b${varName}--`, 'g'),              // -- 运算
    new RegExp(`--${varName}`, 'g'),                 // -- 运算
  ];
  
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of reassignmentPatterns) {
      if (pattern.test(line)) {
        return true;
      }
    }
  }
  
  return false;
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
    if (shouldKeepVar(line, CONFIG.keepPatterns)) {
      return line;
    }
    
    // 检查是否包含 var 声明
    const varMatch = line.match(/\bvar\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/);
    if (!varMatch) {
      return line;
    }
    
    const varName = varMatch[1];
    
    // 检查变量是否被重新赋值
    const needsLet = isReassigned(varName, lines, index + 1);
    const replacement = needsLet ? 'let' : 'const';
    
    // 替换 var 为 const/let
    const newLine = line.replace(/\bvar\s+/, replacement + ' ');
    
    modified = true;
    changes.push({
      line: index + 1,
      original: line.trim(),
      replaced: newLine.trim(),
      reason: needsLet ? 'reassigned' : 'not reassigned'
    });
    
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
function fixVarDeclarations(options = {}) {
  const { apply = false, file = null } = options;
  
  console.log(chalk.bold('\n🔧 前端 var 声明修复工具'));
  console.log(chalk.dim(`  模式: ${apply ? '执行' : '预览'}`));
  console.log(chalk.dim(`  策略: 根据变量是否被重新赋值，替换为 const 或 let`));
  
  let files = [];
  
  if (file) {
    // 处理单个文件
    files = [file];
  } else {
    // 处理所有目录
    for (const dir of CONFIG.directories) {
      const fullPath = path.resolve(dir);
      if (fs.existsSync(fullPath)) {
        files.push(...getFiles(fullPath, CONFIG.extensions, CONFIG.excludeDirs, CONFIG.excludeFiles));
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
        console.log(chalk.dim(`      原因: ${change.reason}`));
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
    console.log(chalk.green('\n✅ var 声明修复完成'));
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
  
  fixVarDeclarations(options);
}

module.exports = { fixVarDeclarations, processFile, getFiles };