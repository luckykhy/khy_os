# [DESIGN-PRIV-001] 数据隐私规范

> 本文档定义 khy-os 项目的数据隐私标准，包括 GDPR 合规、数据保护、用户权利等。

---

## 1. 数据隐私概述

### 1.1 设计原则

1. **数据最小化**：只收集必需的数据
2. **目的限制**：数据仅用于明确的目的
3. **存储限制**：数据保留时间有限
4. **透明性**：用户知情并同意

### 1.2 适用法规

| 法规 | 适用地区 | 说明 |
|------|---------|------|
| GDPR | 欧盟 | 通用数据保护条例 |
| CCPA | 美国加州 | 加州消费者隐私法 |
| PIPL | 中国 | 个人信息保护法 |

---

## 2. 数据分类

### 2.1 数据分类标准

| 类别 | 说明 | 保护级别 | 示例 |
|------|------|---------|------|
| 公开数据 | 可公开访问 | 低 | 公开文档、帮助 |
| 内部数据 | 内部使用 | 中 | 配置、日志 |
| 敏感数据 | 用户个人信息 | 高 | 邮箱、手机号 |
| 高度敏感 | 身份/财务信息 | 极高 | 身份证、银行卡 |

### 2.2 个人数据定义

**个人数据**：任何可识别自然人的信息

**包括**：
- 姓名
- 邮箱地址
- 电话号码
- IP 地址
- 设备标识符
- Cookie ID
- 位置数据

### 2.3 敏感个人数据

**敏感个人数据**：需要额外保护的数据

**包括**：
- 种族或民族出身
- 政治观点
- 宗教信仰
- 健康数据
- 生物特征数据
- 性取向

---

## 3. 用户同意

### 3.1 同意要求

- **自由给予**：用户可以自由选择
- **具体明确**：说明数据用途
- **知情同意**：用户了解数据使用
- **明确同意**：用户主动勾选

### 3.2 同意收集

```vue
<template>
  <div class="consent-form">
    <h2>隐私政策</h2>
    <p>我们收集和处理您的个人信息，用于以下目的：</p>
    
    <label>
      <input type="checkbox" v-model="consents.essential" disabled checked>
      基本功能（必需）
    </label>
    
    <label>
      <input type="checkbox" v-model="consents.analytics">
      使用分析（可选）
    </label>
    
    <label>
      <input type="checkbox" v-model="consents.marketing">
      营销通信（可选）
    </label>
    
    <button @click="saveConsents">保存设置</button>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const consents = ref({
  essential: true,  // 必需，不可取消
  analytics: false,
  marketing: false
});

const saveConsents = async () => {
  await fetch('/api/user/consents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(consents.value)
  });
};
</script>
```

### 3.3 同意记录

```javascript
// models/UserConsent.js
module.exports = (sequelize, DataTypes) => {
  const UserConsent = sequelize.define('UserConsent', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    consentType: {
      type: DataTypes.STRING,
      allowNull: false
    },
    granted: {
      type: DataTypes.BOOLEAN,
      allowNull: false
    },
    ipAddress: {
      type: DataTypes.STRING
    },
    userAgent: {
      type: DataTypes.TEXT
    }
  });
  
  return UserConsent;
};
```

---

## 4. 用户权利

### 4.1 知情权

用户有权了解：
- 收集了哪些数据
- 数据的使用目的
- 数据的存储时间
- 与谁共享数据

### 4.2 访问权

用户可以请求获取其个人数据的副本。

```javascript
// GET /api/user/data-export
router.get('/user/data-export', authenticateToken, async (req, res) => {
  const userId = req.user.sub;
  
  // 收集用户数据
  const userData = {
    profile: await User.findByPk(userId),
    orders: await Order.findAll({ where: { userId } }),
    consents: await UserConsent.findAll({ where: { userId } })
  };
  
  // 导出为 JSON
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="my-data.json"');
  res.json(userData);
});
```

### 4.3 更正权

用户可以更正不准确的个人数据。

```javascript
// PUT /api/user/profile
router.put('/user/profile', authenticateToken, async (req, res) => {
  const userId = req.user.sub;
  const { username, email } = req.body;
  
  await User.update(
    { username, email },
    { where: { id: userId } }
  );
  
  res.json({ success: true, message: '个人信息已更新' });
});
```

### 4.4 删除权（被遗忘权）

用户可以要求删除其个人数据。

```javascript
// DELETE /api/user/account
router.delete('/user/account', authenticateToken, async (req, res) => {
  const userId = req.user.sub;
  
  // 删除用户数据
  await sequelize.transaction(async (t) => {
    await Order.destroy({ where: { userId }, transaction: t });
    await UserConsent.destroy({ where: { userId }, transaction: t });
    await Session.destroy({ where: { userId }, transaction: t });
    await User.destroy({ where: { id: userId }, transaction: t });
  });
  
  res.json({ success: true, message: '账户已删除' });
});
```

### 4.5 数据可携带权

用户可以将其数据导出为通用格式。

```javascript
// 支持格式：JSON, CSV
router.get('/user/data-export/:format', authenticateToken, async (req, res) => {
  const { format } = req.params;
  const userData = await collectUserData(req.user.sub);
  
  if (format === 'csv') {
    const csv = convertToCSV(userData);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="my-data.csv"');
    res.send(csv);
  } else {
    res.json(userData);
  }
});
```

### 4.6 反对权

用户可以反对其数据的某些用途。

```javascript
// 取消营销通信
router.post('/user/opt-out/marketing', authenticateToken, async (req, res) => {
  await UserConsent.update(
    { granted: false },
    { where: { userId: req.user.sub, consentType: 'marketing' } }
  );
  
  res.json({ success: true, message: '已取消营销通信' });
});
```

---

## 5. 数据保护

### 5.1 加密要求

| 数据类型 | 加密方式 |
|---------|---------|
| 密码 | bcrypt（cost factor 12） |
| API Key | AES-256-GCM |
| 传输数据 | TLS 1.3 |
| 静态数据 | 文件系统加密 |

### 5.2 数据脱敏

```javascript
// 邮箱脱敏
const maskEmail = (email) => {
  const [local, domain] = email.split('@');
  return `${local.charAt(0)}***${local.charAt(local.length - 1)}@${domain}`;
};

// 手机号脱敏
const maskPhone = (phone) => {
  return phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
};

// 日志脱敏
const sanitizeLog = (data) => {
  const sensitiveFields = ['password', 'token', 'apiKey', 'secret'];
  const sanitized = { ...data };
  
  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = '***REDACTED***';
    }
  }
  
  return sanitized;
};
```

### 5.3 数据访问控制

```javascript
// 中间件：检查数据访问权限
const checkDataAccess = (req, res, next) => {
  const requestedUserId = req.params.userId;
  const authenticatedUserId = req.user.sub;
  
  // 用户只能访问自己的数据（除非是管理员）
  if (requestedUserId !== authenticatedUserId && req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: '无权访问此数据'
    });
  }
  
  next();
};
```

---

## 6. 数据保留

### 6.1 保留期限

| 数据类型 | 保留期限 |
|---------|---------|
| 用户账户数据 | 账户存在期间 |
| 订单数据 | 7 年 |
| 日志数据 | 30 天 |
| 会话数据 | 7 天 |
| 分析数据 | 1 年 |

### 6.2 自动清理

```javascript
// 定期清理过期数据
const cleanupExpiredData = async () => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  
  // 清理过期日志
  await Log.destroy({
    where: {
      createdAt: { [Op.lt]: thirtyDaysAgo }
    }
  });
  
  // 清理过期会话
  await Session.destroy({
    where: {
      expiresAt: { [Op.lt]: new Date() }
    }
  });
};

// 每天执行一次
setInterval(cleanupExpiredData, 24 * 60 * 60 * 1000);
```

---

## 7. 数据泄露响应

### 7.1 响应流程

1. **发现**：检测数据泄露
2. **评估**：评估泄露范围和影响
3. **通知**：通知相关方
4. **控制**：控制泄露影响
5. **调查**：调查泄露原因
6. **修复**：修复安全漏洞
7. **报告**：向监管机构报告

### 7.2 通知要求

- **72 小时内**：向监管机构报告
- **及时**：通知受影响用户
- **内容**：泄露性质、可能后果、已采取措施

---

## 8. 隐私影响评估

### 8.1 评估范围

- 新功能上线前
- 数据处理方式变更时
- 数据存储位置变更时

### 8.2 评估内容

- 数据收集必要性
- 数据处理合法性
- 数据保护措施
- 用户权利保障

---

## 9. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义数据隐私规范 |

---

*本规范由 khy-os 安全团队维护*