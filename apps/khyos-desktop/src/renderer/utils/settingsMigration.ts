// 设置迁移标记系统 [DESIGN-ARCH-092 §7.13]
// 当一个设置项的默认值随版本变化时，用 <key>MigrationInitialized 布尔标记
// 区分「用户显式设置过」与「默认值演进」

export interface SettingMigration {
  key: string
  defaultValue: unknown
  migrationKey: string
}

// 需要迁移标记的设置项
export const MIGRATED_SETTINGS: SettingMigration[] = [
  { key: 'closeToTrayOnWindows', defaultValue: false, migrationKey: 'closeToTrayOnWindowsMigrationInitialized' },
  { key: 'messageStreamShowReasoning', defaultValue: true, migrationKey: 'messageStreamShowReasoningMigrationInitialized' },
  { key: 'optimizeAgentExperienceEnabled', defaultValue: false, migrationKey: 'optimizeAgentExperienceMigrationInitialized' },
  { key: 'settingsSyncFirstRunPromptHandled', defaultValue: true, migrationKey: 'settingsSyncFirstRunPromptHandled' },
]

/**
 * 通用设置迁移工具
 * @param key 设置键名
 * @param defaultValue 当前版本默认值
 * @param migrationKey 迁移标记键名
 * @param currentSettings 当前设置对象
 * @returns 迁移后的设置值
 */
export function migrateSetting(
  key: string,
  defaultValue: unknown,
  migrationKey: string,
  currentSettings: Record<string, unknown>
): unknown {
  // 如果已经有迁移标记，说明用户已显式设置过，保留当前值
  if (currentSettings[migrationKey] === true) {
    return currentSettings[key]
  }

  // 如果没有迁移标记，说明是首次设置，使用默认值并标记为已迁移
  return defaultValue
}

/**
 * 检查并执行所有设置迁移
 */
export function runAllMigrations(settings: Record<string, unknown>): Record<string, unknown> {
  const result = { ...settings }

  for (const migration of MIGRATED_SETTINGS) {
    result[migration.key] = migrateSetting(
      migration.key,
      migration.defaultValue,
      migration.migrationKey,
      result
    )
    // 设置迁移标记
    if (result[migration.migrationKey] === undefined) {
      result[migration.migrationKey] = true
    }
  }

  return result
}

/**
 * 用户修改设置时，自动设置迁移标记
 */
export function setUserSetting(
  settings: Record<string, unknown>,
  key: string,
  value: unknown
): Record<string, unknown> {
  const result = { ...settings, [key]: value }

  // 查找对应的迁移标记并设置
  const migration = MIGRATED_SETTINGS.find(m => m.key === key)
  if (migration) {
    result[migration.migrationKey] = true
  }

  return result
}
