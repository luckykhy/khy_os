import { contextBridge, ipcRenderer } from 'electron';
// Phase 0b: 暴露首批 20 个高频 RPC 方法（stub 实现）
const api = {
    // 窗口控制
    minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
    maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
    closeWindow: () => ipcRenderer.invoke('window:close'),
    // 设置读写
    getSettings: () => ipcRenderer.invoke('settings:get'),
    setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    // 数据存储路径变更（复制数据 + 写指针，见 main settings:setDataPath）
    setDataPath: (newPath) => ipcRenderer.invoke('settings:setDataPath', newPath),
    // 主题
    getTheme: () => ipcRenderer.invoke('theme:get'),
    setTheme: (mode) => ipcRenderer.invoke('theme:set', mode),
    onThemeChanged: (cb) => {
        const listener = (_e, mode) => cb(mode);
        ipcRenderer.on('theme:changed', listener);
        return () => ipcRenderer.removeListener('theme:changed', listener);
    },
    // 界面缩放（main 侧 setZoomFactor + 持久化，返回实际生效值）
    setZoomFactor: (factor) => ipcRenderer.invoke('zoom:set', factor),
    // 文件系统
    openDirectoryPicker: () => ipcRenderer.invoke('fs:openDirectory'),
    readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
    writeFile: (path, content) => ipcRenderer.invoke('fs:writeFile', path, content),
    // ── 代码查看（codeViewer.*）：四态只读预览 + workspace 文件索引 ──
    codeViewerRead: (filePath) => ipcRenderer.invoke('codeViewer:read', filePath),
    workspaceListFiles: (query) => ipcRenderer.invoke('workspace:listFiles', query || ''),
    // AI 网关
    aiSend: (payload) => ipcRenderer.invoke('ai:send', payload),
    aiStream: (payload) => ipcRenderer.invoke('ai:stream', payload),
    // host 流式回调（main → host aiGateway onChunk）
    onAiChunk: (cb) => {
        const listener = (_e, data) => cb(data);
        ipcRenderer.on('ai:chunk', listener);
        return () => ipcRenderer.removeListener('ai:chunk', listener);
    },
    onAiResult: (cb) => {
        const listener = (_e, data) => cb(data);
        ipcRenderer.on('ai:result', listener);
        return () => ipcRenderer.removeListener('ai:result', listener);
    },
    aiAbort: () => ipcRenderer.invoke('ai:abort'),
    // ── 窗口菜单动作（L 区自绘下拉） ──
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    openPath: (dir) => ipcRenderer.invoke('app:openPath', dir),
    getBrandingLinks: () => ipcRenderer.invoke('app:brandingLinks'),
    // 会话
    createSession: (workspacePath) => ipcRenderer.invoke('session:create', workspacePath),
    listSessions: (limit) => ipcRenderer.invoke('session:list', limit),
    // ── 自动化（定时任务）：store 落盘 + 调度 tick + host ai.generate 执行 ──
    automationsList: () => ipcRenderer.invoke('automation:list'),
    automationsCreate: (input) => ipcRenderer.invoke('automation:create', input),
    automationsUpdate: (id, patch) => ipcRenderer.invoke('automation:update', id, patch),
    automationsDelete: (id) => ipcRenderer.invoke('automation:delete', id),
    automationsRunNow: (id) => ipcRenderer.invoke('automation:runNow', id),
    // ── 插件设置页：pluginStore registry（已安装/发现两 tab 的正门通道）──
    pluginsList: () => ipcRenderer.invoke('plugin:list'),
    pluginsInstall: (input) => ipcRenderer.invoke('plugin:install', input),
    pluginsSetEnabled: (id, enabled) => ipcRenderer.invoke('plugin:setEnabled', id, enabled),
    pluginsUninstall: (id) => ipcRenderer.invoke('plugin:uninstall', id),
    pluginsCheckUpdates: () => ipcRenderer.invoke('plugin:checkUpdates'),
    // ── MCP 设置页：mcpStore 落盘（用户自建服务器）+ plugin:list 宿主区（只读派生）──
    mcpList: () => ipcRenderer.invoke('mcp:list'),
    mcpCreate: (input) => ipcRenderer.invoke('mcp:create', input),
    mcpSetEnabled: (id, enabled) => ipcRenderer.invoke('mcp:setEnabled', id, enabled),
    mcpDelete: (id) => ipcRenderer.invoke('mcp:delete', id),
    mcpImport: (rows) => ipcRenderer.invoke('mcp:import', rows),
    // ── Agent 扩展条目（命令/钩子/技能/子智能体/记忆）— agentItemStore 正门 ──
    agentList: (kind) => ipcRenderer.invoke('agent:list', kind),
    agentCreate: (kind, input) => ipcRenderer.invoke('agent:create', kind, input),
    agentSetEnabled: (kind, id, enabled) => ipcRenderer.invoke('agent:setEnabled', kind, id, enabled),
    agentDelete: (kind, id) => ipcRenderer.invoke('agent:delete', kind, id),
    agentImport: (kind, rows) => ipcRenderer.invoke('agent:import', kind, rows),
    // ── 索引库页 — indexStore（磁盘扫描统计）──
    indexList: () => ipcRenderer.invoke('index:list'),
    indexCreate: (input) => ipcRenderer.invoke('index:create', input),
    indexRebuild: (id) => ipcRenderer.invoke('index:rebuild', id),
    indexSetEnabled: (id, enabled) => ipcRenderer.invoke('index:setEnabled', id, enabled),
    indexDelete: (id) => ipcRenderer.invoke('index:delete', id),
    // ── 外部 Agent 迁移（引导弹窗数据迁移向导，D5/s-8）+ 数据根路径只读 ──
    migrationScan: () => ipcRenderer.invoke('migration:scan'),
    migrationImport: (sourceId) => ipcRenderer.invoke('migration:import', sourceId),
    getDataHome: () => ipcRenderer.invoke('app:dataHome'),
    // ── 审查面板：只读 Git 状态（main 侧 git status --porcelain -z --branch）──
    gitStatus: () => ipcRenderer.invoke('git:status'),
    // Token 用量（后端 tokenUsageService 真源，经 host 桥 CH-2）
    getTokenUsage: () => ipcRenderer.invoke('token:usage'),
    // 用量历史：近 N 日曲线 + 按模型分桶（使用统计页，ZC-ALIGN-001 P13）
    getUsageHistory: (days) => ipcRenderer.invoke('usage:history', days),
    // 上下文窗口估算（estimateTokens 真源启发式 + KHY_CONTEXT_WINDOW 上限，P3-5/P3-6）
    estimateContextSize: (text) => ipcRenderer.invoke('context:size', text),
    // 平台信息
    getPlatform: () => process.platform,
    // 版本
    getVersion: () => ipcRenderer.invoke('app:version'),
    // 工作区根目录（main 进程 cwd）
    getWorkspacePath: () => ipcRenderer.invoke('app:workspacePath'),
    // ── 密钥与端点管理 (DESIGN-ARCH-091 §6, P1) ──
    // keys
    keysList: () => ipcRenderer.invoke('keys:list'),
    keysAdd: (input) => ipcRenderer.invoke('keys:add', input),
    keysUpdate: (provider, keyId, patch) => ipcRenderer.invoke('keys:update', provider, keyId, patch),
    keysRemove: (provider, keyId) => ipcRenderer.invoke('keys:remove', provider, keyId),
    keysToggle: (provider, keyId, enabled) => ipcRenderer.invoke('keys:toggle', provider, keyId, enabled),
    keysReveal: (provider, keyId) => ipcRenderer.invoke('keys:reveal', provider, keyId),
    keysImport: () => ipcRenderer.invoke('keys:import'),
    // providers (custom metadata)
    providersList: () => ipcRenderer.invoke('providers:list'),
    providersAdd: (p) => ipcRenderer.invoke('providers:add', p),
    providersRemove: (id) => ipcRenderer.invoke('providers:remove', id),
    // endpoints / models
    endpointsPresets: () => ipcRenderer.invoke('endpoints:presets'),
    endpointsValidate: (input) => ipcRenderer.invoke('endpoints:validate', input),
    modelsFetch: (input) => ipcRenderer.invoke('models:fetch', input),
    // cards (credential-free)
    cardsList: () => ipcRenderer.invoke('cards:list'),
    cardsAdd: (input) => ipcRenderer.invoke('cards:add', input),
    cardsUpdate: (cardId, patch) => ipcRenderer.invoke('cards:update', cardId, patch),
    cardsRemove: (cardId) => ipcRenderer.invoke('cards:remove', cardId),
    // agents (Mode B 一键激活)
    agentsMatrix: () => ipcRenderer.invoke('agents:matrix'),
    agentsApply: (input) => ipcRenderer.invoke('agents:apply', input),
    agentsRevert: (app) => ipcRenderer.invoke('agents:revert', app),
    // proxy
    proxyStatus: () => ipcRenderer.invoke('proxy:status'),
    proxyStart: () => ipcRenderer.invoke('proxy:start'),
    // health / audit
    healthProbe: (input) => ipcRenderer.invoke('health:probe', input || {}),
    healthAuditList: (limit) => ipcRenderer.invoke('health:audit-list', limit),
    healthAuditExport: (dest) => ipcRenderer.invoke('health:audit-export', dest)
};
contextBridge.exposeInMainWorld('__KHYOS__', api);
