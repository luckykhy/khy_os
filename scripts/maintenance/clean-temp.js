#!/usr/bin/env node
/**
 * 清理临时文件
 * 用法：node clean-temp.js [--apply]
 * 
 * 默认干跑，只打印将删除的文件与体积
 * 加 --apply 才真删
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();

// 临时文件模式（排除 node_modules 和 .git）
const TEMP_PATTERNS = [
  'tmp-*',
  '*.tmp',
  '*.log',
  'coverage/',
  '.nyc_output/',
  'dist/',
  'build/',
  '*.egg-info/',
];

console.log('🔍 扫描临时文件...\n');

let totalSize = 0;
let fileCount = 0;

TEMP_PATTERNS.forEach(pattern => {
  // 使用 PowerShell 的 Get-ChildItem 替代 find
  let cmd;
  if (process.platform === 'win32') {
    cmd = `Get-ChildItem -Path . -Filter "${pattern}" -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch "node_modules|\\.git" } | Select-Object -ExpandProperty FullName`;
  } else {
    cmd = `find . -name "${pattern}" -not -path "./node_modules/*" -not -path "./.git/*" -type f`;
  }
  
  try {
    const output = execSync(cmd, { encoding: 'utf8', shell: true }).trim();
    if (output) {
      output.split('\n').forEach(file => {
        file = file.trim();
        if (file && file.length > 0) {
          const fullPath = path.join(ROOT, file);
          try {
            if (fs.existsSync(fullPath)) {
              const stat = fs.statSync(fullPath);
              totalSize += stat.size;
              fileCount++;
              
              if (APPLY) {
                fs.rmSync(fullPath, { recursive: true, force: true });
                console.log(`  🗑️  删除: ${file}`);
              } else {
                console.log(`  📄 ${file} (${(stat.size / 1024).toFixed(1)} KB)`);
              }
            }
          } catch (e) {
            // 文件可能已被删除或无权限
          }
        }
      });
    }
  } catch (e) {
    // 命令可能失败（无匹配文件）
  }
});

console.log(`\n📊 统计: ${fileCount} 个文件, ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

if (!APPLY) {
  console.log('\n💡 运行 `node scripts/maintenance/clean-temp.js --apply` 执行清理');
} else {
  console.log('\n✅ 清理完成');
}
