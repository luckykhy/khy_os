/**
 * Config Guard — JSON 配置文件损坏自动恢复服务
 *
 * 提供 safeReadJson / safeWriteJson 包装，防止 JSON.parse 失败导致功能不可用。
 * 损坏时自动从 .bak 恢复；.bak 也损坏时返回 schema 默认值并标记降级启动。
 *
 * 【特性】
 * - 三步原子写入：先写 .tmp → rename 原文件为 .bak → rename .tmp 到原文件
 * - 解析失败时自动尝试 .bak 恢复
 * - 双重损坏时返回 schema 默认值
 * - 每次恢复写入 healAudit 审计记录
 *
 * 【一期覆盖文件】
 * settings.json, api_keys.json, session.json, preferences.json, custom_providers.json
 */

const fs = require('fs');
const path = require('path');
const { writeHealAudit } = require('../utils/healAudit');
const { atomicWriteText } = require('../utils/atomicWriteJson');

/**
 * 安全读取 JSON 文件，自动恢复损坏内容
 *
 * @param {string} filePath - 完整文件路径
 * @param {object} [options]
 * @param {object} [options.schema] - JSON Schema 或默认值对象
 * @param {boolean} [options.createIfMissing=true] - 文件不存在时是否创建
 * @param {boolean} [options.silent=false] - 是否静默模式（不写 audit）
 * @returns {Promise<{data: any, wasHealed: boolean, source: 'main'|'backup'|'default'}>}
 */
async function safeReadJson(filePath, options = {}) {
  const { schema = null, createIfMissing = true, silent = false } = options;
  const bakPath = `${filePath}.bak`;

  let result = {
    data: null,
    wasHealed: false,
    source: 'main',
  };

  // 1. 尝试读取主文件
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      result.data = JSON.parse(raw);
      return result;
    } catch (parseError) {
      // 主文件损坏，尝试从备份恢复
      if (!silent) {
        await writeHealAudit({
          action: 'config_corrupted_detected',
          target: path.basename(filePath),
          reason: 'JSON.parse failed on main file',
          details: {
            filePath,
            error: parseError.message,
          },
          message: `检测到配置文件损坏: ${path.basename(filePath)}`,
        });
      }

      // 2. 尝试读取 .bak 备份
      if (fs.existsSync(bakPath)) {
        try {
          const bakRaw = fs.readFileSync(bakPath, 'utf-8');
          const bakData = JSON.parse(bakRaw);

          // 备份有效，恢复到主文件
          try {
            fs.copyFileSync(bakPath, filePath);
            result.data = bakData;
            result.wasHealed = true;
            result.source = 'backup';

            if (!silent) {
              await writeHealAudit({
                action: 'config_restored_from_backup',
                target: path.basename(filePath),
                reason: 'main file corrupted, backup valid',
                details: {
                  filePath,
                  bakPath,
                },
                message: `已从备份恢复配置文件: ${path.basename(filePath)}`,
              });
            }

            return result;
          } catch (restoreError) {
            // 恢复写入失败，但至少可以返回备份数据
            result.data = bakData;
            result.wasHealed = false; // 未能写回主文件
            result.source = 'backup';

            if (!silent) {
              await writeHealAudit({
                action: 'config_restore_failed',
                target: path.basename(filePath),
                reason: 'backup valid but restore write failed',
                details: {
                  filePath,
                  error: restoreError.message,
                },
                message: `备份有效但恢复写入失败: ${path.basename(filePath)}`,
              });
            }

            return result;
          }
        } catch (bakParseError) {
          // 备份也损坏
          if (!silent) {
            await writeHealAudit({
              action: 'config_backup_also_corrupted',
              target: path.basename(filePath),
              reason: 'both main and backup files corrupted',
              details: {
                filePath,
                mainError: parseError.message,
                bakError: bakParseError.message,
              },
              message: `主文件和备份均损坏: ${path.basename(filePath)}`,
            });
          }

          // 主文件 + 备份双损 = configGuard 的 L1 手段全部用尽(下面只能退回 schema 默认值,
          // 用户的真实配置事实上已经丢了)。交给升级链:L2 跑 freshInstallDoctor(断链重建 /
          // 数据指针校准),仍不行则 L3 写 .khy/heal_escalation.json + 终端告警。
          // fail-soft:升级链绝不影响本函数「返回默认值让程序继续跑」的既有行为。
          try {
            await require('./healEscalationService').escalate({
              component: 'configGuard',
              trigger: 'config-guard-double-corrupt',
              context: { filePath, bakPath },
              failedAttempts: [
                { step: 'read_main', error: parseError.message || 'json_parse_failed' },
                { step: 'read_backup', error: bakParseError.message || 'json_parse_failed' },
              ],
            });
          } catch {
            /* 升级链自身失败绝不阻断配置读取 */
          }
        }
      }

      // 3. 双重损坏或无备份，返回 schema 默认值
      if (schema) {
        result.data = typeof schema === 'function' ? schema() : (schema.default || schema);
        result.wasHealed = false;
        result.source = 'default';

        if (!silent) {
          await writeHealAudit({
            action: 'config_fallback_to_default',
            target: path.basename(filePath),
            reason: 'no valid backup, using schema default',
            details: {
              filePath,
            },
            message: `使用默认配置: ${path.basename(filePath)}`,
          });
        }

        return result;
      }

      // 无 schema 且双重损坏，抛出错误
      throw new Error(`Config file corrupted and no backup available: ${filePath}`);
    }
  }

  // 4. 文件不存在
  if (createIfMissing && schema) {
    result.data = typeof schema === 'function' ? schema() : (schema.default || schema);
    result.wasHealed = false;
    result.source = 'default';

    // 创建初始文件
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(result.data, null, 2), 'utf-8');
    } catch {
      // 写入失败不影响返回默认值
    }

    return result;
  }

  // 文件不存在且不创建
  if (schema) {
    result.data = typeof schema === 'function' ? schema() : (schema.default || schema);
    result.source = 'default';
  }

  return result;
}

/**
 * 安全写入 JSON 文件，三步原子操作
 *
 * 步骤:
 * 1. 写入到 .tmp 临时文件
 * 2. 如果原文件存在，rename 为 .bak（覆盖旧备份）
 * 3. rename .tmp 到原文件
 *
 * @param {string} filePath - 完整文件路径
 * @param {any} data - 要写入的数据
 * @param {object} [options]
 * @param {number} [options.pretty=2] - JSON 格式化缩进
 * @param {number} [options.mode=0o666] - 文件权限
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function safeWriteJson(filePath, data, options = {}) {
  const { pretty = 2, mode = 0o666 } = options;
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const bakPath = `${filePath}.bak`;

  try {
    // 确保目录存在
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 1. 序列化并写入 .tmp
    const json = JSON.stringify(data, null, pretty);
    const written = atomicWriteText(tmpPath, json, {
      mode,
      ensureDir: false, // 目录已确保存在
    });

    if (!written) {
      return { success: false, error: 'Failed to write tmp file' };
    }

    // 2. 如果原文件存在，备份为 .bak（覆盖旧备份）
    if (fs.existsSync(filePath)) {
      try {
        // 先删除旧备份（如果存在）
        if (fs.existsSync(bakPath)) {
          fs.unlinkSync(bakPath);
        }
        // rename 原文件为 .bak
        fs.renameSync(filePath, bakPath);
      } catch (bakError) {
        // 备份失败，清理临时文件
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
        return {
          success: false,
          error: `Failed to backup original file: ${bakError.message}`,
        };
      }
    }

    // 3. rename .tmp 到原文件
    try {
      fs.renameSync(tmpPath, filePath);
      return { success: true };
    } catch (renameError) {
      // rename 失败，尝试恢复备份
      if (fs.existsSync(bakPath)) {
        try {
          fs.renameSync(bakPath, filePath);
        } catch {}
      }
      return {
        success: false,
        error: `Failed to rename tmp to target: ${renameError.message}`,
      };
    }
  } catch (error) {
    // 清理临时文件
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {}

    return {
      success: false,
      error: error.message || String(error),
    };
  }
}

/**
 * 同步版本：安全读取 JSON
 */
function safeReadJsonSync(filePath, options = {}) {
  const { schema = null, createIfMissing = true, silent = false } = options;
  const bakPath = `${filePath}.bak`;

  let result = {
    data: null,
    wasHealed: false,
    source: 'main',
  };

  // 1. 尝试读取主文件
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      result.data = JSON.parse(raw);
      return result;
    } catch (parseError) {
      // 主文件损坏
      if (!silent) {
        writeHealAudit({
          action: 'config_corrupted_detected',
          target: path.basename(filePath),
          reason: 'JSON.parse failed on main file',
          details: { filePath, error: parseError.message },
          message: `检测到配置文件损坏: ${path.basename(filePath)}`,
        }).catch(() => {});
      }

      // 2. 尝试读取备份
      if (fs.existsSync(bakPath)) {
        try {
          const bakRaw = fs.readFileSync(bakPath, 'utf-8');
          const bakData = JSON.parse(bakRaw);

          // 恢复到主文件
          try {
            fs.copyFileSync(bakPath, filePath);
            result.data = bakData;
            result.wasHealed = true;
            result.source = 'backup';

            if (!silent) {
              writeHealAudit({
                action: 'config_restored_from_backup',
                target: path.basename(filePath),
                reason: 'main file corrupted, backup valid',
                details: { filePath, bakPath },
                message: `已从备份恢复配置文件: ${path.basename(filePath)}`,
              }).catch(() => {});
            }

            return result;
          } catch {
            result.data = bakData;
            result.source = 'backup';
            return result;
          }
        } catch (bakParseErrorSync) {
          // 备份也损坏 —— 与异步版同一判据,交给升级链(L2 freshInstallDoctor → L3 交人)。
          // 同步入口不能 await,故 fire-and-forget:升级是善后,绝不阻塞配置读取。
          try {
            const p = require('./healEscalationService').escalate({
              component: 'configGuard',
              trigger: 'config-guard-double-corrupt-sync',
              context: { filePath, bakPath },
              failedAttempts: [
                { step: 'read_main', error: parseError.message || 'json_parse_failed' },
                {
                  step: 'read_backup',
                  error: bakParseErrorSync.message || 'json_parse_failed',
                },
              ],
            });
            if (p && typeof p.catch === 'function') {
              p.catch(() => {});
            }
          } catch {
            /* 升级链自身失败绝不阻断配置读取 */
          }
        }
      }

      // 3. 双重损坏，返回默认值
      if (schema) {
        result.data = typeof schema === 'function' ? schema() : (schema.default || schema);
        result.source = 'default';

        if (!silent) {
          writeHealAudit({
            action: 'config_fallback_to_default',
            target: path.basename(filePath),
            reason: 'no valid backup, using schema default',
            details: { filePath },
            message: `使用默认配置: ${path.basename(filePath)}`,
          }).catch(() => {});
        }

        return result;
      }

      throw new Error(`Config file corrupted and no backup available: ${filePath}`);
    }
  }

  // 4. 文件不存在
  if (schema) {
    result.data = typeof schema === 'function' ? schema() : (schema.default || schema);
    result.source = 'default';

    if (createIfMissing) {
      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(result.data, null, 2), 'utf-8');
      } catch {}
    }
  }

  return result;
}

/**
 * 同步版本：安全写入 JSON
 */
function safeWriteJsonSync(filePath, data, options = {}) {
  const { pretty = 2, mode = 0o666 } = options;
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const bakPath = `${filePath}.bak`;

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const json = JSON.stringify(data, null, pretty);
    const written = atomicWriteText(tmpPath, json, { mode, ensureDir: false });

    if (!written) {
      return { success: false, error: 'Failed to write tmp file' };
    }

    if (fs.existsSync(filePath)) {
      try {
        if (fs.existsSync(bakPath)) {
          fs.unlinkSync(bakPath);
        }
        fs.renameSync(filePath, bakPath);
      } catch (bakError) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
        return { success: false, error: `Failed to backup: ${bakError.message}` };
      }
    }

    try {
      fs.renameSync(tmpPath, filePath);
      return { success: true };
    } catch (renameError) {
      if (fs.existsSync(bakPath)) {
        try {
          fs.renameSync(bakPath, filePath);
        } catch {}
      }
      return { success: false, error: `Failed to rename: ${renameError.message}` };
    }
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {}
    return { success: false, error: error.message || String(error) };
  }
}

module.exports = {
  safeReadJson,
  safeWriteJson,
  safeReadJsonSync,
  safeWriteJsonSync,
};
