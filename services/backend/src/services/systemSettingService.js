const { SystemSetting } = require('../models');
const { Op } = require('sequelize');

class SystemSettingService {
  // 获取所有设置
  static async getAllSettings(options = {}) {
    const { category, isPublic, includePrivate = false } = options;
    
    const where = {};
    
    if (category) {
      where.category = category;
    }
    
    if (!includePrivate) {
      where.isPublic = true;
    } else if (isPublic !== undefined) {
      where.isPublic = isPublic;
    }

    const settings = await SystemSetting.findAll({
      where,
      order: [['category', 'ASC'], ['order', 'ASC'], ['key', 'ASC']]
    });

    // 按分类分组
    const grouped = {};
    settings.forEach(setting => {
      if (!grouped[setting.category]) {
        grouped[setting.category] = [];
      }
      grouped[setting.category].push({
        key: setting.key,
        value: setting.getParsedValue(),
        type: setting.type,
        description: setting.description,
        isEditable: setting.isEditable,
        validation: setting.validation ? JSON.parse(setting.validation) : null
      });
    });

    return grouped;
  }

  // 获取单个设置
  static async getSetting(key) {
    const setting = await SystemSetting.findOne({ where: { key } });
    return setting ? setting.getParsedValue() : null;
  }

  // 设置值
  static async setSetting(key, value, options = {}) {
    const { type = 'string', category = 'general', description = '', isPublic = false } = options;
    
    let setting = await SystemSetting.findOne({ where: { key } });
    
    if (setting) {
      setting.setValue(value);
      await setting.save();
    } else {
      setting = await SystemSetting.create({
        key,
        value: value,
        type,
        category,
        description,
        isPublic
      });
      setting.setValue(value);
      await setting.save();
    }
    
    return setting.getParsedValue();
  }

  // 批量设置
  static async setMultipleSettings(settings) {
    const results = {};

    // 单次批量加载，避免逐键 findOne 的 N+1 查询（[MGMT-RPT-020] REQ-2026-007）
    const keys = Object.keys(settings);
    if (keys.length === 0) return results;
    const rows = await SystemSetting.findAll({ where: { key: { [Op.in]: keys } } });
    const byKey = new Map(rows.map((r) => [r.key, r]));

    for (const [key, value] of Object.entries(settings)) {
      const setting = byKey.get(key);
      if (setting && setting.isEditable) {
        setting.setValue(value);
        await setting.save();
        results[key] = setting.getParsedValue();
      }
    }

    return results;
  }

  // 删除设置
  static async deleteSetting(key) {
    const setting = await SystemSetting.findOne({ where: { key } });
    if (setting && setting.isEditable) {
      await setting.destroy();
      return true;
    }
    return false;
  }

  // 重置为默认值
  static async resetToDefault(key) {
    const setting = await SystemSetting.findOne({ where: { key } });
    if (setting && setting.isEditable) {
      setting.value = setting.defaultValue;
      await setting.save();
      return setting.getParsedValue();
    }
    return null;
  }

  // 初始化默认设置
  static async initializeDefaultSettings() {
    const defaultSettings = [
      // 系统基本设置
      {
        key: 'system.name',
        value: 'khy OS AI 平台操作系统',
        type: 'string',
        category: 'system',
        description: '系统名称',
        isPublic: true,
        isEditable: true,
        order: 1
      },
      {
        key: 'system.version',
        value: '1.0.0',
        type: 'string',
        category: 'system',
        description: '系统版本',
        isPublic: true,
        isEditable: false,
        order: 2
      },
      {
        key: 'system.description',
        value: '专业的量化交易平台，提供策略开发、回测分析、实盘交易等功能',
        type: 'text',
        category: 'system',
        description: '系统描述',
        isPublic: true,
        isEditable: true,
        order: 3
      },
      {
        key: 'system.maintenance_mode',
        value: 'false',
        type: 'boolean',
        category: 'system',
        description: '维护模式',
        isPublic: false,
        isEditable: true,
        order: 4
      },
      
      // 用户设置
      {
        key: 'user.registration_enabled',
        value: 'true',
        type: 'boolean',
        category: 'user',
        description: '允许用户注册',
        isPublic: false,
        isEditable: true,
        order: 1
      },
      {
        key: 'user.email_verification_required',
        value: 'false',
        type: 'boolean',
        category: 'user',
        description: '需要邮箱验证',
        isPublic: false,
        isEditable: true,
        order: 2
      },
      {
        key: 'user.default_role',
        value: 'user',
        type: 'string',
        category: 'user',
        description: '默认用户角色',
        isPublic: false,
        isEditable: true,
        order: 3
      },
      {
        key: 'user.session_timeout',
        value: '7',
        type: 'number',
        category: 'user',
        description: '会话超时时间（天）',
        isPublic: false,
        isEditable: true,
        order: 4
      },
      
      // 安全设置
      {
        key: 'security.password_min_length',
        value: '6',
        type: 'number',
        category: 'security',
        description: '密码最小长度',
        isPublic: false,
        isEditable: true,
        order: 1
      },
      {
        key: 'security.login_attempts_limit',
        value: '5',
        type: 'number',
        category: 'security',
        description: '登录尝试次数限制',
        isPublic: false,
        isEditable: true,
        order: 2
      },
      {
        key: 'security.lockout_duration',
        value: '30',
        type: 'number',
        category: 'security',
        description: '账户锁定时间（分钟）',
        isPublic: false,
        isEditable: true,
        order: 3
      },
      
      // K-line display settings
      {
        key: 'kline.enabled_periods',
        value: '["daily"]',
        type: 'json',
        category: 'trading',
        description: 'Allowed K-line periods for frontend display',
        isPublic: true,
        isEditable: true,
        order: 0
      },

      // 交易设置
      {
        key: 'trading.default_commission',
        value: '0.0003',
        type: 'number',
        category: 'trading',
        description: '默认手续费率',
        isPublic: true,
        isEditable: true,
        order: 1
      },
      {
        key: 'trading.max_positions',
        value: '10',
        type: 'number',
        category: 'trading',
        description: '最大持仓数量',
        isPublic: true,
        isEditable: true,
        order: 2
      },
      {
        key: 'trading.risk_limit',
        value: '0.02',
        type: 'number',
        category: 'trading',
        description: '单笔交易风险限制',
        isPublic: true,
        isEditable: true,
        order: 3
      },
      
      // 数据设置
      {
        key: 'data.retention_days',
        value: '365',
        type: 'number',
        category: 'data',
        description: '数据保留天数',
        isPublic: false,
        isEditable: true,
        order: 1
      },
      {
        key: 'data.backup_enabled',
        value: 'true',
        type: 'boolean',
        category: 'data',
        description: '启用数据备份',
        isPublic: false,
        isEditable: true,
        order: 2
      },
      {
        key: 'data.backup_frequency',
        value: 'daily',
        type: 'string',
        category: 'data',
        description: '备份频率',
        isPublic: false,
        isEditable: true,
        order: 3
      },
      
      // 通知设置
      {
        key: 'notification.email_enabled',
        value: 'false',
        type: 'boolean',
        category: 'notification',
        description: '启用邮件通知',
        isPublic: false,
        isEditable: true,
        order: 1
      },
      {
        key: 'notification.smtp_host',
        value: '',
        type: 'string',
        category: 'notification',
        description: 'SMTP服务器',
        isPublic: false,
        isEditable: true,
        order: 2
      },
      {
        key: 'notification.smtp_port',
        value: '587',
        type: 'number',
        category: 'notification',
        description: 'SMTP端口',
        isPublic: false,
        isEditable: true,
        order: 3
      }
    ];

    // 单次批量加载已有键，仅批量创建缺失项，避免逐键 findOne 的 N+1（[MGMT-RPT-020] REQ-2026-007）
    const keys = defaultSettings.map((s) => s.key);
    const existingRows = await SystemSetting.findAll({
      where: { key: { [Op.in]: keys } },
      attributes: ['key'],
      raw: true,
    });
    const existingKeys = new Set(existingRows.map((r) => r.key));
    const missing = defaultSettings.filter((s) => !existingKeys.has(s.key));
    if (missing.length > 0) {
      await SystemSetting.bulkCreate(missing);
    }
  }

  // 获取系统信息
  static async getSystemInfo() {
    const settings = await this.getAllSettings({ includePrivate: true });
    
    // 获取系统统计信息
    const { User, Strategy, Backtest, Trade } = require('../models');
    
    const [userCount, strategyCount, backtestCount, tradeCount] = await Promise.all([
      User.count(),
      Strategy.count(),
      Backtest.count(),
      Trade.count()
    ]);

    return {
      settings,
      statistics: {
        userCount,
        strategyCount,
        backtestCount,
        tradeCount
      },
      systemInfo: {
        nodeVersion: process.version,
        platform: process.platform,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage()
      }
    };
  }
}

module.exports = SystemSettingService;
