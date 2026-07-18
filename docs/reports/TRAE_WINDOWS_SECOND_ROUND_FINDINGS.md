# Trae Windows 端调查记录（第二轮）

## 背景

本记录整理了对 Trae Windows 客户端第二轮排查的结论，覆盖以下问题：

- `GetThirdPartyToken` 的请求头、请求体、返回格式
- Trae 是否存在本地监听端口
- `get_detail_param` 端点的请求/响应特征
- `safeStorage` 解密后的 `iCubeAuthInfo` 结构与 token 流向

说明：

- 本机未在 `C:\Users\25789\.trae` 下发现可用的 `logs` 目录或相关命中日志。
- 因此本轮结论主要来自安装包代码静态分析，而不是运行日志抓包。
- 实际安装路径为 `D:\Users\25789\AppData\Local\Programs\Trae`。

## 1. GetThirdPartyToken

### 1.1 结论

- 该请求不是使用 `Authorization: Bearer ...`。
- 该请求也不是依赖 `Cookie` 鉴权。
- 主进程明确使用自定义请求头 `x-cloudide-token: <用户 token>`。
- 请求体不是 `model_provider` / `model_id`。
- 返回值不是可直接用于 OpenAI 兼容 API 的 token。

### 1.2 调用方式

主进程会动态解析接口地址：

- 路径：`/cloudide/api/v3/trae/GetThirdPartyToken`
- 完整域名不是硬编码在明文逻辑里，而是通过 API 解析器拼出

### 1.3 请求头

可确认的请求头如下：

```http
Content-Type: application/json
x-cloudide-token: <userInfo.token>
```

如果打开 PPE 配置，还会附加：

```http
x-tt-env: <ppe env>
x-use-ppe: 1
```

### 1.4 请求体

代码中请求体构造为：

```json
{
  "Types": ["feishu", "lark"]
}
```

说明：

- `Types` 来源于内部常量 `VK=["feishu","lark"]`
- 没看到 `model_provider`
- 没看到 `model_id`

### 1.5 返回格式

接口返回后，代码要求：

- `ResponseMetadata.Error` 不存在
- `Result` 必须是数组

随后每项被映射为：

```json
{
  "type": "<Type>",
  "accessToken": "<AccessToken>",
  "accessExpireAt": "<AccessExpireAt>",
  "openId": "<ExternalUserID>",
  "scope": "<Scope>"
}
```

刷新完成后会被整理成按类型索引的对象，大致形态如下：

```json
{
  "feishu": {
    "type": "feishu",
    "accessToken": "...",
    "accessExpireAt": "...",
    "openId": "...",
    "scope": "..."
  },
  "lark": {
    "type": "lark",
    "accessToken": "...",
    "accessExpireAt": "...",
    "openId": "...",
    "scope": "..."
  }
}
```

### 1.6 结论解释

这说明 `GetThirdPartyToken` 返回的是第三方平台令牌缓存，主要用于飞书/Lark 场景，不是 OpenAI 兼容 API key，也不是通用模型调用 token。

## 2. Trae 本地监听端口

### 2.1 运行态检查结果

对当前运行中的 `Trae.exe` 和 `trae-sandbox.exe` 进行了端口检查：

- `netstat -ano` 未发现 Trae 进程的 `LISTENING`
- `Get-NetTCPConnection -State Listen -OwningProcess <pid>` 也未发现监听端口

### 2.2 结论

- 当前运行中的 Trae 没有常驻本地 HTTP/WebSocket 监听端口
- 因此没有可直接访问的 `http://127.0.0.1:<port>` 本地代理服务

### 2.3 例外情况

代码中存在一个临时本地 HTTP 服务，但用途不是常规 API 代理，而是外部 SSO handoff：

- 监听地址：`127.0.0.1`
- 端口：随机端口
- 触发时机：外部登录回调
- 路径：`/authorize`

回调结果页面：

- 成功时返回 `Login successful`
- 缺少 token 时返回 `Login failed: missing token`

这说明 Trae 的确可能临时起本地端口，但它不是像 Cursor 那样常驻的本地模型代理服务。

## 3. get_detail_param

### 3.1 端点定义

在 `ai-completion` 相关脚本中可以确认：

- 路径：`api/ide/v1/get_detail_param`
- 方法：`POST`

### 3.2 默认请求头

该接口默认请求头不是 `Authorization`，而是从 `getJwtToken("completion")` 派生：

```http
x-plugin-channel: <channel>
x-ide-version-code: <versionCode>
x-ide-token: <completion jwt token>
Content-Type: application/json
```

### 3.3 当前发现的典型请求体

现有调用点显示它用于拉取配置详情，而不是直接查询模型 provider/id。

示例 1：

```json
{
  "function": "cue_builder",
  "config_name": "deepsearch",
  "need_prompt": false,
  "poly_prompt": false
}
```

示例 2：

```json
{
  "function": "cue_intent",
  "config_name": "intent",
  "need_prompt": false,
  "poly_prompt": false
}
```

### 3.4 返回值特征

虽然没有运行日志中的完整原始响应，但消费链已经暴露了核心结构：

- 返回对象中存在 `config_info_list`
- 每一项中存在 `config_name`
- 每一项中存在 `extra_config`
- `extra_config` 会被 `JSON.parse(...)` 后写入配置管理器

可推测响应骨架近似如下：

```json
{
  "config_info_list": [
    {
      "config_name": "...",
      "extra_config": "{...json string...}"
    }
  ]
}
```

### 3.5 结论

- 目前没有证据表明该接口返回模型列表
- 目前也没有证据表明该接口返回 OpenAI 兼容 API endpoint
- 现有证据更支持它是“配置详情接口”

## 4. iCubeAuthInfo 与 safeStorage

### 4.1 是否是 JSON 对象

是。

流程大致如下：

1. 先把 `userInfo` 对象执行 `JSON.stringify(...)`
2. 再通过 Electron `safeStorage.encryptString(...)` 加密存储
3. 读取时通过 `safeStorage.decryptString(...)` 解密
4. 解密后的内容再作为 JSON 字符串使用

因此，解密后的 `iCubeAuthInfo` 本质上对应一个 JSON 对象。

### 4.2 已确认字段

顶层字段至少包括：

- `token`
- `refreshToken`
- `expiredAt`
- `refreshExpiredAt`
- `tokenReleaseAt`
- `userId`
- `host`
- `userRegion`
- `account`

`account` 下至少包括：

- `username`
- `email`
- `avatar_url`
- `description`
- `scope`
- `loginScope`
- `storeCountryCode`
- `storeCountrySrc`
- `storeRegion`
- `userTag`
- `migrateToSG`

### 4.3 token 流向

可确认的流向有两条：

#### A. 直接进入 HTTP 请求头

`userInfo.token` 会被主进程直接放入请求头，例如：

```http
x-cloudide-token: <user token>
```

这条链路已在 `GetThirdPartyToken` 调用中得到确认。

#### B. 通过 IPC 广播给 sandbox / code windows

代码中存在主进程到 sandbox 的广播事件，例如：

- `MAIN_TO_SANDBOX_SEND_USER_INFO`
- `MAIN_TO_SANDBOX_THIRD_PARTY_TOKEN_UPDATED`

这说明：

- 用户认证态会通过 IPC 传播
- 第三方 token 刷新结果也会通过 IPC 传播

## 5. 本轮关键答案汇总

### 5.1 GetThirdPartyToken 需要什么 auth header

答案：

- 使用 `x-cloudide-token`
- 不是 Bearer
- 不是 Cookie

### 5.2 GetThirdPartyToken 请求体包含什么

答案：

```json
{
  "Types": ["feishu", "lark"]
}
```

未见：

- `model_provider`
- `model_id`

### 5.3 GetThirdPartyToken 返回什么

答案：

- 返回第三方 token 列表
- 每项含 `Type / AccessToken / AccessExpireAt / ExternalUserID / Scope`
- 不是 OpenAI 兼容 token

### 5.4 Trae 有没有本地监听端口

答案：

- 当前运行态没有常驻监听端口
- 只有外部 SSO handoff 时会临时监听 `127.0.0.1:<随机端口>`

### 5.5 如果访问本地端口会返回什么

答案：

- 仅临时 SSO 回调场景下可访问
- 成功返回 `Login successful`
- 缺 token 返回 `Login failed: missing token`

### 5.6 get_detail_param 的请求/响应格式

答案：

- 方法：`POST`
- 请求头含 `x-plugin-channel` / `x-ide-version-code` / `x-ide-token`
- 典型请求体包含 `function`、`config_name`、`need_prompt`、`poly_prompt`
- 响应至少包含 `config_info_list[].extra_config`

### 5.7 get_detail_param 是否返回模型列表或 API endpoint

答案：

- 当前证据不支持
- 更像配置详情接口

### 5.8 iCubeAuthInfo 是什么

答案：

- 是经 `safeStorage` 加密存储的用户认证 JSON
- 解密后包含 `token`、`refreshToken`、`expiredAt`、`tokenReleaseAt`、`account` 等字段

### 5.9 token 被送去了哪里

答案：

- 会直接进入 HTTP 请求头
- 也会通过 IPC 广播给 sandbox / code windows

## 6. 证据来源

本轮结论主要来自以下代码位置：

- `D:\Users\25789\AppData\Local\Programs\Trae\resources\app\out\main.js`
- `D:\Users\25789\AppData\Local\Programs\Trae\resources\app\extensions\ai-completion\resource\aiserver\cueMain.js`

以及本机进程/端口检查结果：

- Trae 相关进程存在
- 当前未发现其监听本地端口

## 7. 限制与后续建议

### 7.1 当前限制

- 本机未拿到 `GetThirdPartyToken` 和 `get_detail_param` 的原始运行日志
- 因而不能提供真实线上响应全文
- `grow-normal.trae.ai` / `core-normal.trae.ai` 的域名出现于历史观察中，但本机本轮未在落盘日志中复现

### 7.2 后续建议

如果需要继续深入，建议下一轮做以下任一动作：

1. 专门追 `get_detail_param` 的完整调用链，恢复更完整的响应 schema
2. 在 Trae 运行时开启更高等级日志，再抓一次真实请求/响应
3. 对 `server.js` 中网络适配层继续做字符串拆分和调用点定位，确认是否有更多隐藏 header 或调试日志格式
