# [DESIGN-ARCH-066] 前端代理出站桥 — 选节点实际路由 + 启用/停用开关

> 状态：定稿 · 归属：`services/backend/src/services/proxy/` + `aiManagementProxyEgress.js` + 前端 `ProxyManagement.vue` · 关联：[[DESIGN-ARCH-026]]（系统级服务调用审批网关）、[[IMPL-RPT-009]]（特性访问与代理解耦）

## 一、目标

把前端「代理管理」从**只读节点浏览器**升级为可**选中某节点实际路由流量** + **一键启用/停用代理**。

此前存在两套互不相连的代理系统:

- **A. 每用户订阅浏览器**(前端唯一接触):`/api/proxy-subscriptions` REST + `ProxyManagement.vue`,纯展示(导入/列出/刷新/浏览/复制),节点对象无 id、无 active。
- **B. 机器级真实出站**(此前仅 CLI 触碰):`proxyConfigService.js`(`~/.khyquant/proxy.json`),`applyProxy()` 把 `HTTP_PROXY/HTTPS_PROXY` 写进 `process.env`,被网关出站 `gateway/adapters/_proxyTunnel.js` 消费。

**空白 = A 与 B 之间没有线**。本设计补上这条线。

## 二、诚实边界(硬约束)

仓库**不含代理内核**(clash/mihomo/xray/sing-box)。一个 vmess/ss/trojan 节点的解析对象**本身不能承载流量**——只有 HTTP CONNECT 端点能真正代理。故出站按节点协议分三条路(`proxyCoreConfigGen.classifyNodeEgress`):

| 通道 | 协议 | 承载方式 | 是否需内核 |
| --- | --- | --- | --- |
| `direct-connect` | http / https | 节点自身即 CONNECT 代理 → `applyProxy(node.server:port)` | 否,即时生效 |
| `core-required` | vmess / vless / trojan / ss / ssr | 本机 mihomo 生成配置 + spawn 暴露混合端口 → `applyProxy(127.0.0.1:mixedPort)` | 是,门 `KHY_PROXY_CORE` |
| `unsupported` | socks5 / wireguard / hysteria / tuic … | 首版不接 | — |

**绝不静默失败、绝不谎报生效**:内核缺失时 `proxyCoreManager` 返回结构化 `{ success:false, reason:'core-missing', guidance }`,前端**显式弹指引**(装 mihomo 到 `~/.khyquant/bin/` / 改用 http 节点 / 本机 Clash)。

## 三、分层实现(5 Tier)

- **Tier-1 纯叶子** `proxy/proxyCoreConfigGen.js`:零 IO、确定性、绝不抛、不 mutate 入参。`classifyNodeEgress` + `buildMihomoConfig`(逐协议必填字段校验 + 白名单透传 clash-native 字段 + 生成最小 mihomo 配置骨架 `{mixed-port, allow-lan:false, mode:global, proxies, proxy-groups:[{name:KHY}], rules:['MATCH,KHY']}`)。
- **Tier-2 内核生命周期** `proxy/proxyCoreManager.js`:抄 `tlsSidecar/index.js` 形态(spawn + stdout 握手 + 10s 超时 + SIGTERM→SIGKILL + TCP 探活)。二进制解析 `~/.khyquant/bin/mihomo[.exe]`,**不 buildFromSource**(mihomo 非本仓 Go 源)。门 `KHY_PROXY_CORE`(opt-in 默认关)。依赖(spawn/fs/net)可注入 → 测试喂 fake 全离线证绿。
- **Tier-3 出站编排** `proxyConfigService.js` 新增(纯 additive,旧 `enableProxy/disableProxy/getStatus` 行为不变):`activateNode(node, options)`(按分类走 direct-connect 直接生效 / core-required 经内核 / unsupported 返 reason)、`deactivate()`、`getStatus()` 扩展(附 `activeNode` + `coreStatus`)。
- **Tier-4 REST 桥** `aiManagementProxyEgress.js`(DI 叶子,抄 `aiManagementProjects.js` 形态 `setProxyEgressDeps`):`GET /api/proxy-egress`、`POST /api/proxy-egress/enable {node}`、`POST /api/proxy-egress/disable`。全走已认证每用户路径(`resolveAuthUserId`),无匿名端点。宿主 `aiManagementServer.js` `routeRequest` 分派。
- **Tier-5 前端** `useProxies.js`(egressStatus + fetchEgressStatus/enableNode/disableEgress)+ `ProxyManagement.vue`(顶部启用/停用 el-switch + 当前激活节点/内核状态状态条 + 节点表「使用此节点」按钮 + 当前节点高亮 + 内核缺失显式指引)。

## 四、可验证性声明(B2 纪律)

Tier-1/2/3/4/5 可全离线 `node:test` 证绿(注入 fake spawn/fs/net)。真实 spawn mihomo 二进制并证明流量经真实节点出站**无法离线证绿**——仓库无内核二进制、无 live 节点。故内核管理器交付「生命周期 + 配置生成 + 二进制缺失时指名可执行指引」,真实隧道 E2E 留作运行时(需用户装 mihomo 内核)。

验证:`npm run test:maintainer:proxy-egress`(5 测文件)+ `npm run build --prefix apps/ai-frontend`。
