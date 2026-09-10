// khy.linux —— 嵌入式 Linux 环境接口（Alpine + PRoot）
//
// 功能：
// - 检查 Linux 环境状态
// - 解压 rootfs（首次运行）
// - 在 Linux 环境中执行 shell 命令
//
// 使用流程：
// 1. getStatus() 检查是否已就绪
// 2. 如果未就绪，调用 extractRootfs() 解压
// 3. exec(command) 执行命令

import { registerPlugin } from '@capacitor/core';

const Linux = registerPlugin('Linux', {
  web: () => ({
    getStatus: () => Promise.resolve({ rootfsExtracted: false, prootAvailable: false, ready: false }),
    extractRootfs: () => Promise.reject(new Error('Linux 插件仅在 Android 上可用')),
    exec: () => Promise.reject(new Error('Linux 插件仅在 Android 上可用')),
  }),
});

/**
 * 获取 Linux 环境状态
 * @returns {Promise<{rootfsExtracted: boolean, prootAvailable: boolean, ready: boolean, rootfsPath: string}>}
 */
export async function getLinuxStatus() {
  return Linux.getStatus();
}

/**
 * 解压 Linux rootfs（首次运行或重置时调用）
 * @returns {Promise<{success: boolean, message: string, path: string}>}
 */
export async function extractLinuxRootfs() {
  return Linux.extractRootfs();
}

/**
 * 在 Linux 环境中执行 shell 命令
 * @param {string} command - 要执行的命令
 * @returns {Promise<{output: string, success: boolean}>}
 */
export async function execLinuxCommand(command) {
  return Linux.exec({ command });
}

/**
 * 确保 Linux 环境已就绪（自动解压如果需要）
 * @returns {Promise<boolean>}
 */
export async function ensureLinuxReady() {
  let status = await getLinuxStatus();
  if (status.ready) return true;

  // 需要解压
  const result = await extractLinuxRootfs();
  if (!result.success) {
    throw new Error(`Linux 环境初始化失败: ${result.message}`);
  }

  // 再次检查状态
  status = await getLinuxStatus();
  return status.ready;
}

export default Linux;
