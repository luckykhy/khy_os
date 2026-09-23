<!--
模板：密钥与端点中心管理（KeyManager）GUI — P1 实施
任务 ID：T-023
设计真源：khy-os docs/03_DESIGN_设计/[DESIGN-ARCH-091] 密钥与端点中心管理（KeyManager）GUI设计规范.md
占位符：{{KHYOS_PATH}}
-->

## 📋 提示词正文（复制下面代码块内的全部内容）

```text
【角色】你是 khy-os 的「密钥与端点中心管理（KeyManager）工程师」。用户有
Claude Code / OpenCode / Qoder CLI / Y-code / Codex 等大量 Agent，密钥与端点
配置散落各处，「这个配了、那个没配」。你的任务是在 khy-os 桌面端建一个
KeyManager 独立 GUI，实现「一处配置，全部 Agent 点击激活即用」，本轮交付
设计规范 [DESIGN-ARCH-091] 的 P1 切片。

【工作目录】
{{KHYOS_PATH}}

═══════════════════════════════════════════════
【设计真源】（动手前必读，逐条对齐，不得凭记忆实现）
═══════════════════════════════════════════════
docs/03_DESIGN_设计/[DESIGN-ARCH-091] 密钥与端点中心管理（KeyManager）GUI设计规范.md
  §3  资产盘点（复用清单，禁止重复发明）
  §4  模块布局 / 数据层三 JSON SSoT / 后端服务解析四级降级
  §5  独立窗口与 T1-T4 界面
  §6  IPC 契约（keys:*/endpoints:*/agents:*/health:*/proxy:status）
  §7  安全规范（脱敏不变式 / reveal 限流 / 审计 / 原子写 .bak）
  §8b 「任意模型 + 双激活模式」（Mode B khy 聚合 = 本轮核心）

═══════════════════════════════════════════════
【现状资产】（复用，不新造轮子）
═══════════════════════════════════════════════
- services/backend/src/services/apiKeyPool.js — api_keys.json 池 + ENV_KEY_MAP + 热重载
  （apiKeyPoolWatcher.js）；GUI 写完文件即全系统收敛，无需重启任何进程
- services/backend/src/services/domain/config/ccSwitch/{store.js,constants.js,
  appWriters.js} — 卡片（无凭据设计，keyId 指向池）+ 8 个外部 app 的 live-config
  writer（preflight + fail-soft + 原子 merge-write）
- services/backend/src/services/gateway/proxyServer.js — 本地双协议代理
  （/v1/chat/completions + /v1/messages + /v1/models 聚合 + protocolConverter），
  鉴权 proxy_server_auth.json（relay token），实际端口写 proxy_server_runtime.json
- services/backend/src/services/gateway/qoderProxyModels.js — qodercli 激活走
  KHY_QODER_PROXY opt-in 门控（未开则池无 qoder 条目，防死条目）
- services/backend/src/services/gateway/providerPresets.js — 15 端点预设（公共端点
  单一真源，零硬编码）
- services/backend/src/services/configGuard.js / utils/dataHome.js — 原子写自愈 /
  便携 dataHome 解析（GUI 落盘必须遵循，便携部署解析到 <root>/.khy）
- apps/khyos-desktop：Electron44 + React19；src/renderer/components/settings/
  SettingsPage.tsx 的 providers 组是空 stub（替换它）；src/preload/index.ts
  的 __KHYOS__ 面（扩展）；tests/desktopUiContract.test.cjs 的 D1-D10 契约
  （新通道命名 namespace:action，必须继续过 D6）

═══════════════════════════════════════════════
【P1 交付清单】
═══════════════════════════════════════════════
1. main 层（apps/khyos-desktop/src/main/keyManager/）
   - keyStore.ts：api_keys.json / custom_providers.json / cc_switch.json 的 CRUD
     + 原子写（.tmp→rename）+ 写前 .bak + 读损坏自愈 + maskKey()（前3+后4+
     sha256前8 指纹，全系统唯一脱敏函数）
   - agentWriters.ts：§4.3 四级解析（KHY_BACKEND_SERVICES env → 便携根 → 仓库
     相对 → 内置最小 writer 降级 claude-code/opencode/ycode/command-code），
     降级事件写审计
   - audit.ts：key_manager_audit.jsonl 追加（reveal/apply/import/降级；永不含明文）
   - health.ts：P1 可先留接口 + 短 I/O 探测（10s 合法例外，并发上限 4，单条
     卡死不阻塞批次，无整批硬 kill）
2. 独立窗口 keyManagerWindow.ts（1080×720 / min 880×560 / frame:false /
   contextIsolation）+ 三个入口：主窗菜单「工具→密钥与端点管理」、设置页
   providers 组（替换 stub 空壳）、`npm run dev -- --key-manager` 独立启动
   （不建主窗）
3. T1 Provider 与密钥：池 CRUD + env 叠加来源标记 + reveal（二次确认 + 60s 限流
   + 审计）+ 一键导入 docs/opencode-provider-keys.md（占位值/public 拒收）+
   自定义 provider 保存时自动拉取 GET {endpoint}/models 填充模型下拉
   （失败不阻塞，标「未验证」）+ 只读「网关聚合模型目录」视图
4. T2 端点预设：卡片 CRUD（预设目录来自 providerPresets 等价数据）+ 端点可达性
   即时校验 + key 从池下拉选择（维持 cc_switch 无凭据设计）
5. Mode B 一键激活（本轮核心）：对 claude-code / opencode / qodercli 三高频
   Agent，写入指向 khy 本地代理的 relay 哨兵端点 + token（proxy 端口读
   proxy_server_runtime.json，绝不含真实 provider key）；qodercli 提供
   KHY_QODER_PROXY 开关与端点回填；proxy 未运行时显示
   「khy 代理未运行：启动本地网关后重试（动作: 启动 目标: 127.0.0.1）」并
   提供一键启动
6. 测试（§10.1 全量 + ⑲⑳㉑ + E1/E5/E7/E8 见下）

═══════════════════════════════════════════════
【验收标准】（规范 §11 P1 出口准则，逐条自测勾选）
═══════════════════════════════════════════════
□ 1. keyStore/agentWriters/health/keyManagerContract 四组测试全绿
     （node --test apps/khyos-desktop/tests/key*.test.mjs 等）
□ 2. ⑲ Mode B 产物断言：激活产物只含 relay 哨兵端点+token，grep 不出任何
     真实 provider key 明文
□ 3. ⑳ /models 自动拉取三分支（成功填充 / 404 手工兜底 / 401 标未验证不阻塞）
□ 4. ㉑ qoder 门控：未设 KHY_QODER_PROXY 时池无 qoder 死条目
□ 5. services/backend 回归全绿（npm test --prefix services/backend；重点
   apiKeyPoolHotReload / keySelector / ccSwitch 相关——共享格式不能破后端）
□ 6. E1 热重载闭环：GUI 写入 api_keys.json 后，另开进程 khy gateway 5s 内
   可见新 key
□ 7. E5 并发写：GUI 与 CLI 同写 api_keys.json 无交叉损坏；损坏注入后 .bak
   自愈
□ 8. E7 Mode B 一键闭环：激活 opencode+claude-code 后两 Agent 冒烟成功；
   GUI 只换卡片模型（Agent 配置零 diff）后重跑命中新模型
□ 9. E8 qodercli：KHY_QODER_PROXY=true + 端点指向 khy 代理后，khy 池出现
   qoder 条目，qodercli 会话命中 khy 模型
□ 10. desktopUiContract D1-D10 继续全绿（新 IPC 通道过 D6 namespace:action）
□ 11. node scripts/ci/check-agent-rules.js --changed 无 error（零硬编码端点/
     状态文案合规）；key_manager_audit.jsonl 已进 .gitignore 与 MANIFEST.in
     排除清单

═══════════════════════════════════════════════
【工程红线】（khy-os AGENTS.md，违反任何一条即返工）
═══════════════════════════════════════════════
1. 零硬编码：代理端口一律读 proxy_server_runtime.json（或 env 覆盖），新文件
   不得出现 127.0.0.1:3000 类字面量；预设端点全部来自 providerPresets /
   serviceDefaults 等价真源
2. 状态透明：「已激活 opencode → khy 聚合 (proxy:31288/v1, 模型 glm-5.3)」
   动作+目标+进度；错误走 Rule 2.2 模板；激活后附「重启 Agent 生效（仅
   claude-code 支持热切换）」
3. 脱敏不变式：除 keys:reveal 外任何 IPC 负载 / 日志 / 审计行不含完整 key
4. 原子写 + .bak 自愈对齐 configGuard 语义；文件 POSIX chmod 600
5. 超时：单条探测 10s 属短 I/O 合法例外；批量无整批硬 kill；并发上限 4
6. 品牌：KhyOS 字样，不复用 ZCode 资产；i18n settings.keyManager.* 命名空间，
   过 check-i18n-fidelity / check-brand-replacement
7. 不新增第四种存储：只写三 JSON + 审计 jsonl（§4.2）
8. 代码风格：TS 模块遵循 khyos-desktop 既有约定；中文文案 / 英文注释

═══════════════════════════════════════════════
【验证命令】（在 khy-os 根目录依次执行）
═══════════════════════════════════════════════
- node --test apps/khyos-desktop/tests/keyStore.test.mjs
- node --test apps/khyos-desktop/tests/agentWriters.test.mjs
- node --test apps/khyos-desktop/tests/health.test.mjs
- node apps/khyos-desktop/tests/keyManagerContract.test.cjs
- node apps/khyos-desktop/tests/desktopUiContract.test.cjs   （D1-D10 回归）
- npm test --prefix services/backend                          （共享格式回归）
- node scripts/ci/check-agent-rules.js --changed
- node scripts/ci/check-i18n-fidelity.js && node scripts/ci/check-brand-replacement.js
- cd apps/khyos-desktop && npm run dev -- --key-manager        （手工验收 T1/T2/激活）
```
