/**
 * 通达信Python引擎桥接器
 * 
 * 通过子进程调用Python引擎执行通达信策略
 */

const { spawn } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
const path = require('path');

class TdxPythonBridge {
  constructor() {
    this.pythonScript = path.join(__dirname, 'tdxPythonEngine.py');
  }

  /**
   * 执行策略回测
   */
  async execute(code, klineData, options = {}) {
    return new Promise((resolve, reject) => {
      // 准备输入数据
      const inputData = {
        code,
        klineData,
        options: {
          initialCapital: options.initialCapital || 90000,
          commission: options.commission || 0.0003
        }
      };

      // 启动Python进程
      const pythonCmd = require('../utils/pythonPath').findPython();
      let python;
      try {
        python = spawn(pythonCmd, [this.pythonScript], {
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (spawnError) {
        console.error('❌ 无法启动Python进程:', spawnError.message);
        reject(new Error(`Python不可用: ${spawnError.message}`));
        return;
      }

      let stdout = '';
      let stderr = '';
      let _settled = false;

      // Activity-aware idle timeout: this runs a user strategy fed via stdin;
      // a looping/hung strategy would otherwise never be killed.
      let _idleTimer = null;
      const IDLE_MS = 120000;
      const _clearIdle = () => { if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; } };
      const _resetIdle = () => {
        _clearIdle();
        _idleTimer = setTimeout(() => {
          if (_settled) return;
          _settled = true;
          if (python && !python.killed) safeKill(python);
          reject(new Error(`Python策略空闲超时（${IDLE_MS / 1000}s 内无输出）`));
        }, IDLE_MS);
      };
      _resetIdle();

      // 🔥 添加错误事件监听器
      python.on('error', (error) => {
        if (_settled) return;
        _settled = true;
        _clearIdle();
        console.error('❌ Python进程错误:', error.message);
        reject(new Error(`Python进程错误: ${error.message}`));
      });

      // 收集输出
      python.stdout.on('data', (data) => {
        stdout += data.toString();
        _resetIdle();
      });

      python.stderr.on('data', (data) => {
        stderr += data.toString();
        _resetIdle();
      });

      // 处理完成
      python.on('close', (code) => {
        if (_settled) return;
        _settled = true;
        _clearIdle();
        // 显示调试信息
        if (stderr) {
          console.error('Python调试输出:', stderr);
        }

        if (code !== 0) {
          console.error('Python引擎错误:', stderr);
          reject(new Error(`Python引擎执行失败: ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          
          if (result.error) {
            reject(new Error(`策略执行错误: ${result.error}`));
            return;
          }

          resolve(result);
        } catch (error) {
          console.error('解析Python输出失败:', stdout);
          reject(new Error(`解析结果失败: ${error.message}`));
        }
      });

      // 发送输入数据
      python.stdin.write(JSON.stringify(inputData));
      python.stdin.end();
    });
  }

  /**
   * 检查Python环境
   */
  async checkPythonEnvironment() {
    return new Promise((resolve) => {
      const pythonCmd = require('../utils/pythonPath').findPython();
      let python;
      try {
        python = spawn(pythonCmd, ['--version']);
      } catch (spawnError) {
        console.error('❌ 无法启动Python进程:', spawnError.message);
        resolve({
          available: false,
          error: spawnError.message
        });
        return;
      }
      
      let output = '';
      
      // 🔥 添加错误事件监听器
      python.on('error', (error) => {
        console.error('❌ Python进程错误:', error.message);
        resolve({
          available: false,
          error: error.message
        });
      });
      
      python.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      python.stderr.on('data', (data) => {
        output += data.toString();
      });
      
      python.on('close', (code) => {
        if (code === 0) {
          resolve({
            available: true,
            version: output.trim()
          });
        } else {
          resolve({
            available: false,
            error: 'Python未安装或不在PATH中'
          });
        }
      });
      
      python.on('error', () => {
        resolve({
          available: false,
          error: 'Python未安装或不在PATH中'
        });
      });
    });
  }
}

module.exports = TdxPythonBridge;
