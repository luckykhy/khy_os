# 网关配置自动修复与重置

## 功能说明

khy 现在能够在启动时自动检测并修复配置问题：

### 1. 配置文件修复

**自动检测并修复 `.env` 文件的常见问题**：
- ✅ 重复的键（保留最后一次出现）
- ✅ 畸形行（缺少 `=` 的非注释行）
- ✅ 空键名（如 `=value`）
- ✅ 未闭合的引号

**修复时会自动创建备份**：
```
.env.broken-2026-07-01T12-34-56
```

### 2. 网关配置重置

**自动检测网关配置问题**：
- 配置文件已损坏
- 必需字段缺失（`GATEWAY_PREFERRED_ADAPTER` 或 relay 配置全空）
- 适配器值非法（不在支持列表中）

**出厂默认配置**：
```bash
GATEWAY_PREFERRED_ADAPTER=relay_api
RELAY_API_ENDPOINT=
RELAY_API_KEY=
RELAY_API_MODEL=
RELAY_API_COMPATIBILITY=openai
```

## 使用方式

### 自动模式（默认）

每次启动 khy 时自动运行：
```bash
khy
```

启动时会看到类似输出：
```
Database connected (sqlite)
配置文件已修复 (移除 2 行)
备份: .env.broken-2026-07-01T12-34-56
建议运行 'khy config reset' 重置网关配置
```

### 关闭自动修复

如果需要关闭自动修复功能：

```bash
# 关闭配置修复
export KHY_CONFIG_REPAIR=off

# 关闭网关重置检测
export KHY_GATEWAY_RESET=off
```

## 常见场景

### 场景 1：手动编辑配置后出错

**问题**：编辑 `.env` 文件时不小心删除了 `=` 符号
```bash
# 错误的配置
GATEWAY_PREFERRED_ADAPTER relay_api  # 缺少 =
RELAY_API_KEY=sk-test
```

**解决**：重新启动 khy，会自动检测并修复：
- 移除畸形行
- 创建备份文件
- 显示修复信息

### 场景 2：配置文件损坏

**问题**：`.env` 文件包含重复键或其他问题

**解决**：启动时自动修复，保留最后一次出现的值

### 场景 3：网关配置丢失

**问题**：升级后网关配置字段缺失或错误

**解决**：启动时检测到问题，建议重置为出厂默认值

## 技术细节

- **纯叶子设计**：决策逻辑与 IO 操作分离
- **fail-soft**：修复失败不影响 khy 正常启动
- **保守策略**：只移除问题行，不自动填充空值
- **完整测试**：30 个测试用例确保可靠性

## 相关门控

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `KHY_CONFIG_REPAIR` | `true` | 配置文件自动修复 |
| `KHY_GATEWAY_RESET` | `true` | 网关配置重置检测 |

## 相关文件

- **纯叶子函数**：
  - `services/backend/src/services/configRepairPolicy.js`
  - `services/backend/src/services/gatewayResetPolicy.js`
- **薄壳服务**：
  - `services/backend/src/services/configRepairService.js`
  - `services/backend/src/services/gatewayResetService.js`
- **接线点**：
  - `services/backend/src/cli/bootstrap.js` (第 51-87 行)
