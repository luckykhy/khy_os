<!--
模板：CRDT 实时协作编辑引擎
触发：需要为 khy-os 添加「多人同时编辑同一文件」的实时同步能力时使用。
占位符：{{KHYOS_PATH}}
依赖：需先在 khy-os 根目录运行 `npm install yjs y-websocket`（或等效 CRDT 库）
-->

## 📋 提示词正文（复制下面代码块内的全部内容）

```text
【角色】你是 khy-os 的「实时协作引擎工程师」。你的任务是在现有 khy-os 架构中，
为文件编辑层引入 CRDT 冲突解决能力，让多个 khy-os 实例（或多台机器）能够同时
编辑同一份文件，变更自动合并，不再依赖悲观锁 + 冲突副本的人工合并。

【工作目录】
{{KHYOS_PATH}}

═══════════════════════════════════════════════════
【当前状态分析】（先理解再动手）
═══════════════════════════════════════════════════

khy-os 当前的文件编辑并发控制：

1. services/backend/src/tools/_fileLock.js
   - 机制：fs.mkdir 原子排他锁 + 心跳保活 + 僵尸进程回收
   - 行为：写操作必须拿到 exclusive 锁，超时 30s 抛 FileLockTimeoutError
   - 降级：锁超时后调用方写 conflictCopyPath() → app_conflict_khy<pid>.py
   - 结果：两个副本，需人工合并

2. services/backend/src/bridge/bridgeServer.js
   - 已有 WebSocket 服务器（端口 9222），支持消息广播 + 50 条历史回放
   - 消息类型：repl_input / repl_output / approval_request / approval_response
   - 缺：没有文件变更事件类型

3. services/backend/src/services/aiManagementKhyosWs.js
   - 已有 /ws 总线的 khyos_* 消息族
   - 缺：没有 khyos_file_changed / khyos_file_lock / khyos_file_unlock

4. services/backend/src/services/agentCommunicationService.js
   - 多 Agent 间通信，但仅限进程内内存队列
   - 缺：跨实例的文件变更通知

═══════════════════════════════════════════════════
【目标架构】
═══════════════════════════════════════════════════

在不破坏现有 pessimistic lock 的前提下，新增一层「乐观并发控制」：

+--------------------------------------------------+
|              khy-os 编辑层                         |
+--------------------------------------------------+
|                                                  |
|  编辑请求 → CRDT 合并引擎（新增）                    |
|              |- 无冲突 → 直接写文件 + 推送变更事件    |
|              |- 有冲突 → auto-merge（CRDT 保证收敛） |
|                                                  |
|  +----------+  +---------------+  +------------+  |
|  | _fileLock|  | fileSyncBus   |  | WebSocket  |  |
|  | (保留)   |  | (新增)        |  | 扩展       |  |
|  | 兜底保护  |  | pub/sub 变更  |  | push 通知  |  |
|  +----------+  +---------------+  +------------+  |
|                                                  |
+--------------------------------------------------+

设计原则：
1. _fileLock.js 保留不动（兜底保护），CRDT 层在其上方作为「快路径」
2. 无 CRDT 冲突时走快路径：读 → 本地改 → CRDT merge → 写文件 + push 事件
3. 有冲突时 CRDT 自动合并（Yjs 保证所有副本最终一致）
4. 变更事件通过 WebSocket push 给所有订阅者（替代前端轮询 khyos_tasks_get 模式）
5. 整个方案 zero-dependency 可选：若 yjs 不可用，降级为现有悲观锁行为

═══════════════════════════════════════════════════
【CRDT 选型】（Yjs，理由如下）
═══════════════════════════════════════════════════

为什么选 Yjs：
- 二进制大小 < 100KB，无原生依赖
- Y.XmlFragment 天然适合结构化文档（代码/Markdown）
- Y.Text 支持 character-level 精度（光标位置、插入/删除）
- 网络无关：Yjs 的 update 可序列化为 Uint8Array，通过任意 transport 传播
- 已有 y-websocket 提供开箱即用的 provider

备选（若团队偏好）：
- Automerge：同样成熟，API 更 FP，但包体略大
- ShareDB + OT：需要中央服务器做 OT 转换，架构更重

═══════════════════════════════════════════════════
【具体实现要求】
═══════════════════════════════════════════════════

【第 1 层】新增 services/backend/src/services/fileSyncBus.js

职责：文件变更的 pub/sub 总线，替代当前散落的轮询模式。

接口：
  subscribe(filePath, callback) → { unsubscribe }
    订阅一个文件的变更，callback 接收变更事件。

  publish(filePath, change)
    发布一个文件的变更（调用方：Edit/Write 工具成功后）。
    change = { type: 'edit'|'write'|'delete', diff_summary, editor, timestamp }

  getActiveEditors(filePath) → [{ editor, since, heartbeatAt }]
    查询当前谁在编辑哪个文件（活跃编辑会话注册表）。

  registerEditSession(filePath, editorId, ttlMs = 30000)
    注册/续期编辑会话（acquire 锁时调用）。

  unregisterEditSession(filePath, editorId)
    取消注册（释放锁时调用）。

实现要点：
- 用内存 Map + 定时 GC（TTL 过期自动清理僵尸会话）
- heartbeat 由调用方每 5s 续期（与 _fileLock.js 心跳模式一致）
- 发布变更时同步更新 Yjs document（见第 2 层）

【第 2 层】新增 services/backend/src/services/crdtEngine.js

职责：文件内容的 CRDT 表示与合并。

接口：
  initDoc(filePath) → Y.Doc
    初始化一个文件的 CRDT 文档（从磁盘内容加载，懒加载）。

  applyRemoteUpdate(filePath, updateBytes) → { merged, conflicts }
    应用一个远端变更到本地文档。

  localUpdateSince(filePath, sinceVector) → { updateBytes, newVector }
    从本地文档生成变更包（用于发送给其他实例）。

  flushToDisk(filePath) → { ok, error }
    将 CRDT 文档快照写回磁盘（合并后调用）。

  getText(filePath) → string
    获取当前文档的文本内容（用于 diff / 预览）。

实现要点：
- 每个被共享的文件对应一个 Y.Doc（懒加载，首次 edit 时创建）
- Y.Doc 存在内存 WeakMap 中，不持有磁盘引用
- flushToDisk 仅在无 pending conflict 时执行（CRDT merge 保证无冲突）
- 若 Yjs 模块不可用（npm 包缺失），所有方法返回 { degraded: true }，
  调用方降级为现有悲观锁路径（零侵入现有代码）

【第 3 层】扩展 WebSocket 消息类型

在 aiManagementKhyosWs.js 的 khyos_* 消息族中新增三种消息：

  khyos_file_changed  ←  { path, change_type, editor, timestamp, diff_summary }
  khyos_file_lock     ←  { path, editor, expires_at }
  khyos_file_unlock   ←  { path, editor }

在前端 apps/ai-frontend/src/views/ 相关组件中：
- AIChat.vue / Markdown.vue 的侧边栏文件列表增加「正在被 XX 编辑」指示
- 接收到 khyos_file_changed 后自动刷新对应文件的预览

【第 4 层】改造 Edit/Write 工具（最小侵入）

当前调用链：
  EditTool → _fileLock.acquireForToolCall → fs.readFile → 改内容 → fs.writeFile → release

改造后（快路径优先）：
  EditTool → _fileLock.acquireForToolCall（保留兜底）
         → crdtEngine.localUpdateSince（生成变更包）
         → fs.writeFile（写合并后的内容）
         → fileSyncBus.publish（push 变更给订阅者）
         → release

关键：_fileLock 保留，CRDT 在其上方作为「无锁快路径」。
只有在 CRDT 检测到真正无法自动合并的结构冲突（如同一行被完全不同的语义替换）
时才 fallback 到悲观锁的冲突副本行为。

═══════════════════════════════════════════════════
【边界情况处理】
═══════════════════════════════════════════════════

1. Yjs 模块加载失败 → 所有 CRDT 方法返回 { degraded: true }，
   Edit/Write 工具走现有悲观锁路径，功能不变
2. 两个实例同时编辑完全不相关的文件 → CRDT 无交集，自动无冲突合并
3. 两个实例同时编辑同一行 → Yjs Y.Text 保证 character-level 原子合并
4. 网络断开 → 变更缓存在本地 Y.Doc 中，重连后同步
5. 文件被外部程序（非 khy-os）修改 → 检测到 mtime 变化时重新 initDoc
6. 大文件（> 10MB）→ 不走 CRDT 路径，回退到悲观锁（代码类文件通常 < 1MB）

═══════════════════════════════════════════════════
【验收标准】（逐条自测勾选）
═══════════════════════════════════════════════════

□ 1. 现有功能零回归：Edit/Write/MultiEdit 工具行为与之前完全一致
□ 2. 同一文件，实例 A 改第 5 行、实例 B 改第 20 行 → 两者均成功，文件包含两处修改
□ 3. 同一文件，实例 A 和 B 同时修改同一行 → 自动合并无冲突副本产生
□ 4. WebSocket 客户端收到 khyos_file_changed 事件，包含正确的 path 和 editor
□ 5. 前端文件列表实时显示「XX 正在编辑此文件」
□ 6. Yjs 不可用时（node_modules 中删除 yjs），所有编辑功能正常降级为悲观锁
□ 7. npm run check:layout 通过（不新增违规目录层级）
□ 8. node scripts/ci/check-agent-rules.js --changed 无 error
□ 9. cd services/backend && npx eslint src/ --max-warnings 0
□ 10. cd services/backend && npx jest（新增文件如有单测）

═══════════════════════════════════════════════════
【khy-os 工程红线】（违反任何一条即返工）
═══════════════════════════════════════════════════

1. 零硬编码：字面量 IP/端口/绝对路径/生产域名一律禁止；端点来自
   constants/serviceDefaults.js 或 env 覆盖；端口占用自动探测下一可用。
2. 状态透明：面向用户的状态/日志必须「动作+目标+进度」三维；
   禁止「正在工作/处理中/Loading/Connecting/请稍候/Processing」单独出现。
3. 基于活动的超时：长任务禁止固定时长硬 kill，用空闲重置计时器。
4. 终端渲染：与回滚输出共存的 CLI 禁用 ANSI 滚动区 \x1B[n;mr，
   用保存/恢复光标模式；全屏备用缓冲区除外。
5. 风格：JS 2 空格、单引号、分号；用户可见串中文；注释英文；
   CommonJS + 'use strict'；fail-soft 叶子返回 {ok:false,error} 不抛。
6. 版本双轨：不手改 platform/khy_platform/__init__.py。

═══════════════════════════════════════════════════
【代码组织与命名规范】（遵循上述红线）
═══════════════════════════════════════════════════

1. 新文件放在 services/backend/src/services/ 下
2. 文件名 snake_case（如 fileSyncBus.js、crdtEngine.js）
3. 所有用户可见字符串用中文；代码注释用英文
4. CommonJS + 'use strict' + 单引号 + 2 空格 + 分号
5. 叶子函数返回 { ok: false, error } 不抛异常；fail-soft
6. 新增文件在 services/backend/package.json 的 dependencies 中加 yjs
   （devDependency 也行，因为 CRDT 是可选增强）
7. 在 services/backend/src/services/gateway/adapters/ 中
   不需要新增适配器（CRDT 不是 AI 模型）

═══════════════════════════════════════════════════
【验证命令】（在 khy-os 根目录依次执行）
═══════════════════════════════════════════════════

- npm install yjs y-websocket --save
- npm run check:layout
- node scripts/ci/check-agent-rules.js --changed
- cd services/backend && npx eslint src/ --max-warnings 0 && npx jest
- khy doctor
```
