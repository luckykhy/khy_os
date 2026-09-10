// khy.hdbDebug —— 鸿蒙 HDB 调试支持
//
// HDB (HarmonyOS Device Bridge) 是华为提供的鸿蒙设备调试工具
// 类似于 Android 的 ADB，用于：
// - 设备连接管理
// - 应用安装/卸载
// - 日志查看
// - 文件传输
// - Shell 命令执行
//
// 参考：华为开发者文档 HDB 工具使用指南

import { execLinuxCommand } from './linux.js';

/**
 * HDB 命令封装
 * 在已连接 HDB 的设备上执行调试命令
 */
class HDBDebugger {
  constructor() {
    this.connected = false;
    this.deviceId = null;
    this.hdbPath = 'hdb'; // 默认使用系统 PATH 中的 hdb
  }

  /**
   * 检查 HDB 是否可用
   */
  async isAvailable() {
    try {
      const result = await execLinuxCommand('which hdb 2>/dev/null || echo "NOT_FOUND"');
      return !result.output.includes('NOT_FOUND');
    } catch {
      return false;
    }
  }

  /**
   * 获取已连接设备列表
   */
  async listDevices() {
    try {
      const result = await execLinuxCommand('hdb list targets');
      const lines = result.output.split('\n').filter(Boolean);
      const devices = [];

      for (const line of lines) {
        const match = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
        if (match) {
          devices.push({
            id: match[1],
            status: match[2],
            description: match[3] || '',
          });
        }
      }

      return devices;
    } catch (error) {
      return [{ id: 'error', status: 'error', description: error.message }];
    }
  }

  /**
   * 连接设备
   */
  async connect(deviceId) {
    try {
      const result = await execLinuxCommand(`hdb connect ${deviceId}`);
      this.connected = result.output.includes('connected') || result.output.includes('success');
      if (this.connected) {
        this.deviceId = deviceId;
      }
      return this.connected;
    } catch {
      return false;
    }
  }

  /**
   * 断开连接
   */
  async disconnect() {
    try {
      await execLinuxCommand('hdb disconnect');
      this.connected = false;
      this.deviceId = null;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 执行 HDB 命令
   */
  async execute(command) {
    if (!this.connected) {
      throw new Error('HDB 未连接');
    }
    const result = await execLinuxCommand(`hdb -t ${this.deviceId} ${command}`);
    return result.output;
  }

  /**
   * 安装应用（HAP 包）
   */
  async installApp(hapPath) {
    return this.execute(`install "${hapPath}"`);
  }

  /**
   * 卸载应用
   */
  async uninstallApp(bundleName) {
    return this.execute(`uninstall ${bundleName}`);
  }

  /**
   * 获取设备信息
   */
  async getDeviceInfo() {
    const output = await this.execute('shell getprop');
    const info = {};

    const lines = output.split('\n');
    for (const line of lines) {
      const match = line.match(/^\[([^\]]+)\]:\s*\[([^\]]*)\]/);
      if (match) {
        info[match[1]] = match[2];
      }
    }

    return info;
  }

  /**
   * 获取日志
   */
  async getLogcat(options = {}) {
    const { lines = 100, filter = '' } = options;
    let cmd = `shell hilog -t ${lines}`;
    if (filter) {
      cmd += ` | grep "${filter}"`;
    }
    return this.execute(cmd);
  }

  /**
   * 文件传输 - 推送文件到设备
   */
  async pushFile(localPath, remotePath) {
    return this.execute(`file send "${localPath}" "${remotePath}"`);
  }

  /**
   * 文件传输 - 从设备拉取文件
   */
  async pullFile(remotePath, localPath) {
    return this.execute(`file recv "${remotePath}" "${localPath}"`);
  }

  /**
   * 执行 Shell 命令
   */
  async shell(command) {
    return this.execute(`shell ${command}`);
  }

  /**
   * 截图
   */
  async screenshot(savePath = '/data/local/tmp/screenshot.png') {
    await this.execute(`shell snapshot_display -f ${savePath}`);
    return savePath;
  }

  /**
   * 获取已安装应用列表
   */
  async listApps() {
    const output = await this.execute('shell bm dump -a');
    return output.split('\n').filter(Boolean);
  }
}

// 单例
let hdbInstance = null;

export function getHDBDebugger() {
  if (!hdbInstance) {
    hdbInstance = new HDBDebugger();
  }
  return hdbInstance;
}

export { HDBDebugger };
