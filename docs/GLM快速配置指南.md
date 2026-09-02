# API厂商快速配置指南

## 概述

现在您只需要输入API Key，khyos就能自动完成所有配置！支持所有主流AI厂商。

## 快速配置步骤

### 方法1：使用快速配置命令（推荐）

```bash
khy gateway
```

然后选择：
```
⚡ 快速配置API厂商 (输入Key即可)
```

### 方法2：手动配置（高级用户）

```bash
khy gateway
```

然后选择：
```
配置模型厂商 API Key (DeepSeek/Qwen/GLM/豆包等)
```

## 支持的厂商

| 厂商 | 环境变量 | 默认端点 | 说明 |
|------|---------|---------|------|
| DeepSeek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` | 深度求索 |
| 通义千问 (Qwen) | `QWEN_API_KEY` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 阿里云 |
| 智谱 GLM | `GLM_API_KEY` | `https://open.bigmodel.cn/api/paas/v4` | 智谱AI |
| 豆包 (Doubao) | `DOUBAO_API_KEY` | `https://ark.cn-beijing.volces.com/api/v3` | 字节跳动 |
| 百度文心 | `WENXIN_API_KEY` | `https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop` | 百度 |
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` | GPT系列 |
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1` | Claude系列 |
| Trae API | `TRAE_API_KEY` | (自定义) | Trae编码助手 |

## 配置流程

### 1. 获取API Key

根据您选择的厂商，访问对应的平台获取API Key：

#### 智谱GLM
1. 访问 [智谱开放平台](https://open.bigmodel.cn)
2. 注册/登录账号
3. 进入 [API Keys](https://bigmodel.cn/usercenter/proj-mgmt/apikeys)
4. 创建新的API Key

#### DeepSeek
1. 访问 [DeepSeek平台](https://platform.deepseek.com)
2. 注册/登录账号
3. 进入API Keys页面
4. 创建新的API Key

#### 通义千问
1. 访问 [阿里云百炼](https://bailian.console.aliyun.com)
2. 注册/登录账号
3. 进入API-KEY管理
4. 创建新的API Key

#### OpenAI
1. 访问 [OpenAI平台](https://platform.openai.com)
2. 注册/登录账号
3. 进入API Keys页面
4. 创建新的API Key

#### Anthropic (Claude)
1. 访问 [Anthropic平台](https://console.anthropic.com)
2. 注册/登录账号
3. 进入API Keys页面
4. 创建新的API Key

### 2. 输入API Key

在khyos中运行快速配置命令后，系统会提示：

```
╔══════════════════════════════════════════════════════════════╗
║           ⚡ 快速配置API厂商                                ║
╚══════════════════════════════════════════════════════════════╝

  只需输入API Key，即可自动配置：
  • API密钥和端点
  • API池映射
  • 默认模型选择
  • 模型路由规则

选择要配置的厂商:
❯ DeepSeek (DEEPSEEK_API_KEY)
  通义千问 (Qwen) (QWEN_API_KEY)
  智谱 GLM (GLM_API_KEY)
  豆包 (Doubao) (DOUBAO_API_KEY)
  百度文心 (WENXIN_API_KEY)
  OpenAI (OPENAI_API_KEY)
  Anthropic (Claude) (ANTHROPIC_API_KEY)
```

选择厂商后，输入API Key：

```
配置 DeepSeek:
  端点: https://api.deepseek.com/v1
  支持模型: deepseek-chat, deepseek-coder, deepseek-reasoner

请输入DeepSeek API Key: ********
```

### 3. 自动配置完成

系统会自动配置：

- ✅ `{PROVIDER}_API_KEY` - API密钥
- ✅ `{PROVIDER}_API_ENDPOINT` - API端点
- ✅ `GATEWAY_API_POOL_SERVICE_MAP` - API池映射
- ✅ `GATEWAY_API_POOL_DEFAULT_MODEL_MAP` - 默认模型
- ✅ `PROXY_MODEL_ROUTE_MAP` - 模型路由规则

## 使用模型

### 选择模型

```bash
khy /model deepseek-chat
```

### 直接使用

```bash
khy "你好，请介绍一下自己"
```

### 切换模型

```bash
khy /model glm-4-flash
```

## 各厂商可用模型

### DeepSeek
- `deepseek-chat` - 对话模型
- `deepseek-coder` - 代码模型
- `deepseek-reasoner` - 推理模型

### 通义千问 (Qwen)
- `qwen-turbo` - 快速对话
- `qwen-plus` - 增强对话
- `qwen-max` - 旗舰对话

### 智谱 GLM
- `glm-4-flash` - 快速对话
- `glm-4.7-flash` - 旗舰对话（200K上下文）
- `glm-4v-flash` - 视觉理解
- `cogview-3-flash` - 文生图
- `cogvideox-flash` - 视频生成

### 豆包 (Doubao)
- `doubao-pro-32k` - 专业版
- `doubao-lite-32k` - 轻量版

### 百度文心
- `ernie-4.0` - 文心4.0
- `ernie-speed` - 快速版

### OpenAI
- `gpt-4o` - GPT-4o
- `gpt-4o-mini` - GPT-4o Mini
- `o1-mini` - o1 Mini

### Anthropic (Claude)
- `claude-sonnet-4-6` - Claude Sonnet 4
- `claude-3-5-haiku-20241022` - Claude 3.5 Haiku

## 验证配置

### 检查配置状态

```bash
khy gateway status
```

### 测试API连接

```bash
khy "测试连接"
```

## 故障排除

### 问题1：API Key无效

**错误信息**：`401 Unauthorized`

**解决方案**：
1. 检查API Key是否正确
2. 确认API Key已激活
3. 检查API Key是否过期

### 问题2：模型不存在

**错误信息**：`model_not_found`

**解决方案**：
1. 使用 `khy /model` 查看可用模型
2. 确认模型名称拼写正确
3. 检查模型是否在您的账户中可用

### 问题3：网络连接失败

**错误信息**：`network error`

**解决方案**：
1. 检查网络连接
2. 确认可以访问对应的API端点
3. 检查防火墙设置
4. 配置代理：`khy gateway config → 配置网络代理`

## 高级配置

### 修改默认模型

```bash
khy gateway config
```

选择：
```
高级: API 池默认 provider (GATEWAY_API_POOL_PROVIDER)
```

### 添加多个API Key

```bash
khy gateway config
```

选择：
```
配置模型厂商 API Key (DeepSeek/Qwen/GLM/豆包等)
```

然后选择厂商，输入多个API Key（每行一个）。

### 自定义端点

如果您使用代理或自定义端点：

```bash
khy gateway config
```

选择：
```
配置模型厂商 API Key (DeepSeek/Qwen/GLM/豆包等)
```

然后选择厂商，在提示时选择"使用自定义地址"。

## 相关命令

- `khy gateway` - 网关配置
- `khy gateway status` - 查看配置状态
- `khy /model` - 查看/选择模型
- `khy "问题"` - 直接对话

## 更多信息

- [DeepSeek文档](https://platform.deepseek.com/api-docs)
- [通义千问文档](https://help.aliyun.com/zh/dashscope/)
- [智谱GLM文档](https://docs.bigmodel.cn)
- [OpenAI文档](https://platform.openai.com/docs)
- [Anthropic文档](https://docs.anthropic.com)
