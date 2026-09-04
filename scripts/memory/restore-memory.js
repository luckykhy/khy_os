#!/usr/bin/env node

/**
 * restore-memory.js — khy-os 记忆恢复脚本
 * 
 * 从归档中恢复记忆文件。
 * 
 * 用法:
 *   node scripts/memory/restore-memory.js                    # 列出所有可恢复的记忆
 *   node scripts/memory/restore-memory.js --file <filename>  # 恢复指定文件
 *   node scripts/memory/restore-memory.js --all              # 恢复所有归档记忆
 *   node scripts/memory/restore-memory.js --type feedback    # 恢复指定类型的记忆
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 路径配置
const ROOT_DIR = path.resolve(__dirname, '../..');
const MEMORY_DIR = path.join(ROOT_DIR, '.khy/memory');
const ARCHIVE_DIR = path.join(MEMORY_DIR, '.archive');
const SKILLS_DIR = path.join(ROOT_DIR, '.khy/skills');
const SKILLS_ARCHIVE_DIR = path.join(SKILLS_DIR, '.archive');
const SESSIONS_DIR = path.join(ROOT_DIR, '.khy/sessions');
const SESSIONS_ARCHIVE_DIR = path.join(SESSIONS_DIR, '.archive');

// 颜色输出
const chalk = {
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  cyan: (text) => `\x1b[36m${text}\x1b[0m`,
  dim: (text) => `\x1b[2m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
};

/**
 * 确保目录存在
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 获取归档文件列表
 */
function listArchivedFiles(archiveDir, type = null) {
  if (!fs.existsSync(archiveDir)) {
    return [];
  }
  
  const files = fs.readdirSync(archiveDir)
    .filter(f => f.endsWith('.md') || f.endsWith('.json') || f.endsWith('.jsonl'));
  
  if (type) {
    return files.filter(f => f.startsWith(type));
  }
  
  return files;
}

/**
 * 恢复单个文件
 */
function restoreFile(archiveDir, targetDir, filename) {
  const src = path.join(archiveDir, filename);
  const dest = path.join(targetDir, filename);
  
  if (!fs.existsSync(src)) {
    console.log(chalk.red(`  ✗ 文件不存在: ${filename}`));
    return false;
  }
  
  // 如果目标已存在，添加时间戳
  if (fs.existsSync(dest)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(filename);
    const name = path.basename(filename, ext);
    const destWithTimestamp = path.join(targetDir, `${name}_${timestamp}${ext}`);
    fs.renameSync(src, destWithTimestamp);
    console.log(chalk.yellow(`  ⚠ 目标已存在，恢复为: ${path.basename(destWithTimestamp)}`));
  } else {
    fs.renameSync(src, dest);
  }
  
  return true;
}

/**
 * 列出可恢复的记忆
 */
function listRecoverableMemories() {
  console.log(chalk.bold('\n📋 可恢复的记忆\n'));
  
  // 核心记忆
  const memoryFiles = listArchivedFiles(ARCHIVE_DIR);
  if (memoryFiles.length > 0) {
    console.log(chalk.cyan('  核心记忆 (.khy/memory/.archive/):'));
    memoryFiles.forEach(f => {
      const stats = fs.statSync(path.join(ARCHIVE_DIR, f));
      const size = (stats.size / 1024).toFixed(2);
      const time = stats.mtime.toISOString().split('T')[0];
      console.log(chalk.dim(`    - ${f} (${size} KB, ${time})`));
    });
  } else {
    console.log(chalk.dim('  核心记忆: 无可恢复文件'));
  }
  
  // 学习缓存
  const skillsFiles = listArchivedFiles(SKILLS_ARCHIVE_DIR);
  if (skillsFiles.length > 0) {
    console.log(chalk.cyan('\n  学习缓存 (.khy/skills/.archive/):'));
    skillsFiles.forEach(f => {
      const stats = fs.statSync(path.join(SKILLS_ARCHIVE_DIR, f));
      const size = (stats.size / 1024).toFixed(2);
      const time = stats.mtime.toISOString().split('T')[0];
      console.log(chalk.dim(`    - ${f} (${size} KB, ${time})`));
    });
  } else {
    console.log(chalk.dim('\n  学习缓存: 无可恢复文件'));
  }
  
  // 会话数据
  const sessionFiles = listArchivedFiles(SESSIONS_ARCHIVE_DIR);
  if (sessionFiles.length > 0) {
    console.log(chalk.cyan('\n  会话数据 (.khy/sessions/.archive/):'));
    sessionFiles.forEach(f => {
      const stats = fs.statSync(path.join(SESSIONS_ARCHIVE_DIR, f));
      const size = (stats.size / 1024).toFixed(2);
      const time = stats.mtime.toISOString().split('T')[0];
      console.log(chalk.dim(`    - ${f} (${size} KB, ${time})`));
    });
  } else {
    console.log(chalk.dim('\n  会话数据: 无可恢复文件'));
  }
  
  console.log(chalk.dim('\n恢复命令:'));
  console.log(chalk.dim('  node scripts/memory/restore-memory.js --file <filename>'));
  console.log(chalk.dim('  node scripts/memory/restore-memory.js --all'));
  console.log(chalk.dim('  node scripts/memory/restore-memory.js --type feedback'));
}

/**
 * 恢复指定文件
 */
function restoreSpecificFile(filename) {
  console.log(chalk.bold(`\n🔄 恢复文件: ${filename}`));
  
  // 检查核心记忆归档
  if (fs.existsSync(path.join(ARCHIVE_DIR, filename))) {
    ensureDir(MEMORY_DIR);
    if (restoreFile(ARCHIVE_DIR, MEMORY_DIR, filename)) {
      console.log(chalk.green(`  ✓ 已从核心记忆归档恢复: ${filename}`));
      return true;
    }
  }
  
  // 检查学习缓存归档
  if (fs.existsSync(path.join(SKILLS_ARCHIVE_DIR, filename))) {
    ensureDir(SKILLS_DIR);
    if (restoreFile(SKILLS_ARCHIVE_DIR, SKILLS_DIR, filename)) {
      console.log(chalk.green(`  ✓ 已从学习缓存归档恢复: ${filename}`));
      return true;
    }
  }
  
  // 检查会话数据归档
  if (fs.existsSync(path.join(SESSIONS_ARCHIVE_DIR, filename))) {
    ensureDir(SESSIONS_DIR);
    if (restoreFile(SESSIONS_ARCHIVE_DIR, SESSIONS_DIR, filename)) {
      console.log(chalk.green(`  ✓ 已从会话数据归档恢复: ${filename}`));
      return true;
    }
  }
  
  console.log(chalk.red(`  ✗ 未找到文件: ${filename}`));
  return false;
}

/**
 * 恢复所有归档记忆
 */
function restoreAllMemories() {
  console.log(chalk.bold('\n🔄 恢复所有归档记忆\n'));
  
  let restored = 0;
  
  // 恢复核心记忆
  const memoryFiles = listArchivedFiles(ARCHIVE_DIR);
  if (memoryFiles.length > 0) {
    console.log(chalk.cyan('  恢复核心记忆:'));
    ensureDir(MEMORY_DIR);
    for (const file of memoryFiles) {
      if (restoreFile(ARCHIVE_DIR, MEMORY_DIR, file)) {
        restored++;
        console.log(chalk.green(`    ✓ ${file}`));
      }
    }
  }
  
  // 恢复学习缓存
  const skillsFiles = listArchivedFiles(SKILLS_ARCHIVE_DIR);
  if (skillsFiles.length > 0) {
    console.log(chalk.cyan('\n  恢复学习缓存:'));
    ensureDir(SKILLS_DIR);
    for (const file of skillsFiles) {
      if (restoreFile(SKILLS_ARCHIVE_DIR, SKILLS_DIR, file)) {
        restored++;
        console.log(chalk.green(`    ✓ ${file}`));
      }
    }
  }
  
  // 恢复会话数据
  const sessionFiles = listArchivedFiles(SESSIONS_ARCHIVE_DIR);
  if (sessionFiles.length > 0) {
    console.log(chalk.cyan('\n  恢复会话数据:'));
    ensureDir(SESSIONS_DIR);
    for (const file of sessionFiles) {
      if (restoreFile(SESSIONS_ARCHIVE_DIR, SESSIONS_DIR, file)) {
        restored++;
        console.log(chalk.green(`    ✓ ${file}`));
      }
    }
  }
  
  console.log(chalk.bold(`\n📊 恢复汇总: ${restored} 个文件`));
  
  if (restored > 0) {
    console.log(chalk.green('\n✅ 记忆恢复完成'));
  } else {
    console.log(chalk.dim('\n没有需要恢复的记忆'));
  }
}

/**
 * 恢复指定类型的记忆
 */
function restoreByType(type) {
  console.log(chalk.bold(`\n🔄 恢复类型: ${type}`));
  
  let restored = 0;
  
  // 恢复核心记忆中的指定类型
  const memoryFiles = listArchivedFiles(ARCHIVE_DIR, type);
  if (memoryFiles.length > 0) {
    console.log(chalk.cyan(`  恢复核心记忆 (${type}):`));
    ensureDir(MEMORY_DIR);
    for (const file of memoryFiles) {
      if (restoreFile(ARCHIVE_DIR, MEMORY_DIR, file)) {
        restored++;
        console.log(chalk.green(`    ✓ ${file}`));
      }
    }
  }
  
  console.log(chalk.bold(`\n📊 恢复汇总: ${restored} 个文件`));
  
  if (restored > 0) {
    console.log(chalk.green('\n✅ 记忆恢复完成'));
  } else {
    console.log(chalk.dim('\n没有需要恢复的记忆'));
  }
}

/**
 * 主函数
 */
function restoreMemory(options = {}) {
  const { file, all, type } = options;
  
  if (file) {
    restoreSpecificFile(file);
  } else if (all) {
    restoreAllMemories();
  } else if (type) {
    restoreByType(type);
  } else {
    listRecoverableMemories();
  }
}

// CLI 入口
if (require.main === module) {
  const args = process.argv.slice(2);
  
  const options = {
    file: null,
    all: false,
    type: null,
  };
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      options.file = args[i + 1];
      i++;
    } else if (args[i] === '--all') {
      options.all = true;
    } else if (args[i] === '--type' && args[i + 1]) {
      options.type = args[i + 1];
      i++;
    }
  }
  
  restoreMemory(options);
}

module.exports = { 
  restoreMemory, 
  listRecoverableMemories, 
  restoreSpecificFile, 
  restoreAllMemories,
  restoreByType
};