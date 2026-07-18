# [OPS-MAN-167] khy msg 多平台消息收发（钉钉 / 飞书 / 企业微信）

> 目标（用户原话）：「我希望 khy 可以填入 webhook 等，发送接收钉钉，飞书，企业，微信消息」。
> 本子系统新增独立顶层命令 `khy msg`，把三大国内 IM 平台的**群机器人 webhook**接进来：
> 填入 webhook（及可选的加签 / 收信密钥）即可**发送**；把本服务的 `/webhooks/<平台>`
> 回调地址配到平台后台，即可**接收**（验签 + 解密 + 解析）。

## 支持的平台与「去哪拿 webhook」

| 平台 | 标识 | 别名 | 拿 webhook 的位置 |
| --- | --- | --- | --- |
| 钉钉 | `dingtalk` | dingding / ding | 群设置 → 智能群助手 → 添加机器人 → 自定义（Webhook） |
| 飞书 | `feishu` | lark | 群设置 → 群机器人 → 添加机器人 → 自定义机器人 |
| 企业微信 | `wecom` | wechat / weixin / qywx | 群设置 → 群机器人 → 添加 → 复制 Webhook 地址 |

## 分层结构（单一真源 + fail-soft + 门控）

```
纯叶子（零 IO / 确定性 / 可独立审计）
  msgChannelCore.js   出站报文 + 加签（钉钉 HMAC、飞书 HMAC、企业微信无签）；平台归一；门 KHY_MSG
  msgInboundCore.js   入站验签 + 解密 + 解析（钉钉验签、飞书 AES-256-CBC + challenge、企业微信 WXBizMsgCrypt）
IO 层
  msgConfigStore.js   配置读写 ~/.khyos/msg.json（0600，字段白名单，原子写 + .bak）
  msgSender.js        原生 http/https 发送（永不抛、无重定向、64K 上限、SSRF 守卫）
渠道类（wiring）
  channels/{dingtalk,feishu,wecom}Channel.js   继承 BaseChannel，sendMessage / handleInbound / emit 'message'
  channels/messageRouter.js                    _bootstrapChannels 读 store 注册三渠道（门 KHY_MSG，fail-soft）；
                                               注册到渠道后自动接线 AI 回复桥（门 KHY_MSG_AUTOREPLY）
  messaging/msgReplyBridge.js                  入站文本 → khy AI 回答 → 回发原会话（闭合双向环，fail-soft）
入口
  routes/webhooks.js  POST /webhooks/{dingtalk,feishu}、GET+POST /webhooks/wecom（验签失败 401）
  cli/handlers/msg.js CLI 处理器；cli/router.js case 'msg'；constants/commandSchema.js 三处登记
```

## 使用（发送）

```bash
# 1) 配置某平台的 webhook（值为 - 时从 stdin 读，避免密钥进 shell 历史）
khy msg set dingtalk webhook=https://oapi.dingtalk.com/robot/send?access_token=xxx
khy msg set dingtalk secret=-      # 加签密钥从 stdin 读

# 2) 看已配置的平台（webhook 掩码显示）
khy msg status

# 3) 发一条 / 发测试
khy msg send dingtalk 库存已同步完成
khy msg test feishu

# 4) 支持的平台 / 清除 / 开关
khy msg platforms
khy msg clear wecom      # 省略平台名则清空全部
khy msg off              # 关闭消息能力（持久化 KHY_MSG）
```

各平台加签规则（出站，纯叶子 `msgChannelCore` 单一真源）：

- **钉钉**：`sign = urlEncode(base64(HMAC_SHA256(key=secret, msg=timestampMs+"\n"+secret)))`，
  以 `&timestamp=<ms>&sign=<sign>` 追加到 webhook；无 secret 时不加签。
- **飞书**：`sign = base64(HMAC_SHA256(key=timestampSec+"\n"+secret, msg=""))`，放进请求体
  `{ timestamp, sign }`。
- **企业微信**：群机器人不需要签名。

## 使用（接收）

把 `https://<你的公网地址>/webhooks/<平台>` 填到平台后台的机器人 / 事件订阅配置：

| 平台 | 回调 | 校验 / 解密 |
| --- | --- | --- |
| 钉钉 | `POST /webhooks/dingtalk` | 请求头 `timestamp` + `sign`，HMAC-SHA256 验签 |
| 飞书 | `POST /webhooks/feishu` | `url_verification` 回显 challenge；事件体 AES-256-CBC 解密 |
| 企业微信 | `GET /webhooks/wecom` | 回调地址校验，回显解密后的 echostr 明文 |
| 企业微信 | `POST /webhooks/wecom` | `msg_signature` 验签 + WXBizMsgCrypt 解密，被动响应留空 200 |

验签失败一律返回 **401**；渠道未注册时 fail-soft（记日志，返回 200 / 空），不影响启动。

## 双向闭环（「像龙虾一样」：用户 → 服务 → 用户）

入站消息在本路由完成**验签 → 解密 → 解析 → emit 'message'** 后，会由 `msgReplyBridge`
把文本当作 prompt 交给 khy 的 AI chat 内核（经 `aiChatPort` 这个 IoC seam），再把回答
经 `messageRouter._handleMessage` 的既有回发逻辑发回**用户所在的原会话**：

| 平台 | 回发目标（AI 自动回复落到哪） |
| --- | --- |
| 钉钉 | 入站 `sessionWebhook`（threadId），即发消息的那个群 |
| 飞书 | 入站会话对应的群机器人 webhook |
| 企业微信 | 入站会话对应的群机器人 webhook |

接线时机：`_bootstrapChannels` 注册到 ≥1 个 IM 渠道后，若 `KHY_MSG_AUTOREPLY`（default-on）
开启且尚未设置 AI handler，则自动调用 `wireReplyBridge(router)`。纯 Slack 部署（无 msg 渠道）
不受影响。

**fail-soft 关键点**：

- **无 AI chat（headless / 后端 server 未加载 CLI 的 chat 内核）**：`aiChatPort.getAiChat()`
  返回 `null`，桥梁只记一次日志、返回 `null`（= 不回复），入站不崩、不误发空消息。
- **chat 返回空 / 抛错 / 文本为空**：一律返回 `null`，不回发。
- **关闭自动回复**：设 `KHY_MSG_AUTOREPLY=off`（或 `0`/`false`/`no`），入站仍解析入库，
  但不自动回答（回到「记录后丢弃」的旧行为，与 Slack 一致）。

验证：桥梁与闭环均可**离线单测**——`msgReplyBridge.test.js` 覆盖门控 / 文本归一 / fail-soft /
接线策略；`msgReplyRoundtrip.test.js` 用真实 `MessageRouter` + 假渠道 + 注入的假 chat，
断言 AI 回复被发回原 `channelId` / `threadId`。真正端到端仍需①公网可达回调地址
②平台后台把地址配好 ③进程内已注册 chat 内核。

## 连接稳定（重试与退避）

为保证「链接的稳定」，发送层 `msgSender` 对**瞬时故障**做指数退避重试，对**永久错**立即返回
（重试只会白打平台 API）。发送与龙虾回发共用同一发送通道，因此两个方向都受益。

| 结果 | 是否重试 | 说明 |
| --- | --- | --- |
| 网络错 / 请求超时 | ✅ 重试 | 传输层瞬时抖动 |
| HTTP 429 | ✅ 重试 | 平台限流，退避后再试 |
| HTTP 5xx | ✅ 重试 | 服务端瞬时错误 |
| HTTP 4xx | ❌ 不重试 | 鉴权 / 请求错误（永久） |
| 业务错误码（2xx 但 errcode≠0） | ❌ 不重试 | 签名不匹配 / 内容非法 / token 失效（永久） |
| 非法 URL / SSRF 守卫拒绝 | ❌ 不重试 | 永久错 |

旋钮（env，可选）：

- `KHY_MSG_MAX_RETRIES`：额外重试次数，默认 `2`（总尝试 = 1 + 重试），夹到 `[0, 5]`；设 `0` 关闭重试。
- `KHY_MSG_RETRY_BASE_MS`：退避基数，默认 `500`ms；第 n 次退避 = `base·2^(n-1)`，单次封顶 30s。

退避时序（默认）：第 1 次重试等 500ms，第 2 次等 1000ms……。返回对象额外带 `attempts`
（总尝试次数）。全程 fail-soft：重试耗尽后以 `{ ok:false, error }` 返回，绝不抛。

## 安全约束

- 运行时机密（带 token 的 webhook URL、加签 / 收信密钥）只落 `~/.khyos/msg.json`（0600），
  **绝不进包 / 源码 / 提交**。
- 所有出站请求目标 URL 必须通过 `urlSafety.assertPublicHttpUrlResolved(url, label)`
  （DNS-rebind 安全，私网 / 本机地址抛错），杜绝 SSRF。
- 能力总开关 `KHY_MSG`（default-on）；关闭 / 异常 / 入参不全时逐层 fail-soft 回退，
  绝不因消息子系统拖垮主流程。

## 验证（做完的定义）

```bash
cd services/backend
node --test 'tests/services/messaging/*.test.js'   # 叶子 + store + sender(含 retry) + channels + 路由 + 回复桥 + 龙虾环
node --test tests/cli/handlers/msgHandler.test.js   # CLI handler（deps 注入，零真实网络）
```
