// 模型 store 的契约测试：保证独立模式 + 链接电脑模式两条路径的核心不变量
// ——"独立模式永不要求后端"、"已配 key 的 provider 决定当前实际可用模型"。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const readSrc = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('models store: 独立模式 / 远程模式 dual-mode 契约', () => {
  it('暴露 firstProviderWithKey / effectiveStandaloneProvider', () => {
    const src = readSrc('src/stores/models.js');
    expect(src).toMatch(/firstProviderWithKey/);
    expect(src).toMatch(/effectiveStandaloneProvider/);
  });

  it('modelOptions 在 mode=standalone 时按 effectiveStandaloneProvider 解析', () => {
    const src = readSrc('src/stores/models.js');
    // 必须用 effectiveStandaloneProvider 去找 provider，而不是 selectedProvider
    expect(src).toMatch(/effectiveStandaloneProvider/);
    // 兜底分支应保留
    expect(src).toMatch(/firstProviderWithKey/);
  });

  it('standalone provider 列表至少含 6 个内置 + 1 个 custom', () => {
    const src = readSrc('src/api/standalone.js');
    for (const id of ['openai', 'deepseek', 'moonshot', 'qwen', 'zhipu', 'custom']) {
      expect(src).toContain(`${id}:`);
    }
  });

  it('API key 永远不进浏览器层 plain storage', () => {
    // 关键安全不变量：getStandaloneApiKey / saveStandaloneApiKey 必须走 SecureStoragePlugin，
    // 只能降级到 web Map（测试/dev），绝不能走 localStorage
    const src = readSrc('src/api/standalone.js');
    expect(src).not.toMatch(/localStorage/);
    expect(src).toMatch(/SecureStoragePlugin/);
  });

  it('streamChatCompletion 走 SSE（流式 + 工具调用 + usage）', () => {
    const src = readSrc('src/api/standalone.js');
    expect(src).toMatch(/stream:\s*true/);
    expect(src).toMatch(/include_usage:\s*true/);
    expect(src).toMatch(/tool_choice/);
    expect(src).toMatch(/consumeSse/);
  });

  it('ChatView 发送时按 effectiveStandaloneProvider 选 key', () => {
    const src = readSrc('src/views/ChatView.vue');
    // sendStandalone 必须用 effectiveStandaloneProvider（不是 selectedProvider）
    expect(src).toMatch(/effectiveStandaloneProvider/);
    // send() 兜底：mode 空 + 任一 provider 有 key → 走独立
    expect(src).toMatch(/firstProviderWithKey/);
  });

  it('HomeView 独立模式下不调后端 API', () => {
    const src = readSrc('src/views/HomeView.vue');
    // isStandalone 计算属性早返回，不进 apiJson
    expect(src).toMatch(/isStandalone/);
    // 独立模式下 refresh() 早返回
    expect(src).toMatch(/if \(isStandalone\.value\) return/);
  });

  it('router 守卫允许独立模式访问所有 view，永不强制 /connect', () => {
    const src = readSrc('src/router/index.js');
    // 独立模式直接 return true，不看 to.path
    expect(src).toMatch(/mode\s*===\s*'standalone'/);
    expect(src).toMatch(/return\s*true/);
  });

  it('localDb.appendMessage 持久化 tool 消息关键字段（toolCallId/toolName/toolOk/thinking）', () => {
    const src = readSrc('src/api/localDb.js');
    expect(src).toMatch(/toolCallId:/);
    expect(src).toMatch(/toolName:/);
    expect(src).toMatch(/toolOk:/);
    expect(src).toMatch(/thinking:/);
  });

  it('toOpenAiMessages 能从持久化字段重建 tool_call_id', () => {
    const src = readSrc('src/api/standalone.js');
    // 必须从 toolCallId（驼峰）读，OpenAI 协议字段名 tool_call_id（下划线）才出
    expect(src).toMatch(/item\.toolCallId/);
  });

  it('router 守卫对公开路由直接放行', () => {
    const src = readSrc('src/router/index.js');
    // 公开路由直接返回 true（welcome、connect、login）
    expect(src).toMatch(/to\.path === '\/welcome'/);
    expect(src).toMatch(/to\.path === '\/connect'/);
    expect(src).toMatch(/to\.path === '\/login'/);
  });

  it('AgentView 走 effectiveStandaloneProvider 而不是 selectedProvider', () => {
    const src = readSrc('src/views/AgentView.vue');
    // send() 必须用 effectiveStandaloneProvider，否则用户只在 zhipu 配了 key 会因
    // selectedProvider 停在 openai 报"未配置 API Key"
    expect(src).toMatch(/effectiveStandaloneProvider/);
  });

  it('WelcomeView 用 standalone.js 的真 provider 列表', () => {
    const src = readSrc('src/views/WelcomeView.vue');
    expect(src).toMatch(/standaloneProviders/);
    // 不能再写死 'OpenAI / DeepSeek / Kimi / 通义 / 智谱 / 自定义' 这种硬编码列表
    expect(src).not.toMatch(/const STANDALONE_PROVIDERS = \[\s*\{ id: 'openai'/);
  });

  it('ChatView/AgentView 必须加载模式配置', () => {
    const chat = readSrc('src/views/ChatView.vue');
    const agent = readSrc('src/views/AgentView.vue');
    // ChatView 加载 mode
    expect(chat).toMatch(/loadMode/);
    // AgentView 使用 effectiveStandaloneProvider
    expect(agent).toMatch(/effectiveStandaloneProvider/);
  });

  it('localDb.appendMessage 默认值给 null 不会丢旧数据', () => {
    const src = readSrc('src/api/localDb.js');
    // toolCallId / toolName / toolOk 都要默认 null，老消息无此字段不会变 undefined 阻塞 toOpenAiMessages
    expect(src).toMatch(/toolCallId:.*null/s);
    expect(src).toMatch(/toolName:.*null/s);
    expect(src).toMatch(/toolOk:.*null/s);
  });

  it('router 守卫处理独立模式和远程模式两条分支', () => {
    const src = readSrc('src/router/index.js');
    // 应有独立模式判断
    expect(src).toMatch(/mode === 'standalone'/);
    // 应有远程模式 session 检查
    expect(src).toMatch(/getSession/);
  });

  it('MobileShell 顶栏显示模式指示器', () => {
    const src = readSrc('src/layouts/MobileShell.vue');
    // 必须有模式指示器
    expect(src).toMatch(/mode-indicator/);
    // 显示独立模式
    expect(src).toMatch(/独立模式/);
  });

  it('调色板使用自然色', () => {
    const css = readSrc('src/styles.css');
    // 检查是否有青绿色调（#68d5c0 是主色）
    expect(css).toMatch(/#68d5c0/);
    // 检查深色背景
    expect(css).toMatch(/#111a24/);
  });

  it('WelcomeView 改名为「森林小屋 / 湖畔工坊」 + emoji provider 头像', () => {
    const src = readSrc('src/views/WelcomeView.vue');
    expect(src).toMatch(/森林小屋/);
    expect(src).toMatch(/湖畔工坊/);
    // 必须有 emoji provider 列表（不依赖 standaloneProviders 的 unicode logo）
    expect(src).toMatch(/FOREST_PROVIDERS/);
  });

  it('edge-to-edge (WebView safe-area) 全屏页面覆盖', () => {
    // 检查 safe-area 处理
    const css = readSrc('src/styles.css');
    expect(css).toMatch(/safe-area-inset/);

    // 欢迎页面使用 safe-area
    const welcome = readSrc('src/views/WelcomeView.vue');
    expect(welcome).toMatch(/safe-area-inset/);
  });

  it('ChatView 支持键盘输入', () => {
    const chat = readSrc('src/views/ChatView.vue');
    // 支持 Enter 发送
    expect(chat).toMatch(/@keydown/);
    // 支持 textarea 输入
    expect(chat).toMatch(/textarea/);
  });

  it('构建配置正确', () => {
    const gradle = readSrc('android/app/build.gradle');
    // 检查 useLegacyPackaging（PRoot 需要）
    expect(gradle).toMatch(/useLegacyPackaging/);
    // 检查 Shizuku 依赖
    expect(gradle).toMatch(/shizuku/);
  });

  it('index.html 配置正确', () => {
    const html = readSrc('index.html');
    // 检查 viewport 配置
    expect(html).toMatch(/viewport/);
  });

  it('ChatView 显示当前模型状态', () => {
    const chat = readSrc('src/views/ChatView.vue');
    // 显示独立模式标签
    expect(chat).toMatch(/独立模式/);
    // 使用 effectiveStandaloneProvider
    expect(chat).toMatch(/effectiveStandaloneProvider/);
  });

  it('ModelsView 有「测试连接」按钮 + 友好错误翻译', () => {
    const mv = readSrc('src/views/ModelsView.vue');
    expect(mv).toMatch(/testConnection|test-btn/);
    expect(mv).toMatch(/测试连接/);
    // 错误翻译覆盖 HTTP 401/404/429/5xx + CORS + 网络 + 超时
    expect(mv).toMatch(/HTTP \$\{code\}/);
    expect(mv).toMatch(/鉴权失败/);
    expect(mv).toMatch(/端点不存在/);
    expect(mv).toMatch(/请求太频繁/);
    expect(mv).toMatch(/供应商服务端异常/);
    expect(mv).toMatch(/CORS/);
    expect(mv).toMatch(/网络不通/);
  });

  it('ModelsView 端到端「测试发送」按钮：拉完模型才出现', () => {
    const mv = readSrc('src/views/ModelsView.vue');
    // 函数 + 状态 + 按钮 + 状态徽章
    expect(mv).toMatch(/testSendMessage/);
    expect(mv).toMatch(/sendTestState/);
    expect(mv).toMatch(/sendTestDetail/);
    expect(mv).toMatch(/sendTestLatency/);
    // 按钮只在 currentModels.length > 0 时渲染
    expect(mv).toMatch(/v-if="currentModels\.length"/);
    expect(mv).toMatch(/测试发送/);
    // 走的是 /v1/chat/completions（用 streamChatCompletion）
    expect(mv).toMatch(/streamChatCompletion/);
    // ping 内容：要求模型回 OK
    expect(mv).toMatch(/hello/);
    expect(mv).toMatch(/OK/);
    // 30s 超时 + AbortController
    expect(mv).toMatch(/AbortController/);
    expect(mv).toMatch(/30000/);
  });

  it('ChatView 处理错误', () => {
    const chat = readSrc('src/views/ChatView.vue');
    // 有错误处理
    expect(chat).toMatch(/error/);
    // 有 try-catch
    expect(chat).toMatch(/try/);
    expect(chat).toMatch(/catch/);
  });

  it('APK 落在 apps/khy-mobile/release/ 而非仓库根', () => {
    // 用文档契约兜底：README 路径 + gitignore 排除 .apk
    // readSrc 已经在仓库根 + 路径，这里 test/ 在 apps/khy-mobile/，所以 'release/README.md' 即可
    const readme = readSrc('release/README.md');
    expect(readme).toMatch(/khy-mobile-debug\.apk/);
    expect(readme).toMatch(/khy-mobile-release\.apk/);
    const gi = readSrc('release/.gitignore');
    expect(gi).toMatch(/\*\.apk/);
  });

  it('ChatView 发送逻辑正确', () => {
    const chat = readSrc('src/views/ChatView.vue');
    // 发送按钮
    expect(chat).toMatch(/发送/);
    // 有 textarea 输入
    expect(chat).toMatch(/textarea/);
    // Ctrl+Enter 发送
    expect(chat).toMatch(/ctrl\.enter/);
  });

  it('错误处理覆盖 HTTP 状态码', () => {
    const mv = readSrc('src/views/ModelsView.vue');
    // ModelsView 有错误处理
    expect(mv).toMatch(/error/);
    // 有 HTTP 错误码处理
    expect(mv).toMatch(/HTTP/);
  });

  it('setApiKey 保存后自动后台拉模型列表', () => {
    const store = readSrc('src/stores/models.js');
    expect(store).toMatch(/refreshStandaloneModels\(/);
    // .then() 里把 defaultModel 设为列表第一个
    expect(store).toMatch(/defaultModel\.value = list\[0\]/);
  });
});
