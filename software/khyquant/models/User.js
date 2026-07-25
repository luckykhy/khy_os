/**
 * 用户模型（User） —— 系统核心实体之一
 *
 * 数据库表：users（对应论文表16）
 * E-R 关系（论文图4/图8）：
 *   User 1:N Strategy（一个用户可创建多条策略）
 *   User 1:N Trade（一个用户可有多笔交易）
 *   User 1:N AISuggestion（一个用户可收到多条AI建议）
 *   User 1:N Watchlist（一个用户可有多个自选股列表）
 *
 * 字段说明：
 *   role: 'admin' | 'user' —— 对应论文图3用例图的两类角色
 *   password: bcrypt 加密存储（对应论文第3.2节安全需求）
 *
 * 对应论文：第4.6节（数据库设计），表16
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const bcrypt = require('bcryptjs');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  username: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true,
    comment: '用户名'
  },
  email: {
    type: DataTypes.STRING(100),
    allowNull: false,
    unique: true,
    validate: {
      isEmail: true
    },
    comment: '邮箱'
  },
  password: {
    type: DataTypes.STRING(255),
    allowNull: false,
    comment: '密码（加密）'
  },
  role: {
    type: DataTypes.ENUM('admin', 'user'),
    defaultValue: 'user',
    comment: '角色：admin-管理员，user-普通用户'
  },
  status: {
    type: DataTypes.ENUM('active', 'inactive', 'banned'),
    defaultValue: 'active',
    comment: '状态：active-活跃，inactive-未激活，banned-已禁用'
  },
  lastLoginAt: {
    type: DataTypes.DATE,
    comment: '最后登录时间'
  },
  securityQuestion: {
    type: DataTypes.STRING(200),
    comment: '密保问题'
  },
  securityAnswer: {
    type: DataTypes.STRING(255),
    comment: '密保答案（加密）'
  },
  webauthnCredentialId: {
    type: DataTypes.TEXT,
    allowNull: true,
    field: 'webauthn_credential_id',
    comment: 'WebAuthn credential id（base64url）'
  },
  webauthnPublicKey: {
    type: DataTypes.TEXT,
    allowNull: true,
    field: 'webauthn_public_key',
    comment: 'WebAuthn 公钥（base64）'
  },
  webauthnCounter: {
    type: DataTypes.BIGINT,
    allowNull: true,
    defaultValue: 0,
    field: 'webauthn_counter',
    comment: 'WebAuthn 防重放计数器'
  },
  sendKey: {
    type: DataTypes.STRING(255),
    allowNull: true,
    field: 'send_key',
    comment: 'ServerChan SendKey for WeChat push notifications'
  }
}, {
  tableName: 'users',
  timestamps: true,
  hooks: {
    beforeCreate: async (user) => {
      if (user.password) {
        user.password = await bcrypt.hash(user.password, 10);
      }
      if (user.securityAnswer) {
        user.securityAnswer = await bcrypt.hash(user.securityAnswer.toLowerCase().trim(), 10);
      }
    },
    beforeUpdate: async (user) => {
      if (user.changed('password')) {
        user.password = await bcrypt.hash(user.password, 10);
      }
      if (user.changed('securityAnswer')) {
        user.securityAnswer = await bcrypt.hash(user.securityAnswer.toLowerCase().trim(), 10);
      }
    }
  }
});

// 实例方法：验证密码
User.prototype.comparePassword = async function(password) {
  return await bcrypt.compare(password, this.password);
};

// 实例方法：验证密保答案
User.prototype.compareSecurityAnswer = async function(answer) {
  if (!this.securityAnswer) return false;
  return await bcrypt.compare(answer.toLowerCase().trim(), this.securityAnswer);
};

// 实例方法：转换为JSON（排除密码和密保答案）
User.prototype.toJSON = function() {
  const values = { ...this.get() };
  delete values.password;
  delete values.securityAnswer;
  delete values.sendKey;
  return values;
};

// SSOT: public-safe attribute projection for association includes.
// Excludes password / securityAnswer / sendKey and other sensitive columns.
// Routes that eager-load a User should reference this instead of inlining
// the field list. Frozen to prevent accidental mutation of the shared list.
User.PUBLIC_ATTRIBUTES = Object.freeze(['id', 'username', 'email']);

// SSOT: minimal user-reference projection for association includes that only
// need to label who a record belongs to (e.g. author/admin badges). Narrower
// than PUBLIC_ATTRIBUTES — omits email. Frozen; copy with [...] before storing.
User.REFERENCE_ATTRIBUTES = Object.freeze(['id', 'username']);

module.exports = User;
