#!/usr/bin/env node
/**
 * @pattern Strategy
 */
/**
 * 启动脚本：自动启动PostgreSQL数据库，然后启动后端服务
 * 使用方法：npm run start:db
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('========================================');
console.log('  启动后端服务（自动启动数据库）');
console.log('========================================\n');

// 检测PostgreSQL安装路径
function findPostgreSQLPath() {
  const possiblePaths = [
    'D:\\Program Files\\PostgreSQL\\18',
    'C:\\Program Files\\PostgreSQL\\18',
    'D:\\Program Files\\PostgreSQL\\17',
    'C:\\Program Files\\PostgreSQL\\17',
    'C:\\Program Files (x86)\\PostgreSQL\\18',
    'C:\\Program Files (x86)\\PostgreSQL\\17'
  ];

  for (const basePath of possiblePaths) {
    const pgCtlPath = path.join(basePath, 'bin', 'pg_ctl.exe');
    const pgDataPath = path.join(basePath, 'data');
    if (fs.existsSync(pgCtlPath) && fs.existsSync(pgDataPath)) {
      return { pgCtlPath, pgDataPath, basePath };
    }
  }

  return null;
}

// 检查PostgreSQL服务状态
function checkPostgreSQLStatus(pgCtlPath, pgDataPath) {
  return new Promise((resolve) => {
    exec(`"${pgCtlPath}" status -D "${pgDataPath}"`, (error) => {
      resolve(!error); // 如果没有错误，说明服务在运行
    });
  });
}

// 启动PostgreSQL服务
function startPostgreSQL(pgCtlPath, pgDataPath) {
  return new Promise((resolve, reject) => {
    console.log('正在启动 PostgreSQL 服务...');
    
    const startProcess = spawn(pgCtlPath, ['start', '-D', pgDataPath, '-w', '-t', '30'], {
      stdio: 'inherit'
    });

    startProcess.on('exit', (code) => {
      if (code === 0) {
        console.log('✓ PostgreSQL 服务启动成功\n');
        // 等待3秒确保服务完全启动
        setTimeout(() => resolve(), 3000);
      } else {
        reject(new Error(`PostgreSQL 启动失败，退出码: ${code}`));
      }
    });

    startProcess.on('error', (error) => {
      reject(error);
    });
  });
}

// 启动后端服务
function startBackend() {
  console.log('========================================');
  console.log('  启动后端服务');
  console.log('========================================\n');

  const nodemonPath = path.join(__dirname, 'node_modules', '.bin', 'nodemon');
  const serverPath = path.join(__dirname, 'server.js');

  // 检查是否有nodemon
  const useNodemon = fs.existsSync(nodemonPath);
  const command = useNodemon ? nodemonPath : 'node';
  const args = [serverPath];

  const backendProcess = spawn(command, args, {
    stdio: 'inherit',
    shell: true
  });

  backendProcess.on('error', (error) => {
    console.error('启动后端失败:', error);
    process.exit(1);
  });

  // 处理退出信号
  process.on('SIGINT', () => {
    console.log('\n正在停止后端服务...');
    backendProcess.kill();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    backendProcess.kill();
    process.exit(0);
  });
}

// 主函数
async function main() {
  try {
    console.log('[步骤 1/3] 检测 PostgreSQL...\n');

    const pgPaths = findPostgreSQLPath();

    if (!pgPaths) {
      console.log('⚠ PostgreSQL 未安装或未找到');
      console.log('将直接启动后端，但可能会连接失败\n');
      startBackend();
      return;
    }

    console.log(`✓ 找到 PostgreSQL: ${pgPaths.basePath}\n`);

    console.log('[步骤 2/3] 检查 PostgreSQL 服务状态...\n');

    const isRunning = await checkPostgreSQLStatus(pgPaths.pgCtlPath, pgPaths.pgDataPath);

    if (isRunning) {
      console.log('✓ PostgreSQL 服务已在运行\n');
    } else {
      console.log('PostgreSQL 服务未运行\n');
      await startPostgreSQL(pgPaths.pgCtlPath, pgPaths.pgDataPath);
    }

    console.log('[步骤 3/3] 启动后端服务...\n');
    startBackend();

  } catch (error) {
    console.error('❌ 错误:', error.message);
    console.log('\n尝试直接启动后端...\n');
    startBackend();
  }
}

// 运行
main();
