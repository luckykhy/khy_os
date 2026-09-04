#!/usr/bin/env node

/**
 * clear-memory.js — khy-os 记忆清空脚本
 * 
 * 安全清空记忆系统，所有操作可恢复。
 * 
 * 用法:
 *   node scripts/memory/clear-memory.js          # 预览模式（dry-run）
 *   node scripts/memory/clear-memory.js --apply  # 执行清空
 *   node scripts/memory/clear-memory.js --level p0  # 只清理 P0 优先级
 * 
 * 恢复命令:
 *   khy memory distill restore [filename]
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 路径配置
const ROOT_DIR = path.resolve(__dirname, '../..');
const MEMORY_DIR = path.join(ROOT_DIR, '.khy/memory');
const ARCHIVE_DIR = path.join(MEMORY_DIR, '.archive');
const GROWTH_DIR = path.join(ROOT_DIR, '.khy/growth');
const SKILLS_DIR = path.join(ROOT_DIR, '.khy/skills');
const TRAINING_DIR = path.join(ROOT_DIR, '.khy/training');
const SESSIONS_DIR = path.join(ROOT_DIR, '.khy/sessions');

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
 * 安全删除文件（移到回收站或归档）
 */
function safeDelete(filePath, archiveDir) {
  if (!fs.existsSync(filePath)) return false;
  
  const filename = path.basename(filePath);
  const dest = path.join(archiveDir, filename);
  
  // 如果目标已存在，添加时间戳
  if (fs.existsSync(dest)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(filename);
    const name = path.basename(filename, ext);
    const destWithTimestamp = path.join(archiveDir, `${name}_${timestamp}${ext}`);
    fs.renameSync(filePath, destWithTimestamp);
  } else {
    fs.renameSync(filePath, dest);
  }
  
  return true;
}

/**
 * P0: 归档核心记忆文件
 */
function archiveMemoryFiles(dryRun) {
  console.log(chalk.bold('\n📦 P0: 归档核心记忆文件'));
  
  if (!fs.existsSync(MEMORY_DIR)) {
    console.log(chalk.dim('  记忆目录不存在，跳过'));
    return 0;
  }
  
  ensureDir(ARCHIVE_DIR);
  
  const files = fs.readdirSync(MEMORY_DIR)
    .filter(f => f.endsWith('.md') && f !== 'MEMORY.md' && !f.startsWith('.'));
  
  if (files.length === 0) {
    console.log(chalk.dim('  没有需要归档的记忆文件'));
    return 0;
  }
  
  console.log(chalk.dim(`  找到 ${files.length} 个记忆文件`));
  
  if (dryRun) {
    console.log(chalk.yellow('  [预览] 将归档以下文件:'));
    files.forEach(f => console.log(chalk.dim(`    - ${f}`)));
    return files.length;
  }
  
  let archived = 0;
  for (const file of files) {
    const src = path.join(MEMORY_DIR, file);
    if (safeDelete(src, ARCHIVE_DIR)) {
      archived++;
    }
  }
  
  console.log(chalk.green(`  ✓ 已归档 ${archived} 个记忆文件`));
  return archived;
}

/**
 * P0: 重置 MEMORY.md 为模板
 */
function resetMemoryIndex(dryRun) {
  console.log(chalk.bold('\n📝 P0: 重置 MEMORY.md'));
  
  const memoryIndex = path.join(MEMORY_DIR, 'MEMORY.md');
  
  if (dryRun) {
    console.log(chalk.yellow('  [预览] 将重置 MEMORY.md 为模板'));
    return;
  }
  
  const template = `# 记忆索引

> 本文件由记忆系统自动维护，记录所有持久化记忆的索引。

## 记忆列表

*暂无记忆*

---
*最后更新: ${new Date().toISOString()}*
`;
  
  ensureDir(MEMORY_DIR);
  fs.writeFileSync(memoryIndex, template, 'utf8');
  console.log(chalk.green('  ✓ 已重置 MEMORY.md'));
}

/**
 * P0: 重置成长数据
 */
function resetGrowthData(dryRun) {
  console.log(chalk.bold('\n📈 P0: 重置成长数据'));
  
  if (!fs.existsSync(GROWTH_DIR)) {
    console.log(chalk.dim('  成长目录不存在，跳过'));
    return;
  }
  
  const initialStructures = {
    'agent_memory.json': {
      version: 1,
      sharedContext: {
        currentMarketRegime: 'unknown',
        recentSignals: [],
        crossAgentInsights: [],
        lastUpdated: null,
        responseStyles: []
      }
    },
    'agent_specialization.json': { domains: [], updated: null },
    'analysis_patterns.json': { patterns: [], updated: null },
    'habits.json': { habits: [], updated: null },
    'knowledge.json': { items: [], updated: null },
    'skills_learned.json': { skills: [], updated: null },
    'skill_usage.json': { usage: [], updated: null },
    'strategy_performance.json': { strategies: [], updated: null },
    'user_knowledge_base.json': { items: [], updated: null },
    'user_preferences.json': { preferences: [], updated: null }
  };
  
  const files = Object.keys(initialStructures).filter(f => 
    fs.existsSync(path.join(GROWTH_DIR, f))
  );
  
  if (files.length === 0) {
    console.log(chalk.dim('  没有需要重置的成长数据文件'));
    return;
  }
  
  console.log(chalk.dim(`  找到 ${files.length} 个成长数据文件`));
  
  if (dryRun) {
    console.log(chalk.yellow('  [预览] 将重置以下文件:'));
    files.forEach(f => console.log(chalk.dim(`    - ${f}`)));
    return;
  }
  
  for (const file of files) {
    const filePath = path.join(GROWTH_DIR, file);
    const structure = initialStructures[file];
    fs.writeFileSync(filePath, JSON.stringify(structure, null, 2), 'utf8');
  }
  
  console.log(chalk.green(`  ✓ 已重置 ${files.length} 个成长数据文件`));
}

/**
 * P1: 归档学习缓存
 */
function archiveSkillsCache(dryRun) {
  console.log(chalk.bold('\n📚 P1: 归档学习缓存'));
  
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log(chalk.dim('  学习缓存目录不存在，跳过'));
    return 0;
  }
  
  const files = fs.readdirSync(SKILLS_DIR)
    .filter(f => f.startsWith('learn-') && f.endsWith('.md'));
  
  if (files.length === 0) {
    console.log(chalk.dim('  没有需要归档的学习缓存'));
    return 0;
  }
  
  console.log(chalk.dim(`  找到 ${files.length} 个学习缓存文件`));
  
  if (dryRun) {
    console.log(chalk.yellow('  [预览] 将归档以下文件:'));
    files.forEach(f => console.log(chalk.dim(`    - ${f}`)));
    return files.length;
  }
  
  const archiveDir = path.join(SKILLS_DIR, '.archive');
  ensureDir(archiveDir);
  
  let archived = 0;
  for (const file of files) {
    const src = path.join(SKILLS_DIR, file);
    if (safeDelete(src, archiveDir)) {
      archived++;
    }
  }
  
  console.log(chalk.green(`  ✓ 已归档 ${archived} 个学习缓存文件`));
  return archived;
}

/**
 * P1: 清空训练数据
 */
function clearTrainingData(dryRun) {
  console.log(chalk.bold('\n🎯 P1: 清空训练数据'));
  
  if (!fs.existsSync(TRAINING_DIR)) {
    console.log(chalk.dim('  训练数据目录不存在，跳过'));
    return 0;
  }
  
  const files = fs.readdirSync(TRAINING_DIR)
    .filter(f => f.endsWith('.jsonl'));
  
  if (files.length === 0) {
    console.log(chalk.dim('  没有需要清空的训练数据'));
    return 0;
  }
  
  console.log(chalk.dim(`  找到 ${files.length} 个训练数据文件`));
  
  if (dryRun) {
    console.log(chalk.yellow('  [预览] 将清空以下文件:'));
    files.forEach(f => console.log(chalk.dim(`    - ${f}`)));
    return files.length;
  }
  
  for (const file of files) {
    const filePath = path.join(TRAINING_DIR, file);
    fs.writeFileSync(filePath, '', 'utf8');
  }
  
  console.log(chalk.green(`  ✓ 已清空 ${files.length} 个训练数据文件`));
  return files.length;
}

/**
 * P2: 清理会话数据
 */
function cleanSessionData(dryRun) {
  console.log(chalk.bold('\n💬 P2: 清理会话数据'));
  
  let cleaned = 0;
  
  // 清理会话目录
  if (fs.existsSync(SESSIONS_DIR)) {
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl') || f.endsWith('.json'));
    
    if (files.length > 0) {
      console.log(chalk.dim(`  找到 ${files.length} 个会话文件`));
      
      if (dryRun) {
        console.log(chalk.yellow('  [预览] 将清理以下文件:'));
        files.forEach(f => console.log(chalk.dim(`    - ${f}`)));
      } else {
        const archiveDir = path.join(SESSIONS_DIR, '.archive');
        ensureDir(archiveDir);
        
        for (const file of files) {
          const src = path.join(SESSIONS_DIR, file);
          if (safeDelete(src, archiveDir)) {
            cleaned++;
          }
        }
        console.log(chalk.green(`  ✓ 已清理 ${cleaned} 个会话文件`));
      }
    } else {
      console.log(chalk.dim('  没有需要清理的会话文件'));
    }
  }
  
  // 重置 profile.json
  const profilePath = path.join(ROOT_DIR, '.khy/profile.json');
  if (fs.existsSync(profilePath)) {
    if (dryRun) {
      console.log(chalk.yellow('  [预览] 将重置 profile.json'));
    } else {
      fs.writeFileSync(profilePath, '{}', 'utf8');
      console.log(chalk.green('  ✓ 已重置 profile.json'));
    }
  }
  
  return cleaned;
}

/**
 * 主函数
 */
function clearMemory(options = {}) {
  const { dryRun = true, level = 'all' } = options;
  
  console.log(chalk.bold('\n🧹 khy-os 记忆清空系统'));
  console.log(chalk.dim(`  模式: ${dryRun ? '预览 (dry-run)' : '执行 (apply)'}`));
  console.log(chalk.dim(`  级别: ${level.toUpperCase()}`));
  
  const stats = {
    memoryFiles: 0,
    growthFiles: 0,
    skillsFiles: 0,
    trainingFiles: 0,
    sessionFiles: 0,
  };
  
  // 按优先级执行清理
  if (level === 'all' || level === 'p0') {
    stats.memoryFiles = archiveMemoryFiles(dryRun);
    resetMemoryIndex(dryRun);
    resetGrowthData(dryRun);
  }
  
  if (level === 'all' || level === 'p1') {
    stats.skillsFiles = archiveSkillsCache(dryRun);
    stats.trainingFiles = clearTrainingData(dryRun);
  }
  
  if (level === 'all' || level === 'p2') {
    stats.sessionFiles = cleanSessionData(dryRun);
  }
  
  // 汇总
  console.log(chalk.bold('\n📊 清理汇总'));
  console.log(chalk.dim(`  记忆文件: ${stats.memoryFiles} 个`));
  console.log(chalk.dim(`  成长数据: ${stats.growthFiles} 个`));
  console.log(chalk.dim(`  学习缓存: ${stats.skillsFiles} 个`));
  console.log(chalk.dim(`  训练数据: ${stats.trainingFiles} 个`));
  console.log(chalk.dim(`  会话数据: ${stats.sessionFiles} 个`));
  
  if (dryRun) {
    console.log(chalk.yellow('\n⚠️  这是预览模式，使用 --apply 参数执行实际操作'));
    console.log(chalk.dim('恢复命令: khy memory distill restore [filename]'));
  } else {
    console.log(chalk.green('\n✅ 记忆清空完成'));
    console.log(chalk.dim('恢复命令: khy memory distill restore [filename]'));
  }
}

// CLI 入口
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');
  const levelArg = args.find(a => a.startsWith('--level='));
  const level = levelArg ? levelArg.split('=')[1] : 'all';
  
  clearMemory({ dryRun, level });
}

module.exports = { 
  clearMemory, 
  archiveMemoryFiles, 
  resetMemoryIndex, 
  resetGrowthData,
  archiveSkillsCache,
  clearTrainingData,
  cleanSessionData
};